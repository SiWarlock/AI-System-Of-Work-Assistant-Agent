import { streamEventSchema, type StreamEvent } from "@sow/contracts/api/events";
import type { Store, UiSafeStoreState } from "../store";
import { applyStreamEvent, withConnection } from "../store/projections";

// ── Reconnect policy (pure, testable) ────────────────────────────────────────
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 15_000;
export const WORKER_DOWN_AFTER_ATTEMPTS = 6;

/** Exponential backoff with a hard cap. attempt 1 → base; always > 0 (no tight reconnect loop). */
export function nextBackoffMs(attempt: number): number {
  const a = Math.max(1, Math.floor(attempt));
  const ms = BACKOFF_BASE_MS * 2 ** (a - 1);
  return Math.min(ms, BACKOFF_MAX_MS);
}

/** After a persistent run of failed reconnects, surface a DISTINCT worker-down state. */
export function statusForAttempt(attempt: number): "reconnecting" | "worker-down" {
  return attempt >= WORKER_DOWN_AFTER_ATTEMPTS ? "worker-down" : "reconnecting";
}

/** Validate a raw wire frame against the frozen §10 schema — the renderer never hydrates non-UI-safe data. */
export function validateStreamEvent(raw: unknown): StreamEvent | null {
  const parsed = streamEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ── The stream controller ────────────────────────────────────────────────────
// Transport-agnostic so it is fully unit-testable; 9.4 injects the real tRPC
// wsLink subscription (token via connectionParams, resume from lastEventId).

export interface StreamSubscribeHandlers {
  readonly onData: (raw: unknown) => void;
  readonly onError: (err: unknown) => void;
  readonly onComplete: () => void;
}

export interface StreamTransport {
  /** Open one subscription (resuming from `lastEventId`); returns an unsubscribe. */
  subscribe(handlers: StreamSubscribeHandlers, lastEventId: string | null): () => void;
}

export interface EventStreamDeps {
  readonly store: Store<UiSafeStoreState>;
  readonly transport: StreamTransport;
  /** Schedule `run` after `ms`; returns a canceler. Injected so tests are deterministic. */
  readonly scheduleReconnect: (ms: number, run: () => void) => () => void;
}

export interface EventStream {
  start(): void;
  stop(): void;
}

export function createEventStream(deps: EventStreamDeps): EventStream {
  let attempt = 0;
  let unsub: (() => void) | null = null;
  let cancelTimer: (() => void) | null = null;
  let stopped = false;

  const setConn = (status: UiSafeStoreState["connection"]): void => {
    deps.store.dispatch((s) => withConnection(s, status));
  };

  const connect = (): void => {
    if (stopped) return;
    setConn(attempt === 0 ? "connecting" : statusForAttempt(attempt));
    const lastEventId = deps.store.getSnapshot().lastEventId;
    unsub = deps.transport.subscribe(
      {
        onData: (raw) => {
          // First data proves the socket is live + the handshake authenticated.
          setConn("live");
          attempt = 0;
          const event = validateStreamEvent(raw);
          if (event !== null) deps.store.dispatch((s) => applyStreamEvent(s, event));
          // A frame that fails the schema is DROPPED — never hydrates the store.
        },
        onError: () => scheduleRetry(),
        onComplete: () => scheduleRetry(),
      },
      lastEventId,
    );
  };

  const scheduleRetry = (): void => {
    if (stopped) return;
    if (unsub) {
      unsub();
      unsub = null;
    }
    attempt += 1;
    setConn(statusForAttempt(attempt));
    cancelTimer = deps.scheduleReconnect(nextBackoffMs(attempt), connect);
  };

  return {
    start(): void {
      stopped = false;
      attempt = 0;
      connect();
    },
    stop(): void {
      stopped = true;
      if (unsub) {
        unsub();
        unsub = null;
      }
      if (cancelTimer) {
        cancelTimer();
        cancelTimer = null;
      }
    },
  };
}
