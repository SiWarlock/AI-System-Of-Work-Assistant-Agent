import { describe, it, expect } from "vitest";
import { createWsStreamTransport } from "../../renderer/lib/ws-transport";

// A fake tRPC client exposing stream.onEvent.subscribe, capturing the call.
interface FakeHandlers {
  onStarted?: () => void;
  onData: (i: unknown) => void;
}
function fakeClient(): {
  client: unknown;
  calls: { input: unknown; handlers: FakeHandlers }[];
  unsubs: () => number;
} {
  const calls: { input: unknown; handlers: FakeHandlers }[] = [];
  let unsubscribed = 0;
  const client = {
    stream: {
      onEvent: {
        subscribe: (input: unknown, handlers: FakeHandlers) => {
          calls.push({ input, handlers });
          return { unsubscribe: () => (unsubscribed += 1) };
        },
      },
    },
  };
  return { client, calls, unsubs: () => unsubscribed };
}

const NOOP = { onData: (): void => {}, onError: (): void => {}, onComplete: (): void => {} };

describe("createWsStreamTransport — tRPC subscription → StreamTransport", () => {
  it("subscribes to stream.onEvent carrying the lastEventId resume cursor", () => {
    const f = fakeClient();
    createWsStreamTransport(f.client as never).subscribe(NOOP, "evt-42");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.input).toEqual({ lastEventId: "evt-42" });
  });

  it("omits lastEventId on a fresh (null-cursor) subscription", () => {
    const f = fakeClient();
    createWsStreamTransport(f.client as never).subscribe(NOOP, null);
    expect(f.calls[0]!.input).toEqual({});
  });

  it("forwards the tracked item's DATA (not the {id,data} wrapper) to onData", () => {
    // The store derives lastEventId from the EVENT's own eventId, so the transport
    // must hand the reducer `item.data` (the StreamEvent), not the tracked wrapper.
    const f = fakeClient();
    const received: unknown[] = [];
    createWsStreamTransport(f.client as never).subscribe(
      { ...NOOP, onData: (raw) => received.push(raw) },
      null,
    );
    const event = { name: "system.health", eventId: "e1", seq: 1, payload: {} };
    f.calls[0]!.handlers.onData({ id: "e1", data: event });
    expect(received).toEqual([event]);
  });

  it("forwards the subscription's onStarted (live-on-connect, before any event)", () => {
    const f = fakeClient();
    let started = 0;
    createWsStreamTransport(f.client as never).subscribe(
      { ...NOOP, onStarted: () => (started += 1) },
      null,
    );
    f.calls[0]!.handlers.onStarted?.();
    expect(started).toBe(1);
  });

  it("returns an unsubscribe that tears down the subscription", () => {
    const f = fakeClient();
    const unsub = createWsStreamTransport(f.client as never).subscribe(NOOP, null);
    unsub();
    expect(f.unsubs()).toBe(1);
  });
});
