// Task 15.3 — the source-ingestion note projection builds the REAL note body (+minimal frontmatter)
// from the gate-validated SourceEnvelope.body (15.2), replacing the `body: "source ingestion (C1)"`
// placeholder. Driven end-to-end through `buildProofSpineActivities`' source delegate (the same
// harness as perSourceNotePath.test.ts). spec(§19.2) spec(§6) spec(§8)
//
// SAFETY (security-reviewer=invariant):
//   - candidate-gate (rule 2): the body written is the GATE-VALIDATED SourceEnvelope.body (threaded
//     as an explicit build param from the driver's context.source.body — already cleared the §8/15.2
//     schema gate); the projection adds NO raw-around-the-gate path.
//   - traversal-safety (WS-8): the note PATH derives ONLY from SourceNoteIdentity — `body` is a
//     SEPARATE param that NEVER reaches deriveSourceNotePath; a hostile body can't traverse.
//   - one-writer (rule 1): build() only fills the plan's creates[0].body/frontmatter; the commit
//     still flows through the unchanged real KnowledgeWriter applyPlan (no new writer here).
//   - Lesson 15: an ABSENT body degrades to a safe minimal real note (honest marker), never the old
//     placeholder and never a failure.
import { describe, it, expect } from "vitest";
import { workspaceId, workflowId, sourceId, KnowledgeMutationPlanSchema } from "@sow/contracts";
import type { WorkspaceId, WorkflowRunRef, SourceRef } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import type { ValidatedExtraction, SourceNoteIdentity, AgentExtraction, MeetingJobInputs } from "@sow/workflows";
import { assembleBackends } from "../../src/composition/backends";
import { buildProofSpineActivities } from "../../src/composition/buildActivities";
import type { ProofSpineParams } from "../../src/composition/buildActivities";

const NOW = "2026-07-02T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const SRC_WS: WorkspaceId = workspaceId("ws-src");
const PLACEHOLDER = "source ingestion (C1)";
const VALIDATED = {} as unknown as ValidatedExtraction;
const runRef: WorkflowRunRef = {
  workflowId: workflowId("wf-153"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:153",
  auditRefs: [],
};
const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-153"),
  workspaceId: SRC_WS,
  capability: "meeting.close",
  outputSchemaId: "sow:meeting.close.output",
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:meeting:153",
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
  egressPolicy: { workspaceId: SRC_WS, allowedProcessors: [], rawContentAllowedProcessors: [], employerRawEgressAcknowledged: false },
  providerMatrix: {
    workspaceId: SRC_WS,
    allowedProviders: [],
    capabilityDefaults: {} as ResolvedWorkspacePolicy["providerMatrix"]["capabilityDefaults"],
    rawCloudEgressEnabled: false,
  },
};
const sourceRef: SourceRef = { sourceId: sourceId("src-153") };
function paramsFor(): ProofSpineParams {
  return {
    resolved,
    correlationSignals: { confidence: 0.95, workspaceId: SRC_WS },
    meetingJobInputs,
    meetingExtraction,
    revisions: { getByIdempotencyKey: () => Promise.resolve(undefined), record: () => Promise.resolve() },
    commit: { actor: "worker:autoingest", sourceEventRef: "evt:autoingest", workflowRunRef: runRef, expectedBaseRevision: "rev:base" },
    sourceRef,
    planIdentity: { closeout: "meeting:153" },
    sourceIngestion: {
      boundWorkspaceId: SRC_WS,
      extraction: sourceExtraction,
      sourceRef: { sourceId: sourceId("src-ingest-153") },
      planIdentity: { ingest: "source:153" },
    },
  } as unknown as ProofSpineParams;
}

const src = (id: string, contentHash = "sha256:c1"): SourceNoteIdentity => ({ sourceId: sourceId(id), contentHash });

async function buildNote(
  acts: ReturnType<typeof buildProofSpineActivities>,
  ws: WorkspaceId,
  source: SourceNoteIdentity,
  body?: string,
) {
  const r = await acts.sourceBuildOutputs(VALIDATED, ws, source, body);
  if (!r.ok) throw new Error(`sourceBuildOutputs failed: ${JSON.stringify(r.error)}`);
  return r.value.plan;
}

describe("source note-body projection (15.3 — real body from gate-validated SourceEnvelope.body)", () => {
  it("note_body_is_real_content_when_source_has_body: a source WITH body ⇒ creates[0].body is that gate-validated content (not the placeholder) [spec(§19.2)]", async () => {
    const backends = await assembleBackends({ now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] }, { candidateOutput: {} });
    try {
      const acts = buildProofSpineActivities(backends, paramsFor());
      const real = "# Meeting notes\n\nDiscussed the Q3 roadmap and the launch date.";
      const plan = await buildNote(acts, SRC_WS, src("file:ws-src:a.md"), real);
      expect(plan.creates[0]?.body).toBe(real);
      expect(plan.creates[0]?.body).not.toBe(PLACEHOLDER);
      // the derived plan still passes the frozen KnowledgeMutationPlan schema.
      expect(KnowledgeMutationPlanSchema.safeParse(plan).success).toBe(true);
    } finally {
      backends.close();
    }
  });

  it("note_body_degrades_safely_when_body_absent: a source WITHOUT body ⇒ a safe minimal real note (honest marker), NOT the placeholder, NOT empty, NOT a failure [Lesson 15]", async () => {
    const backends = await assembleBackends({ now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] }, { candidateOutput: {} });
    try {
      const acts = buildProofSpineActivities(backends, paramsFor());
      const plan = await buildNote(acts, SRC_WS, src("file:ws-src:a.md")); // no body
      const body = plan.creates[0]?.body ?? "";
      expect(body).not.toBe(PLACEHOLDER); // never the old placeholder
      expect(body.length).toBeGreaterThan(0); // a real minimal note, not empty
      expect(KnowledgeMutationPlanSchema.safeParse(plan).success).toBe(true); // still a valid plan (no failure)
    } finally {
      backends.close();
    }
  });

  it("note_body_degrades_when_body_is_empty_string: an EMPTY-STRING body ⇒ the same safe minimal note (empty content collapses to the honest marker, not a verbatim empty note) [Lesson 15]", async () => {
    const backends = await assembleBackends({ now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] }, { candidateOutput: {} });
    try {
      const acts = buildProofSpineActivities(backends, paramsFor());
      const plan = await buildNote(acts, SRC_WS, src("file:ws-src:a.md"), ""); // gate-valid empty-string body
      const body = plan.creates[0]?.body ?? "";
      expect(body).not.toBe(PLACEHOLDER);
      expect(body.length).toBeGreaterThan(0); // empty collapses to the honest marker (pins the length>0 guard)
      expect(KnowledgeMutationPlanSchema.safeParse(plan).success).toBe(true);
    } finally {
      backends.close();
    }
  });

  it("note_path_is_body_independent: two builds with the SAME SourceNoteIdentity but DIFFERENT body ⇒ SAME path AND SAME planId (body never reaches the path — WS-8/traversal) [spec(§6)]", async () => {
    const backends = await assembleBackends({ now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] }, { candidateOutput: {} });
    try {
      const acts = buildProofSpineActivities(backends, paramsFor());
      const withA = await buildNote(acts, SRC_WS, src("file:ws-src:a.md", "sha256:v1"), "body A");
      const withB = await buildNote(acts, SRC_WS, src("file:ws-src:a.md", "sha256:v1"), "body B ../../etc/passwd\nmulti-line");
      expect(withB.creates[0]?.path).toBe(withA.creates[0]?.path); // identical path — body-independent
      expect(withB.planId).toBe(withA.planId); // identical planId — body-independent
    } finally {
      backends.close();
    }
  });

  it("body_written_is_exactly_the_threaded_gate_validated_value: the projection consumes ONLY the threaded body param verbatim — no raw-around-the-gate transform (rule 2) [spec(§8)]", async () => {
    const backends = await assembleBackends({ now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] }, { candidateOutput: {} });
    try {
      const acts = buildProofSpineActivities(backends, paramsFor());
      const gateValidated = "exact gate-validated body — verbatim";
      const plan = await buildNote(acts, SRC_WS, src("file:ws-src:a.md"), gateValidated);
      expect(plan.creates[0]?.body).toBe(gateValidated); // verbatim — the ONLY body source is the threaded param
    } finally {
      backends.close();
    }
  });

  it("note_frontmatter_populated_from_source_identity_not_empty: creates[0].frontmatter reflects the source identity (sourceId/contentHash), no longer {} [spec(§19.2)]", async () => {
    const backends = await assembleBackends({ now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] }, { candidateOutput: {} });
    try {
      const acts = buildProofSpineActivities(backends, paramsFor());
      const plan = await buildNote(acts, SRC_WS, src("file:ws-src:a.md", "sha256:fm"), "body");
      const fm = plan.creates[0]?.frontmatter ?? {};
      expect(Object.keys(fm).length).toBeGreaterThan(0); // no longer the empty {}
      expect(JSON.stringify(fm)).toContain("file:ws-src:a.md"); // identity-derived (sourceId)
      expect(JSON.stringify(fm)).toContain("sha256:fm"); // identity-derived (contentHash)
    } finally {
      backends.close();
    }
  });

  it("note_commits_via_real_knowledgewriter_unchanged: build() only PROJECTS a valid plan (creates[0]) — it is not a writer; the plan flows to the unchanged applyPlan commit (rule 1) [spec(§6)]", async () => {
    const backends = await assembleBackends({ now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] }, { candidateOutput: {} });
    try {
      const acts = buildProofSpineActivities(backends, paramsFor());
      const plan = await buildNote(acts, SRC_WS, src("file:ws-src:a.md"), "body");
      // build() is a pure projection: it yields a schema-valid plan with exactly one create + the
      // provenanceOrigin the sole KnowledgeWriter honors; committing is the separate sourceCommit path.
      expect(plan.creates).toHaveLength(1);
      expect(plan.provenanceOrigin).toBe("ingestion");
      expect(KnowledgeMutationPlanSchema.safeParse(plan).success).toBe(true);
    } finally {
      backends.close();
    }
  });
});
