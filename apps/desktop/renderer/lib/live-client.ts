import {
  createTRPCClient,
  createWSClient,
  httpBatchLink,
  splitLink,
  wsLink,
  type CreateTRPCClient,
} from "@trpc/client";
import type { AnyTRPCRouter } from "@trpc/server";
import { authHeaders } from "./trpc";

// The LIVE tRPC client for the loopback worker (9.4b E): subscriptions over the
// wsLink, queries/mutations over the httpBatchLink. The session token rides the WS
// FIRST-message connectionParams (never a URL) AND the HTTP Authorization header.
// The browser sets the Origin header itself (a forbidden header the client cannot
// forge) — main allowlisted that exact origin, so no origin is set here.

export interface LiveClientConfig {
  readonly httpUrl: string;
  readonly wsUrl: string;
  readonly token: string;
}

export interface LiveClient {
  readonly client: CreateTRPCClient<AnyTRPCRouter>;
  /** Close the underlying WS connection (stops reconnect attempts). */
  close(): void;
}

export function createLiveClient(config: LiveClientConfig): LiveClient {
  const wsClient = createWSClient({
    url: config.wsUrl,
    connectionParams: () => ({ token: config.token }),
  });
  const client = createTRPCClient<AnyTRPCRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === "subscription",
        true: wsLink({ client: wsClient }),
        false: httpBatchLink({
          url: config.httpUrl,
          headers: () => authHeaders(config.token),
        }),
      }),
    ],
  });
  return { client, close: () => wsClient.close() };
}
