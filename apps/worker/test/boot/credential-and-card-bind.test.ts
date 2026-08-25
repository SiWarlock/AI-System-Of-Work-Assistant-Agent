// PROV-6 — 21.10 credential seam bind + 21.8 card-renderer bind.
//
// Two composition-root binds, tested at two levels:
//   (a) the pure boot.ts rebind helpers `withWriteSecretsAccessor` / `withCardTransport`
//       (mirror `withSigning`'s dormancy-preserving shape — apps/worker/test/composition/
//       durableRevisions.test.ts is the sibling fixture style for this half);
//   (b) the assembled `buildProofSpineActivities` dispatch/surface behavior over REAL
//       backends (mirrors apps/worker/test/proof-spine-composition.test.ts's fixture style).
//
// Territory note: this file lives in apps/worker/test/boot (this package's assigned test
// territory) even though its sibling `with*` rebind tests conventionally sit under
// test/composition/ — the functions under test are exported from boot.ts either way.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  ok,
  workspaceId,
  workflowId,
  sourceId,
  actionId,
  approvalId,
  validKnowledgeMutationPlan,
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
} from "@sow/contracts";
import type {
  Capability,
  WorkspaceId,
  WorkflowRunRef,
  SourceRef,
  ProposedAction,
  ExternalWriteEnvelope,
  Approval,
  Result,
} from "@sow/contracts";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import type { AgentExtraction, MeetingJobInputs } from "@sow/workflows";
import type { CommittedRevision, KnowledgeRevisionStore } from "@sow/knowledge";
import { computeRevisionId } from "@sow/knowledge";
import type { WriteSecretsAccessor, WriteSecretUnavailable } from "@sow/integrations";
import type { CardTransportGate } from "@sow/integrations/tools/cards/index";
import type { CardRendererLike, CardSend, CardSendRequest, CardPayload } from "@sow/integrations/tools/cards/card-port";
import { createMacCardTransport } from "@sow/integrations/tools/cards/mac-card";
import { createTelegramCardTransport } from "@sow/integrations/tools/cards/telegram-card";

import { withWriteSecretsAccessor, withCardTransport } from "../../src/boot";
import {
  assembleBackends,
  type ProofSpineBackends,
} from "../../src/composition/backends";
import {
  buildProofSpineActivities,
  type ProofSpineParams,
} from "../../src/composition/buildActivities";

// ---------------------------------------------------------------------------
// (a) withWriteSecretsAccessor / withCardTransport — pure boot.ts rebinds
// ---------------------------------------------------------------------------

// A minimal ProofSpineParams — only the field each rebind touches matters (the rest is
// spread through unchanged), mirroring durableRevisions.test.ts's `baseParams` cast.
const baseParams = { commit: { actor: "worker:test" } } as unknown as ProofSpineParams;

const fakeSecretsAccessor: WriteSecretsAccessor = {
  getSecret: async () => ok("unused-in-this-half"),
};

const fakeCardTransport: CardTransportGate = { enabled: true, make: () => ({ render: async () => ok(undefined) }) };

describe("withWriteSecretsAccessor — byte-equivalent OFF, attaches ON (21.10)", () => {
  it("undefined params passes through undefined (nothing to attach to)", () => {
    expect(withWriteSecretsAccessor(undefined, fakeSecretsAccessor)).toBeUndefined();
  });

  it("undefined accessor returns the SAME params object unchanged (no keychainSecrets gate)", () => {
    const out = withWriteSecretsAccessor(baseParams, undefined);
    expect(out).toBe(baseParams);
    expect(out?.secretsAccessor).toBeUndefined();
  });

  it("a provided accessor attaches it onto a fresh params object without mutating the input", () => {
    const out = withWriteSecretsAccessor(baseParams, fakeSecretsAccessor);
    expect(out).not.toBe(baseParams);
    expect(out?.secretsAccessor).toBe(fakeSecretsAccessor);
    expect(baseParams.secretsAccessor).toBeUndefined(); // input untouched
  });
});

describe("withCardTransport — byte-equivalent OFF, attaches ON (21.8)", () => {
  it("undefined params passes through undefined", () => {
    expect(withCardTransport(undefined, fakeCardTransport)).toBeUndefined();
  });

  it("undefined gate (config.cardTransport unset) returns the SAME params object unchanged", () => {
    const out = withCardTransport(baseParams, undefined);
    expect(out).toBe(baseParams);
    expect(out?.cardTransport).toBeUndefined();
  });

  it("a provided gate attaches it onto a fresh params object without mutating the input", () => {
    const out = withCardTransport(baseParams, fakeCardTransport);
    expect(out).not.toBe(baseParams);
    expect(out?.cardTransport).toBe(fakeCardTransport);
    expect(baseParams.cardTransport).toBeUndefined(); // input untouched
  });
});

// ---------------------------------------------------------------------------
// (b) buildProofSpineActivities — the assembled dispatch + surface-card behavior
// ---------------------------------------------------------------------------

const WS: WorkspaceId = workspaceId("ws-emp");
const NOW = "2026-08-25T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const EMPTY_VAULT_REVISION = computeRevisionId(new Map());

const localRoute = (endpoint: string) =>
  ({
    provider: "ollama",
    model: "local-default",
    endpoint,
    egressClass: "local",
  }) as unknown as ResolvedWorkspacePolicy["providerMatrix"]["capabilityDefaults"][Capability];

// `capabilityDefaults` is keyed by the BRANDED `Capability`, not a bare string, so both the indexed
// access above and this constant are typed at the brand. Branding here (rather than widening the
// record's key type) keeps a raw unbranded string from being usable as a capability key.
const MEETING_CAP = "meeting.close" as Capability;

// employer_work + a local route: mirrors proof-spine-composition.test.ts's `resolvedFor` —
// PROVEN (by that file's CONTROL test) to make `makeRequireApproval` require approval for
// an "auto"-policy ProposedAction, which is exactly the gate this file's dispatch tests
// need to walk through (propose -> pending -> approve -> dispatch) to reach the 21.10 seam.
const RESOLVED: ResolvedWorkspacePolicy = {
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
    capabilityDefaults: { [MEETING_CAP]: localRoute(LOCAL_ENDPOINT) },
    rawCloudEgressEnabled: false,
  },
};

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
  outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:meeting:1",
};

const meetingExtraction: AgentExtraction = {
  fields: { title: { value: "Weekly Sync", evidenceRef: "src:1#0" } },
};

const sourceRef: SourceRef = { sourceId: sourceId("src-1") };

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

function paramsFor(overrides: Partial<ProofSpineParams> = {}): ProofSpineParams {
  return {
    resolved: RESOLVED,
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
    planIdentity: { closeout: "test:1" },
    ...overrides,
  };
}

const openBackends: ProofSpineBackends[] = [];
afterEach(() => {
  for (const b of openBackends.splice(0)) b.close();
});

async function freshBackends(): Promise<ProofSpineBackends> {
  const b = await assembleBackends(
    { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    { candidateOutput: validKnowledgeMutationPlan },
  );
  openBackends.push(b);
  return b;
}

// A "todoist" external-write action/envelope pair — todoist is the exact vendor
// `writeSecretRef`'s test-list item 2 pins (`keychain://connector-write/todoist`).
function todoistActionAndEnvelope(idSuffix: string): { action: ProposedAction; envelope: ExternalWriteEnvelope } {
  const action: ProposedAction = {
    actionId: actionId(`act:cred:${idSuffix}`),
    targetSystem: "todoist",
    canonicalObjectKey: `todoist:task:cred-${idSuffix}`,
    payload: { title: `credential-seam test ${idSuffix}` },
    approvalPolicy: "auto",
    idempotencyKey: `idem:cred:${idSuffix}`,
  };
  const envelope: ExternalWriteEnvelope = {
    actionId: action.actionId,
    targetSystem: "todoist",
    canonicalObjectKey: action.canonicalObjectKey,
    idempotencyKey: action.idempotencyKey,
    preconditions: ["not_exists"],
    payloadHash: `sha256:cred-${idSuffix}`,
  };
  return { action, envelope };
}

/**
 * Drive an action through propose (records a pending Approval — proven by the
 * proof-spine-composition.test.ts CONTROL to land `approval_pending` under RESOLVED) then
 * flip it to "approved" via the real ApprovalRepository CAS, so `approvalDispatchApproved`'s
 * `isApproved` check passes and dispatch reaches the 21.10 credential seam (gateway.ts step
 * 2.5, which runs strictly AFTER the approval check).
 */
async function proposeThenApprove(
  acts: ReturnType<typeof buildProofSpineActivities>,
  backends: ProofSpineBackends,
  action: ProposedAction,
  envelope: ExternalWriteEnvelope,
): Promise<void> {
  const proposed = await acts.sourcePropose(action, envelope);
  expect(proposed.ok).toBe(false); // approval_pending, by construction of RESOLVED (employer_work)
  const listed = await backends.repos.approvals.listByStatus("pending");
  if (!listed.ok) throw new Error(`expected pending list ok, got ${listed.error.code}`);
  const pending = listed.value.find((a) => a.payloadHash === envelope.payloadHash);
  if (pending === undefined) throw new Error("expected a pending Approval for this envelope");
  const approved = await backends.repos.approvals.applyTransition(pending.id, "pending", {
    ...pending,
    status: "approved",
  });
  if (!approved.ok) throw new Error(`approve failed: ${approved.error.code}`);
}

describe("21.10 — externalWriteDeps.secrets: dormant-by-default, consulted when bound", () => {
  it("an ABSENT accessor leaves the dispatch byte-equivalent (the dormancy pin)", async () => {
    const backends = await freshBackends();
    const acts = buildProofSpineActivities(backends, paramsFor()); // no secretsAccessor
    const { action, envelope } = todoistActionAndEnvelope("absent");
    await proposeThenApprove(acts, backends, action, envelope);
    const res = await acts.approvalDispatchApproved(action, envelope);
    // No credential seam ⇒ dispatch reaches the stub transport's create ⇒ created.
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe("created");
  });

  it("a provisioned accessor is consulted at dispatch with exactly the 17.4 ref", async () => {
    const backends = await freshBackends();
    const getSecret = vi.fn(async (_ref: string): Promise<Result<string, WriteSecretUnavailable>> => ok("faketoken-xyz"));
    const acts = buildProofSpineActivities(backends, paramsFor({ secretsAccessor: { getSecret } }));
    const { action, envelope } = todoistActionAndEnvelope("provisioned");
    await proposeThenApprove(acts, backends, action, envelope);
    const res = await acts.approvalDispatchApproved(action, envelope);
    expect(getSecret).toHaveBeenCalledTimes(1);
    expect(getSecret).toHaveBeenCalledWith("keychain://connector-write/todoist");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe("created");
  });

  it("an unavailable (locked) accessor holds the write closed; the reason is code-only", async () => {
    const backends = await freshBackends();
    const getSecret = async (): Promise<Result<string, WriteSecretUnavailable>> => ({ ok: false, error: { reason: "locked" } });
    const acts = buildProofSpineActivities(backends, paramsFor({ secretsAccessor: { getSecret } }));
    const { action, envelope } = todoistActionAndEnvelope("locked");
    await proposeThenApprove(acts, backends, action, envelope);
    const res = await acts.approvalDispatchApproved(action, envelope);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("held");
    expect(res.error.message.includes("locked")).toBe(true);
    expect(res.error.message.includes("keychain://")).toBe(false); // rule 7: never the raw ref
  });

  it("a throwing accessor is caught and held, never propagates (§16)", async () => {
    const backends = await freshBackends();
    const getSecret = async (): Promise<Result<string, WriteSecretUnavailable>> => {
      throw new Error("keychain backend fault");
    };
    const acts = buildProofSpineActivities(backends, paramsFor({ secretsAccessor: { getSecret } }));
    const { action, envelope } = todoistActionAndEnvelope("throwing");
    await proposeThenApprove(acts, backends, action, envelope);
    const res = await acts.approvalDispatchApproved(action, envelope);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("held");
    expect(res.error.message.includes("keychain backend fault")).toBe(false); // never the raw cause
  });

  it("a same-idempotencyKey replay reuses the receipt — zero duplicate external write (rule 3)", async () => {
    const backends = await freshBackends();
    const acts = buildProofSpineActivities(backends, paramsFor()); // absent accessor is fine here
    const { action, envelope } = todoistActionAndEnvelope("replay");
    await proposeThenApprove(acts, backends, action, envelope);
    const first = await acts.approvalDispatchApproved(action, envelope);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.status).toBe("created");
    const second = await acts.approvalDispatchApproved(action, envelope);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.status).toBe("reused");
      // The reused receipt is the SAME external object the first create minted — no 2nd create.
      if (first.ok) expect(second.value.envelope.writeReceipt).toEqual(first.value.envelope.writeReceipt);
    }
  });
});

describe("21.8 — the card renderer: dormant no-op by default, parity-armed when gated", () => {
  const pendingApproval: Approval = {
    id: approvalId("appr:card-test"),
    actionRef: actionId("act:card-test"),
    subjectKind: "external_action",
    workspaceId: WS,
    status: "pending",
    actor: "worker:test",
    channel: "mac",
    payloadHash: "sha256:card-test",
  };

  it("the shipped default (cardTransport unset) is the no-op — both channels render, nothing sinks", async () => {
    const backends = await freshBackends();
    const acts = buildProofSpineActivities(backends, paramsFor()); // no cardTransport
    const res = await acts.approvalSurfaceCard(pendingApproval);
    expect(res).toEqual(ok({ channels: ["mac", "telegram"] }));
  });

  it("an armed card gate renders parity cards on both channels; no secret reaches either CardPayload", async () => {
    const backends = await freshBackends();
    const macCalls: CardSendRequest[] = [];
    const telegramCalls: CardSendRequest[] = [];
    const macSend: CardSend = async (req) => {
      macCalls.push(req);
      return { ok: true };
    };
    const telegramSend: CardSend = async (req) => {
      telegramCalls.push(req);
      return { ok: true };
    };
    const TOKEN = "telegram-bot-token-SECRET-xyz";
    const telegramSecrets: WriteSecretsAccessor = { getSecret: async () => ok(TOKEN) };
    const mac = createMacCardTransport({ send: macSend, clock: () => NOW });
    const telegram = createTelegramCardTransport({ send: telegramSend, secrets: telegramSecrets, clock: () => NOW });
    // A test-only combinator routing render() by channel — the owner's eventual `make`
    // factory does the same; building THAT factory is a separate, owner-gated arming step
    // (NOTHING ARMS in this slice) — this combinator exists only to exercise the seam.
    const combined: CardRendererLike = {
      render: (approval, channel) => (channel === "mac" ? mac.render(approval, channel) : telegram.render(approval, channel)),
    };
    const cardTransport: CardTransportGate = { enabled: true, make: () => combined };
    const acts = buildProofSpineActivities(backends, paramsFor({ cardTransport }));
    const res = await acts.approvalSurfaceCard(pendingApproval);
    expect(res).toEqual(ok({ channels: ["mac", "telegram"] }));
    expect(macCalls).toHaveLength(1);
    expect(telegramCalls).toHaveLength(1);
    // Identical redaction-safe CardPayload on both channels (channel field aside — both
    // derive from the SAME approval's own `.channel`, so they're deep-equal too).
    const macPayload: CardPayload = macCalls[0]!.card;
    const telegramPayload: CardPayload = telegramCalls[0]!.card;
    expect(macPayload).toEqual(telegramPayload);
    // rule 7: the token rides ONLY telegram's dedicated `auth` field — never inside EITHER
    // channel's CardPayload, and never on mac's request at all.
    expect(macCalls[0]!.auth).toBeUndefined();
    expect(JSON.stringify(macPayload)).not.toContain(TOKEN);
    expect(JSON.stringify(telegramPayload)).not.toContain(TOKEN);
    expect(telegramCalls[0]!.auth).toBe(TOKEN);
  });

  it.each([
    ["enabled:1 (truthy, not strict true)", { enabled: 1 } as unknown as CardTransportGate],
    ["enabled:'true' (string)", { enabled: "true" } as unknown as CardTransportGate],
    ["enabled:'false' (string)", { enabled: "false" } as unknown as CardTransportGate],
    ["{} (both locks absent)", {} as CardTransportGate],
    ["enabled:true, no make", { enabled: true } as CardTransportGate],
  ])("a truthy-but-not-armed cardTransport gate (%s) never arms — stays the no-op", async (_label, cardTransport) => {
    const backends = await freshBackends();
    const acts = buildProofSpineActivities(backends, paramsFor({ cardTransport }));
    const res = await acts.approvalSurfaceCard(pendingApproval);
    expect(res).toEqual(ok({ channels: ["mac", "telegram"] }));
  });
});
