// Subpath imports (not the index barrel): the barrel pulls schema/registry.ts,
// which uses node:fs and cannot be bundled into the browser renderer.
import type {
  UiSafeApproval,
  UiSafeHealthItem,
  UiSafeWorkflowRunRef,
  UiSafeDashboardCard,
} from "@sow/contracts/api/ui-safe";

// The renderer store holds ONLY UI-safe projections delivered over the §10 push
// stream — never secrets, Keychain refs, or unfiltered raw content (§10 boundary,
// REQ-S-004, §16). Everything here is an allowlisted `UiSafe*` shape from
// @sow/contracts, keyed by its id.

/** Connection state surfaced to the UI — worker-down is a DISTINCT state, never an indefinite spinner. */
export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "worker-down";

export interface UiSafeStoreState {
  readonly connection: ConnectionStatus;
  readonly approvals: ReadonlyMap<string, UiSafeApproval>;
  readonly health: ReadonlyMap<string, UiSafeHealthItem>;
  readonly workflows: ReadonlyMap<string, UiSafeWorkflowRunRef>;
  readonly cards: ReadonlyMap<string, UiSafeDashboardCard>;
  /** The last stream `eventId` applied — a resumed subscription replays from here. */
  readonly lastEventId: string | null;
  /** The last per-stream `seq` applied — a gap (seq != last + 1) signals a dropped event. */
  readonly lastSeq: number | null;
}

export const initialStoreState: UiSafeStoreState = {
  connection: "connecting",
  approvals: new Map(),
  health: new Map(),
  workflows: new Map(),
  cards: new Map(),
  lastEventId: null,
  lastSeq: null,
};

// ── A minimal external store (useSyncExternalStore-compatible) ───────────────
export interface Store<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
  dispatch(update: (prev: T) => T): void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: (): T => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch(update: (prev: T) => T): void {
      const next = update(state);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

export function createUiSafeStore(): Store<UiSafeStoreState> {
  return createStore(initialStoreState);
}
