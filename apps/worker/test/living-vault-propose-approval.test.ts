// spec(§6 KN-10 / §9.8 Approvals; ⚠SAFETY; 13.8i) — createProposeKnowledgeApprovalPort: the thin
// composition-root adapter that lets `runSourceIngestion` (Temporal workflow-sandbox code, cannot import
// @sow/db/worker adapters) route a withheld PROPOSE-tier living-vault plan into a PENDING §9.8 Approval
// by REUSING the EXISTING `CopilotKnowledgeProposeSink` (apps/worker/src/api/procedures/
// copilotProposeKnowledgeSink.ts) — never a second minting site (contracts L39/L61).
//
// This test does NOT re-verify the sink's own security contracts (workspace provenance, payload-swap
// TOCTOU, redaction) — those are pinned exhaustively in copilotProposeKnowledgeSink.test.ts. It verifies
// ONLY this adapter's own mapping contract: delegates verbatim, folds a sink error/throw to the closed
// `mint_failed` port error (never leaking the raw FailureVariant detail), and — the highest-value case —
// that the sink's OWN idempotency-by-planId survives unmangled through the adapter (a re-drive mints no
// duplicate Approval).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err, isOk } from "@sow/contracts";
import type { Approval, FailureVariant, KnowledgeMutationPlan, Workspace, WorkspaceId, Result } from "@sow/contracts";
import type { DbError, DbResult, PendingKnowledgeMutation, PendingKnowledgeMutationRepository, WorkspaceConfigRepository, ApprovalRepository } from "@sow/db";
import { createProposeKnowledgeApprovalPort, createProposeKnowledgeApprovalActivity } from "../src/composition/living-vault";
import { createApprovalsKnowledgeProposeSink } from "../src/api/procedures/copilotProposeKnowledgeSink";
import type { CopilotKnowledgeProposeSink } from "../src/api/procedures/copilotProposeKnowledgeSink";
import type { ScheduleStore, Clock } from "@sow/workflows/ports/operational";
import type {
  CommitKnowledgePort,
  KnowledgeCommitSuccess,
  KnowledgeCommitFailure,
  ProposeKnowledgeApprovalPort,
  ProposeKnowledgeApprovalResult,
  ProposeKnowledgeApprovalError,
} from "@sow/workflows";
import type { SynthesisOutcome, SynthesisError } from "@sow/knowledge";
import { createLivingVaultSynthesisActivity } from "../src/composition/living-vault-synthesis";

// 13.8e/26.2 — createLivingVaultSynthesisActivity's own planSynthesis CALL is mocked at the
// @sow/knowledge module boundary exactly like meeting-vault.test.ts mocks rewriteVaultForMeeting:
// this file pins ONLY the activity's OWN contract (LIFE-2 tick sequence + AUTO-vs-PROPOSE routing),
// never re-verifying planSynthesis's own tiering logic (pinned exhaustively in
// packages/knowledge/test/planner.test.ts).
const planSynthesisMock = vi.fn<(...args: unknown[]) => Promise<Result<SynthesisOutcome, SynthesisError>>>();
vi.mock("@sow/knowledge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sow/knowledge")>();
  return { ...actual, planSynthesis: (...args: unknown[]) => planSynthesisMock(...args) };
});

const WS = "ws-employer" as WorkspaceId;
const NOW = "2026-07-31T00:00:00.000Z";

function plan(over: Partial<KnowledgeMutationPlan> = {}): KnowledgeMutationPlan {
  return {
    planId: "plan-lv-propose-1",
    workspaceId: WS,
    sourceRefs: [{ sourceId: "src-1" }],
    creates: [],
    patches: [],
    linkMutations: [],
    frontmatterUpdates: [],
    externalActionProposals: [],
    confidence: 0.9,
    requiresApproval: true,
    provenanceOrigin: "ingestion",
    ...over,
  } as unknown as KnowledgeMutationPlan;
}

describe("createProposeKnowledgeApprovalPort — 13.8i adapter contract (a thin wrapper over the EXISTING sink)", () => {
  it("delegates to sink.record({plan, workspaceId}) and forwards a successful mint verbatim", async () => {
    let calls = 0;
    const fakeSink: CopilotKnowledgeProposeSink = {
      record: async (input) => {
        calls += 1;
        expect(input.plan).toBe(plan_);
        expect(input.workspaceId).toBe(WS);
        return ok({ approvalRef: "apr_1", planRef: "plan-lv-propose-1", created: true });
      },
    };
    const plan_ = plan();
    const port = createProposeKnowledgeApprovalPort(fakeSink);
    const res = await port.propose(plan_, WS);

    expect(calls).toBe(1);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual({ approvalRef: "apr_1", created: true });
  });

  it("folds a sink FailureVariant err to the closed mint_failed code — never leaks the raw detail", async () => {
    const rawFailure: FailureVariant = {
      kind: "write_conflict",
      message: "raw internal store detail that must never cross",
      cause: { code: "COPILOT_PROPOSE_KNOWLEDGE_PLAN_CONFLICT" },
    } as unknown as FailureVariant;
    const fakeSink: CopilotKnowledgeProposeSink = {
      record: async () => err(rawFailure),
    };
    const port = createProposeKnowledgeApprovalPort(fakeSink);
    const res = await port.propose(plan(), WS);

    expect(isOk(res)).toBe(false);
    if (!isOk(res)) {
      expect(res.error.code).toBe("mint_failed");
      expect(res.error.message).not.toContain("raw internal store detail");
    }
  });

  it("folds a THROWING sink to the closed mint_failed code — never throws (§16)", async () => {
    const fakeSink: CopilotKnowledgeProposeSink = {
      record: async () => {
        throw new Error("boom — raw driver detail must never cross");
      },
    };
    const port = createProposeKnowledgeApprovalPort(fakeSink);
    const res = await port.propose(plan(), WS);

    expect(isOk(res)).toBe(false);
    if (!isOk(res)) {
      expect(res.error.code).toBe("mint_failed");
      expect(res.error.message).not.toContain("boom");
    }
  });

  it("a re-drive mints NO duplicate Approval — the REAL sink's idempotency survives unmangled through the adapter", async () => {
    // Drives the REAL createApprovalsKnowledgeProposeSink (not a fake) over fake DB repos — proving the
    // adapter introduces no extra state that could break the sink's own planId-keyed idempotency.
    const approvalsStore = new Map<string, Approval>();
    const approvals: ApprovalRepository = {
      create: (a: Approval): DbResult<Approval> => {
        if (approvalsStore.has(String(a.id))) return Promise.resolve(err({ code: "conflict", message: "PK" } satisfies DbError));
        approvalsStore.set(String(a.id), a);
        return Promise.resolve(ok(a));
      },
      get: (id: Approval["id"]): DbResult<Approval> => {
        const found = approvalsStore.get(String(id));
        return Promise.resolve(found ? ok(found) : err({ code: "not_found", message: "no row" } satisfies DbError));
      },
      listByStatus: (): DbResult<Approval[]> => Promise.resolve(ok([])),
      listByStatusAndWorkspace: (): DbResult<Approval[]> => Promise.resolve(ok([])),
      applyTransition: () => {
        throw new Error("must never be called here");
      },
    };
    const pendingStore = new Map<string, PendingKnowledgeMutation>();
    const pendingKmp: PendingKnowledgeMutationRepository = {
      record: (e: PendingKnowledgeMutation): DbResult<PendingKnowledgeMutation> => {
        if (pendingStore.has(e.planId)) return Promise.resolve(err({ code: "conflict", message: "PK" } satisfies DbError));
        pendingStore.set(e.planId, e);
        return Promise.resolve(ok(e));
      },
      get: (planIdStr: string): DbResult<PendingKnowledgeMutation> => {
        const found = pendingStore.get(planIdStr);
        return Promise.resolve(found ? ok(found) : err({ code: "not_found", message: "no row" } satisfies DbError));
      },
      update: (e: PendingKnowledgeMutation): DbResult<PendingKnowledgeMutation> => {
        pendingStore.set(e.planId, e);
        return Promise.resolve(ok(e));
      },
    };
    const workspaceConfig: WorkspaceConfigRepository = {
      get: (id: Workspace["id"]): DbResult<Workspace> => Promise.resolve(ok({ id } as unknown as Workspace)),
    } as WorkspaceConfigRepository;

    const sink = createApprovalsKnowledgeProposeSink({ approvals, pendingKmp, workspaceConfig, now: () => NOW });
    const port = createProposeKnowledgeApprovalPort(sink);

    const same = plan();
    const first = await port.propose(same, WS);
    const second = await port.propose(same, WS); // the re-drive: SAME plan, SAME planId

    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (isOk(first) && isOk(second)) {
      expect(first.value.created).toBe(true);
      expect(second.value.created).toBe(false); // idempotent no-op, not a second Approval
      expect(second.value.approvalRef).toBe(first.value.approvalRef); // the SAME card
    }
    expect(approvalsStore.size).toBe(1); // exactly one Approval row exists, never two
  });
});

// spec(§6 KN-10 / §9.8 Approvals; ⚠SAFETY; 13.8i-B) — createProposeKnowledgeApprovalActivity: the
// ARMING gate as an activity delegate, mirroring createLivingVaultActivity's SHAPE (a pure factory over
// `port | undefined`, dormancy INSIDE the activity, per contracts L59) but NOT its `ok([])` identity
// return — propose has no natural "nothing happened" success, so the unarmed branch is a typed
// `not_armed` err, never ok(...) (a false proof a plan was queued) and never a throw (§16).
describe("createProposeKnowledgeApprovalActivity — 13.8i-B dormancy-in-the-activity (L59 shape, corrected return)", () => {
  it("unarmed (port undefined) returns a typed not_armed err — never ok, never throws", async () => {
    const activity = createProposeKnowledgeApprovalActivity(undefined);
    const res = await activity(plan(), WS);

    expect(isOk(res)).toBe(false);
    if (!isOk(res)) {
      expect(res.error.code).toBe("not_armed");
    }
  });

  it("armed (port defined) delegates verbatim — no double-wrapping, no re-interpretation", async () => {
    let calls = 0;
    const fakePort = {
      propose: async (p: KnowledgeMutationPlan, ws: WorkspaceId) => {
        calls += 1;
        expect(p).toBe(plan_);
        expect(ws).toBe(WS);
        return ok({ approvalRef: "apr_armed", created: true });
      },
    };
    const plan_ = plan();
    const activity = createProposeKnowledgeApprovalActivity(fakePort);
    const res = await activity(plan_, WS);

    expect(calls).toBe(1);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual({ approvalRef: "apr_armed", created: true });
  });

  it("armed + a genuine mint rejection still surfaces mint_failed, NOT not_armed — the codes are distinct", async () => {
    const fakePort = {
      propose: async () => err({ code: "mint_failed" as const, message: "fake sink rejection" }),
    };
    const activity = createProposeKnowledgeApprovalActivity(fakePort);
    const res = await activity(plan(), WS);

    expect(isOk(res)).toBe(false);
    if (!isOk(res)) expect(res.error.code).toBe("mint_failed");
  });
});

// ── 13.8e / 26.2 — createLivingVaultSynthesisActivity ───────────────────────────────────────────
// VERIFIED (positive control): dispatchMeetingCloseout returns hits at
// apps/worker/src/temporal/dispatchMeetingCloseout.ts:57; livingVaultSynthesis/LivingVaultSynthesis
// return ZERO hits repo-wide before this slice — there was nothing to "register", only something
// to BUILD. LIFE-2 catch-up runs over the REAL @sow/workflows collapsedNextRunFromClock +
// advanceBookkeeping functions (never a hand-rolled stand-in) against an in-memory ScheduleStore
// whose collapse DECISION is genuinely computed, not hardcoded — "the injected schedule port, do
// not stub it."
describe("createLivingVaultSynthesisActivity (13.8e/26.2) — dormant, hand-built, arms via §19.13", () => {
  const SCHED = "living-vault-synthesis";
  const HOUR = 3_600_000;

  interface FakeClock extends Clock {
    wallMs: number;
  }
  function fakeClock(startWallIso: string): FakeClock {
    const c: FakeClock = {
      wallMs: Date.parse(startWallIso),
      now: () => new Date(c.wallMs).toISOString(),
      monotonicMs: () => c.wallMs,
      monotonicEpoch: () => "boot-1",
    };
    return c;
  }

  /** A genuine in-memory ScheduleStore — its OWN behavior is trivial (a Map get/put), but the
   *  CATCH-UP DECISION the activity computes from it runs through the real
   *  collapsedNextRunFromClock/advanceBookkeeping functions, never re-implemented here. */
  function memScheduleStore(): ScheduleStore {
    const rows = new Map<string, Awaited<ReturnType<ScheduleStore["getBookkeeping"]>>>();
    return {
      getBookkeeping: async (id) => rows.get(id),
      put: async (bk) => {
        rows.set(bk.scheduleId, bk);
      },
    };
  }

  function autoPlan(over: Partial<KnowledgeMutationPlan> = {}): KnowledgeMutationPlan {
    return plan({ requiresApproval: false, provenanceOrigin: "gbrain_proposal", ...over, planId: "auto-1" } as unknown as Partial<KnowledgeMutationPlan>);
  }
  function proposePlan(over: Partial<KnowledgeMutationPlan> = {}): KnowledgeMutationPlan {
    return plan({ requiresApproval: true, provenanceOrigin: "gbrain_proposal", ...over, planId: "propose-1" } as unknown as Partial<KnowledgeMutationPlan>);
  }

  function fixtureOutcome(plans: readonly KnowledgeMutationPlan[]): SynthesisOutcome {
    return {
      plans,
      entityRefsTruncated: 0,
      entityRefsRejected: 0,
      entityRefsWithheldByReason: {},
    };
  }

  function stubKnowledgeDeps() {
    return {
      gbrain: { workspaceId: WS, findCandidates: () => Promise.resolve(ok([])) } as unknown as Parameters<
        typeof createLivingVaultSynthesisActivity
      >[0]["gbrain"],
      reason: { reason: () => Promise.reject(new Error("not exercised — planSynthesis is mocked")) } as unknown as Parameters<
        typeof createLivingVaultSynthesisActivity
      >[0]["reason"],
      sections: { describe: () => ({ generatedRegionIds: [] }) },
      newPlanId: () => "minted-plan-id",
    };
  }

  function fixtureDeps(over: Partial<Parameters<typeof createLivingVaultSynthesisActivity>[0]> = {}) {
    const commit = vi.fn(
      (): Promise<Result<KnowledgeCommitSuccess, KnowledgeCommitFailure>> =>
        Promise.resolve(ok({ revisionId: "rev-1", replayed: false })),
    );
    const propose = {
      propose: vi.fn(
        (): Promise<Result<ProposeKnowledgeApprovalResult, ProposeKnowledgeApprovalError>> =>
          Promise.resolve(ok({ approvalRef: "apr-1", created: true })),
      ),
    } satisfies ProposeKnowledgeApprovalPort;
    return {
      workspaceId: WS,
      scheduleId: SCHED,
      intervalMs: HOUR,
      catchUpWindowMs: 24 * HOUR,
      schedule: memScheduleStore(),
      clock: fakeClock("2026-08-24T00:00:00.000Z"),
      commit: { commit } as unknown as CommitKnowledgePort,
      propose,
      ...stubKnowledgeDeps(),
      ...over,
    };
  }

  beforeEach(() => {
    planSynthesisMock.mockReset();
  });

  it("first_run_no_bookkeeping_runs_immediately_no_catch_up_needed", async () => {
    planSynthesisMock.mockResolvedValueOnce(ok(fixtureOutcome([])));
    const deps = fixtureDeps();
    const activity = createLivingVaultSynthesisActivity(deps);

    const outcome = await activity();

    expect(outcome.kind).toBe("ran");
    expect(planSynthesisMock).toHaveBeenCalledTimes(1);
  });

  it("no_run_due_when_the_interval_has_not_elapsed — no planSynthesis call, no durable write", async () => {
    planSynthesisMock.mockResolvedValueOnce(ok(fixtureOutcome([])));
    const deps = fixtureDeps();
    const activity = createLivingVaultSynthesisActivity(deps);
    await activity(); // first run seeds bookkeeping at wallMs=T0

    // Advance by less than one interval.
    (deps.clock as unknown as { wallMs: number }).wallMs += HOUR / 2;
    const outcome = await activity();

    expect(outcome).toEqual({ kind: "no_run_due" });
    expect(planSynthesisMock).toHaveBeenCalledTimes(1); // still just the first run
  });

  it("LIFE-2_five_missed_hourly_occurrences_collapse_to_exactly_one_run", async () => {
    planSynthesisMock.mockResolvedValue(ok(fixtureOutcome([])));
    const deps = fixtureDeps();
    const activity = createLivingVaultSynthesisActivity(deps);
    const first = await activity(); // seeds bookkeeping
    expect(first.kind).toBe("ran");

    // Simulate 5 missed hourly occurrences by jumping the clock forward 5 hours in ONE leap,
    // then a SINGLE tick — the real collapsedNextRunFromClock collapses this to one run.
    (deps.clock as unknown as { wallMs: number }).wallMs += 5 * HOUR;
    const collapsedRun = await activity();

    expect(collapsedRun.kind).toBe("ran");
    if (collapsedRun.kind === "ran") expect(collapsedRun.collapsed).toBe(true);
    // Exactly TWO planSynthesis calls total (the seed run + the ONE collapsed run) — never five.
    expect(planSynthesisMock).toHaveBeenCalledTimes(2);

    // A THIRD tick immediately after (no further elapsed time) finds nothing due.
    const thirdTick = await activity();
    expect(thirdTick).toEqual({ kind: "no_run_due" });
    expect(planSynthesisMock).toHaveBeenCalledTimes(2);
  });

  it("armed_run_AUTO_applies_additive_and_PROPOSES_human_relevant — never auto-commits the propose tier", async () => {
    const auto = autoPlan();
    const propose = proposePlan();
    planSynthesisMock.mockResolvedValueOnce(ok(fixtureOutcome([auto, propose])));
    const deps = fixtureDeps();
    const activity = createLivingVaultSynthesisActivity(deps);

    const outcome = await activity();

    expect(outcome.kind).toBe("ran");
    if (outcome.kind === "ran") {
      expect(outcome.autoApplied).toBe(1);
      expect(outcome.proposed).toBe(1);
    }
    // AUTO tier → commit, called EXACTLY with the auto plan.
    expect(deps.commit.commit).toHaveBeenCalledTimes(1);
    expect(deps.commit.commit).toHaveBeenCalledWith(auto);
    // PROPOSE tier → propose, called EXACTLY with the propose plan — NEVER auto-committed.
    expect(deps.propose.propose).toHaveBeenCalledTimes(1);
    expect(deps.propose.propose).toHaveBeenCalledWith(propose, WS);
    // Cross-check: the propose plan NEVER reaches commit, and the auto plan NEVER reaches propose.
    expect(deps.commit.commit).not.toHaveBeenCalledWith(propose);
    expect(deps.propose.propose).not.toHaveBeenCalledWith(auto, WS);
  });

  it("planSynthesis_rejection_is_a_typed_failure_never_thrown_bookkeeping_not_advanced", async () => {
    planSynthesisMock.mockResolvedValueOnce(err({ code: "unusable_input" }));
    const deps = fixtureDeps();
    const activity = createLivingVaultSynthesisActivity(deps);

    const outcome = await activity();

    expect(outcome.kind).toBe("synthesis_failed");
    expect(deps.commit.commit).not.toHaveBeenCalled();
    expect(deps.propose.propose).not.toHaveBeenCalled();

    // Bookkeeping was NOT advanced on failure — a retry within the SAME window still finds work due
    // (the real collapse math, not a hand-rolled assertion): the very next tick (no elapsed time) still
    // runs, because no bookkeeping row exists yet (both attempts are effectively "first run").
    planSynthesisMock.mockResolvedValueOnce(ok(fixtureOutcome([])));
    const retried = await activity();
    expect(retried.kind).toBe("ran");
  });

  it("a_throwing_planSynthesis_call_is_caught_never_propagates — total, never throws (§16)", async () => {
    planSynthesisMock.mockRejectedValueOnce(new Error("synthesis exploded"));
    const deps = fixtureDeps();
    const activity = createLivingVaultSynthesisActivity(deps);

    const outcome = await activity();

    expect(outcome.kind).toBe("synthesis_failed");
  });
});
