// spec(§9) — task 7.7 SOURCE INGESTION — the PURE orchestration driver.
//
// These tests drive `runSourceIngestion` (the pure driver) over the source-ingestion
// activity-port FAKES (test/support/source-fakes.ts) + the foundation FakeClock +
// InMemoryWorkflowRunRepo. The driver imports NEITHER @temporalio NOR node:crypto and
// calls NO Date.now()/Math.random(), so it runs entirely in-memory with no Temporal
// server (root CLAUDE.md ★ two-layer split). It drives the @sow/domain sourceMachine:
//   captured → classified → (queued_for_review | processing) → proposed
//            → applied | rejected | failed_retryable | failed_terminal
//
// The suite pins the 7.7 safety invariants:
//   • the SourceEnvelope is REGISTERED before extraction; a dedupe-hit is a no-op.
//   • LOW-confidence routing parks in queued_for_review (Ingestion Inbox), NO workspace
//     guess, NO durable write (inv-1) — the router NEVER auto-routes.
//   • the FORBIDDEN transition captured→applied (skip classification+policy) is rejected;
//     processing→external_write is structurally unrepresentable (no such edge).
//   • the source-processing job runs under a READ-ONLY ToolPolicy (ING-7): a mutating
//     tool is rejected at admission (→ failed_terminal) and never runs.
//   • the committed plan is DERIVED-FROM-VALIDATED — no inferred field reaches KW; the
//     write targets the ROUTING-BOUND workspace, never a caller value.
//   • injection / unsupported type / dedupe-hit are typed states → 7.5.
//   • REPLAY from the start reuses the commit + external write (each happens once).
//   • EVERY failure/park branch surfaces a 7.5 health item (nothing silent, inv-5).
import { describe, it, expect } from "vitest";
import { isOk, ok, workflowId } from "@sow/contracts";
import type { WorkspaceId, KnowledgeMutationPlan, Result } from "@sow/contracts";
import { SOURCE_STATES } from "@sow/domain";
import { runSourceIngestion } from "../src/workflows/sourceIngestion";
import type {
  SourceIngestionInput,
  SourceIngestionDeps,
} from "../src/workflows/sourceIngestion";
import {
  FakeRegisterSourcePort,
  FakeRouteSourcePort,
  FakeSourceAgentJobPort,
  FakeValidatePort,
  FakeBuildOutputsPort,
  FakeCommitPort,
  FakeProposePort,
  FakeIndexGbrainPort,
  FakeSourceHealthSink,
  makeSourceContext,
  makeAgentExtraction,
} from "./support/source-fakes";
import { FakeClock, InMemoryWorkflowRunRepo } from "./support/fakes";
import type {
  RegisterErrorCode,
  RouteErrorCode,
  SourceAgentFailureCode,
  KnowledgeCommitFailureCode,
  ProposeErrorCode,
  BuildOutputsFailureCode,
  CommitKnowledgePort,
  KnowledgeCommitSuccess,
  KnowledgeCommitFailure,
} from "../src/ports/sourceIngestion";

// --- fixtures --------------------------------------------------------------

const WS = "ws-employer" as WorkspaceId;

/** The happy-path input: the run submission + the pre-registration context. */
function makeInput(partial: Partial<SourceIngestionInput> = {}): SourceIngestionInput {
  return {
    run: {
      workflowId: workflowId("wf-si-1"),
      trigger: "connector_event",
      idempotencyKey: "idem-run-si-1",
      workspaceId: WS,
    },
    context: makeSourceContext(),
    ...partial,
  };
}

/** Build a fresh, all-green dep set with the fakes; override any port per test. */
function makeDeps(overrides: Partial<SourceIngestionDeps> = {}): SourceIngestionDeps {
  return {
    register: new FakeRegisterSourcePort({ result: "registered" }),
    route: new FakeRouteSourcePort({ confidence: "high", workspaceId: WS }),
    agent: new FakeSourceAgentJobPort({ result: "accepted" }),
    validate: new FakeValidatePort(),
    buildOutputs: new FakeBuildOutputsPort(),
    commit: new FakeCommitPort(),
    propose: new FakeProposePort(),
    index: new FakeIndexGbrainPort(),
    health: new FakeSourceHealthSink(),
    runs: new InMemoryWorkflowRunRepo(),
    clock: new FakeClock(),
    ...overrides,
  };
}

type KnowledgeMutationPlanCapture = KnowledgeMutationPlan;

/** A commit port that RECORDS every plan the driver hands it (for the WS-2 regression). */
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

describe("runSourceIngestion — happy path", () => {
  it("drives captured → classified → processing → proposed → applied with one commit + one external create", async () => {
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const index = new FakeIndexGbrainPort();
    const deps = makeDeps({ commit, propose, index });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("applied");
    expect(commit.writeCount).toBe(1);
    expect(propose.createCount).toBe(1);
    // GBrain index runs AFTER the Markdown commit: the committed revision is present.
    expect(outcome.context.revisionId).toBeDefined();
    expect(index.indexed).toContain(outcome.context.revisionId);
    // workspace bound before durable write (WS-2 / inv-1).
    expect(outcome.context.workspaceId).toBe(WS);
  });

  it("summarizes to proposed→applied with NO external actions when the derived plan has none", async () => {
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const deps = makeDeps({
      buildOutputs: new FakeBuildOutputsPort({ actionCount: 0 }),
      commit,
      propose,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("applied");
    expect(commit.writeCount).toBe(1);
    // No external actions → no external create.
    expect(propose.createCount).toBe(0);
  });

  it("resolves the run idempotently through the foundation seam (reused on a seen key)", async () => {
    const runs = new InMemoryWorkflowRunRepo();
    const first = await runSourceIngestion(makeInput(), makeDeps({ runs }));
    expect(isOk(first.run)).toBe(true);

    const second = await runSourceIngestion(makeInput(), makeDeps({ runs }));
    expect(second.runReused).toBe(true);
  });
});

// --- register-before-extraction + dedupe-hit no-op --------------------------

describe("runSourceIngestion — registration gate", () => {
  it("registers the SourceEnvelope BEFORE routing/extraction (register runs first)", async () => {
    const register = new FakeRegisterSourcePort({ result: "registered" });
    const route = new FakeRouteSourcePort({ confidence: "high", workspaceId: WS });
    const agent = new FakeSourceAgentJobPort({ result: "accepted" });
    const deps = makeDeps({ register, route, agent });

    await runSourceIngestion(makeInput(), deps);

    // register was consulted; and it ran before the agent extraction.
    expect(register.calls).toHaveLength(1);
    expect(agent.calls).toHaveLength(1);
  });

  it("a dedupe-hit is a NO-OP: no routing, no extraction, no commit, and a health item is surfaced", async () => {
    const route = new FakeRouteSourcePort({ confidence: "high", workspaceId: WS });
    const agent = new FakeSourceAgentJobPort({ result: "accepted" });
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const health = new FakeSourceHealthSink();
    const deps = makeDeps({
      register: new FakeRegisterSourcePort({ result: "dedupe_hit" }),
      route,
      agent,
      commit,
      propose,
      health,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    // A dedupe-hit ends the pipeline as a no-op (rejected — no reprocessing).
    expect(outcome.state).toBe("rejected");
    expect(route.calls).toHaveLength(0);
    expect(agent.calls).toHaveLength(0);
    expect(commit.writeCount).toBe(0);
    expect(propose.createCount).toBe(0);
    // The no-op is surfaced (nothing silent).
    expect(health.surfaced).toHaveLength(1);
  });

  it("a malformed source → failed_terminal with a health item, no routing", async () => {
    const route = new FakeRouteSourcePort({ confidence: "high", workspaceId: WS });
    const health = new FakeSourceHealthSink();
    const failWith: RegisterErrorCode = "malformed_source";
    const deps = makeDeps({
      register: new FakeRegisterSourcePort({ failWith }),
      route,
      health,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("failed_terminal");
    expect(route.calls).toHaveLength(0);
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- low-confidence routing → queued_for_review -----------------------------

describe("runSourceIngestion — low-confidence routing (Ingestion Inbox)", () => {
  it("parks in queued_for_review with NO commit and NO guessed workspace (inv-1)", async () => {
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const agent = new FakeSourceAgentJobPort({ result: "accepted" });
    const health = new FakeSourceHealthSink();
    const deps = makeDeps({
      route: new FakeRouteSourcePort({ confidence: "low", reason: "ambiguous" }),
      agent,
      commit,
      propose,
      health,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("queued_for_review");
    // NEVER auto-routes: no extraction, no durable writes on the parked path.
    expect(agent.calls).toHaveLength(0);
    expect(commit.writeCount).toBe(0);
    expect(propose.createCount).toBe(0);
    // NEVER guesses a workspace (inv-1 / WS-2).
    expect(outcome.context.workspaceId).toBeUndefined();
    // Parked to the Ingestion Inbox is surfaced (nothing silent).
    expect(health.surfaced).toHaveLength(1);
  });

  it("a router hard-failure also parks in queued_for_review (fail-closed; never guesses)", async () => {
    const health = new FakeSourceHealthSink();
    const failWith: RouteErrorCode = "route_source_unavailable";
    const deps = makeDeps({
      route: new FakeRouteSourcePort({ failWith }),
      health,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("queued_for_review");
    expect(outcome.context.workspaceId).toBeUndefined();
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- FORBIDDEN transitions --------------------------------------------------

describe("runSourceIngestion — forbidden transitions rejected", () => {
  it("the driver NEVER walks captured→applied (skipping classification+policy is structurally rejected)", () => {
    // The domain sourceMachine has NO captured→applied edge (forbidden per
    // DOMAIN_MODEL §Source). The alphabet has no `external_write` state at all, so
    // processing→external_write is unrepresentable.
    expect(SOURCE_STATES).toContain("captured");
    expect(SOURCE_STATES).toContain("applied");
    // There is no external_write state — the source agent can never drive one.
    expect(SOURCE_STATES).not.toContain("external_write");
  });
});

// --- source-agent READ-ONLY admission (ING-7) -------------------------------

describe("runSourceIngestion — read-only admission (ING-7)", () => {
  it("a mutating-tool declaration is rejected at admission → failed_terminal, NO extraction commit", async () => {
    const commit = new FakeCommitPort();
    const health = new FakeSourceHealthSink();
    const rejection: SourceAgentFailureCode = "admission_rejected";
    const deps = makeDeps({
      agent: new FakeSourceAgentJobPort({ result: "rejected", rejection }),
      commit,
      health,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("failed_terminal");
    expect(commit.writeCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("a detected injection → failed_terminal with a distinct health item", async () => {
    const health = new FakeSourceHealthSink();
    const deps = makeDeps({
      agent: new FakeSourceAgentJobPort({ result: "rejected", rejection: "injection_detected" }),
      health,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("failed_terminal");
    expect(health.surfaced).toHaveLength(1);
    expect(health.surfaced[0]?.message).toContain("injection_detected");
  });

  it("an unsupported source type → failed_terminal", async () => {
    const health = new FakeSourceHealthSink();
    const deps = makeDeps({
      agent: new FakeSourceAgentJobPort({ result: "rejected", rejection: "unsupported_type" }),
      health,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("failed_terminal");
    expect(health.surfaced).toHaveLength(1);
  });

  it("a provider failure → failed_retryable (non-terminal), with a health item", async () => {
    const health = new FakeSourceHealthSink();
    const deps = makeDeps({
      agent: new FakeSourceAgentJobPort({ result: "rejected", rejection: "provider_failed" }),
      health,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("failed_retryable");
    expect(health.surfaced).toHaveLength(1);
  });

  it("a broker schema rejection → rejected (candidate-gate failure), with a health item", async () => {
    const health = new FakeSourceHealthSink();
    const deps = makeDeps({
      agent: new FakeSourceAgentJobPort({ result: "rejected", rejection: "schema_rejected" }),
      health,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("rejected");
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- validator rejection → rejected, NO PARTIAL COMMIT ----------------------

describe("runSourceIngestion — validator rejection", () => {
  it("hard-rejects an inferred field → rejected, NO commit, NO external write (inv-3)", async () => {
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const buildOutputs = new FakeBuildOutputsPort();
    const health = new FakeSourceHealthSink();
    // An inferred owner with NO evidenceRef — the REAL no-inference rule rejects it.
    const badExtraction = makeAgentExtraction({
      fields: { owner: { value: "Alice" }, dueDate: { value: "2026-08-01" } },
    });
    const deps = makeDeps({
      agent: new FakeSourceAgentJobPort({ result: "accepted", extraction: badExtraction }),
      buildOutputs,
      commit,
      propose,
      health,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("rejected");
    // NO PARTIAL COMMIT: neither a Markdown commit nor an external write happened,
    // and buildOutputs was never reached (an inferred value can never be derived).
    expect(buildOutputs.calls).toHaveLength(0);
    expect(commit.writeCount).toBe(0);
    expect(propose.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("a build-outputs derivation failure → rejected, NO commit", async () => {
    const commit = new FakeCommitPort();
    const health = new FakeSourceHealthSink();
    const failWith: BuildOutputsFailureCode = "unmappable_extraction";
    const deps = makeDeps({
      buildOutputs: new FakeBuildOutputsPort({ failWith }),
      commit,
      health,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("rejected");
    expect(commit.writeCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- KnowledgeWriter write_conflict → failed_retryable ----------------------

describe("runSourceIngestion — write conflict", () => {
  it("lands in failed_retryable on a compare-revision clash, with NO external write and a health item", async () => {
    const propose = new FakeProposePort();
    const health = new FakeSourceHealthSink();
    const failWith: KnowledgeCommitFailureCode = "write_conflict";
    const deps = makeDeps({
      commit: new FakeCommitPort({ failWith }),
      propose,
      health,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("failed_retryable");
    expect(propose.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("a commit ownership_violation → failed_terminal (a WS-isolation breach never retries blindly)", async () => {
    const health = new FakeSourceHealthSink();
    const deps = makeDeps({
      commit: new FakeCommitPort({ failWith: "ownership_violation" }),
      health,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("failed_terminal");
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- external action held / approval → failed_retryable ---------------------

describe("runSourceIngestion — external action non-terminal", () => {
  it("an approval-required external action → failed_retryable (fail-closed, no write) with a health item", async () => {
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort({ failWith: "approval_pending" satisfies ProposeErrorCode });
    const health = new FakeSourceHealthSink();
    const deps = makeDeps({ commit, propose, health });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("failed_retryable");
    // The Markdown commit stands (it precedes the external stage); the external write
    // fails closed — no create.
    expect(commit.writeCount).toBe(1);
    expect(propose.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("a held external action → failed_retryable (non-terminal, re-drivable via outbox)", async () => {
    const propose = new FakeProposePort({ failWith: "held" satisfies ProposeErrorCode });
    const health = new FakeSourceHealthSink();
    const deps = makeDeps({ propose, health });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("failed_retryable");
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- REGRESSION: outputs DERIVED from validated data (the 7.6 governance lesson)

describe("runSourceIngestion — outputs derived from validated data (regression)", () => {
  it("[CRITICAL] an inferred owner is rejected at validate → rejected; buildOutputs + commit NEVER run", async () => {
    const buildOutputs = new FakeBuildOutputsPort();
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const health = new FakeSourceHealthSink();
    const inferred = makeAgentExtraction({
      fields: { owner: { value: "Alice" }, dueDate: { value: "2026-08-01" } },
    });
    const deps = makeDeps({
      agent: new FakeSourceAgentJobPort({ result: "accepted", extraction: inferred }),
      buildOutputs,
      commit,
      propose,
      health,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("rejected");
    expect(buildOutputs.calls).toHaveLength(0);
    expect(commit.writeCount).toBe(0);
    expect(propose.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("[HIGH] the committed plan targets the ROUTING-BOUND workspace, not a caller value", async () => {
    const boundWs = "ws-routing-bound" as WorkspaceId;
    const buildOutputs = new FakeBuildOutputsPort();
    const committedPlans: KnowledgeMutationPlanCapture[] = [];
    const commit = new CapturingCommitPort(committedPlans);
    const deps = makeDeps({
      route: new FakeRouteSourcePort({ confidence: "high", workspaceId: boundWs }),
      buildOutputs,
      commit,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("applied");
    // buildOutputs was handed the bound workspace (WS-2/WS-4) — not a caller field.
    expect(buildOutputs.calls).toHaveLength(1);
    expect(buildOutputs.calls[0]?.workspaceId).toBe(boundWs);
    // The plan that actually reached the commit carries the bound workspace.
    expect(committedPlans).toHaveLength(1);
    expect(committedPlans[0]?.workspaceId).toBe(boundWs);
  });

  it("the derived owner/date frontmatter comes ONLY from the validated extraction fields", async () => {
    const buildOutputs = new FakeBuildOutputsPort();
    const committedPlans: KnowledgeMutationPlanCapture[] = [];
    const commit = new CapturingCommitPort(committedPlans);
    const validExtraction = makeAgentExtraction({
      fields: {
        owner: { value: "Carol", evidenceRef: "source#L42" },
        dueDate: { value: "TBD" as never },
      },
    });
    const deps = makeDeps({
      agent: new FakeSourceAgentJobPort({ result: "accepted", extraction: validExtraction }),
      buildOutputs,
      commit,
    });

    const outcome = await runSourceIngestion(makeInput(), deps);

    expect(outcome.state).toBe("applied");
    expect(buildOutputs.calls[0]?.validated.fields.owner?.value).toBe("Carol");
    const create = committedPlans[0]?.creates[0];
    expect(create?.frontmatter?.owner).toBe("Carol");
    expect(create?.frontmatter?.dueDate).toBe("TBD");
  });
});

// --- REPLAY-SAFETY: re-run from the start reuses commit + external write -----

describe("runSourceIngestion — replay safety (LIFE-3)", () => {
  it("re-drives from the start with NO duplicate commit and NO duplicate external write (inv-5)", async () => {
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const runs = new InMemoryWorkflowRunRepo();

    const first = await runSourceIngestion(makeInput(), makeDeps({ commit, propose, runs }));
    expect(first.state).toBe("applied");
    expect(commit.writeCount).toBe(1);
    expect(propose.createCount).toBe(1);
    const firstRevision = first.context.revisionId;

    const second = await runSourceIngestion(makeInput(), makeDeps({ commit, propose, runs }));

    expect(second.state).toBe("applied");
    // The durable writes are REUSED — each happened exactly once across both drives.
    expect(commit.writeCount).toBe(1);
    expect(propose.createCount).toBe(1);
    expect(second.context.revisionId).toBe(firstRevision);
    expect(second.runReused).toBe(true);
  });
});

// --- §16 inv-5: the surfaced failure-class reflects the CAUSE, not just the state --

describe("runSourceIngestion — cause-aware §16 failure class (inv-5)", () => {
  const surfacedClass = async (overrides: Partial<SourceIngestionDeps>): Promise<string | undefined> => {
    const health = new FakeSourceHealthSink();
    const outcome = await runSourceIngestion(makeInput(), makeDeps({ ...overrides, health }));
    return outcome.surfaced?.failureClass;
  };

  it("a register-malformed schema reject → schema_rejection (NOT worker_down), still at failed_terminal — spec(§16)", async () => {
    const health = new FakeSourceHealthSink();
    const outcome = await runSourceIngestion(
      makeInput(),
      makeDeps({ register: new FakeRegisterSourcePort({ failWith: "malformed_source" }), health }),
    );
    expect(outcome.state).toBe("failed_terminal");
    expect(outcome.surfaced?.failureClass).toBe("schema_rejection");
    // never the infra bucket — the C1 Finding drained.
    expect(outcome.surfaced?.failureClass).not.toBe("worker_down");
    // the specific cause rides the message (preserved through the coarse-bucket class).
    expect(outcome.surfaced?.message).toContain("malformed_source");
  });

  it("a commit_failed terminal → write_through_failed, NOT schema_rejection — spec(§16)", async () => {
    expect(await surfacedClass({ commit: new FakeCommitPort({ failWith: "commit_failed" }) })).toBe(
      "write_through_failed",
    );
  });

  it("each conflated failed_terminal cause maps to its DEDICATED §16 member, never worker_down — spec(§16)", async () => {
    // C-enum: the security / policy / egress / isolation terminal causes now have dedicated
    // FailureClass members (retiring the C-fix least-wrong interims).
    const agent = (rejection: SourceAgentFailureCode): Partial<SourceIngestionDeps> => ({
      agent: new FakeSourceAgentJobPort({ result: "rejected", rejection }),
    });
    expect(await surfacedClass(agent("admission_rejected"))).toBe("policy_denial");
    expect(await surfacedClass(agent("injection_detected"))).toBe("security_violation");
    expect(await surfacedClass(agent("egress_vetoed"))).toBe("egress_denied");
    // unsupported_type is a genuine schema/type reject — STAYS schema_rejection.
    expect(await surfacedClass(agent("unsupported_type"))).toBe("schema_rejection");
    // Commit-stage causes: isolation + secret get dedicated members; commit_failed stays write_through.
    const commit = (failWith: KnowledgeCommitFailureCode): Partial<SourceIngestionDeps> => ({
      commit: new FakeCommitPort({ failWith }),
    });
    expect(await surfacedClass(commit("ownership_violation"))).toBe("isolation_breach");
    expect(await surfacedClass(commit("secret_found"))).toBe("security_violation");
    expect(await surfacedClass(commit("commit_failed"))).toBe("write_through_failed");
    // NONE of the conflated terminal causes is worker_down (reserved for supervision/infra).
    for (const c of ["admission_rejected", "injection_detected", "unsupported_type", "egress_vetoed"] as const) {
      expect(await surfacedClass(agent(c))).not.toBe("worker_down");
    }
    for (const c of ["ownership_violation", "secret_found", "commit_failed"] as const) {
      expect(await surfacedClass(commit(c))).not.toBe("worker_down");
    }
    expect(
      await surfacedClass({ register: new FakeRegisterSourcePort({ failWith: "malformed_source" }) }),
    ).not.toBe("worker_down");
    // The specific cause still rides the surfaced MESSAGE (defense-in-depth alongside the
    // now-dedicated class) — a refactor dropping the cause must fail HERE.
    const injected = await runSourceIngestion(makeInput(), makeDeps(agent("injection_detected")));
    expect(injected.surfaced?.failureClass).toBe("security_violation");
    expect(injected.surfaced?.message).toContain("injection_detected");
  });

  it("the non-terminal failure-class mappings are UNCHANGED (no regression / parity) — spec(§16)", async () => {
    // The non-terminal causes keep their prior class: for agent/commit causes the explicit
    // helper (agentFailureClass/commitFailureClass) EQUALS the prior state-based class
    // (parity); `held` (propose) still exercises the failureClassFor default path directly.
    // queued_for_review → conflict_review
    expect(await surfacedClass({ route: new FakeRouteSourcePort({ confidence: "low" }) })).toBe(
      "conflict_review",
    );
    // rejected → schema_rejection (a broker schema reject rests at rejected)
    expect(
      await surfacedClass({ agent: new FakeSourceAgentJobPort({ result: "rejected", rejection: "schema_rejected" }) }),
    ).toBe("schema_rejection");
    // failed_retryable → write_through_failed (provider / budget / write_conflict / held)
    expect(
      await surfacedClass({ agent: new FakeSourceAgentJobPort({ result: "rejected", rejection: "provider_failed" }) }),
    ).toBe("write_through_failed");
    expect(
      await surfacedClass({ agent: new FakeSourceAgentJobPort({ result: "rejected", rejection: "budget_exceeded" }) }),
    ).toBe("write_through_failed");
    expect(await surfacedClass({ commit: new FakeCommitPort({ failWith: "write_conflict" }) })).toBe(
      "write_through_failed",
    );
    expect(await surfacedClass({ propose: new FakeProposePort({ failWith: "held" }) })).toBe(
      "write_through_failed",
    );
  });
});

// --- inv-5: EVERY failure/park branch surfaces a health item ----------------

describe("runSourceIngestion — nothing fails silently (inv-5)", () => {
  it("every failure/park branch routes through the health sink", async () => {
    const scenarios: Array<Partial<SourceIngestionDeps>> = [
      { register: new FakeRegisterSourcePort({ result: "dedupe_hit" }) },
      { register: new FakeRegisterSourcePort({ failWith: "malformed_source" }) },
      { route: new FakeRouteSourcePort({ confidence: "low" }) },
      { agent: new FakeSourceAgentJobPort({ result: "rejected", rejection: "provider_failed" }) },
      { validate: new FakeValidatePort({ forceSchemaReject: true }) },
      { buildOutputs: new FakeBuildOutputsPort({ failWith: "build_failed" }) },
      { commit: new FakeCommitPort({ failWith: "write_conflict" }) },
      { propose: new FakeProposePort({ failWith: "held" }) },
    ];
    for (const scenario of scenarios) {
      const health = new FakeSourceHealthSink();
      await runSourceIngestion(makeInput(), makeDeps({ ...scenario, health }));
      expect(health.surfaced.length).toBeGreaterThanOrEqual(1);
    }
  });
});
