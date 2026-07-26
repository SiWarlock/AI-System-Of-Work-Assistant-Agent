// Task 13.16 (§11 Today/task surface + §10 read-model + §5/WS-8) — the write-time task-rollup PRODUCER.
// `refreshTaskRollup` projects the 13.15 Task store (`TaskRepository.listByWorkspace`) into the frozen
// `UiSafeTaskRollup`: excludes terminal statuses, ranks DETERMINISTICALLY (priority p0<p1<p2<p3<UNSET-last
// → dueDate earliest-first → taskId asc; REQ-F-017 NEVER infers priority), maps TaskRow→UiSafeTaskRollupItem
// (drops workspaceId; projectId→projectRef), and upserts the WORKSPACE-scoped `task_rollup` read-model row.
// WS-8 positive-keying (write key = served wsId; emitted shape carries NO workspaceId). Never-throws,
// fail-SAFE (L77). Ships DORMANT (no TaskRow writer yet — the composition binding is a deferred follow-up).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { isOk, isErr, workspaceId } from "@sow/contracts";
import type { WorkspaceId, UiSafeTaskRollupItem } from "@sow/contracts";
import type { TaskRepository, TaskRow, ReadModelRepository, ReadModelRecord, DbResult, DbError } from "@sow/db";
import { refreshTaskRollup } from "../../../src/api/projections/taskRollupProjection";
import { READ_MODEL_KEYS } from "../../../src/api/adapters/readModel";

const WS_A: WorkspaceId = workspaceId("ws-a");
const WS_B: WorkspaceId = workspaceId("ws-b");
const NOW = "2026-07-25T12:00:00.000Z";
const notFound: DbError = { code: "not_found", message: "absent" } as DbError;

/** A TaskRow with sensible defaults (WS_A / todo) — override any field. */
function row(over: Partial<TaskRow> & { taskId: string }): TaskRow {
  return { workspaceId: WS_A, title: `t-${over.taskId}`, status: "todo", ...over } as TaskRow;
}

function fakeReadModels(putFault = false): { repo: ReadModelRepository; puts: ReadModelRecord[] } {
  const puts: ReadModelRecord[] = [];
  const repo: ReadModelRepository = {
    get: (): DbResult<ReadModelRecord> => Promise.resolve({ ok: false, error: notFound }),
    put: (record: ReadModelRecord): DbResult<ReadModelRecord> => {
      puts.push(record);
      return putFault
        ? Promise.resolve({ ok: false, error: { code: "unavailable", message: "down" } as DbError })
        : Promise.resolve({ ok: true, value: record });
    },
    clear: (): DbResult<void> => Promise.resolve({ ok: true, value: undefined }),
  };
  return { repo, puts };
}

function fakeTasks(rows: TaskRow[], opts: { fault?: boolean } = {}): TaskRepository {
  return {
    upsert: (r: TaskRow): DbResult<TaskRow> => Promise.resolve({ ok: true, value: r }),
    get: (): DbResult<TaskRow> => Promise.resolve({ ok: false, error: notFound }),
    listByWorkspace: (wsId: WorkspaceId): DbResult<TaskRow[]> =>
      opts.fault
        ? Promise.resolve({ ok: false, error: { code: "unavailable", message: "db down" } as DbError })
        : Promise.resolve({ ok: true, value: rows.filter((r) => r.workspaceId === wsId) }),
  };
}

function itemsOf(puts: ReadModelRecord[]): readonly UiSafeTaskRollupItem[] {
  expect(puts.length).toBe(1);
  return (puts[0]!.data as { items: readonly UiSafeTaskRollupItem[] }).items;
}

describe("§13.16 task-rollup read-model producer (WS-8 / REQ-F-017 / L77)", () => {
  it("ranks_priority_then_due_then_id — p0<p1<p2<p3<UNSET; dueDate earliest-first within a priority; taskId asc final tiebreak", async () => {
    const { repo, puts } = fakeReadModels();
    const tasks = fakeTasks([
      row({ taskId: "t3", priority: "p3" }),
      row({ taskId: "tU" }), // no priority → last
      row({ taskId: "t1b", priority: "p1", dueDate: "2026-07-26T00:00:00.000Z" }),
      row({ taskId: "t1a", priority: "p1", dueDate: "2026-07-25T00:00:00.000Z" }), // earlier due → before t1b
      row({ taskId: "t0", priority: "p0" }),
      row({ taskId: "t1z", priority: "p1", dueDate: "2026-07-25T00:00:00.000Z" }), // same due as t1a → taskId asc (t1a<t1z)
    ]);
    const r = await refreshTaskRollup({ workspaceId: WS_A }, { tasks, readModels: repo, now: () => NOW });
    expect(isOk(r)).toBe(true);
    expect(itemsOf(puts).map((i) => i.taskId)).toEqual(["t0", "t1a", "t1z", "t1b", "t3", "tU"]);
  });

  it("absent_priority_stays_unset — a task with no priority emits an item with NO priority field, sorted last (never guessed)", async () => {
    const { repo, puts } = fakeReadModels();
    const tasks = fakeTasks([row({ taskId: "tU" }), row({ taskId: "t0", priority: "p0" })]);
    await refreshTaskRollup({ workspaceId: WS_A }, { tasks, readModels: repo, now: () => NOW });
    const list = itemsOf(puts);
    const tU = list.find((i) => i.taskId === "tU")!;
    expect("priority" in tU).toBe(false); // REQ-F-017 — absent, never fabricated
    expect(list[list.length - 1]!.taskId).toBe("tU"); // unset ranks last
  });

  it("excludes_terminal_statuses — done + cancelled tasks are omitted from the rollup", async () => {
    const { repo, puts } = fakeReadModels();
    const tasks = fakeTasks([
      row({ taskId: "done1", status: "done", priority: "p0" }),
      row({ taskId: "cancel1", status: "cancelled", priority: "p0" }),
      row({ taskId: "active1", status: "in_progress", priority: "p1" }),
      row({ taskId: "blocked1", status: "blocked", priority: "p2" }),
    ]);
    await refreshTaskRollup({ workspaceId: WS_A }, { tasks, readModels: repo, now: () => NOW });
    expect(itemsOf(puts).map((i) => i.taskId)).toEqual(["active1", "blocked1"]);
  });

  it("ws8_positive_keying — tasks for A are stored under (task_rollup, A); B's task never blends (listByWorkspace scoped)", async () => {
    const { repo, puts } = fakeReadModels();
    const tasks = fakeTasks([row({ taskId: "a1", workspaceId: WS_A }), row({ taskId: "b1", workspaceId: WS_B })]);
    await refreshTaskRollup({ workspaceId: WS_A }, { tasks, readModels: repo, now: () => NOW });
    expect(puts[0]!.readModelKey).toBe(READ_MODEL_KEYS.taskRollup);
    expect(puts[0]!.workspaceId).toBe(WS_A); // the SERVED ws is the write key (WS-8 positive keying)
    expect(itemsOf(puts).map((i) => i.taskId)).toEqual(["a1"]);
  });

  it("emitted_rollup_has_no_workspaceId — the serialized items carry NO workspaceId; only the 6 allowlisted fields", async () => {
    const { repo, puts } = fakeReadModels();
    const tasks = fakeTasks([row({ taskId: "a1", projectId: "prj-1", priority: "p0", dueDate: "2026-07-25T00:00:00.000Z" })]);
    await refreshTaskRollup({ workspaceId: WS_A }, { tasks, readModels: repo, now: () => NOW });
    const serialized = JSON.stringify(itemsOf(puts));
    expect(serialized).not.toContain("workspaceId");
    expect(serialized).not.toContain("ws-a");
    const item = itemsOf(puts)[0]!;
    expect(new Set(Object.keys(item))).toEqual(new Set(["taskId", "title", "status", "priority", "dueDate", "projectRef"]));
    expect(item.projectRef).toBe("prj-1"); // projectId → projectRef
  });

  it("producer_fail_safe_never_throws — a listByWorkspace fault → typed Err with NO put (never partial, never blocks, never throws)", async () => {
    const { repo, puts } = fakeReadModels();
    const r = await refreshTaskRollup({ workspaceId: WS_A }, { tasks: fakeTasks([], { fault: true }), readModels: repo, now: () => NOW });
    expect(isErr(r)).toBe(true);
    expect(puts.length).toBe(0); // no write on a source fault
  });

  it("producer_fail_safe_put_fault — a readModels.put fault → typed Err (never throws, L77)", async () => {
    const { repo } = fakeReadModels(true);
    const r = await refreshTaskRollup({ workspaceId: WS_A }, { tasks: fakeTasks([row({ taskId: "a1" })]), readModels: repo, now: () => NOW });
    expect(isErr(r)).toBe(true);
  });

  it("cap_at_200 — >200 active tasks are capped to 200 (flood-bound, mirrors UiSafeTaskRollupSchema.max(200))", async () => {
    const { repo, puts } = fakeReadModels();
    const many = Array.from({ length: 250 }, (_, i) => row({ taskId: `t${String(i).padStart(3, "0")}`, priority: "p1" }));
    await refreshTaskRollup({ workspaceId: WS_A }, { tasks: fakeTasks(many), readModels: repo, now: () => NOW });
    expect(itemsOf(puts).length).toBe(200);
  });

  it("all_terminal_writes_empty_supersede — a workspace with ONLY done/cancelled tasks WRITES {items:[]} (full-refresh supersede — distinct from a fault no-write)", async () => {
    const { repo, puts } = fakeReadModels();
    const tasks = fakeTasks([row({ taskId: "d1", status: "done" }), row({ taskId: "c1", status: "cancelled" })]);
    const r = await refreshTaskRollup({ workspaceId: WS_A }, { tasks, readModels: repo, now: () => NOW });
    expect(isOk(r)).toBe(true);
    expect(puts.length).toBe(1); // a write DID happen (supersede with empty) — unlike a source fault (no write)
    expect(itemsOf(puts)).toEqual([]);
  });

  it("dormant_producer_unbound — refreshTaskRollup is NOT wired in composition/ or boot.ts (dormant/empty-until-data, mirrors 9.9a)", () => {
    const compDir = new URL("../../../src/composition/", import.meta.url).pathname;
    const scanned = readdirSync(compDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => compDir + f)
      .concat([new URL("../../../src/boot.ts", import.meta.url).pathname]);
    const hits = scanned.filter((p) => readFileSync(p, "utf8").includes("refreshTaskRollup"));
    expect(hits).toEqual([]); // no composition-root/boot binding — the producer ships dormant
  });
});
