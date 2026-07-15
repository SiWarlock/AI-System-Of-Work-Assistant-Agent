import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";
import type { Store, UiSafeStoreState } from "../store";
import { replaceCards, resolveOnboardedWorkspaceId } from "../store/projections";
import { type WorkspaceScope } from "../store/scope";

// Push-path liveness for a workspace scope (§9.5). Lives in its own module (no `window`/
// bridge dependency — just a client + store) so it stays unit-testable without the DOM.

/**
 * Push-path LIVENESS for a workspace scope (§9.5). `applyStreamEvent` suppresses a
 * read_model.change card in a workspace scope (isolation — the card carries no
 * workspaceId), so on each such push we re-query THAT scope's cards through the
 * scope-correct pull path (query.workspace) and replace — keeping the tab live rather
 * than frozen on its entry snapshot. Global scope is a no-op: it stays live via the
 * reducer's direct fold (its `cards` ARE the query.dashboard aggregate the push emits).
 *
 * Unlike a scope CHANGE (`hydrateScope`), a same-scope refresh does NOT clear first — so
 * it never flickers. Two guards keep it correct under a burst:
 *  - LATEST-WINS: a monotonic token drops an older in-flight query that resolves after a
 *    newer one (never overwrites fresh cards with stale).
 *  - STALE-SCOPE: a result whose scope was switched away mid-flight is dropped.
 * Backpressure coalesces read_model.change at the source, so refreshes stay bounded.
 */
export function createScopeRefresher(
  client: CreateTRPCClient<AppRouter>,
  store: Store<UiSafeStoreState>,
): { refresh: (scope: WorkspaceScope) => Promise<void> } {
  let latest = 0;
  return {
    refresh: async (scope: WorkspaceScope): Promise<void> => {
      // The REAL onboarded query id (§19.1 / 14.1): `null` for Global, a NON-onboarded bucket,
      // OR an unknown scope — all skip the scoped pull (Global stays live via the direct fold;
      // a bucket with no onboarded workspace has nothing to refresh).
      const workspaceId = resolveOnboardedWorkspaceId(store.getSnapshot(), scope);
      if (workspaceId === null) return;
      const token = ++latest;
      try {
        const cardsR = await client.query.workspace.query({ workspaceId });
        if (token !== latest) return; // superseded by a newer refresh (latest-wins)
        if (store.getSnapshot().scope !== scope) return; // scope switched away mid-flight
        if (cardsR.ok === true) store.dispatch((s) => replaceCards(s, cardsR.value));
      } catch {
        // Best-effort — the prior snapshot stands; the next push/scope-change refreshes.
      }
    },
  };
}
