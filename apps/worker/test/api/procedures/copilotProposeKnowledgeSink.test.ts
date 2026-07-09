// spec(§13.10a) — Slice E: createApprovalsKnowledgeProposeSink, the concrete KMP-propose sink.
//
// The SEMANTIC-write sibling of createApprovalsProposeSink (copilotProposeSink.test.ts). Records a derived,
// validated KnowledgeMutationPlan as (1) a PENDING row in the pending-KMP store AND (2) a PENDING §9.8
// Approval carrying subjectKind:"semantic_mutation" + planRef → the stored plan. On owner approval the
// executor (Slice F) re-fetches the plan and commits via KnowledgeWriter. This suite pins the security
// contracts (mirroring the external sink + the Slice-C/D forward-guidance):
//   (a) WORKSPACE PROVENANCE — registry-validate the server-bound workspaceId (unknown ⇒ fail-closed); AND
//       cross-check the KMP's own plan.workspaceId against it (FG-1: a plan for X never recorded under Y).
//   (b) PAYLOAD-SWAP TOCTOU — the pending-KMP store is first-write-wins; a same-planId hit with a DIVERGENT
//       payloadHash is REJECTED. KMP store recorded FIRST (no dangling Approval).
//   (c) REDACTION + NO AUTO-APPLY — bounded cause codes; never throws; never applyTransition/applyPlan.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, approvalId as makeApprovalId } from "@sow/contracts";
import type {
  Approval,
  KnowledgeMutationPlan,
  SourceId,
  SourceRef,
  Workspace,
  WorkspaceId,
} from "@sow/contracts";
import type {
  ApprovalRepository,
  DbError,
  DbResult,
  PendingKnowledgeMutation,
  PendingKnowledgeMutationRepository,
  WorkspaceConfigRepository,
} from "@sow/db";
import { buildIdempotencyKey } from "@sow/domain";
import { payloadHash } from "@sow/integrations";
import { deriveCopilotProjectKnowledgePlan } from "../../../src/api/procedures/copilotProposeKnowledge";
import {
  createApprovalsKnowledgeProposeSink,
  COPILOT_PROPOSE_KNOWLEDGE_ACTOR,
} from "../../../src/api/procedures/copilotProposeKnowledgeSink";

const WS = "personal-business" as WorkspaceId;
const NOW = "2026-07-08T12:00:00.000Z";
const SOURCE_REF: SourceRef = { sourceId: "src-copilot-1" as SourceId };

/** Derive a genuinely-valid KMP (the same path Slice B produces), for a fresh (create) note by default. */
function kmpFor(
  over: { projectId?: string; title?: string; lifecycleState?: string; summary?: string; workspaceId?: WorkspaceId } = {},
): KnowledgeMutationPlan {
  const r = deriveCopilotProjectKnowledgePlan(
    {
      projectId: over.projectId ?? "q3-launch",
      title: over.title ?? "Q3 Launch",
      lifecycleState: over.lifecycleState ?? "active",
      ...(over.summary !== undefined ? { summary: over.summary } : {}),
    },
    { workspaceId: over.workspaceId ?? WS, sourceRef: SOURCE_REF, noteExists: false },
  );
  if (!isOk(r)) throw new Error("fixture KMP derive failed");
  return r.value;
}

/** A fake ApprovalRepository over an in-memory map (create/get; applyTransition throws — no auto-apply). */
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
      if (store.has(String(a.id))) return Promise.resolve(err({ code: "conflict", message: "PK" } satisfies DbError));
      store.set(String(a.id), a);
      return Promise.resolve(ok(a));
    },
    get: (id: Approval["id"]): DbResult<Approval> => {
      const found = store.get(String(id));
      return Promise.resolve(found ? ok(found) : err({ code: "not_found", message: "no row" } satisfies DbError));
    },
    listByStatus: (): DbResult<Approval[]> => Promise.resolve(ok([])),
    listByStatusAndWorkspace: (): DbResult<Approval[]> => Promise.resolve(ok([])),
    applyTransition: () => {
      throw new Error("sink must never applyTransition (no auto-apply)");
    },
  };
  return { repo, store, createCalls: () => createCalls };
}

/** A fake pending-KMP store: first-write-wins record (dup planId → conflict), get, update. */
function fakePendingKmp(
  opts: { recordError?: DbError; getError?: DbError; store?: Map<string, PendingKnowledgeMutation> } = {},
): {
  repo: PendingKnowledgeMutationRepository;
  store: Map<string, PendingKnowledgeMutation>;
  recordCalls: () => number;
} {
  const store = opts.store ?? new Map<string, PendingKnowledgeMutation>();
  let recordCalls = 0;
  const repo: PendingKnowledgeMutationRepository = {
    record: (e: PendingKnowledgeMutation): DbResult<PendingKnowledgeMutation> => {
      recordCalls += 1;
      if (opts.recordError !== undefined) return Promise.resolve(err(opts.recordError));
      if (store.has(e.planId)) return Promise.resolve(err({ code: "conflict", message: "PK" } satisfies DbError));
      store.set(e.planId, e);
      return Promise.resolve(ok(e));
    },
    get: (planId: string): DbResult<PendingKnowledgeMutation> => {
      if (opts.getError !== undefined) return Promise.resolve(err(opts.getError));
      const found = store.get(planId);
      return Promise.resolve(found ? ok(found) : err({ code: "not_found", message: "no row" } satisfies DbError));
    },
    update: (e: PendingKnowledgeMutation): DbResult<PendingKnowledgeMutation> => {
      if (!store.has(e.planId)) return Promise.resolve(err({ code: "not_found", message: "no row" } satisfies DbError));
      store.set(e.planId, e);
      return Promise.resolve(ok(e));
    },
  };
  return { repo, store, recordCalls: () => recordCalls };
}

function fakeWorkspaceConfig(known: boolean): WorkspaceConfigRepository {
  return {
    get: (id: Workspace["id"]): DbResult<Workspace> =>
      Promise.resolve(
        known ? ok({ id } as unknown as Workspace) : err({ code: "not_found", message: "unknown" } satisfies DbError),
      ),
  } as WorkspaceConfigRepository;
}

function makeSink(approvals: ApprovalRepository, pendingKmp: PendingKnowledgeMutationRepository, known = true) {
  return createApprovalsKnowledgeProposeSink({
    approvals,
    pendingKmp,
    workspaceConfig: fakeWorkspaceConfig(known),
    now: () => NOW,
  });
}

describe("createApprovalsKnowledgeProposeSink — record a pending semantic-mutation card + stored KMP", () => {
  it("records BOTH stores: a semantic_mutation Approval (planRef, NO actionRef) + the pending-KMP row", async () => {
    const plan = kmpFor();
    const hash = payloadHash(plan as unknown as Record<string, unknown>);
    const a = fakeApprovals();
    const k = fakePendingKmp();
    const r = await makeSink(a.repo, k.repo).record({ plan, workspaceId: WS });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.created).toBe(true);
    expect(r.value.planRef).toBe(String(plan.planId));

    // (1) the Approval card
    const card = a.store.get(r.value.approvalRef);
    expect(card?.subjectKind).toBe("semantic_mutation");
    expect(card?.planRef).toBe(plan.planId);
    expect(card?.actionRef).toBeUndefined();
    expect(card?.workspaceId).toBe(WS);
    expect(card?.status).toBe("pending");
    expect(card?.actor).toBe(COPILOT_PROPOSE_KNOWLEDGE_ACTOR);
    expect(card?.channel).toBe("mac");
    expect(card?.payloadHash).toBe(hash);
    expect(typeof card?.expiresAt).toBe("string");

    // (2) the pending-KMP row — plan + matching hash + pending; payloadHash === the Approval's (TOCTOU link)
    const row = k.store.get(String(plan.planId));
    expect(row?.status).toBe("pending");
    expect(row?.workspaceId).toBe(String(WS));
    expect(row?.payloadHash).toBe(hash);
    expect(row?.plan).toEqual(plan);
  });

  it("§13.10a gate 3 (FG-2 robustness) — stamps the PERSISTED-form hash so a present-undefined value can't diverge the executor's re-hash", async () => {
    // A schema-legal present-`undefined` optional. `payloadHash` maps it to a sentinel, but the store
    // persists `plan` as JSON — a round-trip DROPS the key. The sink MUST hash the persisted form so the
    // executor (re-hashing the round-tripped row.plan for FG-2) always matches.
    const withUndef = { ...kmpFor(), gbrainProposalRef: undefined } as unknown as KnowledgeMutationPlan;
    const persistedHash = payloadHash(JSON.parse(JSON.stringify(withUndef)) as Record<string, unknown>);
    const inMemoryHash = payloadHash(withUndef as unknown as Record<string, unknown>);
    expect(persistedHash).not.toBe(inMemoryHash); // sanity: the present-undefined key makes the forms diverge

    const a = fakeApprovals();
    const k = fakePendingKmp();
    const r = await makeSink(a.repo, k.repo).record({ plan: withUndef, workspaceId: WS });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    // BOTH stores carry the PERSISTED-form hash — what the executor reproduces — NOT the in-memory hash.
    expect(a.store.get(r.value.approvalRef)?.payloadHash).toBe(persistedHash);
    expect(k.store.get(String(withUndef.planId))?.payloadHash).toBe(persistedHash);
  });

  it("(a) fails CLOSED on an UNKNOWN workspace — NEITHER store is touched", async () => {
    const a = fakeApprovals();
    const k = fakePendingKmp();
    const r = await makeSink(a.repo, k.repo, false).record({ plan: kmpFor(), workspaceId: WS });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_KNOWLEDGE_UNKNOWN_WORKSPACE");
    expect(a.createCalls()).toBe(0);
    expect(k.recordCalls()).toBe(0);
  });

  it("(a/FG-1) rejects a plan whose workspaceId ≠ the server-bound workspaceId — NEITHER store touched", async () => {
    // Derive a plan for personal-life, then try to record it under personal-business (both registry-known).
    const foreignPlan = kmpFor({ workspaceId: "personal-life" as WorkspaceId });
    const a = fakeApprovals();
    const k = fakePendingKmp();
    const r = await makeSink(a.repo, k.repo).record({ plan: foreignPlan, workspaceId: WS });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_KNOWLEDGE_WORKSPACE_MISMATCH");
    expect(a.createCalls()).toBe(0);
    expect(k.recordCalls()).toBe(0);
  });

  it("(b) FIRST-WRITE-WINS — an identical re-record returns created:false and duplicates nothing", async () => {
    const plan = kmpFor();
    const a = fakeApprovals();
    const k = fakePendingKmp();
    const sink = makeSink(a.repo, k.repo);
    const first = await sink.record({ plan, workspaceId: WS });
    const second = await sink.record({ plan, workspaceId: WS });
    expect(isOk(first) && isOk(second)).toBe(true);
    if (!isOk(second)) return;
    expect(second.value.created).toBe(false);
    expect(a.store.size).toBe(1);
    expect(k.store.size).toBe(1);
  });

  it("(b) PAYLOAD-SWAP REJECT — same planId, DIVERGENT plan ⇒ rejected at the KMP store; stored plan untouched, no card for the swap", async () => {
    // Same projectId ⇒ same note path ⇒ same planId; different title ⇒ different content ⇒ different hash.
    const planA = kmpFor({ projectId: "same-proj", title: "Original" });
    const planB = kmpFor({ projectId: "same-proj", title: "TAMPERED" });
    expect(planA.planId).toBe(planB.planId); // same key
    const hashA = payloadHash(planA as unknown as Record<string, unknown>);
    const a = fakeApprovals();
    const k = fakePendingKmp();
    const sink = makeSink(a.repo, k.repo);
    await sink.record({ plan: planA, workspaceId: WS });
    const r = await sink.record({ plan: planB, workspaceId: WS });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_KNOWLEDGE_PLAN_CONFLICT");
    // the stored plan + hash are UNCHANGED (never overwritten); still exactly one card (planA's).
    expect(k.store.get(String(planA.planId))?.payloadHash).toBe(hashA);
    expect(a.store.size).toBe(1);
  });

  it("(b) ORDERING — the KMP store is recorded FIRST: a store fault means the Approval is NEVER created", async () => {
    const a = fakeApprovals();
    const k = fakePendingKmp({ recordError: { code: "unavailable", message: "db down: secret=hunter2" } });
    const r = await makeSink(a.repo, k.repo).record({ plan: kmpFor(), workspaceId: WS });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(a.createCalls()).toBe(0); // no dangling Approval
    expect(r.error.retryable).toBe(true);
    expect(JSON.stringify(r.error)).not.toContain("secret"); // (c) redaction
  });

  it("(c) REDACTION — an Approval-create fault folds to a bounded code, never leaks the driver message", async () => {
    const a = fakeApprovals({ createError: { code: "unavailable", message: "db down: secret=hunter2" } });
    const k = fakePendingKmp();
    const r = await makeSink(a.repo, k.repo).record({ plan: kmpFor(), workspaceId: WS });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.kind).toBe("degraded_unavailable");
    expect(JSON.stringify(r.error)).not.toContain("secret");
  });

  it("(b) CONCURRENT RACE — Approval create() returns conflict, re-read finds the racer's identical card ⇒ created:false", async () => {
    // Force the TRUE create()-conflict branch (distinct from a plain get-hit): get() MISSES on the first
    // probe (so we pass the get-then-create guard and reach create), create() reports a PK conflict (a
    // concurrent writer won), and the re-read then HITS the racer's identical-hash card → reconcile no-op.
    const plan = kmpFor();
    const hash = payloadHash(plan as unknown as Record<string, unknown>);
    const id = makeApprovalId(
      buildIdempotencyKey({
        operation: "approval.pending.knowledge",
        identity: { planRef: String(plan.planId), workspace: String(WS) },
      }),
    );
    const racerCard: Approval = {
      id,
      planRef: plan.planId,
      subjectKind: "semantic_mutation",
      workspaceId: WS,
      status: "pending",
      actor: COPILOT_PROPOSE_KNOWLEDGE_ACTOR,
      channel: "mac",
      payloadHash: hash,
    };
    let getCalls = 0;
    let createCalls = 0;
    const raceApprovals: ApprovalRepository = {
      create: () => {
        createCalls += 1;
        return Promise.resolve(err({ code: "conflict", message: "racer won" } satisfies DbError));
      },
      get: () => {
        getCalls += 1;
        // miss on the first probe (pre-create), hit the racer's card on the re-read (post-conflict).
        return Promise.resolve(getCalls === 1 ? err({ code: "not_found", message: "miss" }) : ok(racerCard));
      },
      listByStatus: () => Promise.resolve(ok([])),
      listByStatusAndWorkspace: () => Promise.resolve(ok([])),
      applyTransition: () => {
        throw new Error("no auto-apply");
      },
    };
    const k = fakePendingKmp();
    const r = await makeSink(raceApprovals, k.repo).record({ plan, workspaceId: WS });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.created).toBe(false); // reconciled against the racer's identical card
    expect(createCalls).toBe(1); // create WAS attempted (true race branch, not the get-hit short-circuit)
    expect(getCalls).toBe(2); // pre-create miss + post-conflict re-read
  });

  it("HEALS an orphan — pending-KMP row present (matching hash) but NO card ⇒ creates the missing card (created:true)", async () => {
    // A prior partial run recorded the plan but failed before creating the Approval. A retry: store.record →
    // conflict → re-read → hash MATCHES → fall through → approvals.get MISSES → create the card. This pins the
    // heal branch — a future early-return on store-conflict would silently break retry-heal with no failure.
    const plan = kmpFor();
    const hash = payloadHash(plan as unknown as Record<string, unknown>);
    const seeded = new Map<string, PendingKnowledgeMutation>([
      [String(plan.planId), { planId: String(plan.planId), workspaceId: String(WS), plan, payloadHash: hash, status: "pending", recordedAt: NOW }],
    ]);
    const a = fakeApprovals(); // NO card yet (the orphan case)
    const k = fakePendingKmp({ store: seeded });
    const r = await makeSink(a.repo, k.repo).record({ plan, workspaceId: WS });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.created).toBe(true); // the missing card was created (healed)
    expect(a.store.size).toBe(1);
    expect(k.store.size).toBe(1); // the pre-seeded plan row is untouched (not duplicated)
  });

  it("folds cleanly when the pending-KMP re-read itself fails after a record conflict (no Approval created)", async () => {
    // record() → conflict (planId already present), but the follow-up get() ERRORS → fold to a bounded store
    // failure; the Approval is NEVER reached (fail-closed, no dangling card).
    const plan = kmpFor();
    const seeded = new Map<string, PendingKnowledgeMutation>([
      [String(plan.planId), { planId: String(plan.planId), workspaceId: String(WS), plan, payloadHash: "sha256:x", status: "pending", recordedAt: NOW }],
    ]);
    const a = fakeApprovals();
    const k = fakePendingKmp({ store: seeded, getError: { code: "unavailable", message: "store down" } });
    const r = await makeSink(a.repo, k.repo).record({ plan, workspaceId: WS });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_KNOWLEDGE_STORE_UNAVAILABLE");
    expect(a.createCalls()).toBe(0);
  });

  it("derives a DETERMINISTIC, workspace-folded Approval id (planRef + workspace)", async () => {
    const plan = kmpFor();
    const a = fakeApprovals();
    const k = fakePendingKmp();
    const r = await makeSink(a.repo, k.repo).record({ plan, workspaceId: WS });
    if (!isOk(r)) throw new Error("expected ok");
    const expected = makeApprovalId(
      buildIdempotencyKey({
        operation: "approval.pending.knowledge",
        identity: { planRef: String(plan.planId), workspace: String(WS) },
      }),
    );
    expect(r.value.approvalRef).toBe(String(expected));
  });
});
