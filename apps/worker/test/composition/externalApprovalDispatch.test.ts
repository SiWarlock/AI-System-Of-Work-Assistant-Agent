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
import { approvalIdFor, approvalOutboxId } from "@sow/domain";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    armedTargets: b.armedTargets,
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
  it("does nothing for a card that is not approved (the port fires on edit and defer too; reject closes — see below)", async () => {
    const v = vendor();
    const b = await backends(v.transport);
    const approval = await proposeAndApprove(b, "st");
    for (const status of ["edited", "deferred", "pending"] as const) {
      expect(await dispatchExternalApproval({ ...approval, status }, depsFor(b))).toEqual({ kind: "skipped", reason: "not_approved" });
    }
    expect(v.calls).toHaveLength(0);
  });

  it("⛔ a REJECTED card closes its saved entry, so nothing can ever re-drive it", async () => {
    const v = vendor();
    const b = await backends(v.transport);
    const card = await proposeAndApprove(b, "rej-close");
    const out = await dispatchExternalApproval({ ...card, status: "rejected" }, depsFor(b));
    expect(out).toEqual({ kind: "closed" });
    expect((await entryFor(b, "rej-close")).status).toBe("rejected");
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

  // Each case below builds a card and its saved entry BY HAND, consistent in every way (same workspace, same id
  // derivation, same payload) except the one fact its guard checks — so ONLY that guard can stop the write.
  // (Review 2026-09-22: the first versions reused a real card and were stopped by the workspace-mismatch guard
  // instead, so they passed with the guard under test deleted.)
  async function handMade(b: ProofSpineBackends, ws: string, key: string, entryKey = key): Promise<Approval> {
    const id = approvalIdFor({ idempotencyKey: `idem:${key}`, workspace: ws });
    const enq = await b.repos.outbox.enqueue({
      outboxId: approvalOutboxId(id), actionRef: `act-${key}`, workspaceId: ws, targetSystem: "linear",
      canonicalObjectKey: `lin:${key}`, idempotencyKey: `idem:${entryKey}`, payloadHash: `hash:${key}`, status: "proposed",
      payload: { teamId: "team-1", title: key }, approvalPolicy: "required", attempts: 0, enqueuedAt: NOW, updatedAt: NOW,
    });
    if (!enq.ok) throw new Error("seed failed");
    return {
      id, actionRef: `act-${key}` as Approval["actionRef"], subjectKind: "external_action", workspaceId: ws as WorkspaceId,
      status: "approved", actor: "owner", channel: "mac", payloadHash: `hash:${key}`,
    };
  }

  it("refuses a workspace that is not onboarded (only the onboarding guard can stop this card)", async () => {
    const v = vendor();
    const b = await backends(v.transport);
    const card = await handMade(b, "personal-business", "pb"); // no workspace_config row for it
    expect(await dispatchExternalApproval(card, depsFor(b))).toEqual({ kind: "refused", reason: "unknown_workspace" });
    expect(v.calls).toHaveLength(0);
  });

  it("refuses the unassigned sentinel by its OWN reason (no config row can exist for it — the contract rejects the id)", async () => {
    // The sentinel fails WorkspaceIdSchema, so the onboarding guard would also stop it; the explicit guard is a
    // backstop. Pinning the REASON is what shows the backstop fires first (without it: unknown_workspace).
    const v = vendor();
    const b = await backends(v.transport);
    const card = await handMade(b, "__unassigned__", "un");
    expect(await dispatchExternalApproval(card, depsFor(b))).toEqual({ kind: "refused", reason: "unassigned_workspace" });
    expect(v.calls).toHaveLength(0);
  });

  it("refuses a saved entry at the card's id that is not the card's own write (id-derivation check)", async () => {
    const v = vendor();
    const b = await backends(v.transport);
    const card = await handMade(b, String(WS), "mine", "someone-elses-key");
    expect(await dispatchExternalApproval(card, depsFor(b))).toEqual({ kind: "refused", reason: "no_saved_action" });
    expect(v.calls).toHaveLength(0);
  });
});

describe("⛔ OWNER DECISION — writes OFF: approving sends nothing and fakes nothing", () => {
  it("with no real sender armed: refused as writes_off, NO receipt, the entry stays retryable", async () => {
    const b = await backends(); // no writeTransport ⇒ the stub would be selected for everything else
    expect(b.armedTargets.size).toBe(0);
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

describe("⛔ OWNER DECISION — REFUSE AND SAY SO: every approved card that is not sent is reported", () => {
  it("writes off and nothing saved each reach System Health, as content-free reasons", async () => {
    const off = await backends();
    const failures: ExternalApprovalFailure[] = [];
    await dispatchExternalApproval(await proposeAndApprove(off, "say-off"), depsFor(off, failures));
    const on = await backends(vendor().transport);
    const orphan: Approval = { ...(await proposeAndApprove(on, "say-gone")), id: "idem_1111111111111111111111111111111111111111111111111111111111111111" as Approval["id"] };
    await dispatchExternalApproval(orphan, depsFor(on, failures));
    expect(failures.map((f) => [f.kind, f.reason])).toEqual([
      ["not_sent", "writes_off"],
      ["not_sent", "no_saved_action"],
    ]);
  });

  it("a card that is only skipped (not approved) is not reported", async () => {
    const b = await backends(vendor().transport);
    const failures: ExternalApprovalFailure[] = [];
    const card = await proposeAndApprove(b, "quiet");
    await dispatchExternalApproval({ ...card, status: "deferred" }, depsFor(b, failures));
    expect(failures).toEqual([]);
  });
});

describe("⛔ OWNER DECISION — STAYS RETRYABLE: refused while off, sent once the switch is on", () => {
  it("the same saved entry is sent after a restart with the sender armed", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "sow-retry-")), "ops.db");
    const off = await assembleBackends({ now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT], dbPath }, { candidateOutput: {} });
    await off.repos.workspaceConfig.upsert(
      defaultWorkspace({ id: WS, name: "ws", type: "employer_work", markdownRepoPath: "/tmp/ws", gbrainBrainId: "ws" }),
    );
    const card = await proposeAndApprove(off, "retry");
    expect(await dispatchExternalApproval(card, depsFor(off))).toEqual({ kind: "refused", reason: "writes_off" });
    off.close();

    const v = vendor();
    const on = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT], dbPath, writeTransport: { enabled: true, make: () => v.transport } },
      { candidateOutput: {} },
    );
    open.push(on);
    expect(await dispatchExternalApproval(card, depsFor(on))).toEqual({ kind: "dispatched", status: "created" });
    expect(v.calls.filter((c) => c.op === "create")).toHaveLength(1);
  });
});

describe("the propose sink under a race (its contract b)", () => {
  it("two identical concurrent proposals: both succeed, exactly one card is created, one entry is saved", async () => {
    const b = await backends(vendor().transport);
    const sink = createApprovalsProposeSink({ approvals: b.repos.approvals, workspaceConfig: b.repos.workspaceConfig, outbox: b.repos.outbox, now: () => NOW });
    const { action, envelope } = linearIssue("race");
    const [r1, r2] = await Promise.all([
      sink.record({ action, envelope, workspaceId: WS }),
      sink.record({ action, envelope, workspaceId: WS }),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    expect([r1, r2].filter((r) => r.ok && r.value.created)).toHaveLength(1);
    expect(await cardCount(b)).toBe(1);
  });
});

describe("⛔ OWNER DECISION, per system: only Linear has a real sender", () => {
  it("a non-Linear card approved while ONLY Linear is armed is refused as writes_off and stays retryable — never closed", async () => {
    const v = vendor();
    const b = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT], writeTransport: { enabled: true, targets: ["linear"], make: () => v.transport } },
      { candidateOutput: {} },
    );
    open.push(b);
    const up = await b.repos.workspaceConfig.upsert(
      defaultWorkspace({ id: WS, name: "ws", type: "employer_work", markdownRepoPath: "/tmp/ws", gbrainBrainId: "ws" }),
    );
    expect(up.ok).toBe(true);
    const sink = createApprovalsProposeSink({ approvals: b.repos.approvals, workspaceConfig: b.repos.workspaceConfig, outbox: b.repos.outbox, now: () => NOW });
    const { action, envelope } = linearIssue("todo");
    const todo = { ...action, targetSystem: "todoist" as const };
    const rec = await sink.record({ action: todo, envelope: { ...envelope, targetSystem: "todoist" }, workspaceId: WS });
    if (!rec.ok) throw new Error("propose failed");
    const card = await b.repos.approvals.get(rec.value.approvalRef as Approval["id"]);
    if (!card.ok) throw new Error("card missing");
    await b.repos.approvals.applyTransition(card.value.id, "pending", { ...card.value, status: "approved" });
    const out = await dispatchExternalApproval({ ...card.value, status: "approved" }, depsFor(b));
    expect(out).toEqual({ kind: "refused", reason: "writes_off" });
    expect(v.calls).toHaveLength(0);
    expect((await entryFor(b, "todo")).status).toBe("proposed");
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
    const off = externalApprovalFailureToHealth({ kind: "not_sent", approvalId: "idem_x", reason: "writes_off" }, at);
    expect(off.failureClass).toBe("write_through_failed");
    expect(off.message).toBe("approved external write not sent: writes_off");
  });
});
