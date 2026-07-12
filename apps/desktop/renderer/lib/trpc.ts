import { createTRPCClient, httpBatchLink, type CreateTRPCClient } from "@trpc/client";
// The renderer's DOM tsconfigs redirect `@sow/worker` to its BUILT `api/server.d.ts` (see the `paths`
// in tsconfig.web.json / tsconfig.testdom.json) — importing the worker's SOURCE-inferred router would
// drag `@sow/db` node source into the DOM program (node `Buffer` vs DOM `BlobPart`). Build-order:
// `turbo typecheck dependsOn ^build`, so the worker/db dist `.d.ts` exist before the desktop typecheck;
// a bare `tsc`/IDE on a clean tree must build `@sow/worker` + `@sow/db` first.
import type { AppRouter } from "@sow/worker";

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
export function createWorkerClient(config: WorkerClientConfig): CreateTRPCClient<AppRouter> {
  return createTRPCClient<AppRouter>({
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
