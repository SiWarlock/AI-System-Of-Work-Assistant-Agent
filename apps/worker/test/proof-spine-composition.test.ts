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
  actionId,
} from "@sow/contracts";
import type {
  WorkspaceId,
  WorkflowRunRef,
  SourceRef,
  KnowledgeMutationPlan,
  ProviderRoute,
  ProposedAction,
  ExternalWriteEnvelope,
  Result,
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

// ── 15.7 (closes G7): sourcePropose routes through the REAL Tool Gateway ────────
// The source-ingestion external-write propose must be the SAME real `propose`
// (createProposeActivity over dispatchExternalWrite) that backs meetingPropose —
// NOT the pre-15.7 in-memory `sourceReceiptByKey` Map that minted `ext-source-N`
// receipts. An approval-required employer_work external write FAILS CLOSED to
// `approval_pending` (safety rule 2/5) and lands a PENDING §9 Approval carrying the
// external-write envelope (rule 3), redaction-safe (rule 7), with NO real transport
// bound (dormant / byte-equivalent — the real write transport is Phase 21).
// A distinctive token rides the RAW payload so the redaction pin (t5) is non-vacuous.
const proposeAction: ProposedAction = {
  actionId: actionId("act:src:propose"),
  targetSystem: "todoist",
  canonicalObjectKey: "todoist:task:src-propose",
  payload: { title: "Ingested follow-up RAW-PAYLOAD-SECRET-TOKEN" },
  approvalPolicy: "auto",
  idempotencyKey: "idem:src:propose",
};
const proposeEnvelope: ExternalWriteEnvelope = {
  actionId: actionId("act:src:propose"),
  targetSystem: "todoist",
  canonicalObjectKey: "todoist:task:src-propose",
  idempotencyKey: "idem:src:propose",
  preconditions: ["not_exists"],
  payloadHash: "sha256:src-propose",
};

// A DISTINCT canonical action (different idempotencyKey/canonicalObjectKey) — used by t3
// to prove the pending-Approval dedup is genuinely KEYED, not an incidental "only one".
const proposeAction2: ProposedAction = {
  actionId: actionId("act:src:propose:2"),
  targetSystem: "todoist",
  canonicalObjectKey: "todoist:task:src-propose-2",
  payload: { title: "Second ingested follow-up" },
  approvalPolicy: "auto",
  idempotencyKey: "idem:src:propose:2",
};
const proposeEnvelope2: ExternalWriteEnvelope = {
  actionId: actionId("act:src:propose:2"),
  targetSystem: "todoist",
  canonicalObjectKey: "todoist:task:src-propose-2",
  idempotencyKey: "idem:src:propose:2",
  preconditions: ["not_exists"],
  payloadHash: "sha256:src-propose-2",
};

type ProposeDelegate = (
  a: ProposedAction,
  e: ExternalWriteEnvelope,
) => Promise<Result<{ status: string; envelope: ExternalWriteEnvelope }, { code: string; message: string }>>;

/** Drive a propose delegate once + read back the pending Approvals (fresh backends per test). */
async function drivePropose(
  delegate: ProposeDelegate,
  b: ProofSpineBackends,
): Promise<{
  res: Awaited<ReturnType<ProposeDelegate>>;
  pendingCount: number;
  firstPending: Record<string, unknown> | undefined;
}> {
  const res = await delegate(proposeAction, proposeEnvelope);
  const listed = await b.repos.approvals.listByStatus("pending");
  return {
    res,
    pendingCount: listed.ok ? listed.value.length : -1,
    firstPending: listed.ok
      ? (listed.value[0] as unknown as Record<string, unknown> | undefined)
      : undefined,
  };
}

describe("sourcePropose — routes through the REAL Tool Gateway (15.7 / closes G7)", () => {
  // CONTROL (already green): meetingPropose is ALREADY the real gateway propose — it
  // proves the harness + the approval_pending/pending-Approval model are correct, so a
  // RED on the source tests below is the source delegate's wiring, not a broken oracle.
  it("meetingPropose CONTROL — the same approval-required action fails closed to a pending Approval", async () => {
    const b = await freshBackends(LOCAL_ENDPOINT);
    const acts = buildProofSpineActivities(b, paramsFor(LOCAL_ENDPOINT));
    const { res, pendingCount } = await drivePropose((a, e) => acts.meetingPropose(a, e), b);
    expect(res.ok).toBe(false); // spec(§8) — real gateway fail-closed, no fabricated receipt
    if (!res.ok) expect(res.error.code).toBe("approval_pending");
    expect(pendingCount).toBe(1);
  });

  it("t1 source_propose_routes_through_the_real_gateway_not_an_in_memory_receipt", async () => {
    // spec(§19.2/§8) — the G7 fix: the source propose is the real gateway propose, so an
    // approval-required write FAILS CLOSED — NOT ok(status:"created") with an `ext-source-N`
    // in-memory receipt (which is exactly what the pre-15.7 stub returns → RED).
    const b = await freshBackends(LOCAL_ENDPOINT);
    const acts = buildProofSpineActivities(b, paramsFor(LOCAL_ENDPOINT));
    const { res } = await drivePropose((a, e) => acts.sourcePropose(a, e), b);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("approval_pending");
  });

  it("t2 source_propose_lands_a_pending_approval_carrying_the_envelope", async () => {
    // spec(§8 / rule 3) — the external-write envelope's payloadHash (keyed to the
    // idempotencyKey + canonicalObjectKey) rides onto the pending §9 Approval.
    const b = await freshBackends(LOCAL_ENDPOINT);
    const acts = buildProofSpineActivities(b, paramsFor(LOCAL_ENDPOINT));
    const { pendingCount, firstPending } = await drivePropose((a, e) => acts.sourcePropose(a, e), b);
    expect(pendingCount).toBe(1);
    expect(firstPending?.payloadHash).toBe(proposeEnvelope.payloadHash);
  });

  it("t3 source_propose_is_idempotent_no_duplicate_pending_approval", async () => {
    // spec(rule 3) — a re-propose of the same canonical action does NOT duplicate the
    // pending Approval (the Approval id derives from the envelope idempotencyKey).
    const b = await freshBackends(LOCAL_ENDPOINT);
    const acts = buildProofSpineActivities(b, paramsFor(LOCAL_ENDPOINT));
    await acts.sourcePropose(proposeAction, proposeEnvelope);
    await acts.sourcePropose(proposeAction, proposeEnvelope);
    const listed = await b.repos.approvals.listByStatus("pending");
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.length).toBe(1);
    // A DISTINCT canonical action IS added (2 pending) — the dedup is genuinely KEYED,
    // not an incidental "only ever one pending Approval".
    await acts.sourcePropose(proposeAction2, proposeEnvelope2);
    const listed2 = await b.repos.approvals.listByStatus("pending");
    expect(listed2.ok).toBe(true);
    if (listed2.ok) expect(listed2.value.length).toBe(2);
  });

  it("t4 source_propose_binds_no_real_transport_zero_real_write", async () => {
    // spec(NO hard line) — dormant/byte-equivalent: fails closed (no fabricated write
    // receipt) AND no COMMITTED external write receipt was landed (real transport is
    // UNBOUND — Phase 21). A committed receipt would mean a real egress happened.
    const b = await freshBackends(LOCAL_ENDPOINT);
    const acts = buildProofSpineActivities(b, paramsFor(LOCAL_ENDPOINT));
    const { res } = await drivePropose((a, e) => acts.sourcePropose(a, e), b);
    expect(res.ok).toBe(false);
    const reserve = await b.repos.writeReceipts.reserve(
      proposeAction.targetSystem,
      proposeAction.canonicalObjectKey,
    );
    expect(reserve.ok).toBe(true);
    if (reserve.ok) expect(reserve.value.kind).not.toBe("committed");
  });

  it("t5 source_propose_pending_approval_is_redaction_safe", async () => {
    // spec(rule 7) — the Approval card carries the payloadHash, NEVER the raw payload bytes.
    const b = await freshBackends(LOCAL_ENDPOINT);
    const acts = buildProofSpineActivities(b, paramsFor(LOCAL_ENDPOINT));
    const { firstPending } = await drivePropose((a, e) => acts.sourcePropose(a, e), b);
    expect(firstPending).toBeDefined();
    const serialized = JSON.stringify(firstPending);
    expect(serialized).toContain(proposeEnvelope.payloadHash);
    expect(serialized).not.toContain("RAW-PAYLOAD-SECRET-TOKEN");
  });
});
