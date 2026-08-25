// spec(§9 workflow 6, REQ-F-009, Flow 3) — PKG-W3 25.4: the cross-calendar-
// scheduling LEAKAGE + ROUTING boundary, driven end-to-end through
// `runCrossCalendarScheduling` (the real pure driver).
//
// PART 1 (REQ-F-009 / Flow 3 leakage): two workspaces — one with an approved
// cross-workspace link, one without — through the REAL `createGatherAvailabilityActivity`
// (25.4's deliverable) over an injected query+gate pair (the gate models the
// GCL "owner-approved link" contract the port doc names; the REAL cross-
// workspace link resolution is apps/worker/composition territory, out of this
// package's scope — see the port's own dormancy note). Asserts: the unlinked
// pair yields ZERO blended windows (the whole gather fails closed — REQ-F-009
// never treats an unauthorized source as free); the linked pair's admitted
// output carries no raw foreign event body (the BusyWindow shape structurally
// excludes it).
//
// PART 2 (classify/autoCreate/routeToApproval split, §9 workflow 6): drives
// the REAL `createClassifyActionActivity` (25.4's deliverable) over the REAL
// @sow/policy `requiresApproval` — one test per branch: a private
// policy-allowed personal action → auto_create (autoCreate invoked,
// routeToApproval NEVER); an employer-owned action on the same target →
// route_to_approval (routeToApproval invoked, autoCreate NEVER); an
// unresolvable organizer workspace → classify fails closed → ALSO
// route_to_approval, autoCreate NEVER.
import { describe, it, expect } from "vitest";
import { ok, actionId, workflowId, workspaceId } from "@sow/contracts";
import type { ProposedAction, ExternalWriteEnvelope, WorkspaceId, Result } from "@sow/contracts";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import { runCrossCalendarScheduling } from "../../src/workflows/crossCalendarScheduling";
import type {
  CrossCalendarSchedulingInput,
  CrossCalendarSchedulingDeps,
} from "../../src/workflows/crossCalendarScheduling";
import type {
  CrossCalendarSchedulingContext,
  AvailabilitySource,
  GatherAvailabilityPort,
  ProposeWindowsAgentPort,
  ProposedWindows,
  ValidateProposalPort,
  ValidatedProposal,
  BuildSchedulingOutputsPort,
  SchedulingBuiltOutputs,
  AutoCreateEventPort,
  AutoCreateResult,
  AutoCreateError,
  RouteToApprovalPort,
  RouteToApprovalResult,
  RouteToApprovalError,
  SchedulingHealthSink,
  SchedulingSurfaceOutcome,
  SchedulingHealthSinkError,
  SchedulingWorkflowFailure,
} from "../../src/ports/crossCalendarScheduling";
import { createGatherAvailabilityActivity } from "../../src/activities/gatherAvailability";
import type { CandidateBusyWindow, AvailabilityGate, AvailabilitySourceQuery } from "../../src/activities/gatherAvailability";
import { createClassifyActionActivity } from "../../src/activities/classifyAction";
import type { WorkspacePolicyLookup } from "../../src/activities/classifyAction";
import { FakeClock, InMemoryWorkflowRunRepo } from "../support/fakes";

// ---------------------------------------------------------------------------
// PART 1 — gather-availability leakage boundary
// ---------------------------------------------------------------------------

const ORGANIZER_WS = workspaceId("ws-personal-boundary");
const LINKED_WS = ORGANIZER_WS; // same-workspace source — always readable, no link needed
const UNLINKED_WS = workspaceId("ws-employer-unlinked");

const RAW_FOREIGN_BODY = "RAW-FOREIGN-EVENT: acme board meeting — layoffs discussion";

function rawCandidate(sourceId: string, wsId: WorkspaceId, rawTitle?: string): CandidateBusyWindow {
  return {
    sourceId,
    workspaceId: wsId,
    start: "2026-08-24T09:00:00.000Z",
    end: "2026-08-24T10:00:00.000Z",
    ...(rawTitle !== undefined ? { rawTitle } : {}),
    genericReason: "busy",
  };
}

/** Models the GCL "owner-approved link" contract: same-workspace always
 *  admits; a cross-workspace candidate admits ONLY when an approved link is
 *  present — and even then strips to the sanitized BusyWindow shape (no
 *  `rawTitle`/`rawAttendees` on the admitted value). */
function makeLinkGate(approvedLinks: ReadonlySet<string>): AvailabilityGate {
  return {
    admit(candidate, organizerWorkspaceId) {
      const linkKey = `${String(organizerWorkspaceId)}->${String(candidate.workspaceId)}`;
      const authorized = candidate.workspaceId === organizerWorkspaceId || approvedLinks.has(linkKey);
      if (!authorized) {
        return Promise.resolve({
          ok: false,
          error: { reason: `no approved cross-workspace link for ${linkKey}` },
        });
      }
      return Promise.resolve({
        ok: true,
        value: {
          sourceId: candidate.sourceId,
          start: candidate.start,
          end: candidate.end,
          ...(candidate.genericReason !== undefined ? { genericReason: candidate.genericReason } : {}),
        },
      });
    },
  };
}

function makeGatherCtx(sources: readonly AvailabilitySource[]): CrossCalendarSchedulingContext {
  return { sources, organizerWorkspaceId: ORGANIZER_WS };
}

describe("cross-calendar-scheduling gather leakage boundary (REQ-F-009 / Flow 3, 25.4)", () => {
  it("the LINKED pair (same-workspace) admits windows with NO raw foreign event body", async () => {
    const query: AvailabilitySourceQuery = {
      query: (source) => Promise.resolve(ok([rawCandidate(source.sourceId, LINKED_WS, RAW_FOREIGN_BODY)])),
    };
    const activity = createGatherAvailabilityActivity({
      query,
      gate: makeLinkGate(new Set()),
    });

    const result = await activity.gather(makeGatherCtx([{ sourceId: "cal-personal", workspaceId: LINKED_WS }]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.busyWindows).toHaveLength(1);
      expect(JSON.stringify(result.value)).not.toContain(RAW_FOREIGN_BODY);
      // Structural: the admitted window shape has no raw-title field at all.
      expect(Object.keys(result.value.busyWindows[0]!)).not.toContain("rawTitle");
    }
  });

  it("the UNLINKED pair yields ZERO blended windows — the whole gather fails closed", async () => {
    const query: AvailabilitySourceQuery = {
      query: (source) =>
        Promise.resolve(
          ok([rawCandidate(source.sourceId, source.workspaceId === LINKED_WS ? LINKED_WS : UNLINKED_WS, RAW_FOREIGN_BODY)]),
        ),
    };
    const activity = createGatherAvailabilityActivity({
      query,
      // No approved link from ORGANIZER_WS to UNLINKED_WS.
      gate: makeLinkGate(new Set()),
    });

    const result = await activity.gather(
      makeGatherCtx([
        { sourceId: "cal-personal", workspaceId: LINKED_WS },
        { sourceId: "cal-employer-unlinked", workspaceId: UNLINKED_WS },
      ]),
    );
    // The unauthorized source hard-fails the WHOLE gather (REQ-F-009: never
    // silently treated as free) — zero blended windows, never a partial set.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("gate_rejected");
      expect(JSON.stringify(result.error)).not.toContain(RAW_FOREIGN_BODY);
    }
  });

  it("MUTATION CHECK: an approved link admits the previously-unlinked source (proves the rejection above is load-bearing)", async () => {
    const linkKey = `${String(ORGANIZER_WS)}->${String(UNLINKED_WS)}`;
    const query: AvailabilitySourceQuery = {
      query: (source) =>
        Promise.resolve(
          ok([rawCandidate(source.sourceId, source.workspaceId === LINKED_WS ? LINKED_WS : UNLINKED_WS, RAW_FOREIGN_BODY)]),
        ),
    };
    const activity = createGatherAvailabilityActivity({
      query,
      gate: makeLinkGate(new Set([linkKey])),
    });

    const result = await activity.gather(
      makeGatherCtx([
        { sourceId: "cal-personal", workspaceId: LINKED_WS },
        { sourceId: "cal-employer-unlinked", workspaceId: UNLINKED_WS },
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.busyWindows.length).toBeGreaterThan(0);
      expect(result.value.readSources).toContain("cal-employer-unlinked");
    }
  });
});

// ---------------------------------------------------------------------------
// PART 2 — classify / autoCreate / routeToApproval split (§9 workflow 6)
// ---------------------------------------------------------------------------

const ROUTING_WS = workspaceId("ws-routing-boundary");
const UNRESOLVABLE_WS = workspaceId("ws-routing-unresolvable");

function makeResolvedPolicy(overrides: Partial<ResolvedWorkspacePolicy> = {}): ResolvedWorkspacePolicy {
  return {
    workspaceId: String(ROUTING_WS),
    type: "personal_life",
    dataOwner: "user",
    defaultVisibility: "isolated",
    egressPolicy: {
      workspaceId: ROUTING_WS,
      allowedProcessors: [],
      rawContentAllowedProcessors: [],
      employerRawEgressAcknowledged: false,
    },
    providerMatrix: { workspaceId: ROUTING_WS, allowedProviders: [], capabilityDefaults: {}, rawCloudEgressEnabled: false },
    ...overrides,
  };
}

function makeAction(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    actionId: actionId("act-routing-boundary"),
    targetSystem: "calendar",
    canonicalObjectKey: "calendar:event:routing-boundary",
    payload: { start: "2026-08-24T09:00:00.000Z", end: "2026-08-24T10:00:00.000Z", genericExplanation: "busy" },
    approvalPolicy: "auto_private",
    idempotencyKey: "idem-routing-boundary",
    ...overrides,
  };
}

const FIXED_ENVELOPE: ExternalWriteEnvelope = {
  actionId: actionId("act-routing-boundary"),
  targetSystem: "calendar",
  canonicalObjectKey: "calendar:event:routing-boundary",
  idempotencyKey: "idem-routing-boundary",
  preconditions: ["not_exists"],
  payloadHash: "sha256:routing-boundary",
};

class CountingAutoCreate implements AutoCreateEventPort {
  count = 0;
  create(action: ProposedAction, env: ExternalWriteEnvelope): Promise<Result<AutoCreateResult, AutoCreateError>> {
    void action;
    this.count += 1;
    return Promise.resolve(ok({ status: "created", envelope: env }));
  }
}

class CountingRouteToApproval implements RouteToApprovalPort {
  count = 0;
  route(action: ProposedAction, env: ExternalWriteEnvelope): Promise<Result<RouteToApprovalResult, RouteToApprovalError>> {
    void action;
    void env;
    this.count += 1;
    return Promise.resolve(ok({ approvalRef: "appr-routing-boundary", created: true }));
  }
}

class FixedGatherAvailability implements GatherAvailabilityPort {
  gather() {
    return Promise.resolve(ok({ readSources: ["cal-1"], busyWindows: [] }));
  }
}

class FixedProposeAgent implements ProposeWindowsAgentPort {
  run(): ReturnType<ProposeWindowsAgentPort["run"]> {
    const windows: ProposedWindows = {
      fields: {},
      windows: [{ start: "2026-08-24T09:00:00.000Z", end: "2026-08-24T10:00:00.000Z", genericExplanation: "busy" }],
      schemaId: "sow:cross-calendar-scheduling",
    };
    return Promise.resolve(ok(windows));
  }
}

class PassthroughValidate implements ValidateProposalPort {
  validate(proposal: ProposedWindows): ReturnType<ValidateProposalPort["validate"]> {
    const validated: ValidatedProposal = { ...proposal, validated: true };
    return ok(validated);
  }
}

function makeBuildOutputs(action: ProposedAction): BuildSchedulingOutputsPort {
  return {
    build(): ReturnType<BuildSchedulingOutputsPort["build"]> {
      const outputs: SchedulingBuiltOutputs = {
        action,
        envelope: { ...FIXED_ENVELOPE, actionId: action.actionId },
      };
      return Promise.resolve(ok(outputs));
    },
  };
}

class NoopHealthSink implements SchedulingHealthSink {
  surface(failure: SchedulingWorkflowFailure): Promise<Result<SchedulingSurfaceOutcome, SchedulingHealthSinkError>> {
    void failure;
    return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
  }
}

function makeRoutingInput(): CrossCalendarSchedulingInput {
  return {
    run: {
      workflowId: workflowId("wf-routing-boundary"),
      trigger: "owner_action",
      idempotencyKey: "idem-routing-boundary-run",
    },
    context: { sources: [{ sourceId: "cal-1", workspaceId: ROUTING_WS }], organizerWorkspaceId: ROUTING_WS },
  };
}

function makeRoutingDeps(
  action: ProposedAction,
  resolvePolicy: WorkspacePolicyLookup,
): { deps: CrossCalendarSchedulingDeps; autoCreate: CountingAutoCreate; routeToApproval: CountingRouteToApproval } {
  const autoCreate = new CountingAutoCreate();
  const routeToApproval = new CountingRouteToApproval();
  const deps: CrossCalendarSchedulingDeps = {
    gather: new FixedGatherAvailability(),
    agent: new FixedProposeAgent(),
    validate: new PassthroughValidate(),
    buildOutputs: makeBuildOutputs(action),
    classify: createClassifyActionActivity({ resolvePolicy }),
    autoCreate,
    routeToApproval,
    health: new NoopHealthSink(),
    runs: new InMemoryWorkflowRunRepo(),
    clock: new FakeClock(),
  };
  return { deps, autoCreate, routeToApproval };
}

describe("cross-calendar-scheduling classify/autoCreate/routeToApproval split (§9 workflow 6, 25.4)", () => {
  it("BRANCH auto_create: a private, policy-allowed personal action auto-creates — routeToApproval NEVER runs", async () => {
    const action = makeAction(); // dataOwner:user (via resolved policy), auto_private, calendar, isolated
    const { deps, autoCreate, routeToApproval } = makeRoutingDeps(action, (id) =>
      id === ROUTING_WS ? makeResolvedPolicy() : undefined,
    );

    const outcome = await runCrossCalendarScheduling(makeRoutingInput(), deps);

    expect(outcome.route).toBe("auto_create");
    expect(autoCreate.count).toBe(1);
    expect(routeToApproval.count).toBe(0);
  });

  it("BRANCH route_to_approval (shared/employer-owned): routeToApproval runs — autoCreate NEVER runs", async () => {
    const action = makeAction(); // same target/policy; only the RESOLVED workspace posture differs
    const { deps, autoCreate, routeToApproval } = makeRoutingDeps(action, (id) =>
      id === ROUTING_WS ? makeResolvedPolicy({ dataOwner: "employer" }) : undefined,
    );

    const outcome = await runCrossCalendarScheduling(makeRoutingInput(), deps);

    expect(outcome.route).toBe("route_to_approval");
    expect(routeToApproval.count).toBe(1);
    expect(autoCreate.count).toBe(0);
  });

  it("BRANCH route_to_approval (classify fails closed on an unresolvable workspace): autoCreate NEVER runs", async () => {
    const action = makeAction();
    // resolvePolicy never resolves ROUTING_WS — classify folds to classify_failed,
    // which the driver ALSO routes to approval (fail-closed under uncertainty).
    const { deps, autoCreate, routeToApproval } = makeRoutingDeps(action, (id) =>
      id === UNRESOLVABLE_WS ? makeResolvedPolicy() : undefined,
    );

    const outcome = await runCrossCalendarScheduling(makeRoutingInput(), deps);

    expect(outcome.route).toBe("route_to_approval");
    expect(routeToApproval.count).toBe(1);
    expect(autoCreate.count).toBe(0);
  });
});
