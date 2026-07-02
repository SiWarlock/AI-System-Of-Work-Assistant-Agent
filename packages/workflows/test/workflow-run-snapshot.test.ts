// spec(§9) — RED-first drift guard for slice 7.4 (WorkflowRun registry).
//
// Two frozen surfaces are pinned here so a later drift fails LOUDLY:
//   (1) The @sow/contracts WorkflowRunRef FIELD-NAME set. The field-name set was
//       FROZEN in Phase 1 (task 1.9) and the §9 durability spine builds on it —
//       adding/removing a top-level key upstream must break this test (it forces
//       the Appendix-A + schema-snapshot round discipline). We read the frozen
//       set through the same generated-JSON-Schema path the contract's own
//       snapshot test uses (emitJsonSchema → fieldSet), never a hand-copied list.
//   (2) The @sow/workflows-LOCAL trigger + state VALUE taxonomies. trigger/state
//       are OPEN strings upstream; §9 pins the closed value sets locally. A silent
//       edit to either enum must fail this snapshot.
import { describe, it, expect } from "vitest";
import {
  WorkflowRunRefSchema,
  WORKFLOW_RUN_REF_SCHEMA_ID,
  emitJsonSchema,
  fieldSet,
} from "@sow/contracts";
import { WORKFLOW_TRIGGERS } from "../src/ports/operational";
import {
  WORKFLOW_RUN_STATES,
  TERMINAL_WORKFLOW_RUN_STATES,
} from "../src/runtime/workflowRun";

describe("spec(§9) WorkflowRun contract drift guard", () => {
  it("pins the FROZEN WorkflowRunRef top-level field-name set", () => {
    const schema = emitJsonSchema(WorkflowRunRefSchema, WORKFLOW_RUN_REF_SCHEMA_ID);
    // Exact, sorted top-level key set — frozen in Phase 1. NO workspaceId: the
    // ref carries no workspace field, so workspace binding (WS-2) is enforced by
    // an admission PARAMETER, never a ref key.
    expect(fieldSet(schema)).toEqual([
      "auditRefs",
      "idempotencyKey",
      "state",
      "trigger",
      "workflowId",
    ]);
  });

  it("pins the LOCAL §9 trigger value taxonomy", () => {
    expect([...WORKFLOW_TRIGGERS]).toEqual([
      "schedule",
      "connector_event",
      "owner_action",
      "hermes_automation",
    ]);
  });

  it("pins the LOCAL §9 WorkflowRunState value taxonomy", () => {
    expect([...WORKFLOW_RUN_STATES]).toEqual([
      "running",
      "waiting_approval",
      "completed",
      "failed",
      "cancelled",
    ]);
  });

  it("pins the LOCAL §9 TERMINAL WorkflowRunState subset", () => {
    expect([...TERMINAL_WORKFLOW_RUN_STATES]).toEqual([
      "completed",
      "failed",
      "cancelled",
    ]);
  });
});
