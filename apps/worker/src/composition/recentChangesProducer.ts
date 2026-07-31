// 9.15 — recent_changes audit-projection PRODUCER. A pure worker composition port that refreshes the
// recent_changes read-model for ONE workspace from real audit rows: query workspace-scoped audit → project via
// the existing `projectRecentChanges` → `readModels.put`. Replaces the dev-only `buildSyncRecentChange`
// (provisionDev.ts) on the real path. Two safety properties: WS-8-safe by construction (the scoped `audit.query`
// AND the projector's fail-closed foreign/null-scope drop — the write key is always the served workspaceId, never
// a record-derived value), and never-throws typed Result (§16) — a query/put fault is a typed Err with NO
// partial/false write. Full REFRESH (rebuilds the whole row); the trigger is a separate bounded, fail-SAFE seam
// that surfaces a HealthItem on fault and NEVER blocks/fails the (sole-writer, durable) KW commit.
import { ok, err, isErr } from "@sow/contracts";
import type { Result, AuditRecord } from "@sow/contracts";
import type { AuditRepository, DbError, ReadModelRecord, ReadModelRepository } from "@sow/db";
import { projectRecentChanges, RECENT_CHANGES_AUDIT_SCAN_BOUND } from "../api/projections/recentChanges";
import { READ_MODEL_KEYS } from "../api/adapters/readModel";

export interface RefreshRecentChangesInput {
  readonly workspaceId: string;
}
export interface RefreshRecentChangesDeps {
  readonly audit: AuditRepository;
  readonly readModels: ReadModelRepository;
  readonly now: () => string;
}
export interface RefreshRecentChangesError {
  readonly code: "audit_query_failed" | "read_model_put_failed";
  readonly message: string;
}

/**
 * Refresh the `recent_changes` read-model row for `input.workspaceId` from real audit rows. Never throws (§16):
 * an `audit.query` fault (returned Err OR thrown) → typed Err with NO put; a `readModels.put` fault → typed Err.
 * The audit query is workspace-scoped and the projector drops any foreign/null-scope record (WS-8 defense-in-depth);
 * the write key is always the served `workspaceId`. Unconditional put — an empty projection writes `{changes:[]}`
 * with a fresh `rebuiltAt` (a full refresh always reflects current state + a freshness signal).
 */
export async function refreshRecentChanges(
  input: RefreshRecentChangesInput,
  deps: RefreshRecentChangesDeps,
): Promise<Result<void, RefreshRecentChangesError>> {
  let audited: Result<AuditRecord[], DbError>;
  try {
    audited = await deps.audit.query({ workspaceId: input.workspaceId }, RECENT_CHANGES_AUDIT_SCAN_BOUND);
  } catch {
    return err({ code: "audit_query_failed", message: "audit query threw" });
  }
  if (isErr(audited)) return err({ code: "audit_query_failed", message: `audit query failed: ${audited.error.code}` });

  const { changes } = projectRecentChanges(audited.value, input.workspaceId);

  let put: Result<ReadModelRecord, DbError>;
  try {
    // Full REFRESH: replaces the whole row from the current audit projection — deliberately NOT the sibling
    // dev-writer's sibling-preserving upsert (`provisionDev.ts` `upsertRecentChangeRow`). On the real path the
    // audit feed is the source of truth, so a real commit supersedes any dev-only `project-synced` placeholder rows.
    put = await deps.readModels.put({
      readModelKey: READ_MODEL_KEYS.recentChanges,
      workspaceId: input.workspaceId,
      data: { changes },
      rebuiltAt: deps.now(),
    });
  } catch {
    return err({ code: "read_model_put_failed", message: "read-model put threw" });
  }
  if (isErr(put)) return err({ code: "read_model_put_failed", message: `read-model put failed: ${put.error.code}` });
  return ok(undefined);
}
