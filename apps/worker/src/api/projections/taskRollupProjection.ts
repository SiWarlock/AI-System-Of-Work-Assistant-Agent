// Task 13.16 (§11 Today/task surface + §10 read-model serving + §5/WS-8) — the write-time task-rollup
// PRODUCER core. `refreshTaskRollup` projects the 13.15 Task store (`TaskRepository.listByWorkspace`)
// into the frozen `UiSafeTaskRollup` — a PRE-RANKED, WORKSPACE-scoped ordered list the §11
// "highest-priority tasks" surface serves — and upserts the `task_rollup` read-model row. Deterministic
// over injected deps; never throws (§16); fail-SAFE (L77 — a source/put fault is a typed Err, never a
// partial write, never blocks a caller). Mirrors `calendarProjection.ts` (9.9a) + `recentChangesProducer`.
//
// SAFETY POSTURE:
//   • WS-8 positive-keying: the write key is the SERVED `workspaceId`; `listByWorkspace` reads only that
//     authorized workspace (never a cross-workspace enumeration — see the @sow/db interface note); the
//     emitted `UiSafeTaskRollupItem` carries NO `workspaceId` (a pushed/cached row can't blend scopes).
//   • REQ-F-017 no-inference: priority is NEVER guessed — an absent `TaskRow.priority` maps to an item
//     with NO `priority` field and ranks LAST. Ranking is purely on the real, stored fields.
//   • Terminal statuses (`done`/`cancelled`) are EXCLUDED (a completed task isn't a priority).
//
// Ships DORMANT: no `TaskRow` writer exists yet (13.15 built the repo, not a populator), so this producer
// is NOT wired in `composition/`/`boot.ts` — the serve path (`query.taskRollup`) is empty-until-data. The
// post-commit trigger binding (like `recentChanges`) is a named follow-up.
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { Result, WorkspaceId, Priority, UiSafeTaskRollupItem } from "@sow/contracts";
import type { ReadModelRepository, TaskRepository, TaskRow } from "@sow/db";
import { READ_MODEL_KEYS } from "../adapters/readModel";

/** Write-side cap — mirrors the read cap (`sanitizeTaskRollup`) + the frozen `UiSafeTaskRollupSchema.max(200)`. */
const TASK_ROLLUP_CAP = 200;

/** Priority rank (lower = higher priority). An ABSENT priority ranks LAST (unset, never inferred). */
const PRIORITY_RANK: Record<Priority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
const UNSET_PRIORITY_RANK = 4;

/** The served/authorized workspace this rollup is for (WS-2/WS-8 — never a caller-derived cross-ws value). */
export interface RefreshTaskRollupInput {
  readonly workspaceId: WorkspaceId;
}

/** Deps: the typed-Task rollup repo + the read-model repo + a clock (deterministic/testable). */
export interface RefreshTaskRollupDeps {
  readonly tasks: TaskRepository;
  readonly readModels: ReadModelRepository;
  /** ISO-8601 now — injected so the producer stays deterministic (the `rebuiltAt` stamp). */
  readonly now: () => string;
}

/** A typed producer failure (never thrown — §16; fail-SAFE, L77). */
export interface RefreshTaskRollupError {
  readonly code: "task_rollup_write_failed";
  readonly message: string;
  readonly cause?: unknown;
}

const fail = (message: string, cause?: unknown): RefreshTaskRollupError => ({
  code: "task_rollup_write_failed",
  message,
  cause,
});

/**
 * Deterministic, CI-stable rank (REQ-F-017 — no inference): priority `p0<p1<p2<p3<UNSET-last`, then
 * dueDate EARLIEST-first (an unset OR unparseable dueDate ranks last via `Infinity`), then `taskId` asc
 * as the final tiebreak (mirrors the RRF id-asc tiebreak, L26 — a stable order across dialects/runs).
 */
function rankRows(rows: readonly TaskRow[]): TaskRow[] {
  return [...rows].sort((a, b) => {
    const pa = a.priority !== undefined ? PRIORITY_RANK[a.priority] : UNSET_PRIORITY_RANK;
    const pb = b.priority !== undefined ? PRIORITY_RANK[b.priority] : UNSET_PRIORITY_RANK;
    if (pa !== pb) return pa - pb;
    const da = a.dueDate !== undefined ? Date.parse(a.dueDate) : NaN;
    const db = b.dueDate !== undefined ? Date.parse(b.dueDate) : NaN;
    const dav = Number.isFinite(da) ? da : Infinity; // unset / malformed → last
    const dbv = Number.isFinite(db) ? db : Infinity;
    if (dav !== dbv) return dav - dbv;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });
}

/**
 * Map a `TaskRow` → `UiSafeTaskRollupItem`: copies ONLY the UI-safe fields by EXPLICIT copy (no spread) —
 * `workspaceId` is DROPPED (WS-8), `projectId` is renamed to the opaque `projectRef` handle. `TaskRow`
 * already omits `provenanceOrigin` (the operational index carries no provenance). Optional fields are
 * OMITTED when absent (never a `undefined`-valued key; REQ-F-017 for `priority`).
 */
function toItem(row: TaskRow): UiSafeTaskRollupItem {
  const item: UiSafeTaskRollupItem = { taskId: row.taskId, title: row.title, status: row.status };
  if (row.priority !== undefined) item.priority = row.priority;
  if (row.dueDate !== undefined) item.dueDate = row.dueDate;
  if (row.projectId !== undefined) item.projectRef = row.projectId;
  return item;
}

/**
 * Refresh the `task_rollup` read-model row for `input.workspaceId` from the real Task store. Full-refresh
 * SUPERSEDES (unconditional put — an empty projection writes `{items:[]}`). Never throws (§16): a
 * `listByWorkspace` fault (returned Err OR thrown) → typed Err with NO put; a `readModels.put` fault →
 * typed Err. WS-8: the write key is always the served `workspaceId`. Fail-SAFE (L77).
 */
export async function refreshTaskRollup(
  input: RefreshTaskRollupInput,
  deps: RefreshTaskRollupDeps,
): Promise<Result<void, RefreshTaskRollupError>> {
  try {
    const listed = await deps.tasks.listByWorkspace(input.workspaceId);
    if (isErr(listed)) return err(fail("task list failed", listed.error));
    // Exclude terminal statuses (a completed/cancelled task isn't a priority), rank, cap, project.
    const active = listed.value.filter((r) => r.status !== "done" && r.status !== "cancelled");
    const items = rankRows(active).slice(0, TASK_ROLLUP_CAP).map(toItem);
    const put = await deps.readModels.put({
      readModelKey: READ_MODEL_KEYS.taskRollup,
      workspaceId: input.workspaceId, // WS-8 write-key = the served workspace
      data: { items },
      rebuiltAt: deps.now(),
    });
    return isOk(put) ? ok(undefined) : err(fail("task rollup put failed", put.error));
  } catch (cause) {
    return err(fail("unexpected refresh fault", cause));
  }
}
