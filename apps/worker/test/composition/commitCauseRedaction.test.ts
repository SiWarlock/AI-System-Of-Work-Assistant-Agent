// Task 24.105 (F1) — `meetingCommit`/`sourceCommit` must never leak the raw KnowledgeWriter
// commit-rejection `cause` (the WHOLE @sow/knowledge `WriteFailure`, including validator-authored
// `issues[]`/`path`/`kind` detail) into the Temporal ACTIVITY result: Temporal workflow history is
// a durable, replayed log sink (safety rule 7), and both wrappers previously returned the raw
// `CommitKnowledgePort` Result verbatim on rejection.
//
// Drives the REGISTERED `meetingCommit`/`sourceCommit` activity members (the plain-async functions
// `buildProofSpineActivities` returns), never the raw `CommitKnowledgePort`, over a REAL
// `assembleBackends` (real fs vault + the real default `scanForSecrets`/`workspacePathCheck` — no
// injected pass-through), so the rejections this pin drives are genuine `WriteFailure` instances a
// real commit produces, not a simulated shape.
import { describe, it, expect, afterEach } from "vitest";
import { ok, workspaceId, workflowId, planId, sourceId } from "@sow/contracts";
import type { WorkspaceId, WorkflowRunRef, SourceRef, KnowledgeMutationPlan } from "@sow/contracts";
import type { AgentExtraction, MeetingJobInputs } from "@sow/workflows";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import { computeRevisionId } from "@sow/knowledge";
import type {
  KnowledgeRevisionStore,
  CommittedRevision,
  GbrainSyncOutboxStore,
  GbrainSyncOutboxEntry,
} from "@sow/knowledge";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import { buildProofSpineActivities, type ProofSpineParams } from "../../src/composition/buildActivities";
import type { GbrainSyncOutboxBinding } from "../../src/composition/gbrainSyncOutbox";

const NOW = "2026-08-27T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
// A plain, real, NON-exempt workspace (NOT "personal-business" — LEGACY_UNPREFIXED_WORKSPACE_ID) so
// an unprefixed create path trips the REAL workspace-path guard rather than sailing through exempt.
const WS: WorkspaceId = workspaceId("ws-redact-probe");
const EMPTY_VAULT_REVISION = computeRevisionId(new Map());

// The hostile marker this pin must NEVER see cross the activity boundary — embedded in a rejected
// commit's PATH, exactly the live leak an adversarial verifier demonstrated against the un-redacted
// wrappers: `cause:{code:"workspace_path_violation", path:"notes/PZN9F3A1BSECRET-leak.md"}` and
// `cause:{code:"secret_found", path:"ws-probe/notes/…", kind:"credential_shaped"}`.
const POISON_PATH_MARKER = "PZN9F3A1BSECRET-leak";
// A credential-shaped token the REAL default `scanForSecrets` (packages/knowledge/src/knowledge-
// writer/secret-scan.ts's `CREDENTIAL_PREFIX` net, `\bsk-[a-z0-9]`) rejects on sight.
const POISON_SECRET_TOKEN = "sk-LEAKEDSECRETTOKEN1234567890";

const runRef: WorkflowRunRef = {
  workflowId: workflowId("wf-redact"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:redact",
  auditRefs: [],
};
const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-redact"),
  workspaceId: WS,
  capability: "meeting.close",
  outputSchemaId: "sow:meeting.close.output",
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:redact",
};
const meetingExtraction: AgentExtraction = {
  fields: { title: { value: "n/a", evidenceRef: "src:redact#0" } },
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
const sourceRef: SourceRef = { sourceId: sourceId("src-redact") };

/** A tiny in-memory KnowledgeRevisionStore, fresh per test (mirrors proof-spine-composition.test.ts). */
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

/**
 * A recording fake `GbrainSyncOutboxStore` — lets the "the `ok` arm still reaches `withGbrainSync`
 * unredacted" pin OBSERVE the enqueue `triggerGbrainSync` performs. That enqueue only ever fires
 * when `withGbrainSync` reads a real `result.value.revisionId` off the FULL, un-redacted commit
 * Result (buildActivities.ts's `withGbrainSync`: `committedRevisionId: result.value.revisionId`) —
 * so an enqueued entry carrying the SAME `revisionId` the caller received is direct evidence that
 * this in-process consumer was handed the complete success value, not a stand-in.
 */
function recordingGbrainSyncOutbox(): {
  readonly binding: GbrainSyncOutboxBinding;
  readonly enqueued: GbrainSyncOutboxEntry[];
} {
  const enqueued: GbrainSyncOutboxEntry[] = [];
  const store: GbrainSyncOutboxStore = {
    getByKey: () => Promise.resolve(ok(undefined)),
    enqueue: (entry) => {
      enqueued.push(entry);
      return Promise.resolve(ok(entry));
    },
    update: (entry) => Promise.resolve(ok(entry)),
    listDue: () => Promise.resolve(ok([])),
    indexedHighWater: () => Promise.resolve(ok(undefined)),
  };
  return { binding: { store, close: () => {} }, enqueued };
}

function paramsFor(revisions: KnowledgeRevisionStore, gbrainSyncOutbox?: GbrainSyncOutboxBinding): ProofSpineParams {
  return {
    resolved,
    correlationSignals: { confidence: 0.95, workspaceId: WS },
    meetingJobInputs,
    meetingExtraction,
    revisions,
    commit: {
      actor: "worker:test",
      sourceEventRef: "evt:redact",
      workflowRunRef: runRef,
      expectedBaseRevision: EMPTY_VAULT_REVISION,
    },
    sourceRef,
    planIdentity: { closeout: "redact:1" },
    // Conditional-spread: omitted (not `undefined`-valued) when a test doesn't need to observe the
    // outbox, so the byte-equivalent default (`createGbrainSyncOutboxBinding(undefined)`) still
    // binds inside `buildProofSpineActivities` for those tests.
    ...(gbrainSyncOutbox !== undefined ? { gbrainSyncOutbox } : {}),
  };
}

const openBackends: ProofSpineBackends[] = [];
afterEach(() => {
  for (const b of openBackends.splice(0)) b.close();
});

/** Fresh real backends (real fs vault, real default KnowledgeWriter validators) for one test. */
async function freshBackends(): Promise<ProofSpineBackends> {
  const b = await assembleBackends(
    { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    { candidateOutput: {} },
  );
  openBackends.push(b);
  return b;
}

describe("meetingCommit / sourceCommit — task 24.105: the raw commit-rejection `cause` never crosses the ACTIVITY boundary (rule 7)", () => {
  it("meetingCommit — a REAL workspace_path_violation: `cause`/the poisoned path never cross; `code` still does", async () => {
    const b = await freshBackends();
    const acts = buildProofSpineActivities(b, paramsFor(memRevisionStore()));
    const plan: KnowledgeMutationPlan = {
      planId: planId("plan:redact-wsviol-meeting"),
      workspaceId: WS,
      sourceRefs: [{ sourceId: sourceId("src-redact") }],
      // Unprefixed for a NON-exempt workspace — the real workspace-path guard rejects this.
      creates: [{ path: `notes/${POISON_PATH_MARKER}.md`, title: "note", body: "hello world", frontmatter: {} }],
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
    // The REAL guard fired for the reason this test expects — not some other rejection.
    expect(res.error.code).toBe("workspace_path_violation");
    // The stable, closed-taxonomy code crosses; the raw WriteFailure `cause` (which would have
    // carried `path` — the poisoned value) does not.
    expect("cause" in res.error).toBe(false);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(POISON_PATH_MARKER);
  });

  it("meetingCommit — a REAL secret_found: `cause`/the leaked secret/the poisoned path never cross; `code` still does", async () => {
    const b = await freshBackends();
    const acts = buildProofSpineActivities(b, paramsFor(memRevisionStore()));
    const plan: KnowledgeMutationPlan = {
      planId: planId("plan:redact-secret-meeting"),
      workspaceId: WS,
      sourceRefs: [{ sourceId: sourceId("src-redact") }],
      // Correctly prefixed (passes the workspace-path guard) so the REAL secret scan is what
      // rejects this plan — isolates the scenario this test targets.
      creates: [
        {
          path: `${WS}/notes/${POISON_PATH_MARKER}.md`,
          title: "note",
          body: `token: ${POISON_SECRET_TOKEN}`,
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
    expect(res.error.code).toBe("secret_found");
    expect("cause" in res.error).toBe(false);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(POISON_SECRET_TOKEN);
    expect(serialized).not.toContain(POISON_PATH_MARKER);
  });

  it("sourceCommit — a REAL workspace_path_violation: `cause`/the poisoned path never cross; `code` still does", async () => {
    const b = await freshBackends();
    const acts = buildProofSpineActivities(b, paramsFor(memRevisionStore()));
    const plan: KnowledgeMutationPlan = {
      planId: planId("plan:redact-wsviol-source"),
      workspaceId: WS,
      sourceRefs: [{ sourceId: sourceId("src-redact") }],
      creates: [{ path: `notes/${POISON_PATH_MARKER}.md`, title: "note", body: "hello world", frontmatter: {} }],
      patches: [],
      linkMutations: [],
      frontmatterUpdates: [],
      externalActionProposals: [],
      confidence: 1,
      requiresApproval: false,
      provenanceOrigin: "ingestion",
    };
    const res = await acts.sourceCommit(plan);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("workspace_path_violation");
    expect("cause" in res.error).toBe(false);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(POISON_PATH_MARKER);
  });

  // sourceCommit is the HIGHER-risk of the two sites: source-ingestion note paths derive from
  // user-dropped/imported (untrusted) files, so a leaked `.path` would be attacker-influenced by
  // design — this is the scenario the buildActivities.ts binding-site comment names explicitly.
  it("sourceCommit — a REAL secret_found: `cause`/the leaked secret/the poisoned path never cross; `code` still does", async () => {
    const b = await freshBackends();
    const acts = buildProofSpineActivities(b, paramsFor(memRevisionStore()));
    const plan: KnowledgeMutationPlan = {
      planId: planId("plan:redact-secret-source"),
      workspaceId: WS,
      sourceRefs: [{ sourceId: sourceId("src-redact") }],
      creates: [
        {
          path: `${WS}/notes/${POISON_PATH_MARKER}.md`,
          title: "note",
          body: `token: ${POISON_SECRET_TOKEN}`,
          frontmatter: {},
        },
      ],
      patches: [],
      linkMutations: [],
      frontmatterUpdates: [],
      externalActionProposals: [],
      confidence: 1,
      requiresApproval: false,
      provenanceOrigin: "ingestion",
    };
    const res = await acts.sourceCommit(plan);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("secret_found");
    expect("cause" in res.error).toBe(false);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(POISON_SECRET_TOKEN);
    expect(serialized).not.toContain(POISON_PATH_MARKER);
  });

  it("a SUCCESSFUL commit's `ok` arm is untouched, AND the in-process consumer (withGbrainSync) still receives the FULL result", async () => {
    const b = await freshBackends();
    const { binding, enqueued } = recordingGbrainSyncOutbox();
    const acts = buildProofSpineActivities(b, paramsFor(memRevisionStore(), binding));
    const plan: KnowledgeMutationPlan = {
      planId: planId("plan:redact-ok"),
      workspaceId: WS,
      sourceRefs: [{ sourceId: sourceId("src-redact") }],
      creates: [{ path: `${WS}/notes/ok.md`, title: "note", body: "hello world", frontmatter: {} }],
      patches: [],
      linkMutations: [],
      frontmatterUpdates: [],
      externalActionProposals: [],
      confidence: 1,
      requiresApproval: false,
      provenanceOrigin: "meeting_close",
    };
    const res = await acts.meetingCommit(plan);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The caller's `ok` arm carries the FULL success shape — `dropCommitFailureCause` never runs
    // on this arm.
    expect(res.value.revisionId).toMatch(/^rev:/);
    expect(res.value.replayed).toBe(false);
    // The in-process consumer that reads `result.value.revisionId` (withGbrainSync →
    // triggerGbrainSync → outbox.enqueue, buildActivities.ts) actually fired with the REAL
    // revisionId the caller received — proof it was handed the SAME full Result, not a stand-in
    // starved by the redaction added at the return statement.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.revisionId).toBe(res.value.revisionId);
    expect(enqueued[0]?.workspaceId).toBe(String(WS));
  });
});
