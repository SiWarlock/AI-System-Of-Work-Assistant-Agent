// @sow/worker — the 15.9 G1 FLAGSHIP end-to-end proof: a fake Granola-shaped completed-meeting
// record → the REAL connector→ingestion bridge (kind:"meeting" discrimination) → dispatchMeetingCloseout
// → the meetingCloseoutWorkflow running on a REAL @temporalio Worker (an ephemeral TestWorkflowEnvironment)
// → the meeting machinery correlates → runs the meeting.close job → validates → derives outputs →
// PROPOSES a task (a todoist ProposedAction, observed as a pending Approval, since todoist+auto always
// requires approval). This is the production trigger the flagship gap (G1) was missing: before 15.9 the
// meetingCloseoutWorkflow started ONLY in fakes.
//
// GATED: `describe.skipIf(!SOW_TEMPORAL)` — the default suite must NEVER need a live Temporal server.
// The deterministic discrimination / idempotency / WS-8 / candidate-gate / degraded-safe behaviors are
// pinned by the always-run fast-unit tests (connectorIngestionBridge.test.ts §15.9 +
// meetingCloseout-dispatch.test.ts). This file proves the dispatch→workflow→propose WIRING end-to-end.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { workspaceId, workflowId, sourceId, auditId } from "@sow/contracts";
import type { WorkspaceId, WorkflowRunRef, SourceRef, ProviderRoute, AuditId } from "@sow/contracts";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import type {
  AgentExtraction,
  MeetingJobInputs,
  MeetingCloseoutInput,
  MeetingCloseoutOutcome,
} from "@sow/workflows";
import type { CommittedRevision, KnowledgeRevisionStore } from "@sow/knowledge";
import { computeRevisionId } from "@sow/knowledge";
import type { ConnectorRecord } from "@sow/integrations";
import type { Client as TemporalClient } from "@temporalio/client";
import { SOW_CONTROL_PLANE_TASK_QUEUE } from "@sow/workflows/runtime/taskQueue";

import { createTemporalClientStartRun } from "../../src/temporal/dispatchSourceIngestion";
import {
  dispatchMeetingCloseout,
  type DispatchMeetingCloseoutDeps,
} from "../../src/temporal/dispatchMeetingCloseout";
import { createConnectorIngestionBridge } from "../../src/composition/connectorIngestionBridge";
import { SOW_TEMPORAL } from "../support/temporalGate";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import { buildProofSpineActivities } from "../../src/composition/buildActivities";
import type { ProofSpineParams } from "../../src/composition/buildActivities";
import {
  proofSpineWorkflowsPath,
  PROOF_SPINE_IGNORE_MODULES,
  proofSpineWebpackConfigHook,
} from "../../src/temporal/registerWorker";

// ── deterministic constants ───────────────────────────────────────────────────
const WS: WorkspaceId = workspaceId("ws-emp");
const NOW = "2026-07-02T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const MEETING_CAP = "meeting.close";
const TASK_QUEUE = "sow-control-plane";
const MEETING_AUDIT: AuditId = auditId("meeting-dispatch:live");
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
  workflowId: workflowId("wf-mtg-live"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:mtg:live",
  auditRefs: [],
};

const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-mtg-live"),
  workspaceId: WS,
  capability: MEETING_CAP,
  outputSchemaId: "sow:meeting.close.output",
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:meeting:live",
};

// An extraction with a concrete title AND one evidence-backed action item (owner + title). The real
// meetingOutputsProjection derives exactly one todoist ProposedAction from `actionItems.<n>.*`. Both
// fields carry an evidenceRef so the no-inference gate PASSES (it is field-name-agnostic).
const meetingExtraction: AgentExtraction = {
  fields: {
    title: { value: "Weekly Sync", evidenceRef: "transcript#0" },
    "actionItems.0.title": { value: "Send the recap", evidenceRef: "transcript#L20" },
    "actionItems.0.owner": { value: "Bob", evidenceRef: "transcript#L21" },
  },
};

const meetingSourceRef: SourceRef = { sourceId: sourceId("mtg-live-1") };

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

/** ProofSpineParams driving the meeting flow with an action-producing extraction (HIGH correlation). */
function meetingParamsFor(revisions: KnowledgeRevisionStore): ProofSpineParams {
  return {
    resolved: resolvedFor(LOCAL_ENDPOINT),
    correlationSignals: { confidence: 0.95, workspaceId: WS }, // HIGH ⇒ binds WS before any write (WS-2)
    meetingJobInputs,
    meetingExtraction,
    revisions,
    commit: {
      actor: "worker:mtg-live",
      sourceEventRef: "evt:mtg-live",
      workflowRunRef: runRef,
      expectedBaseRevision: EMPTY_VAULT_REVISION,
    },
    sourceRef: meetingSourceRef,
    planIdentity: { closeout: "meeting:live" },
  };
}

// ── the shared ephemeral Temporal rig (ONE worker for the file; SDK Runtime is a singleton) ─────────
interface SharedRig {
  readonly backends: ProofSpineBackends;
  readonly client: TemporalClient;
}
let sharedRig: SharedRig | undefined;
let teardownAll: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!SOW_TEMPORAL) return;
  const { TestWorkflowEnvironment } = await import("@temporalio/testing");
  const { Worker, bundleWorkflowCode } = await import("@temporalio/worker");

  const bundle = await bundleWorkflowCode({
    workflowsPath: proofSpineWorkflowsPath(),
    ignoreModules: [...PROOF_SPINE_IGNORE_MODULES],
    webpackConfigHook: proofSpineWebpackConfigHook,
  });
  const env = await TestWorkflowEnvironment.createLocal();
  const backends = await assembleBackends(
    { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    { candidateOutput: {} },
  );
  const activities = buildProofSpineActivities(backends, meetingParamsFor(memRevisionStore()));
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle: bundle,
    activities: activities as unknown as Record<string, unknown>,
  });
  const runPromise = worker.run();

  sharedRig = { backends, client: env.client };
  teardownAll = async (): Promise<void> => {
    worker.shutdown();
    await runPromise.catch(() => undefined);
    backends.close();
    await env.teardown();
  };
}, 120_000);

afterAll(async () => {
  await teardownAll?.();
  sharedRig = undefined;
  teardownAll = undefined;
});

function rig(): SharedRig {
  if (sharedRig === undefined) throw new Error("shared rig not initialised");
  return sharedRig;
}

// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SOW_TEMPORAL)("15.9 meeting-closeout dispatcher — G1 flagship, end-to-end over a real Temporal worker", () => {
  it("meeting_flagship_end_to_end_produces_a_proposed_action: a fake Granola completed-meeting → the REAL bridge (kind:meeting) → dispatchMeetingCloseout → meetingCloseoutWorkflow runs → PROPOSES a task (spec §19.2 Done-when / §9)", async () => {
    // The meeting connector-instance binding (kind derived from the 14.2 registry, NOT record content).
    const meetingBinding = {
      connectorId: "granola",
      workspaceId: String(WS), // WS-8 anchor — the bound instance, never a payload field
      origin: "connector:granola",
      type: "transcript",
      sensitivity: "internal" as const,
      routingHints: { connectorId: "granola" },
      kind: "meeting" as const,
    };
    // The bridge's meeting dispatch is the REAL dispatchMeetingCloseout over the live TestWorkflowEnvironment
    // client — so this exact production adapter is exercised, not a fake.
    const startRun = createTemporalClientStartRun(rig().client);
    const dispatchMeeting = (input: MeetingCloseoutInput) => {
      const deps: DispatchMeetingCloseoutDeps = {
        startRun,
        surfaceHealth: () => Promise.resolve(),
        taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE,
        auditRef: MEETING_AUDIT,
      };
      return dispatchMeetingCloseout(input, deps);
    };
    const bridge = createConnectorIngestionBridge({
      binding: meetingBinding,
      registerDeps: { seenContentHash: () => Promise.resolve(false) },
      dispatch: () => Promise.reject(new Error("source dispatch must not be called for a meeting binding")),
      dispatchMeeting,
    });

    // A fake Granola-shaped completed-meeting record (payload = the raw transcript, candidate data).
    const record: ConnectorRecord = {
      recordId: "granola-note-1",
      contentHash: "sha256:mtg-live-1",
      payload: { id: "granola-note-1", title: "Weekly Sync", transcript: "…meeting transcript…" },
    };

    // Drive the record through the bridge: registerSource gate → dispatchMeetingCloseout → START the run.
    const bridged = await bridge.onRecords([record]);
    expect(bridged.ok).toBe(true);

    // The deterministic meeting workflowId (record id, NOT contentHash). Await the started run.
    const meetingWorkflowId = `meeting:${String(WS)}:granola-note-1`;
    const outcome = (await rig()
      .client.workflow.getHandle(meetingWorkflowId)
      .result()) as MeetingCloseoutOutcome;

    // The pipeline correlated (HIGH → bound WS), ran the meeting.close job, validated, DERIVED a
    // todoist action, and PROPOSED it. A todoist+auto action always requires approval, so the closeout
    // rests at approval_pending — the proposal fired but fail-closed to approval (no blind external write).
    expect(outcome.state).toBe("approval_pending");
    expect(outcome.surfaced?.failureClass).toBe("conflict_review");

    // The load-bearing flagship proof: a ProposedAction was PROPOSED — a pending external-action Approval
    // landed in the real repo (the transcript → closeout → propose-tasks production trigger works).
    const pending = await rig().backends.repos.approvals.listByStatus("pending");
    expect(pending.ok).toBe(true);
    if (pending.ok) {
      expect(pending.value.some((a) => a.subjectKind === "external_action")).toBe(true);
    }
  }, 120_000);
});
