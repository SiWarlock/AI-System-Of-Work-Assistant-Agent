// Task contract test (§13.15, §3/§6/§9). RED-first schema-snapshot freeze + behavior. The typed Task seam
// model — the sibling of the typed Project model (13.5) — carrying an optional, NEVER-inferred `priority`
// (absent ⇒ unset/TBD, REQ-F-017) + an optional `projectId` binding. Mirrors the Project / AuditRecord
// template. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import { TaskSchema, TASK_SCHEMA_ID } from "../../src/models/task";
import { TaskLifecycle, Priority } from "../../src/models/shared-enums";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// A fully-populated valid task reused as the base for negative fixtures.
const validTask = {
  id: "task-1",
  workspaceId: "personal-business",
  projectId: "proj-1",
  title: "Ship the frozen contracts",
  status: "in_progress",
  priority: "p1",
  dueDate: "2026-08-01T00:00:00.000Z",
  provenanceOrigin: "meeting_close",
};

describe("Task contract — spec(§13.15/§3/§6/§9)", () => {
  // ── Frozen field-name set (hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(TaskSchema, TASK_SCHEMA_ID))).toEqual(loadFieldSnapshot("task"));
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/task.schema.json", import.meta.url),
      emitJsonSchema(TaskSchema, TASK_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a fully-valid task", () => {
    expect(TaskSchema.safeParse(validTask).success).toBe(true);
  });

  // REQ-F-017 no-inference: an absent priority stays ABSENT — never defaulted/guessed.
  it("accepts a task with NO priority and leaves it UNSET (never inferred — REQ-F-017) spec(§6)", () => {
    const { priority: _omit, ...noPriority } = validTask;
    const parsed = TaskSchema.safeParse(noPriority);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // The unset/TBD state: priority is undefined, NOT defaulted to a value.
    expect(parsed.data.priority).toBeUndefined();
  });

  it("rejects an out-of-vocabulary priority (closed-vocabulary candidate-data gate) spec(§6)", () => {
    expect(TaskSchema.safeParse({ ...validTask, priority: "urgent" }).success).toBe(false);
  });

  it("accepts every priority in the closed vocabulary", () => {
    for (const p of Priority) {
      expect(TaskSchema.safeParse({ ...validTask, priority: p }).success, `priority ${p}`).toBe(true);
    }
  });

  // Additive/optional cross-entity ref (no required cross-entity gate — contract Lesson 15).
  it("accepts a task with NO projectId, and one WITH a valid projectId spec(§6)", () => {
    const { projectId: _omit, ...noProject } = validTask;
    expect(TaskSchema.safeParse(noProject).success).toBe(true);
    expect(TaskSchema.safeParse({ ...validTask, projectId: "proj-99" }).success).toBe(true);
  });

  it("accepts a task with NO dueDate (optional)", () => {
    const { dueDate: _omit, ...noDue } = validTask;
    expect(TaskSchema.safeParse(noDue).success).toBe(true);
  });

  it("rejects unknown top-level keys (.strict)", () => {
    expect(TaskSchema.safeParse({ ...validTask, extra: 1 }).success).toBe(false);
  });

  it("rejects an empty id / workspaceId / title, and an empty (present) optional projectId — branded + min-length gates", () => {
    // projectId is OPTIONAL, but a PRESENT empty string still fails the branded min(1) gate
    // (only absence is the unset state — a provided "" is invalid, never coerced).
    for (const patch of [{ id: "" }, { workspaceId: "" }, { title: "" }, { projectId: "" }]) {
      expect(TaskSchema.safeParse({ ...validTask, ...patch }).success).toBe(false);
    }
  });

  it("accepts every lifecycle status as valid", () => {
    for (const status of TaskLifecycle) {
      expect(TaskSchema.safeParse({ ...validTask, status }).success, `status ${status}`).toBe(true);
    }
  });

  it("rejects an unknown lifecycle status", () => {
    expect(TaskSchema.safeParse({ ...validTask, status: "snoozed" }).success).toBe(false);
  });

  it("rejects a non-ISO dueDate", () => {
    expect(TaskSchema.safeParse({ ...validTask, dueDate: "tomorrow" }).success).toBe(false);
  });

  it("rejects an unknown provenanceOrigin", () => {
    expect(TaskSchema.safeParse({ ...validTask, provenanceOrigin: "nope" }).success).toBe(false);
  });
});
