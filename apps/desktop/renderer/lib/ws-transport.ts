import type { CreateTRPCClient } from "@trpc/client";
import type { AnyTRPCRouter } from "@trpc/server";
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

/** Build a StreamTransport backed by the worker's tRPC push-stream subscription. */
export function createWsStreamTransport(
  client: CreateTRPCClient<AnyTRPCRouter>,
): StreamTransport {
  return {
    subscribe(handlers: StreamSubscribeHandlers, lastEventId: string | null): () => void {
      // The renderer is typed against a generic router (full AppRouter typing is a
      // deferred worker-track .d.ts emit), so the concrete procedure is accessed
      // dynamically — validated at runtime by streamEventSchema downstream.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sub = (client as any).stream.onEvent.subscribe(
        lastEventId !== null ? { lastEventId } : {},
        {
          onData: (item: { id: string; data: unknown }) => handlers.onData(item.data),
          onError: (err: unknown) => handlers.onError(err),
          onComplete: () => handlers.onComplete(),
        },
      );
      return () => sub.unsubscribe();
    },
  };
}
