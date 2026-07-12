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
import type { TriageDisposition } from "../../lib/triage-disposition";

export interface IngestionInboxProps {
  /** The active workspace scope's ingestion inbox (empty under Global; empty-until-producer). */
  readonly items: readonly UiSafeIngestionItem[];
  /**
   * Dispose a parked source (§9.7). Absent when there is no live worker → the action buttons
   * render DISABLED (a disposition can't be issued offline). Returns whether it succeeded: on
   * `true` the parent has drained the item (store removal) and the card unmounts; on `false` the
   * card shows a non-blocking error affordance and the item REMAINS (fail closed — no data loss).
   */
  readonly onDispose?: (sourceId: string, disposition: TriageDisposition) => Promise<boolean>;
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
}: {
  readonly item: UiSafeIngestionItem;
  readonly onDispose?: (sourceId: string, disposition: TriageDisposition) => Promise<boolean>;
}): ReactElement {
  const disabled = onDispose === undefined;
  // Transient per-card error flag — the ONLY local state (list membership is store-driven). Set on a
  // failed disposition (the item stays); cleared when a new disposition is attempted.
  const [failed, setFailed] = useState(false);

  const dispose = (disposition: TriageDisposition): void => {
    if (onDispose === undefined) return;
    setFailed(false);
    void onDispose(item.sourceId, disposition).then((ok) => {
      // On ok the parent drains the item (this card unmounts) — nothing to set here. On a failed
      // disposition the item REMAINS; surface the non-blocking error affordance.
      if (!ok) setFailed(true);
    });
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
      </div>
      {failed ? (
        <div className="sow-ingestion-error" role="alert">
          Couldn&apos;t dispose — try again
        </div>
      ) : null}
    </li>
  );
}

export function IngestionInbox(props: IngestionInboxProps): ReactElement {
  const { items, onDispose } = props;
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
            <IngestionCard key={it.sourceId} item={it} onDispose={onDispose} />
          ))}
        </ul>
      )}
    </main>
  );
}
