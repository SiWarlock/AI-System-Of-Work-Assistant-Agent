// Task 11.1 slice 2b — the REAL ingestion sourceCommit (KnowledgeWriter sole-writer path)
// wired over the durable slice-2a KnowledgeRevisionStore. spec(§13) spec(§6) spec(§16) spec(§4)
//
// Fast unit (NO Temporal): drives the source-ingestion `sourceCommit` delegate that
// `buildProofSpineActivities` exposes, over a REAL `assembleBackends` (real fs vault + real
// operational store) + the durable 2a store adapter. It proves the fake→real swap:
//   • real KnowledgeWriter commit (a rev:<sha> id + a durable record), NOT the in-memory fake;
//   • DURABLE idempotency across a (simulated) worker restart — a fresh backends over the SAME
//     operational db replays the prior revision (the exactly-once substrate; the fake's per-
//     process Map fails this);
//   • FAIL-CLOSED — a durable-store rejection folds to `commit_failed` (createCommitActivity's
//     §16 catch), never a silent proceed / re-commit;
//   • WS-8 — the idempotencyKey (`kw:commit:${planId}`) is workspace-distinct and the durable
//     revision stamps the routing-BOUND workspace.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, afterEach } from "vitest";
import { ok, err, workspaceId, workflowId, sourceId } from "@sow/contracts";
import type { WorkspaceId, WorkflowRunRef, SourceRef, SourceId } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import type {
  ValidatedExtraction,
  AgentExtraction,
  MeetingJobInputs,
  SourceNoteIdentity,
} from "@sow/workflows";
import { computeRevisionId } from "@sow/knowledge";
import type { KnowledgeRevisionRepository } from "@sow/db";
import { assembleBackends } from "../../src/composition/backends";
import { buildProofSpineActivities } from "../../src/composition/buildActivities";
import type { ProofSpineParams } from "../../src/composition/buildActivities";
import { createKnowledgeRevisionStoreAdapter } from "../../src/composition/knowledgeRevisionStore";
import type { KnowledgeRevisionStore } from "@sow/knowledge";

const NOW = "2026-07-02T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const SRC_WS: WorkspaceId = workspaceId("ws-src");
const EMPTY_VAULT_REVISION = computeRevisionId(new Map());
// The source build derives the plan from the BINDING (WS-2/WS-4 stamp), ignoring this arg.
const VALIDATED = {} as unknown as ValidatedExtraction;

const runRef: WorkflowRunRef = {
  workflowId: workflowId("wf-2b"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:2b",
  auditRefs: [],
};
const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-2b"),
  workspaceId: SRC_WS,
  capability: "meeting.close",
  outputSchemaId: "sow:meeting.close.output",
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:meeting:2b",
};
const meetingExtraction: AgentExtraction = {
  fields: { title: { value: "n/a", evidenceRef: "src:2b#0" } },
};
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
const sourceRef: SourceRef = { sourceId: sourceId("src-2b") };

/** ProofSpineParams with the source binding; `revisions` is the store under test. */
function paramsFor(revisions: KnowledgeRevisionStore): ProofSpineParams {
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
      expectedBaseRevision: EMPTY_VAULT_REVISION,
    },
    sourceRef,
    planIdentity: { closeout: "meeting:2b" },
    sourceIngestion: {
      boundWorkspaceId: SRC_WS,
      extraction: sourceExtraction,
      sourceRef: { sourceId: sourceId("src-ingest-2b") },
      planIdentity: { ingest: "source:2b" },
    },
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "sow-2b-"));
  tempDirs.push(dir);
  return join(dir, "ops.db");
}

// A stable per-file source identity (slice #46: the build derives the note path + planId from it).
const SRC: SourceNoteIdentity = {
  sourceId: sourceId("file:ws-src:notes/2b.md") as SourceId,
  contentHash: "sha256:2b",
};
async function derivePlan(
  acts: ReturnType<typeof buildProofSpineActivities>,
  ws: WorkspaceId,
  source: SourceNoteIdentity = SRC,
) {
  const built = await acts.sourceBuildOutputs(VALIDATED, ws, source);
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error("sourceBuildOutputs failed");
  return built.value.plan;
}

describe("real sourceCommit — KnowledgeWriter sole-writer commit + durable 2a store (2b)", () => {
  it("commits through the REAL KnowledgeWriter (rev:<sha> id + durable record), NOT the in-memory fake", async () => {
    const backends = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT], dbPath: tempDbPath() },
      { candidateOutput: {} },
    );
    try {
      const store = createKnowledgeRevisionStoreAdapter(backends.repos.knowledgeRevisions);
      const acts = buildProofSpineActivities(backends, paramsFor(store));
      const plan = await derivePlan(acts, SRC_WS);

      const committed = await acts.sourceCommit(plan);
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;
      // A real content-addressed writer revision — NOT the fake's `rev-source-N` counter.
      expect(committed.value.revisionId).toMatch(/^rev:/);
      expect(committed.value.revisionId).not.toMatch(/^rev-source-/);
      expect(committed.value.replayed).toBe(false);
      // The Markdown is really on disk (the sole-writer commit ran) — at the per-source note path
      // the build derived (slice #46: content-addressed under sources/<ws>/, not a fixed name).
      const notePath = plan.creates[0]?.path;
      expect(notePath).toMatch(new RegExp(`^sources/${String(SRC_WS)}/[0-9a-f]+\\.md$`));
      const onDisk = notePath === undefined ? undefined : await backends.vault.read(notePath);
      expect(onDisk).toBeDefined();
      // The durable store recorded the revision under kw:commit:<planId>.
      const rec = await store.getByIdempotencyKey(`kw:commit:${String(plan.planId)}`);
      expect(rec?.revisionId).toBe(committed.value.revisionId);
    } finally {
      backends.close();
    }
  });

  it("durable idempotent across a RESTART — a fresh backends over the SAME db replays the prior revision (one commit)", async () => {
    const dbPath = tempDbPath();
    // ── worker run #1: real commit, record in the durable operational store, SHUT DOWN ──
    const b1 = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT], dbPath },
      { candidateOutput: {} },
    );
    const store1 = createKnowledgeRevisionStoreAdapter(b1.repos.knowledgeRevisions);
    const acts1 = buildProofSpineActivities(b1, paramsFor(store1));
    const plan = await derivePlan(acts1, SRC_WS);
    const c1 = await acts1.sourceCommit(plan);
    expect(c1.ok).toBe(true);
    if (!c1.ok) return;
    expect(c1.value.replayed).toBe(false);
    b1.close(); // the worker exits — an in-memory Map store would vanish here

    // ── worker run #2 (RESTART): fresh backends over the SAME db → the durable store replays ──
    const b2 = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT], dbPath },
      { candidateOutput: {} },
    );
    try {
      const store2 = createKnowledgeRevisionStoreAdapter(b2.repos.knowledgeRevisions);
      const acts2 = buildProofSpineActivities(b2, paramsFor(store2));
      const c2 = await acts2.sourceCommit(plan);
      expect(c2.ok).toBe(true);
      if (!c2.ok) return;
      // ONE durable revision: the second run REPLAYS the first (no duplicate Markdown commit).
      expect(c2.value.replayed).toBe(true);
      expect(c2.value.revisionId).toBe(c1.value.revisionId);
    } finally {
      b2.close();
    }
  });

  it("fail-closed: a durable-store rejection ⇒ sourceCommit → commit_failed (never a silent proceed / re-commit)", async () => {
    const backends = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] },
      { candidateOutput: {} },
    );
    try {
      // The pre-write idempotency lookup faults → the 2a adapter REJECTS → applyPlan throws →
      // createCommitActivity's §16 catch folds it to commit_failed (no write, no re-commit).
      const rejectingRepo: KnowledgeRevisionRepository = {
        getByIdempotencyKey: () => Promise.resolve(err({ code: "unavailable", message: "down" })),
        record: () => Promise.resolve(ok(undefined)),
      };
      const store = createKnowledgeRevisionStoreAdapter(rejectingRepo);
      const acts = buildProofSpineActivities(backends, paramsFor(store));
      const plan = await derivePlan(acts, SRC_WS);
      const committed = await acts.sourceCommit(plan);
      expect(committed.ok).toBe(false);
      if (committed.ok) return;
      expect(committed.error.code).toBe("commit_failed");
    } finally {
      backends.close();
    }
  });

  it("WS-8: the idempotencyKey is workspace-distinct + the durable revision stamps the BOUND workspace", async () => {
    const backends = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT], dbPath: tempDbPath() },
      { candidateOutput: {} },
    );
    try {
      const store = createKnowledgeRevisionStoreAdapter(backends.repos.knowledgeRevisions);
      const acts = buildProofSpineActivities(backends, paramsFor(store));
      // Two plans bound to DIFFERENT workspaces: the planId incorporates ${ws}, so the derived
      // idempotencyKey (kw:commit:${planId}) is workspace-distinct — no cross-workspace collision
      // in the globally-keyed 2a store.
      const planA = await derivePlan(acts, SRC_WS);
      const planB = await derivePlan(acts, workspaceId("ws-other"));
      expect(planA.planId).not.toBe(planB.planId);
      expect(planA.workspaceId).toBe(String(SRC_WS));
      expect(planB.workspaceId).toBe("ws-other");

      // Commit planA; the durable revision's AuditRecord carries the routing-BOUND workspace.
      const committed = await acts.sourceCommit(planA);
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;
      const rec = await store.getByIdempotencyKey(`kw:commit:${String(planA.planId)}`);
      expect(rec?.auditRecord.workspaceId).toBe(String(SRC_WS));
    } finally {
      backends.close();
    }
  });
});
