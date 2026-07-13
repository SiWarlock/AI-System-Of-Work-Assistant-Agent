// Task 11.1 slice #46 — the ingestion build derives a PER-FILE note (distinct files → distinct
// notes), driven end-to-end through `buildProofSpineActivities`' source delegate. spec(§13) spec(§16)
//
// The mechanism: the source build now receives the per-file SourceNoteIdentity (threaded from the
// driver's context.source) and derives BOTH the traversal-safe content-addressed note path AND the
// planId from it — so two distinct dropped files become two distinct durable notes (a fixed path
// collapsed every file to one), while a same-file same-content re-drop derives the SAME identity
// (→ the durable revision store replays; no duplicate). Also pins: WS-8 (path/planId stamped from
// the routing-bound ws), real per-file sourceRefs, minimal note, and the candidate-gate ≥1 sourceRef.
import { describe, it, expect } from "vitest";
import { workspaceId, workflowId, sourceId, KnowledgeMutationPlanSchema } from "@sow/contracts";
import type { WorkspaceId, WorkflowRunRef, SourceRef } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import type {
  ValidatedExtraction,
  SourceNoteIdentity,
  AgentExtraction,
  MeetingJobInputs,
} from "@sow/workflows";
import { assembleBackends } from "../../src/composition/backends";
import { buildProofSpineActivities } from "../../src/composition/buildActivities";
import type { ProofSpineParams } from "../../src/composition/buildActivities";

const NOW = "2026-07-02T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const SRC_WS: WorkspaceId = workspaceId("ws-src");
const VALIDATED = {} as unknown as ValidatedExtraction;
const runRef: WorkflowRunRef = {
  workflowId: workflowId("wf-46"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:46",
  auditRefs: [],
};
const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-46"),
  workspaceId: SRC_WS,
  capability: "meeting.close",
  outputSchemaId: "sow:meeting.close.output",
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:meeting:46",
};
const meetingExtraction: AgentExtraction = { fields: { title: { value: "n/a", evidenceRef: "s#0" } } };
const sourceExtraction: AgentExtraction = {
  fields: { owner: { value: "Bob", evidenceRef: "source#L12" }, dueDate: { value: TBD } },
  schemaId: "sow:source-ingest-output",
};
const resolved: ResolvedWorkspacePolicy = {
  workspaceId: String(SRC_WS),
  type: "personal_business",
  dataOwner: "user",
  defaultVisibility: "coordination",
  egressPolicy: {
    workspaceId: SRC_WS,
    allowedProcessors: [],
    rawContentAllowedProcessors: [],
    employerRawEgressAcknowledged: false,
  },
  providerMatrix: {
    workspaceId: SRC_WS,
    allowedProviders: [],
    capabilityDefaults: {} as ResolvedWorkspacePolicy["providerMatrix"]["capabilityDefaults"],
    rawCloudEgressEnabled: false,
  },
};
const sourceRef: SourceRef = { sourceId: sourceId("src-46") };
function paramsFor(): ProofSpineParams {
  const revisions = {
    getByIdempotencyKey: () => Promise.resolve(undefined),
    record: () => Promise.resolve(),
  };
  return {
    resolved,
    correlationSignals: { confidence: 0.95, workspaceId: SRC_WS },
    meetingJobInputs,
    meetingExtraction,
    revisions,
    commit: {
      actor: "worker:autoingest",
      sourceEventRef: "evt:autoingest",
      workflowRunRef: runRef,
      expectedBaseRevision: "rev:base",
    },
    sourceRef,
    planIdentity: { closeout: "meeting:46" },
    sourceIngestion: {
      boundWorkspaceId: SRC_WS,
      extraction: sourceExtraction,
      sourceRef: { sourceId: sourceId("src-ingest-46") },
      planIdentity: { ingest: "source:46" },
    },
  } as unknown as ProofSpineParams;
}

const src = (id: string, contentHash = "sha256:c1"): SourceNoteIdentity => ({
  sourceId: sourceId(id),
  contentHash,
});
async function build(
  acts: ReturnType<typeof buildProofSpineActivities>,
  ws: WorkspaceId,
  source: SourceNoteIdentity,
) {
  const r = await acts.sourceBuildOutputs(VALIDATED, ws, source);
  if (!r.ok) throw new Error(`sourceBuildOutputs failed: ${JSON.stringify(r.error)}`);
  return r.value.plan;
}

describe("per-source ingestion build — distinct files → distinct notes (§13/#46)", () => {
  it("two DISTINCT sources into the same ws → DIFFERENT creates[].path AND DIFFERENT planId", async () => {
    const backends = await assembleBackends({ now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] }, { candidateOutput: {} });
    try {
      const acts = buildProofSpineActivities(backends, paramsFor());
      const a = await build(acts, SRC_WS, src("file:ws-src:a.md"));
      const b = await build(acts, SRC_WS, src("file:ws-src:b.md"));
      expect(a.creates[0]?.path).not.toBe(b.creates[0]?.path);
      expect(a.planId).not.toBe(b.planId);
    } finally {
      backends.close();
    }
  });

  it("same source + same content → SAME path AND SAME planId (→ durable replay, no duplicate)", async () => {
    const backends = await assembleBackends({ now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] }, { candidateOutput: {} });
    try {
      const acts = buildProofSpineActivities(backends, paramsFor());
      const a = await build(acts, SRC_WS, src("file:ws-src:a.md", "sha256:v1"));
      const again = await build(acts, SRC_WS, src("file:ws-src:a.md", "sha256:v1"));
      expect(again.creates[0]?.path).toBe(a.creates[0]?.path);
      expect(again.planId).toBe(a.planId);
      // an EDITED file (new content) diverges → a new note (lossless)
      const edited = await build(acts, SRC_WS, src("file:ws-src:a.md", "sha256:v2"));
      expect(edited.creates[0]?.path).not.toBe(a.creates[0]?.path);
      expect(edited.planId).not.toBe(a.planId);
    } finally {
      backends.close();
    }
  });

  it("WS-8: path under sources/<bound ws>/, planId carries ws, and the plan is candidate-gate valid", async () => {
    const backends = await assembleBackends({ now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] }, { candidateOutput: {} });
    try {
      const acts = buildProofSpineActivities(backends, paramsFor());
      const plan = await build(acts, SRC_WS, src("file:ws-src:a.md"));
      expect(plan.creates[0]?.path.startsWith(`sources/${String(SRC_WS)}/`)).toBe(true);
      expect(plan.workspaceId).toBe(String(SRC_WS));
      expect(plan.planId).toContain(String(SRC_WS));
      // honest per-file traceability + a minimal note derived from the source identity
      expect(plan.sourceRefs).toEqual([{ sourceId: "file:ws-src:a.md" }]);
      expect(plan.creates[0]?.title).toContain("file:ws-src:a.md");
      // the derived plan passes the frozen KnowledgeMutationPlan schema (≥1 sourceRef, etc.)
      expect(KnowledgeMutationPlanSchema.safeParse(plan).success).toBe(true);
    } finally {
      backends.close();
    }
  });

  it("fail-closed: an unsafe ws segment ⇒ the build returns build_failed (the helper's err is honored, no escaping path)", async () => {
    const backends = await assembleBackends({ now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] }, { candidateOutput: {} });
    try {
      const acts = buildProofSpineActivities(backends, paramsFor());
      // `workspaceId("..")` passes the brand constructor (charset-unvalidated) but the note-path
      // helper rejects it → the build folds that to build_failed (never a `sources/../…` escape).
      const r = await acts.sourceBuildOutputs(VALIDATED, workspaceId(".."), src("file:x:a.md"));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("build_failed");
    } finally {
      backends.close();
    }
  });

  it("the SAME source into DIFFERENT workspaces → distinct planId + distinct path prefix (WS-8 no collision)", async () => {
    const backends = await assembleBackends({ now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] }, { candidateOutput: {} });
    try {
      const acts = buildProofSpineActivities(backends, paramsFor());
      const inA = await build(acts, workspaceId("ws-a"), src("file:x:a.md"));
      const inB = await build(acts, workspaceId("ws-b"), src("file:x:a.md"));
      expect(inA.planId).not.toBe(inB.planId);
      expect(inA.creates[0]?.path.startsWith("sources/ws-a/")).toBe(true);
      expect(inB.creates[0]?.path.startsWith("sources/ws-b/")).toBe(true);
    } finally {
      backends.close();
    }
  });
});
