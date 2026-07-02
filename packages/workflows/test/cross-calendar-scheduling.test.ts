// spec(§9) — task 7.12 CROSS-CALENDAR SCHEDULING — the PURE orchestration driver.
//
// These tests drive `runCrossCalendarScheduling` (the pure driver) over in-memory
// activity-port FAKES + the foundation FakeClock + InMemoryWorkflowRunRepo. The
// driver imports NEITHER @temporalio NOR node:crypto and calls NO
// Date.now()/Math.random(), so it runs entirely in-memory with no Temporal server
// (root CLAUDE.md ★ two-layer split).
//
// The suite pins the 7.12 safety invariants (from the brief):
//   • unreachable calendar → typed failure (calendar_unreachable), NEVER treated as
//     free (REQ-F-009); a PARTIAL read of the bound source set is the same failure.
//   • private-personal auto-create allowed → event_created via the Tool Gateway.
//   • a shared/invite change routes to the Approval Inbox (7.9) — NOT auto-applied.
//   • generic conflict explanations only — a raw-content-shaped explanation is
//     refused at derivation (no raw detail leaks into a cross-workspace proposal).
//   • replay reuses the envelope → no duplicate event on a re-drive.
//   • EVERY failure/park branch surfaces a 7.5 health item (nothing silent).
import { describe, it, expect } from "vitest";
import { isOk, ok, err, actionId, planId, sourceId, workflowId } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  ProposedAction,
  ExternalWriteEnvelope,
  KnowledgeMutationPlan,
  WriteReceipt,
} from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { ExtractionField } from "@sow/domain";
import {
  runCrossCalendarScheduling,
  crossCalendarSchedulingMachine,
} from "../src/workflows/crossCalendarScheduling";
import type {
  CrossCalendarSchedulingInput,
  CrossCalendarSchedulingDeps,
} from "../src/workflows/crossCalendarScheduling";
import type {
  CrossCalendarSchedulingContext,
  GatherAvailabilityPort,
  GatheredAvailability,
  GatherAvailabilityError,
  GatherAvailabilityErrorCode,
  ProposeWindowsAgentPort,
  ProposedWindows,
  ProposeAgentFailure,
  ProposeAgentFailureCode,
  ValidateProposalPort,
  ValidatedProposal,
  ProposalValidationRejection,
  BuildSchedulingOutputsPort,
  SchedulingBuiltOutputs,
  BuildSchedulingFailure,
  BuildSchedulingFailureCode,
  ClassifyActionPort,
  SchedulingRoute,
  ClassifyActionError,
  AutoCreateEventPort,
  AutoCreateResult,
  AutoCreateError,
  AutoCreateErrorCode,
  RouteToApprovalPort,
  RouteToApprovalResult,
  RouteToApprovalError,
  RouteToApprovalErrorCode,
  CommitSchedulingNotePort,
  SchedulingCommitSuccess,
  SchedulingCommitFailure,
  SchedulingCommitFailureCode,
  SchedulingHealthSink,
  SchedulingWorkflowFailure,
  SchedulingSurfaceOutcome,
  SchedulingHealthSinkError,
} from "../src/ports/crossCalendarScheduling";
import { FakeClock, InMemoryWorkflowRunRepo } from "./support/fakes";

// --- fixtures --------------------------------------------------------------

const ORG_WS = "ws-personal" as WorkspaceId;
const SRC_A = "cal-personal";
const SRC_B = "cal-employer";

function makeContext(
  partial: Partial<CrossCalendarSchedulingContext> = {},
): CrossCalendarSchedulingContext {
  return {
    sources: [
      { sourceId: SRC_A, workspaceId: ORG_WS },
      { sourceId: SRC_B, workspaceId: "ws-employer" as WorkspaceId },
    ],
    organizerWorkspaceId: ORG_WS,
    ...partial,
  };
}

function makeInput(
  partial: Partial<CrossCalendarSchedulingInput> = {},
): CrossCalendarSchedulingInput {
  return {
    run: {
      workflowId: workflowId("wf-ccs-1"),
      trigger: "owner_action",
      idempotencyKey: "idem-run-ccs-1",
      workspaceId: ORG_WS,
    },
    context: makeContext(),
    ...partial,
  };
}

// --- fakes -----------------------------------------------------------------

/** Gather succeeds reading the FULL bound source set (default), OR fails typed, OR
 * returns a PARTIAL read (drops one source) to exercise the completeness guard. */
type FakeGatherConfig =
  | { kind: "ok" }
  | { kind: "partial" } // reads only SRC_A — SRC_B silently missing
  | { kind: "fail"; code: GatherAvailabilityErrorCode };

class FakeGatherPort implements GatherAvailabilityPort {
  readonly calls: CrossCalendarSchedulingContext[] = [];
  constructor(private readonly config: FakeGatherConfig = { kind: "ok" }) {}
  gather(
    ctx: CrossCalendarSchedulingContext,
  ): Promise<Result<GatheredAvailability, GatherAvailabilityError>> {
    this.calls.push(ctx);
    if (this.config.kind === "fail") {
      const error: GatherAvailabilityError = {
        code: this.config.code,
        message: `fake gather failure: ${this.config.code}`,
      };
      return Promise.resolve(err(error));
    }
    const readSources =
      this.config.kind === "partial"
        ? [SRC_A]
        : ctx.sources.map((s) => s.sourceId);
    const value: GatheredAvailability = {
      readSources,
      busyWindows: [
        { sourceId: SRC_A, start: "2026-07-02T09:00:00Z", end: "2026-07-02T10:00:00Z", genericReason: "busy" },
      ],
    };
    return Promise.resolve(ok(value));
  }
}

/** Default candidate: an evidence-backed organizer field + a TBD attendee note, so
 * the default proposal PASSES a real no-inference validator. */
function makeProposedWindows(partial: Partial<ProposedWindows> = {}): ProposedWindows {
  return {
    fields: {
      organizer: { value: "user", evidenceRef: "request#L1" } as ExtractionField<unknown>,
      attendeeNote: { value: TBD } as ExtractionField<unknown>,
    },
    windows: [{ start: "2026-07-02T14:00:00Z", end: "2026-07-02T15:00:00Z", genericExplanation: "no conflicts" }],
    schemaId: "sow:cross-calendar-proposal",
    ...partial,
  };
}

type FakeAgentConfig =
  | { result: "accepted"; proposal?: ProposedWindows }
  | { result: "rejected"; code?: ProposeAgentFailureCode };

class FakeAgentPort implements ProposeWindowsAgentPort {
  constructor(private readonly config: FakeAgentConfig = { result: "accepted" }) {}
  run(
    _ctx: CrossCalendarSchedulingContext,
  ): Promise<Result<ProposedWindows, ProposeAgentFailure>> {
    if (this.config.result === "accepted") {
      return Promise.resolve(ok(this.config.proposal ?? makeProposedWindows()));
    }
    const code = this.config.code ?? "provider_failed";
    return Promise.resolve(err({ code, message: `fake agent rejection: ${code}` }));
  }
}

/** Validate: passes through into a ValidatedProposal by default; force-rejects when
 * configured. (The deriver leakage-guard is what pins the generic-explanation rule,
 * so this fake is a plain gate — mirrors the meeting FakeValidatePort force-reject.) */
class FakeValidatePort implements ValidateProposalPort {
  constructor(private readonly config: { reject?: boolean } = {}) {}
  validate(
    proposal: ProposedWindows,
  ): Result<ValidatedProposal, ProposalValidationRejection> {
    if (this.config.reject === true) {
      return err({
        code: "no_inference_violation",
        message: "forced validation rejection",
        rejections: [],
      });
    }
    const validated: ValidatedProposal = {
      validated: true,
      fields: proposal.fields,
      windows: proposal.windows,
      ...(proposal.schemaId !== undefined ? { schemaId: proposal.schemaId } : {}),
    };
    return ok(validated);
  }
}

/** BuildOutputs: derives a calendar action from the validated proposal's FIRST window.
 * The action's approvalPolicy defaults to `auto_private` (private-personal path); pass
 * `sharedAction:true` to derive a shared/invite action (routes to approval). A
 * `failWith` forces a typed derivation failure. `leaky:true` derives a raw-content-
 * shaped explanation to prove the driver folds it (the real deriver refuses it). */
interface FakeBuildConfig {
  readonly failWith?: BuildSchedulingFailureCode;
  readonly sharedAction?: boolean;
  readonly withPlan?: boolean;
}

class FakeBuildPort implements BuildSchedulingOutputsPort {
  readonly calls: { validated: ValidatedProposal; workspaceId: WorkspaceId }[] = [];
  constructor(private readonly config: FakeBuildConfig = {}) {}
  build(
    validated: ValidatedProposal,
    workspaceId: WorkspaceId,
  ): Promise<Result<SchedulingBuiltOutputs, BuildSchedulingFailure>> {
    this.calls.push({ validated, workspaceId });
    if (this.config.failWith !== undefined) {
      return Promise.resolve(
        err({ code: this.config.failWith, message: `fake build failure: ${this.config.failWith}` }),
      );
    }
    const win = validated.windows[0];
    const idem = `idem-cal-${String(workspaceId)}-${win?.start ?? "x"}`;
    const action: ProposedAction = {
      actionId: actionId(idem),
      targetSystem: "calendar",
      canonicalObjectKey: `calendar:${String(workspaceId)}:${win?.start ?? "x"}`,
      payload: {
        start: win?.start,
        end: win?.end,
        genericExplanation: win?.genericExplanation ?? "no conflicts",
      },
      approvalPolicy: this.config.sharedAction === true ? "shared_invite" : "auto_private",
      idempotencyKey: idem,
    };
    const envelope: ExternalWriteEnvelope = {
      actionId: action.actionId,
      targetSystem: "calendar",
      canonicalObjectKey: action.canonicalObjectKey,
      idempotencyKey: idem,
      preconditions: [],
      payloadHash: `hash-${idem}`,
    };
    const plan: KnowledgeMutationPlan = {
      planId: planId(`plan-ccs-${String(workspaceId)}`),
      workspaceId,
      sourceRefs: [{ sourceId: sourceId("src-ccs-1") }],
      creates: [{ path: `calendar/${String(workspaceId)}/scheduled.md`, body: "scheduled", frontmatter: {} }],
      patches: [],
      linkMutations: [],
      frontmatterUpdates: [],
      externalActionProposals: [],
      confidence: 1,
      requiresApproval: false,
      provenanceOrigin: "ingestion",
    };
    const outputs: SchedulingBuiltOutputs =
      this.config.withPlan === true ? { action, envelope, plan } : { action, envelope };
    return Promise.resolve(ok(outputs));
  }
}

/** Classify: routes by the action's approvalPolicy — `auto_private` → auto_create,
 * anything else → route_to_approval (mirrors the real @sow/policy fail-closed rule).
 * `failWith` forces a classify error (the driver fails closed to approval). */
class FakeClassifyPort implements ClassifyActionPort {
  constructor(private readonly config: { failWith?: boolean } = {}) {}
  classify(
    action: ProposedAction,
    _ws: WorkspaceId,
  ): Promise<Result<SchedulingRoute, ClassifyActionError>> {
    if (this.config.failWith === true) {
      const error: ClassifyActionError = { code: "classify_failed", message: "forced classify failure" };
      return Promise.resolve(err(error));
    }
    const route: SchedulingRoute =
      action.approvalPolicy === "auto_private" ? "auto_create" : "route_to_approval";
    return Promise.resolve(ok(route));
  }
}

/** AutoCreate: envelope reuse by idempotencyKey (created once, reused on replay);
 * `failWith` forces a held/conflict/rejected (→ outbox_retry). */
class FakeAutoCreatePort implements AutoCreateEventPort {
  createCount = 0;
  private readonly byKey = new Map<string, WriteReceipt>();
  constructor(private readonly config: { failWith?: AutoCreateErrorCode } = {}) {}
  create(
    _action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<AutoCreateResult, AutoCreateError>> {
    if (this.config.failWith !== undefined) {
      return Promise.resolve(
        err({ code: this.config.failWith, message: `fake auto-create failure: ${this.config.failWith}` }),
      );
    }
    const key = env.idempotencyKey;
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      return Promise.resolve(ok({ status: "reused", envelope: { ...env, writeReceipt: existing } }));
    }
    this.createCount += 1;
    const receipt: WriteReceipt = {
      externalObjectId: `evt-${this.createCount}`,
      recordedAt: "2026-07-01T00:00:00.000Z",
    };
    this.byKey.set(key, receipt);
    return Promise.resolve(ok({ status: "created", envelope: { ...env, writeReceipt: receipt } }));
  }
}

/** RouteToApproval: records the pending action idempotently (created once, reused on
 * replay); `failWith` forces a typed route failure. NEVER performs the write. */
class FakeRoutePort implements RouteToApprovalPort {
  routeCount = 0;
  private readonly byKey = new Map<string, string>();
  constructor(private readonly config: { failWith?: RouteToApprovalErrorCode } = {}) {}
  route(
    _action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<RouteToApprovalResult, RouteToApprovalError>> {
    if (this.config.failWith !== undefined) {
      return Promise.resolve(
        err({ code: this.config.failWith, message: `fake route failure: ${this.config.failWith}` }),
      );
    }
    const key = env.idempotencyKey;
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      return Promise.resolve(ok({ approvalRef: existing, created: false }));
    }
    this.routeCount += 1;
    const approvalRef = `apr-${this.routeCount}`;
    this.byKey.set(key, approvalRef);
    return Promise.resolve(ok({ approvalRef, created: true }));
  }
}

/** Optional commit: idempotent by planId; `failWith` forces a commit failure. */
class FakeCommitPort implements CommitSchedulingNotePort {
  writeCount = 0;
  private readonly byKey = new Map<string, string>();
  constructor(private readonly config: { failWith?: SchedulingCommitFailureCode } = {}) {}
  commit(
    plan: KnowledgeMutationPlan,
  ): Promise<Result<SchedulingCommitSuccess, SchedulingCommitFailure>> {
    if (this.config.failWith !== undefined) {
      return Promise.resolve(
        err({ code: this.config.failWith, message: `fake commit failure: ${this.config.failWith}` }),
      );
    }
    const key = String(plan.planId);
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      return Promise.resolve(ok({ revisionId: existing, replayed: true }));
    }
    this.writeCount += 1;
    const revisionId = `rev-${this.writeCount}`;
    this.byKey.set(key, revisionId);
    return Promise.resolve(ok({ revisionId, replayed: false }));
  }
}

class FakeHealthSink implements SchedulingHealthSink {
  readonly surfaced: SchedulingWorkflowFailure[] = [];
  surface(
    failure: SchedulingWorkflowFailure,
  ): Promise<Result<SchedulingSurfaceOutcome, SchedulingHealthSinkError>> {
    this.surfaced.push(failure);
    return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
  }
}

/** All-green dep set; override any port per test. */
function makeDeps(
  overrides: Partial<CrossCalendarSchedulingDeps> = {},
): CrossCalendarSchedulingDeps {
  return {
    gather: new FakeGatherPort(),
    agent: new FakeAgentPort(),
    validate: new FakeValidatePort(),
    buildOutputs: new FakeBuildPort(),
    classify: new FakeClassifyPort(),
    autoCreate: new FakeAutoCreatePort(),
    routeToApproval: new FakeRoutePort(),
    health: new FakeHealthSink(),
    runs: new InMemoryWorkflowRunRepo(),
    clock: new FakeClock(),
    ...overrides,
  };
}

// --- happy path: private-personal auto-create ------------------------------

describe("runCrossCalendarScheduling — private-personal auto-create", () => {
  it("drives requested → … → scheduled, auto-creating a private event exactly once", async () => {
    const autoCreate = new FakeAutoCreatePort();
    const route = new FakeRoutePort();
    const deps = makeDeps({ autoCreate, routeToApproval: route });

    const outcome = await runCrossCalendarScheduling(makeInput(), deps);

    expect(outcome.state).toBe("scheduled");
    expect(outcome.route).toBe("auto_create");
    expect(autoCreate.createCount).toBe(1);
    // A private auto-create NEVER routes to the approval inbox.
    expect(route.routeCount).toBe(0);
    expect(outcome.context.envelope?.writeReceipt).toBeDefined();
  });

  it("resolves the run idempotently through the foundation seam (reused on a seen key)", async () => {
    const runs = new InMemoryWorkflowRunRepo();
    const first = await runCrossCalendarScheduling(makeInput(), makeDeps({ runs }));
    expect(isOk(first.run)).toBe(true);
    const second = await runCrossCalendarScheduling(makeInput(), makeDeps({ runs }));
    expect(second.runReused).toBe(true);
  });
});

// --- REQ-F-009: unreachable / partial calendar → typed failure, never free -

describe("runCrossCalendarScheduling — availability completeness (REQ-F-009)", () => {
  it("an UNREACHABLE calendar source → calendar_unreachable (never treated as free), NO propose/create", async () => {
    const agent = new FakeAgentPort();
    const autoCreate = new FakeAutoCreatePort();
    const health = new FakeHealthSink();
    const gather = new FakeGatherPort({ kind: "fail", code: "calendar_unreachable" });
    const deps = makeDeps({ gather, agent, autoCreate, health });

    const outcome = await runCrossCalendarScheduling(makeInput(), deps);

    expect(outcome.state).toBe("calendar_unreachable");
    // The pipeline HARD-STOPS: no window is proposed over an unread calendar, no event.
    expect(autoCreate.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
    expect(health.surfaced[0]?.failureClass).toBe("connector_unreachable");
  });

  it("a PARTIAL read of the bound source set is the SAME failure — an omitted source is never assumed free", async () => {
    const autoCreate = new FakeAutoCreatePort();
    const health = new FakeHealthSink();
    // Two bound sources but the gather only reads one (SRC_B silently missing).
    const gather = new FakeGatherPort({ kind: "partial" });
    const deps = makeDeps({ gather, autoCreate, health });

    const outcome = await runCrossCalendarScheduling(makeInput(), deps);

    expect(outcome.state).toBe("calendar_unreachable");
    expect(autoCreate.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("a GCL gate rejection (raw event detail present) also folds to calendar_unreachable", async () => {
    const health = new FakeHealthSink();
    const gather = new FakeGatherPort({ kind: "fail", code: "gate_rejected" });
    const deps = makeDeps({ gather, health });

    const outcome = await runCrossCalendarScheduling(makeInput(), deps);

    expect(outcome.state).toBe("calendar_unreachable");
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- shared/invite change → routes to the 7.9 Approval Inbox ---------------

describe("runCrossCalendarScheduling — shared change routes to approval (7.9)", () => {
  it("a shared/invite action ROUTES to the Approval Inbox — NOT auto-applied", async () => {
    const autoCreate = new FakeAutoCreatePort();
    const route = new FakeRoutePort();
    const health = new FakeHealthSink();
    const deps = makeDeps({
      buildOutputs: new FakeBuildPort({ sharedAction: true }),
      autoCreate,
      routeToApproval: route,
      health,
    });

    const outcome = await runCrossCalendarScheduling(makeInput(), deps);

    expect(outcome.state).toBe("approval_pending");
    expect(outcome.route).toBe("route_to_approval");
    expect(outcome.approvalRef).toBeDefined();
    // NEVER auto-applied: no external event was created.
    expect(autoCreate.createCount).toBe(0);
    expect(route.routeCount).toBe(1);
    // approval-pending is a typed state → 7.5 health item.
    expect(health.surfaced).toHaveLength(1);
    expect(health.surfaced[0]?.failureClass).toBe("conflict_review");
  });

  it("a classify FAILURE fails closed to approval routing (never auto-creates)", async () => {
    const autoCreate = new FakeAutoCreatePort();
    const route = new FakeRoutePort();
    const deps = makeDeps({
      classify: new FakeClassifyPort({ failWith: true }),
      autoCreate,
      routeToApproval: route,
    });

    const outcome = await runCrossCalendarScheduling(makeInput(), deps);

    expect(outcome.state).toBe("approval_pending");
    expect(autoCreate.createCount).toBe(0);
    expect(route.routeCount).toBe(1);
  });
});

// --- broker rejection → provider_failed ------------------------------------

describe("runCrossCalendarScheduling — broker rejection", () => {
  it("a propose-agent rejection → provider_failed, NO create, surfaces a health item", async () => {
    const autoCreate = new FakeAutoCreatePort();
    const health = new FakeHealthSink();
    const code: ProposeAgentFailureCode = "admission_rejected";
    const deps = makeDeps({
      agent: new FakeAgentPort({ result: "rejected", code }),
      autoCreate,
      health,
    });

    const outcome = await runCrossCalendarScheduling(makeInput(), deps);

    expect(outcome.state).toBe("provider_failed");
    expect(autoCreate.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- validator / derivation rejection → schema_rejected --------------------

describe("runCrossCalendarScheduling — validation / derivation rejection", () => {
  it("a validator rejection → schema_rejected, NO derivation, NO create", async () => {
    const build = new FakeBuildPort();
    const autoCreate = new FakeAutoCreatePort();
    const health = new FakeHealthSink();
    const deps = makeDeps({
      validate: new FakeValidatePort({ reject: true }),
      buildOutputs: build,
      autoCreate,
      health,
    });

    const outcome = await runCrossCalendarScheduling(makeInput(), deps);

    expect(outcome.state).toBe("schema_rejected");
    // NO partial side effect: buildOutputs never ran, no event created.
    expect(build.calls).toHaveLength(0);
    expect(autoCreate.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("a derivation failure → schema_rejected, NO create", async () => {
    const autoCreate = new FakeAutoCreatePort();
    const failWith: BuildSchedulingFailureCode = "unmappable_proposal";
    const deps = makeDeps({
      buildOutputs: new FakeBuildPort({ failWith }),
      autoCreate,
    });

    const outcome = await runCrossCalendarScheduling(makeInput(), deps);

    expect(outcome.state).toBe("schema_rejected");
    expect(autoCreate.createCount).toBe(0);
  });
});

// --- generic conflict explanation only (no raw detail leak) ----------------

describe("runCrossCalendarScheduling — generic explanation only (Flow 3)", () => {
  it("[deriver] a raw-content-shaped (multi-line) conflict explanation is REFUSED at derivation", async () => {
    // Exercise the REAL deriver's leakage guard: a projection that emits a multi-line
    // explanation folds to a typed build failure the driver maps to schema_rejected.
    const { createProposeWindowsActivity } = await import("../src/activities/proposeWindows");
    const { isGenericExplanation } = await import("../src/activities/proposeWindows");

    // Sanity: a multi-line string is NOT a generic explanation.
    expect(isGenericExplanation("line1\nline2 — raw meeting title")).toBe(false);
    expect(isGenericExplanation("conflicts with a busy block")).toBe(true);

    const port = createProposeWindowsActivity({
      projection: {
        project: () =>
          ok({
            action: {
              targetSystem: "calendar",
              canonicalIdentity: { slot: "s" },
              operation: "calendar.create",
              idempotencyIdentity: { slot: "s" },
              payload: { start: "x", end: "y" },
              approvalPolicy: "auto_private",
              payloadHash: "h",
              preconditions: [],
              // RAW-content-shaped: a leaked multi-line event body/title.
              genericExplanation: "Sync with Acme re: Q3 contract\nAttendees: alice@acme, bob@acme",
            },
          }),
      },
      sourceRef: { sourceId: sourceId("src-ccs-1") },
      planIdentity: { run: "1" },
    });

    const validated: ValidatedProposal = { validated: true, fields: {}, windows: [] };
    const built = await port.build(validated, ORG_WS);
    expect(isOk(built)).toBe(false);
  });

  it("[deriver] raw cross-workspace detail in the DISPATCHED payload is REFUSED even when genericExplanation is clean", async () => {
    // REGRESSION (C2 leakage): the load-bearing leakage guard must run over the
    // ACTUALLY-DISPATCHED action.payload, NOT the decoy `genericExplanation`
    // descriptor field (which is never copied into the dispatched artifact). Here the
    // decoy field is a clean single-line string, but the payload carries raw
    // cross-workspace content (a multi-line employer conflict title). The prior guard
    // — which only inspected `genericExplanation` — let this ride straight through the
    // Tool Gateway onto the external calendar event. The fix must fail-closed.
    const { createProposeWindowsActivity } = await import("../src/activities/proposeWindows");
    const port = createProposeWindowsActivity({
      projection: {
        project: () =>
          ok({
            action: {
              targetSystem: "calendar",
              canonicalIdentity: { slot: "s" },
              operation: "calendar.create",
              idempotencyIdentity: { slot: "s" },
              // DISPATCHED payload carries RAW cross-workspace detail — a leaked
              // multi-line employer meeting title/body that must NOT egress.
              payload: {
                start: "2026-07-02T14:00:00Z",
                end: "2026-07-02T15:00:00Z",
                conflictDetail:
                  "Acme M&A war-room: Project Falcon\nAttendees: cfo@acme, gc@acme\nRe: undisclosed acquisition terms",
              },
              approvalPolicy: "auto_private",
              payloadHash: "h",
              preconditions: [],
              // DECOY field is CLEAN — the old guard would have passed this.
              genericExplanation: "no conflicts",
            },
          }),
      },
      sourceRef: { sourceId: sourceId("src-ccs-1") },
      planIdentity: { run: "1" },
    });

    const validated: ValidatedProposal = { validated: true, fields: {}, windows: [] };
    const built = await port.build(validated, ORG_WS);
    // Fail-closed: raw content in the dispatched payload → rejected, NOT dispatched.
    expect(isOk(built)).toBe(false);
  });

  it("[deriver] a clean dispatched payload (generic fields only) passes and dispatches", async () => {
    // The generic path: a payload built from only whitelisted/generic single-line
    // fields carries no raw content → ok + dispatches.
    const { createProposeWindowsActivity } = await import("../src/activities/proposeWindows");
    const port = createProposeWindowsActivity({
      projection: {
        project: () =>
          ok({
            action: {
              targetSystem: "calendar",
              canonicalIdentity: { slot: "s" },
              operation: "calendar.create",
              idempotencyIdentity: { slot: "s" },
              payload: {
                start: "2026-07-02T14:00:00Z",
                end: "2026-07-02T15:00:00Z",
                genericExplanation: "conflicts with a busy block",
              },
              approvalPolicy: "auto_private",
              payloadHash: "h",
              preconditions: [],
              genericExplanation: "conflicts with a busy block",
            },
          }),
      },
      sourceRef: { sourceId: sourceId("src-ccs-1") },
      planIdentity: { run: "1" },
    });

    const validated: ValidatedProposal = { validated: true, fields: {}, windows: [] };
    const built = await port.build(validated, ORG_WS);
    expect(isOk(built)).toBe(true);
    if (isOk(built)) {
      expect(built.value.action.targetSystem).toBe("calendar");
    }
  });

  it("[deriver] a short single-line generic explanation passes and stamps the BOUND workspace", async () => {
    const { createProposeWindowsActivity } = await import("../src/activities/proposeWindows");
    const boundWs = "ws-correlation-bound" as WorkspaceId;
    const port = createProposeWindowsActivity({
      projection: {
        project: (_v, ws) =>
          ok({
            action: {
              targetSystem: "calendar",
              canonicalIdentity: { slot: "s" },
              operation: "calendar.create",
              idempotencyIdentity: { slot: "s" },
              payload: { start: "x", end: "y", genericExplanation: "no conflicts" },
              approvalPolicy: "auto_private",
              payloadHash: "h",
              preconditions: [],
              genericExplanation: "no conflicts",
            },
            note: { path: `calendar/${String(ws)}/scheduled.md`, body: "scheduled", frontmatter: {} },
          }),
      },
      sourceRef: { sourceId: sourceId("src-ccs-1") },
      planIdentity: { run: "1" },
    });

    const validated: ValidatedProposal = { validated: true, fields: {}, windows: [] };
    const built = await port.build(validated, boundWs);
    expect(isOk(built)).toBe(true);
    if (isOk(built)) {
      // WS-2/WS-4: the derived plan targets the BOUND workspace, never a caller value.
      expect(built.value.plan?.workspaceId).toBe(boundWs);
      expect(built.value.action.targetSystem).toBe("calendar");
    }
  });
});

// --- auto-create held → outbox_retry ---------------------------------------

describe("runCrossCalendarScheduling — auto-create held", () => {
  it("a held/conflict/rejected auto-create → outbox_retry (non-terminal), surfaces a health item", async () => {
    const failWith: AutoCreateErrorCode = "held";
    const health = new FakeHealthSink();
    const deps = makeDeps({
      autoCreate: new FakeAutoCreatePort({ failWith }),
      health,
    });

    const outcome = await runCrossCalendarScheduling(makeInput(), deps);

    expect(outcome.state).toBe("outbox_retry");
    expect(outcome.route).toBe("auto_create");
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- REPLAY safety: re-drive reuses the envelope (no duplicate event) -------

describe("runCrossCalendarScheduling — replay safety (LIFE-3)", () => {
  it("re-drives from the start with NO duplicate external event (envelope reused)", async () => {
    const autoCreate = new FakeAutoCreatePort();
    const runs = new InMemoryWorkflowRunRepo();

    const first = await runCrossCalendarScheduling(makeInput(), makeDeps({ autoCreate, runs }));
    expect(first.state).toBe("scheduled");
    expect(autoCreate.createCount).toBe(1);

    // Simulate a restart: re-drive the WHOLE pipeline with fresh read-stage fakes but
    // the SAME durable auto-create/runs.
    const second = await runCrossCalendarScheduling(makeInput(), makeDeps({ autoCreate, runs }));
    expect(second.state).toBe("scheduled");
    // The external event happened exactly once across both drives.
    expect(autoCreate.createCount).toBe(1);
    expect(second.runReused).toBe(true);
    expect(second.context.envelope?.writeReceipt?.externalObjectId).toBe("evt-1");
  });
});

// --- optional note commit does NOT roll the event back ---------------------

describe("runCrossCalendarScheduling — optional scheduling-note commit", () => {
  it("a note-commit failure surfaces a health item but the event STANDS (scheduled)", async () => {
    const autoCreate = new FakeAutoCreatePort();
    const health = new FakeHealthSink();
    const deps = makeDeps({
      buildOutputs: new FakeBuildPort({ withPlan: true }),
      commit: new FakeCommitPort({ failWith: "write_conflict" }),
      autoCreate,
      health,
    });

    const outcome = await runCrossCalendarScheduling(makeInput(), deps);

    // The event was created; the note-commit failure does NOT roll it back.
    expect(outcome.state).toBe("scheduled");
    expect(autoCreate.createCount).toBe(1);
    // The commit failure IS surfaced (nothing silent).
    expect(health.surfaced).toHaveLength(1);
    expect(health.surfaced[0]?.message).toContain("scheduling-note commit failed");
  });

  it("commits the scheduling note on the happy path when a plan is derived", async () => {
    const commit = new FakeCommitPort();
    const deps = makeDeps({
      buildOutputs: new FakeBuildPort({ withPlan: true }),
      commit,
    });

    const outcome = await runCrossCalendarScheduling(makeInput(), deps);

    expect(outcome.state).toBe("scheduled");
    expect(commit.writeCount).toBe(1);
  });
});

// --- inv-5: every failure branch surfaces a health item --------------------

describe("runCrossCalendarScheduling — nothing fails silently (inv-5)", () => {
  it("every failure/park branch routes through the health sink", async () => {
    const branches: Array<Partial<CrossCalendarSchedulingDeps>> = [
      { gather: new FakeGatherPort({ kind: "fail", code: "calendar_unreachable" }) },
      { agent: new FakeAgentPort({ result: "rejected" }) },
      { validate: new FakeValidatePort({ reject: true }) },
      { buildOutputs: new FakeBuildPort({ failWith: "build_failed" }) },
      { buildOutputs: new FakeBuildPort({ sharedAction: true }) }, // → approval_pending
      { autoCreate: new FakeAutoCreatePort({ failWith: "rejected" }) }, // → outbox_retry
    ];
    for (const override of branches) {
      const health = new FakeHealthSink();
      await runCrossCalendarScheduling(makeInput(), makeDeps({ ...override, health }));
      expect(health.surfaced.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// --- the local state machine is well-formed --------------------------------

describe("crossCalendarSchedulingMachine — total + happy path is legal", () => {
  it("only `scheduled` is terminal; the happy edges are all legal", () => {
    expect(crossCalendarSchedulingMachine.isTerminal("scheduled")).toBe(true);
    const happy = [
      ["requested", "availability_gathered"],
      ["availability_gathered", "proposed"],
      ["proposed", "validated"],
      ["validated", "outputs_built"],
      ["outputs_built", "event_created"],
      ["event_created", "scheduled"],
    ] as const;
    for (const [from, to] of happy) {
      expect(crossCalendarSchedulingMachine.canTransition(from, to)).toBe(true);
    }
    // A skipped-gate edge is illegal (no requested → scheduled teleport).
    expect(crossCalendarSchedulingMachine.canTransition("requested", "scheduled")).toBe(false);
  });
});
