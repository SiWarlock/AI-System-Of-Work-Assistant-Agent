// Task 13.8i-B — `withProposeKnowledgeApproval`: the bootWorker post-processor that binds the
// propose-knowledge-approval port onto ProofSpineParams, for BOTH the source-ingestion and
// meeting-closeout paths (one shared port instance, two activity names at the composition layer).
// spec(§6 KN-10) spec(§9.8)
//
// UNLIKE `withSubscriptionExtractionArming`, this is NOT a flag-gated arming crossing — it binds
// UNCONDITIONALLY whenever `proofSpineParams` exists at all (mirrors `withDurableRevisions`'s OFF-path
// passthrough: `proofSpineParams === undefined` ⇒ unchanged, nothing constructed — the slice-1
// owner-opt-in invariant). Test 3 below is the structural proof that no Copilot flag gates this binding.
import { describe, it, expect } from "vitest";
import { ok, err } from "@sow/contracts";
import type { Approval, Workspace } from "@sow/contracts";
import type {
  ApprovalRepository,
  DbError,
  DbResult,
  PendingKnowledgeMutation,
  PendingKnowledgeMutationRepository,
  WorkspaceConfigRepository,
} from "@sow/db";
import { withProposeKnowledgeApproval } from "../../src/boot";
import type { ProofSpineParams } from "../../src/composition/buildActivities";
import type { ProofSpineBackends } from "../../src/composition/backends";

const NOW = "2026-08-11T00:00:00.000Z";

/** A repo whose every method THROWS — proves the OFF path never even touches it. */
function throwingApprovals(): ApprovalRepository {
  const boom = () => {
    throw new Error("must not be touched on the OFF path");
  };
  return { create: boom, get: boom, listByStatus: boom, listByStatusAndWorkspace: boom, applyTransition: boom } as unknown as ApprovalRepository;
}
function throwingPendingKmp(): PendingKnowledgeMutationRepository {
  const boom = () => {
    throw new Error("must not be touched on the OFF path");
  };
  return { record: boom, get: boom, update: boom } as unknown as PendingKnowledgeMutationRepository;
}
function throwingWorkspaceConfig(): WorkspaceConfigRepository {
  return {
    get: () => {
      throw new Error("must not be touched on the OFF path");
    },
  } as unknown as WorkspaceConfigRepository;
}

/** A minimal real-shaped backends fake — only the four fields the sink needs. */
function makeBackends(): ProofSpineBackends {
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
  const pendingKnowledgeMutations: PendingKnowledgeMutationRepository = {
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

  return {
    repos: { approvals, pendingKnowledgeMutations, workspaceConfig } as unknown as ProofSpineBackends["repos"],
    now: () => NOW,
  } as unknown as ProofSpineBackends;
}

function throwingBackends(): ProofSpineBackends {
  return {
    repos: {
      approvals: throwingApprovals(),
      pendingKnowledgeMutations: throwingPendingKmp(),
      workspaceConfig: throwingWorkspaceConfig(),
    } as unknown as ProofSpineBackends["repos"],
    now: (): string => {
      throw new Error("must not be touched on the OFF path");
    },
  } as unknown as ProofSpineBackends;
}

const baseParams = { proposeKnowledgeApproval: undefined } as unknown as ProofSpineParams;

describe("withProposeKnowledgeApproval — unconditional bind, no separate arming flag (13.8i-B)", () => {
  it("OFF path: undefined params → undefined (the sink is NEVER constructed / backends untouched)", () => {
    expect(withProposeKnowledgeApproval(undefined, throwingBackends())).toBeUndefined();
  });

  it("ON path: binds a real, callable proposeKnowledgeApproval port", async () => {
    const out = withProposeKnowledgeApproval(baseParams, makeBackends());
    expect(out).toBeDefined();
    if (out === undefined) return;
    expect(out.proposeKnowledgeApproval).toBeDefined();
    const plan = {
      planId: "plan-bind-1",
      workspaceId: "ws-1",
      creates: [],
      patches: [],
      linkMutations: [],
      frontmatterUpdates: [],
      externalActionProposals: [],
      sourceRefs: [{ sourceId: "src-1" }],
      confidence: 0.9,
      requiresApproval: true,
      provenanceOrigin: "ingestion",
    } as never;
    const res = await out.proposeKnowledgeApproval?.propose(plan, "ws-1" as never);
    expect(res).toBeDefined();
  });

  it("no Copilot flag gates this binding — the function takes no config/flag argument at all", () => {
    // Structural: withProposeKnowledgeApproval's signature is (params, backends) — there is no third
    // `config`/flag parameter it could branch on, so `copilotRealModel`/`copilotAgentMode` cannot gate
    // it even accidentally. Pinned by arity rather than by probing config values that don't exist here.
    expect(withProposeKnowledgeApproval.length).toBe(2);
  });

  it("binding does not touch livingVault/meetingVault — the two arming gates stay independent", () => {
    const params = {
      proposeKnowledgeApproval: undefined,
      livingVault: undefined,
      meetingVault: undefined,
    } as unknown as ProofSpineParams;
    const out = withProposeKnowledgeApproval(params, makeBackends());
    expect(out).toBeDefined();
    if (out === undefined) return;
    // Unchanged — this post-processor adds proposeKnowledgeApproval and nothing else.
    expect(out.livingVault).toBeUndefined();
    expect(out.meetingVault).toBeUndefined();
  });
});
