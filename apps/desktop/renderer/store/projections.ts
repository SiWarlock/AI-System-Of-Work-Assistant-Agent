import type { StreamEvent } from "@sow/contracts";
import type { ConnectionStatus, UiSafeStoreState } from "./index";

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
