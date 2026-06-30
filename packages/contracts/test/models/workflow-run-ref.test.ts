// WorkflowRunRef contract test (task 1.9, §3/§9). RED-first schema-snapshot
// freeze + behavior + field-constraint coverage. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import {
  WorkflowRunRefSchema,
  WORKFLOW_RUN_REF_SCHEMA_ID,
} from "../../src/models/workflow-run-ref";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

describe("WorkflowRunRef contract — spec(§3/§9)", () => {
  // ── Frozen field-name set (spec, hand-authored in __snapshots__) ───────────
  it("freezes its top-level field-name set (spec snapshot)", () => {
    expect(
      fieldSet(emitJsonSchema(WorkflowRunRefSchema, WORKFLOW_RUN_REF_SCHEMA_ID)),
    ).toEqual(loadFieldSnapshot("workflow-run-ref"));
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/workflow-run-ref.schema.json", import.meta.url),
      emitJsonSchema(WorkflowRunRefSchema, WORKFLOW_RUN_REF_SCHEMA_ID),
    );
  });

  // ── Behaviors ──────────────────────────────────────────────────────────────
  it("accepts a valid workflow-run ref (with audit refs)", () => {
    const ok = WorkflowRunRefSchema.safeParse({
      workflowId: "wf-meeting-close",
      // trigger/state are §9 open strings here (the 6 state machines live in §9).
      trigger: "schedule",
      state: "running",
      idempotencyKey: "wf-meeting-close:2026-06-30",
      auditRefs: ["audit-1", "audit-2"],
    });
    expect(ok.success).toBe(true);
  });

  it("accepts an empty auditRefs list (refs accumulate over a run's life)", () => {
    const ok = WorkflowRunRefSchema.safeParse({
      workflowId: "wf-x",
      trigger: "manual",
      state: "pending",
      idempotencyKey: "k1",
      auditRefs: [],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown top-level key (strict)", () => {
    const bad = WorkflowRunRefSchema.safeParse({
      workflowId: "wf-x",
      trigger: "manual",
      state: "pending",
      idempotencyKey: "k1",
      auditRefs: [],
      extra: "nope",
    });
    expect(bad.success).toBe(false);
  });

  // ── Invariant: idempotencyKey required non-empty ────────────────────────────
  it("rejects an empty idempotencyKey (required non-empty)", () => {
    const bad = WorkflowRunRefSchema.safeParse({
      workflowId: "wf-x",
      trigger: "manual",
      state: "pending",
      idempotencyKey: "",
      auditRefs: [],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing idempotencyKey (required)", () => {
    const bad = WorkflowRunRefSchema.safeParse({
      workflowId: "wf-x",
      trigger: "manual",
      state: "pending",
      auditRefs: [],
    });
    expect(bad.success).toBe(false);
  });

  // ── Branded-field non-emptiness ─────────────────────────────────────────────
  it("rejects an empty workflowId (branded non-empty)", () => {
    const bad = WorkflowRunRefSchema.safeParse({
      workflowId: "",
      trigger: "manual",
      state: "pending",
      idempotencyKey: "k1",
      auditRefs: [],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty entry in auditRefs (branded AuditId non-empty)", () => {
    const bad = WorkflowRunRefSchema.safeParse({
      workflowId: "wf-x",
      trigger: "manual",
      state: "pending",
      idempotencyKey: "k1",
      auditRefs: [""],
    });
    expect(bad.success).toBe(false);
  });

  // ── Open-string fields still reject empty (taxonomy unspecified, not blank) ──
  it("rejects an empty trigger", () => {
    const bad = WorkflowRunRefSchema.safeParse({
      workflowId: "wf-x",
      trigger: "",
      state: "pending",
      idempotencyKey: "k1",
      auditRefs: [],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty state", () => {
    const bad = WorkflowRunRefSchema.safeParse({
      workflowId: "wf-x",
      trigger: "manual",
      state: "",
      idempotencyKey: "k1",
      auditRefs: [],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing required field (auditRefs)", () => {
    const bad = WorkflowRunRefSchema.safeParse({
      workflowId: "wf-x",
      trigger: "manual",
      state: "pending",
      idempotencyKey: "k1",
    });
    expect(bad.success).toBe(false);
  });
});
