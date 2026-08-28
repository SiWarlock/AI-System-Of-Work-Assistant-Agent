// W2 — `meetingCorrelate`/`sourceRoute` must never leak a raw thrown `cause` into the
// Temporal ACTIVITY result: registering a function as a Temporal activity turns its
// return value into durable, replayed workflow history (a log sink under safety rule
// 7). `content-project-resolver.ts`'s two `catch (cause)` blocks previously forwarded
// the raw thrown value verbatim — a provider error can carry a token-bearing URL, a DB
// driver error a DSN, an fs error an absolute vault path.
//
// Drives the REGISTERED `meetingCorrelate`/`sourceRoute` activity members (the plain
// functions `buildProofSpineActivities` returns), never the raw producer fns directly,
// over the REAL composition (`buildProofSpineActivities(await assembleBackends({}), …)`
// — the object `Worker.create` actually receives) with an INJECTED `contentResolver` /
// `correlationScorer` that throws the poison object, so the leak this pins is the one a
// real thrown-object fault produces end-to-end, not a simulated Result shape.
import { describe, it, expect, afterEach } from "vitest";
import { sourceId, workspaceId, workflowId } from "@sow/contracts";
import type { WorkspaceId, WorkflowRunRef, SourceRef, SourceEnvelope } from "@sow/contracts";
import type { AgentExtraction, MeetingJobInputs, MeetingCloseoutContext, SourceIngestionContext } from "@sow/workflows";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import { computeRevisionId } from "@sow/knowledge";
import type { KnowledgeRevisionStore, CommittedRevision } from "@sow/knowledge";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import { buildProofSpineActivities, type ProofSpineParams } from "../../src/composition/buildActivities";
import type { ContentResolver, CorrelationScorerPort } from "../../src/composition/content-project-resolver";

const WS: WorkspaceId = workspaceId("ws-w2-probe");

// The exact poison shape the census demonstrated leaking through `meetingCorrelate` /
// `sourceRoute` — a provider error with a token-bearing URL, a DB driver DSN, and a
// bearer-token authorization header, all inside the raw thrown `cause`.
const POISON_CAUSE = {
  url: "https://api.example.com/v1/items?token=CENSUS-SECRET-TOKEN",
  authorization: "Bearer sk-CENSUSLEAK1234567890",
  dsn: "postgres://u:CENSUS-PASSWORD@h/db",
};
const POISON_SUBSTRINGS = ["CENSUS-SECRET-TOKEN", "sk-CENSUSLEAK1234567890", "CENSUS-PASSWORD"];

const sourceEnvelope: SourceEnvelope = {
  sourceId: sourceId("src-w2-probe"),
  workspaceId: WS,
  origin: "test://w2-probe",
  contentHash: "hash-w2-probe",
  type: "test",
  sensitivity: "internal",
  routingHints: {},
};

const runRef: WorkflowRunRef = {
  workflowId: workflowId("wf-w2-probe"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:w2-probe",
  auditRefs: [],
};
const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-w2-probe"),
  workspaceId: WS,
  capability: "meeting.close",
  outputSchemaId: "sow:meeting.close.output",
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:w2-probe",
};
const meetingExtraction: AgentExtraction = {
  fields: { title: { value: "n/a", evidenceRef: "src:w2-probe#0" } },
};
const resolved: ResolvedWorkspacePolicy = {
  workspaceId: String(WS),
  type: "personal_business",
  dataOwner: "user",
  defaultVisibility: "coordination",
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
const sourceRef: SourceRef = { sourceId: sourceId("src-w2-probe") };
const EMPTY_VAULT_REVISION = computeRevisionId(new Map());

/** A tiny in-memory KnowledgeRevisionStore (mirrors commitCauseRedaction.test.ts) — never
 *  exercised by this test (neither activity reaches a commit), only required to satisfy
 *  `ProofSpineParams`. */
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

/** A `ContentResolver` that ALWAYS throws the poison object — drives `sourceRoute`'s
 *  injected `classify` dep straight into the catch site this pin targets. */
const throwingContentResolver: ContentResolver = {
  resolve(): Promise<never> {
    throw POISON_CAUSE;
  },
};

/** A `CorrelationScorerPort` that ALWAYS throws the poison object — drives
 *  `meetingCorrelate`'s injected `resolveSignals` dep straight into the catch site. */
const throwingCorrelationScorer: CorrelationScorerPort = {
  score(): Promise<never> {
    throw POISON_CAUSE;
  },
};

function paramsFor(revisions: KnowledgeRevisionStore): ProofSpineParams {
  return {
    resolved,
    correlationSignals: { confidence: 0.95, workspaceId: WS },
    meetingJobInputs,
    meetingExtraction,
    revisions,
    commit: {
      actor: "worker:test",
      sourceEventRef: "evt:w2-probe",
      workflowRunRef: runRef,
      expectedBaseRevision: EMPTY_VAULT_REVISION,
    },
    sourceRef,
    planIdentity: { closeout: "w2-probe:1" },
    contentResolver: throwingContentResolver,
    correlationScorer: throwingCorrelationScorer,
  };
}

const openBackends: ProofSpineBackends[] = [];
afterEach(() => {
  for (const b of openBackends.splice(0)) b.close();
});

/** The REAL composition — `Worker.create` gets exactly this object. */
async function freshActivities(): Promise<ReturnType<typeof buildProofSpineActivities>> {
  const b = await assembleBackends({});
  openBackends.push(b);
  return buildProofSpineActivities(b, paramsFor(memRevisionStore()));
}

describe("meetingCorrelate / sourceRoute — W2: a raw thrown `cause` never crosses the ACTIVITY boundary (rule 7)", () => {
  it("sourceRoute — a thrown poison object: `cause`/its secrets never cross; `code` still does", async () => {
    const acts = await freshActivities();
    const ctx: SourceIngestionContext = { source: sourceEnvelope, envelopes: [] };
    const res = await acts.sourceRoute(ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // The stable, closed-taxonomy code crosses unchanged — consumers switch on it.
    expect(res.error.code).toBe("route_failed");
    expect("cause" in res.error).toBe(false);
    const serialized = JSON.stringify(res);
    for (const poison of POISON_SUBSTRINGS) {
      expect(serialized).not.toContain(poison);
    }
  });

  it("meetingCorrelate — a thrown poison object: `cause`/its secrets never cross; `code` still does", async () => {
    const acts = await freshActivities();
    // `envelopes` is REQUIRED on the context (its own doc: "An empty list is the
    // default (no external actions)") — omitting it is a TS2741 that vitest, which
    // does not typecheck, would never surface.
    const ctx: MeetingCloseoutContext = { source: sourceEnvelope, envelopes: [] };
    const res = await acts.meetingCorrelate(ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("correlation_failed");
    expect("cause" in res.error).toBe(false);
    const serialized = JSON.stringify(res);
    for (const poison of POISON_SUBSTRINGS) {
      expect(serialized).not.toContain(poison);
    }
  });
});
