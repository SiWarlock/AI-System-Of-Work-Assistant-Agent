import { describe, it, expect } from "vitest";
import {
  nextBackoffMs,
  statusForAttempt,
  validateStreamEvent,
  createEventStream,
  WORKER_DOWN_AFTER_ATTEMPTS,
  BACKOFF_MAX_MS,
  type StreamTransport,
  type StreamSubscribeHandlers,
} from "../../renderer/lib/event-stream";
import { createUiSafeStore } from "../../renderer/store";
import { approvalEvent } from "./fixtures";

describe("reconnect policy (9.3)", () => {
  it("backoff is exponential from the base and always positive", () => {
    expect(nextBackoffMs(1)).toBe(500);
    expect(nextBackoffMs(2)).toBe(1000);
    expect(nextBackoffMs(3)).toBe(2000);
  });
  it("backoff is hard-capped (never unbounded — no runaway)", () => {
    expect(nextBackoffMs(100)).toBe(BACKOFF_MAX_MS);
  });
  it("flips to a DISTINCT worker-down state after a persistent run", () => {
    expect(statusForAttempt(1)).toBe("reconnecting");
    expect(statusForAttempt(WORKER_DOWN_AFTER_ATTEMPTS - 1)).toBe("reconnecting");
    expect(statusForAttempt(WORKER_DOWN_AFTER_ATTEMPTS)).toBe("worker-down");
  });
});

describe("validateStreamEvent (9.3 — UI-safe boundary)", () => {
  it("accepts a schema-valid UI-safe event", () => {
    expect(validateStreamEvent(approvalEvent(1, "e1"))).not.toBeNull();
  });
  it("drops a non-conforming frame (never hydrates non-UI-safe data)", () => {
    expect(validateStreamEvent({ name: "evil", payload: { secret: "x" } })).toBeNull();
    expect(validateStreamEvent(null)).toBeNull();
  });
});

interface Timer {
  ms: number;
  run: () => void;
}

function fakeTransport(): {
  transport: StreamTransport;
  emit: (raw: unknown) => void;
  fail: () => void;
  unsubscribed: () => number;
} {
  let handlers: StreamSubscribeHandlers | null = null;
  let unsubs = 0;
  return {
    transport: {
      subscribe(h) {
        handlers = h;
        return () => {
          unsubs += 1;
        };
      },
    },
    emit: (raw) => handlers?.onData(raw),
    fail: () => handlers?.onError(new Error("drop")),
    unsubscribed: () => unsubs,
  };
}

describe("event stream controller (9.3)", () => {
  it("starts connecting, goes live on first data, hydrates the store", () => {
    const store = createUiSafeStore();
    const ft = fakeTransport();
    const es = createEventStream({
      store,
      transport: ft.transport,
      scheduleReconnect: () => () => {},
    });
    es.start();
    expect(store.getSnapshot().connection).toBe("connecting");
    ft.emit(approvalEvent(1, "e1", "a1"));
    expect(store.getSnapshot().connection).toBe("live");
    expect(store.getSnapshot().approvals.get("a1")?.id).toBe("a1");
  });

  it("on drop shows reconnecting + schedules a bounded reconnect (no tight loop)", () => {
    const store = createUiSafeStore();
    const ft = fakeTransport();
    const timers: Timer[] = [];
    const es = createEventStream({
      store,
      transport: ft.transport,
      scheduleReconnect: (ms, run) => {
        timers.push({ ms, run });
        return () => {};
      },
    });
    es.start();
    ft.fail();
    expect(store.getSnapshot().connection).toBe("reconnecting");
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(500);
  });

  it("surfaces worker-down after a persistent run of failures", () => {
    const store = createUiSafeStore();
    const ft = fakeTransport();
    const timers: Timer[] = [];
    const es = createEventStream({
      store,
      transport: ft.transport,
      scheduleReconnect: (ms, run) => {
        timers.push({ ms, run });
        return () => {};
      },
    });
    es.start();
    for (let i = 0; i < WORKER_DOWN_AFTER_ATTEMPTS; i += 1) {
      ft.fail();
      timers[timers.length - 1]?.run(); // fire the scheduled reconnect (re-subscribes)
    }
    expect(store.getSnapshot().connection).toBe("worker-down");
  });

  it("stop() unsubscribes the live subscription", () => {
    const store = createUiSafeStore();
    const ft = fakeTransport();
    const es = createEventStream({
      store,
      transport: ft.transport,
      scheduleReconnect: () => () => {},
    });
    es.start();
    es.stop();
    expect(ft.unsubscribed()).toBeGreaterThanOrEqual(1);
  });
});
