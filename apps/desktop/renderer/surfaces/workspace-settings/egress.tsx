import { useEffect, useRef, useState, type ReactElement } from "react";
import type { EgressStatusResult, UiSafeEgressStatusView } from "../../lib/egress-status";

// Task 9.10-C (desktop leg) — the workspace-settings EGRESS surface (REQ-S-002, ⚠ safety rule 5).
//
// Shows, per onboarded workspace, the Employer-Work raw-cloud-egress posture the worker projects
// (acknowledged vs not) and offers exactly ONE mutating affordance: the audited fail-SAFE REVOKE,
// dispatched as a worker command. The renderer never flips policy locally.
//
// ⚠ There is deliberately NO re-ACK control. Turning employer raw-cloud egress ON is an owner-gated
// rule-5 crossing performed at provisioning time (`bcde3d61`); the worker exposes no re-ack command.
// The OFF state says so instead of offering a button. Tests pin the absence as an exact control
// INVENTORY in BOTH posture states (a filter-only assertion would be vacuous when OFF renders nothing).
//
// ⚠ 9.10-C bullet 1 (task #8, ⚠ safety rule 5) — `zeroEgressOnly` IS now rendered, as a SEPARATE
// pill from the ack posture above. 9.22 (`69b10883`) changed its derivation from `!acknowledged` to
// `isZeroEgressOnlyWorkspace` (an all-local NON-EMPTY provider matrix AND both egress allowlists
// empty), so the field now means what it documents — the withholding this comment used to explain is
// superseded, not merely edited around.
//
// `true` = ESTABLISHED: no model-provider route can leave this machine. `false` = NOT ESTABLISHED —
// never "cloud egress is possible", never "safe". The app does not know. Both misreadings are real
// risks on this exact surface (contracts L56/L62), so the pill text is deliberately EPISTEMIC
// ("established" / "not established") rather than substantive ("safe" / "local").
//
// ⛔ SCOPE: the predicate covers MODEL-PROVIDER ROUTES ONLY — connectors and Tool-Gateway external
// writes never consult it. So even `true` is a SCOPED claim, never "nothing leaves this machine".
// `EGRESS_SCOPE_NOTE` below is constant, shared text — safe as a constant because it states what the
// predicate MEASURES (a fixed architectural fact), not the derived VALUE; only the pill text itself
// moves with `zeroEgressOnly` (forbidden-pattern #7's test: change the governing state, the claim moves).
//
// ⚠ KNOWN BOUND (state here, not discover later): after 9.22, a worker-side STORE FAULT returns `ok`
// with a fail-closed `zeroEgressOnly: false` — indistinguishable at this renderer from a genuinely
// not-established workspace (Q3 was settled as ONE `false` value, deliberately, not a third state).
// This is NOT the same as this component's own `cell.kind === "unavailable"` branch below (a
// transport-level failure or malformed payload), which stays textually distinct ("posture
// unavailable" + Retry) and IS recoverable via Retry — that distinction is real and preserved; the
// one above is not, and is accepted under Q3's ruling.
//
// ⚠ `true` is currently UNREACHABLE in production (task 9.32 — nothing writes a non-empty
// `providerMatrix` yet; an owner-ratified deferred arc, not a bug). Rendered PLAINLY, no special
// affordance: de-emphasizing an unreachable state would itself be an implicit claim the predicate
// does not support.
//
// Fail-closed PRESENTATION: a read error renders "posture unavailable" — an unknown posture is never
// drawn as acknowledged, and no revoke is offered on a guess. It is NOT terminal, though: a per-row
// Retry re-reads, because failing closed on the display must not strand the emergency OFF switch after
// one transient blip. A revoke is a deliberate TWO-STEP confirm (never a native confirm()/alert(): a
// modal dialog blocks the harness), and its result comes from the command's returned status — a failure
// leaves the displayed posture untouched (no optimistic flip, no false "revoked").

/** Task #8 — the shared scope caveat for the provider-routing posture pill. See the file-header
 *  comment for why a constant is safe here (it describes the MEASURED scope, never the derived value). */
const EGRESS_SCOPE_NOTE =
  "Covers model-provider routing only — connector reads and external-write traffic are governed separately and aren't reflected here.";

/** Epistemic, not substantive: "established" (a fact was confirmed) vs "not established" (unknown) —
 *  never the two banned over-claiming shorthand tokens named in the file-header comment above. */
const PROVIDER_ROUTING_ESTABLISHED = "Provider routing: established";
const PROVIDER_ROUTING_NOT_ESTABLISHED = "Provider routing: not established";

export interface EgressWorkspaceOption {
  readonly id: string;
  readonly label: string;
}

export interface EgressSettingsProps {
  /** The onboarded/registered workspaces to show a posture row for (WS-8 — the registry is the source). */
  readonly workspaces: readonly EgressWorkspaceOption[];
  /** Read one workspace's posture (`systemHealth.egressStatus`); fails closed to `{ok:false}`. */
  readonly onLoadStatus: (workspaceId: string) => Promise<EgressStatusResult>;
  /** Revoke the ack (`egressCommand.revokeEgressAck`). UNDEFINED ⇒ no live worker ⇒ the control is not
   *  offered at all — never a dead button (mirrors the Approvals `onDecide` gating). */
  readonly onRevoke?: (workspaceId: string) => Promise<EgressStatusResult>;
}

/** A row's posture: pending read / a known posture / an UNKNOWN one (read fault). */
type PostureCell =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly status: UiSafeEgressStatusView }
  | { readonly kind: "unavailable" };

export function EgressSettings(props: EgressSettingsProps): ReactElement {
  const { workspaces, onLoadStatus, onRevoke } = props;
  const [cells, setCells] = useState<Record<string, PostureCell>>({});
  /** Which row has an ARMED confirm (the deliberate second step); at most one at a time. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Per-workspace monotonic request sequence. Every read AND every successful revoke bumps it; a
   * resolution whose captured seq is stale is DROPPED. Without this, a hydrate dispatched before a
   * revoke landed can resolve after it and repaint "acknowledged" over a workspace that is now
   * revoked — overstating permission on a rule-5 surface.
   */
  const seq = useRef<Record<string, number>>({});
  /** Synchronous mirror of `inFlight` — state is captured at render, so two dispatches inside ONE task
   *  would both read a stale `null` and fire duplicate audited commands. The ref closes that window. */
  const inFlightRef = useRef<string | null>(null);

  const loadStatus = (workspaceId: string): void => {
    const mine = (seq.current[workspaceId] = (seq.current[workspaceId] ?? 0) + 1);
    setCells((m) => ({ ...m, [workspaceId]: { kind: "loading" } }));
    void onLoadStatus(workspaceId)
      .then((r) => {
        if (seq.current[workspaceId] !== mine) return; // superseded by a newer read or a revoke
        // A failed read is UNKNOWN, never a posture — fail-closed presentation.
        setCells((m) => ({
          ...m,
          [workspaceId]: r.ok ? { kind: "ready", status: r.status } : { kind: "unavailable" },
        }));
      })
      .catch(() => {
        if (seq.current[workspaceId] === mine) {
          setCells((m) => ({ ...m, [workspaceId]: { kind: "unavailable" } }));
        }
      });
  };

  // Hydrate on mount and whenever the workspace SET changes. The key is percent-escaped so it is
  // INJECTIVE (desktop Lesson 12) — a plain join is ambiguous for an id containing the delimiter, and a
  // collision would wedge the new rows at "Checking…" forever.
  const ids = workspaces.map((w) => encodeURIComponent(w.id)).join(",");
  useEffect(() => {
    // REBUILD (not merge): entries for workspaces that are gone must not linger, and a removed-then-
    // re-added workspace must not paint one frame of its cached posture. Also clears any armed confirm
    // and stale error — the deliberate gate must be armed in THIS cycle, never carried across a re-read.
    setConfirming(null);
    setError(null);
    setCells(Object.fromEntries(workspaces.map((w) => [w.id, { kind: "loading" } as const])));
    for (const w of workspaces) loadStatus(w.id);
    return () => {
      // Invalidate every in-flight read for this cycle (the resolutions land after unmount / re-key).
      for (const w of workspaces) seq.current[w.id] = (seq.current[w.id] ?? 0) + 1;
    };
    // Keyed on the workspace-id SET, not the array identity: App.tsx rebuilds `onboardedWorkspaces`
    // every render, so depending on the array itself would storm the worker with reads.
  }, [ids]);

  const confirmRevoke = (workspaceId: string): void => {
    // Guard the two-step gate EXPLICITLY, not merely positionally: a future keyboard shortcut or bulk
    // action calling this without an armed confirm must not dispatch.
    if (onRevoke === undefined || confirming !== workspaceId || inFlightRef.current !== null) return;
    inFlightRef.current = workspaceId;
    setError(null);
    setInFlight(workspaceId);
    const label = workspaces.find((w) => w.id === workspaceId)?.label ?? workspaceId;
    const failed = `Couldn't revoke the acknowledgment for ${label}. The posture is unchanged — try again.`;
    void onRevoke(workspaceId)
      .then((r) => {
        if (!r.ok) {
          // Honest failure: the posture on screen is UNCHANGED — no optimistic flip, no false "revoked".
          setError(failed);
          return;
        }
        // Re-render from the COMMAND's returned status: the worker is the single source of posture
        // truth. Bumping the seq drops any read that was already in flight against the OLD posture.
        seq.current[workspaceId] = (seq.current[workspaceId] ?? 0) + 1;
        setCells((m) => ({ ...m, [workspaceId]: { kind: "ready", status: r.status } }));
        setConfirming(null);
      })
      .catch(() => setError(failed))
      .finally(() => {
        inFlightRef.current = null;
        setInFlight(null);
      });
  };

  return (
    <main className="sow-content sow-workspace-settings" aria-label="Workspace settings">
      <div className="sow-page-head">
        <div>
          <h1>Workspace settings</h1>
          <p className="sow-subtitle">
            Employer-Work raw content is only sent to a cloud provider for a workspace whose egress
            acknowledgment is on. Revoking is immediate and audited; re-enabling happens through
            provisioning, not from this screen.
          </p>
        </div>
      </div>

      {error !== null ? (
        <div role="alert" className="sow-inline-error sow-egress-error">
          {error}
        </div>
      ) : null}

      {workspaces.length === 0 ? (
        <div className="sow-empty" role="status">
          No workspaces yet — onboard one to see its egress posture.
        </div>
      ) : (
        <ul className="sow-egress-list" aria-label="Workspace egress posture">
          {workspaces.map((w) => {
            const cell = cells[w.id] ?? { kind: "loading" };
            return (
              <li
                key={w.id}
                className="sow-egress-item"
                data-egress-workspace={w.id}
                data-egress-ack={
                  cell.kind === "loading"
                    ? "pending"
                    : cell.kind === "unavailable"
                      ? "unknown"
                      : String(cell.status.employerRawEgressAcknowledged)
                }
              >
                <span className="sow-egress-workspace">{w.label}</span>

                {cell.kind === "loading" ? (
                  <span className="sow-pill sow-pill--muted">Checking…</span>
                ) : cell.kind === "unavailable" ? (
                  <>
                    {/* NEVER "acknowledged" — an unknown posture must not read as permission. */}
                    <span className="sow-pill sow-pill--muted">Egress posture unavailable</span>
                    <div className="sow-row-actions">
                      <button
                        type="button"
                        className="sow-btn"
                        onClick={() => loadStatus(w.id)}
                        aria-label={`Retry reading the egress posture for ${w.label}`}
                      >
                        Retry
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className={`sow-pill sow-pill--egress-${String(cell.status.employerRawEgressAcknowledged)}`}>
                      {cell.status.employerRawEgressAcknowledged
                        ? "Cloud egress acknowledged"
                        : "Not acknowledged — raw employer content is not cleared for cloud"}
                    </span>
                    {/* Task #8 — a SEPARATE claim from the ack pill above: pinned to `zeroEgressOnly`
                        alone (9.22 decoupled it from `employerRawEgressAcknowledged`). */}
                    <span
                      className="sow-pill sow-pill--egress-scoped"
                      data-egress-scope={cell.status.zeroEgressOnly ? "established" : "not-established"}
                      title={EGRESS_SCOPE_NOTE}
                    >
                      {cell.status.zeroEgressOnly ? PROVIDER_ROUTING_ESTABLISHED : PROVIDER_ROUTING_NOT_ESTABLISHED}
                    </span>
                    <p className="sow-egress-scope-note">{EGRESS_SCOPE_NOTE}</p>
                  </>
                )}

                {/* The ONLY mutating control — offered iff the ack is genuinely ON and a live worker exists. */}
                {cell.kind === "ready" && cell.status.employerRawEgressAcknowledged && onRevoke !== undefined ? (
                  <div className="sow-row-actions">
                    {confirming === w.id ? (
                      <>
                        <span className="sow-egress-confirm-copy">
                          Raw employer content for {w.label} will no longer be sent to a cloud provider.
                        </span>
                        <button
                          type="button"
                          className="sow-btn sow-btn--reject"
                          disabled={inFlight !== null}
                          onClick={() => confirmRevoke(w.id)}
                          aria-label={`Confirm revoke of the egress acknowledgment for ${w.label}`}
                        >
                          Confirm revoke
                        </button>
                        {/* Deliberately NOT disabled in flight — backing out of a safety gate must
                            always be available; it only un-arms the UI, it cancels no dispatch. */}
                        <button
                          type="button"
                          className="sow-btn"
                          onClick={() => setConfirming(null)}
                          aria-label={`Keep the egress acknowledgment for ${w.label}`}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="sow-btn sow-btn--reject"
                        // Arming another row mid-revoke would let the resolving command's un-arm land
                        // on the row the user just armed.
                        disabled={inFlight !== null}
                        onClick={() => {
                          setError(null);
                          setConfirming(w.id);
                        }}
                        aria-label={`Revoke egress acknowledgment for ${w.label}`}
                      >
                        Revoke egress acknowledgment
                      </button>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
