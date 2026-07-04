import type { CreateTRPCClient } from "@trpc/client";
import type { AnyTRPCRouter } from "@trpc/server";
import type { UiSafeDashboardCard } from "@sow/contracts/api/ui-safe";

// §9.4 policy-gated drill-down (renderer side). The renderer is UNTRUSTED: it only
// REQUESTS the drill — the worker (`query.globalDrillDown`) re-derives the visibility
// gate server-side and returns either the workspace-scoped UI-safe cards or a typed
// denial. This wrapper folds a denial (err Result) OR any transport error to
// `{ ok: false }` so nothing raw is ever surfaced on a non-permitted drill.

export type DrillResult =
  | { readonly ok: true; readonly cards: readonly UiSafeDashboardCard[] }
  | { readonly ok: false };

/** Build the drill-down caller over a live tRPC client. */
export function createDrillDown(
  client: CreateTRPCClient<AnyTRPCRouter>,
): (workspaceId: string, projectionType: string) => Promise<DrillResult> {
  return async (workspaceId: string, projectionType: string): Promise<DrillResult> => {
    try {
      // Generic-router client (full AppRouter typing deferred) → dynamic access.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = client as any;
      const res = await c.query.globalDrillDown.query({ workspaceId, projectionType });
      if (res?.ok === true && Array.isArray(res.value)) {
        return { ok: true, cards: res.value as readonly UiSafeDashboardCard[] };
      }
      // A typed denial (DRILL_NOT_PERMITTED / DRILL_TARGET_NOT_FOUND) → no context.
      return { ok: false };
    } catch {
      // Transport failure → fail closed (never surface a partial / raw result).
      return { ok: false };
    }
  };
}
