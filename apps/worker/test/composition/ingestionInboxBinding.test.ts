// Task 9.16 — the always-on binding of the read-model ingestion-inbox PRODUCER at the composition
// root (the second "make the daily briefing real" producer leg; sibling to 9.15 recentChanges).
//
// Proves the composition wiring in `buildProofSpineActivities`:
//   • the DEFAULT `ingestionPark` (no `params.ingestionPark`) is the REAL readModels-backed
//     `createIngestionInboxProjectionPort` — a below-threshold park upserts a real `ingestion_inbox`
//     row (NOT the silent no-op stub);
//   • WS-8 (safety rule 4): a park keys the row per the source's OWN workspace — a park for B can
//     never surface in A's inbox;
//   • FAIL-SAFE (LESSON 76/21, §16): a park-store fault never blocks the routing/park decision;
//   • the NEW disposition-remove seam: a triage disposition removes the item — but ONLY after the
//     durable `recordDisposition` CAS succeeds — and a remove fault never fails the durable CAS.
//
// Fast composition unit (NO Temporal, NO network): drives the proof-spine activities DIRECTLY over
// REAL `assembleBackends` (in-memory sqlite). The park is forced with an injected low-confidence
// `contentResolver`; the durable-park precondition is set via the real `meetingPark` activity.
import { describe, it, expect, afterEach } from "vitest";
import { ok, err, isOk, workspaceId, workflowId, sourceId, validSourceEnvelope } from "@sow/contracts";
import type { WorkspaceId, WorkflowRunRef, SourceRef, SourceEnvelope } from "@sow/contracts";
import { computeRevisionId } from "@sow/knowledge";
import type { KnowledgeRevisionStore } from "@sow/knowledge";
import type { AgentExtraction, MeetingJobInputs, CorrelationSignals, SourceIngestionContext } from "@sow/workflows";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import { buildProofSpineActivities, type ProofSpineParams } from "../../src/composition/buildActivities";
import { createKnowledgeRevisionStoreAdapter } from "../../src/composition/knowledgeRevisionStore";
import { READ_MODEL_KEYS, readIngestionItems } from "../../src/api/adapters/readModel";
import type { ContentResolver } from "../../src/composition/content-project-resolver";
import type { IngestionInboxProjectionPort } from "../../src/api/projections/ingestionInboxProjection";

const NOW = "2026-07-24T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const WS_A: WorkspaceId = workspaceId("ws-inbox-a");
const WS_B: WorkspaceId = workspaceId("ws-inbox-b");

// A resolver that ALWAYS parks (sub-threshold, no workspace) — forces the recordPark seam.
const PARK_ALWAYS: ContentResolver = {
  resolve: () => Promise.resolve(ok({ confidence: 0, reason: "forced park (test)" })),
};

const src = (ws: WorkspaceId, id: string): SourceEnvelope => ({
  ...validSourceEnvelope,
  sourceId: sourceId(id),
  workspaceId: ws,
});
const ctxFor = (s: SourceEnvelope): SourceIngestionContext => ({
  source: s,
  workspaceId: s.workspaceId,
  envelopes: [],
});

const runRef: WorkflowRunRef = {
  workflowId: workflowId("wf-9-16"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:9.16",
  auditRefs: [],
};
const resolved: ResolvedWorkspacePolicy = {
  workspaceId: String(WS_A),
  type: "personal_business",
  dataOwner: "user",
  defaultVisibility: "coordination",
  egressPolicy: { workspaceId: WS_A, allowedProcessors: [], rawContentAllowedProcessors: [], employerRawEgressAcknowledged: false },
  providerMatrix: {
    workspaceId: WS_A,
    allowedProviders: [],
    capabilityDefaults: {} as ResolvedWorkspacePolicy["providerMatrix"]["capabilityDefaults"],
    rawCloudEgressEnabled: false,
  },
};
const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-9-16"),
  workspaceId: WS_A,
  capability: "meeting.close",
  outputSchemaId: "sow:meeting.close.output",
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:meeting:9.16",
};
const meetingExtraction: AgentExtraction = { fields: { title: { value: "n/a", evidenceRef: "src#0" } } };
const correlationSignals: CorrelationSignals = { confidence: 0.95, workspaceId: WS_A };
const sourceRef: SourceRef = { sourceId: sourceId("src-9.16") };

/** Minimal-but-complete ProofSpineParams; `over` injects the seams under test. */
function paramsFor(revisions: KnowledgeRevisionStore, over: Partial<ProofSpineParams> = {}): ProofSpineParams {
  return {
    resolved,
    correlationSignals,
    meetingJobInputs,
    meetingExtraction,
    revisions,
    commit: {
      actor: "worker:test",
      sourceEventRef: "evt:test",
      workflowRunRef: runRef,
      expectedBaseRevision: computeRevisionId(new Map()),
    },
    sourceRef,
    planIdentity: { ingest: "source:9.16" },
    contentResolver: PARK_ALWAYS,
    ...over,
  };
}

const open: ProofSpineBackends[] = [];
afterEach(() => {
  for (const b of open.splice(0)) b.close();
});
async function fresh(): Promise<ProofSpineBackends> {
  const b = await assembleBackends({ now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] });
  open.push(b);
  return b;
}
async function inboxIds(b: ProofSpineBackends, ws: WorkspaceId): Promise<readonly string[]> {
  const row = await b.repos.readModels.get(READ_MODEL_KEYS.ingestion, String(ws));
  return isOk(row) ? readIngestionItems(row.value.data).map((i) => i.sourceId) : [];
}

describe("ingestion-inbox producer binding (9.16 — always-on park + disposition-remove at the composition root)", () => {
  it("park_binds_real_readmodel_port: the DEFAULT ingestionPark parks to a REAL ingestion_inbox row (not the no-op stub) — spec(§11) spec(§10)", async () => {
    const b = await fresh();
    const acts = buildProofSpineActivities(b, paramsFor(createKnowledgeRevisionStoreAdapter(b.repos.knowledgeRevisions)));
    const s = src(WS_A, "src-park-real");
    const routed = await acts.sourceRoute(ctxFor(s));
    expect(isOk(routed)).toBe(true); // a below-threshold park is a successful routing decision (low signal)
    expect(await inboxIds(b, WS_A)).toContain(String(s.sourceId)); // the REAL producer wrote the row
  });

  it("park_is_ws8_scoped_foreign_never_lands: a park for B keys B's row and NEVER surfaces in A's inbox — spec(§5) [rule 4]", async () => {
    const b = await fresh();
    const acts = buildProofSpineActivities(b, paramsFor(createKnowledgeRevisionStoreAdapter(b.repos.knowledgeRevisions)));
    const sB = src(WS_B, "src-scoped-b");
    await acts.sourceRoute(ctxFor(sB));
    expect(await inboxIds(b, WS_B)).toContain(String(sB.sourceId)); // lands in B's own row
    expect(await inboxIds(b, WS_A)).not.toContain(String(sB.sourceId)); // never A's
    expect(await inboxIds(b, WS_A)).toHaveLength(0);
  });

  it("park_fault_is_failsafe_never_blocks_routing: a recordPark fault (err OR throw) never fails the routing decision — spec(§16) [LESSON 76/21]", async () => {
    const b = await fresh();
    const revisions = createKnowledgeRevisionStoreAdapter(b.repos.knowledgeRevisions);
    const errPort: IngestionInboxProjectionPort = {
      recordPark: () => Promise.resolve(err({ code: "ingestion_inbox_write_failed", message: "boom" })),
      recordDisposition: () => Promise.resolve(ok(undefined)),
    };
    const throwPort: IngestionInboxProjectionPort = {
      recordPark: () => { throw new Error("kaboom"); },
      recordDisposition: () => Promise.resolve(ok(undefined)),
    };
    for (const ingestionPark of [errPort, throwPort]) {
      const acts = buildProofSpineActivities(b, paramsFor(revisions, { ingestionPark }));
      const routed = await acts.sourceRoute(ctxFor(src(WS_A, "src-failsafe")));
      expect(isOk(routed)).toBe(true); // routing decision unaffected by an inbox-write fault
    }
  });

  it("disposition_removes_item_after_durable_record: a triage disposition removes the parked item, AFTER the durable CAS records — spec(§11)", async () => {
    const b = await fresh();
    const acts = buildProofSpineActivities(b, paramsFor(createKnowledgeRevisionStoreAdapter(b.repos.knowledgeRevisions)));
    const s = src(WS_A, "src-dispose");
    await acts.sourceRoute(ctxFor(s)); // read-model park
    await acts.meetingPark(s, "idem:dispose"); // durable queued_for_review (disposition precondition)
    expect(await inboxIds(b, WS_A)).toContain(String(s.sourceId)); // present before disposition

    const disp = await acts.triageRecordDisposition({ sourceId: String(s.sourceId), workspaceId: WS_A, channel: "mac" });
    expect(isOk(disp)).toBe(true); // the durable CAS recorded
    expect(await inboxIds(b, WS_A)).not.toContain(String(s.sourceId)); // the derived remove cleared the row
  });

  it("disposition_remove_gated_on_durable_success: a NOT-durably-parked disposition (not_parked) leaves the inbox item in place — spec(§11)", async () => {
    const b = await fresh();
    const acts = buildProofSpineActivities(b, paramsFor(createKnowledgeRevisionStoreAdapter(b.repos.knowledgeRevisions)));
    const s = src(WS_A, "src-not-parked");
    await acts.sourceRoute(ctxFor(s)); // read-model park, but NO durable meetingPark
    const disp = await acts.triageRecordDisposition({ sourceId: String(s.sourceId), workspaceId: WS_A, channel: "mac" });
    expect(isOk(disp)).toBe(false); // durable CAS fails closed (not_parked)
    expect(await inboxIds(b, WS_A)).toContain(String(s.sourceId)); // remove NEVER ran → item stays
  });

  it("disposition_remove_fault_is_failsafe: a recordDisposition (inbox-remove) fault (err OR throw) never fails the durable disposition — spec(§16) [LESSON 21]", async () => {
    const b = await fresh();
    const revisions = createKnowledgeRevisionStoreAdapter(b.repos.knowledgeRevisions);
    const errRemove: IngestionInboxProjectionPort = {
      recordPark: () => Promise.resolve(ok(undefined)),
      recordDisposition: () => Promise.resolve(err({ code: "ingestion_inbox_write_failed", message: "remove err" })),
    };
    const throwRemove: IngestionInboxProjectionPort = {
      recordPark: () => Promise.resolve(ok(undefined)),
      recordDisposition: () => { throw new Error("remove kaboom"); },
    };
    let n = 0;
    for (const ingestionPark of [errRemove, throwRemove]) {
      const acts = buildProofSpineActivities(b, paramsFor(revisions, { ingestionPark }));
      const s = src(WS_A, `src-remove-failsafe-${n++}`);
      await acts.meetingPark(s, `idem:remove-failsafe-${n}`); // durable precondition
      const disp = await acts.triageRecordDisposition({ sourceId: String(s.sourceId), workspaceId: WS_A, channel: "mac" });
      expect(isOk(disp)).toBe(true); // durable CAS unaffected by the read-model remove fault
    }
  });

  it("disposition_remove_ws8_scoped_divergent_ws_no_cross_touch: a disposition whose workspaceId (B) DIVERGES from the source's parked ws (A) removes from B's row only — A's inbox is NEVER cross-touched (item lingers = the documented liveness residual; zero cross-ws touch = the WS-8 safety) — spec(§5) [rule 4]", async () => {
    const b = await fresh();
    const acts = buildProofSpineActivities(b, paramsFor(createKnowledgeRevisionStoreAdapter(b.repos.knowledgeRevisions)));
    const s = src(WS_A, "src-divergent"); // parked UNDER A (recordPark keys per source.workspaceId)
    await acts.sourceRoute(ctxFor(s)); // read-model park in A's row
    await acts.meetingPark(s, "idem:divergent"); // durable precondition (workspace-unbound, keyed by sourceId)
    expect(await inboxIds(b, WS_A)).toContain(String(s.sourceId));

    // The owner reroutes to B — disposition.workspaceId = B ≠ the parked ws A.
    const disp = await acts.triageRecordDisposition({ sourceId: String(s.sourceId), workspaceId: WS_B, channel: "mac" });
    expect(isOk(disp)).toBe(true); // durable CAS records (by sourceId)
    // Zero cross-ws touch (the WS-8 safety): the B-scoped remove structurally cannot reach A's row.
    expect(await inboxIds(b, WS_A)).toContain(String(s.sourceId)); // A UNTOUCHED — item lingers (documented residual)
    expect(await inboxIds(b, WS_B)).not.toContain(String(s.sourceId)); // B's row never held it (remove was a no-op)
  });
});
