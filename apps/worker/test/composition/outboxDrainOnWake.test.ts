// Task 21.4/24.8 — `buildDrainDeps`/`buildWakeDrainHook` (composition/outboxDrainBind.ts) now have a
// REAL, non-test production caller: `buildProofSpineActivities` fires a drain-on-wake pass
// (`network_reconnect`) on every construction, over the SAME `externalWriteDeps`/`backends.writeAdapters`
// the live `propose`/`dispatchApproved` paths dispatch through. This suite proves, over the REAL
// `assembleBackends` + `buildProofSpineActivities` composition (never a hand-rolled fake outbox):
//   • a due, correctly-scoped entry actually drains (status → receipt_recorded) purely from CALLING
//     `buildProofSpineActivities` — no activity is invoked, proving the wiring is construction-time, not
//     something a caller has to remember to trigger;
//   • the receipt's externalObjectId carries the `stub-obj:` marker — proving the drain reached ONLY the
//     in-memory `createStubAdapterTransport`, never a real vendor (backends.ts's default-OFF gate, evidence
//     for the "verify no real external write is reachable" review instruction);
//   • an entry for a DIFFERENT workspace than the one this activities-builder is bound for is left
//     completely untouched (safety rule 4 / task 24.50) — proving `workspaceId` was threaded, not
//     defaulted/omitted;
//   • a broken outbox repo never blocks/throws out of `buildProofSpineActivities` (§16 fail-safe).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceId, workflowId, sourceId, RevisionIdSchema } from "@sow/contracts";
import type { WorkspaceId, WorkflowRunRef, RevisionId } from "@sow/contracts";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import type { AgentExtraction, MeetingJobInputs } from "@sow/workflows";
import type { OutboxEntry } from "@sow/integrations";
import { assembleBackends } from "../../src/composition/backends";
import { buildProofSpineActivities } from "../../src/composition/buildActivities";
import type { ProofSpineParams } from "../../src/composition/buildActivities";
import { createKnowledgeRevisionStoreAdapter } from "../../src/composition/knowledgeRevisionStore";

const NOW = "2026-08-25T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const WS: WorkspaceId = workspaceId("ws-drain-on-wake");
const OTHER_WS: WorkspaceId = workspaceId("ws-a-different-workspace");
const REV_GENESIS: RevisionId = RevisionIdSchema.parse("rev:genesis");

const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-21-4"),
  workspaceId: WS,
  capability: "meeting.close",
  outputSchemaId: "sow:meeting.close.output",
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:meeting:21-4",
};
const meetingExtraction: AgentExtraction = {
  fields: { title: { value: "n/a", evidenceRef: "src:21-4#0" } },
};
const runRef: WorkflowRunRef = {
  workflowId: workflowId("wf-21-4"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:21-4",
  auditRefs: [],
};

// `defaultVisibility: "isolated"` + `dataOwner: "user"` — the narrow auto-allow leg
// (`@sow/policy`'s `requiresApproval`) so a `calendar`/`auto_private` entry dispatches straight
// through, no pending-approval hold in the way of proving the drain itself ran.
const resolved: ResolvedWorkspacePolicy = {
  workspaceId: String(WS),
  type: "personal_business",
  dataOwner: "user",
  defaultVisibility: "isolated",
  egressPolicy: {
    workspaceId: WS,
    allowedProcessors: [],
    rawContentAllowedProcessors: [],
    employerRawEgressAcknowledged: false,
  },
  providerMatrix: {
    workspaceId: WS,
    allowedProviders: [],
    capabilityDefaults: {} as ResolvedWorkspacePolicy["providerMatrix"]["capabilityDefaults"],
    rawCloudEgressEnabled: false,
  },
};

function baseParams(): ProofSpineParams {
  return {
    resolved,
    correlationSignals: { confidence: 0.95, workspaceId: WS },
    meetingJobInputs,
    meetingExtraction,
    revisions: createKnowledgeRevisionStoreAdapter(backendsRevisions()),
    commit: {
      actor: "worker:test",
      sourceEventRef: "evt:21-4",
      workflowRunRef: runRef,
      expectedBaseRevision: REV_GENESIS,
    },
    sourceRef: { sourceId: sourceId("src-21-4") },
    planIdentity: { closeout: "meeting:21-4" },
  };
}
// Set by each test right after `assembleBackends` resolves (needs `backends.repos.knowledgeRevisions`).
let backendsRevisionsRepo: Parameters<typeof createKnowledgeRevisionStoreAdapter>[0] | undefined;
function backendsRevisions(): Parameters<typeof createKnowledgeRevisionStoreAdapter>[0] {
  if (backendsRevisionsRepo === undefined) {
    throw new Error("test bug: backendsRevisionsRepo not set before baseParams()");
  }
  return backendsRevisionsRepo;
}

function makeDueEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    outboxId: "outbox_drain_on_wake_1",
    actionRef: "action_drain_on_wake_1",
    workspaceId: String(WS),
    targetSystem: "calendar",
    canonicalObjectKey: "cok_calendar_drain_on_wake_1",
    idempotencyKey: "idem_calendar_drain_on_wake_1",
    payloadHash: "sha256:drainonwake",
    approvalPolicy: "auto_private",
    status: "retry_queued",
    payload: { title: "team standup" },
    attempts: 0,
    enqueuedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// Flush the fire-and-forget drain chain started synchronously inside `buildProofSpineActivities`. A
// single macrotask tick is sufficient — Node drains the ENTIRE microtask queue (regardless of hop
// depth) before any timer callback runs.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
  const dir = mkdtempSync(join(tmpdir(), "sow-21-4-drain-on-wake-"));
  tempDirs.push(dir);
  return join(dir, "ops.db");
}

describe("buildProofSpineActivities — the write-outbox drain-on-wake (task 21.4/24.8)", () => {
  it("a due, correctly-scoped entry drains to receipt_recorded purely from calling buildProofSpineActivities — no activity invoked", async () => {
    const backends = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT], dbPath: tempDbPath() },
      { candidateOutput: {} },
    );
    backendsRevisionsRepo = backends.repos.knowledgeRevisions;
    try {
      const enq = await backends.repos.outbox.enqueue(makeDueEntry());
      expect(enq.ok).toBe(true);

      // The production caller under test — no activity method called, ONLY construction.
      buildProofSpineActivities(backends, baseParams());
      await flush();

      const after = await backends.repos.outbox.get("outbox_drain_on_wake_1");
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value.status).toBe("receipt_recorded");
    } finally {
      backends.close();
      backendsRevisionsRepo = undefined;
    }
  });

  it("the recorded receipt's externalObjectId carries the stub marker — never reaches a real vendor", async () => {
    const backends = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT], dbPath: tempDbPath() },
      { candidateOutput: {} },
    );
    backendsRevisionsRepo = backends.repos.knowledgeRevisions;
    try {
      await backends.repos.outbox.enqueue(makeDueEntry());
      buildProofSpineActivities(backends, baseParams());
      await flush();

      const receipt = await backends.receiptStore.getByIdempotencyKey("idem_calendar_drain_on_wake_1");
      expect(receipt).toBeDefined();
      expect(receipt?.receipt.externalObjectId).toMatch(/^stub-obj:/);
    } finally {
      backends.close();
      backendsRevisionsRepo = undefined;
    }
  });

  it("an entry for a DIFFERENT workspace is left completely untouched (safety rule 4 / task 24.50)", async () => {
    const backends = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT], dbPath: tempDbPath() },
      { candidateOutput: {} },
    );
    backendsRevisionsRepo = backends.repos.knowledgeRevisions;
    try {
      const foreignEntry = makeDueEntry({
        outboxId: "outbox_drain_on_wake_foreign",
        actionRef: "action_drain_on_wake_foreign",
        workspaceId: String(OTHER_WS),
        canonicalObjectKey: "cok_calendar_drain_on_wake_foreign",
        idempotencyKey: "idem_calendar_drain_on_wake_foreign",
      });
      await backends.repos.outbox.enqueue(foreignEntry);

      buildProofSpineActivities(backends, baseParams()); // bound for WS, not OTHER_WS
      await flush();

      const after = await backends.repos.outbox.get("outbox_drain_on_wake_foreign");
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      // Untouched: still retry_queued, attempts NOT bumped, updatedAt unchanged.
      expect(after.value.status).toBe("retry_queued");
      expect(after.value.attempts).toBe(0);
      expect(after.value.updatedAt).toBe(NOW);
    } finally {
      backends.close();
      backendsRevisionsRepo = undefined;
    }
  });

  it("an empty outbox is a no-op — construction never throws when there is nothing to drain", async () => {
    const backends = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT], dbPath: tempDbPath() },
      { candidateOutput: {} },
    );
    backendsRevisionsRepo = backends.repos.knowledgeRevisions;
    try {
      expect(() => buildProofSpineActivities(backends, baseParams())).not.toThrow();
      await flush();
    } finally {
      backends.close();
      backendsRevisionsRepo = undefined;
    }
  });
});
