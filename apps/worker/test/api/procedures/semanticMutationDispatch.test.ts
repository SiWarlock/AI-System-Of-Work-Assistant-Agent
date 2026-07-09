// §13.10a — Slice F: on-approval → KnowledgeWriter executor (the SEMANTIC branch of the
// approval dispatcher). The most safety-critical slice: this is where a Copilot proposal
// FIRST commits real Markdown — and ONLY on owner approval, through KnowledgeWriter, never
// a direct/auto write (safety rules 1+2). The enforced preconditions (fetch-by-planRef,
// idempotency, FG-1 WS-8, FG-2 TOCTOU, candidate-data gate) are each pinned below.
import { describe, it, expect } from "vitest";
import { ok, err, isOk } from "@sow/contracts";
import type { Approval, Result } from "@sow/contracts";
import type {
  DbError,
  DbResult,
  PendingKnowledgeMutation,
  PendingKnowledgeMutationRepository,
} from "@sow/db";
import type {
  CommitKnowledgePort,
  KnowledgeCommitFailure,
} from "@sow/workflows";
import { payloadHash } from "@sow/integrations";
import {
  createSemanticMutationDispatch,
  createApprovalDispatchRouter,
  type SemanticMutationDispatchDeps,
} from "../../../src/api/procedures/semanticMutationDispatch";
import type { DispatchApprovalFn } from "../../../src/api/procedures/approvalCommands";

// ── fixtures ──────────────────────────────────────────────────────────────────

/** A schema-valid KnowledgeMutationPlan (passes KnowledgeMutationPlanSchema.safeParse). */
const validPlan: Record<string, unknown> = {
  planId: "plan-f-1",
  workspaceId: "personal-business",
  sourceRefs: [{ sourceId: "src-1" }],
  creates: [
    { path: "Projects/acme.md", title: "Acme", body: "# Acme", frontmatter: { projectId: "acme" } },
  ],
  patches: [],
  linkMutations: [],
  frontmatterUpdates: [],
  externalActionProposals: [],
  confidence: 0.5,
  requiresApproval: true,
  provenanceOrigin: "copilot_propose",
};
/** The canonical, replay-stable hash the sink wrote onto BOTH the row + the Approval. */
const HASH = payloadHash(validPlan);
const NOW = "2026-07-08T12:00:00.000Z";

function mkRow(over: Partial<PendingKnowledgeMutation> = {}): PendingKnowledgeMutation {
  return {
    planId: "plan-f-1",
    workspaceId: "personal-business",
    plan: validPlan,
    payloadHash: HASH,
    status: "pending",
    recordedAt: "2026-07-08T00:00:00.000Z",
    ...over,
  };
}

function mkApproval(over: Record<string, unknown> = {}): Approval {
  return {
    id: "appr-1",
    planRef: "plan-f-1",
    subjectKind: "semantic_mutation",
    workspaceId: "personal-business",
    status: "approved",
    actor: "copilot-propose",
    channel: "mac",
    payloadHash: HASH,
    ...over,
  } as unknown as Approval;
}

// ── fakes ───────────────────────────────────────────────────────────────────

/** Mirror the real DB adapter: a stored plan is JSON-serialized, so the read-back is a round-trip. */
const roundTrip = <T,>(v: T): unknown => JSON.parse(JSON.stringify(v));

function fakePendingKmp(
  seed: PendingKnowledgeMutation | undefined,
  opts: { getError?: DbError; updateError?: DbError } = {},
): { repo: PendingKnowledgeMutationRepository; store: Map<string, PendingKnowledgeMutation> } {
  const store = new Map<string, PendingKnowledgeMutation>();
  // Persist the seed the way the real store does — the plan blob is JSON-round-tripped on read-back,
  // so FG-2's re-hash is tested against the PERSISTED form (not a retained in-memory reference).
  if (seed) store.set(seed.planId, { ...seed, plan: roundTrip(seed.plan) });
  const repo: PendingKnowledgeMutationRepository = {
    record: (e: PendingKnowledgeMutation): DbResult<PendingKnowledgeMutation> => {
      if (store.has(e.planId)) return Promise.resolve(err({ code: "conflict", message: "PK" } satisfies DbError));
      store.set(e.planId, e);
      return Promise.resolve(ok(e));
    },
    get: (planId: string): DbResult<PendingKnowledgeMutation> => {
      if (opts.getError !== undefined) return Promise.resolve(err(opts.getError));
      const found = store.get(planId);
      return Promise.resolve(found ? ok(found) : err({ code: "not_found", message: "nf" } satisfies DbError));
    },
    update: (e: PendingKnowledgeMutation): DbResult<PendingKnowledgeMutation> => {
      if (opts.updateError !== undefined) return Promise.resolve(err(opts.updateError));
      if (!store.has(e.planId)) return Promise.resolve(err({ code: "not_found", message: "nf" } satisfies DbError));
      store.set(e.planId, e);
      return Promise.resolve(ok(e));
    },
  };
  return { repo, store };
}

function fakeCommit(opts: { failure?: KnowledgeCommitFailure; replayed?: boolean } = {}): {
  port: CommitKnowledgePort;
  calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  const port: CommitKnowledgePort = {
    commit: (plan) => {
      calls.push(plan as unknown as Record<string, unknown>);
      if (opts.failure !== undefined) return Promise.resolve(err(opts.failure));
      return Promise.resolve(ok({ revisionId: "rev-f-1", replayed: opts.replayed ?? false }));
    },
  };
  return { port, calls };
}

function makeDispatch(
  seed: PendingKnowledgeMutation | undefined,
  opts: {
    kmp?: { getError?: DbError; updateError?: DbError };
    commit?: { failure?: KnowledgeCommitFailure; replayed?: boolean };
  } = {},
): {
  dispatch: DispatchApprovalFn;
  kmp: ReturnType<typeof fakePendingKmp>;
  commit: ReturnType<typeof fakeCommit>;
} {
  const kmp = fakePendingKmp(seed, opts.kmp);
  const commit = fakeCommit(opts.commit);
  const deps: SemanticMutationDispatchDeps = { pendingKmp: kmp.repo, commit: commit.port, now: () => NOW };
  return { dispatch: createSemanticMutationDispatch(deps), kmp, commit };
}

const assertErr = <T,>(r: Result<T, { kind: string; cause?: { code: string } }>): { kind: string; cause?: { code: string } } => {
  if (r.ok) throw new Error("expected err, got ok");
  return r.error;
};

// ── the executor ────────────────────────────────────────────────────────────

describe("createSemanticMutationDispatch — approved commit path", () => {
  it("commits the KMP via KnowledgeWriter and marks the row committed + settledAt", async () => {
    const { dispatch, kmp, commit } = makeDispatch(mkRow());
    const r = await dispatch(mkApproval());
    expect(isOk(r)).toBe(true);
    // committed exactly once, with the RE-VALIDATED plan (branded planId preserved).
    expect(commit.calls).toHaveLength(1);
    expect(commit.calls[0]?.planId).toBe("plan-f-1");
    // row advanced to the terminal committed state with the injected clock's instant.
    const row = kmp.store.get("plan-f-1");
    expect(row?.status).toBe("committed");
    expect(row?.settledAt).toBe(NOW);
    // immutable fields untouched.
    expect(row?.payloadHash).toBe(HASH);
    expect(row?.workspaceId).toBe("personal-business");
  });

  it("is idempotent: a row already committed skips (NO second write) and returns ok", async () => {
    const { dispatch, commit } = makeDispatch(mkRow({ status: "committed", settledAt: "2026-07-07T00:00:00.000Z" }));
    const r = await dispatch(mkApproval());
    expect(isOk(r)).toBe(true);
    expect(commit.calls).toHaveLength(0);
  });

  it("fail-closed on a phantom plan: planRef not in the store never commits", async () => {
    const { dispatch, commit } = makeDispatch(undefined); // empty store → get → not_found
    const r = await dispatch(mkApproval());
    expect(assertErr(r).kind).toBe("validation_rejected");
    expect(commit.calls).toHaveLength(0);
  });
});

describe("createSemanticMutationDispatch — safety guards", () => {
  it("FG-1 (WS-8): a row whose workspace differs from the approval's never commits", async () => {
    const { dispatch, kmp, commit } = makeDispatch(mkRow({ workspaceId: "employer-work" }));
    const r = await dispatch(mkApproval({ workspaceId: "personal-business" }));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_WORKSPACE_MISMATCH");
    expect(commit.calls).toHaveLength(0);
    expect(kmp.store.get("plan-f-1")?.status).toBe("pending"); // untouched
  });

  it("FG-2 (TOCTOU): a stored plan that no longer hashes to the FROZEN Approval.payloadHash never commits", async () => {
    // Row plan swapped for a DIFFERENT (but schema-valid) plan; Approval.payloadHash stays the frozen original.
    const tamperedPlan = { ...validPlan, planId: "plan-f-1", confidence: 0.99 };
    const { dispatch, commit } = makeDispatch(mkRow({ plan: tamperedPlan }));
    const r = await dispatch(mkApproval()); // Approval.payloadHash === HASH (over the ORIGINAL plan)
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_PAYLOAD_DIVERGED");
    expect(commit.calls).toHaveLength(0);
  });

  it("object-guards a non-object stored blob before hashing", async () => {
    const { dispatch, commit } = makeDispatch(mkRow({ plan: "not-an-object", payloadHash: HASH }));
    const r = await dispatch(mkApproval());
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_PLAN_NOT_OBJECT");
    expect(commit.calls).toHaveLength(0);
  });

  it("candidate-data gate: a stored blob whose hash matches but fails the schema never commits", async () => {
    // Malformed plan (missing sourceRefs → REQ-F-006), with the Approval hash set OVER that malformed blob
    // so FG-2 passes and the SCHEMA gate is the thing under test.
    const malformed: Record<string, unknown> = { planId: "plan-f-1", workspaceId: "personal-business" };
    const badHash = payloadHash(malformed);
    const { dispatch, commit } = makeDispatch(mkRow({ plan: malformed, payloadHash: badHash }));
    const r = await dispatch(mkApproval({ payloadHash: badHash }));
    expect(assertErr(r).kind).toBe("schema_rejected");
    expect(commit.calls).toHaveLength(0);
  });

  it("defensive: a semantic_mutation card missing planRef fails closed (never commits)", async () => {
    const { dispatch, commit } = makeDispatch(mkRow());
    const r = await dispatch(mkApproval({ planRef: undefined }));
    expect(assertErr(r).kind).toBe("validation_rejected");
    expect(commit.calls).toHaveLength(0);
  });

  it("refuses to commit a plan whose validated workspaceId disagrees with the row's WS-8 scope", async () => {
    // Row scope says personal-business, but the plan blob decodes to a different workspace.
    const crossPlan = { ...validPlan, workspaceId: "employer-work" };
    const crossHash = payloadHash(crossPlan);
    const { dispatch, commit } = makeDispatch(
      mkRow({ workspaceId: "personal-business", plan: crossPlan, payloadHash: crossHash }),
    );
    const r = await dispatch(mkApproval({ workspaceId: "personal-business", payloadHash: crossHash }));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_PLAN_WORKSPACE_MISMATCH");
    expect(commit.calls).toHaveLength(0);
  });
});

describe("createSemanticMutationDispatch — commit failure + non-approved statuses", () => {
  it("propagates a KnowledgeWriter WriteFailure as a redaction-safe variant; row stays pending", async () => {
    const { dispatch, kmp } = makeDispatch(mkRow(), {
      commit: { failure: { code: "write_conflict", message: "boom", cause: { secret: "leak" } } },
    });
    const r = await dispatch(mkApproval());
    const e = assertErr(r);
    expect(e.kind).toBe("write_conflict");
    // never a marked-committed row on a failed commit; the raw cause never crosses.
    expect(kmp.store.get("plan-f-1")?.status).toBe("pending");
    expect(JSON.stringify(e)).not.toContain("leak");
  });

  it("commit succeeds but the row-status update fails → surfaces the store fault, no double-commit", async () => {
    // The Markdown is already durably (idempotently) written; surfacing the store fault — NOT a
    // second commit — is the safe outcome. The row stays pending (a re-drive replays the writer).
    const { dispatch, kmp, commit } = makeDispatch(mkRow(), {
      kmp: { updateError: { code: "unavailable", message: "db down" } },
    });
    const r = await dispatch(mkApproval());
    expect(assertErr(r).kind).toBe("degraded_unavailable");
    expect(commit.calls).toHaveLength(1);
    expect(kmp.store.get("plan-f-1")?.status).toBe("pending");
  });

  it("settleRejected guards WS-8: a reject whose workspace differs never touches the row", async () => {
    const { dispatch, kmp } = makeDispatch(mkRow({ workspaceId: "employer-work" }));
    const r = await dispatch(mkApproval({ status: "rejected", workspaceId: "personal-business" }));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_WORKSPACE_MISMATCH");
    expect(kmp.store.get("plan-f-1")?.status).toBe("pending"); // untouched
  });

  it("rejected decision marks the row rejected + settledAt (never commits)", async () => {
    const { dispatch, kmp, commit } = makeDispatch(mkRow());
    const r = await dispatch(mkApproval({ status: "rejected" }));
    expect(isOk(r)).toBe(true);
    expect(commit.calls).toHaveLength(0);
    const row = kmp.store.get("plan-f-1");
    expect(row?.status).toBe("rejected");
    expect(row?.settledAt).toBe(NOW);
  });

  it("a deferred semantic card is a no-op: leaves the plan pending, never commits", async () => {
    const { dispatch, kmp, commit } = makeDispatch(mkRow());
    const r = await dispatch(mkApproval({ status: "deferred", snoozeUntil: "2026-07-09T00:00:00.000Z" }));
    expect(isOk(r)).toBe(true);
    expect(commit.calls).toHaveLength(0);
    expect(kmp.store.get("plan-f-1")?.status).toBe("pending");
  });

  it("refuses to commit a plan whose row is already rejected (no resurrection)", async () => {
    const { dispatch, commit } = makeDispatch(mkRow({ status: "rejected", settledAt: "2026-07-07T00:00:00.000Z" }));
    const r = await dispatch(mkApproval({ status: "approved" }));
    expect(isOk(r)).toBe(false);
    expect(commit.calls).toHaveLength(0);
  });

  it("an external_action card is not this executor's card — no-op ok, never touches the KMP store", async () => {
    const { dispatch, kmp, commit } = makeDispatch(mkRow());
    const external = {
      id: "appr-2",
      actionRef: "act-1",
      subjectKind: "external_action",
      workspaceId: "personal-business",
      status: "approved",
      actor: "x",
      channel: "mac",
      payloadHash: "sha256:whatever",
    } as unknown as Approval;
    const r = await dispatch(external);
    expect(isOk(r)).toBe(true);
    expect(commit.calls).toHaveLength(0);
    expect(kmp.store.get("plan-f-1")?.status).toBe("pending");
  });
});

// ── the router ────────────────────────────────────────────────────────────────

describe("createApprovalDispatchRouter — routes by subjectKind", () => {
  const record = (bucket: string[], tag: string): DispatchApprovalFn => (a) => {
    bucket.push(`${tag}:${a.subjectKind}`);
    return Promise.resolve(ok(undefined));
  };

  it("sends semantic_mutation to the semantic branch, external_action to the external branch", async () => {
    const seen: string[] = [];
    const router = createApprovalDispatchRouter({
      semantic: record(seen, "semantic"),
      external: record(seen, "external"),
    });
    await router(mkApproval({ status: "approved" }));
    await router({
      id: "e", actionRef: "a", subjectKind: "external_action", workspaceId: "w",
      status: "approved", actor: "x", channel: "mac", payloadHash: "h",
    } as unknown as Approval);
    expect(seen).toEqual(["semantic:semantic_mutation", "external:external_action"]);
  });
});
