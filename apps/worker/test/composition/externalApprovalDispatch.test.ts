// The Approvals-screen dispatch for an external action. Linear slice 3+4, step 3.
//
// When the owner approves an external_action card, THIS sends the write: it rebuilds the action + envelope
// that the proposer saved (step 2) and dispatches them through the Tool Gateway, scoped to the APPROVAL's own
// workspace. Every case below runs over the REAL backends, the REAL propose sink, the REAL outbox and the REAL
// gateway; only the vendor transport is fake (no network).
//
// ⛔ OWNER DECISION (2026-09-22): with no real sender armed, approving sends NOTHING and records NO receipt —
// never the stub's fabricated one — and the saved entry stays retryable. See the "writes off" cases.
import { describe, it, expect, afterEach } from "vitest";
import { workspaceId, actionId, defaultWorkspace } from "@sow/contracts";
import type { Approval, ProposedAction, ExternalWriteEnvelope, WorkspaceId } from "@sow/contracts";
import type { AdapterTransport, AdapterTransportRequest, TransportResponse } from "@sow/integrations";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import { createApprovalsProposeSink } from "../../src/api/procedures/copilotProposeSink";
import {
  dispatchExternalApproval,
  createExternalApprovalDispatch,
  resolveExternalApprovalDispatch,
  externalApprovalFailureToHealth,
  type ExternalApprovalDispatchDeps,
  type ExternalApprovalFailure,
} from "../../src/composition/externalApprovalDispatch";
import type { DispatchApprovalFn } from "../../src/api/procedures/approvalCommands";

const NOW = "2026-09-22T12:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const WS: WorkspaceId = workspaceId("employer-work");
const OTHER_WS: WorkspaceId = workspaceId("personal-life");

const open: ProofSpineBackends[] = [];
afterEach(() => {
  for (const b of open.splice(0)) b.close();
});

/** A fake vendor: the existence probe misses; a create either succeeds or returns the given fault. */
function vendor(onCreate: "ok" | "unreachable" | "rejected" = "ok"): { transport: AdapterTransport; calls: AdapterTransportRequest[] } {
  const calls: AdapterTransportRequest[] = [];
  const transport: AdapterTransport = (req): Promise<TransportResponse> => {
    calls.push(req);
    if (req.op === "query") return Promise.resolve({ ok: true, object: null });
    if (onCreate === "ok") return Promise.resolve({ ok: true, object: { externalObjectId: "LIN-1" } });
    return Promise.resolve({ ok: false, fault: onCreate, detail: "vendor said no" });
  };
  return { transport, calls };
}

async function backends(transport?: AdapterTransport): Promise<ProofSpineBackends> {
  const b = await assembleBackends(
    {
      now: () => NOW,
      allowedLocalEndpoints: [LOCAL_ENDPOINT],
      ...(transport !== undefined ? { writeTransport: { enabled: true, make: () => transport } } : {}),
    },
    { candidateOutput: {} },
  );
  open.push(b);
  for (const id of [WS, OTHER_WS]) {
    const up = await b.repos.workspaceConfig.upsert(
      defaultWorkspace({ id, name: String(id), type: id === WS ? "employer_work" : "personal_life", markdownRepoPath: `/tmp/${id}`, gbrainBrainId: String(id) }),
    );
    if (!up.ok) throw new Error("workspace seed failed");
  }
  return b;
}

function linearIssue(key: string): { action: ProposedAction; envelope: ExternalWriteEnvelope } {
  const action: ProposedAction = {
    actionId: actionId(`act-${key}`),
    targetSystem: "linear",
    canonicalObjectKey: `lin:${key}`,
    payload: { teamId: "team-1", title: `Issue ${key}` },
    approvalPolicy: "required",
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

/** Propose through the REAL sink (which saves the action + envelope), then approve as the Approvals screen does. */
async function proposeAndApprove(b: ProofSpineBackends, key: string, ws: WorkspaceId = WS): Promise<Approval> {
  const { action, envelope } = linearIssue(key);
  const sink = createApprovalsProposeSink({ approvals: b.repos.approvals, workspaceConfig: b.repos.workspaceConfig, outbox: b.repos.outbox, now: () => NOW });
  const rec = await sink.record({ action, envelope, workspaceId: ws });
  if (!rec.ok) throw new Error(`propose failed: ${rec.error.message}`);
  const card = await b.repos.approvals.get(rec.value.approvalRef as Approval["id"]);
  if (!card.ok) throw new Error("card missing");
  const approved = await b.repos.approvals.applyTransition(card.value.id, "pending", { ...card.value, status: "approved" });
  if (!approved.ok) throw new Error("approve failed");
  return { ...card.value, status: "approved" };
}

function depsFor(b: ProofSpineBackends, failures: ExternalApprovalFailure[] = []): ExternalApprovalDispatchDeps {
  return {
    armed: b.writeTransportArmed,
    outbox: b.repos.outbox,
    workspaceConfig: b.repos.workspaceConfig,
    receiptStore: b.receiptStore,
    writeAdapters: b.writeAdapters,
    audit: async (rec) => {
      await b.repos.audit.append(rec);
    },
    clock: b.now,
    onFailure: async (f) => {
      failures.push(f);
    },
  };
}

async function entryFor(b: ProofSpineBackends, key: string) {
  const got = await b.repos.outbox.getByIdempotencyKey(`idem:${key}`);
  if (!got.ok) throw new Error("no saved entry");
  return got.value;
}

async function cardCount(b: ProofSpineBackends): Promise<number> {
  let n = 0;
  for (const s of ["pending", "approved", "rejected", "deferred", "edited", "expired"] as const) {
    const listed = await b.repos.approvals.listByStatus(s);
    if (listed.ok) n += listed.value.length;
  }
  return n;
}

describe("dispatchExternalApproval — an approved card's write is SENT through the gateway (rule 3)", () => {
  it("sends exactly once, records the receipt, and marks the saved entry done", async () => {
    const v = vendor();
    const b = await backends(v.transport);
    const approval = await proposeAndApprove(b, "a");
    const out = await dispatchExternalApproval(approval, depsFor(b));
    expect(out).toEqual({ kind: "dispatched", status: "created" });
    expect(v.calls.filter((c) => c.op === "create")).toHaveLength(1);
    const entry = await entryFor(b, "a");
    expect(entry.status).toBe("receipt_recorded");
    expect((entry.writeReceipt as { externalObjectId?: string } | undefined)?.externalObjectId).toBe("LIN-1");
  });

  it("⛔ rule 3: dispatching the same approval twice never sends a second write", async () => {
    const v = vendor();
    const b = await backends(v.transport);
    const approval = await proposeAndApprove(b, "b");
    await dispatchExternalApproval(approval, depsFor(b));
    const again = await dispatchExternalApproval(approval, depsFor(b));
    expect(again).toEqual({ kind: "already_done" });
    expect(v.calls.filter((c) => c.op === "create")).toHaveLength(1);
  });

  it("⛔ rule 4: the write is sent under the APPROVAL's workspace — the one its credential is looked up for", async () => {
    const v = vendor();
    const b = await backends(v.transport);
    await dispatchExternalApproval(await proposeAndApprove(b, "ws", OTHER_WS), depsFor(b));
    expect(v.calls.length).toBeGreaterThan(0);
    for (const c of v.calls) expect(c.workspaceId).toBe(String(OTHER_WS));
  });

  it("a HELD write (vendor unreachable) is kept for retry, not lost, and is reported", async () => {
    const v = vendor("unreachable");
    const b = await backends(v.transport);
    const failures: ExternalApprovalFailure[] = [];
    const out = await dispatchExternalApproval(await proposeAndApprove(b, "held"), depsFor(b, failures));
    expect(out).toEqual({ kind: "dispatched", status: "held" });
    const entry = await entryFor(b, "held");
    expect(entry.status).toBe("retry_queued");
    expect(entry.nextAttemptAt).toBeDefined();
    expect(failures.map((f) => f.kind)).toEqual(["held"]);
  });

  it("a vendor REJECTION closes the entry and is reported", async () => {
    const v = vendor("rejected");
    const b = await backends(v.transport);
    const failures: ExternalApprovalFailure[] = [];
    const out = await dispatchExternalApproval(await proposeAndApprove(b, "rej"), depsFor(b, failures));
    expect(out).toEqual({ kind: "dispatched", status: "rejected" });
    expect((await entryFor(b, "rej")).status).toBe("rejected");
    expect(failures.map((f) => f.kind)).toEqual(["rejected"]);
  });
});

describe("dispatchExternalApproval — refuses WITHOUT writing when anything does not line up", () => {
  it("does nothing for a card that is not approved (the port fires on reject, edit and defer too)", async () => {
    const v = vendor();
    const b = await backends(v.transport);
    const approval = await proposeAndApprove(b, "st");
    for (const status of ["rejected", "edited", "deferred", "pending"] as const) {
      expect(await dispatchExternalApproval({ ...approval, status }, depsFor(b))).toEqual({ kind: "skipped", reason: "not_approved" });
    }
    expect(v.calls).toHaveLength(0);
  });

  it("does nothing for a semantic-mutation card (that has its own dispatcher)", async () => {
    const v = vendor();
    const b = await backends(v.transport);
    const approval = await proposeAndApprove(b, "sem");
    expect(await dispatchExternalApproval({ ...approval, subjectKind: "semantic_mutation" }, depsFor(b))).toEqual({
      kind: "skipped",
      reason: "not_external",
    });
    expect(v.calls).toHaveLength(0);
  });

  it("⛔ rule 4: refuses when the card's workspace does not match the saved entry's", async () => {
    const v = vendor();
    const b = await backends(v.transport);
    const approval = await proposeAndApprove(b, "mis");
    const out = await dispatchExternalApproval({ ...approval, workspaceId: OTHER_WS }, depsFor(b));
    expect(out.kind).toBe("refused");
    expect(v.calls).toHaveLength(0);
  });

  it("⛔ rule 3: refuses when the approved payload is not the saved one (a swapped payload never executes)", async () => {
    const v = vendor();
    const b = await backends(v.transport);
    const approval = await proposeAndApprove(b, "swap");
    expect(await dispatchExternalApproval({ ...approval, payloadHash: "hash:SOMETHING-ELSE" }, depsFor(b))).toEqual({
      kind: "refused",
      reason: "payload_mismatch",
    });
    expect(v.calls).toHaveLength(0);
  });

  it("refuses a card with nothing saved to send — and never records a card of its own", async () => {
    const v = vendor();
    const b = await backends(v.transport);
    const approval = await proposeAndApprove(b, "gone");
    const before = await cardCount(b);
    const orphan: Approval = { ...approval, id: "idem_0000000000000000000000000000000000000000000000000000000000000000" as Approval["id"] };
    expect(await dispatchExternalApproval(orphan, depsFor(b))).toEqual({ kind: "refused", reason: "no_saved_action" });
    expect(v.calls).toHaveLength(0);
    expect(await cardCount(b)).toBe(before);
  });

  it("refuses a workspace that is not onboarded, and the unassigned sentinel", async () => {
    const v = vendor();
    const b = await backends(v.transport);
    const approval = await proposeAndApprove(b, "unk");
    expect((await dispatchExternalApproval({ ...approval, workspaceId: workspaceId("personal-business") }, depsFor(b))).kind).toBe("refused");
    expect((await dispatchExternalApproval({ ...approval, workspaceId: "__unassigned__" as WorkspaceId }, depsFor(b))).kind).toBe("refused");
    expect(v.calls).toHaveLength(0);
  });
});

describe("⛔ OWNER DECISION — writes OFF: approving sends nothing and fakes nothing", () => {
  it("with no real sender armed: refused as writes_off, NO receipt, the entry stays retryable", async () => {
    const b = await backends(); // no writeTransport ⇒ the stub would be selected for everything else
    expect(b.writeTransportArmed).toBe(false);
    const approval = await proposeAndApprove(b, "off");
    const out = await dispatchExternalApproval(approval, depsFor(b));
    expect(out).toEqual({ kind: "refused", reason: "writes_off" });
    const entry = await entryFor(b, "off");
    expect(entry.status).toBe("proposed"); // untouched: once the switch is on it can still be sent
    expect(entry.writeReceipt).toBeUndefined();
    const receipt = await b.repos.writeReceipts.getByIdempotencyKey("idem:off");
    expect(receipt.ok).toBe(false); // the stub never got the chance to fabricate one
  });
});

describe("createExternalApprovalDispatch — the port the Approvals screen calls", () => {
  it("returns ok for every outcome: the decision already landed, and the card shows the real state", async () => {
    const v = vendor("rejected");
    const b = await backends(v.transport);
    const port = createExternalApprovalDispatch(depsFor(b));
    const approval = await proposeAndApprove(b, "port");
    expect(await port(approval)).toEqual({ ok: true, value: undefined });
    expect(await port({ ...approval, payloadHash: "hash:x" })).toEqual({ ok: true, value: undefined });
  });
});

describe("resolveExternalApprovalDispatch — what boot binds for external_action approvals", () => {
  it("uses the REAL guarded dispatcher unless a caller supplies an explicit override", () => {
    const real: DispatchApprovalFn = async () => ({ ok: true, value: undefined });
    const override: DispatchApprovalFn = async () => ({ ok: true, value: undefined });
    let built = 0;
    const build = (): DispatchApprovalFn => {
      built += 1;
      return real;
    };
    expect(resolveExternalApprovalDispatch(undefined, build)).toBe(real);
    expect(resolveExternalApprovalDispatch(override, build)).toBe(override);
    expect(built).toBe(1); // the real one is never built when an override is supplied
  });
});

describe("externalApprovalFailureToHealth — what System Health shows (rule 7: no content)", () => {
  it("maps each failure to a closed class, keyed by the approval, with no payload or vendor text", () => {
    const at = "2026-09-22T12:00:00.000Z";
    const held = externalApprovalFailureToHealth({ kind: "held", approvalId: "idem_x" }, at);
    expect(held.failureClass).toBe("write_through_failed");
    expect(held.subjectRef).toBe("idem_x");
    expect(externalApprovalFailureToHealth({ kind: "rejected", approvalId: "idem_x" }, at).failureClass).toBe("write_through_failed");
    expect(externalApprovalFailureToHealth({ kind: "conflict", approvalId: "idem_x" }, at).failureClass).toBe("conflict_review");
    const integrity = externalApprovalFailureToHealth({ kind: "integrity", approvalId: "idem_x", reason: "payload_mismatch" }, at);
    expect(integrity.failureClass).toBe("conflict_review");
    expect(integrity.message).toContain("payload_mismatch");
  });
});
