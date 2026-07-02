// spec(§9) — slice 7.4 WorkflowRun registry admission + state-guard rules.
//
// PURE runtime over an INJECTED WorkflowRunRefRepository + Clock (a FakeClock).
// No Temporal server, no real DB, no Date.now(). Every function returns a typed
// Result<T, WorkflowRunError> with an ENUMERABLE closed failure set (§16) — never
// throws across the boundary.
//
// Invariants pinned:
//   • REQ-F-002 / WS-2: WORKSPACE is bound before any durable processing. An
//     UNSCOPED run (missing/blank workspaceId) is REJECTED at admission — a
//     durable step cannot execute on an unscoped run.
//   • A run cannot reach a TERMINAL state (completed | failed | cancelled) without
//     an audit trail (auditRefs non-empty). Enforced by the transition guard.
//   • State transitions route through a small guard (the reused defineMachine).
import { describe, it, expect } from "vitest";
import { isOk, isErr, workflowId, auditId } from "@sow/contracts";
import type { WorkflowRunRef } from "@sow/contracts";
import {
  createWorkflowRun,
  transitionWorkflowRun,
  workflowRunMachine,
} from "../src/runtime/workflowRun";
import { FakeClock, InMemoryWorkflowRunRepo } from "./support/fakes";

describe("spec(§9) createWorkflowRun — admission + workspace binding (WS-2)", () => {
  it("creates a valid, workspace-scoped run in the RUNNING initial state", async () => {
    const repo = new InMemoryWorkflowRunRepo();
    const clock = new FakeClock();
    const res = await createWorkflowRun(
      {
        workflowId: workflowId("wf-a"),
        trigger: "schedule",
        idempotencyKey: "idem-a",
        workspaceId: "ws-employer",
      },
      repo,
      clock,
    );
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.workflowId).toBe("wf-a");
    expect(res.value.trigger).toBe("schedule");
    expect(res.value.state).toBe("running");
    expect(res.value.idempotencyKey).toBe("idem-a");
    expect(res.value.auditRefs).toEqual([]);
    // It was actually persisted through the repo (idempotency lookup finds it).
    const found = await repo.getByIdempotencyKey("idem-a");
    expect(isOk(found)).toBe(true);
  });

  it("REJECTS an UNSCOPED run (missing workspaceId) — WS-2 fail-closed", async () => {
    const repo = new InMemoryWorkflowRunRepo();
    const clock = new FakeClock();
    const res = await createWorkflowRun(
      {
        workflowId: workflowId("wf-b"),
        trigger: "schedule",
        idempotencyKey: "idem-b",
        // no workspaceId
      },
      repo,
      clock,
    );
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("unscoped_run");
    // Nothing was persisted.
    const found = await repo.getByIdempotencyKey("idem-b");
    expect(isErr(found)).toBe(true);
  });

  it("REJECTS a blank/whitespace workspaceId — WS-2 fail-closed", async () => {
    const repo = new InMemoryWorkflowRunRepo();
    const clock = new FakeClock();
    const res = await createWorkflowRun(
      {
        workflowId: workflowId("wf-c"),
        trigger: "owner_action",
        idempotencyKey: "idem-c",
        workspaceId: "   ",
      },
      repo,
      clock,
    );
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("unscoped_run");
  });

  it("surfaces a repo conflict as a typed persist_failed (never throws)", async () => {
    const repo = new InMemoryWorkflowRunRepo();
    const clock = new FakeClock();
    const first = await createWorkflowRun(
      { workflowId: workflowId("wf-d"), trigger: "schedule", idempotencyKey: "k1", workspaceId: "ws" },
      repo,
      clock,
    );
    expect(isOk(first)).toBe(true);
    // Same workflowId again → the repo returns a conflict; we surface it typed.
    const dup = await createWorkflowRun(
      { workflowId: workflowId("wf-d"), trigger: "schedule", idempotencyKey: "k2", workspaceId: "ws" },
      repo,
      clock,
    );
    expect(isErr(dup)).toBe(true);
    if (!isErr(dup)) return;
    expect(dup.error.code).toBe("persist_failed");
  });
});

describe("spec(§9) transitionWorkflowRun — state guard + terminal-needs-audit", () => {
  const scoped = (over: Partial<WorkflowRunRef> = {}): WorkflowRunRef => ({
    workflowId: workflowId("wf-t"),
    trigger: "schedule",
    state: "running",
    idempotencyKey: "idem-t",
    auditRefs: [],
    ...over,
  });

  it("allows a legal non-terminal edge (running → waiting_approval)", async () => {
    const repo = new InMemoryWorkflowRunRepo();
    await repo.create(scoped());
    const res = await transitionWorkflowRun(workflowId("wf-t"), "waiting_approval", repo);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.state).toBe("waiting_approval");
  });

  it("REJECTS a terminal transition when auditRefs is EMPTY (no audit trail)", async () => {
    const repo = new InMemoryWorkflowRunRepo();
    await repo.create(scoped({ state: "running", auditRefs: [] }));
    const res = await transitionWorkflowRun(workflowId("wf-t"), "completed", repo);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("terminal_without_audit");
    // The run was NOT moved to a terminal state.
    const still = await repo.get(workflowId("wf-t"));
    expect(isOk(still)).toBe(true);
    if (!isOk(still)) return;
    expect(still.value.state).toBe("running");
  });

  it("ALLOWS a terminal transition once an audit trail exists", async () => {
    const repo = new InMemoryWorkflowRunRepo();
    await repo.create(scoped({ state: "running", auditRefs: [auditId("audit-1")] }));
    const res = await transitionWorkflowRun(workflowId("wf-t"), "completed", repo);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.state).toBe("completed");
  });

  it("REJECTS an illegal edge through the guard (completed → running)", async () => {
    const repo = new InMemoryWorkflowRunRepo();
    await repo.create(scoped({ state: "completed", auditRefs: [auditId("a")] }));
    const res = await transitionWorkflowRun(workflowId("wf-t"), "running", repo);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("illegal_transition");
  });

  it("returns not_found for an unknown run (never throws)", async () => {
    const repo = new InMemoryWorkflowRunRepo();
    const res = await transitionWorkflowRun(workflowId("nope"), "completed", repo);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("not_found");
  });

  it("exposes the reused machine's taxonomy (running is non-terminal, completed terminal)", () => {
    expect(workflowRunMachine.isTerminal("running")).toBe(false);
    expect(workflowRunMachine.isTerminal("completed")).toBe(true);
    expect(workflowRunMachine.canTransition("running", "completed")).toBe(true);
    expect(workflowRunMachine.canTransition("completed", "running")).toBe(false);
  });
});
