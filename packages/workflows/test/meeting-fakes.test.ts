// spec(§9 / task 7.6) — the meeting-closeout PORTS seam + its in-memory fakes.
//
// This is the seam every downstream 7.6 slice imports: the port INTERFACES the
// PURE driver calls (each carrying a closed, enumerable typed error, §16) plus
// the in-memory fakes/builders that let the driver be Vitest-unit-tested with NO
// broker / KnowledgeWriter / Tool Gateway / Temporal server. These tests assert
// the fakes SATISFY the ports (compile-time via explicit `: Port` annotations at
// their declaration) and behave per the 7.6 safety invariants they model:
//   1. correlation LOW-CONFIDENCE routes to needs_routing_review (never guesses a
//      workspace); a bound workspace is present ONLY on high confidence.
//   3. the validator hard-rejects inferred owners/dates (REQ-F-017) — no partial.
//   4. semantic outputs go through the commit port; external via the propose port.
//   5. replay: the commit fake is idempotent-by-key (replayed:true, no 2nd write);
//      the propose fake reuses a receipt (reused, no duplicate external write).
import { describe, it, expect } from "vitest";
import { isOk, isErr, workspaceId, planId, auditId } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type {
  CorrelatePort,
  RunMeetingAgentJobPort,
  ValidateExtractionPort,
  BuildOutputsPort,
  ValidatedExtraction,
  CommitKnowledgePort,
  ProposeActionsPort,
  ReindexGbrainPort,
  MeetingHealthSink,
  MeetingCloseoutContext,
  AgentExtraction,
  CorrelationOutcome,
} from "../src/ports/meetingCloseout";
import {
  makeMeetingContext,
  makeAgentExtraction,
  FakeCorrelatePort,
  FakeAgentJobPort,
  FakeValidatePort,
  FakeBuildOutputsPort,
  FakeCommitPort,
  FakeProposePort,
  FakeReindexPort,
  FakeMeetingHealthSink,
} from "./support/meeting-fakes";
import { FakeClock } from "./support/fakes";

const T0 = "2026-07-01T00:00:00.000Z";

// --- builders --------------------------------------------------------------

describe("spec(§9) meeting-closeout builders", () => {
  it("makeMeetingContext produces a well-formed pipeline context with sane defaults", () => {
    const ctx: MeetingCloseoutContext = makeMeetingContext();
    expect(ctx.source).toBeDefined();
    expect(ctx.source.workspaceId).toBeDefined();
    // The pre-correlation context carries NO bound workspaceId yet (WS-2: bound
    // only AFTER correlation succeeds).
    expect(ctx.workspaceId).toBeUndefined();
    expect(ctx.correlation).toBeUndefined();
    expect(ctx.extraction).toBeUndefined();
    expect(ctx.validated).toBeUndefined();
    expect(ctx.revisionId).toBeUndefined();
    expect(ctx.envelopes).toEqual([]);
  });

  it("makeMeetingContext accepts partial overrides", () => {
    const ws = workspaceId("ws-employer");
    const ctx = makeMeetingContext({ workspaceId: ws, revisionId: "rev-9" });
    expect(ctx.workspaceId).toBe(ws);
    expect(ctx.revisionId).toBe("rev-9");
  });

  it("makeAgentExtraction produces an evidence-backed, non-inferred field set by default", () => {
    const ex: AgentExtraction = makeAgentExtraction();
    expect(Object.keys(ex.fields).length).toBeGreaterThan(0);
    // Defaults are evidence-backed (owner) or the TBD sentinel (dueDate) so the
    // default extraction PASSES the no-inference validator.
    expect(ex.fields.owner?.evidenceRef).toBeTruthy();
    expect(ex.fields.dueDate?.value).toBe(TBD);
  });
});

// --- FakeCorrelatePort (confidence high/low) -------------------------------

describe("spec(§9 inv-1) FakeCorrelatePort — low-confidence routes to needs_routing_review", () => {
  it("HIGH confidence binds a workspace (+ project) and does NOT ask for routing review", async () => {
    const port: CorrelatePort = new FakeCorrelatePort({
      confidence: "high",
      workspaceId: workspaceId("ws-employer"),
      projectId: "proj-acme",
    });
    const res = await port.correlate(makeMeetingContext());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    const outcome: CorrelationOutcome = res.value;
    expect(outcome.confidence).toBe("high");
    // Type-narrow: a high-confidence outcome carries the bound workspace.
    if (outcome.confidence !== "high") return;
    expect(outcome.workspaceId).toBe(workspaceId("ws-employer"));
    expect(outcome.projectId).toBe("proj-acme");
  });

  it("LOW confidence carries a routing_review marker and NO bound workspace (never guesses)", async () => {
    const port = new FakeCorrelatePort({ confidence: "low" });
    const res = await port.correlate(makeMeetingContext());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    const outcome = res.value;
    expect(outcome.confidence).toBe("low");
    if (outcome.confidence !== "low") return;
    expect(outcome.routingReview).toBe(true);
    // A low-confidence outcome has no workspaceId field to read at all — the
    // discriminated union does not carry it. (compile-time guarantee)
    expect((outcome as { workspaceId?: unknown }).workspaceId).toBeUndefined();
  });

  it("can be configured to fail with a typed correlate error (never throws)", async () => {
    const port = new FakeCorrelatePort({ failWith: "correlation_source_unavailable" });
    const res = await port.correlate(makeMeetingContext());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("correlation_source_unavailable");
  });
});

// --- FakeAgentJobPort (accepted/rejected) ----------------------------------

describe("spec(§9 inv-2) FakeAgentJobPort — broker admission + candidate extraction", () => {
  it("ACCEPTED returns a candidate AgentExtraction", async () => {
    const port: RunMeetingAgentJobPort = new FakeAgentJobPort({ result: "accepted" });
    const res = await port.run(makeMeetingContext({ workspaceId: workspaceId("ws-x") }));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.fields).toBeDefined();
  });

  it("REJECTED (ING-7: a mutating tool declared on untrusted content) → typed admission_rejected", async () => {
    const port = new FakeAgentJobPort({ result: "rejected", rejection: "admission_rejected" });
    const res = await port.run(makeMeetingContext());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    // A closed, enumerable failure set — never a thrown provider error.
    expect(res.error.code).toBe("admission_rejected");
  });

  it("provider failure surfaces as a distinct provider_failed code", async () => {
    const port = new FakeAgentJobPort({ result: "rejected", rejection: "provider_failed" });
    const res = await port.run(makeMeetingContext());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("provider_failed");
  });
});

// --- FakeValidatePort (valid / rejects-inferred) ---------------------------

describe("spec(§9 inv-3) FakeValidatePort — no-inference + schema hard-reject, no partial", () => {
  it("a fully evidence-backed extraction VALIDATES", () => {
    const port: ValidateExtractionPort = new FakeValidatePort();
    const res = port.validate(makeAgentExtraction());
    expect(isOk(res)).toBe(true);
  });

  it("an INFERRED owner (concrete value, no evidenceRef) is HARD-REJECTED (REQ-F-017)", () => {
    const port = new FakeValidatePort();
    const inferred = makeAgentExtraction({
      fields: {
        // concrete value with NO evidence slot → inferred_owner_or_date
        owner: { value: "Alice" },
      },
    });
    const res = port.validate(inferred);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("no_inference_violation");
    expect(res.error.rejections.length).toBeGreaterThan(0);
    expect(res.error.rejections[0]?.code).toBe("inferred_owner_or_date");
  });

  it("can be forced to a schema_rejected error independent of field content", () => {
    const port = new FakeValidatePort({ forceSchemaReject: true });
    const res = port.validate(makeAgentExtraction());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("schema_rejected");
  });
});

// --- FakeBuildOutputsPort (derives plan + actions FROM validated data) ------

describe("spec(§9 inv-3) FakeBuildOutputsPort — outputs derived from validated extraction", () => {
  const validated: ValidatedExtraction = {
    validated: true,
    fields: {
      owner: { value: "Dana", evidenceRef: "transcript#L7" },
      dueDate: { value: TBD },
    },
  };

  it("stamps plan.workspaceId from the PASSED workspace (WS-2/WS-4 — never a caller value)", async () => {
    const port: BuildOutputsPort = new FakeBuildOutputsPort();
    const res = await port.build(validated, workspaceId("ws-bound"));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.plan.workspaceId).toBe(workspaceId("ws-bound"));
  });

  it("derives owner/date frontmatter ONLY from the validated fields (never invented)", async () => {
    const port = new FakeBuildOutputsPort();
    const res = await port.build(validated, workspaceId("ws-bound"));
    if (!isOk(res)) return;
    const create = res.value.plan.creates[0];
    expect(create?.frontmatter?.owner).toBe("Dana");
    // An unstated dueDate stays TBD — REQ-F-017.
    expect(create?.frontmatter?.dueDate).toBe(TBD);
  });

  it("records the (validated, workspaceId) it was asked to build", async () => {
    const port = new FakeBuildOutputsPort();
    await port.build(validated, workspaceId("ws-bound"));
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.workspaceId).toBe(workspaceId("ws-bound"));
    expect(port.calls[0]?.validated.fields.owner?.value).toBe("Dana");
  });

  it("can be configured to fail (→ the driver folds it to schema_rejected)", async () => {
    const port = new FakeBuildOutputsPort({ failWith: "unmappable_extraction" });
    const res = await port.build(validated, workspaceId("ws-bound"));
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("unmappable_extraction");
  });
});

// --- FakeCommitPort (ok / conflict, idempotent-by-key) ---------------------

describe("spec(§9 inv-5) FakeCommitPort — KnowledgeWriter idempotent-by-key replay", () => {
  it("commits a plan and returns a revisionId (replayed:false on first sight)", async () => {
    const port: CommitKnowledgePort = new FakeCommitPort();
    const res = await port.commit(makeMeetingPlan());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.revisionId).toBeTruthy();
    expect(res.value.replayed).toBe(false);
  });

  it("REPLAY: a second commit with the SAME idempotencyKey returns replayed:true, no 2nd write", async () => {
    const port = new FakeCommitPort();
    const plan = makeMeetingPlan();
    const first = await port.commit(plan);
    const second = await port.commit(plan);
    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    // Same revisionId — the replay reuses the prior commit, no new revision.
    expect(second.value.revisionId).toBe(first.value.revisionId);
    expect(second.value.replayed).toBe(true);
    // Exactly ONE underlying write happened.
    expect(port.writeCount).toBe(1);
  });

  it("can be configured to return a write_conflict", async () => {
    const port = new FakeCommitPort({ failWith: "write_conflict" });
    const res = await port.commit(makeMeetingPlan());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("write_conflict");
  });
});

// --- FakeProposePort (created / reused) ------------------------------------

describe("spec(§9 inv-5) FakeProposePort — Tool Gateway envelope reuse (no duplicate external write)", () => {
  it("first propose CREATES the external write (envelope carries a receipt)", async () => {
    const port: ProposeActionsPort = new FakeProposePort();
    const { action, env } = makeProposal();
    const res = await port.propose(action, env);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.status).toBe("created");
    expect(res.value.envelope.writeReceipt).toBeDefined();
  });

  it("REPLAY: a second propose with the SAME idempotencyKey REUSES the receipt — zero duplicate write", async () => {
    const port = new FakeProposePort();
    const { action, env } = makeProposal();
    const first = await port.propose(action, env);
    const second = await port.propose(action, env);
    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(second.value.status).toBe("reused");
    expect(port.createCount).toBe(1);
  });

  it("can be configured to require approval (fail-closed, no write) → approval_pending", async () => {
    const port = new FakeProposePort({ failWith: "approval_pending" });
    const { action, env } = makeProposal();
    const res = await port.propose(action, env);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("approval_pending");
    expect(port.createCount).toBe(0);
  });
});

// --- FakeReindexPort (async, idempotent, after commit) ---------------------

describe("spec(§9 inv-4) FakeReindexPort — GBrain re-index after commit, idempotent", () => {
  it("reindex succeeds and records the revisionId", async () => {
    // Declared as the concrete fake, but assigned through the port type to prove
    // FakeReindexPort SATISFIES ReindexGbrainPort (compile-time).
    const asPort: ReindexGbrainPort = new FakeReindexPort();
    const port = asPort as FakeReindexPort;
    const res = await port.reindex("rev-1");
    expect(isOk(res)).toBe(true);
    expect(port.reindexed).toContain("rev-1");
  });

  it("is idempotent — re-indexing the same revisionId does not duplicate", async () => {
    const port = new FakeReindexPort();
    await port.reindex("rev-1");
    await port.reindex("rev-1");
    expect(port.reindexed.filter((r) => r === "rev-1")).toHaveLength(1);
  });

  it("a reindex failure is a typed err (never rolls back the commit)", async () => {
    const port = new FakeReindexPort({ failWith: "reindex_failed" });
    const res = await port.reindex("rev-1");
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("reindex_failed");
  });
});

// --- FakeMeetingHealthSink (5.2 failure sink) ------------------------------

describe("spec(§16) FakeMeetingHealthSink — every failure class surfaces (nothing silent)", () => {
  it("records each surfaced failure so a test can assert nothing failed silently", async () => {
    const sink: MeetingHealthSink = new FakeMeetingHealthSink();
    const res = await sink.surface({
      failureClass: "schema_rejection",
      subjectRef: "candidate-1",
      message: "rejected",
      auditRef: auditId("audit-1"),
    });
    expect(isOk(res)).toBe(true);
    expect((sink as FakeMeetingHealthSink).surfaced).toHaveLength(1);
    expect((sink as FakeMeetingHealthSink).surfaced[0]?.failureClass).toBe("schema_rejection");
  });
});

// --- FakeClock reuse (foundation) ------------------------------------------

describe("meeting fakes reuse the foundation FakeClock (no Date.now())", () => {
  it("the FakeClock injects a controllable time", () => {
    const clock = new FakeClock({ now: T0 });
    expect(clock.now()).toBe(T0);
  });
});

// --- local test builders (kept in the test, not the fakes module) ----------

import type { KnowledgeMutationPlan, ProposedAction, ExternalWriteEnvelope } from "@sow/contracts";
import { actionId } from "@sow/contracts";

function makeMeetingPlan(): KnowledgeMutationPlan {
  return {
    planId: planId("plan-1"),
    workspaceId: workspaceId("ws-employer"),
    sourceRefs: [{ sourceId: "src-1" }],
    creates: [],
    patches: [],
    linkMutations: [],
    frontmatterUpdates: [],
    externalActionProposals: [],
    confidence: 0.9,
    requiresApproval: false,
    provenanceOrigin: "meeting_close",
  } as unknown as KnowledgeMutationPlan;
}

function makeProposal(): { action: ProposedAction; env: ExternalWriteEnvelope } {
  const action: ProposedAction = {
    actionId: actionId("action-1"),
    targetSystem: "todoist",
    canonicalObjectKey: "todoist:task:abc",
    payload: {},
    approvalPolicy: "auto",
    idempotencyKey: "idem-ext-1",
  };
  const env: ExternalWriteEnvelope = {
    actionId: actionId("action-1"),
    targetSystem: "todoist",
    canonicalObjectKey: "todoist:task:abc",
    idempotencyKey: "idem-ext-1",
    preconditions: ["not-exists"],
    payloadHash: "hash-1",
  };
  return { action, env };
}
