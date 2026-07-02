// spec(§9) — task 7.18 HERMES AUTONOMOUS AUTOMATION — Gateway-Routing.
//
// REQ-F-014 / RT-7: Hermes cron/Kanban MAY initiate user-defined automations,
// but EVERY external side effect is FORCED through the Tool Gateway envelope +
// EVERY semantic write through KnowledgeWriter — there is NO Hermes-direct
// Markdown or GBrain write path. Hermes is NOT the product-workflow source of
// truth (Temporal is): a Hermes-initiated automation is recorded as a WorkflowRun
// with trigger=hermes_automation carrying an idempotencyKey (via resolveRun); a
// REPLAYED automation produces NO duplicate external action (envelope/canonical-
// key reuse) + NO direct Markdown/GBrain write — the one-writer + duplicate-write
// invariants are enforced by the GATEWAYS, not by trusting Hermes.
//
// These tests drive `runHermesAutomation` (the pure driver) over Hermes-automation
// activity-port FAKES + the foundation FakeClock + InMemoryWorkflowRunRepo. The
// driver imports NEITHER @temporalio NOR node:crypto and calls NO
// Date.now()/Math.random(), so it runs entirely in-memory (root CLAUDE.md ★).
//
// The suite pins the 7.18 safety invariants:
//  • happy path drives triggered → … → completed (no illegal machine edge), with
//    the semantic write through the KnowledgeWriter commit port + the external
//    write through the Tool Gateway propose port — never a direct adapter.
//  • the run is recorded with trigger=hermes_automation (resolveRun / WorkflowRun).
//  • a REPLAY re-drives the whole pipeline: the commit + external write are REUSED
//    (each happens exactly once), no duplicate external action, run is reused.
//  • routing failure → routing_failed; agent rejection → provider_failed; validator
//    rejection → schema_rejected (NO commit, NO external write); commit conflict →
//    write_conflict; approval-required action → approval_pending; held → outbox_retry.
//  • EVERY failure branch surfaces a distinct 7.5 health item (nothing silent).
//  • REGRESSION (the bug-class prior verify passes caught): the committed plan's
//    workspaceId is the ROUTE-BOUND workspace (not a caller value), and an inferred
//    field is rejected at validate so buildOutputs + commit NEVER run.
import { describe, it, expect } from "vitest";
import { isOk, ok } from "@sow/contracts";
import { workflowId } from "@sow/contracts";
import type {
  WorkspaceId,
  KnowledgeMutationPlan,
  Result,
} from "@sow/contracts";
import { runHermesAutomation } from "../src/workflows/hermesAutomation";
import { createHermesRouteActivity } from "../src/activities/hermesRoute";
import type { HermesRouteSignals } from "../src/activities/hermesRoute";
import type { HermesRouteError } from "../src/workflows/hermesAutomation";
import type {
  HermesAutomationInput,
  HermesAutomationDeps,
  CommitKnowledgePort,
  KnowledgeCommitSuccess,
  KnowledgeCommitFailure,
  HermesAgentFailureCode,
  KnowledgeCommitFailureCode,
  ProposeErrorCode,
  BuildOutputsFailureCode,
  HermesRouteErrorCode,
} from "../src/workflows/hermesAutomation";
import {
  FakeHermesRoutePort,
  FakeHermesAgentJobPort,
  makeHermesContext,
  makeHermesExtraction,
} from "./support/hermes-fakes";
import {
  FakeValidatePort,
  FakeBuildOutputsPort,
  FakeCommitPort,
  FakeProposePort,
  FakeReindexPort,
  FakeMeetingHealthSink,
} from "./support/meeting-fakes";
import { FakeClock, InMemoryWorkflowRunRepo } from "./support/fakes";

const WS = "ws-personal-business" as WorkspaceId;

/**
 * A happy-path input. The semantic outputs (plan + actions) are NOT caller-
 * supplied — they are DERIVED inside the pipeline by the BuildOutputsPort — so the
 * input is just the run submission (trigger MUST be hermes_automation) + the
 * pre-route context (the automation trigger descriptor).
 */
function makeInput(partial: Partial<HermesAutomationInput> = {}): HermesAutomationInput {
  return {
    run: {
      workflowId: workflowId("wf-hermes-1"),
      trigger: "hermes_automation",
      idempotencyKey: "idem-run-hermes-1",
      workspaceId: WS,
    },
    context: makeHermesContext(),
    ...partial,
  };
}

/** Build a fresh, all-green dep set of fakes; override a port per test. */
function makeDeps(overrides: Partial<HermesAutomationDeps> = {}): HermesAutomationDeps {
  return {
    route: new FakeHermesRoutePort({ confidence: "high", workspaceId: WS }),
    agent: new FakeHermesAgentJobPort({ result: "accepted" }),
    validate: new FakeValidatePort(),
    buildOutputs: new FakeBuildOutputsPort(),
    commit: new FakeCommitPort(),
    propose: new FakeProposePort(),
    reindex: new FakeReindexPort(),
    health: new FakeMeetingHealthSink(),
    runs: new InMemoryWorkflowRunRepo(),
    clock: new FakeClock(),
    ...overrides,
  };
}

type KnowledgeMutationPlanCapture = KnowledgeMutationPlan;

/** A commit port that RECORDS the plan the driver hands it (for the regression tests). */
class CapturingCommitPort implements CommitKnowledgePort {
  constructor(private readonly captured: KnowledgeMutationPlanCapture[]) {}
  private n = 0;
  commit(
    plan: KnowledgeMutationPlan,
  ): Promise<Result<KnowledgeCommitSuccess, KnowledgeCommitFailure>> {
    this.captured.push(plan);
    this.n += 1;
    return Promise.resolve(ok({ revisionId: `rev-cap-${this.n}`, replayed: false }));
  }
}

// --- happy path ------------------------------------------------------------

describe("runHermesAutomation — happy path", () => {
  it("drives triggered → completed; semantic write via KnowledgeWriter, external write via Tool Gateway", async () => {
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const reindex = new FakeReindexPort();
    const deps = makeDeps({ commit, propose, reindex });

    const outcome = await runHermesAutomation(makeInput(), deps);

    expect(outcome.state).toBe("completed");
    // The semantic write went through the KnowledgeWriter commit port (never a
    // direct Markdown/GBrain adapter) — exactly one commit.
    expect(commit.writeCount).toBe(1);
    // The external write went through the Tool Gateway propose port (never a
    // direct adapter) — exactly one create.
    expect(propose.createCount).toBe(1);
    // GBrain re-index runs AFTER the Markdown commit (no direct GBrain write).
    expect(outcome.context.revisionId).toBeDefined();
    expect(reindex.reindexed).toContain(outcome.context.revisionId);
    // Workspace bound (route high-confidence) before any durable write (WS-2).
    expect(outcome.context.workspaceId).toBe(WS);
  });

  it("records the run as a WorkflowRun with trigger=hermes_automation", async () => {
    const runs = new InMemoryWorkflowRunRepo();
    const deps = makeDeps({ runs });

    const outcome = await runHermesAutomation(makeInput(), deps);

    expect(isOk(outcome.run)).toBe(true);
    if (isOk(outcome.run)) {
      expect(outcome.run.value.trigger).toBe("hermes_automation");
    }
    // The run is persisted under its idempotencyKey (Temporal is the source of
    // truth — Hermes only initiated it).
    const persisted = await runs.getByIdempotencyKey("idem-run-hermes-1");
    expect(isOk(persisted)).toBe(true);
    if (isOk(persisted)) {
      expect(persisted.value.trigger).toBe("hermes_automation");
    }
  });

  it("resolves the run idempotently (reused on a seen key)", async () => {
    const runs = new InMemoryWorkflowRunRepo();
    const first = await runHermesAutomation(makeInput(), makeDeps({ runs }));
    expect(isOk(first.run)).toBe(true);

    const second = await runHermesAutomation(makeInput(), makeDeps({ runs }));
    expect(second.runReused).toBe(true);
  });
});

// --- routing failure → routing_failed --------------------------------------

describe("runHermesAutomation — routing failure", () => {
  it("routes to routing_failed with NO commit and NO guessed workspace", async () => {
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const health = new FakeMeetingHealthSink();
    const failWith: HermesRouteErrorCode = "route_failed";
    const deps = makeDeps({
      route: new FakeHermesRoutePort({ failWith }),
      commit,
      propose,
      health,
    });

    const outcome = await runHermesAutomation(makeInput(), deps);

    expect(outcome.state).toBe("routing_failed");
    expect(commit.writeCount).toBe(0);
    expect(propose.createCount).toBe(0);
    expect(outcome.context.workspaceId).toBeUndefined();
    expect(health.surfaced).toHaveLength(1);
  });

  it("routes a low-confidence automation to routing_failed with NO durable write", async () => {
    const commit = new FakeCommitPort();
    const health = new FakeMeetingHealthSink();
    const deps = makeDeps({
      route: new FakeHermesRoutePort({ confidence: "low", reason: "no target" }),
      commit,
      health,
    });

    const outcome = await runHermesAutomation(makeInput(), deps);

    expect(outcome.state).toBe("routing_failed");
    expect(commit.writeCount).toBe(0);
    expect(outcome.context.workspaceId).toBeUndefined();
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- agent rejection → provider_failed -------------------------------------

describe("runHermesAutomation — agent rejection", () => {
  it("folds an ING-7 admission rejection to provider_failed (mutating tool, never run)", async () => {
    const rejection: HermesAgentFailureCode = "admission_rejected";
    const commit = new FakeCommitPort();
    const health = new FakeMeetingHealthSink();
    const deps = makeDeps({
      agent: new FakeHermesAgentJobPort({ result: "rejected", rejection }),
      commit,
      health,
    });

    const outcome = await runHermesAutomation(makeInput(), deps);

    expect(outcome.state).toBe("provider_failed");
    expect(commit.writeCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- validator rejection → schema_rejected, NO PARTIAL COMMIT --------------

describe("runHermesAutomation — validator rejection", () => {
  it("hard-rejects an inferred field → schema_rejected, NO commit, NO external write", async () => {
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const health = new FakeMeetingHealthSink();
    // An inferred owner with NO evidenceRef — the REAL no-inference rule rejects it.
    const badExtraction = makeHermesExtraction({
      fields: { owner: { value: "Dana" }, dueDate: { value: "2026-09-01" } },
    });
    const deps = makeDeps({
      agent: new FakeHermesAgentJobPort({ result: "accepted", extraction: badExtraction }),
      commit,
      propose,
      health,
    });

    const outcome = await runHermesAutomation(makeInput(), deps);

    expect(outcome.state).toBe("schema_rejected");
    expect(commit.writeCount).toBe(0);
    expect(propose.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- KnowledgeWriter conflict → write_conflict -----------------------------

describe("runHermesAutomation — knowledge-commit conflict", () => {
  it("folds a compare-revision conflict to write_conflict, NO external write", async () => {
    const propose = new FakeProposePort();
    const health = new FakeMeetingHealthSink();
    const failWith: KnowledgeCommitFailureCode = "write_conflict";
    const deps = makeDeps({
      commit: new FakeCommitPort({ failWith }),
      propose,
      health,
    });

    const outcome = await runHermesAutomation(makeInput(), deps);

    expect(outcome.state).toBe("write_conflict");
    expect(propose.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- external action approval/hold -----------------------------------------

describe("runHermesAutomation — external action gating", () => {
  it("parks in approval_pending (fail-closed, no external write) when approval required", async () => {
    const commit = new FakeCommitPort();
    const failWith: ProposeErrorCode = "approval_pending";
    const propose = new FakeProposePort({ failWith });
    const health = new FakeMeetingHealthSink();
    const deps = makeDeps({ commit, propose, health });

    const outcome = await runHermesAutomation(makeInput(), deps);

    expect(outcome.state).toBe("approval_pending");
    // The Markdown commit stands (it precedes the external stage), but the external
    // write fails closed — no create.
    expect(commit.writeCount).toBe(1);
    expect(propose.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("holds to outbox_retry when the external action is held (non-terminal)", async () => {
    const failWith: ProposeErrorCode = "held";
    const propose = new FakeProposePort({ failWith });
    const health = new FakeMeetingHealthSink();
    const deps = makeDeps({ propose, health });

    const outcome = await runHermesAutomation(makeInput(), deps);

    expect(outcome.state).toBe("outbox_retry");
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- REPLAY-SAFETY: no duplicate external action, no direct write ----------

describe("runHermesAutomation — replay safety (LIFE-3 / RT-7)", () => {
  it("re-drives the whole pipeline with NO duplicate external action + NO duplicate commit", async () => {
    // Share the DURABLE fakes (commit/propose/runs) across both drives — as the
    // real KnowledgeWriter + Tool Gateway do — while the pure read stages get
    // fresh fakes on the re-drive.
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const runs = new InMemoryWorkflowRunRepo();

    const first = await runHermesAutomation(makeInput(), makeDeps({ commit, propose, runs }));
    expect(first.state).toBe("completed");
    expect(commit.writeCount).toBe(1);
    expect(propose.createCount).toBe(1);
    const firstRevision = first.context.revisionId;

    // Simulate a restart: re-drive the WHOLE pipeline from the start.
    const second = await runHermesAutomation(makeInput(), makeDeps({ commit, propose, runs }));

    expect(second.state).toBe("completed");
    // The durable writes are REUSED — each happened exactly once across both drives
    // (envelope/canonical-key reuse = zero duplicate external action, RT-7).
    expect(commit.writeCount).toBe(1);
    expect(propose.createCount).toBe(1);
    expect(second.context.revisionId).toBe(firstRevision);
    // The run was reused, not re-created.
    expect(second.runReused).toBe(true);
  });
});

// --- inv-5: nothing fails silently -----------------------------------------

describe("runHermesAutomation — nothing fails silently", () => {
  it("every failure branch routes through the health sink", async () => {
    // routing failure
    {
      const health = new FakeMeetingHealthSink();
      await runHermesAutomation(
        makeInput(),
        makeDeps({ route: new FakeHermesRoutePort({ failWith: "route_failed" }), health }),
      );
      expect(health.surfaced.length).toBeGreaterThanOrEqual(1);
    }
    // agent rejection
    {
      const health = new FakeMeetingHealthSink();
      await runHermesAutomation(
        makeInput(),
        makeDeps({
          agent: new FakeHermesAgentJobPort({ result: "rejected", rejection: "provider_failed" }),
          health,
        }),
      );
      expect(health.surfaced.length).toBeGreaterThanOrEqual(1);
    }
    // commit conflict
    {
      const health = new FakeMeetingHealthSink();
      await runHermesAutomation(
        makeInput(),
        makeDeps({ commit: new FakeCommitPort({ failWith: "write_conflict" }), health }),
      );
      expect(health.surfaced.length).toBeGreaterThanOrEqual(1);
    }
    // output-derivation failure — folds to schema_rejected, NO commit
    {
      const health = new FakeMeetingHealthSink();
      const commit = new FakeCommitPort();
      const outcome = await runHermesAutomation(
        makeInput(),
        makeDeps({
          buildOutputs: new FakeBuildOutputsPort({ failWith: "build_failed" }),
          commit,
          health,
        }),
      );
      expect(outcome.state).toBe("schema_rejected");
      expect(health.surfaced.length).toBeGreaterThanOrEqual(1);
      expect(commit.writeCount).toBe(0);
    }
  });
});

// --- REGRESSION: outputs DERIVED from validated data, never caller-supplied -
//
// These pin the bug-class prior verify passes caught (a guard that reads a field
// which is NOT what flows to the side effect):
//  • [HIGH] the committed plan's workspaceId is the ROUTE-BOUND workspace, not a
//    caller-controlled value — a caller cannot redirect the durable write.
//  • [CRITICAL] an inferred owner is rejected at validate, so buildOutputs + commit
//    NEVER run (the no-inference gate is not theater).

describe("runHermesAutomation — outputs derived from validated data (regression)", () => {
  it("[HIGH] the committed plan carries the ROUTE-BOUND workspace, not a caller value", async () => {
    const boundWs = "ws-route-bound" as WorkspaceId;
    const buildOutputs = new FakeBuildOutputsPort();
    const committedPlans: KnowledgeMutationPlanCapture[] = [];
    const commit = new CapturingCommitPort(committedPlans);
    const deps = makeDeps({
      route: new FakeHermesRoutePort({ confidence: "high", workspaceId: boundWs }),
      buildOutputs,
      commit,
    });

    const outcome = await runHermesAutomation(makeInput(), deps);

    expect(outcome.state).toBe("completed");
    // buildOutputs was handed the route-bound workspace (WS-2/WS-4), not a caller field.
    expect(buildOutputs.calls).toHaveLength(1);
    expect(buildOutputs.calls[0]?.workspaceId).toBe(boundWs);
    // The plan that actually reached commit carries the bound workspace.
    expect(committedPlans).toHaveLength(1);
    expect(committedPlans[0]?.workspaceId).toBe(boundWs);
  });

  it("[CRITICAL] an inferred owner is rejected at validate → schema_rejected; buildOutputs + commit NEVER run", async () => {
    const buildOutputs = new FakeBuildOutputsPort();
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const health = new FakeMeetingHealthSink();
    const inferred = makeHermesExtraction({
      fields: { owner: { value: "Dana" }, dueDate: { value: "2026-09-01" } },
    });
    const deps = makeDeps({
      agent: new FakeHermesAgentJobPort({ result: "accepted", extraction: inferred }),
      buildOutputs,
      commit,
      propose,
      health,
    });

    const outcome = await runHermesAutomation(makeInput(), deps);

    expect(outcome.state).toBe("schema_rejected");
    expect(buildOutputs.calls).toHaveLength(0);
    expect(commit.writeCount).toBe(0);
    expect(propose.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("[BUILD] a derivation failure folds to schema_rejected with no partial commit", async () => {
    const failing = new FakeCommitPort();
    const failWith: BuildOutputsFailureCode = "unmappable_extraction";
    const failedOutcome = await runHermesAutomation(
      makeInput(),
      makeDeps({
        buildOutputs: new FakeBuildOutputsPort({ failWith }),
        commit: failing,
      }),
    );
    expect(failedOutcome.state).toBe("schema_rejected");
    expect(failing.writeCount).toBe(0);
  });
});

// --- hermesRoute activity (inv-1: never guesses a workspace) ----------------

describe("spec(§9 inv-1) createHermesRouteActivity — never auto-routes below threshold", () => {
  function portFor(signals: HermesRouteSignals, threshold?: number) {
    return createHermesRouteActivity({
      resolve: () => Promise.resolve({ ok: true, value: signals }),
      ...(threshold !== undefined ? { threshold } : {}),
    });
  }

  it("high confidence + resolved workspace → high (WS-2 bind)", async () => {
    const port = portFor({ confidence: 0.9, workspaceId: WS, projectId: "proj-h" });
    const result = await port.route(makeHermesContext());
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.confidence).toBe("high");
      if (result.value.confidence === "high") {
        expect(result.value.workspaceId).toBe(WS);
        expect(result.value.projectId).toBe("proj-h");
      }
    }
  });

  it("sub-threshold confidence → low (fail-closed), NO workspace even if one was guessed", async () => {
    const port = portFor({ confidence: 0.4, workspaceId: WS, reason: "ambiguous" });
    const result = await port.route(makeHermesContext());
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.confidence).toBe("low");
      if (result.value.confidence === "low") {
        expect(result.value.routingReview).toBe(true);
        expect(result.value.reason).toBe("ambiguous");
      }
    }
  });

  it("at/above threshold but NO resolved workspace → low (never guesses a workspace)", async () => {
    const port = portFor({ confidence: 0.95 });
    const result = await port.route(makeHermesContext());
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.confidence).toBe("low");
  });

  it("a resolver failure surfaces as a typed HermesRouteError (never throws)", async () => {
    const failure: HermesRouteError = { code: "route_failed", message: "resolver down" };
    const port = createHermesRouteActivity({
      resolve: (): Promise<Result<HermesRouteSignals, HermesRouteError>> =>
        Promise.resolve({ ok: false, error: failure }),
    });
    const result = await port.route(makeHermesContext());
    expect(isOk(result)).toBe(false);
    if (!isOk(result)) expect(result.error.code).toBe("route_failed");
  });

  it("uses the default 0.7 threshold when none is injected", async () => {
    const port = portFor({ confidence: 0.7, workspaceId: WS });
    const result = await port.route(makeHermesContext());
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.confidence).toBe("high");
  });
});
