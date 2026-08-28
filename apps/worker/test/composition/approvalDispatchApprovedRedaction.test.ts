// Task I1 (SUPERSEDED mechanism, SAME invariant) — `approvalDispatchApproved`'s ERR arm must
// never carry vendor-/driver-authored free text (a real vendor 409 body, a raw Authorization
// header, an adapter's own error message) across the Temporal activity boundary. Originally this
// was enforced by a SECOND redaction layer in buildActivities.ts (`redactDispatchApprovedError`,
// now DELETED) that folded the gateway's `reason` to a fixed code-keyed string. That layer was
// removed because it was redundant AND harmful: it also stripped the credential-fault `"locked"`
// token an operator needs (worker LESSONS §41) — see buildActivities.ts's comment at the
// `approvedGateway.dispatch` switch and gateway.ts:81-101's `ExternalWriteResult` doc comment.
//
// ⚠ NAME THE MECHANISM PRECISELY — an earlier version of this comment claimed the §8 Tool
// Gateway builds `reason` "from a closed code or a fixed literal, NEVER the adapter's own
// `.message`". That is FALSE and its cited templates never existed: gateway.ts interpolates the
// adapter's message on exactly these arms (`existence-check ${code}: ${message}` at ~:266,
// `create fault (${code}): ${message}` at ~:310). The poison is absent for a DIFFERENT reason,
// one layer further down — at the ADAPTER:
//
//   `makeTargetWriteAdapter`'s `faultToError`
//   (packages/integrations/src/tools/adapters/adapter-core.ts) composes `AdapterError.message`
//   from the closed 4-value `TransportFault` code plus the NUMERIC `httpStatus`. It never reads
//   the transport's free-text `detail` — which is precisely the field these tests poison.
//
// RESIDUAL, honestly: `TargetWriteAdapter` is a plain interface, so a hand-written adapter that
// bypasses that shared core could put arbitrary text in `.message` and the gateway would forward
// it. The guarantee is by the shared core, not by the type. Every SHIPPED vendor adapter
// (calendar here included) goes through the core, so these tests do pin the real production path.
//
// So the pin is genuinely end-to-end: the REGISTERED `approvalDispatchApproved` activity (the
// plain-async function `buildProofSpineActivities` returns) → the REAL §8 pipeline
// (`dispatchRouted` → `dispatchExternalWrite`) → a REAL `assembleBackends`, with a FAKE
// `AdapterTransport` injected via the `writeTransport` owner gate whose `detail` carries poisoned
// vendor text. The poison is absent because the ADAPTER never let it into `message`, not because
// a second worker-side layer scrubbed it back out.
//
// BOTH DIRECTIONS ARE ASSERTED. `code` crosses unchanged (approvalFlow.ts:412-440 branches only
// on `.error.code`, never on prose), and `message` is no longer artificially blanked — each fault
// test now also pins that its own closed diagnostic sentence still arrives, so a re-landed
// blanket collapse fails here rather than passing vacuously. See also the "created" success case
// + the `"locked"` credential pin at `apps/worker/test/boot/credential-and-card-bind.test.ts:301`.
// NOTE THE PATH: that file is under `test/boot/`, NOT under this `test/composition/` directory —
// an earlier bare-filename citation here sent a reader auditing the locked-Keychain positive
// control looking in the wrong directory, where they found nothing.
import { describe, it, expect, afterEach } from "vitest";
import { workspaceId, workflowId, sourceId, actionId } from "@sow/contracts";
import type {
  WorkspaceId,
  WorkflowRunRef,
  SourceRef,
  ProposedAction,
  ExternalWriteEnvelope,
  Approval,
} from "@sow/contracts";
import type { AgentExtraction, MeetingJobInputs } from "@sow/workflows";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import type {
  AdapterTransport,
  AdapterTransportRequest,
  TransportResponse,
} from "@sow/integrations";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import { buildProofSpineActivities, type ProofSpineParams } from "../../src/composition/buildActivities";
import type { KnowledgeRevisionStore, CommittedRevision } from "@sow/knowledge";
import { computeRevisionId } from "@sow/knowledge";

const NOW = "2026-08-27T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const WS: WorkspaceId = workspaceId("ws-i1-probe");
const EMPTY_VAULT_REVISION = computeRevisionId(new Map());

// The live-demonstrated poison strings from the brief: a vendor 409 body carrying a token in the
// URL, and a raw Authorization header value. Both must be absent from the ERR arm's serialized
// JSON — never truncated/masked, ABSENT.
const POISON_URL_TOKEN = "PZN9F3A1BSECRET-leak";
const POISON_CONFLICT_DETAIL = `409 from https://api.vendor.com/v1?token=${POISON_URL_TOKEN}: duplicate task`;
const POISON_BEARER_TOKEN = "sk-PZN9F3A1BSECRET-leak";
const POISON_HELD_DETAIL = `Bearer ${POISON_BEARER_TOKEN}`;
const POISON_REJECTED_DETAIL = "vendor rejected: invalid field 'sk-PZN9F3A1BSECRET-leak2'";

const runRef: WorkflowRunRef = {
  workflowId: workflowId("wf-i1"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:i1",
  auditRefs: [],
};
const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-i1"),
  workspaceId: WS,
  capability: "meeting.close",
  outputSchemaId: "sow:meeting.close.output",
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:i1",
};
const meetingExtraction: AgentExtraction = {
  fields: { title: { value: "n/a", evidenceRef: "src:i1#0" } },
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
const sourceRef: SourceRef = { sourceId: sourceId("src-i1") };

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

function paramsFor(): ProofSpineParams {
  return {
    resolved,
    correlationSignals: { confidence: 0.95, workspaceId: WS },
    meetingJobInputs,
    meetingExtraction,
    revisions: memRevisionStore(),
    commit: {
      actor: "worker:test",
      sourceEventRef: "evt:i1",
      workflowRunRef: runRef,
      expectedBaseRevision: EMPTY_VAULT_REVISION,
    },
    sourceRef,
    planIdentity: { closeout: "i1:1" },
  };
}

const openBackends: ProofSpineBackends[] = [];
afterEach(() => {
  for (const b of openBackends.splice(0)) b.close();
});

/**
 * A fake `AdapterTransport` (the §8 write-adapter's injected vendor seam, transport.ts) whose
 * "query" op always misses (so the mandatory pre-write existence check clears normally) and whose
 * "create" op ALWAYS returns the given fault/detail. `detail` is the free-text field a real vendor
 * client's error body would land in — and the field `faultToError` (adapter-core.ts) deliberately
 * does NOT read when it builds `AdapterError.message`. The gateway then interpolates that message
 * into `ExternalWriteResult.reason` verbatim (gateway.ts ~:266 / ~:310), so poisoning `detail` is
 * the correct way to test whether vendor text can reach the activity boundary.
 */
function fakeTransportWithCreateFault(
  fault: "conflict" | "unreachable" | "rejected",
  detail: string,
): AdapterTransport {
  return (req: AdapterTransportRequest): Promise<TransportResponse> => {
    if (req.op === "query") {
      return Promise.resolve({ ok: true, object: null });
    }
    // "create" (and "update", unused here) — the poisoned vendor fault.
    return Promise.resolve({ ok: false, fault, detail });
  };
}

/** Fresh real backends wired with the fake transport as the OWNER-ARMED write transport. */
async function backendsWithFakeTransport(transport: AdapterTransport): Promise<ProofSpineBackends> {
  const b = await assembleBackends(
    {
      now: () => NOW,
      allowedLocalEndpoints: [LOCAL_ENDPOINT],
      writeTransport: { enabled: true, make: () => transport },
    },
    { candidateOutput: {} },
  );
  openBackends.push(b);
  return b;
}

/** A ProposedAction + matching ExternalWriteEnvelope pair (envelopeMatchesAction-linked) for one
 * probe, keyed uniquely so each test's Approval/receipt state is isolated. */
function actionAndEnvelope(key: string): { action: ProposedAction; envelope: ExternalWriteEnvelope } {
  const action: ProposedAction = {
    actionId: actionId(`act-${key}`),
    targetSystem: "calendar",
    canonicalObjectKey: `cal:${key}`,
    payload: { title: "probe event" },
    approvalPolicy: "auto",
    idempotencyKey: `idem:${key}`,
  };
  const envelope: ExternalWriteEnvelope = {
    actionId: action.actionId,
    targetSystem: action.targetSystem,
    canonicalObjectKey: action.canonicalObjectKey,
    idempotencyKey: action.idempotencyKey,
    preconditions: [],
    payloadHash: `hash:${key}`,
  };
  return { action, envelope };
}

/** Pre-seed an ALREADY-APPROVED Approval matching the envelope's idempotencyKey (the exact id
 * convention `makeApprovalIdFromEnvelope` uses, buildActivities.ts) so `dispatchExternalWrite`'s
 * approval-before-dispatch step (gateway.ts step 2) clears without going through the full
 * recordPending/applyTransition cycle — this test targets the DISPATCH leg only. */
async function preApprove(backends: ProofSpineBackends, envelope: ExternalWriteEnvelope): Promise<void> {
  const approval: Approval = {
    id: `approval:${envelope.idempotencyKey}` as Approval["id"],
    actionRef: envelope.actionId,
    subjectKind: "external_action",
    workspaceId: meetingJobInputs.workspaceId,
    status: "approved",
    actor: "worker:test",
    channel: "mac",
    payloadHash: envelope.payloadHash,
  };
  const created = await backends.repos.approvals.create(approval);
  expect(created.ok).toBe(true);
}

describe("approvalDispatchApproved — task I1: the §8 gateway's vendor-authored `reason` never crosses the ACTIVITY boundary (rule 7)", () => {
  it("a REAL `conflict` create-fault: the vendor 409-with-token body never crosses; `code` still does", async () => {
    const { action, envelope } = actionAndEnvelope("conflict");
    const b = await backendsWithFakeTransport(
      fakeTransportWithCreateFault("conflict", POISON_CONFLICT_DETAIL),
    );
    await preApprove(b, envelope);
    const acts = buildProofSpineActivities(b, paramsFor());

    const res = await acts.approvalDispatchApproved(action, envelope);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("conflict");
    expect("cause" in res.error).toBe(false);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(POISON_URL_TOKEN);
    expect(serialized).not.toContain("api.vendor.com");
    expect(serialized).not.toContain(POISON_CONFLICT_DETAIL);
    // RESTORE direction — the closed per-code diagnostic must still identify WHICH fault this was.
    expect(res.error.message).toContain("conflict");
    expect(res.error.message).toContain("write conflict (stale precondition)");
  });

  it("a REAL `held` create-fault (vendor unreachable): the raw Bearer token never crosses; `code` still does", async () => {
    const { action, envelope } = actionAndEnvelope("held");
    const b = await backendsWithFakeTransport(
      fakeTransportWithCreateFault("unreachable", POISON_HELD_DETAIL),
    );
    await preApprove(b, envelope);
    const acts = buildProofSpineActivities(b, paramsFor());

    const res = await acts.approvalDispatchApproved(action, envelope);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("held");
    expect("cause" in res.error).toBe(false);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(POISON_BEARER_TOKEN);
    expect(serialized).not.toContain(POISON_HELD_DETAIL);
    // RESTORE direction — "unreachable" must not render identically to "rejected".
    expect(res.error.message).toContain("unreachable");
    expect(res.error.message).toContain("target system unreachable");
  });

  it("a REAL `rejected` create-fault: the vendor validation-error body never crosses; `code` still does", async () => {
    const { action, envelope } = actionAndEnvelope("rejected");
    const b = await backendsWithFakeTransport(
      fakeTransportWithCreateFault("rejected", POISON_REJECTED_DETAIL),
    );
    await preApprove(b, envelope);
    const acts = buildProofSpineActivities(b, paramsFor());

    const res = await acts.approvalDispatchApproved(action, envelope);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("rejected");
    expect("cause" in res.error).toBe(false);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(POISON_BEARER_TOKEN);
    expect(serialized).not.toContain(POISON_REJECTED_DETAIL);
    // RESTORE direction — a vendor refusal must stay distinguishable from an outage.
    expect(res.error.message).toContain("rejected");
    expect(res.error.message).toContain("request rejected");
  });

  it("a SUCCESSFUL dispatch (`created`) is untouched by the redaction — the `ok` arm's real receipt still crosses", async () => {
    const { action, envelope } = actionAndEnvelope("created-ok");
    const transport: AdapterTransport = (req: AdapterTransportRequest): Promise<TransportResponse> => {
      if (req.op === "query") return Promise.resolve({ ok: true, object: null });
      return Promise.resolve({ ok: true, object: { externalObjectId: "vendor-obj-1" } });
    };
    const b = await backendsWithFakeTransport(transport);
    await preApprove(b, envelope);
    const acts = buildProofSpineActivities(b, paramsFor());

    const res = await acts.approvalDispatchApproved(action, envelope);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe("created");
    expect(res.value.envelope.writeReceipt?.externalObjectId).toBe("vendor-obj-1");
  });
});

// ── C3 — the registered activity must FORWARD `intentCreatedAt` to the gateway ──
//
// ⛔ THIS PINS A REAL BREAK, not a hypothetical. The production wiring was
// `approvalDispatchApproved: (action, env) => dispatchApproved.dispatch(action, env)`
// — a fixed-arity lambda that SILENTLY DROPPED the third argument the moment C3
// added one. The ordering guard existed, was tested at the gateway, and would have
// received a value from nowhere on the live approval path: a guard wired to nothing.
// Every other test still passed, because nothing else observed the argument.
//
// The approval path is the one that needs it most — its envelope waits on a HUMAN,
// so a fresher write landing meanwhile is the ordinary case, not the exotic one.

/** A transport that succeeds: query misses, create/update return a vendor object. */
function fakeTransportOk(): AdapterTransport {
  return (req: AdapterTransportRequest): Promise<TransportResponse> =>
    Promise.resolve(
      req.op === "query"
        ? { ok: true, object: null }
        : { ok: true, object: { externalObjectId: "ext-c3" } },
    );
}

/** Two envelopes for the SAME object with DIFFERENT payload hashes — i.e. an update. */
function sameObjectPair(
  key: string,
  hash: string,
): { action: ProposedAction; envelope: ExternalWriteEnvelope } {
  const action: ProposedAction = {
    actionId: actionId(`act-c3-${key}`),
    targetSystem: "calendar",
    canonicalObjectKey: "cal:c3-shared-object",
    payload: { title: `probe ${key}` },
    approvalPolicy: "auto",
    idempotencyKey: `idem:c3-${key}`,
  };
  return {
    action,
    envelope: {
      actionId: action.actionId,
      targetSystem: action.targetSystem,
      canonicalObjectKey: action.canonicalObjectKey,
      idempotencyKey: action.idempotencyKey,
      preconditions: [],
      payloadHash: hash,
    },
  };
}

describe("approvalDispatchApproved — forwards the C3 intentCreatedAt end-to-end", () => {
  it("a STALE approval (intent older than the applied payload) is refused, and NOTHING is written", async () => {
    const b = await backendsWithFakeTransport(fakeTransportOk());
    const acts = buildProofSpineActivities(b, paramsFor());

    // First approval lands and becomes the applied payload for this object.
    const first = sameObjectPair("first", "hash:v1");
    await preApprove(b, first.envelope);
    expect((await acts.approvalDispatchApproved(first.action, first.envelope)).ok).toBe(true);

    // A SECOND approval for the SAME object with DIFFERENT content, whose intent
    // predates the write above. Without the forward this updates (reverting the
    // document); with it, the gateway refuses.
    const stale = sameObjectPair("stale", "hash:v0-stale");
    await preApprove(b, stale.envelope);
    const res = await acts.approvalDispatchApproved(
      stale.action,
      stale.envelope,
      "2000-01-01T00:00:00.000Z", // unambiguously older than anything applied
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("rejected");
    expect(res.error.message).toContain("predates");
  });

  it("NON-VACUITY: the same second approval with NO intent time is not refused for staleness", async () => {
    // Proves the refusal above comes from the FORWARDED ARGUMENT, not from some
    // other property of the second dispatch.
    const b = await backendsWithFakeTransport(fakeTransportOk());
    const acts = buildProofSpineActivities(b, paramsFor());
    const first = sameObjectPair("first", "hash:v1");
    await preApprove(b, first.envelope);
    await acts.approvalDispatchApproved(first.action, first.envelope);

    const second = sameObjectPair("second", "hash:v2");
    await preApprove(b, second.envelope);
    const res = await acts.approvalDispatchApproved(second.action, second.envelope);

    if (!res.ok) expect(res.error.message).not.toContain("predates");
  });
});
