import { createTRPCClient, httpBatchLink, type CreateTRPCClient } from "@trpc/client";
import type { AnyTRPCRouter } from "@trpc/server";

// NOTE (deferred, task 9.x): the client is typed against tRPC's generic router
// rather than the worker's concrete `AppRouter`. Importing the worker's
// source-inferred router type drags `packages/db` source into the renderer's DOM
// tsconfig, where node's `Buffer` conflicts with DOM's `BlobPart`. End-to-end
// procedure typing needs the worker to emit a `.d.ts` type entry (a worker-track
// change). The client is fully CORRECT at runtime; rendered DATA stays fully typed
// via `@sow/contracts` UI-safe types.

export interface WorkerClientConfig {
  /** The loopback worker base URL, e.g. http://127.0.0.1:<port>. Provided by main (9.4). */
  readonly url: string;
  /** The per-launch session token from the preload bridge. */
  readonly token: string;
}

/**
 * The exact auth headers the worker HTTP interceptor reads (apps/worker
 * api/mount.ts `bearerFromHeader`): the token as an `Authorization: Bearer`
 * value. The `Origin` header is the renderer's page origin — a browser-forbidden
 * header the client cannot forge — and must be on the worker's allowlist, which
 * main configures when it starts the worker (9.4).
 */
export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Build the authenticated tRPC client for the loopback worker API. */
export function createWorkerClient(config: WorkerClientConfig): CreateTRPCClient<AnyTRPCRouter> {
  return createTRPCClient<AnyTRPCRouter>({
    links: [
      httpBatchLink({
        url: config.url,
        // Attach the session token on EVERY call. httpBatchLink does not retry,
        // so an auth rejection is surfaced to the caller — never silently re-sent
        // against an unauthenticated path (9.2).
        headers: () => authHeaders(config.token),
      }),
    ],
  });
}
