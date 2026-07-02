// spec(§9.13) — task 7.17 COPILOT Q&A (read path) — the PURE orchestration driver.
//
// These tests drive `runCopilotQa` (the pure driver) over in-memory activity-port
// FAKES + the foundation FakeClock + InMemoryWorkflowRunRepo. The driver imports
// NEITHER @temporalio NOR node:crypto and calls NO Date.now()/Math.random(), so it
// runs entirely in-memory with no Temporal server (root CLAUDE.md ★ two-layer split).
//
// The suite pins the 7.17 safety invariants (Section 9.13 / REQ-F-005 / REQ-S-007):
//   • READ PATH = NO SIDE EFFECT: no KnowledgeWriter commit call, no Tool-Gateway
//     external-write dispatch call — EVER (the port set has neither; the driver only
//     retrieves + synthesizes + optionally ROUTES a proposal).
//   • a WORKSPACE question resolves to workspace-scoped retrieval (ONE brain).
//   • a GLOBAL question routes via the GCL Visibility Gate (RetrieveGlobalPort) —
//     the workspace-retrieval port is NEVER called (no direct cross-brain query).
//   • synthesis is schema-gated and returns CITATIONS (≥1).
//   • an explicit act-request hands a ProposedAction to the 7.9 approval path
//     (QaRouteToApprovalPort) as a PROPOSAL — it is NOT applied inline.
//   • provider/budget failure → 7.5; a budget breach cancels with NO partial side
//     effect (nothing to leak — the read path never mutated anything).
//   • EVERY failure/park branch surfaces a distinct 7.5 health item (nothing silent).
import { describe, it, expect } from "vitest";
import {
  isOk,
  ok,
  err,
  actionId,
  sourceId,
  workflowId,
} from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  ProposedAction,
  ExternalWriteEnvelope,
  SourceRef,
  GclProjection,
} from "@sow/contracts";
import { runCopilotQa, copilotQaMachine } from "../src/workflows/copilotQa";
import type {
  CopilotQaInput,
  CopilotQaDeps,
} from "../src/workflows/copilotQa";
import type {
  CopilotQaContext,
  CopilotQuestion,
  QaScope,
  ClassifyScopePort,
  ClassifyScopeError,
  RetrieveWorkspacePort,
  RetrieveWorkspaceError,
  RetrieveWorkspaceErrorCode,
  RetrieveGlobalPort,
  RetrieveGlobalError,
  RetrieveGlobalErrorCode,
  RetrievedEvidence,
  SynthesizeAnswerPort,
  SynthesizeFailure,
  SynthesizeFailureCode,
  ValidatedAnswer,
  BuildProposalPort,
  QaProposalOutputs,
  BuildProposalFailure,
  BuildProposalFailureCode,
  QaRouteToApprovalPort,
  QaRouteToApprovalResult,
  QaRouteToApprovalError,
  QaRouteToApprovalErrorCode,
  CopilotQaHealthSink,
  CopilotQaFailure,
  CopilotQaSurfaceOutcome,
  CopilotQaHealthSinkError,
} from "../src/ports/copilotQa";
import { FakeClock, InMemoryWorkflowRunRepo } from "./support/fakes";

// --- fixtures --------------------------------------------------------------

const WS = "ws-personal" as WorkspaceId;
const WS_OTHER = "ws-employer" as WorkspaceId;

function makeQuestion(partial: Partial<CopilotQuestion> = {}): CopilotQuestion {
  return {
    text: "what did I decide about the auth redesign?",
    channel: "mac",
    askedWorkspaceId: WS,
    ...partial,
  };
}

function makeContext(partial: Partial<CopilotQaContext> = {}): CopilotQaContext {
  return { question: makeQuestion(), ...partial };
}

function makeInput(partial: Partial<CopilotQaInput> = {}): CopilotQaInput {
  return {
    run: {
      workflowId: workflowId("wf-qa-1"),
      trigger: "owner_action",
      idempotencyKey: "idem-run-qa-1",
      workspaceId: WS,
    },
    context: makeContext(),
    ...partial,
  };
}

const SREF: SourceRef = { sourceId: sourceId("note-auth-redesign") };

function workspaceEvidence(ws: WorkspaceId = WS): RetrievedEvidence {
  return { scope: "workspace", workspaceId: ws, sourceRefs: [SREF] };
}

function globalEvidence(): RetrievedEvidence {
  const projection: GclProjection = {
    workspaceId: WS_OTHER,
    visibilityLevel: "coordination",
    projectionType: "status_summary",
    sanitizedPayload: { status: "in progress" },
    sourceRefs: [SREF],
  };
  return { scope: "global", projections: [projection] };
}

function validatedAnswer(): ValidatedAnswer {
  return {
    validated: true,
    text: "You chose OAuth device flow.",
    citations: [{ sourceRef: SREF, snippet: "decision: device flow" }],
  };
}

function makeAction(): ProposedAction {
  return {
    actionId: actionId("act-qa-1"),
    targetSystem: "telegram",
    canonicalObjectKey: "telegram:msg:qa-1",
    payload: { text: "You chose OAuth device flow." },
    approvalPolicy: "requires_approval",
    idempotencyKey: "idem-act-qa-1",
  };
}

function makeEnvelope(): ExternalWriteEnvelope {
  const act = makeAction();
  return {
    actionId: act.actionId,
    targetSystem: act.targetSystem,
    canonicalObjectKey: act.canonicalObjectKey,
    idempotencyKey: act.idempotencyKey,
    preconditions: [],
    payloadHash: "hash-qa-1",
  };
}

// --- fakes -----------------------------------------------------------------

type FakeClassifyConfig =
  | { kind: "workspace"; workspaceId?: WorkspaceId }
  | { kind: "global" }
  | { kind: "undetermined" };

class FakeClassifyScopePort implements ClassifyScopePort {
  readonly calls: CopilotQuestion[] = [];
  constructor(private readonly config: FakeClassifyConfig = { kind: "workspace" }) {}
  classify(question: CopilotQuestion): Promise<Result<QaScope, ClassifyScopeError>> {
    this.calls.push(question);
    if (this.config.kind === "undetermined") {
      const error: ClassifyScopeError = {
        code: "scope_undetermined",
        message: "ambiguous scope",
      };
      return Promise.resolve(err(error));
    }
    if (this.config.kind === "global") {
      return Promise.resolve(ok({ kind: "global" }));
    }
    return Promise.resolve(
      ok({ kind: "workspace", workspaceId: this.config.workspaceId ?? WS }),
    );
  }
}

type FakeRetrieveWsConfig =
  | { kind: "ok"; workspaceId?: WorkspaceId }
  | { kind: "fail"; code: RetrieveWorkspaceErrorCode };

class FakeRetrieveWorkspacePort implements RetrieveWorkspacePort {
  readonly calls: WorkspaceId[] = [];
  constructor(private readonly config: FakeRetrieveWsConfig = { kind: "ok" }) {}
  retrieve(
    workspaceId: WorkspaceId,
    _question: CopilotQuestion,
  ): Promise<Result<RetrievedEvidence, RetrieveWorkspaceError>> {
    this.calls.push(workspaceId);
    if (this.config.kind === "fail") {
      return Promise.resolve(
        err({ code: this.config.code, message: `ws retrieve failed: ${this.config.code}` }),
      );
    }
    return Promise.resolve(ok(workspaceEvidence(this.config.workspaceId ?? workspaceId)));
  }
}

type FakeRetrieveGlobalConfig =
  | { kind: "ok" }
  | { kind: "fail"; code: RetrieveGlobalErrorCode };

class FakeRetrieveGlobalPort implements RetrieveGlobalPort {
  readonly calls: CopilotQuestion[] = [];
  constructor(private readonly config: FakeRetrieveGlobalConfig = { kind: "ok" }) {}
  retrieve(
    question: CopilotQuestion,
  ): Promise<Result<RetrievedEvidence, RetrieveGlobalError>> {
    this.calls.push(question);
    if (this.config.kind === "fail") {
      return Promise.resolve(
        err({ code: this.config.code, message: `global retrieve failed: ${this.config.code}` }),
      );
    }
    return Promise.resolve(ok(globalEvidence()));
  }
}

type FakeSynthesizeConfig =
  | { kind: "ok"; answer?: ValidatedAnswer }
  | { kind: "fail"; code: SynthesizeFailureCode };

class FakeSynthesizeAnswerPort implements SynthesizeAnswerPort {
  readonly calls: RetrievedEvidence[] = [];
  constructor(private readonly config: FakeSynthesizeConfig = { kind: "ok" }) {}
  synthesize(
    evidence: RetrievedEvidence,
    _question: CopilotQuestion,
  ): Promise<Result<ValidatedAnswer, SynthesizeFailure>> {
    this.calls.push(evidence);
    if (this.config.kind === "fail") {
      return Promise.resolve(
        err({ code: this.config.code, message: `synth failed: ${this.config.code}` }),
      );
    }
    return Promise.resolve(ok(this.config.answer ?? validatedAnswer()));
  }
}

type FakeBuildProposalConfig =
  | { kind: "ok" }
  | { kind: "fail"; code: BuildProposalFailureCode };

class FakeBuildProposalPort implements BuildProposalPort {
  readonly calls: ValidatedAnswer[] = [];
  constructor(private readonly config: FakeBuildProposalConfig = { kind: "ok" }) {}
  build(
    answer: ValidatedAnswer,
    _question: CopilotQuestion,
  ): Promise<Result<QaProposalOutputs, BuildProposalFailure>> {
    this.calls.push(answer);
    if (this.config.kind === "fail") {
      return Promise.resolve(
        err({ code: this.config.code, message: `build failed: ${this.config.code}` }),
      );
    }
    return Promise.resolve(ok({ action: makeAction(), envelope: makeEnvelope() }));
  }
}

type FakeRoutePayload = { action: ProposedAction; env: ExternalWriteEnvelope };
type FakeRouteConfig =
  | { kind: "ok"; created?: boolean }
  | { kind: "fail"; code: QaRouteToApprovalErrorCode };

class FakeRouteToApprovalPort implements QaRouteToApprovalPort {
  readonly calls: FakeRoutePayload[] = [];
  constructor(private readonly config: FakeRouteConfig = { kind: "ok" }) {}
  route(
    action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<QaRouteToApprovalResult, QaRouteToApprovalError>> {
    this.calls.push({ action, env });
    if (this.config.kind === "fail") {
      return Promise.resolve(
        err({ code: this.config.code, message: `route failed: ${this.config.code}` }),
      );
    }
    return Promise.resolve(
      ok({ approvalRef: "appr-qa-1", created: this.config.created ?? true }),
    );
  }
}

class FakeHealthSink implements CopilotQaHealthSink {
  readonly surfaced: CopilotQaFailure[] = [];
  constructor(private readonly fail = false) {}
  surface(
    failure: CopilotQaFailure,
  ): Promise<Result<CopilotQaSurfaceOutcome, CopilotQaHealthSinkError>> {
    this.surfaced.push(failure);
    if (this.fail) {
      return Promise.resolve(err({ code: "surface_failed", message: "sink down" }));
    }
    return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
  }
}

// --- deps assembly ---------------------------------------------------------

interface DepsOverrides {
  classify?: ClassifyScopePort;
  retrieveWorkspace?: FakeRetrieveWorkspacePort;
  retrieveGlobal?: FakeRetrieveGlobalPort;
  synthesize?: FakeSynthesizeAnswerPort;
  buildProposal?: FakeBuildProposalPort;
  route?: FakeRouteToApprovalPort;
  health?: FakeHealthSink;
}

function makeDeps(o: DepsOverrides = {}): {
  deps: CopilotQaDeps;
  classify: FakeClassifyScopePort;
  retrieveWorkspace: FakeRetrieveWorkspacePort;
  retrieveGlobal: FakeRetrieveGlobalPort;
  synthesize: FakeSynthesizeAnswerPort;
  buildProposal: FakeBuildProposalPort;
  route: FakeRouteToApprovalPort;
  health: FakeHealthSink;
} {
  const classify = (o.classify as FakeClassifyScopePort) ?? new FakeClassifyScopePort();
  const retrieveWorkspace = o.retrieveWorkspace ?? new FakeRetrieveWorkspacePort();
  const retrieveGlobal = o.retrieveGlobal ?? new FakeRetrieveGlobalPort();
  const synthesize = o.synthesize ?? new FakeSynthesizeAnswerPort();
  const buildProposal = o.buildProposal ?? new FakeBuildProposalPort();
  const route = o.route ?? new FakeRouteToApprovalPort();
  const health = o.health ?? new FakeHealthSink();
  const deps: CopilotQaDeps = {
    classify,
    retrieveWorkspace,
    retrieveGlobal,
    synthesize,
    buildProposal,
    route,
    health,
    runs: new InMemoryWorkflowRunRepo(),
    clock: new FakeClock(),
  };
  return {
    deps,
    classify: classify as FakeClassifyScopePort,
    retrieveWorkspace,
    retrieveGlobal,
    synthesize,
    buildProposal,
    route,
    health,
  };
}

// --- tests -----------------------------------------------------------------

describe("copilotQaMachine", () => {
  it("is total: every state has a defined (possibly empty) transition set", () => {
    const answered = copilotQaMachine.transition("retrieved", "answered");
    expect(isOk(answered)).toBe(true);
    const illegal = copilotQaMachine.transition("received", "answered");
    expect(isOk(illegal)).toBe(false);
    // terminal `answered` -> `done` legal; done has no outgoing edge.
    expect(isOk(copilotQaMachine.transition("answered", "done"))).toBe(true);
  });
});

describe("runCopilotQa — happy path (workspace-scoped)", () => {
  it("classifies workspace, retrieves ONE bound brain, synthesizes a cited answer, no side effects", async () => {
    const { deps, classify, retrieveWorkspace, retrieveGlobal, synthesize, route } =
      makeDeps({ classify: new FakeClassifyScopePort({ kind: "workspace" }) });

    const outcome = await runCopilotQa(makeInput(), deps);

    expect(outcome.state).toBe("answered");
    expect(outcome.surfaced).toBeUndefined();
    // workspace-scoped retrieval used, GLOBAL path NOT touched (WS-8: no cross-brain).
    expect(classify.calls).toHaveLength(1);
    expect(retrieveWorkspace.calls).toEqual([WS]);
    expect(retrieveGlobal.calls).toHaveLength(0);
    // answer is validated + carries ≥1 citation.
    expect(outcome.context.answer?.validated).toBe(true);
    expect(outcome.context.answer?.citations.length).toBeGreaterThanOrEqual(1);
    // READ PATH: no act-request → NO proposal routed (no side effect).
    expect(route.calls).toHaveLength(0);
    expect(outcome.context.proposalRef).toBeUndefined();
    expect(synthesize.calls).toHaveLength(1);
  });
});

describe("runCopilotQa — global question routes via the GCL Visibility Gate", () => {
  it("uses the global (gate) retrieval port and NEVER the direct workspace-brain port", async () => {
    const { deps, retrieveWorkspace, retrieveGlobal } = makeDeps({
      classify: new FakeClassifyScopePort({ kind: "global" }),
    });

    const outcome = await runCopilotQa(makeInput(), deps);

    expect(outcome.state).toBe("answered");
    // WS-8: a global question NEVER issues a direct cross-brain workspace query.
    expect(retrieveWorkspace.calls).toHaveLength(0);
    expect(retrieveGlobal.calls).toHaveLength(1);
    // evidence carried the SANITIZED gate projections (never raw bodies).
    expect(outcome.context.evidence?.scope).toBe("global");
  });

  it("a gate denial parks in retrieval_denied and surfaces a 7.5 item — no answer", async () => {
    const { deps, health, synthesize } = makeDeps({
      classify: new FakeClassifyScopePort({ kind: "global" }),
      retrieveGlobal: new FakeRetrieveGlobalPort({ kind: "fail", code: "gate_denied" }),
    });

    const outcome = await runCopilotQa(makeInput(), deps);

    expect(outcome.state).toBe("retrieval_denied");
    expect(outcome.surfaced?.failureClass).toBeDefined();
    expect(health.surfaced).toHaveLength(1);
    // synthesis never ran — no evidence.
    expect(synthesize.calls).toHaveLength(0);
    expect(outcome.context.answer).toBeUndefined();
  });
});

describe("runCopilotQa — scope classification fail-closed (WS-8)", () => {
  it("an undetermined scope parks in scope_undetermined and NEVER guesses a workspace", async () => {
    const { deps, retrieveWorkspace, retrieveGlobal, health } = makeDeps({
      classify: new FakeClassifyScopePort({ kind: "undetermined" }),
    });

    const outcome = await runCopilotQa(makeInput(), deps);

    expect(outcome.state).toBe("scope_undetermined");
    // no retrieval of any kind happened — no wrong-brain read.
    expect(retrieveWorkspace.calls).toHaveLength(0);
    expect(retrieveGlobal.calls).toHaveLength(0);
    expect(health.surfaced).toHaveLength(1);
  });
});

describe("runCopilotQa — REQ-S-007 provider/budget failure", () => {
  it("a provider failure parks in provider_failed with a 7.5 item and NO answer", async () => {
    const { deps, health, route } = makeDeps({
      synthesize: new FakeSynthesizeAnswerPort({ kind: "fail", code: "provider_failed" }),
    });

    const outcome = await runCopilotQa(makeInput(), deps);

    expect(outcome.state).toBe("provider_failed");
    expect(health.surfaced).toHaveLength(1);
    expect(health.surfaced[0]?.failureClass).toBe("write_through_failed");
    // no proposal / no side effect.
    expect(route.calls).toHaveLength(0);
    expect(outcome.context.answer).toBeUndefined();
  });

  it("a budget breach CANCELS in budget_exceeded with NO partial side effect", async () => {
    const { deps, health, route } = makeDeps({
      classify: new FakeClassifyScopePort({ kind: "workspace" }),
      synthesize: new FakeSynthesizeAnswerPort({ kind: "fail", code: "budget_exceeded" }),
    });

    // ask to ACT so we can prove the budget cancel produced NO proposal either.
    const input = makeInput({ context: makeContext({ question: makeQuestion({ explicitActRequest: true }) }) });
    const outcome = await runCopilotQa(input, deps);

    expect(outcome.state).toBe("budget_exceeded");
    expect(health.surfaced).toHaveLength(1);
    // REQ-S-007: NO partial side effect — the proposal path was never entered.
    expect(route.calls).toHaveLength(0);
    expect(outcome.context.proposalRef).toBeUndefined();
    expect(outcome.context.answer).toBeUndefined();
  });

  it("an uncited/malformed answer is a schema rejection (no answer surfaced)", async () => {
    const { deps, health } = makeDeps({
      synthesize: new FakeSynthesizeAnswerPort({ kind: "fail", code: "schema_rejected" }),
    });

    const outcome = await runCopilotQa(makeInput(), deps);

    expect(outcome.state).toBe("schema_rejected");
    expect(health.surfaced[0]?.failureClass).toBe("schema_rejection");
  });
});

describe("runCopilotQa — explicit act-request → 7.9 proposal (NOT applied inline)", () => {
  it("hands the derived ProposedAction to the approval path as a proposal", async () => {
    const { deps, route, buildProposal } = makeDeps({
      classify: new FakeClassifyScopePort({ kind: "workspace" }),
    });

    const input = makeInput({
      context: makeContext({ question: makeQuestion({ explicitActRequest: true }) }),
    });
    const outcome = await runCopilotQa(input, deps);

    expect(outcome.state).toBe("proposed");
    // the proposal was DERIVED from the validated answer, then ROUTED (not applied).
    expect(buildProposal.calls).toHaveLength(1);
    expect(buildProposal.calls[0]?.validated).toBe(true);
    expect(route.calls).toHaveLength(1);
    expect(route.calls[0]?.action.actionId).toBe(actionId("act-qa-1"));
    expect(outcome.context.proposalRef).toBe("appr-qa-1");
  });

  it("a route failure parks in route_failed with a 7.5 item — still NO external write", async () => {
    const { deps, health } = makeDeps({
      classify: new FakeClassifyScopePort({ kind: "workspace" }),
      route: new FakeRouteToApprovalPort({ kind: "fail", code: "route_failed" }),
    });

    const input = makeInput({
      context: makeContext({ question: makeQuestion({ explicitActRequest: true }) }),
    });
    const outcome = await runCopilotQa(input, deps);

    expect(outcome.state).toBe("route_failed");
    expect(health.surfaced).toHaveLength(1);
    // still no applied write — routing to the inbox is the only durable artifact, and it failed.
    expect(outcome.context.proposalRef).toBeUndefined();
  });

  it("a proposal-derivation failure folds to schema_rejected (no side effect)", async () => {
    const { deps, route, health } = makeDeps({
      classify: new FakeClassifyScopePort({ kind: "workspace" }),
      buildProposal: new FakeBuildProposalPort({ kind: "fail", code: "unmappable_answer" }),
    });

    const input = makeInput({
      context: makeContext({ question: makeQuestion({ explicitActRequest: true }) }),
    });
    const outcome = await runCopilotQa(input, deps);

    expect(outcome.state).toBe("schema_rejected");
    expect(route.calls).toHaveLength(0);
    expect(health.surfaced).toHaveLength(1);
  });
});

describe("runCopilotQa — workspace retrieval denial", () => {
  it("a denied workspace read parks in retrieval_denied and surfaces a 7.5 item", async () => {
    const { deps, health, synthesize } = makeDeps({
      classify: new FakeClassifyScopePort({ kind: "workspace" }),
      retrieveWorkspace: new FakeRetrieveWorkspacePort({ kind: "fail", code: "retrieval_denied" }),
    });

    const outcome = await runCopilotQa(makeInput(), deps);

    expect(outcome.state).toBe("retrieval_denied");
    expect(synthesize.calls).toHaveLength(0);
    expect(health.surfaced).toHaveLength(1);
  });
});

describe("runCopilotQa — idempotent replay", () => {
  it("re-driving with the same idempotencyKey reuses the run and re-answers with no side effect", async () => {
    const { deps, route } = makeDeps({
      classify: new FakeClassifyScopePort({ kind: "workspace" }),
    });

    const input = makeInput();
    const first = await runCopilotQa(input, deps);
    const second = await runCopilotQa(input, deps);

    expect(first.state).toBe("answered");
    expect(second.state).toBe("answered");
    expect(second.runReused).toBe(true);
    // still side-effect-free on the replay.
    expect(route.calls).toHaveLength(0);
  });
});

describe("runCopilotQa — never throws even if the health sink errors", () => {
  it("returns the failure state when the sink itself fails (fail-closed)", async () => {
    const { deps } = makeDeps({
      classify: new FakeClassifyScopePort({ kind: "undetermined" }),
      health: new FakeHealthSink(true),
    });

    const outcome = await runCopilotQa(makeInput(), deps);
    expect(outcome.state).toBe("scope_undetermined");
  });
});
