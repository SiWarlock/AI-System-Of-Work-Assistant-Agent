// Worker composition SAFETY (end-to-end wiring): the assembled backends + the bound
// proof-spine activities uphold the four pinned invariants:
//   • the genesis migration materialized the write_receipts index (reserve→put→reserve
//     round-trips through the REAL @sow/db repo) — the exactly-once backstop exists.
//   • localConfig is ALWAYS supplied to the broker AND is consulted: a local route whose
//     endpoint matches localConfig is ACCEPTED; a mismatched local endpoint is a typed
//     failure (proving the config flowed — a missing config would skip the check).
//   • the KnowledgeWriter keeps its REAL secret-scan default: a plan whose note body is
//     credential-shaped is rejected `secret_found` (no pass-through was injected).
//   • buildProofSpineActivities exposes every proof-spine activity as a plain async fn.
import { describe, it, expect, afterEach } from "vitest";
import {
  ok,
  workspaceId,
  workflowId,
  planId,
  sourceId,
  auditId,
} from "@sow/contracts";
import type {
  WorkspaceId,
  WorkflowRunRef,
  SourceRef,
  KnowledgeMutationPlan,
  ProviderRoute,
} from "@sow/contracts";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import type { AgentExtraction, MeetingCloseoutContext, MeetingJobInputs } from "@sow/workflows";
import type { CommittedRevision, KnowledgeRevisionStore } from "@sow/knowledge";
import { computeRevisionId } from "@sow/knowledge";

// The compare-revision base of a fresh, EMPTY vault (the writer refuses a commit
// whose expected base ≠ the on-disk revision — so the secret-scan test must target
// the real empty-vault revision to reach the scan step).
const EMPTY_VAULT_REVISION = computeRevisionId(new Map());
import {
  assembleBackends,
  type ProofSpineBackends,
} from "../src/composition/backends";
import {
  buildProofSpineActivities,
  type ProofSpineParams,
} from "../src/composition/buildActivities";

const WS: WorkspaceId = workspaceId("ws-emp");
const NOW = "2026-07-02T00:00:00.000Z";

const LOCAL_ENDPOINT = "http://127.0.0.1:11434";

// A local (loopback, zero-egress) route — the egress veto clears it, and the route
// resolver requires its endpoint to be listed in the supplied localConfig.
const localRoute = (endpoint: string): ProviderRoute =>
  ({
    provider: "ollama",
    model: "local-default",
    endpoint,
    egressClass: "local",
  }) as unknown as ProviderRoute;

const MEETING_CAP = "meeting.close";

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
  workflowId: workflowId("wf-1"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:1",
  auditRefs: [],
};

const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-1"),
  workspaceId: WS,
  capability: MEETING_CAP,
  outputSchemaId: "sow:meeting.close.output",
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:meeting:1",
};

// A validated-shaped meeting extraction (title evidence-backed) the broker outcome maps to.
const meetingExtraction: AgentExtraction = {
  fields: {
    title: { value: "Weekly Sync", evidenceRef: "src:1#0" },
  },
};

const sourceRef: SourceRef = { sourceId: sourceId("src-1") };

/** A tiny in-memory KnowledgeRevisionStore (the concrete driver is Phase-4). */
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
      sourceEventRef: "evt:1",
      workflowRunRef: runRef,
      expectedBaseRevision: EMPTY_VAULT_REVISION,
    },
    sourceRef,
    planIdentity: { closeout: "meeting:1" },
  };
}

const openBackends: ProofSpineBackends[] = [];
afterEach(() => {
  for (const b of openBackends.splice(0)) b.close();
});

async function freshBackends(endpoint: string): Promise<ProofSpineBackends> {
  const b = await assembleBackends(
    { now: () => NOW, allowedLocalEndpoints: [endpoint] },
    { candidateOutput: {} },
  );
  openBackends.push(b);
  return b;
}

const meetingCtx = (): MeetingCloseoutContext => ({
  source: {
    sourceId: sourceId("src-1"),
    workspaceId: WS,
    origin: "https://example.test/mtg",
    contentHash: "hash:1",
    type: "transcript",
    sensitivity: "internal",
    routingHints: {},
  },
  envelopes: [],
});

describe("assembleBackends — genesis migration + write_receipts backstop", () => {
  it("materialized the write_receipts index: reserve → put → reserve(committed) round-trips", async () => {
    const b = await freshBackends(LOCAL_ENDPOINT);
    const repo = b.repos.writeReceipts;
    // First reserve wins (the row was materialized by the genesis migration).
    const first = await repo.reserve("todoist", "obj:round-trip");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.kind).toBe("reserved");
    // Commit the receipt (upgrade reserved → committed).
    const put = await repo.put({
      targetSystem: "todoist",
      canonicalObjectKey: "obj:round-trip",
      idempotencyKey: "idem:round-trip",
      payloadHash: "hash:round-trip",
      receipt: { externalObjectId: "ext-round-trip", recordedAt: NOW },
      recordedAt: NOW,
    });
    expect(put.ok).toBe(true);
    // A second reserve now sees the committed row → REUSE (never a 2nd create).
    const second = await repo.reserve("todoist", "obj:round-trip");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.kind).toBe("committed");
  });

  it("ALWAYS supplies a non-empty localConfig to the broker", async () => {
    const b = await freshBackends(LOCAL_ENDPOINT);
    expect(b.localConfig.allowedLocalEndpoints.length).toBeGreaterThan(0);
    expect(b.localConfig.allowedLocalEndpoints).toContain(LOCAL_ENDPOINT);
  });
});

describe("buildProofSpineActivities — the plain-async-function shape Temporal registers", () => {
  it("exposes every proof-spine activity as a function", async () => {
    const b = await freshBackends(LOCAL_ENDPOINT);
    const acts = buildProofSpineActivities(b, paramsFor(LOCAL_ENDPOINT));
    const expected = [
      "meetingCorrelate",
      "meetingRunAgentJob",
      "meetingValidate",
      "meetingBuildOutputs",
      "meetingCommit",
      "meetingPropose",
      "meetingReindex",
      "approvalRecordPending",
      "approvalSurfaceCard",
      "approvalApply",
      "approvalDispatchApproved",
      "triageRecordDisposition",
      "triageRescopeSource",
      "triageReenter",
      "surfaceFailure",
    ] as const;
    for (const name of expected) {
      expect(typeof (acts as unknown as Record<string, unknown>)[name]).toBe("function");
    }
  });
});

describe("meetingRunAgentJob — localConfig is threaded to the broker AND consulted", () => {
  it("ACCEPTS a meeting.close job when the local route endpoint matches localConfig", async () => {
    const b = await freshBackends(LOCAL_ENDPOINT);
    const acts = buildProofSpineActivities(b, paramsFor(LOCAL_ENDPOINT));
    const res = await acts.meetingRunAgentJob(meetingCtx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The accepted extraction is the deterministic meeting extraction (mapCandidate).
    expect(res.value.fields.title?.value).toBe("Weekly Sync");
  });

  it("FAILS CLOSED (typed) when the local route endpoint is NOT in localConfig (config was consulted)", async () => {
    // localConfig admits only LOCAL_ENDPOINT, but the route points elsewhere → the
    // resolver's LOCAL_ENDPOINT_NOT_CONFIGURED denial fires ONLY because localConfig
    // flowed to the broker. A missing config would have SKIPPED this check.
    const b = await freshBackends(LOCAL_ENDPOINT);
    const acts = buildProofSpineActivities(b, paramsFor("http://127.0.0.1:9999"));
    const res = await acts.meetingRunAgentJob(meetingCtx());
    expect(res.ok).toBe(false);
  });
});

describe("meetingCommit — the KnowledgeWriter keeps its REAL secret-scan default", () => {
  it("rejects a plan whose note body is credential-shaped (no pass-through injected)", async () => {
    const b = await freshBackends(LOCAL_ENDPOINT);
    const acts = buildProofSpineActivities(b, paramsFor(LOCAL_ENDPOINT));
    // A minimal, schema-valid plan whose note body carries a sensitive keyword the
    // real scanForSecrets default trips on. A pass-through default would let it commit.
    const plan: KnowledgeMutationPlan = {
      planId: planId("plan:secret"),
      workspaceId: WS,
      sourceRefs: [{ sourceId: sourceId("src-1") }],
      creates: [
        {
          path: "meetings/note.md",
          title: "note",
          body: "password: hunter2-supersecret-value",
          frontmatter: {},
        },
      ],
      patches: [],
      linkMutations: [],
      frontmatterUpdates: [],
      externalActionProposals: [],
      confidence: 1,
      requiresApproval: false,
      provenanceOrigin: "meeting_close",
    };
    const res = await acts.meetingCommit(plan);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // The real scanForSecrets default fired — not a schema/other rejection.
    expect(res.error.code).toBe("secret_found");
  });
});
