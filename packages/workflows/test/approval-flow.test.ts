// spec(§9) — task 7.9 APPROVAL FLOW (incl. deferred snooze/expiry) — the PURE
// orchestration driver + the deferred snooze timer.
//
// These tests drive `runApprovalFlow` (the pure driver) over the approval-flow
// activity-port FAKES (test/support/approval-fakes.ts) + the foundation FakeClock +
// InMemoryWorkflowRunRepo. The driver imports NEITHER @temporalio NOR node:crypto
// and calls NO Date.now()/Math.random(), so it runs entirely in-memory with no
// Temporal server (root CLAUDE.md ★ two-layer split).
//
// The suite pins the 7.9 safety invariants:
//   • EXACTLY-ONCE across Mac + Telegram: a 2nd approve/reject from either channel
//     is an idempotent no-op (no double-apply, no double-audit, no double-dispatch).
//   • deferred → snooze re-surface (after the window) → auto-expire (after the TTL).
//   • an EXPIRED approval can NEVER later be approved.
//   • approved → a SINGLE Tool Gateway dispatch; a replay REUSES the receipt.
//   • rejection / deferral records WITHOUT an external side effect.
//   • precondition failure / stale card / conflicting approvals / parity break are
//     typed failure states → a 7.5 health item (inv-5: nothing silent).
//   • the §9 Approval contract field-name set + status enum (incl. deferred/expired,
//     snoozeUntil, expiresAt) are pinned against the frozen @sow/contracts snapshot.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, ApprovalSchema, APPROVAL_SCHEMA_ID, emitJsonSchema, fieldSet, ApprovalStatus } from "@sow/contracts";
import { workflowId } from "@sow/contracts";
import type {
  WorkspaceId,
  Approval,
  Result,
  ProposedAction,
  ExternalWriteEnvelope,
} from "@sow/contracts";
import { APPROVAL_STATES, APPROVAL_DEFAULTS } from "@sow/domain";
import { decideApprovalCas } from "@sow/db";
import type { ApprovalRepository, ApprovalTransitionOutcome, DbError, DbResult } from "@sow/db";
import { runApprovalFlow } from "../src/workflows/approvalFlow";
import type {
  ApprovalFlowInput,
  ApprovalFlowDeps,
} from "../src/workflows/approvalFlow";
import { createApplyTransitionActivity } from "../src/activities/approvalTransition";
import type {
  RecordPendingPort,
  RecordPendingResult,
  RecordPendingError,
  ApprovalFlowContext,
  DispatchApprovedActionPort,
} from "../src/ports/approvalFlow";
import {
  evaluateDeferred,
  resolveDeferredWindows,
  isExpired,
  DEFAULT_SNOOZE_CONFIG,
} from "../src/runtime/snoozeTimer";
import {
  FakeRecordPendingPort,
  FakeSurfaceCardPort,
  FakeApplyTransitionPort,
  FakeApprovalStore,
  FakeDispatchApprovedPort,
  FakeApprovalHealthSink,
  makeApprovalContext,
  makeApproval,
} from "./support/approval-fakes";
import { FakeClock, InMemoryWorkflowRunRepo } from "./support/fakes";

// --- fixtures --------------------------------------------------------------

const WS = "ws-employer" as WorkspaceId;

function makeInput(partial: Partial<ApprovalFlowInput> = {}): ApprovalFlowInput {
  return {
    run: {
      workflowId: workflowId("wf-ap-1"),
      trigger: "owner_action",
      idempotencyKey: "idem-run-ap-1",
      workspaceId: WS,
    },
    context: makeApprovalContext({ workspaceId: WS }),
    action: { kind: "decide", decision: { decision: "approved", channel: "mac", actor: "user:alice" } },
    ...partial,
  };
}

function makeDeps(overrides: Partial<ApprovalFlowDeps> = {}): ApprovalFlowDeps {
  return {
    record: new FakeRecordPendingPort(),
    surface: new FakeSurfaceCardPort(),
    applyTransition: new FakeApplyTransitionPort(),
    dispatch: new FakeDispatchApprovedPort(),
    health: new FakeApprovalHealthSink(),
    runs: new InMemoryWorkflowRunRepo(),
    clock: new FakeClock(),
    ...overrides,
  };
}

// --- happy approve → single Tool Gateway dispatch --------------------------

describe("runApprovalFlow — approve", () => {
  it("records → surfaces (parity) → applies approve → dispatches ONE external write", async () => {
    const record = new FakeRecordPendingPort();
    const surface = new FakeSurfaceCardPort();
    const dispatch = new FakeDispatchApprovedPort();
    const deps = makeDeps({ record, surface, dispatch });

    const outcome = await runApprovalFlow(makeInput(), deps);

    expect(outcome.state).toBe("approved");
    // Recorded once, card shown on BOTH channels (parity), one external create.
    expect(record.recordCount).toBe(1);
    expect(surface.surfaced).toHaveLength(1);
    expect(dispatch.createCount).toBe(1);
    // The write receipt rode back on the dispatched envelope.
    expect(outcome.dispatched?.writeReceipt).toBeDefined();
  });

  it("resolves the run idempotently through the foundation seam", async () => {
    const runs = new InMemoryWorkflowRunRepo();
    const first = await runApprovalFlow(makeInput(), makeDeps({ runs }));
    expect(isOk(first.run)).toBe(true);
    const second = await runApprovalFlow(makeInput(), makeDeps({ runs }));
    expect(second.runReused).toBe(true);
  });
});

// --- EXACTLY-ONCE across Mac + Telegram ------------------------------------

describe("runApprovalFlow — exactly-once across Mac + Telegram", () => {
  it("a 2nd approve from the OTHER channel is a no-op: no double-apply, no double-dispatch", async () => {
    // Shared durable store + dispatch survive across both channel drives (models
    // the real DB + Tool Gateway). The run repo persists the resolved run.
    const store = new FakeApprovalStore();
    const dispatch = new FakeDispatchApprovedPort();
    const runs = new InMemoryWorkflowRunRepo();

    // Mac approves first.
    const macIn = makeInput({
      action: { kind: "decide", decision: { decision: "approved", channel: "mac", actor: "user:alice" } },
    });
    const macDeps = makeDeps({
      applyTransition: new FakeApplyTransitionPort({ store }),
      dispatch,
      runs,
    });
    const mac = await runApprovalFlow(macIn, macDeps);
    expect(mac.state).toBe("approved");
    expect(store.applyCount).toBe(1);
    expect(dispatch.createCount).toBe(1);

    // Telegram approves the SAME approval second — idempotent no-op.
    const tgIn = makeInput({
      action: { kind: "decide", decision: { decision: "approved", channel: "telegram", actor: "user:alice" } },
    });
    const tgDeps = makeDeps({
      applyTransition: new FakeApplyTransitionPort({ store }),
      dispatch,
      runs,
    });
    const tg = await runApprovalFlow(tgIn, tgDeps);

    expect(tg.state).toBe("approved");
    // EXACTLY-ONCE: no second durable transition, no second external create.
    expect(store.applyCount).toBe(1);
    expect(dispatch.createCount).toBe(1);
  });

  it("a 2nd reject from the other channel is also a no-op (no double-audit)", async () => {
    const store = new FakeApprovalStore();
    const runs = new InMemoryWorkflowRunRepo();
    const rejectIn = (channel: "mac" | "telegram") =>
      makeInput({
        action: { kind: "decide", decision: { decision: "rejected", channel, actor: "user:alice" } },
      });

    const first = await runApprovalFlow(rejectIn("mac"), makeDeps({ applyTransition: new FakeApplyTransitionPort({ store }), runs }));
    expect(first.state).toBe("rejected");
    expect(store.applyCount).toBe(1);

    const second = await runApprovalFlow(rejectIn("telegram"), makeDeps({ applyTransition: new FakeApplyTransitionPort({ store }), runs }));
    expect(second.state).toBe("rejected");
    expect(store.applyCount).toBe(1); // no double-apply / double-audit
  });
});

// --- REGRESSION: end-to-end exactly-once over the REAL activity + faithful repo ---
//
// The exactly-once tests above use FakeApplyTransitionPort (a PORT-level fake that
// bypasses the real activity). The adversarial-verify HIGH finding is that the real
// activity (createApplyTransitionActivity) MISCLASSIFIES the shipped repo's
// `idempotent_noop` (ok(current)) as applied:true — so a second-channel approve on
// an already-approved record slips past the driver's `if (!applied) return` guard
// and dispatch fires a SECOND time. To catch it, this block wires the REAL activity
// over a decideApprovalCas-FAITHFUL repo, and a record port that hands back the
// DURABLE record (as the production record activity does on a re-drive) so the second
// approve arrives with from = current = "approved" (the self-loop the bug rides on).

/** decideApprovalCas-faithful in-memory repo — mirrors the shipped adapter's CAS. */
class FaithfulApprovalRepo implements ApprovalRepository {
  private readonly byId = new Map<string, Approval>();
  applyCount = 0;
  seed(a: Approval): void {
    this.byId.set(a.id, a);
  }
  create(approval: Approval): DbResult<Approval> {
    if (this.byId.has(approval.id)) {
      return Promise.resolve(err({ code: "conflict", message: "exists" } satisfies DbError));
    }
    this.byId.set(approval.id, approval);
    return Promise.resolve(ok(approval));
  }
  get(id: Approval["id"]): DbResult<Approval> {
    const found = this.byId.get(id);
    return Promise.resolve(
      found === undefined ? err({ code: "not_found", message: id } satisfies DbError) : ok(found),
    );
  }
  listByStatus(status: Approval["status"]): DbResult<Approval[]> {
    return Promise.resolve(ok([...this.byId.values()].filter((a) => a.status === status)));
  }
  listByStatusAndWorkspace(
    status: Approval["status"],
    workspaceId: Approval["workspaceId"],
  ): DbResult<Approval[]> {
    return Promise.resolve(
      ok([...this.byId.values()].filter((a) => a.status === status && a.workspaceId === workspaceId)),
    );
  }
  applyTransition(
    id: Approval["id"],
    expectedFromStatus: Approval["status"],
    next: Approval,
  ): DbResult<ApprovalTransitionOutcome> {
    const current = this.byId.get(id);
    if (current === undefined) {
      return Promise.resolve(err({ code: "not_found", message: id } satisfies DbError));
    }
    const verdict = decideApprovalCas(current.status, expectedFromStatus, next.status);
    switch (verdict.kind) {
      case "apply":
        this.byId.set(id, next);
        this.applyCount += 1;
        return Promise.resolve(ok({ approval: next, applied: true }));
      case "idempotent_noop":
        // ok with applied:FALSE — a genuine no-op that did NOT cause the transition
        // (NOT err(conflict)), so the caller learns it must not dispatch again.
        return Promise.resolve(ok({ approval: current, applied: false }));
      case "stale_conflict":
        return Promise.resolve(err({ code: "conflict", message: "stale" } satisfies DbError));
    }
  }
}

/**
 * A record port that returns the DURABLE record from the shared repo (modeling the
 * production record activity's re-read on a re-drive). The seeded id anchors the
 * pending record; on the second drive the durable record has already advanced to
 * `approved`, so the driver's `apply(pending=…)` receives from = "approved".
 */
function reReadingRecordPort(repo: FaithfulApprovalRepo, id: Approval["id"]): RecordPendingPort {
  return {
    async record(_ctx: ApprovalFlowContext): Promise<Result<RecordPendingResult, RecordPendingError>> {
      const cur = await repo.get(id);
      if (isOk(cur)) return ok({ approval: cur.value, created: false });
      return err({ code: "record_failed", message: "no pending record seeded" });
    },
  };
}

/**
 * A dispatch port that COUNTS how many times the driver INVOKED it (not just how
 * many DISTINCT external creates the gateway made). This is the load-bearing
 * assertion for the finding: the envelope dedupe would keep `createCount` at 1 even
 * when the driver calls dispatch a SECOND time — so createCount alone MASKS the bug.
 * `invocations` counts the driver actually reaching the dispatch step, which the
 * `applied:false` no-op guard must prevent on a second-channel / replay approve.
 */
function countingDispatch(): { port: DispatchApprovedActionPort; invocations: number } {
  const inner = new FakeDispatchApprovedPort();
  const spy = {
    invocations: 0,
    port: {
      dispatch(action: ProposedAction, env: ExternalWriteEnvelope) {
        spy.invocations += 1;
        return inner.dispatch(action, env);
      },
    },
  };
  return spy;
}

describe("runApprovalFlow — REGRESSION: second-channel approve over the REAL activity dispatches ONCE", () => {
  it("Mac approve dispatches once; Telegram approve on the now-approved record does NOT dispatch again", async () => {
    const repo = new FaithfulApprovalRepo();
    const pending = makeApproval({ status: "pending", channel: "mac", actor: "user:alice" });
    repo.seed(pending);

    const applyTransition = createApplyTransitionActivity({
      approvals: repo,
      now: "2026-07-01T00:00:00.000Z",
      snoozeUntil: "2026-07-02T00:00:00.000Z",
      expiresAt: "2026-07-08T00:00:00.000Z",
    });
    const dispatch = countingDispatch();
    const runs = new InMemoryWorkflowRunRepo();
    const record = reReadingRecordPort(repo, pending.id);

    // Mac approves — a genuine first transition → dispatch fires ONCE.
    const macIn = makeInput({
      run: { workflowId: workflowId("wf-ap-mac"), trigger: "owner_action", idempotencyKey: "idem-mac", workspaceId: WS },
      action: { kind: "decide", decision: { decision: "approved", channel: "mac", actor: "user:alice" } },
    });
    const mac = await runApprovalFlow(macIn, makeDeps({ record, applyTransition, dispatch: dispatch.port, runs }));
    expect(mac.state).toBe("approved");
    expect(repo.applyCount).toBe(1);
    expect(dispatch.invocations).toBe(1);

    // Telegram approves the SAME (now-approved) record — a distinct run so the run
    // seam does not short-circuit; from = current = "approved" (the self-loop). This
    // MUST be an idempotent no-op: no second durable apply, and the driver must NOT
    // even REACH dispatch (createCount alone would be masked by the envelope dedupe).
    const tgIn = makeInput({
      run: { workflowId: workflowId("wf-ap-tg"), trigger: "owner_action", idempotencyKey: "idem-tg", workspaceId: WS },
      action: { kind: "decide", decision: { decision: "approved", channel: "telegram", actor: "user:alice" } },
    });
    const tg = await runApprovalFlow(tgIn, makeDeps({ record, applyTransition, dispatch: dispatch.port, runs }));
    expect(tg.state).toBe("approved");
    expect(repo.applyCount).toBe(1); // no double-apply / double-audit
    expect(dispatch.invocations).toBe(1); // ★ EXACTLY ONCE — the bug fired this twice
  });

  it("CONCURRENT race: channel B holds a STALE pending view (from=pending) while A already committed approved → B is applied:false, dispatch stays at ONCE", async () => {
    // The exact TOCTOU the re-verify flagged HIGH: B's decision CASes from its stale
    // pre-write snapshot (expectedFrom = "pending"), but the durable record is ALREADY
    // "approved" (A committed first). decideApprovalCas(current=approved,
    // expectedFrom=pending, next=approved) → current===next → idempotent_noop → the
    // repo now surfaces applied:FALSE, so the activity reports applied:false and the
    // driver never reaches dispatch a second time. On the buggy code the activity took
    // the isOk(res) branch and reported applied:TRUE, firing dispatch twice.
    const repo = new FaithfulApprovalRepo();
    const pending = makeApproval({ status: "pending", channel: "mac", actor: "user:alice" });
    repo.seed(pending);
    const applyTransition = createApplyTransitionActivity({
      approvals: repo,
      now: "2026-07-01T00:00:00.000Z",
      snoozeUntil: "2026-07-02T00:00:00.000Z",
      expiresAt: "2026-07-08T00:00:00.000Z",
    });
    const dispatch = countingDispatch();
    const runs = new InMemoryWorkflowRunRepo();
    // Channel A re-reads the durable record (sees pending) and commits approved first.
    const recordA = reReadingRecordPort(repo, pending.id);
    const macIn = makeInput({
      run: { workflowId: workflowId("wf-race-mac"), trigger: "owner_action", idempotencyKey: "idem-race-mac", workspaceId: WS },
      action: { kind: "decide", decision: { decision: "approved", channel: "mac", actor: "user:alice" } },
    });
    const mac = await runApprovalFlow(macIn, makeDeps({ record: recordA, applyTransition, dispatch: dispatch.port, runs }));
    expect(mac.state).toBe("approved");
    expect(repo.applyCount).toBe(1);
    expect(dispatch.invocations).toBe(1);

    // Channel B's pre-write view is the ORIGINAL pending snapshot (its record port
    // hands back `pending`, NOT a re-read), so its apply CASes from = "pending" while
    // the durable record is already "approved" — the concurrent-race no-op.
    const staleRecordB: RecordPendingPort = {
      record(_ctx: ApprovalFlowContext): Promise<Result<RecordPendingResult, RecordPendingError>> {
        return Promise.resolve(ok({ approval: pending, created: false }));
      },
    };
    const tgIn = makeInput({
      run: { workflowId: workflowId("wf-race-tg"), trigger: "owner_action", idempotencyKey: "idem-race-tg", workspaceId: WS },
      action: { kind: "decide", decision: { decision: "approved", channel: "telegram", actor: "user:alice" } },
    });
    const tg = await runApprovalFlow(tgIn, makeDeps({ record: staleRecordB, applyTransition, dispatch: dispatch.port, runs }));
    expect(tg.state).toBe("approved");
    expect(repo.applyCount).toBe(1); // no second durable transition
    expect(dispatch.invocations).toBe(1); // ★ EXACTLY ONCE — the bug fired this twice
  });

  it("a workflow REPLAY of an already-approved run does not dispatch a second time", async () => {
    const repo = new FaithfulApprovalRepo();
    const pending = makeApproval({ status: "pending", channel: "mac", actor: "user:alice" });
    repo.seed(pending);
    const applyTransition = createApplyTransitionActivity({
      approvals: repo,
      now: "2026-07-01T00:00:00.000Z",
      snoozeUntil: "2026-07-02T00:00:00.000Z",
      expiresAt: "2026-07-08T00:00:00.000Z",
    });
    const dispatch = countingDispatch();
    const record = reReadingRecordPort(repo, pending.id);

    // First drive approves + dispatches once.
    const first = await runApprovalFlow(
      makeInput({ action: { kind: "decide", decision: { decision: "approved", channel: "mac", actor: "user:alice" } } }),
      makeDeps({ record, applyTransition, dispatch: dispatch.port }),
    );
    expect(first.state).toBe("approved");
    expect(dispatch.invocations).toBe(1);

    // Re-drive the SAME run (record re-reads the now-approved record → self-loop
    // apply). The applied:false no-op must keep the driver from REACHING dispatch a
    // second time (the envelope dedupe would otherwise hide a second invocation).
    const replay = await runApprovalFlow(
      makeInput({ action: { kind: "decide", decision: { decision: "approved", channel: "mac", actor: "user:alice" } } }),
      makeDeps({ record, applyTransition, dispatch: dispatch.port }),
    );
    expect(replay.state).toBe("approved");
    expect(repo.applyCount).toBe(1);
    expect(dispatch.invocations).toBe(1); // ★ no second dispatch on replay
  });
});

// --- rejection / deferral records WITHOUT side effect ----------------------

describe("runApprovalFlow — reject / defer records without side effect", () => {
  it("a rejection records but dispatches NO external write", async () => {
    const dispatch = new FakeDispatchApprovedPort();
    const input = makeInput({
      action: { kind: "decide", decision: { decision: "rejected", channel: "mac", actor: "user:alice" } },
    });
    const outcome = await runApprovalFlow(input, makeDeps({ dispatch }));

    expect(outcome.state).toBe("rejected");
    expect(dispatch.createCount).toBe(0); // no side effect (inv-E)
  });

  it("a deferral parks in deferred with NO external write", async () => {
    const dispatch = new FakeDispatchApprovedPort();
    const input = makeInput({
      action: { kind: "decide", decision: { decision: "deferred", channel: "mac", actor: "user:alice" } },
    });
    const outcome = await runApprovalFlow(input, makeDeps({ dispatch }));

    expect(outcome.state).toBe("deferred");
    expect(dispatch.createCount).toBe(0);
  });
});

// --- deferred → snooze re-surface → expire ---------------------------------

describe("runApprovalFlow — deferred snooze/expiry (inv-D)", () => {
  it("sleeps within the snooze window (no durable move)", async () => {
    const store = new FakeApprovalStore();
    const deferred = makeApproval({ status: "deferred" });
    store.seed(deferred);
    const clock = new FakeClock({ now: "2026-07-01T01:00:00.000Z" }); // 1h < 24h snooze
    const input = makeInput({
      context: makeApprovalContext({ workspaceId: WS, approval: deferred }),
      action: { kind: "snooze_tick", deferredAt: "2026-07-01T00:00:00.000Z" },
    });
    const apply = new FakeApplyTransitionPort({ store });
    const outcome = await runApprovalFlow(input, makeDeps({ applyTransition: apply, clock }));

    expect(outcome.state).toBe("deferred");
    expect(store.applyCount).toBe(0); // still asleep
  });

  it("re-surfaces to pending after the snooze window and shows the card again", async () => {
    const store = new FakeApprovalStore();
    const deferred = makeApproval({ status: "deferred" });
    store.seed(deferred);
    const surface = new FakeSurfaceCardPort();
    // 25h after deferral: past the 24h snooze, before the 7d expiry.
    const clock = new FakeClock({ now: "2026-07-02T01:00:00.000Z" });
    const input = makeInput({
      context: makeApprovalContext({ workspaceId: WS, approval: deferred }),
      action: { kind: "snooze_tick", deferredAt: "2026-07-01T00:00:00.000Z" },
    });
    const apply = new FakeApplyTransitionPort({ store });
    const outcome = await runApprovalFlow(input, makeDeps({ applyTransition: apply, surface, clock }));

    expect(outcome.state).toBe("pending");
    expect(outcome.approval?.status).toBe("pending");
    expect(store.applyCount).toBe(1); // deferred → pending
    expect(surface.surfaced).toHaveLength(1); // card shown again
  });

  it("auto-expires after the expiry window (deferred → expired), NO re-surface", async () => {
    const store = new FakeApprovalStore();
    const deferred = makeApproval({ status: "deferred" });
    store.seed(deferred);
    const surface = new FakeSurfaceCardPort();
    const health = new FakeApprovalHealthSink();
    // 8 days after deferral: past the 7d expiry.
    const clock = new FakeClock({ now: "2026-07-09T00:00:00.000Z" });
    const input = makeInput({
      context: makeApprovalContext({ workspaceId: WS, approval: deferred }),
      action: { kind: "snooze_tick", deferredAt: "2026-07-01T00:00:00.000Z" },
    });
    const apply = new FakeApplyTransitionPort({ store });
    const outcome = await runApprovalFlow(input, makeDeps({ applyTransition: apply, surface, health, clock }));

    expect(outcome.state).toBe("expired");
    expect(store.applyCount).toBe(1); // deferred → expired
    expect(surface.surfaced).toHaveLength(0); // never re-surfaced into a stale card
    expect(health.surfaced).toHaveLength(1); // auto-expiry surfaced (nothing silent)
  });
});

// --- an EXPIRED approval can NEVER later be approved ------------------------

describe("runApprovalFlow — expired can never be approved", () => {
  it("an approve on an already-expired approval fails closed → expired state, NO dispatch", async () => {
    const store = new FakeApprovalStore();
    // The record port hands back a record that is ALREADY expired.
    const expired = makeApproval({ status: "expired" });
    store.seed(expired);
    const record = new FakeRecordPendingPort({ approval: expired });
    const dispatch = new FakeDispatchApprovedPort();
    const health = new FakeApprovalHealthSink();
    const input = makeInput({
      action: { kind: "decide", decision: { decision: "approved", channel: "mac", actor: "user:alice" } },
    });
    const outcome = await runApprovalFlow(
      input,
      makeDeps({ record, applyTransition: new FakeApplyTransitionPort({ store }), dispatch, health }),
    );

    expect(outcome.state).toBe("expired");
    expect(dispatch.createCount).toBe(0); // never dispatches (inv-D/inv-E)
    expect(store.applyCount).toBe(0); // no illegal expired → approved transition
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- approved → replay reuses the receipt (no duplicate external write) -----

describe("runApprovalFlow — replay safety (inv-E)", () => {
  it("re-drives the approved flow from the start with NO duplicate external write", async () => {
    const store = new FakeApprovalStore();
    const dispatch = new FakeDispatchApprovedPort();
    const runs = new InMemoryWorkflowRunRepo();

    const first = await runApprovalFlow(
      makeInput(),
      makeDeps({ applyTransition: new FakeApplyTransitionPort({ store }), dispatch, runs }),
    );
    expect(first.state).toBe("approved");
    expect(dispatch.createCount).toBe(1);

    // Restart: re-drive the WHOLE flow with the SAME durable store/dispatch/runs.
    const second = await runApprovalFlow(
      makeInput(),
      makeDeps({ applyTransition: new FakeApplyTransitionPort({ store }), dispatch, runs }),
    );

    expect(second.state).toBe("approved");
    expect(dispatch.createCount).toBe(1); // receipt REUSED — zero duplicate write
    expect(second.runReused).toBe(true);
  });
});

// --- typed failure states → 7.5 health (inv-F / inv-5) ----------------------

describe("runApprovalFlow — typed failures surface health items", () => {
  it("a card PARITY break → pending, surfaces a health item (no single-channel card)", async () => {
    const dispatch = new FakeDispatchApprovedPort();
    const health = new FakeApprovalHealthSink();
    const surface = new FakeSurfaceCardPort({ failWith: "parity_failed" });
    const outcome = await runApprovalFlow(makeInput(), makeDeps({ surface, dispatch, health }));

    expect(outcome.state).toBe("pending");
    expect(dispatch.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("a precondition failure on record → pending, surfaces a health item", async () => {
    const health = new FakeApprovalHealthSink();
    const record = new FakeRecordPendingPort({ failWith: "precondition_failed" });
    const outcome = await runApprovalFlow(makeInput(), makeDeps({ record, health }));

    expect(outcome.state).toBe("pending");
    expect(health.surfaced).toHaveLength(1);
  });

  it("a conflicting approval on apply → surfaces a health item, NO dispatch", async () => {
    const dispatch = new FakeDispatchApprovedPort();
    const health = new FakeApprovalHealthSink();
    const apply = new FakeApplyTransitionPort({ failWith: "conflicting_approval" });
    const outcome = await runApprovalFlow(makeInput(), makeDeps({ applyTransition: apply, dispatch, health }));

    expect(outcome.state).toBe("pending");
    expect(dispatch.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("a HELD external dispatch on an approved action → surfaces a health item (retryable)", async () => {
    const health = new FakeApprovalHealthSink();
    const dispatch = new FakeDispatchApprovedPort({ failWith: "held" });
    const outcome = await runApprovalFlow(makeInput(), makeDeps({ dispatch, health }));

    // The approval STANDS as approved (the human decision landed + is audited);
    // the external write failed downstream → a distinct health item (inv-5).
    expect(outcome.state).toBe("approved");
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- the PURE snooze timer (clock-injected, LIFE-5-safe) --------------------

describe("snoozeTimer — deferred lifecycle (pure, clock-injected)", () => {
  const deferredAt = "2026-07-01T00:00:00.000Z";

  it("derives the default 24h/7d windows from the domain when the record has none", () => {
    const w = resolveDeferredWindows({}, deferredAt);
    expect(w.snoozeUntilMs).toBe(Date.parse(deferredAt) + APPROVAL_DEFAULTS.snoozeMs);
    expect(w.expiresAtMs).toBe(Date.parse(deferredAt) + APPROVAL_DEFAULTS.expiryMs);
  });

  it("sleeps within the snooze window", () => {
    const clock = new FakeClock({ now: "2026-07-01T12:00:00.000Z" }); // 12h < 24h
    expect(evaluateDeferred({}, deferredAt, clock)).toBe("sleep");
  });

  it("re-surfaces once the snooze window elapses (before expiry)", () => {
    const clock = new FakeClock({ now: "2026-07-02T01:00:00.000Z" }); // 25h
    expect(evaluateDeferred({}, deferredAt, clock)).toBe("resurface");
  });

  it("expires once the expiry window elapses — expiry WINS over re-surface", () => {
    const clock = new FakeClock({ now: "2026-07-09T00:00:00.000Z" }); // 8d > 7d
    expect(evaluateDeferred({}, deferredAt, clock)).toBe("expire");
    expect(isExpired({}, deferredAt, clock)).toBe(true);
  });

  it("honors an explicit snoozeUntil/expiresAt on the record over the defaults", () => {
    const clock = new FakeClock({ now: "2026-07-01T02:00:00.000Z" });
    const decision = evaluateDeferred(
      { snoozeUntil: "2026-07-01T01:00:00.000Z", expiresAt: "2026-07-10T00:00:00.000Z" },
      deferredAt,
      clock,
    );
    // now (02:00) is past the explicit 01:00 snooze but before the 10th expiry.
    expect(decision).toBe("resurface");
    // sanity: the default config is the domain's.
    expect(DEFAULT_SNOOZE_CONFIG.snoozeMs).toBe(APPROVAL_DEFAULTS.snoozeMs);
  });
});

// --- spec(§9) Approval contract drift guard (schema snapshot) --------------

describe("spec(§9) Approval contract drift guard", () => {
  it("pins the FROZEN Approval top-level field-name set (incl. snoozeUntil/expiresAt)", () => {
    const schema = emitJsonSchema(ApprovalSchema, APPROVAL_SCHEMA_ID);
    expect(fieldSet(schema)).toEqual([
      "actionRef",
      "actor",
      "channel",
      "expiresAt",
      "id",
      "payloadHash",
      // §13.10a — the semantic-subject fields: planRef (the pending-KMP ref) + subjectKind
      // (the external_action|semantic_mutation discriminator). actionRef is now optional.
      "planRef",
      "snoozeUntil",
      "status",
      "subjectKind",
      "workspaceId",
    ]);
  });

  it("pins the §9 Approval status enum (incl. deferred + expired)", () => {
    expect([...ApprovalStatus]).toEqual([
      "pending",
      "approved",
      "edited",
      "rejected",
      "deferred",
      "expired",
    ]);
  });

  it("keeps the domain APPROVAL_STATES in lockstep with the contract status enum", () => {
    expect([...APPROVAL_STATES]).toEqual([...ApprovalStatus]);
  });
});
