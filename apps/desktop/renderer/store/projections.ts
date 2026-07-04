import type { StreamEvent } from "@sow/contracts/api/events";
import type {
  UiSafeDashboardCard,
  UiSafeHealthItem,
  UiSafeGclProjection,
} from "@sow/contracts/api/ui-safe";
import type { ConnectionStatus, UiSafeStoreState } from "./index";
import type { WorkspaceScope } from "./scope";

// Pure reducers that fold validated UI-safe StreamEvents into the store. Every
// payload is an allowlisted `UiSafe*` shape (the wire is validated by
// streamEventSchema before it reaches here — see lib/event-stream validateStreamEvent).

function cloneSet<V>(map: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

export function withConnection(
  state: UiSafeStoreState,
  connection: ConnectionStatus,
): UiSafeStoreState {
  if (state.connection === connection) return state;
  return { ...state, connection };
}

/** Set the active workspace scope (top-bar switcher). Identity when unchanged. */
export function setScope(state: UiSafeStoreState, scope: WorkspaceScope): UiSafeStoreState {
  if (state.scope === scope) return state;
  return { ...state, scope };
}

/** True when `event.seq` is not the immediate successor of the last applied seq (a dropped event). */
export function isGap(state: UiSafeStoreState, event: StreamEvent): boolean {
  return state.lastSeq !== null && event.seq !== state.lastSeq + 1;
}

/** Fold one validated UI-safe event into state, upserting by id and advancing the resume cursor. */
export function applyStreamEvent(state: UiSafeStoreState, event: StreamEvent): UiSafeStoreState {
  const base: UiSafeStoreState = { ...state, lastEventId: event.eventId, lastSeq: event.seq };
  switch (event.name) {
    case "approval.update":
      return { ...base, approvals: cloneSet(state.approvals, event.payload.id, event.payload) };
    case "system.health":
      return { ...base, health: cloneSet(state.health, event.payload.id, event.payload) };
    case "workflow.status":
      return {
        ...base,
        workflows: cloneSet(state.workflows, event.payload.workflowId, event.payload),
      };
    case "read_model.change":
      return { ...base, cards: cloneSet(state.cards, event.payload.cardId, event.payload) };
    default: {
      // Exhaustiveness: a new §10 event class must be handled above.
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

// ── initial hydrate (9.4b) ───────────────────────────────────────────────────
// Bulk-upsert the read-model an INITIAL query returns (persisted data shows on
// load; the live stream then keeps it current). Keyed identically to the stream
// reducers, so a subsequent stream event for the same id is a clean upsert. The
// resume cursor is untouched — hydrate is a snapshot, not a stream event.

/** Fold an initial dashboard-cards query result into state (upsert by cardId). */
export function hydrateCards(
  state: UiSafeStoreState,
  cards: readonly UiSafeDashboardCard[],
): UiSafeStoreState {
  if (cards.length === 0) return state;
  const next = new Map(state.cards);
  for (const card of cards) next.set(card.cardId, card);
  return { ...state, cards: next };
}

/** Fold an initial System-Health query result into state (upsert by id). */
export function hydrateHealth(
  state: UiSafeStoreState,
  items: readonly UiSafeHealthItem[],
): UiSafeStoreState {
  if (items.length === 0) return state;
  const next = new Map(state.health);
  for (const item of items) next.set(item.id, item);
  return { ...state, health: next };
}

// ── Global (§9.4) cross-workspace surface ────────────────────────────────────
// `query.global` returns the WHOLE current global surface, so hydrate REPLACES the
// snapshot (unlike the upsert reducers) — a projection that dropped off the surface
// must disappear. Empty→empty is a ref-stable no-op.

/** Replace the Global-scope GCL snapshot with the latest query.global result. */
export function hydrateGlobal(
  state: UiSafeStoreState,
  projections: readonly UiSafeGclProjection[],
): UiSafeStoreState {
  if (projections.length === 0 && state.global.length === 0) return state;
  return { ...state, global: [...projections] };
}

/** A workspace's grouped Global items (the §9.4 "sanitized grouped results"). */
export interface GlobalGroup {
  readonly workspaceId: string;
  readonly items: readonly UiSafeGclProjection[];
}

/** Group Global projections by workspaceId, preserving first-seen workspace order. */
export function groupGlobalByWorkspace(
  projections: readonly UiSafeGclProjection[],
): readonly GlobalGroup[] {
  const order: string[] = [];
  const byWs = new Map<string, UiSafeGclProjection[]>();
  for (const p of projections) {
    let bucket = byWs.get(p.workspaceId);
    if (bucket === undefined) {
      bucket = [];
      byWs.set(p.workspaceId, bucket);
      order.push(p.workspaceId);
    }
    bucket.push(p);
  }
  return order.map((workspaceId) => ({
    workspaceId,
    items: byWs.get(workspaceId) ?? [],
  }));
}
