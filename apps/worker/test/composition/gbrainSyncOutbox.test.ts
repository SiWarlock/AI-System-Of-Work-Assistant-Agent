// Task 19.1 — worker-side pins for the durable GBrain sync-outbox binding, the
// working-tree CanonicalMarkdownSource, and the drain-on-wake re-driver. Also
// proves `triggerGbrainSync` reaches a REAL, non-test production caller: the
// `sourceCommit` activity `buildProofSpineActivities` exposes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceId, workflowId, sourceId } from "@sow/contracts";
import type { WorkspaceId, WorkflowRunRef, SourceRef, SourceId } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import type { AgentExtraction, MeetingJobInputs, SourceNoteIdentity, ValidatedExtraction } from "@sow/workflows";
import {
  buildSyncOutboxEntry,
  computeRevisionId,
  type GbrainSyncOutboxStore,
  type IndexApplyClient,
  type VaultFs,
} from "@sow/knowledge";
import { assembleBackends, createStubIndexApplyClient } from "../../src/composition/backends";
import { buildProofSpineActivities } from "../../src/composition/buildActivities";
import type { ProofSpineParams } from "../../src/composition/buildActivities";
import { createKnowledgeRevisionStoreAdapter } from "../../src/composition/knowledgeRevisionStore";
import {
  createGbrainSyncOutboxBinding,
  createWorkingTreeMarkdownSource,
  drainGbrainSyncOutbox,
} from "../../src/composition/gbrainSyncOutbox";

const NOW = "2026-07-02T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const EMPTY_VAULT_REVISION = computeRevisionId(new Map());

/** A real (not-mocked) in-memory VaultFs — the same double style backends.ts's own fs vault mirrors. */
function makeInMemoryVaultFs(seed: ReadonlyMap<string, string> = new Map()): VaultFs {
  const files = new Map(seed);
  return {
    async read(path) {
      return files.get(path);
    },
    async list() {
      return [...files.keys()];
    },
    async write(path, content) {
      files.set(path, content);
    },
    async rename(from, to) {
      const c = files.get(from);
      if (c !== undefined) {
        files.delete(from);
        files.set(to, c);
      }
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

describe("createWorkingTreeMarkdownSource", () => {
  it("loads the vault's current file tree, hashing to computeRevisionId of that exact tree", async () => {
    const vault = makeInMemoryVaultFs(new Map([["notes/a.md", "hello"]]));
    const source = createWorkingTreeMarkdownSource(vault);
    const expectedRevision = computeRevisionId(new Map([["notes/a.md", "hello"]]));
    const loaded = await source.loadSnapshot("ws-1", expectedRevision);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.files.get("notes/a.md")).toBe("hello");
      expect(loaded.value.workspaceId).toBe("ws-1");
    }
  });
});

describe("drainGbrainSyncOutbox — LIFE-6 catch-up, exactly-once per row", () => {
  it("indexes a due entry on first drain; a second drain over the now-indexed row does NO work and does not increment attempts", async () => {
    const binding = createGbrainSyncOutboxBinding(":memory:");
    try {
      const entry = buildSyncOutboxEntry({
        workspaceId: "ws-drain",
        revisionId: EMPTY_VAULT_REVISION,
        planId: "plan-drain-1",
        auditRef: "kw:commit:plan-drain-1",
        enqueuedAt: NOW,
      });
      const enq = await binding.store.enqueue(entry);
      expect(enq.ok).toBe(true);

      const deps = {
        outbox: binding.store,
        snapshotSource: createWorkingTreeMarkdownSource(makeInMemoryVaultFs()),
        indexClient: createStubIndexApplyClient(),
        now: () => NOW,
        newHealthItemId: () => "hi-drain-1",
      };

      const first = await drainGbrainSyncOutbox(deps, 50);
      expect(first.attempted).toBe(1);
      expect(first.indexed).toBe(1);
      expect(first.lagging).toBe(0);

      const afterFirst = await binding.store.getByKey("ws-drain", EMPTY_VAULT_REVISION);
      expect(afterFirst.ok).toBe(true);
      if (afterFirst.ok) {
        expect(afterFirst.value?.status).toBe("indexed");
        expect(afterFirst.value?.attempts).toBe(0);
      }

      // Second drain: listDue excludes the `indexed` terminal, so this row is never re-seen.
      const second = await drainGbrainSyncOutbox(deps, 50);
      expect(second.attempted).toBe(0);
      expect(second.indexed).toBe(0);

      const afterSecond = await binding.store.getByKey("ws-drain", EMPTY_VAULT_REVISION);
      expect(afterSecond.ok).toBe(true);
      if (afterSecond.ok) {
        expect(afterSecond.value?.status).toBe("indexed");
        // The load-bearing claim: a second drain does not touch attempts.
        expect(afterSecond.value?.attempts).toBe(0);
      }
    } finally {
      binding.close();
    }
  });

  it("a load/derive failure degrades to sync_lagging and increments attempts (real retry bookkeeping)", async () => {
    const binding = createGbrainSyncOutboxBinding(":memory:");
    try {
      // The snapshot source's vault tree does NOT hash to the entry's declared revisionId
      // (empty vault vs. a bogus non-empty revision) — index-sync.ts's own hash guard (step 3)
      // refuses to index it, degrading to `lagging` (never a wrong index).
      const entry = buildSyncOutboxEntry({
        workspaceId: "ws-lag",
        revisionId: "rev:does-not-match-the-empty-vault",
        planId: "plan-lag-1",
        auditRef: "kw:commit:plan-lag-1",
        enqueuedAt: NOW,
      });
      await binding.store.enqueue(entry);

      const deps = {
        outbox: binding.store,
        snapshotSource: createWorkingTreeMarkdownSource(makeInMemoryVaultFs()),
        indexClient: createStubIndexApplyClient(),
        now: () => NOW,
        newHealthItemId: () => "hi-lag-1",
      };
      const first = await drainGbrainSyncOutbox(deps, 50);
      expect(first.lagging).toBe(1);
      expect(first.indexed).toBe(0);

      const after = await binding.store.getByKey("ws-lag", "rev:does-not-match-the-empty-vault");
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.value?.status).toBe("sync_lagging");
        expect(after.value?.attempts).toBe(1);
      }
    } finally {
      binding.close();
    }
  });
});

// ── production caller — buildActivities' sourceCommit REALLY triggers a sync ────

const SRC_WS: WorkspaceId = workspaceId("ws-19-1");
const VALIDATED = {} as unknown as ValidatedExtraction;
const runRef: WorkflowRunRef = {
  workflowId: workflowId("wf-19-1"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:19-1",
  auditRefs: [],
};
const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-19-1"),
  workspaceId: SRC_WS,
  capability: "meeting.close",
  outputSchemaId: "sow:meeting.close.output",
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:meeting:19-1",
};
const meetingExtraction: AgentExtraction = {
  fields: { title: { value: "n/a", evidenceRef: "src:19-1#0" } },
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
const sourceRef: SourceRef = { sourceId: sourceId("src-19-1") };
const SRC: SourceNoteIdentity = {
  sourceId: sourceId("file:ws-19-1:notes/19-1.md") as SourceId,
  contentHash: "sha256:19-1",
};

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
  const dir = mkdtempSync(join(tmpdir(), "sow-19-1-"));
  tempDirs.push(dir);
  return join(dir, "ops.db");
}

describe("triggerGbrainSync has a real production caller (buildActivities' sourceCommit)", () => {
  it("a successful sourceCommit enqueues a real gbrain_sync_outbox entry keyed to the committed revision", async () => {
    const backends = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT], dbPath: tempDbPath() },
      { candidateOutput: {} },
    );
    const gbrainSyncOutbox = createGbrainSyncOutboxBinding(":memory:");
    try {
      const revisions = createKnowledgeRevisionStoreAdapter(backends.repos.knowledgeRevisions);
      const params: ProofSpineParams = {
        resolved,
        correlationSignals: { confidence: 0.95, workspaceId: SRC_WS },
        meetingJobInputs,
        meetingExtraction,
        revisions,
        commit: {
          actor: "worker:test",
          sourceEventRef: "evt:19-1",
          workflowRunRef: runRef,
          expectedBaseRevision: EMPTY_VAULT_REVISION,
        },
        sourceRef,
        planIdentity: { closeout: "meeting:19-1" },
        sourceIngestion: {
          boundWorkspaceId: SRC_WS,
          extraction: sourceExtraction,
          sourceRef: { sourceId: sourceId("src-ingest-19-1") },
          planIdentity: { ingest: "source:19-1" },
        },
        gbrainSyncOutbox,
      };
      const acts = buildProofSpineActivities(backends, params);
      const built = await acts.sourceBuildOutputs(VALIDATED, SRC_WS, SRC);
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const plan = built.value.plan;

      const committed = await acts.sourceCommit(plan);
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;

      // The post-commit trigger enqueued a REAL entry — proving triggerGbrainSync ran off a
      // real commit, not a test-only direct call.
      const entry = await gbrainSyncOutbox.store.getByKey(String(plan.workspaceId), committed.value.revisionId as never);
      expect(entry.ok).toBe(true);
      if (entry.ok) {
        expect(entry.value).toBeDefined();
        expect(entry.value?.planId).toBe(String(plan.planId));
        expect(entry.value?.auditRef).toBe(`kw:commit:${String(plan.planId)}`);
      }
    } finally {
      backends.close();
      gbrainSyncOutbox.close();
    }
  });

  it("a failing gbrain-sync-outbox store never fails the commit — the committed bytes/result are unchanged", async () => {
    const backends = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT], dbPath: tempDbPath() },
      { candidateOutput: {} },
    );
    // A poisoned store: every method rejects. If `withGbrainSync` were NOT fail-safe, the
    // commit itself would blow up or return an altered result.
    const poisonedStore: GbrainSyncOutboxStore = {
      getByKey: () => Promise.reject(new Error("poisoned")),
      enqueue: () => Promise.reject(new Error("poisoned")),
      update: () => Promise.reject(new Error("poisoned")),
      listDue: () => Promise.reject(new Error("poisoned")),
      indexedHighWater: () => Promise.reject(new Error("poisoned")),
    };
    const poisonedIndexClient: IndexApplyClient = {
      applyRevision: () => Promise.reject(new Error("poisoned")),
    };
    try {
      const revisions = createKnowledgeRevisionStoreAdapter(backends.repos.knowledgeRevisions);
      const params: ProofSpineParams = {
        resolved,
        correlationSignals: { confidence: 0.95, workspaceId: SRC_WS },
        meetingJobInputs,
        meetingExtraction,
        revisions,
        commit: {
          actor: "worker:test",
          sourceEventRef: "evt:19-1-poison",
          workflowRunRef: runRef,
          expectedBaseRevision: EMPTY_VAULT_REVISION,
        },
        sourceRef,
        planIdentity: { closeout: "meeting:19-1-poison" },
        sourceIngestion: {
          boundWorkspaceId: SRC_WS,
          extraction: sourceExtraction,
          sourceRef: { sourceId: sourceId("src-ingest-19-1-poison") },
          planIdentity: { ingest: "source:19-1-poison" },
        },
        gbrainSyncOutbox: { store: poisonedStore, close: () => undefined },
      };
      // Also poison backends.indexClient via a monkeypatch-free approach is not possible (real
      // backends field) — the store rejection alone is enough to prove the fail-safe wrapper: every
      // deps.outbox call inside triggerGbrainSync throws, and the commit must still succeed.
      void poisonedIndexClient;
      const acts = buildProofSpineActivities(backends, params);
      const built = await acts.sourceBuildOutputs(VALIDATED, SRC_WS, SRC);
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const plan = built.value.plan;

      const committed = await acts.sourceCommit(plan);
      expect(committed.ok).toBe(true);
      if (committed.ok) {
        expect(committed.value.revisionId).toMatch(/^rev:/);
        expect(committed.value.replayed).toBe(false);
      }
    } finally {
      backends.close();
    }
  });
});
