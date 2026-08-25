// @sow/workflows — task 25.2/25.3 (PKG-W3) ACTIVITY: a GENERIC rebuildable
// dashboard read-model updater, reused across the three families whose port
// declares an identical single-method/single-failure-code shape —
// UpdateDashboardPort (dailyBrief), ReviewUpdateDashboardPort (periodReview),
// and ProjectSyncUpdateDashboardPort (projectSync): each is
// `update(payload: Record<string,unknown>): Promise<Result<void, {code:
// "dashboard_failed", message, cause?}>>` — structurally IDENTICAL, so one
// generic core satisfies all three directly (never a re-implementation).
//
// This is an ACTIVITY, NOT workflow code. It wraps the injected read-model store
// (@sow/db-backed in production). This is a REBUILDABLE projection (§4/§16) —
// SUMMARY/metadata only, never raw content; a failure here surfaces a health item
// but does NOT roll back the durable Markdown commit (mirrors the 7.6 reindex
// posture). Never throws.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";

/** The injected rebuildable dashboard read-model sink. */
export interface DashboardReadModelStore {
  put(payload: Record<string, unknown>): Promise<void>;
}

export interface DashboardUpdateError {
  readonly code: "dashboard_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Build a generic `{update(payload): Promise<Result<void, DashboardUpdateError>>}`
 * over the injected store. A store rejection/throw folds to a typed
 * `dashboard_failed` — never propagates a raw exception. Never throws.
 */
export function createDashboardUpdateActivity(deps: {
  readonly store: DashboardReadModelStore;
}): { update(payload: Record<string, unknown>): Promise<Result<void, DashboardUpdateError>> } {
  return {
    async update(payload: Record<string, unknown>): Promise<Result<void, DashboardUpdateError>> {
      try {
        await deps.store.put(payload);
        return ok(undefined);
      } catch (cause) {
        return err({ code: "dashboard_failed", message: "dashboard read-model update failed", cause });
      }
    },
  };
}
