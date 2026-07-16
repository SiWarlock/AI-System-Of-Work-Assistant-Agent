import { useState, type ReactElement } from "react";
import { mintCrossWorkspaceLinkId, type UiSafeCrossWorkspaceLinkView } from "../../store/cross-workspace-links";
import type { CreateCrossWorkspaceLinkInput, CrossWorkspaceLinkResult } from "../../lib/cross-workspace-link";

// Task 14.7 (desktop leg) — the cross-workspace-links surface. The SINGLE sanctioned WS-8 cross-read
// authorization surface (safety rule 4): create a PENDING directional+scoped link (from → to),
// DELIBERATELY owner-approve it (the human-in-the-loop gate that opens the scoped cross-read path),
// and revoke it (terminal — closes the path immediately). Drives crossWorkspaceLink.create/approve/
// revoke via injected callbacks (unit-testable). Renders ONLY the UI-safe link summary — there is NO
// raw cross-workspace content in the shape, and this surface invents no content read.
//
// WS-8: the from/to pickers offer ONLY registered/onboarded workspaces; a self-link (from===to) is
// disabled client-side (the worker also rejects CWL_SELF). NO pre-approval smuggling: create sends
// only the 5 whitelisted fields (the callers forward exactly those); approval is a separate action.

/** The cross-workspace-allowed projection types (a CURATED bounded set; the GclProjection taxonomy is
 *  an open arch_gap — a Future-TODO formalizes the cross-read-allowed set). */
const PROJECTION_TYPES = ["calendar_busy", "busy_free_window", "deadlines", "task_rollup", "summary"] as const;
/** The cross-read visibility levels (`isolated` excluded — it is the no-cross default; worker validates). */
const VISIBILITY_LEVELS = ["coordination", "sanitized", "full"] as const;

export interface WorkspaceOption {
  readonly id: string;
  readonly label: string;
}

export interface CrossWorkspaceLinksProps {
  /** The registered/onboarded workspaces the from/to pickers may offer (WS-8). */
  readonly workspaces: readonly WorkspaceOption[];
  /** The currently-selected onboarded workspace id (default `from`), or null. */
  readonly defaultFrom: string | null;
  /** The session's links (optimistic; latest status per linkId). */
  readonly links: readonly UiSafeCrossWorkspaceLinkView[];
  readonly onCreate: (input: CreateCrossWorkspaceLinkInput) => Promise<CrossWorkspaceLinkResult>;
  readonly onApprove: (linkId: string) => Promise<CrossWorkspaceLinkResult>;
  readonly onRevoke: (linkId: string) => Promise<CrossWorkspaceLinkResult>;
}

export function CrossWorkspaceLinks(props: CrossWorkspaceLinksProps): ReactElement {
  const { workspaces, defaultFrom, links, onCreate, onApprove, onRevoke } = props;
  const firstId = workspaces[0]?.id ?? "";
  const [from, setFrom] = useState<string>(defaultFrom ?? firstId);
  const [to, setTo] = useState<string>("");
  const [projType, setProjType] = useState<string>(PROJECTION_TYPES[0]);
  const [visLevel, setVisLevel] = useState<string>(VISIBILITY_LEVELS[0]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Per-link in-flight guard so a double-click on Approve/Revoke can't fire a duplicate transition
  // (the second would hit the worker's terminal guard → a spurious "couldn't…" banner on a SUCCESS).
  const [linkOpInFlight, setLinkOpInFlight] = useState<Record<string, boolean>>({});

  // Two DISTINCT workspaces are required to link (matches the empty-state copy); a lone workspace
  // could only self-link (which is rejected), so the form would be unusable — gate it out.
  const hasLinkableWorkspaces = workspaces.length >= 2;
  const selfLink = from !== "" && from === to;
  const canCreate = hasLinkableWorkspaces && from !== "" && to !== "" && !selfLink && !busy;

  const labelFor = (id: string): string => workspaces.find((w) => w.id === id)?.label ?? id;

  const submitCreate = (): void => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    const input: CreateCrossWorkspaceLinkInput = {
      // Deterministic, collision-free anchor id (idempotent per authorization; a scope change → a
      // new link needing its own approval — worker Lesson 32). NEVER a status/approvedAt (approval
      // is a separate explicit transition).
      linkId: mintCrossWorkspaceLinkId(from, to, projType, visLevel),
      fromWorkspaceId: from,
      toWorkspaceId: to,
      scopeProjectionType: projType,
      scopeVisibilityLevel: visLevel,
    };
    void onCreate(input)
      .then((r) => {
        if (!r.ok) setError("Couldn't create the link. Check the workspaces and scope, then try again.");
      })
      .catch(() => setError("Couldn't create the link. Check the workspaces and scope, then try again."))
      .finally(() => setBusy(false));
  };

  const runLinkOp = (linkId: string, op: () => Promise<CrossWorkspaceLinkResult>, failMsg: string): void => {
    if (linkOpInFlight[linkId] === true) return; // ignore a double-fire while the op is in flight
    setError(null);
    setLinkOpInFlight((m) => ({ ...m, [linkId]: true }));
    void op()
      .then((r) => {
        if (!r.ok) setError(failMsg);
      })
      .catch(() => setError(failMsg))
      .finally(() => setLinkOpInFlight((m) => ({ ...m, [linkId]: false })));
  };

  const approve = (linkId: string): void => runLinkOp(linkId, () => onApprove(linkId), "Couldn't approve the link.");
  const revoke = (linkId: string): void => runLinkOp(linkId, () => onRevoke(linkId), "Couldn't revoke the link.");

  return (
    <main className="sow-content sow-cross-workspace-links" aria-label="Cross-workspace links">
      <div className="sow-page-head">
        <div>
          <h1>Cross-workspace links</h1>
          <p className="sow-subtitle">
            Authorize a single directional, scoped read from one workspace into another. Approval is
            deliberate and per-link; revoke closes the path immediately.
          </p>
        </div>
      </div>

      {!hasLinkableWorkspaces ? (
        <div className="sow-empty" role="status">
          Onboard at least two workspaces to link them.
        </div>
      ) : (
        <section className="sow-form-section" aria-label="Create a link">
          <div className="sow-field-row">
            <label className="sow-field">
              <span className="sow-field-label">From</span>
              <select className="sow-input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From workspace">
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="sow-field">
              <span className="sow-field-label">To</span>
              <select className="sow-input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To workspace">
                <option value="">Select…</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="sow-field">
              <span className="sow-field-label">Projection</span>
              <select className="sow-input" value={projType} onChange={(e) => setProjType(e.target.value)} aria-label="Projection type">
                {PROJECTION_TYPES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="sow-field">
              <span className="sow-field-label">Visibility</span>
              <select className="sow-input" value={visLevel} onChange={(e) => setVisLevel(e.target.value)} aria-label="Visibility level">
                {VISIBILITY_LEVELS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {selfLink ? (
            <div className="sow-field-note" role="status">
              A link's two workspaces must differ.
            </div>
          ) : null}
          <div className="sow-form-actions">
            <button type="button" className="sow-btn sow-btn--primary" disabled={!canCreate} aria-busy={busy} onClick={submitCreate}>
              {busy && <span className="sow-spinner" aria-hidden="true" />}
              Create link
            </button>
          </div>
        </section>
      )}

      {error !== null ? (
        <div role="alert" className="sow-inline-error sow-cross-workspace-links-error">
          {error}
        </div>
      ) : null}

      {links.length === 0 ? (
        <div className="sow-empty" role="status">
          No cross-workspace links yet.
        </div>
      ) : (
        <ul className="sow-link-list" aria-label="Cross-workspace links">
          {links.map((l) => (
            <li key={l.linkId} className="sow-link-item" data-link-id={l.linkId} data-status={l.status}>
              {/* The deliberate authorization surface — the owner sees exactly what they authorize. */}
              <span className="sow-link-direction">
                {labelFor(l.fromWorkspaceId)} → {labelFor(l.toWorkspaceId)}
              </span>
              <span className="sow-link-scope">
                {l.scopeProjectionType} / {l.scopeVisibilityLevel}
              </span>
              <span className={`sow-pill sow-pill--link-${l.status}`}>{l.status}</span>
              <div className="sow-row-actions">
                {l.status === "pending" ? (
                  <button
                    type="button"
                    className="sow-btn sow-btn--approve"
                    disabled={linkOpInFlight[l.linkId] === true}
                    onClick={() => approve(l.linkId)}
                    aria-label={`Approve cross-workspace link from ${labelFor(l.fromWorkspaceId)} to ${labelFor(l.toWorkspaceId)} scoped ${l.scopeProjectionType} ${l.scopeVisibilityLevel}`}
                  >
                    Approve
                  </button>
                ) : null}
                {l.status !== "revoked" ? (
                  <button
                    type="button"
                    className="sow-btn sow-btn--reject"
                    disabled={linkOpInFlight[l.linkId] === true}
                    onClick={() => revoke(l.linkId)}
                    aria-label={`Revoke cross-workspace link from ${labelFor(l.fromWorkspaceId)} to ${labelFor(l.toWorkspaceId)}`}
                  >
                    Revoke
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
