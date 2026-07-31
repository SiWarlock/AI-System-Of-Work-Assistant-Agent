// spec(§6 KN-10 / §9.8 Approvals; ⚠SAFETY; 13.8i) — createProposeKnowledgeApprovalPort: the thin
// composition-root adapter that lets `runSourceIngestion` (Temporal workflow-sandbox code, cannot import
// @sow/db/worker adapters) route a withheld PROPOSE-tier living-vault plan into a PENDING §9.8 Approval
// by REUSING the EXISTING `CopilotKnowledgeProposeSink` (apps/worker/src/api/procedures/
// copilotProposeKnowledgeSink.ts) — never a second minting site (contracts L39/L61).
//
// This test does NOT re-verify the sink's own security contracts (workspace provenance, payload-swap
// TOCTOU, redaction) — those are pinned exhaustively in copilotProposeKnowledgeSink.test.ts. It verifies
// ONLY this adapter's own mapping contract: delegates verbatim, folds a sink error/throw to the closed
// `mint_failed` port error (never leaking the raw FailureVariant detail), and — the highest-value case —
// that the sink's OWN idempotency-by-planId survives unmangled through the adapter (a re-drive mints no
// duplicate Approval).
import { describe, it, expect } from "vitest";
import { ok, err, isOk } from "@sow/contracts";
import type { Approval, FailureVariant, KnowledgeMutationPlan, Workspace, WorkspaceId } from "@sow/contracts";
import type { DbError, DbResult, PendingKnowledgeMutation, PendingKnowledgeMutationRepository, WorkspaceConfigRepository, ApprovalRepository } from "@sow/db";
import { createProposeKnowledgeApprovalPort } from "../src/composition/living-vault";
import { createApprovalsKnowledgeProposeSink } from "../src/api/procedures/copilotProposeKnowledgeSink";
import type { CopilotKnowledgeProposeSink } from "../src/api/procedures/copilotProposeKnowledgeSink";

const WS = "ws-employer" as WorkspaceId;
const NOW = "2026-07-31T00:00:00.000Z";

function plan(over: Partial<KnowledgeMutationPlan> = {}): KnowledgeMutationPlan {
  return {
    planId: "plan-lv-propose-1",
    workspaceId: WS,
    sourceRefs: [{ sourceId: "src-1" }],
    creates: [],
    patches: [],
    linkMutations: [],
    frontmatterUpdates: [],
    externalActionProposals: [],
    confidence: 0.9,
    requiresApproval: true,
    provenanceOrigin: "ingestion",
    ...over,
  } as unknown as KnowledgeMutationPlan;
}

describe("createProposeKnowledgeApprovalPort — 13.8i adapter contract (a thin wrapper over the EXISTING sink)", () => {
  it("delegates to sink.record({plan, workspaceId}) and forwards a successful mint verbatim", async () => {
    let calls = 0;
    const fakeSink: CopilotKnowledgeProposeSink = {
      record: async (input) => {
        calls += 1;
        expect(input.plan).toBe(plan_);
        expect(input.workspaceId).toBe(WS);
        return ok({ approvalRef: "apr_1", planRef: "plan-lv-propose-1", created: true });
      },
    };
    const plan_ = plan();
    const port = createProposeKnowledgeApprovalPort(fakeSink);
    const res = await port.propose(plan_, WS);

    expect(calls).toBe(1);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual({ approvalRef: "apr_1", created: true });
  });

  it("folds a sink FailureVariant err to the closed mint_failed code — never leaks the raw detail", async () => {
    const rawFailure: FailureVariant = {
      kind: "write_conflict",
      message: "raw internal store detail that must never cross",
      cause: { code: "COPILOT_PROPOSE_KNOWLEDGE_PLAN_CONFLICT" },
    } as unknown as FailureVariant;
    const fakeSink: CopilotKnowledgeProposeSink = {
      record: async () => err(rawFailure),
    };
    const port = createProposeKnowledgeApprovalPort(fakeSink);
    const res = await port.propose(plan(), WS);

    expect(isOk(res)).toBe(false);
    if (!isOk(res)) {
      expect(res.error.code).toBe("mint_failed");
      expect(res.error.message).not.toContain("raw internal store detail");
    }
  });

  it("folds a THROWING sink to the closed mint_failed code — never throws (§16)", async () => {
    const fakeSink: CopilotKnowledgeProposeSink = {
      record: async () => {
        throw new Error("boom — raw driver detail must never cross");
      },
    };
    const port = createProposeKnowledgeApprovalPort(fakeSink);
    const res = await port.propose(plan(), WS);

    expect(isOk(res)).toBe(false);
    if (!isOk(res)) {
      expect(res.error.code).toBe("mint_failed");
      expect(res.error.message).not.toContain("boom");
    }
  });

  it("a re-drive mints NO duplicate Approval — the REAL sink's idempotency survives unmangled through the adapter", async () => {
    // Drives the REAL createApprovalsKnowledgeProposeSink (not a fake) over fake DB repos — proving the
    // adapter introduces no extra state that could break the sink's own planId-keyed idempotency.
    const approvalsStore = new Map<string, Approval>();
    const approvals: ApprovalRepository = {
      create: (a: Approval): DbResult<Approval> => {
        if (approvalsStore.has(String(a.id))) return Promise.resolve(err({ code: "conflict", message: "PK" } satisfies DbError));
        approvalsStore.set(String(a.id), a);
        return Promise.resolve(ok(a));
      },
      get: (id: Approval["id"]): DbResult<Approval> => {
        const found = approvalsStore.get(String(id));
        return Promise.resolve(found ? ok(found) : err({ code: "not_found", message: "no row" } satisfies DbError));
      },
      listByStatus: (): DbResult<Approval[]> => Promise.resolve(ok([])),
      listByStatusAndWorkspace: (): DbResult<Approval[]> => Promise.resolve(ok([])),
      applyTransition: () => {
        throw new Error("must never be called here");
      },
    };
    const pendingStore = new Map<string, PendingKnowledgeMutation>();
    const pendingKmp: PendingKnowledgeMutationRepository = {
      record: (e: PendingKnowledgeMutation): DbResult<PendingKnowledgeMutation> => {
        if (pendingStore.has(e.planId)) return Promise.resolve(err({ code: "conflict", message: "PK" } satisfies DbError));
        pendingStore.set(e.planId, e);
        return Promise.resolve(ok(e));
      },
      get: (planIdStr: string): DbResult<PendingKnowledgeMutation> => {
        const found = pendingStore.get(planIdStr);
        return Promise.resolve(found ? ok(found) : err({ code: "not_found", message: "no row" } satisfies DbError));
      },
      update: (e: PendingKnowledgeMutation): DbResult<PendingKnowledgeMutation> => {
        pendingStore.set(e.planId, e);
        return Promise.resolve(ok(e));
      },
    };
    const workspaceConfig: WorkspaceConfigRepository = {
      get: (id: Workspace["id"]): DbResult<Workspace> => Promise.resolve(ok({ id } as unknown as Workspace)),
    } as WorkspaceConfigRepository;

    const sink = createApprovalsKnowledgeProposeSink({ approvals, pendingKmp, workspaceConfig, now: () => NOW });
    const port = createProposeKnowledgeApprovalPort(sink);

    const same = plan();
    const first = await port.propose(same, WS);
    const second = await port.propose(same, WS); // the re-drive: SAME plan, SAME planId

    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (isOk(first) && isOk(second)) {
      expect(first.value.created).toBe(true);
      expect(second.value.created).toBe(false); // idempotent no-op, not a second Approval
      expect(second.value.approvalRef).toBe(first.value.approvalRef); // the SAME card
    }
    expect(approvalsStore.size).toBe(1); // exactly one Approval row exists, never two
  });
});
