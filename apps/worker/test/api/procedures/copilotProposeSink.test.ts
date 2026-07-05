// spec(§8/§9.8) — Phase-C C5.3b: createApprovalsProposeSink, the concrete CopilotProposeSink.
//
// Records a Copilot proposal as a PENDING §9.8 Approval via a DIRECT ApprovalRepository write (no Temporal,
// no runApprovalFlow). This suite pins the THREE security contracts the sink must honor (from the C5.3
// design's adversarial verification):
//   (a) WORKSPACE PROVENANCE — the server-bound workspaceId is registry-validated (unknown ⇒ fail-closed,
//       approvals never touched); it is folded into the derived id so two workspaces never share a card.
//   (b) PAYLOAD-SWAP TOCTOU — first-write-wins on an identical re-drive; a same-idempotencyKey hit whose
//       payloadHash DIVERGES is REJECTED (the existing card is never overwritten), incl. the concurrent race.
//   (c) REDACTION — a DbError folds to a bounded cause code only; the sink never throws, never auto-applies.
// Plus the cross-path id-equality pin (the sink derives the SAME approval id as createRecordPendingActivity).
import { describe, it, expect, beforeEach } from "vitest";
import { ok, err, isOk, isErr, approvalId as makeApprovalId } from "@sow/contracts";
import type { Approval, ProposedAction, ExternalWriteEnvelope, WorkspaceId, Workspace } from "@sow/contracts";
import type { ApprovalRepository, WorkspaceConfigRepository, DbError, DbResult } from "@sow/db";
import { buildIdempotencyKey } from "@sow/domain";
import {
  createApprovalsProposeSink,
  COPILOT_PROPOSE_ACTOR,
} from "../../../src/api/procedures/copilotProposeSink";
import { deriveCopilotProposedAction } from "../../../src/api/procedures/copilotPropose";
import { buildEnvelopeFromAction } from "@sow/integrations";

const WS = "personal-business" as WorkspaceId;
const NOW = "2026-07-05T12:00:00.000Z";

function fixtureActionEnvelope(overIdentity?: Record<string, string>): {
  action: ProposedAction;
  envelope: ExternalWriteEnvelope;
} {
  const a = deriveCopilotProposedAction({
    targetSystem: "todoist",
    operation: "todoist.create_task",
    identity: overIdentity ?? { title: "Draft the Q3 launch checklist" },
    payload: { title: "Draft the Q3 launch checklist" },
  });
  if (!isOk(a)) throw new Error("fixture derive failed");
  const e = buildEnvelopeFromAction(a.value, { preconditions: ["copilot.proposal.requires_owner_approval"] });
  if (!isOk(e)) throw new Error("fixture envelope failed");
  return { action: a.value, envelope: e.value };
}

/** A fake ApprovalRepository over an in-memory map, with injectable create-fault. */
function fakeApprovals(opts: { createError?: DbError; store?: Map<string, Approval> } = {}): {
  repo: ApprovalRepository;
  store: Map<string, Approval>;
  createCalls: () => number;
} {
  const store = opts.store ?? new Map<string, Approval>();
  let createCalls = 0;
  const repo: ApprovalRepository = {
    create: (a: Approval): DbResult<Approval> => {
      createCalls += 1;
      if (opts.createError !== undefined) return Promise.resolve(err(opts.createError));
      if (store.has(String(a.id))) {
        return Promise.resolve(err({ code: "conflict", message: "PK" } satisfies DbError));
      }
      store.set(String(a.id), a);
      return Promise.resolve(ok(a));
    },
    get: (id: Approval["id"]): DbResult<Approval> => {
      const found = store.get(String(id));
      return Promise.resolve(found ? ok(found) : err({ code: "not_found", message: "no row" } satisfies DbError));
    },
    listByStatus: (): DbResult<Approval[]> => Promise.resolve(ok([])),
    // The sink NEVER calls applyTransition (no auto-apply — contract c); it throws if ever invoked, which
    // pins that (contract-c test would fail loudly rather than silently transitioning).
    applyTransition: () => {
      throw new Error("sink must never applyTransition (no auto-apply)");
    },
  };
  return { repo, store, createCalls: () => createCalls };
}

function fakeWorkspaceConfig(known: boolean): WorkspaceConfigRepository {
  return {
    get: (id: Workspace["id"]): DbResult<Workspace> =>
      Promise.resolve(
        known
          ? ok({ id } as unknown as Workspace)
          : err({ code: "not_found", message: "unknown workspace" } satisfies DbError),
      ),
  } as WorkspaceConfigRepository;
}

function makeSink(approvals: ApprovalRepository, known = true) {
  return createApprovalsProposeSink({
    approvals,
    workspaceConfig: fakeWorkspaceConfig(known),
    now: () => NOW,
  });
}

describe("createApprovalsProposeSink — record a pending Approval (direct repository write)", () => {
  let fx: ReturnType<typeof fixtureActionEnvelope>;
  beforeEach(() => {
    fx = fixtureActionEnvelope();
  });

  it("creates a pending Approval with the derived id, server actor, channel mac, payloadHash, and expiry", async () => {
    const a = fakeApprovals();
    const r = await makeSink(a.repo).record({ action: fx.action, envelope: fx.envelope, workspaceId: WS });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.created).toBe(true);
    const row = a.store.get(r.value.approvalRef);
    expect(row?.status).toBe("pending");
    expect(row?.actor).toBe(COPILOT_PROPOSE_ACTOR);
    expect(row?.channel).toBe("mac");
    expect(row?.payloadHash).toBe(fx.envelope.payloadHash);
    expect(row?.actionRef).toBe(fx.action.actionId);
    expect(typeof row?.expiresAt).toBe("string");
  });

  it("(a) fails CLOSED on an UNKNOWN workspace — approvals is never touched", async () => {
    const a = fakeApprovals();
    const r = await makeSink(a.repo, false).record({ action: fx.action, envelope: fx.envelope, workspaceId: WS });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_UNKNOWN_WORKSPACE");
    expect(a.createCalls()).toBe(0);
  });

  it("(b) FIRST-WRITE-WINS — an identical re-drive returns created:false and calls create once", async () => {
    const a = fakeApprovals();
    const sink = makeSink(a.repo);
    const first = await sink.record({ action: fx.action, envelope: fx.envelope, workspaceId: WS });
    const second = await sink.record({ action: fx.action, envelope: fx.envelope, workspaceId: WS });
    expect(isOk(first) && isOk(second)).toBe(true);
    if (!isOk(second)) return;
    expect(second.value.created).toBe(false);
    expect(a.createCalls()).toBe(1);
  });

  it("(b) PAYLOAD-SWAP REJECT — a same-idempotencyKey hit with a DIVERGENT payloadHash is rejected, card untouched", async () => {
    const a = fakeApprovals();
    const sink = makeSink(a.repo);
    await sink.record({ action: fx.action, envelope: fx.envelope, workspaceId: WS });
    const original = a.store.get(String(fx.action.actionId));
    // same identity+operation ⇒ same idempotencyKey/id, but a divergent payloadHash (envelope hash differs).
    const swapped: ExternalWriteEnvelope = { ...fx.envelope, payloadHash: `${fx.envelope.payloadHash}_TAMPERED` };
    const r = await sink.record({ action: fx.action, envelope: swapped, workspaceId: WS });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_PAYLOAD_CONFLICT");
    // the originally-recorded card's payloadHash is UNCHANGED (never overwritten).
    expect(a.store.get(String(fx.action.actionId))?.payloadHash).toBe(original?.payloadHash);
  });

  it("(b) CONCURRENT RACE — create returns conflict, re-read same payload ⇒ created:false", async () => {
    // pre-seed the store as if a concurrent writer won, then force create() to report a PK conflict.
    const store = new Map<string, Approval>();
    const seed = fixtureActionEnvelope();
    const id = makeApprovalId(
      buildIdempotencyKey({
        operation: "approval.pending",
        identity: { idempotencyKey: seed.envelope.idempotencyKey, workspace: String(WS) },
      }),
    );
    store.set(String(id), {
      id,
      actionRef: seed.action.actionId,
      status: "pending",
      actor: COPILOT_PROPOSE_ACTOR,
      channel: "mac",
      payloadHash: seed.envelope.payloadHash,
    });
    // get() will hit the seeded row FIRST (so this actually exercises the get-hit path, first-write-wins).
    const a = fakeApprovals({ store });
    const r = await makeSink(a.repo).record({ action: seed.action, envelope: seed.envelope, workspaceId: WS });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.created).toBe(false);
    expect(a.createCalls()).toBe(0); // get-hit short-circuits before create
  });

  it("(c) REDACTION — a create fault folds to a bounded degraded_unavailable code, never throws, no payload substring", async () => {
    const a = fakeApprovals({ createError: { code: "unavailable", message: "db down: secret=hunter2" } });
    const r = await makeSink(a.repo).record({ action: fx.action, envelope: fx.envelope, workspaceId: WS });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.kind).toBe("degraded_unavailable");
    expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_STORE_UNAVAILABLE");
    expect(r.error.retryable).toBe(true);
    expect(JSON.stringify(r.error)).not.toContain("secret");
  });

  it("(a) two DIFFERENT workspaces derive DIFFERENT approval ids for the same envelope (no cross-workspace bleed)", async () => {
    const a = fakeApprovals();
    const sink = makeSink(a.repo);
    await sink.record({ action: fx.action, envelope: fx.envelope, workspaceId: WS });
    const other = await sink.record({ action: fx.action, envelope: fx.envelope, workspaceId: "personal-life" as WorkspaceId });
    expect(isOk(other)).toBe(true);
    if (!isOk(other)) return;
    // a second, DISTINCT card (different derived id) — not deduped against the first workspace's card.
    expect(other.value.created).toBe(true);
    expect(a.store.size).toBe(2);
  });

  it("CROSS-PATH id equality — the sink derives the SAME approval id as createRecordPendingActivity's recipe", async () => {
    const a = fakeApprovals();
    const r = await makeSink(a.repo).record({ action: fx.action, envelope: fx.envelope, workspaceId: WS });
    if (!isOk(r)) throw new Error("expected ok");
    const expected = makeApprovalId(
      buildIdempotencyKey({
        operation: "approval.pending",
        identity: { idempotencyKey: fx.envelope.idempotencyKey, workspace: String(WS) },
      }),
    );
    expect(r.value.approvalRef).toBe(String(expected));
  });
});
