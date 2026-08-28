// WP4 (task 25.1's crossTerritoryNeed close-out) — the FOUR output-workflow families'
// (dailyBrief/periodReview/projectSync/crossCalendarScheduling) flat activity surface
// (packages/workflows/src/activities/outputWorkflows.ts's `OutputWorkflowActivities`), the
// projectSync registry resolver, and the 7 durable scheduled-runtime activities
// (scheduleArgs.ts's frozen `SCHEDULED_RUNTIME_ACTIVITY_NAMES` contract) — closing task 25.1's own
// named crossTerritoryNeed: "the composition-root binding that spreads
// createOutputWorkflowActivities(...)'s real backends into the registered activities object is a
// NAMED, NOT-YET-LANDED follow-up."
//
// WHY THIS TEST MATTERS (per the brief — "the highest-value test in this whole build"):
// temporal/workflows.ts's `proxyActivities<OutputWorkflowActivities>()` /
// `proxyActivities<ProjectSyncRegistryActivities>()` / `proxyActivities<ScheduledRunActivities>()` /
// `proxyActivities<ScheduledScheduleActivities>()` are the SANDBOX SIDE of this exact name set.
// `proxyActivities` returns a function for ANY property access (it is a lazy Proxy, not a fixed
// object) — so a name present on the sandbox side but MISSING (or MISSPELLED) on the registered
// side here is INVISIBLE to typecheck and surfaces ONLY as "activity not registered" against a
// live Temporal server, on the very first scheduled occurrence. This file is that gap's test.
import { describe, it, expect } from "vitest";
import { workspaceId, workflowId, sourceId, validKnowledgeMutationPlan, KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID } from "@sow/contracts";
import type { WorkspaceId, WorkflowRunRef, SourceRef, ProviderRoute } from "@sow/contracts";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import type { AgentExtraction, MeetingJobInputs } from "@sow/workflows";
import type { CommittedRevision, KnowledgeRevisionStore } from "@sow/knowledge";
import { computeRevisionId } from "@sow/knowledge";

import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import { buildProofSpineActivities, type ProofSpineParams } from "../../src/composition/buildActivities";
import { SCHEDULED_RUNTIME_ACTIVITY_NAMES } from "../../src/temporal/scheduleArgs";

// ── fixture (mirrors test/proof-spine-composition.test.ts's established shape) ────────────────
const WS: WorkspaceId = workspaceId("ws-owf");
const NOW = "2026-08-27T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const MEETING_CAP = "meeting.close";
const EMPTY_VAULT_REVISION = computeRevisionId(new Map());

const localRoute = (endpoint: string): ProviderRoute =>
  ({ provider: "ollama", model: "local-default", endpoint, egressClass: "local" }) as unknown as ProviderRoute;

const resolvedFor = (endpoint: string): ResolvedWorkspacePolicy => ({
  workspaceId: String(WS),
  type: "employer_work",
  dataOwner: "employer",
  defaultVisibility: "coordination",
  egressPolicy: {
    workspaceId: WS,
    allowedProcessors: [],
    rawContentAllowedProcessors: [],
    employerRawEgressAcknowledged: false,
  },
  providerMatrix: {
    workspaceId: WS,
    allowedProviders: ["ollama"],
    capabilityDefaults: { [MEETING_CAP]: localRoute(endpoint) } as never,
    rawCloudEgressEnabled: false,
  },
});

const runRef: WorkflowRunRef = {
  workflowId: workflowId("wf-owf-1"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:owf:1",
  auditRefs: [],
};

const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-owf-1"),
  workspaceId: WS,
  capability: MEETING_CAP,
  outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:meeting:owf",
};

const meetingExtraction: AgentExtraction = {
  fields: { title: { value: "WP4 activity-binding test", evidenceRef: "src:1#0" } },
};

const sourceRef: SourceRef = { sourceId: sourceId("src-owf-1") };

function memRevisionStore(): KnowledgeRevisionStore {
  const byKey = new Map<string, CommittedRevision>();
  return {
    getByIdempotencyKey: (k) => Promise.resolve(byKey.get(k)),
    record: (rev) => {
      byKey.set(rev.idempotencyKey, rev);
      return Promise.resolve();
    },
  };
}

function paramsFor(endpoint: string): ProofSpineParams {
  return {
    resolved: resolvedFor(endpoint),
    correlationSignals: { confidence: 0.95, workspaceId: WS },
    meetingJobInputs,
    meetingExtraction,
    revisions: memRevisionStore(),
    commit: {
      actor: "worker:test",
      sourceEventRef: "evt:owf",
      workflowRunRef: runRef,
      expectedBaseRevision: EMPTY_VAULT_REVISION,
    },
    sourceRef,
    planIdentity: { closeout: "owf:1" },
  };
}

async function freshBackends(endpoint: string): Promise<ProofSpineBackends> {
  return assembleBackends(
    { now: () => NOW, allowedLocalEndpoints: [endpoint] },
    { candidateOutput: validKnowledgeMutationPlan },
  );
}

// ── the expected name set ──────────────────────────────────────────────────────────────────────

// The flat OutputWorkflowActivities surface (packages/workflows/src/activities/outputWorkflows.ts).
// No shared runtime constant enumerates these (they are interface members, erased at compile time)
// — listed here the same way temporal/workflows.ts's `ScheduledRunActivities` interface. names its
// OWN members: verbatim from the interface, one line per family, in the SAME order the interface
// declares them, so a side-by-side diff against outputWorkflows.ts catches drift on review.
const OUTPUT_WORKFLOW_ACTIVITY_NAMES = [
  // dailyBrief (25.2)
  "dailyBriefRefreshConnectors",
  "dailyBriefUpdateProjections",
  "dailyBriefRunAgent",
  "dailyBriefValidate",
  "dailyBriefBuildGlobal",
  "dailyBriefBuildWorkspace",
  "dailyBriefCommit",
  "dailyBriefUpdateDashboard",
  "dailyBriefNotify",
  "dailyBriefSurfaceFailure",
  // periodReview (25.2)
  "periodReviewRefreshConnectors",
  "periodReviewUpdateProjections",
  "periodReviewRunAgent",
  "periodReviewValidate",
  "periodReviewBuildGlobal",
  "periodReviewBuildWorkspace",
  "periodReviewCommit",
  "periodReviewUpdateDashboard",
  "periodReviewNotify",
  "periodReviewSurfaceFailure",
  // projectSync (25.3) — `registry` is DELIBERATELY excluded from this interface (its own doc
  // comment: "the composition root supplies it directly") — that is `projectSyncResolveRegistry`,
  // tested separately below.
  "projectSyncParseProgress",
  "projectSyncSynthesizeNarrative",
  "projectSyncValidateNarrative",
  "projectSyncBuildOutputs",
  "projectSyncCommitStatus",
  "projectSyncUpdateDashboard",
  "projectSyncProposeActions",
  "projectSyncSurfaceFailure",
  // crossCalendarScheduling (25.4)
  "crossCalendarGatherAvailability",
  "crossCalendarProposeWindowsAgent",
  "crossCalendarValidateProposal",
  "crossCalendarBuildOutputs",
  "crossCalendarClassifyAction",
  "crossCalendarAutoCreateEvent",
  "crossCalendarRouteToApproval",
  "crossCalendarCommitNote",
  "crossCalendarSurfaceFailure",
] as const;

// The ONE name workflows.ts's `projectSyncRegistryActivities` proxy declares OUTSIDE
// OutputWorkflowActivities (see that proxy's own doc comment + this module's own interface member).
const PROJECT_SYNC_REGISTRY_ACTIVITY_NAME = "projectSyncResolveRegistry" as const;

// DERIVED, not hardcoded (per the brief) — straight off the SAME frozen SCHEDULED_RUNTIME_ACTIVITY_NAMES
// constant scheduleArgs.ts declares and temporal/workflows.ts's `ScheduledRunActivities`/
// `ScheduledScheduleActivities` proxies key off — an addition/rename to that constant flows into this
// test automatically; it can never silently drift out of sync with it.
const SCHEDULED_RUNTIME_NAMES = Object.values(SCHEDULED_RUNTIME_ACTIVITY_NAMES);

describe("buildProofSpineActivities — WP4: output-workflow / projectSync-registry / scheduled-runtime activities are ALL registered", () => {
  it("every name temporal/workflows.ts's WP4 proxies reference is present on the registered activities object, as a function", async () => {
    const backends = await freshBackends(LOCAL_ENDPOINT);
    try {
      const acts = buildProofSpineActivities(backends, paramsFor(LOCAL_ENDPOINT));
      const record = acts as unknown as Record<string, unknown>;

      const expected: readonly string[] = [
        ...OUTPUT_WORKFLOW_ACTIVITY_NAMES,
        PROJECT_SYNC_REGISTRY_ACTIVITY_NAME,
        ...SCHEDULED_RUNTIME_NAMES,
      ];
      // Non-vacuity — prove the derivation actually produced the expected populations BEFORE
      // trusting the loop below (a broken derivation yielding an empty array would pass vacuously).
      expect(OUTPUT_WORKFLOW_ACTIVITY_NAMES.length).toBe(37);
      expect(SCHEDULED_RUNTIME_NAMES.length).toBe(7);
      expect(expected.length).toBe(45);

      for (const name of expected) {
        expect(typeof record[name]).toBe("function");
      }
    } finally {
      backends.close();
    }
  });
});

// task 24.105 — the SAME binding-site precondition guard proof-spine-composition.test.ts already
// pins for `meetingCommit`/`sourceCommit`, extended to the FOUR WP4 commit-bearing members. A
// commit rejection's `cause` is the WHOLE @sow/knowledge `WriteFailure` (validator-authored
// secret-scan/workspace-path/ownership detail) — outputWorkflows.ts's own `commitWithRedactedFailure`
// drops it on the `err` arm BEFORE it ever reaches this registration (the module header + the
// buildActivities.ts binding-site comment explain the full mapping). This test pins the OTHER half
// of task 24.105's Done-when: no raw `CommitKnowledgePort`-shaped object (a `.commit` method) is
// ever exposed as a registered activity VALUE — only ever the plain-async WRAPPER.
describe("buildProofSpineActivities — task 24.105: the WP4 commit-bearing members carry no nested .commit", () => {
  it("dailyBriefCommit/periodReviewCommit/projectSyncCommitStatus/crossCalendarCommitNote are bare functions, never the raw commit port object", async () => {
    const backends = await freshBackends(LOCAL_ENDPOINT);
    try {
      const acts = buildProofSpineActivities(backends, paramsFor(LOCAL_ENDPOINT));
      const record = acts as unknown as Record<string, unknown>;
      const commitBearing = [
        "dailyBriefCommit",
        "periodReviewCommit",
        "projectSyncCommitStatus",
        "crossCalendarCommitNote",
      ] as const;
      for (const name of commitBearing) {
        expect(typeof record[name]).toBe("function");
        // A regression that spread `{...commitActivity}` (the raw port, nested `.commit` method)
        // instead of the wrapped function would put a `.commit` property here — this is what proves
        // it was WRAPPED, not aliased (mirrors proof-spine-composition.test.ts's identical pin for
        // meetingCommit/sourceCommit).
        expect((record[name] as { readonly commit?: unknown }).commit).toBeUndefined();
      }
    } finally {
      backends.close();
    }
  });
});
