// Ingestion Inbox surface (§9.7, task 9.7-C) — the routable page listing parked imported sources
// (Flow 5 triage) that mounts inside the AppShell. Consumes the live `query.ingestionInbox →
// UiSafeIngestionItem[]` (9.7-A) via the store's workspace-scoped `ingestion` slice.
//
// Invariants:
//   - WS-8: the surface is workspace-scoped — the store's `ingestion` slice is populated per the
//     active workspace scope and cleared to `[]` under Global (ingestion never aggregates
//     cross-workspace; see `hydrateIngestionInbox` in lib/live.ts). So the surface just renders what
//     the store holds — empty-state under Global.
//   - Reads ONLY the four UI-safe fields (`sourceId`/`type`/`sensitivity`/`summary`). The contract
//     (`UiSafeIngestionItem`) already dropped every raw ref (origin/contentHash/routingHints/
//     workspaceId) at 9.7-A + the producer never persisted them (9.7-B) — the surface must not reach
//     past the contract.
//   - Empty-until-producer: `query.ingestionInbox` returns `[]` today (the producer's Temporal wiring
//     is deferred), so the surface renders its empty-state now and populates automatically once the
//     wiring lands. Read-only this slice — the triage-resolution ACTIONS are the deferred follow-up.
// NEVER import electron, node, or @sow/worker from a renderer file.

import { type ReactElement } from "react";
import type { UiSafeIngestionItem } from "@sow/contracts/api/ui-safe";

export interface IngestionInboxProps {
  /** The active workspace scope's ingestion inbox (empty under Global; empty-until-producer). */
  readonly items: readonly UiSafeIngestionItem[];
}

/** One parked-source card — the summary, a sensitivity badge, and the source type. Read-only. */
function IngestionCard({ item }: { readonly item: UiSafeIngestionItem }): ReactElement {
  return (
    <li className="sow-ingestion-card" role="listitem" data-source-id={item.sourceId}>
      <div className="sow-ingestion-head">
        <span className="sow-ingestion-summary">{item.summary}</span>
        <span className="sow-ingestion-sensitivity">{item.sensitivity}</span>
      </div>
      <div className="sow-ingestion-meta">{item.type}</div>
    </li>
  );
}

export function IngestionInbox(props: IngestionInboxProps): ReactElement {
  const { items } = props;
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
            <IngestionCard key={it.sourceId} item={it} />
          ))}
        </ul>
      )}
    </main>
  );
}
