// 9.16 (Step-7.5 reachability) — a REAL activity-direct park surfaces on the SERVED ingestion-inbox
// query, and a REAL triage disposition clears it. Drives the proof-spine activities DIRECTLY (no
// Temporal, no network): register the workspace → sourceRoute (below-threshold park) → the served
// `queries.ingestionInbox` returns the item → meetingPark (durable precondition) + triageRecordDisposition
// → the served query returns empty. Proves the producer is reachable end-to-end on the served read path
// ("real data appears, then clears"), not just from its own unit tests. Mirrors recentChangesProducer-live.
// spec(§11 / §10)
import { describe, it, expect } from "vitest";
import { ok, isOk, workspaceId, workflowId, sourceId, validSourceEnvelope } from "@sow/contracts";
import type { WorkspaceId, WorkflowRunRef, SourceRef, SourceEnvelope } from "@sow/contracts";
import { computeRevisionId } from "@sow/knowledge";
import type { AgentExtraction, MeetingJobInputs, CorrelationSignals, SourceIngestionContext } from "@sow/workflows";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import { assembleBackends } from "../../src/composition/backends";
import { buildProofSpineActivities, type ProofSpineParams } from "../../src/composition/buildActivities";
import { createKnowledgeRevisionStoreAdapter } from "../../src/composition/knowledgeRevisionStore";
import { createDbReadModelQueryPort } from "../../src/api/adapters/readModel";
import { registerWorkspace } from "../../src/composition/workspaceRegistry";
import type { ContentResolver } from "../../src/composition/content-project-resolver";

const NOW = "2026-07-24T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const WS: WorkspaceId = workspaceId("ws-inbox-live");

const PARK_ALWAYS: ContentResolver = {
  resolve: () => Promise.resolve(ok({ confidence: 0, reason: "forced park (live test)" })),
};
const source: SourceEnvelope = { ...validSourceEnvelope, sourceId: sourceId("src-inbox-live"), workspaceId: WS };
const ctx: SourceIngestionContext = { source, workspaceId: WS, envelopes: [] };

const runRef: WorkflowRunRef = {
  workflowId: workflowId("wf-9-16-live"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:9.16-live",
  auditRefs: [],
};
const resolved: ResolvedWorkspacePolicy = {
  workspaceId: String(WS),
  type: "personal_business",
  dataOwner: "user",
  defaultVisibility: "coordination",
  egressPolicy: { workspaceId: WS, allowedProcessors: [], rawContentAllowedProcessors: [], employerRawEgressAcknowledged: false },
  providerMatrix: {
    workspaceId: WS,
    allowedProviders: [],
    capabilityDefaults: {} as ResolvedWorkspacePolicy["providerMatrix"]["capabilityDefaults"],
    rawCloudEgressEnabled: false,
  },
};
const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-9-16-live"),
  workspaceId: WS,
  capability: "meeting.close",
  outputSchemaId: "sow:meeting.close.output",
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:meeting:9.16-live",
};
const meetingExtraction: AgentExtraction = { fields: { title: { value: "n/a", evidenceRef: "src#0" } } };
const correlationSignals: CorrelationSignals = { confidence: 0.95, workspaceId: WS };
const sourceRef: SourceRef = { sourceId: sourceId("src-9.16-live") };

function paramsFor(revisions: ReturnType<typeof createKnowledgeRevisionStoreAdapter>): ProofSpineParams {
  return {
    resolved,
    correlationSignals,
    meetingJobInputs,
    meetingExtraction,
    revisions,
    commit: { actor: "worker:test", sourceEventRef: "evt:test", workflowRunRef: runRef, expectedBaseRevision: computeRevisionId(new Map()) },
    sourceRef,
    planIdentity: { ingest: "source:9.16-live" },
    contentResolver: PARK_ALWAYS,
  };
}

describe("ingestion-inbox producer — a real park surfaces on the served query, then a disposition clears it", () => {
  it("real_park_surfaces_then_disposition_clears — spec(§11 / §10)", async () => {
    const backends = await assembleBackends({ now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] });
    try {
      // Register WS in the fail-closed registry (the production union path) so the SERVED query
      // resolves it (WS-8 visibility authority).
      await registerWorkspace(backends.repos.readModels, String(WS), NOW);
      const queries = createDbReadModelQueryPort({
        readModels: backends.repos.readModels,
        approvals: backends.repos.approvals,
        audit: backends.repos.audit,
      });
      const acts = buildProofSpineActivities(backends, paramsFor(createKnowledgeRevisionStoreAdapter(backends.repos.knowledgeRevisions)));

      // Real below-threshold park → the served ingestion-inbox query returns the item.
      const routed = await acts.sourceRoute(ctx);
      expect(isOk(routed)).toBe(true);
      const afterPark = await queries.ingestionInbox(String(WS));
      expect(isOk(afterPark)).toBe(true);
      if (isOk(afterPark)) {
        expect(afterPark.value.map((i) => i.sourceId)).toContain(String(source.sourceId));
      }

      // Durably park (disposition precondition), then a real triage disposition clears the served inbox.
      await acts.meetingPark(source, "idem:9.16-live");
      const disp = await acts.triageRecordDisposition({ sourceId: String(source.sourceId), workspaceId: WS, channel: "mac" });
      expect(isOk(disp)).toBe(true);
      const afterDisp = await queries.ingestionInbox(String(WS));
      expect(isOk(afterDisp)).toBe(true);
      if (isOk(afterDisp)) {
        expect(afterDisp.value.map((i) => i.sourceId)).not.toContain(String(source.sourceId));
      }
    } finally {
      backends.close();
    }
  });
});
