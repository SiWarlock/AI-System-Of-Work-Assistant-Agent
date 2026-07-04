// spec(§20.1 "Cross-calendar scheduling" · REQ-F-009 · WS-8) — task 12.9.
//
// §20.1 ACCEPTANCE suite for cross-calendar scheduling scheduling-safety. Unlike the
// packages/workflows unit test (packages/workflows/test/cross-calendar-scheduling.test.ts),
// which pins the driver's per-branch mechanics + machine adjacency, this suite drives
// the REAL @sow/workflows cross-calendar scheduling code end-to-end to assert the three
// §20.1 acceptance BULLETS, then SCORES the `CROSS_CALENDAR_SCHEDULING` criterion
// through the EVAL-1 runner (task 12.1).
//
// It exercises real code (not just the harness):
//   • runCrossCalendarScheduling — the PURE replay-safe scheduling driver
//     (src/workflows/crossCalendarScheduling.ts), over inline activity-port fakes +
//     an inline in-memory WorkflowRun repo + FakeClock (pure literals, no clock/RNG).
//   • createProposeWindowsActivity / isGenericExplanation / payloadCarriesRawContent —
//     the REAL deriver + its load-bearing Flow-3 leakage guards
//     (src/activities/proposeWindows.ts).
//   • crossCalendarSchedulingMachine — the real §9 state machine.
//
// §20.1 acceptance bullets exercised (task 12.9):
//   (a) scheduling respects ALL configured availability sources across calendars: a
//       doctor-appointment flow (personal-life scope) reading its OWN calendar + an
//       employer WORK calendar + a personal-business SIDE-PROJECT calendar auto-creates
//       the private event only when the busy/free of ALL THREE was read; dropping the
//       WORK or the SIDE-PROJECT source HARD-STOPS (never schedules over an unread
//       calendar — REQ-F-009).
//   (b) proposals carry only GENERIC conflict explanations — NO raw work/cross-workspace
//       detail leaks (WS-8 / Flow 3): the real deriver refuses a raw-content-shaped
//       explanation AND a raw-content-shaped DISPATCHED payload, even when the decoy
//       descriptor field is clean.
//   (c) insufficient availability metadata yields a TYPED failure, not a silent bad
//       slot: an unreachable / partial / gate-rejected gather folds to the typed
//       `calendar_unreachable` state, surfaces a System-Health item, and creates NO
//       event (never a silently-chosen bad slot).
//
// DoD honesty: CROSS_CALENDAR_SCHEDULING is `requiresRealIntegration:false` — the
// deterministic driver + leakage guards ARE the real code path (no vendor/provider
// needed), so a mock-backed run is BOTH functionally- AND DoD-passing (the runner's
// dodValid holds because no real integration is required). This is asserted below.
import { describe, it, expect } from "vitest";
import { isOk, ok, err, actionId, planId, sourceId, workflowId } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  WorkflowRunRef,
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
} from "@sow/workflows/workflows/crossCalendarScheduling";
import type {
  CrossCalendarSchedulingInput,
  CrossCalendarSchedulingDeps,
} from "@sow/workflows/workflows/crossCalendarScheduling";
import {
  createProposeWindowsActivity,
  isGenericExplanation,
  payloadCarriesRawContent,
} from "@sow/workflows/activities/proposeWindows";
import type {
  CrossCalendarSchedulingContext,
  GatherAvailabilityPort,
  GatheredAvailability,
  GatherAvailabilityError,
  GatherAvailabilityErrorCode,
  ProposeWindowsAgentPort,
  ProposedWindows,
  ProposeAgentFailure,
  ValidateProposalPort,
  ValidatedProposal,
  ProposalValidationRejection,
  BuildSchedulingOutputsPort,
  SchedulingBuiltOutputs,
  BuildSchedulingFailure,
  ClassifyActionPort,
  SchedulingRoute,
  ClassifyActionError,
  AutoCreateEventPort,
  AutoCreateResult,
  AutoCreateError,
  RouteToApprovalPort,
  RouteToApprovalResult,
  RouteToApprovalError,
  SchedulingHealthSink,
  SchedulingWorkflowFailure,
  SchedulingSurfaceOutcome,
  SchedulingHealthSinkError,
} from "@sow/workflows/ports/crossCalendarScheduling";
import type {
  Clock,
  WorkflowRunRefRepository,
  DbError,
  DbResult,
} from "@sow/workflows/ports/operational";
import { scoreById, type EvalOutcome } from "../../src/harness/runner";
import { criterionById } from "../../src/harness/criteria-registry";

const CRITERION_ID = "CROSS_CALENDAR_SCHEDULING";

// --- fixtures: a doctor-appointment flow reading THREE calendars -------------
//
// The organizer scope is personal-life; it must read its own calendar PLUS the
// employer WORK calendar PLUS a personal-business SIDE-PROJECT calendar so the chosen
// slot avoids a work meeting AND a side-project block (REQ-F-009 reads across all).
const ORG_WS = "ws-personal-life" as WorkspaceId;
const SRC_PERSONAL = "cal-personal";
const SRC_WORK = "cal-employer";
const SRC_SIDE = "cal-side-project";

const BOUND_SOURCES: readonly { sourceId: string; workspaceId: WorkspaceId }[] = [
  { sourceId: SRC_PERSONAL, workspaceId: ORG_WS },
  { sourceId: SRC_WORK, workspaceId: "ws-employer" as WorkspaceId },
  { sourceId: SRC_SIDE, workspaceId: "ws-side" as WorkspaceId },
];

function makeContext(
  partial: Partial<CrossCalendarSchedulingContext> = {},
): CrossCalendarSchedulingContext {
  return {
    sources: BOUND_SOURCES.map((s) => ({ ...s })),
    organizerWorkspaceId: ORG_WS,
    ...partial,
  };
}

function makeInput(
  partial: Partial<CrossCalendarSchedulingInput> = {},
): CrossCalendarSchedulingInput {
  return {
    run: {
      workflowId: workflowId("wf-ccs-accept-1"),
      trigger: "owner_action",
      idempotencyKey: "idem-ccs-accept-1",
      workspaceId: ORG_WS,
    },
    context: makeContext(),
    ...partial,
  };
}

// --- inline foundation fakes (replicated; pure literals, no Date.now/RNG) -----

class FakeClock implements Clock {
  now(): string {
    return "2026-07-04T00:00:00.000Z";
  }
  monotonicMs(): number {
    return 0;
  }
  monotonicEpoch(): string {
    return "boot-accept-1";
  }
}

const dbConflict = (message: string): DbError => ({ code: "conflict", message });
const dbNotFound = (message: string): DbError => ({ code: "not_found", message });

class InMemoryWorkflowRunRepo implements WorkflowRunRefRepository {
  private readonly byId = new Map<string, WorkflowRunRef>();

  create(ref: WorkflowRunRef): DbResult<WorkflowRunRef> {
    if (this.byId.has(ref.workflowId)) {
      return Promise.resolve(err(dbConflict(`workflow run already exists: ${ref.workflowId}`)));
    }
    for (const existing of this.byId.values()) {
      if (existing.idempotencyKey === ref.idempotencyKey) {
        return Promise.resolve(
          err(dbConflict(`workflow run already exists for idempotency key: ${ref.idempotencyKey}`)),
        );
      }
    }
    this.byId.set(ref.workflowId, ref);
    return Promise.resolve(ok(ref));
  }

  get(id: WorkflowRunRef["workflowId"]): DbResult<WorkflowRunRef> {
    const found = this.byId.get(id);
    return Promise.resolve(found === undefined ? err(dbNotFound(`no workflow run: ${id}`)) : ok(found));
  }

  getByIdempotencyKey(idempotencyKey: WorkflowRunRef["idempotencyKey"]): DbResult<WorkflowRunRef> {
    for (const ref of this.byId.values()) {
      if (ref.idempotencyKey === idempotencyKey) return Promise.resolve(ok(ref));
    }
    return Promise.resolve(err(dbNotFound(`no workflow run for idempotency key: ${idempotencyKey}`)));
  }

  updateState(
    id: WorkflowRunRef["workflowId"],
    state: WorkflowRunRef["state"],
  ): DbResult<WorkflowRunRef> {
    const found = this.byId.get(id);
    if (found === undefined) return Promise.resolve(err(dbNotFound(`no workflow run: ${id}`)));
    const next: WorkflowRunRef = { ...found, state };
    this.byId.set(id, next);
    return Promise.resolve(ok(next));
  }

  appendAuditRef(
    id: WorkflowRunRef["workflowId"],
    auditRef: WorkflowRunRef["auditRefs"][number],
  ): DbResult<WorkflowRunRef> {
    const found = this.byId.get(id);
    if (found === undefined) return Promise.resolve(err(dbNotFound(`no workflow run: ${id}`)));
    const next: WorkflowRunRef = { ...found, auditRefs: [...found.auditRefs, auditRef] };
    this.byId.set(id, next);
    return Promise.resolve(ok(next));
  }
}

// --- inline activity-port fakes ---------------------------------------------

/** Gather reads the FULL bound source set (default), OR drops a named source
 * (partial read → completeness guard trips), OR fails typed. The busy windows model
 * a WORK conflict + a SIDE-PROJECT conflict so a scheduled slot demonstrably avoids
 * both. Records the ctx it saw so the suite can assert ALL sources were presented. */
type FakeGatherConfig =
  | { kind: "ok" }
  | { kind: "partial"; drop: string }
  | { kind: "fail"; code: GatherAvailabilityErrorCode };

class FakeGatherPort implements GatherAvailabilityPort {
  readonly calls: CrossCalendarSchedulingContext[] = [];
  constructor(private readonly config: FakeGatherConfig = { kind: "ok" }) {}
  gather(
    ctx: CrossCalendarSchedulingContext,
  ): Promise<Result<GatheredAvailability, GatherAvailabilityError>> {
    this.calls.push(ctx);
    if (this.config.kind === "fail") {
      return Promise.resolve(
        err({ code: this.config.code, message: `fake gather failure: ${this.config.code}` }),
      );
    }
    const drop = this.config.kind === "partial" ? this.config.drop : undefined;
    const readSources = ctx.sources.map((s) => s.sourceId).filter((id) => id !== drop);
    const value: GatheredAvailability = {
      readSources,
      // SANITIZED busy/free only — a generic reason, never a raw work/side title.
      busyWindows: [
        { sourceId: SRC_WORK, start: "2026-07-06T09:00:00Z", end: "2026-07-06T10:00:00Z", genericReason: "busy" },
        { sourceId: SRC_SIDE, start: "2026-07-06T18:00:00Z", end: "2026-07-06T19:00:00Z", genericReason: "tentative" },
      ],
    };
    return Promise.resolve(ok(value));
  }
}

function makeProposedWindows(): ProposedWindows {
  return {
    fields: {
      organizer: { value: "user", evidenceRef: "request#L1" } as ExtractionField<unknown>,
      attendeeNote: { value: TBD } as ExtractionField<unknown>,
    },
    // A slot that avoids BOTH the work (09:00) and side-project (18:00) busy windows.
    windows: [
      { start: "2026-07-06T14:00:00Z", end: "2026-07-06T15:00:00Z", genericExplanation: "no conflicts" },
    ],
    schemaId: "sow:cross-calendar-proposal",
  };
}

class FakeAgentPort implements ProposeWindowsAgentPort {
  run(
    _ctx: CrossCalendarSchedulingContext,
  ): Promise<Result<ProposedWindows, ProposeAgentFailure>> {
    return Promise.resolve(ok(makeProposedWindows()));
  }
}

class FakeValidatePort implements ValidateProposalPort {
  validate(
    proposal: ProposedWindows,
  ): Result<ValidatedProposal, ProposalValidationRejection> {
    const validated: ValidatedProposal = {
      validated: true,
      fields: proposal.fields,
      windows: proposal.windows,
      ...(proposal.schemaId !== undefined ? { schemaId: proposal.schemaId } : {}),
    };
    return ok(validated);
  }
}

/** Derives a calendar action from the validated FIRST window. `auto_private` by
 * default (the sole Flow-3 auto-create path); `sharedAction:true` derives a shared
 * change that must route to approval. The payload carries ONLY a generic explanation. */
class FakeBuildPort implements BuildSchedulingOutputsPort {
  constructor(private readonly config: { sharedAction?: boolean } = {}) {}
  build(
    validated: ValidatedProposal,
    workspaceId: WorkspaceId,
  ): Promise<Result<SchedulingBuiltOutputs, BuildSchedulingFailure>> {
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
    return Promise.resolve(ok({ action, envelope, plan }));
  }
}

class FakeClassifyPort implements ClassifyActionPort {
  classify(
    action: ProposedAction,
    _ws: WorkspaceId,
  ): Promise<Result<SchedulingRoute, ClassifyActionError>> {
    const route: SchedulingRoute =
      action.approvalPolicy === "auto_private" ? "auto_create" : "route_to_approval";
    return Promise.resolve(ok(route));
  }
}

class FakeAutoCreatePort implements AutoCreateEventPort {
  createCount = 0;
  private readonly byKey = new Map<string, WriteReceipt>();
  create(
    _action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<AutoCreateResult, AutoCreateError>> {
    const existing = this.byKey.get(env.idempotencyKey);
    if (existing !== undefined) {
      return Promise.resolve(ok({ status: "reused", envelope: { ...env, writeReceipt: existing } }));
    }
    this.createCount += 1;
    const receipt: WriteReceipt = { externalObjectId: `evt-${this.createCount}`, recordedAt: "2026-07-04T00:00:00.000Z" };
    this.byKey.set(env.idempotencyKey, receipt);
    return Promise.resolve(ok({ status: "created", envelope: { ...env, writeReceipt: receipt } }));
  }
}

class FakeRoutePort implements RouteToApprovalPort {
  routeCount = 0;
  route(
    _action: ProposedAction,
    _env: ExternalWriteEnvelope,
  ): Promise<Result<RouteToApprovalResult, RouteToApprovalError>> {
    this.routeCount += 1;
    return Promise.resolve(ok({ approvalRef: `apr-${this.routeCount}`, created: true }));
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

// ===========================================================================
// (a) scheduling respects ALL configured availability sources across calendars
// ===========================================================================

describe("calendar-conflict — respects ALL availability sources (§20.1 · REQ-F-009)", () => {
  it("a doctor-appt flow that reads its OWN + WORK + SIDE-PROJECT calendars auto-creates the private event", async () => {
    const gather = new FakeGatherPort({ kind: "ok" });
    const autoCreate = new FakeAutoCreatePort();
    const route = new FakeRoutePort();
    const deps = makeDeps({ gather, autoCreate, routeToApproval: route });

    const outcome = await runCrossCalendarScheduling(makeInput(), deps);

    expect(outcome.state).toBe("scheduled");
    expect(outcome.route).toBe("auto_create");
    // ALL THREE bound calendars (personal + work + side-project) were presented to gather.
    expect(gather.calls).toHaveLength(1);
    expect(gather.calls[0]?.sources.map((s) => s.sourceId).sort()).toEqual(
      [SRC_WORK, SRC_PERSONAL, SRC_SIDE].sort(),
    );
    // The private event was created exactly once and never routed to approval.
    expect(autoCreate.createCount).toBe(1);
    expect(route.routeCount).toBe(0);
    expect(outcome.context.envelope?.writeReceipt).toBeDefined();
  });

  it("dropping the WORK calendar HARD-STOPS — never schedules over an unread work source", async () => {
    const gather = new FakeGatherPort({ kind: "partial", drop: SRC_WORK });
    const autoCreate = new FakeAutoCreatePort();
    const deps = makeDeps({ gather, autoCreate });

    const outcome = await runCrossCalendarScheduling(makeInput(), deps);

    expect(outcome.state).toBe("calendar_unreachable");
    expect(autoCreate.createCount).toBe(0);
  });

  it("dropping the SIDE-PROJECT calendar HARD-STOPS — an omitted side-project source is never assumed free", async () => {
    const gather = new FakeGatherPort({ kind: "partial", drop: SRC_SIDE });
    const autoCreate = new FakeAutoCreatePort();
    const deps = makeDeps({ gather, autoCreate });

    const outcome = await runCrossCalendarScheduling(makeInput(), deps);

    expect(outcome.state).toBe("calendar_unreachable");
    expect(autoCreate.createCount).toBe(0);
  });

  it("a shared/invite scheduling change ROUTES to the Approval Inbox (7.9) — never auto-applied cross-calendar", async () => {
    const autoCreate = new FakeAutoCreatePort();
    const route = new FakeRoutePort();
    const deps = makeDeps({
      buildOutputs: new FakeBuildPort({ sharedAction: true }),
      autoCreate,
      routeToApproval: route,
    });

    const outcome = await runCrossCalendarScheduling(makeInput(), deps);

    expect(outcome.state).toBe("approval_pending");
    expect(outcome.route).toBe("route_to_approval");
    expect(autoCreate.createCount).toBe(0);
    expect(route.routeCount).toBe(1);
  });
});

// ===========================================================================
// (b) proposals carry only GENERIC conflict explanations — NO raw leak (WS-8)
// ===========================================================================

describe("calendar-conflict — generic conflict explanations only, no raw leak (§20.1 · WS-8 · Flow 3)", () => {
  it("the real leakage predicates classify generic vs raw-content-shaped strings", () => {
    // A short single-line explanation is generic; a multi-line one is raw-content-shaped.
    expect(isGenericExplanation("conflicts with a busy block")).toBe(true);
    expect(isGenericExplanation(undefined)).toBe(true);
    expect(isGenericExplanation("Sync w/ Acme re: Q3 contract\nAttendees: alice@acme")).toBe(false);
    // The load-bearing dispatched-payload check catches raw content under ANY key.
    expect(payloadCarriesRawContent({ start: "x", end: "y", genericExplanation: "busy" })).toBe(false);
    expect(
      payloadCarriesRawContent({
        start: "x",
        conflictDetail: "Acme M&A war-room: Project Falcon\nAttendees: cfo@acme",
      }),
    ).toBe(true);
  });

  it("the real deriver REFUSES a raw-content-shaped conflict explanation (descriptor guard)", async () => {
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
              // RAW multi-line employer meeting title/body — must NOT ride a proposal.
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

  it("the real deriver REFUSES raw cross-workspace detail in the DISPATCHED payload even when the decoy field is clean (WS-8 fail-closed)", async () => {
    const port = createProposeWindowsActivity({
      projection: {
        project: () =>
          ok({
            action: {
              targetSystem: "calendar",
              canonicalIdentity: { slot: "s" },
              operation: "calendar.create",
              idempotencyIdentity: { slot: "s" },
              // DISPATCHED payload carries raw cross-workspace content — a leaked
              // multi-line employer meeting body that must NOT egress onto the event.
              payload: {
                start: "2026-07-06T14:00:00Z",
                end: "2026-07-06T15:00:00Z",
                conflictDetail:
                  "Acme M&A war-room: Project Falcon\nAttendees: cfo@acme, gc@acme\nRe: undisclosed acquisition terms",
              },
              approvalPolicy: "auto_private",
              payloadHash: "h",
              preconditions: [],
              // DECOY descriptor field is CLEAN — a guard that only inspects this passes.
              genericExplanation: "no conflicts",
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

  it("a clean generic-only payload PASSES and stamps the BOUND workspace (WS-2/WS-4)", async () => {
    const boundWs = "ws-bound-derive" as WorkspaceId;
    const port = createProposeWindowsActivity({
      projection: {
        project: (_v, ws) =>
          ok({
            action: {
              targetSystem: "calendar",
              canonicalIdentity: { slot: "s" },
              operation: "calendar.create",
              idempotencyIdentity: { slot: "s" },
              payload: { start: "x", end: "y", genericExplanation: "conflicts with a busy block" },
              approvalPolicy: "auto_private",
              payloadHash: "h",
              preconditions: [],
              genericExplanation: "conflicts with a busy block",
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
      expect(built.value.action.targetSystem).toBe("calendar");
      expect(built.value.plan?.workspaceId).toBe(boundWs);
    }
  });
});

// ===========================================================================
// (c) insufficient availability metadata → typed failure, not a silent bad slot
// ===========================================================================

describe("calendar-conflict — insufficient availability → typed failure, not a silent bad slot (§20.1 · REQ-F-009)", () => {
  const cases: { name: string; gather: FakeGatherPort }[] = [
    { name: "an UNREACHABLE calendar source", gather: new FakeGatherPort({ kind: "fail", code: "calendar_unreachable" }) },
    { name: "a PARTIAL read (an omitted source)", gather: new FakeGatherPort({ kind: "partial", drop: SRC_WORK }) },
    { name: "a GCL gate rejection (raw event detail present)", gather: new FakeGatherPort({ kind: "fail", code: "gate_rejected" }) },
  ];

  for (const c of cases) {
    it(`${c.name} → typed calendar_unreachable, a health item, and NO event created`, async () => {
      const autoCreate = new FakeAutoCreatePort();
      const health = new FakeHealthSink();
      const deps = makeDeps({ gather: c.gather, autoCreate, health });

      const outcome = await runCrossCalendarScheduling(makeInput(), deps);

      // Typed failure state — not a silently-chosen bad slot.
      expect(outcome.state).toBe("calendar_unreachable");
      // No external event was created over the incomplete availability picture.
      expect(autoCreate.createCount).toBe(0);
      // The failure surfaced to System Health (nothing silent — inv-5).
      expect(health.surfaced).toHaveLength(1);
      expect(health.surfaced[0]?.failureClass).toBe("connector_unreachable");
    });
  }
});

// ===========================================================================
// the real §9 state machine forbids scheduling without gathering availability
// ===========================================================================

describe("calendar-conflict — machine forbids skipping availability (§9)", () => {
  it("only `scheduled` is terminal and there is no requested→scheduled teleport", () => {
    expect(crossCalendarSchedulingMachine.isTerminal("scheduled")).toBe(true);
    expect(crossCalendarSchedulingMachine.canTransition("requested", "availability_gathered")).toBe(true);
    // A slot can never be scheduled without first gathering availability.
    expect(crossCalendarSchedulingMachine.canTransition("requested", "scheduled")).toBe(false);
    expect(crossCalendarSchedulingMachine.canTransition("requested", "event_created")).toBe(false);
  });
});

// ===========================================================================
// EVAL-1 runner scoring — the §20.1 CROSS_CALENDAR_SCHEDULING criterion
// ===========================================================================

describe("calendar-conflict — EVAL-1 runner scoring", () => {
  it("the criterion is deterministic (requiresRealIntegration === false)", () => {
    expect(criterionById(CRITERION_ID)?.requiresRealIntegration).toBe(false);
  });

  it("scores functionally- AND DoD-passing when the acceptance bullets hold (no vendor needed)", async () => {
    // Re-drive the representative acceptance scenarios and AND their real outcomes into
    // the boolean gate measurement fed to the runner — an honest gate value, not a
    // hard-coded `true`.
    const happy = await runCrossCalendarScheduling(makeInput(), makeDeps());
    const unreachable = await runCrossCalendarScheduling(
      makeInput(),
      makeDeps({ gather: new FakeGatherPort({ kind: "fail", code: "calendar_unreachable" }) }),
    );
    const shared = await runCrossCalendarScheduling(
      makeInput(),
      makeDeps({ buildOutputs: new FakeBuildPort({ sharedAction: true }) }),
    );
    const leakyBuild = await createProposeWindowsActivity({
      projection: {
        project: () =>
          ok({
            action: {
              targetSystem: "calendar",
              canonicalIdentity: { slot: "s" },
              operation: "calendar.create",
              idempotencyIdentity: { slot: "s" },
              payload: { start: "x", detail: "line1\nline2 raw title" },
              approvalPolicy: "auto_private",
              payloadHash: "h",
              preconditions: [],
              genericExplanation: "no conflicts",
            },
          }),
      },
      sourceRef: { sourceId: sourceId("src-ccs-1") },
      planIdentity: { run: "1" },
    }).build({ validated: true, fields: {}, windows: [] }, ORG_WS);

    const acceptanceHeld =
      happy.state === "scheduled" &&
      happy.route === "auto_create" &&
      unreachable.state === "calendar_unreachable" &&
      shared.state === "approval_pending" &&
      isOk(leakyBuild) === false;

    const out: EvalOutcome = scoreById({
      criterionId: CRITERION_ID,
      value: acceptanceHeld,
      fromRealIntegration: false,
    });

    expect(acceptanceHeld).toBe(true);
    expect(out.functionalPass).toBe(true);
    // Deterministic criterion → dodValid holds even from a mock-backed run.
    expect(out.dodValid).toBe(true);
    expect(out.dodPass).toBe(true);
  });

  it("a failing gate measurement does NOT report passing (runner honesty)", () => {
    const out = scoreById({ criterionId: CRITERION_ID, value: false, fromRealIntegration: false });
    expect(out.functionalPass).toBe(false);
    expect(out.dodPass).toBe(false);
  });
});
