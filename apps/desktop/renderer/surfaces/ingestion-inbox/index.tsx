// Ingestion Inbox surface (§9.7, task 9.7-C + triage-resolution ACTION UI) — the routable page
// listing parked imported sources (Flow 5 triage) that mounts inside the AppShell. Consumes the
// live `query.ingestionInbox → UiSafeIngestionItem[]` (9.7-A) via the store's workspace-scoped
// `ingestion` slice, and offers per-card disposition ACTIONS (§9.7 triage resolution).
//
// Invariants:
//   - WS-8: the surface is workspace-scoped — the store's `ingestion` slice is populated per the
//     active workspace scope and cleared to `[]` under Global (ingestion never aggregates
//     cross-workspace; see `hydrateIngestionInbox` in lib/live.ts). So the surface just renders what
//     the store holds — empty-state under Global. A disposition acts only on a scoped item's
//     `sourceId` (the command path carries no workspaceId — the renderer sends none).
//   - Reads ONLY the four UI-safe fields (`sourceId`/`type`/`sensitivity`/`summary`). The contract
//     (`UiSafeIngestionItem`) already dropped every raw ref (origin/contentHash/routingHints/
//     workspaceId) at 9.7-A + the producer never persisted them (9.7-B) — the surface must not reach
//     past the contract.
//   - Disposition is REQUEST-only: the renderer is UNTRUSTED (only asks); the worker
//     (`command.disposeTriage`) re-enters the ingestion pipeline (the one writer; ING-4). On ok the
//     parent DRAINS the item (store removal — `disposeTriage` returns no post-state record, so no
//     re-query); on a failed/again disposition the item REMAINS with a non-blocking error affordance
//     (fail closed — a failed disposition loses nothing). A missing `onDispose` (no live worker)
//     disables the buttons — honest, not a dead control that silently no-ops.
//   - Empty-until-producer: `query.ingestionInbox` returns `[]` until the producer's Temporal wiring
//     lands, so the surface renders its empty-state now and populates automatically once it does.
// NEVER import electron, node, or @sow/worker from a renderer file.

import { useState, type ReactElement } from "react";
import type { UiSafeIngestionItem } from "@sow/contracts/api/ui-safe";
import type { TriageDisposition, RerouteTarget } from "../../lib/triage-disposition";
import type { ReroutePickerOptions } from "../../lib/reroute-picker";

export interface IngestionInboxProps {
  /** The active workspace scope's ingestion inbox (empty under Global; empty-until-producer). */
  readonly items: readonly UiSafeIngestionItem[];
  /**
   * Dispose a parked source (§9.7). Absent when there is no live worker → the action buttons
   * render DISABLED (a disposition can't be issued offline). Returns whether it succeeded: on
   * `true` the parent has drained the item (store removal) and the card unmounts; on `false` the
   * card shows a non-blocking error affordance and the item REMAINS (fail closed — no data loss).
   * A `reroute` disposition (15.8) carries the explicit registry-picked `target`.
   */
  readonly onDispose?: (sourceId: string, disposition: TriageDisposition, target?: RerouteTarget) => Promise<boolean>;
  /**
   * The registry-sourced reroute picker options (15.8 — workspaces from the onboarded set, projects
   * from the current scope's read model). ABSENT ⇒ the reroute control is not offered (the renderer
   * never invents a target; there is nothing to select from). Present ⇒ each card exposes a reroute
   * control whose picker lists ONLY these options.
   */
  readonly reroute?: ReroutePickerOptions;
}

/** The dispositions offered per card — accept (re-enter) vs reject (discard). The worker re-validates. */
const DISPOSITIONS: readonly { readonly disposition: TriageDisposition; readonly label: string }[] = [
  { disposition: "accept", label: "Accept" },
  { disposition: "reject", label: "Reject" },
];

/** One parked-source card — the summary, a sensitivity badge, the source type, and disposition actions. */
function IngestionCard({
  item,
  onDispose,
  reroute,
}: {
  readonly item: UiSafeIngestionItem;
  readonly onDispose?: (sourceId: string, disposition: TriageDisposition, target?: RerouteTarget) => Promise<boolean>;
  readonly reroute?: ReroutePickerOptions;
}): ReactElement {
  const disabled = onDispose === undefined;
  // Transient per-card error flag — the ONLY store-independent list flag. Set on a failed
  // disposition (the item stays); cleared when a new disposition is attempted.
  const [failed, setFailed] = useState(false);
  // Reroute control local state (15.8): the expand toggle + the two registry-picked selections.
  // "" ⇒ nothing selected — the fail-closed default a submit is guarded against (REQ-F-017 edge).
  const [rerouting, setRerouting] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");

  // Share the ok-drains / fail-retains handling across accept/reject/reroute. On ok the parent
  // drains the item (this card unmounts); on a failed disposition the item REMAINS with an error.
  const runDispose = (p: Promise<boolean>): void => {
    setFailed(false);
    void p.then((ok) => {
      if (!ok) setFailed(true);
    });
  };

  // Legacy accept/reject: a 2-arg call, byte-equivalent to today (no target ever passed).
  const dispose = (disposition: TriageDisposition): void => {
    if (onDispose === undefined) return;
    runDispose(onDispose(item.sourceId, disposition));
  };

  // The project sub-picker is offered ONLY when the picked target IS the current scope's workspace
  // (the only workspace whose projects the renderer holds — WS-8). Rerouting elsewhere sends the
  // workspace alone; the worker validates/assigns the project on its side.
  const canPickProject =
    reroute !== undefined && selectedWorkspaceId !== "" && selectedWorkspaceId === reroute.projectsWorkspaceId;

  const onWorkspaceChange = (workspaceId: string): void => {
    setSelectedWorkspaceId(workspaceId);
    // A project selection is only valid for the current-scope workspace — drop it on any other pick.
    if (reroute === undefined || workspaceId !== reroute.projectsWorkspaceId) setSelectedProjectId("");
  };

  const submitReroute = (): void => {
    // REQ-F-017 at the edge: never dispatch a reroute without an explicit, registry-picked workspace.
    if (onDispose === undefined || selectedWorkspaceId === "") return;
    const target: RerouteTarget =
      canPickProject && selectedProjectId !== ""
        ? { workspaceId: selectedWorkspaceId, projectId: selectedProjectId }
        : { workspaceId: selectedWorkspaceId };
    runDispose(onDispose(item.sourceId, "reroute", target));
  };

  return (
    <li
      className="sow-ingestion-card"
      role="listitem"
      data-source-id={item.sourceId}
      data-dispose-failed={failed ? "true" : undefined}
    >
      <div className="sow-ingestion-head">
        <span className="sow-ingestion-summary">{item.summary}</span>
        <span className="sow-ingestion-sensitivity">{item.sensitivity}</span>
      </div>
      <div className="sow-ingestion-meta">{item.type}</div>
      <div className="sow-ingestion-actions">
        {DISPOSITIONS.map((d) => (
          <button
            key={d.disposition}
            type="button"
            className={`sow-ingestion-btn sow-ingestion-btn--${d.disposition}`}
            disabled={disabled}
            onClick={() => dispose(d.disposition)}
            title={disabled ? "Connect the worker to triage sources" : undefined}
          >
            {d.label}
          </button>
        ))}
        {reroute !== undefined ? (
          <button
            type="button"
            className="sow-ingestion-btn sow-ingestion-btn--reroute"
            disabled={disabled}
            aria-expanded={rerouting}
            onClick={() => setRerouting((v) => !v)}
            title={disabled ? "Connect the worker to reroute sources" : undefined}
          >
            Reroute
          </button>
        ) : null}
      </div>
      {reroute !== undefined && rerouting && !disabled ? (
        <div className="sow-ingestion-reroute" role="group" aria-label="Reroute this source">
          <label className="sow-reroute-field">
            <span className="sow-reroute-label">Reroute to workspace</span>
            <select
              className="sow-reroute-select"
              value={selectedWorkspaceId}
              onChange={(e) => onWorkspaceChange(e.target.value)}
            >
              <option value="">Select workspace…</option>
              {reroute.workspaces.map((w) => (
                <option key={w.workspaceId} value={w.workspaceId}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          {canPickProject ? (
            <label className="sow-reroute-field">
              <span className="sow-reroute-label">Assign to project</span>
              <select
                className="sow-reroute-select"
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
              >
                <option value="">No project</option>
                {reroute.projects.map((p) => (
                  <option key={p.projectId} value={p.projectId}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            type="button"
            className="sow-ingestion-btn sow-ingestion-btn--reroute-confirm"
            // REQ-F-017 at the edge: submit is inert until a workspace is explicitly chosen.
            disabled={selectedWorkspaceId === ""}
            onClick={submitReroute}
          >
            Confirm reroute
          </button>
        </div>
      ) : null}
      {failed ? (
        <div className="sow-ingestion-error" role="alert">
          Couldn&apos;t dispose — try again
        </div>
      ) : null}
    </li>
  );
}

export function IngestionInbox(props: IngestionInboxProps): ReactElement {
  const { items, onDispose, reroute } = props;
  const empty = items.length === 0;

  return (
    <main className="sow-content" aria-label="Ingestion Inbox">
      <div className="sow-page-head">
        <div>
          <h1>Inbox</h1>
          {items.length > 0 ? (
            <div className="sow-subtitle">{items.length} awaiting triage</div>
          ) : null}
        </div>
      </div>

      {empty ? (
        <div className="sow-empty" role="status">
          No items awaiting triage
        </div>
      ) : (
        <ul className="sow-ingestion-list" role="list" aria-label="Parked sources awaiting triage">
          {items.map((it) => (
            <IngestionCard key={it.sourceId} item={it} onDispose={onDispose} reroute={reroute} />
          ))}
        </ul>
      )}
    </main>
  );
}
