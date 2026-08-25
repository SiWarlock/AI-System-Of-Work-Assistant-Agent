// spec(§9) — data-wf-plan-id-injectivity: make per-plan health-item identity
// STRUCTURALLY injective, instead of trusting an unbound `newPlanId` factory.
//
// Task 24.58 composed a per-plan health-item `subjectRef` as
// `${workflowId}:${planId}` and wrote down three obligations that composite
// silently depends on: (a) `newPlanId` is INJECTIVE WITHIN A RUN, (b) BOUNDED
// LENGTH, (c) DERIVED FROM NOTHING CONTENT-BEARING. NONE was enforced — a
// constant binding (`() => "plan-1"`, already the most common binding in the
// test tree — see apps/worker/test/composition/meeting-vault.test.ts:61) makes
// every sibling plan in a run collapse onto ONE health item (last message
// wins, N-1 lost), invisibly to every prior test.
//
// This suite pins the fix for meetingCloseout.ts's two per-plan `health.surface`
// call sites (the propose-withheld branch and the commit-failure branch) — the
// only production file this package's territory covers this round.
//
// TERRITORY NOTE: sourceIngestion.ts's matching per-plan site (step 7b, the
// `livingVaultPlans` loop) needs the IDENTICAL fix and is explicitly called out
// in the brief (Case 2), but sourceIngestion.ts is NOT in this package's
// declared edit territory for this dispatch — only meetingCloseout.ts and this
// test file are. That gap is reported in `crossTerritoryNeeds`, not silently
// dropped or silently "fixed" by editing a file outside territory.
import { describe, it, expect } from "vitest";
import { ok, err, planId, workflowId } from "@sow/contracts";
import type {
  WorkspaceId,
  KnowledgeMutationPlan,
  Result,
  SourceEnvelope,
} from "@sow/contracts";
import {
  runMeetingCloseout,
  planHealthSubjectRef,
  PLAN_ID_SUBJECT_REF_SEGMENT_MAX_LEN,
} from "../src/workflows/meetingCloseout";
import type {
  MeetingCloseoutInput,
  MeetingCloseoutDeps,
} from "../src/workflows/meetingCloseout";
import type { MeetingParkPort, MeetingParkFailure } from "../src/ports/meetingCloseout";
import type {
  ProposeKnowledgeApprovalPort,
  ProposeKnowledgeApprovalResult,
  ProposeKnowledgeApprovalError,
} from "../src/ports/sourceIngestion";
import {
  FakeCorrelatePort,
  FakeAgentJobPort,
  FakeValidatePort,
  FakeBuildOutputsPort,
  FakeCommitPort,
  FakeProposePort,
  FakeReindexPort,
  FakeMeetingHealthSink,
  makeMeetingContext,
} from "./support/meeting-fakes";
import { FakeClock, InMemoryWorkflowRunRepo } from "./support/fakes";

// --- fixtures ----------------------------------------------------------------
// Modeled on packages/workflows/test/meeting-closeout.test.ts's own fixtures
// (siblingPlan / SpyProposeKnowledgePort / makeInput / makeDeps / a park-port
// fake) rather than inventing new shapes — those helpers are declared LOCAL
// to that test file (not exported from a shared support module), and that
// file is outside this package's territory, so they are reproduced here
// rather than imported.

const WS = "ws-employer" as WorkspaceId;

function makeInput(partial: Partial<MeetingCloseoutInput> = {}): MeetingCloseoutInput {
  return {
    run: {
      workflowId: workflowId("wf-mc-inj-1"),
      trigger: "connector_event",
      idempotencyKey: "idem-run-mc-inj-1",
      workspaceId: WS,
    },
    context: makeMeetingContext(),
    ...partial,
  };
}

function makeDeps(overrides: Partial<MeetingCloseoutDeps> = {}): MeetingCloseoutDeps {
  return {
    correlate: new FakeCorrelatePort({ confidence: "high", workspaceId: WS }),
    agent: new FakeAgentJobPort({ result: "accepted" }),
    validate: new FakeValidatePort(),
    buildOutputs: new FakeBuildOutputsPort(),
    commit: new FakeCommitPort(),
    propose: new FakeProposePort(),
    reindex: new FakeReindexPort(),
    health: new FakeMeetingHealthSink(),
    park: new FakeMeetingParkPort(),
    runs: new InMemoryWorkflowRunRepo(),
    clock: new FakeClock(),
    ...overrides,
  };
}

class FakeMeetingParkPort implements MeetingParkPort {
  readonly calls: Array<{ source: SourceEnvelope; idempotencyKey: string }> = [];
  park(source: SourceEnvelope, idempotencyKey: string): Promise<Result<void, MeetingParkFailure>> {
    this.calls.push({ source, idempotencyKey });
    return Promise.resolve(ok(undefined));
  }
}

function siblingPlan(id: string, requiresApproval = true): KnowledgeMutationPlan {
  return {
    planId: planId(id),
    workspaceId: WS,
    sourceRefs: [],
    creates: [],
    patches: [],
    linkMutations: [],
    frontmatterUpdates: [],
    confidence: 1,
    requiresApproval,
    provenanceOrigin: "meeting_close",
  } as unknown as KnowledgeMutationPlan;
}

/** Always rejects the mint (`mint_failed`) — drives every sibling down the WITHHELD +
 *  health.surface branch, which is the only branch this package's two call sites cover. */
class AlwaysFailsProposeKnowledgePort implements ProposeKnowledgeApprovalPort {
  readonly calls: { readonly plan: KnowledgeMutationPlan; readonly workspaceId: WorkspaceId }[] = [];
  propose(
    plan: KnowledgeMutationPlan,
    ws: WorkspaceId,
  ): Promise<Result<ProposeKnowledgeApprovalResult, ProposeKnowledgeApprovalError>> {
    this.calls.push({ plan, workspaceId: ws });
    return Promise.resolve(err({ code: "mint_failed", message: "fake: propose always fails" }));
  }
}

// --- Case 1 --------------------------------------------------------------

describe("plan-id-injectivity — meetingCloseout", () => {
  it("two sibling plans sharing a planId still surface TWO DISTINCT health items (meetingCloseout)", async () => {
    // The exact constant binding apps/worker/test/composition/meeting-vault.test.ts:61 uses
    // today for `newPlanId` — proof a constant factory is not a hypothetical adversary.
    const SHARED_PLAN_ID = "plan-1";
    const health = new FakeMeetingHealthSink();
    const propose = new AlwaysFailsProposeKnowledgePort();
    const buildOutputs = new FakeBuildOutputsPort({
      siblingPlans: [siblingPlan(SHARED_PLAN_ID), siblingPlan(SHARED_PLAN_ID)],
    });

    const outcome = await runMeetingCloseout(
      makeInput(),
      makeDeps({ health, buildOutputs, proposeKnowledgeApproval: propose } as never),
    );

    expect(outcome.state).toBe("summarized"); // withheld siblings never fail the closeout
    expect(propose.calls).toHaveLength(2); // sanity: both siblings actually drove a propose attempt
    expect(health.surfaced).toHaveLength(2); // the spy RECORDS every call, not just the last

    const [first, second] = health.surfaced;
    expect(first?.subjectRef).toBeDefined();
    expect(second?.subjectRef).toBeDefined();
    // This is the load-bearing assertion: pre-fix, both composites were
    // `${workflowId}:plan-1` — identical — so the second call's `surface()` upserted
    // the same health-item row the first call created (the health store's PK is
    // `failureClass|subjectRef`) and the first sibling's failure was invisibly lost.
    expect(first?.subjectRef).not.toBe(second?.subjectRef);
  });

  // --- Case 3: positive control -------------------------------------------

  it("two sibling plans with DISTINCT planIds still yield distinct subjectRefs, each containing its own planId (positive control)", async () => {
    const health = new FakeMeetingHealthSink();
    const propose = new AlwaysFailsProposeKnowledgePort();
    const buildOutputs = new FakeBuildOutputsPort({
      siblingPlans: [siblingPlan("sib-alpha"), siblingPlan("sib-beta")],
    });

    const outcome = await runMeetingCloseout(
      makeInput(),
      makeDeps({ health, buildOutputs, proposeKnowledgeApproval: propose } as never),
    );

    expect(outcome.state).toBe("summarized");
    // Control identity: the spy itself is the control here. If it returned fewer than 2
    // calls, cases asserting "two distinct subjectRefs" above would vacuously pass (nothing
    // to compare) for the wrong reason. It returns exactly 2 (observed), confirming the spy
    // genuinely observes both propose attempts rather than silently swallowing one.
    expect(health.surfaced).toHaveLength(2);

    const [first, second] = health.surfaced;
    expect(first?.subjectRef).not.toBe(second?.subjectRef);
    // Per-plan legibility (24.58's own goal) survives the fix: each subjectRef still
    // names its own planId as a substring, not just an opaque ordinal.
    expect(first?.subjectRef).toContain("sib-alpha");
    expect(second?.subjectRef).toContain("sib-beta");
  });

  // --- Case 4: bounded length -----------------------------------------------

  it("a health-item subjectRef stays bounded regardless of planId length", async () => {
    const ABSURDLY_LONG_PLAN_ID = "x".repeat(4000);
    const health = new FakeMeetingHealthSink();
    const propose = new AlwaysFailsProposeKnowledgePort();
    const buildOutputs = new FakeBuildOutputsPort({
      siblingPlans: [siblingPlan(ABSURDLY_LONG_PLAN_ID)],
    });
    const input = makeInput();

    await runMeetingCloseout(
      input,
      makeDeps({ health, buildOutputs, proposeKnowledgeApproval: propose } as never),
    );

    expect(health.surfaced).toHaveLength(1);
    const subjectRef = health.surfaced[0]?.subjectRef ?? "";
    // Named bound, not a magic number: workflowId + ":" + ordinal ("0") + ":" +
    // (planId clipped to PLAN_ID_SUBJECT_REF_SEGMENT_MAX_LEN). Computed from the same
    // exported constant the production code clips with, so this pins the CONTRACT
    // (bounded regardless of input length) rather than one hardcoded number.
    const expectedMax =
      String(input.run.workflowId).length + 1 + String(0).length + 1 + PLAN_ID_SUBJECT_REF_SEGMENT_MAX_LEN;
    expect(subjectRef.length).toBeLessThanOrEqual(expectedMax);
    // Sanity: the bound is actually doing something — the raw planId alone (4000 chars)
    // is far longer than the bound, so this is not vacuously true because the input was
    // already short.
    expect(ABSURDLY_LONG_PLAN_ID.length).toBeGreaterThan(expectedMax);
  });

  // --- helper unit coverage ---------------------------------------------------

  it("planHealthSubjectRef is injective across ordinals for the identical planId (unit-level pin on the exported helper)", () => {
    const a = planHealthSubjectRef("wf-x", 0, "plan-1");
    const b = planHealthSubjectRef("wf-x", 1, "plan-1");
    expect(a).not.toBe(b);
  });

  it("planHealthSubjectRef clips the planId segment to the named bound", () => {
    const long = "y".repeat(PLAN_ID_SUBJECT_REF_SEGMENT_MAX_LEN + 500);
    const ref = planHealthSubjectRef("wf-x", 0, long);
    expect(ref).toBe(`wf-x:0:${long.slice(0, PLAN_ID_SUBJECT_REF_SEGMENT_MAX_LEN)}`);
    expect(ref.length).toBe("wf-x:0:".length + PLAN_ID_SUBJECT_REF_SEGMENT_MAX_LEN);
  });
});
