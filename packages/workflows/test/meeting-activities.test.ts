// spec(§9 / task 7.6) — the MEETING-CLOSEOUT ACTIVITY implementations: the
// worker-side wiring of the real adapters (Broker / policy / KnowledgeWriter /
// Tool Gateway / GBrain index-sync) BEHIND the pure port interfaces
// (src/ports/meetingCloseout.ts). Each activity takes its effects INJECTED so it
// is Vitest-unit-testable with fakes (no live Temporal / network / DB) and every
// one returns the EXACT typed Result its port declares — never throws (§16).
//
// The safety invariants these tests pin (7.6):
//   inv-1 correlation LOW-CONFIDENCE → needs_routing_review, NEVER guesses a ws.
//   inv-2 ING-7: a meeting.close job declaring a MUTATING tool on the untrusted
//         transcript is REJECTED at admission (admission_rejected) — never run.
//   inv-3 the validator HARD-REJECTS an inferred owner/date (REQ-F-017) — no partial.
//   inv-5 commit is idempotent-by-key on replay (replayed:true, one write); propose
//         REUSES the receipt on replay (reused, one create).
//   inv-4 reindex runs only AFTER a commit (needs a revisionId) and is idempotent.
import { describe, it, expect } from "vitest";
import {
  ok,
  err,
  isOk,
  isErr,
  workspaceId,
  planId,
  actionId,
  workflowId,
  toolId,
} from "@sow/contracts";
import type {
  Result,
  AgentJob,
  KnowledgeMutationPlan,
  ProposedAction,
  ExternalWriteEnvelope,
  WriteReceipt,
  WorkflowRunRef,
} from "@sow/contracts";
import { TBD } from "@sow/domain";
import { makeMeetingContext, makeAgentExtraction } from "./support/meeting-fakes";
import type {
  AgentExtraction,
  ValidatedExtraction,
} from "../src/ports/meetingCloseout";
import { sourceId } from "@sow/contracts";
import type { SourceRef } from "@sow/contracts";

import { createCorrelateActivity } from "../src/activities/correlateMeeting";
import type { CorrelationSignals } from "../src/activities/correlateMeeting";
import { createRunAgentJobActivity } from "../src/activities/runAgentJob";
import type {
  MeetingBroker,
  MeetingJobInputs,
} from "../src/activities/runAgentJob";
import { createValidateActivity } from "../src/activities/validateCloseout";
import { createBuildOutputsActivity } from "../src/activities/buildOutputs";
import { FakeNoteExistsReader } from "./support/project-sync-fakes";
import type {
  OutputsProjection,
  DerivedActionDescriptor,
} from "../src/activities/buildOutputs";
import { createCommitActivity } from "../src/activities/commitKnowledge";
import type { ApplyPlanFn } from "../src/activities/commitKnowledge";
import { createProposeActivity } from "../src/activities/proposeExternalActions";
import type { DispatchExternalWriteFn } from "../src/activities/proposeExternalActions";
import { createReindexActivity } from "../src/activities/reindexGbrain";
import type { GbrainReindexClient } from "../src/activities/reindexGbrain";

import type { BrokerOutcome, BrokerAccepted } from "@sow/providers";
import type { WriteSuccess, WriteFailure } from "@sow/knowledge";
import type { ExternalWriteResult } from "@sow/integrations";

// ---------------------------------------------------------------------------
// correlateMeeting — inv-1
// ---------------------------------------------------------------------------

describe("spec(§9 inv-1) correlateMeeting activity — low confidence routes to needs_routing_review", () => {
  it("HIGH-confidence signals bind a workspace (+ project), no routing review", async () => {
    const signals: CorrelationSignals = {
      confidence: 0.95,
      workspaceId: workspaceId("ws-employer"),
      projectId: "proj-acme",
    };
    const port = createCorrelateActivity({
      resolveSignals: () => Promise.resolve(ok(signals)),
      threshold: 0.7,
    });
    const res = await port.correlate(makeMeetingContext());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.confidence).toBe("high");
    if (res.value.confidence !== "high") return;
    expect(res.value.workspaceId).toBe(workspaceId("ws-employer"));
    expect(res.value.projectId).toBe("proj-acme");
  });

  it("BELOW-threshold confidence → low outcome with routingReview, NO bound workspace (never guesses)", async () => {
    const signals: CorrelationSignals = {
      confidence: 0.4,
      // even if a candidate workspace is present, sub-threshold must NOT bind it
      workspaceId: workspaceId("ws-guess"),
    };
    const port = createCorrelateActivity({
      resolveSignals: () => Promise.resolve(ok(signals)),
      threshold: 0.7,
    });
    const res = await port.correlate(makeMeetingContext());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.confidence).toBe("low");
    if (res.value.confidence !== "low") return;
    expect(res.value.routingReview).toBe(true);
    expect((res.value as { workspaceId?: unknown }).workspaceId).toBeUndefined();
  });

  it("a high-confidence score with NO resolved workspace still routes to review (never invents one)", async () => {
    const port = createCorrelateActivity({
      resolveSignals: () => Promise.resolve(ok({ confidence: 0.99 })),
      threshold: 0.7,
    });
    const res = await port.correlate(makeMeetingContext());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.confidence).toBe("low");
  });

  it("a signal-source failure surfaces a typed correlate error (never throws)", async () => {
    const port = createCorrelateActivity({
      resolveSignals: () =>
        Promise.resolve(err({ code: "correlation_source_unavailable", message: "calendar down" })),
      threshold: 0.7,
    });
    const res = await port.correlate(makeMeetingContext());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("correlation_source_unavailable");
  });
});

// ---------------------------------------------------------------------------
// runAgentJob — inv-2 (ING-7 admission)
// ---------------------------------------------------------------------------

function meetingInputs(overrides: Partial<MeetingJobInputs> = {}): MeetingJobInputs {
  return {
    workflowRunId: workflowId("wf-1"),
    workspaceId: workspaceId("ws-employer"),
    capability: "meeting.close",
    outputSchemaId: "sow:meeting-close-output",
    maxRuntimeSeconds: 120,
    idempotencyKey: "idem-meeting-1",
    ...overrides,
  };
}

// A broker that records the job it was handed and returns a canned outcome.
function recordingBroker(outcome: BrokerOutcome): {
  broker: MeetingBroker;
  seen: AgentJob[];
} {
  const seen: AgentJob[] = [];
  const broker: MeetingBroker = {
    runJob: (req) => {
      seen.push(req.job);
      return Promise.resolve(outcome);
    },
  };
  return { broker, seen };
}

const acceptedOutcome: BrokerAccepted = {
  jobState: "accepted",
  route: { provider: "claude", model: "claude-x", endpoint: "local", egressClass: "local_zero_egress" } as unknown as BrokerAccepted["route"],
  candidate: {
    kind: "knowledge_mutation_plan",
    plan: { planId: planId("plan-x") } as unknown as KnowledgeMutationPlan,
  },
  usage: {} as unknown as BrokerAccepted["usage"],
  audits: [],
  replayed: false,
};

describe("spec(§9 inv-2) runAgentJob activity — ING-7 admission + broker dispatch", () => {
  it("builds a READ-ONLY, untrusted, raw-content meeting.close job and (ACCEPTED) maps the candidate → AgentExtraction", async () => {
    const { broker, seen } = recordingBroker(ok(acceptedOutcome));
    const extraction = makeAgentExtraction();
    const port = createRunAgentJobActivity({
      broker,
      inputs: meetingInputs(),
      buildEgress: () => ({} as never),
      buildMatrix: () => ({} as never),
      buildWorkspace: () => ({ type: "employer" as never, dataOwner: "employer" as never }),
      mapCandidate: () => extraction,
    });
    const res = await port.run(makeMeetingContext({ workspaceId: workspaceId("ws-employer") }));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.fields).toBe(extraction.fields);
    // The job actually handed to the broker is READ-ONLY on untrusted raw content.
    expect(seen).toHaveLength(1);
    const job = seen[0]!;
    expect(job.trustLevel).toBe("untrusted");
    expect(job.carriesRawContent).toBe(true);
    expect(job.toolPolicy.mode).toBe("read_only");
    expect(job.toolPolicy.allowsMutating).toBe(false);
    expect(job.outputSchemaId).toBe("sow:meeting-close-output");
    expect(job.idempotencyKey).toBe("idem-meeting-1");
  });

  it("ING-7: a MUTATING tool policy on the untrusted transcript is REJECTED at admission → admission_rejected, broker NEVER runs", async () => {
    const { broker, seen } = recordingBroker(ok(acceptedOutcome));
    const port = createRunAgentJobActivity({
      broker,
      // A caller-declared mutating tool policy — must be refused at admission.
      inputs: meetingInputs({
        toolPolicy: {
          mode: "scoped_write",
          allowedTools: [toolId("todoist.create")],
          deniedTools: [],
          allowsMutating: true,
        },
      }),
      buildEgress: () => ({} as never),
      buildMatrix: () => ({} as never),
      buildWorkspace: () => ({ type: "employer" as never, dataOwner: "employer" as never }),
      mapCandidate: () => makeAgentExtraction(),
    });
    const res = await port.run(makeMeetingContext());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("admission_rejected");
    // The job was never dispatched — admission stopped it dead (never run).
    expect(seen).toHaveLength(0);
  });

  it("a broker rejection maps to a distinct provider_failed code (candidate-gate rejection → schema_rejected)", async () => {
    const rejection: BrokerOutcome = err({
      stage: "run" as never,
      reason: "provider_unreachable" as never,
      message: "provider down",
      audit: {} as never,
      jobState: "provider_failed" as never,
      branch: "provider_failed" as never,
      retryable: true,
      audits: [],
    });
    const { broker } = recordingBroker(rejection);
    const port = createRunAgentJobActivity({
      broker,
      inputs: meetingInputs(),
      buildEgress: () => ({} as never),
      buildMatrix: () => ({} as never),
      buildWorkspace: () => ({ type: "employer" as never, dataOwner: "employer" as never }),
      mapCandidate: () => makeAgentExtraction(),
      mapRejection: () => "provider_failed",
    });
    const res = await port.run(makeMeetingContext());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("provider_failed");
  });
});

// ---------------------------------------------------------------------------
// validateCloseout — inv-3 (no-inference + schema, no partial)
// ---------------------------------------------------------------------------

describe("spec(§9 inv-3) validateCloseout activity — no-inference + schema hard-reject, no partial", () => {
  it("an evidence-backed / TBD extraction VALIDATES to a branded ValidatedExtraction", () => {
    const port = createValidateActivity({ schemaGate: () => ok(undefined) });
    const res = port.validate(makeAgentExtraction());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.validated).toBe(true);
  });

  it("an INFERRED owner (concrete value, no evidenceRef) is HARD-REJECTED (REQ-F-017) → no_inference_violation, no partial", () => {
    const port = createValidateActivity({ schemaGate: () => ok(undefined) });
    const inferred = makeAgentExtraction({ fields: { owner: { value: "Alice" } } });
    const res = port.validate(inferred);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("no_inference_violation");
    expect(res.error.rejections[0]?.code).toBe("inferred_owner_or_date");
  });

  it("a no-inference PASS but schema-gate FAIL → schema_rejected (the gate composition, not just no-inference)", () => {
    const port = createValidateActivity({
      schemaGate: () => err({ code: "schema_rejected", message: "ajv structural failure" }),
    });
    const res = port.validate(makeAgentExtraction());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("schema_rejected");
  });

  it("no-inference runs BEFORE the schema gate — an inferred field rejects even when the schema gate would pass", () => {
    let gateCalled = false;
    const port = createValidateActivity({
      schemaGate: () => {
        gateCalled = true;
        return ok(undefined);
      },
    });
    const res = port.validate(makeAgentExtraction({ fields: { owner: { value: "Alice" } } }));
    expect(isErr(res)).toBe(true);
    // The no-inference hard-reject short-circuits — no partial validation state.
    expect(gateCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildOutputs — inv-3/WS-2/WS-4 (derive the plan + actions FROM validated data)
// ---------------------------------------------------------------------------

function validatedFixture(ownerValue = "Erin"): ValidatedExtraction {
  return {
    validated: true,
    fields: {
      owner: { value: ownerValue, evidenceRef: "transcript#L3" },
      dueDate: { value: TBD },
    },
  };
}

const meetingSourceRef: SourceRef = { sourceId: sourceId("src-meeting-1") };

// A projection that maps the validated fields onto a meeting note + one action.
function noteProjection(): OutputsProjection {
  return {
    project: (validated, ws) =>
      ok({
        mutation: {
          kind: "create",
          note: {
            path: `meetings/${String(ws)}/closeout.md`,
            body: "closeout",
            frontmatter: {
              owner: validated.fields.owner?.value,
              dueDate: validated.fields.dueDate?.value,
            },
          },
        },
        actions: [
          {
            targetSystem: "todoist",
            canonicalIdentity: { list: "inbox", title: "follow-up" },
            operation: "todoist.create",
            idempotencyIdentity: { title: "follow-up" },
            payload: { title: "follow-up" },
            approvalPolicy: "auto",
            payloadHash: "sha256:x",
            preconditions: ["not_exists"],
          } satisfies DerivedActionDescriptor,
        ],
      }),
  };
}

describe("spec(§9 inv-3/WS-2) buildOutputs activity — outputs DERIVED from validated data", () => {
  it("stamps plan.workspaceId from the PASSED workspace (never a caller value)", async () => {
    const port = createBuildOutputsActivity({
      projection: noteProjection(),
      sourceRef: meetingSourceRef,
      planIdentity: { closeout: "wf-1" },
      noteExists: new FakeNoteExistsReader({ exists: false }),
    });
    const res = await port.build(validatedFixture(), workspaceId("ws-bound"));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.plan.workspaceId).toBe(workspaceId("ws-bound"));
    // The plan cites its evidence (REQ-F-006 ≥1 sourceRef).
    expect(res.value.plan.sourceRefs.length).toBeGreaterThanOrEqual(1);
  });

  it("populates note frontmatter ONLY from the validated fields (owner from validated, TBD stays TBD)", async () => {
    const port = createBuildOutputsActivity({
      projection: noteProjection(),
      sourceRef: meetingSourceRef,
      planIdentity: { closeout: "wf-1" },
      noteExists: new FakeNoteExistsReader({ exists: false }),
    });
    const res = await port.build(validatedFixture("Frank"), workspaceId("ws-bound"));
    if (!isOk(res)) return;
    const create = res.value.plan.creates[0];
    expect(create?.frontmatter?.owner).toBe("Frank");
    expect(create?.frontmatter?.dueDate).toBe(TBD);
  });

  it("derives external actions with computed canonicalObjectKey + idempotencyKey (drives replay reuse)", async () => {
    const port = createBuildOutputsActivity({
      projection: noteProjection(),
      sourceRef: meetingSourceRef,
      planIdentity: { closeout: "wf-1" },
      noteExists: new FakeNoteExistsReader({ exists: false }),
    });
    const res = await port.build(validatedFixture(), workspaceId("ws-bound"));
    if (!isOk(res)) return;
    expect(res.value.actions).toHaveLength(1);
    const item = res.value.actions[0]!;
    // §8 key builders produce the opaque cok_/idem_ keys — not caller strings.
    expect(item.action.canonicalObjectKey.startsWith("cok_todoist_")).toBe(true);
    expect(item.action.idempotencyKey.startsWith("idem_")).toBe(true);
    // The envelope shares the four linkage keys with the action.
    expect(item.envelope.canonicalObjectKey).toBe(item.action.canonicalObjectKey);
    expect(item.envelope.idempotencyKey).toBe(item.action.idempotencyKey);
  });

  it("is DETERMINISTIC — same validated + workspace ⇒ same planId + keys (replay-stable, inv-5)", async () => {
    const port = createBuildOutputsActivity({
      projection: noteProjection(),
      sourceRef: meetingSourceRef,
      planIdentity: { closeout: "wf-1" },
      noteExists: new FakeNoteExistsReader({ exists: false }),
    });
    const a = await port.build(validatedFixture(), workspaceId("ws-bound"));
    const b = await port.build(validatedFixture(), workspaceId("ws-bound"));
    if (!isOk(a) || !isOk(b)) return;
    expect(b.value.plan.planId).toBe(a.value.plan.planId);
    expect(b.value.actions[0]?.action.idempotencyKey).toBe(
      a.value.actions[0]?.action.idempotencyKey,
    );
  });

  it("fails closed on a projection error (→ the driver folds to schema_rejected, no partial commit)", async () => {
    const failingProjection: OutputsProjection = {
      project: () => err({ code: "unmappable_extraction", message: "cannot project" }),
    };
    const port = createBuildOutputsActivity({
      projection: failingProjection,
      sourceRef: meetingSourceRef,
      planIdentity: { closeout: "wf-1" },
      noteExists: new FakeNoteExistsReader({ exists: false }),
    });
    const res = await port.build(validatedFixture(), workspaceId("ws-bound"));
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("unmappable_extraction");
  });
});

// ---------------------------------------------------------------------------
// commitKnowledge — inv-5 (KnowledgeWriter idempotent replay)
// ---------------------------------------------------------------------------

function meetingPlan(): KnowledgeMutationPlan {
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

function runRef(): WorkflowRunRef {
  return {
    workflowId: workflowId("wf-1"),
    trigger: "event",
    state: "open",
    idempotencyKey: "run-idem-1",
    auditRefs: [],
  };
}

// A fake applyPlan that is idempotent by command.idempotencyKey.
function idempotentApplyPlan(): { fn: ApplyPlanFn; writeCount: () => number } {
  let writes = 0;
  const byKey = new Map<string, string>();
  const fn: ApplyPlanFn = (command) => {
    const existing = byKey.get(command.idempotencyKey);
    if (existing !== undefined) {
      return Promise.resolve(
        ok({
          revisionId: existing,
          auditRecord: {} as WriteSuccess["auditRecord"],
          replayed: true,
        } as WriteSuccess),
      );
    }
    writes += 1;
    const rev = `rev-${writes}`;
    byKey.set(command.idempotencyKey, rev);
    return Promise.resolve(
      ok({
        revisionId: rev as WriteSuccess["revisionId"],
        auditRecord: {} as WriteSuccess["auditRecord"],
        replayed: false,
      } as WriteSuccess),
    );
  };
  return { fn, writeCount: () => writes };
}

describe("spec(§9 inv-5) commitKnowledge activity — KnowledgeWriter idempotent-by-key replay", () => {
  it("commits a validated plan → revisionId (replayed:false on first sight)", async () => {
    const applied = idempotentApplyPlan();
    const port = createCommitActivity({
      applyPlan: applied.fn,
      deps: {} as never,
      actor: "meeting-closeout",
      sourceEventRef: "src-event-1",
      workflowRunRef: runRef(),
      expectedBaseRevision: "rev-base" as never,
      deriveIdempotencyKey: (plan) => `commit:${String(plan.planId)}`,
    });
    const res = await port.commit(meetingPlan());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.revisionId).toBeTruthy();
    expect(res.value.replayed).toBe(false);
  });

  it("REPLAY: a second commit of the SAME plan returns replayed:true, same revision, ONE underlying write", async () => {
    const applied = idempotentApplyPlan();
    const port = createCommitActivity({
      applyPlan: applied.fn,
      deps: {} as never,
      actor: "meeting-closeout",
      sourceEventRef: "src-event-1",
      workflowRunRef: runRef(),
      expectedBaseRevision: "rev-base" as never,
      deriveIdempotencyKey: (plan) => `commit:${String(plan.planId)}`,
    });
    const plan = meetingPlan();
    const first = await port.commit(plan);
    const second = await port.commit(plan);
    expect(isOk(first) && isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(second.value.revisionId).toBe(first.value.revisionId);
    expect(second.value.replayed).toBe(true);
    expect(applied.writeCount()).toBe(1);
  });

  it("maps a WriteFailure(write_conflict) → write_conflict; a partial commit never happens", async () => {
    const failing: ApplyPlanFn = () =>
      Promise.resolve(
        err({
          code: "write_conflict",
          expectedBaseRevision: "rev-base" as never,
          onDiskRevision: "rev-other" as never,
        } as WriteFailure),
      );
    const port = createCommitActivity({
      applyPlan: failing,
      deps: {} as never,
      actor: "meeting-closeout",
      sourceEventRef: "src-event-1",
      workflowRunRef: runRef(),
      expectedBaseRevision: "rev-base" as never,
      deriveIdempotencyKey: (plan) => `commit:${String(plan.planId)}`,
    });
    const res = await port.commit(meetingPlan());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("write_conflict");
  });

  it("maps a WriteFailure(schema_rejected) → schema_rejected", async () => {
    const failing: ApplyPlanFn = () =>
      Promise.resolve(err({ code: "schema_rejected", stage: "ajv", issues: [] } as WriteFailure));
    const port = createCommitActivity({
      applyPlan: failing,
      deps: {} as never,
      actor: "meeting-closeout",
      sourceEventRef: "src-event-1",
      workflowRunRef: runRef(),
      expectedBaseRevision: "rev-base" as never,
      deriveIdempotencyKey: (plan) => `commit:${String(plan.planId)}`,
    });
    const res = await port.commit(meetingPlan());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("schema_rejected");
  });
});

// ---------------------------------------------------------------------------
// proposeExternalActions — inv-5 (Tool Gateway envelope reuse)
// ---------------------------------------------------------------------------

function proposal(): { action: ProposedAction; env: ExternalWriteEnvelope } {
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

// A fake dispatch that CREATEs on first key, REUSEs on replay.
function idempotentDispatch(): { fn: DispatchExternalWriteFn; createCount: () => number } {
  let creates = 0;
  const byKey = new Map<string, WriteReceipt>();
  const fn: DispatchExternalWriteFn = (env) => {
    const existing = byKey.get(env.idempotencyKey);
    if (existing !== undefined) {
      return Promise.resolve({ status: "reused", receipt: existing } as ExternalWriteResult);
    }
    creates += 1;
    const receipt: WriteReceipt = {
      externalObjectId: `ext-${creates}`,
      recordedAt: "2026-07-01T00:00:00.000Z",
    };
    byKey.set(env.idempotencyKey, receipt);
    return Promise.resolve({ status: "created", receipt } as ExternalWriteResult);
  };
  return { fn, createCount: () => creates };
}

describe("spec(§9 inv-5) proposeExternalActions activity — Tool Gateway envelope reuse (no duplicate write)", () => {
  it("first propose CREATES the external write; the returned envelope carries the receipt", async () => {
    const dispatch = idempotentDispatch();
    const port = createProposeActivity({ dispatch: dispatch.fn, deps: {} as never });
    const { action, env } = proposal();
    const res = await port.propose(action, env);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.status).toBe("created");
    expect(res.value.envelope.writeReceipt).toBeDefined();
  });

  it("REPLAY: a second propose with the SAME idempotencyKey REUSES the receipt — zero duplicate create", async () => {
    const dispatch = idempotentDispatch();
    const port = createProposeActivity({ dispatch: dispatch.fn, deps: {} as never });
    const { action, env } = proposal();
    const first = await port.propose(action, env);
    const second = await port.propose(action, env);
    expect(isOk(first) && isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(second.value.status).toBe("reused");
    expect(dispatch.createCount()).toBe(1);
  });

  it("an approval-required action FAILS CLOSED → approval_pending, NO write", async () => {
    const dispatch = idempotentDispatch();
    const port = createProposeActivity({
      dispatch: () => Promise.resolve({ status: "approval_pending" } as ExternalWriteResult),
      deps: {} as never,
    });
    const { action, env } = proposal();
    const res = await port.propose(action, env);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("approval_pending");
    expect(dispatch.createCount()).toBe(0);
  });

  it("maps a gateway conflict / held / rejected onto the closed ProposeError set (never throws)", async () => {
    const cases: Array<{ out: ExternalWriteResult; code: string }> = [
      { out: { status: "conflict", reason: "precondition clash" }, code: "conflict" },
      { out: { status: "held", reason: "probe unreachable" }, code: "held" },
      { out: { status: "rejected", reason: "vendor refused" }, code: "rejected" },
    ];
    for (const c of cases) {
      const port = createProposeActivity({
        dispatch: () => Promise.resolve(c.out),
        deps: {} as never,
      });
      const { action, env } = proposal();
      const res = await port.propose(action, env);
      expect(isErr(res)).toBe(true);
      if (!isErr(res)) continue;
      expect(res.error.code).toBe(c.code);
    }
  });
});

// ---------------------------------------------------------------------------
// reindexGbrain — inv-4 (async, idempotent, AFTER commit)
// ---------------------------------------------------------------------------

// A fake reindex client, idempotent by revisionId.
function idempotentReindexClient(): { client: GbrainReindexClient; calls: () => string[] } {
  const seen: string[] = [];
  const client: GbrainReindexClient = {
    reindex: (revisionId) => {
      if (seen.includes(revisionId)) {
        return Promise.resolve(ok({ kind: "already_indexed" as const, revisionId }));
      }
      seen.push(revisionId);
      return Promise.resolve(ok({ kind: "indexed" as const, revisionId }));
    },
  };
  return { client, calls: () => seen };
}

describe("spec(§9 inv-4) reindexGbrain activity — after commit, idempotent, never rolls back", () => {
  it("reindexes a committed revision (needs a revisionId — i.e. AFTER a commit)", async () => {
    const c = idempotentReindexClient();
    const port = createReindexActivity({ client: c.client });
    const res = await port.reindex("rev-1");
    expect(isOk(res)).toBe(true);
    expect(c.calls()).toContain("rev-1");
  });

  it("is idempotent — re-indexing the same revision does not dispatch a second index job", async () => {
    const c = idempotentReindexClient();
    const port = createReindexActivity({ client: c.client });
    await port.reindex("rev-1");
    await port.reindex("rev-1");
    expect(c.calls().filter((r) => r === "rev-1")).toHaveLength(1);
  });

  it("NEVER runs before a commit: an empty revisionId fails closed → revision_unavailable (client not called)", async () => {
    let called = false;
    const port = createReindexActivity({
      client: {
        reindex: (revisionId) => {
          called = true;
          return Promise.resolve(ok({ kind: "indexed" as const, revisionId }));
        },
      },
    });
    const res = await port.reindex("");
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("revision_unavailable");
    expect(called).toBe(false);
  });

  it("a reindex failure is a typed err (the commit is NOT rolled back — that is the caller's guarantee)", async () => {
    const port = createReindexActivity({
      client: {
        reindex: () =>
          Promise.resolve(err({ code: "reindex_failed", message: "index write failed" })),
      },
    });
    const res = await port.reindex("rev-1");
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("reindex_failed");
  });
});
