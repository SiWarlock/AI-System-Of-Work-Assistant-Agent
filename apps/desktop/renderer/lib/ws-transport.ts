import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";
import type { StreamEvent } from "@sow/contracts/api/events";
import type { StreamTransport, StreamSubscribeHandlers } from "./event-stream";

// The real §10 push-stream transport: a tRPC `stream.onEvent` subscription over the
// wsLink. The token rides the WS connectionParams (set up in live-client.ts); this
// adapter only maps the subscription to the transport-agnostic StreamTransport the
// event-stream controller drives.
//
// The worker yields TRACKED items `{ id, data }` (id = the event's eventId). The
// store advances its resume cursor from the StreamEvent's OWN eventId, so we forward
// `item.data` (the StreamEvent) — never the wrapper — and validateStreamEvent gates
// it before it touches the store.

/**
 * The client shape of the worker's `stream.onEvent` subscription procedure. The worker DELIBERATELY
 * types the `stream` sub-router as `AnyRouter` (see `apps/worker/src/api/stream/pushStream.ts`): the
 * concrete subscription procedure map is NOT nameable across the worker's `declaration: true` emit
 * (TS2742) — and that erasure is exactly what makes the AppRouter `.d.ts` this typed client consumes
 * emittable at all. So `AppRouter["stream"]` carries no `onEvent`, and the renderer adapts to the one
 * subscription through THIS explicit typed shape (a typed assertion, NOT `any`). The item `data` is
 * anchored to the canonical `@sow/contracts` `StreamEvent` (so the adapter can't drift from the real
 * event contract) and is STILL re-validated at runtime by `streamEventSchema` downstream (candidate-data).
 */
interface StreamOnEventProc {
  subscribe(
    input: { readonly lastEventId?: string },
    handlers: {
      readonly onStarted?: () => void;
      readonly onData: (item: { readonly id: string; readonly data: StreamEvent }) => void;
      readonly onError: (err: unknown) => void;
      readonly onComplete: () => void;
    },
  ): { readonly unsubscribe: () => void };
}

/** Build a StreamTransport backed by the worker's tRPC push-stream subscription. */
export function createWsStreamTransport(
  client: CreateTRPCClient<AppRouter>,
): StreamTransport {
  return {
    subscribe(handlers: StreamSubscribeHandlers, lastEventId: string | null): () => void {
      // `stream` is an `AnyRouter` on AppRouter by worker design (see StreamOnEventProc above), so the
      // subscription is reached via the explicit typed shape. `item.data` (the StreamEvent) is
      // validated at runtime by streamEventSchema downstream.
      const streamProc = (client.stream as unknown as { readonly onEvent: StreamOnEventProc }).onEvent;
      const sub = streamProc.subscribe(lastEventId !== null ? { lastEventId } : {}, {
        onStarted: () => handlers.onStarted?.(),
        onData: (item) => handlers.onData(item.data),
        onError: (err) => handlers.onError(err),
        onComplete: () => handlers.onComplete(),
      });
      return () => sub.unsubscribe();
    },
  };
}
