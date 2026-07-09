// §13.10a — Slice F: on-approval → KnowledgeWriter executor (the SEMANTIC branch of the
// approval dispatcher). The most safety-critical slice: this is where a Copilot proposal
// FIRST commits real Markdown — and ONLY on owner approval, through KnowledgeWriter, never
// a direct/auto write (safety rules 1+2). The enforced preconditions (fetch-by-planRef,
// idempotency, FG-1 WS-8, FG-2 TOCTOU, candidate-data gate) are each pinned below.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, failure } from "@sow/contracts";
import type { Approval, FailureVariant, Result } from "@sow/contracts";
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
  type NoteProjectIdReader,
  type NoteExistsProbe,
} from "../../../src/api/procedures/semanticMutationDispatch";
import type { DispatchApprovalFn } from "../../../src/api/procedures/approvalCommands";

// ── fixtures ──────────────────────────────────────────────────────────────────

/** A schema-valid KnowledgeMutationPlan (passes KnowledgeMutationPlanSchema.safeParse). */
const validPlan: Record<string, unknown> = {
  planId: "plan-f-1",
  workspaceId: "personal-business",
  sourceRefs: [{ sourceId: "src-1" }],
  creates: [
    // The canonical WS-8 note path (projectNotePath("personal-business","acme")) — a real derive never emits
    // a bare/mis-cased path, and the executor's WS-8 containment gate requires targets inside projects/<ws>/.
    { path: "projects/personal-business/acme.md", title: "Acme", body: "# Acme", frontmatter: { projectId: "acme" } },
  ],
  patches: [],
  linkMutations: [],
  frontmatterUpdates: [],
  externalActionProposals: [],
  confidence: 0.5,
  requiresApproval: true,
  provenanceOrigin: "copilot_propose",
  // §13.10a gate 1 — a copilot-propose plan carries the intended projectId (matches the create frontmatter).
  expectedProjectId: "acme",
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
    /** The projectId the frontmatter reader returns for any PATCH target (undefined ⇒ note/projectId absent). */
    targetProjectId?: string;
    /** Per-path projectId overrides (for multi-target patch plans); falls back to targetProjectId. */
    targetByPath?: Record<string, string | undefined>;
    /** A read fault the frontmatter reader returns instead (patch fail-closed path). */
    readError?: FailureVariant;
    /** Whether a CREATE target already exists (default false ⇒ free). Keys the create-clobber guard. */
    targetExists?: boolean;
    /** Per-path existence overrides (for multi-target create plans); falls back to targetExists. */
    existsByPath?: Record<string, boolean>;
    /** A read fault the existence probe returns instead (create fail-closed path). */
    existsError?: FailureVariant;
  } = {},
): {
  dispatch: DispatchApprovalFn;
  kmp: ReturnType<typeof fakePendingKmp>;
  commit: ReturnType<typeof fakeCommit>;
  readCalls: { path: string; workspaceId: string }[];
  existsCalls: { path: string; workspaceId: string }[];
} {
  const kmp = fakePendingKmp(seed, opts.kmp);
  const commit = fakeCommit(opts.commit);
  const readCalls: { path: string; workspaceId: string }[] = [];
  const readNoteProjectId: NoteProjectIdReader = (path, workspaceId) => {
    readCalls.push({ path, workspaceId: String(workspaceId) });
    if (opts.readError !== undefined) return Promise.resolve(err(opts.readError));
    const v = opts.targetByPath !== undefined ? opts.targetByPath[path] : opts.targetProjectId;
    return Promise.resolve(ok(v));
  };
  const existsCalls: { path: string; workspaceId: string }[] = [];
  const noteExists: NoteExistsProbe = (path, workspaceId) => {
    existsCalls.push({ path, workspaceId: String(workspaceId) });
    if (opts.existsError !== undefined) return Promise.resolve(err(opts.existsError));
    const v = opts.existsByPath !== undefined ? (opts.existsByPath[path] ?? false) : (opts.targetExists ?? false);
    return Promise.resolve(ok(v));
  };
  const deps: SemanticMutationDispatchDeps = { pendingKmp: kmp.repo, commit: commit.port, readNoteProjectId, noteExists, now: () => NOW };
  return { dispatch: createSemanticMutationDispatch(deps), kmp, commit, readCalls, existsCalls };
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

// ── gate 1: slug-collision patch-target verification ───────────────────────────

describe("createSemanticMutationDispatch — gate 1 (slug-collision) patch-target verification", () => {
  const PATCH_PATH = "projects/personal-business/acme.md";
  const patchPlan = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    planId: "plan-f-1",
    workspaceId: "personal-business",
    sourceRefs: [{ sourceId: "src-1" }],
    creates: [],
    patches: [{ path: PATCH_PATH, regionId: "kw:project-status", newBody: "status prose" }],
    linkMutations: [],
    frontmatterUpdates: [],
    externalActionProposals: [],
    confidence: 0.5,
    requiresApproval: true,
    provenanceOrigin: "copilot_propose",
    expectedProjectId: "acme",
    ...over,
  });
  const seedFor = (plan: Record<string, unknown>): PendingKnowledgeMutation => mkRow({ plan, payloadHash: payloadHash(plan) });
  const apprFor = (plan: Record<string, unknown>): Approval => mkApproval({ payloadHash: payloadHash(plan) });

  it("commits a patch when the target note's projectId MATCHES expectedProjectId (WS-8-scoped read)", async () => {
    const plan = patchPlan();
    const { dispatch, commit, kmp, readCalls } = makeDispatch(seedFor(plan), { targetProjectId: "acme" });
    const r = await dispatch(apprFor(plan));
    expect(isOk(r)).toBe(true);
    expect(commit.calls).toHaveLength(1);
    expect(kmp.store.get("plan-f-1")?.status).toBe("committed");
    // the reader was consulted for the patch target, scoped to the plan's workspace.
    expect(readCalls).toEqual([{ path: PATCH_PATH, workspaceId: "personal-business" }]);
  });

  it("REJECTS a patch whose target note belongs to a DIFFERENT project (slug-collision) — never commits", async () => {
    const plan = patchPlan();
    const { dispatch, commit, kmp } = makeDispatch(seedFor(plan), { targetProjectId: "unrelated-project" });
    const r = await dispatch(apprFor(plan));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_PATCH_TARGET_MISMATCH");
    expect(commit.calls).toHaveLength(0);
    expect(kmp.store.get("plan-f-1")?.status).toBe("pending");
  });

  it("REJECTS a patch whose target note has NO projectId frontmatter (unattributed) — fail-closed", async () => {
    const plan = patchPlan();
    const { dispatch, commit } = makeDispatch(seedFor(plan), { targetProjectId: undefined });
    const r = await dispatch(apprFor(plan));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_PATCH_TARGET_MISMATCH");
    expect(commit.calls).toHaveLength(0);
  });

  it("fail-closed on a frontmatter read fault (never commits on an unverifiable target)", async () => {
    const plan = patchPlan();
    const readError = failure("degraded_unavailable", "vault read failed", { cause: { code: "VAULT_READ_FAULT" } });
    const { dispatch, commit } = makeDispatch(seedFor(plan), { readError });
    const r = await dispatch(apprFor(plan));
    expect(assertErr(r).cause?.code).toBe("VAULT_READ_FAULT");
    expect(commit.calls).toHaveLength(0);
  });

  it("REJECTS a patch plan missing expectedProjectId (no verification key ⇒ unsafe to patch)", async () => {
    const plan = patchPlan();
    delete plan["expectedProjectId"]; // OMIT (not undefined) so the stored-blob hash round-trips cleanly
    const { dispatch, commit, readCalls } = makeDispatch(seedFor(plan), { targetProjectId: "acme" });
    const r = await dispatch(apprFor(plan));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_MISSING_EXPECTED_PROJECT_ID");
    expect(commit.calls).toHaveLength(0);
    expect(readCalls).toHaveLength(0); // short-circuits before any read
  });

  it("checks EVERY patch — a LATER patch targeting a foreign note rejects the whole commit", async () => {
    const OTHER = "projects/personal-business/other.md";
    const plan = patchPlan({
      patches: [
        { path: PATCH_PATH, regionId: "kw:project-status", newBody: "a" },
        { path: OTHER, regionId: "kw:project-status", newBody: "b" },
      ],
    });
    const { dispatch, commit } = makeDispatch(seedFor(plan), {
      targetByPath: { [PATCH_PATH]: "acme", [OTHER]: "unrelated" },
    });
    const r = await dispatch(apprFor(plan));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_PATCH_TARGET_MISMATCH");
    expect(commit.calls).toHaveLength(0);
  });

  it("a CREATE whose target path is free commits (and the executor probed existence, not projectId)", async () => {
    // validPlan is a single create at projects/personal-business/acme.md; targetExists defaults false ⇒ path is free.
    const { dispatch, commit, existsCalls } = makeDispatch(mkRow());
    const r = await dispatch(mkApproval());
    expect(isOk(r)).toBe(true);
    expect(commit.calls).toHaveLength(1);
    // Keyed on REAL existence — the create branch uses the existence probe, not the projectId reader.
    expect(existsCalls).toEqual([{ path: "projects/personal-business/acme.md", workspaceId: "personal-business" }]);
  });

  it("REJECTS a create whose target path ALREADY EXISTS (renderCreate would overwrite it)", async () => {
    const { dispatch, commit } = makeDispatch(mkRow(), { targetExists: true });
    const r = await dispatch(mkApproval());
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_CREATE_TARGET_EXISTS");
    expect(commit.calls).toHaveLength(0);
  });

  it("REJECTS a create over an existing note that has NO projectId — existence, not id-presence (data-loss guard)", async () => {
    // The false-accept the existence probe closes: an unattributed note (a human/daily note, or a
    // note whose projectId is unparseable) occupies the path. A projectId-presence proxy would read
    // undefined ⇒ "free" ⇒ overwrite. The existence probe reports it occupied ⇒ reject.
    const { dispatch, commit } = makeDispatch(mkRow(), { targetExists: true, targetProjectId: undefined });
    const r = await dispatch(mkApproval());
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_CREATE_TARGET_EXISTS");
    expect(commit.calls).toHaveLength(0);
  });

  it("fails CLOSED when the create-existence probe faults (no commit)", async () => {
    const fault = failure("degraded_unavailable", "boom", { retryable: true, cause: { code: "NOTE_PROJECT_ID_READ_FAULT" } });
    const { dispatch, commit } = makeDispatch(mkRow(), { existsError: fault });
    const r = await dispatch(mkApproval());
    expect(isErr(r)).toBe(true);
    expect(commit.calls).toHaveLength(0);
  });

  it("REJECTS a plan carrying a frontmatterUpdate (an unsupported, gate-1-UNGUARDED kind) — no commit", async () => {
    // Gate 1 covers only creates/patches; a frontmatterUpdate to a note deleted since propose would
    // resurrect it. The Copilot propose contract never emits these, so reject fail-closed (defense-in-depth).
    const fmPlan = { ...validPlan, frontmatterUpdates: [{ path: "Projects/acme.md", key: "status", value: "x" }] };
    const fmHash = payloadHash(fmPlan);
    const { dispatch, commit } = makeDispatch(mkRow({ plan: fmPlan, payloadHash: fmHash }), {});
    const r = await dispatch(mkApproval({ payloadHash: fmHash }));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_UNSUPPORTED_MUTATION_KIND");
    expect(commit.calls).toHaveLength(0);
  });

  it("REJECTS a plan carrying a linkMutation (unsupported kind) — no commit", async () => {
    const lmPlan = { ...validPlan, linkMutations: [{ op: "add", srcPath: "Projects/acme.md", dstSlug: "other" }] };
    const lmHash = payloadHash(lmPlan);
    const { dispatch, commit } = makeDispatch(mkRow({ plan: lmPlan, payloadHash: lmHash }), {});
    const r = await dispatch(mkApproval({ payloadHash: lmHash }));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_UNSUPPORTED_MUTATION_KIND");
    expect(commit.calls).toHaveLength(0);
  });
});

// ── WS-8 path-within-workspace containment (residual #3) ───────────────────────

describe("createSemanticMutationDispatch — WS-8 path-within-workspace containment", () => {
  // A schema-valid plan whose ONLY target sits at `path` (create) — for asserting the containment gate in
  // isolation. workspaceId stays personal-business, so a target outside projects/personal-business/ is foreign.
  const createAt = (path: string): Record<string, unknown> => ({
    planId: "plan-f-1",
    workspaceId: "personal-business",
    sourceRefs: [{ sourceId: "src-1" }],
    creates: [{ path, title: "Acme", body: "# Acme", frontmatter: { projectId: "acme" } }],
    patches: [],
    linkMutations: [],
    frontmatterUpdates: [],
    externalActionProposals: [],
    confidence: 0.5,
    requiresApproval: true,
    provenanceOrigin: "copilot_propose",
    expectedProjectId: "acme",
  });
  const patchAt = (path: string): Record<string, unknown> => ({
    ...createAt(path),
    creates: [],
    patches: [{ path, regionId: "project-status", newBody: "status prose" }],
  });
  const seedFor = (plan: Record<string, unknown>): PendingKnowledgeMutation => mkRow({ plan, payloadHash: payloadHash(plan) });
  const apprFor = (plan: Record<string, unknown>): Approval => mkApproval({ payloadHash: payloadHash(plan) });

  it("REJECTS a create whose target sits in ANOTHER workspace's subtree — no existence probe, no commit", async () => {
    // The vault join(root, path) is verbatim: a stored plan tampered to target projects/employer-work/ would
    // write into the WRONG workspace tree. The containment gate rejects it BEFORE any I/O (fail-closed).
    const plan = createAt("projects/employer-work/acme.md");
    const { dispatch, commit, existsCalls } = makeDispatch(seedFor(plan));
    const r = await dispatch(apprFor(plan));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_TARGET_OUTSIDE_WORKSPACE");
    expect(commit.calls).toHaveLength(0);
    expect(existsCalls).toHaveLength(0); // rejected before touching the vault
  });

  it("REJECTS a patch whose target sits in another workspace's subtree — no frontmatter read, no commit", async () => {
    const plan = patchAt("projects/employer-work/acme.md");
    const { dispatch, commit, readCalls } = makeDispatch(seedFor(plan), { targetProjectId: "acme" });
    const r = await dispatch(apprFor(plan));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_TARGET_OUTSIDE_WORKSPACE");
    expect(commit.calls).toHaveLength(0);
    expect(readCalls).toHaveLength(0); // rejected before touching the vault
  });

  it("REJECTS a create whose path TRAVERSES out of the workspace dir (projects/<ws>/../…)", async () => {
    const plan = createAt("projects/personal-business/../employer-work/acme.md");
    const { dispatch, commit, existsCalls } = makeDispatch(seedFor(plan));
    const r = await dispatch(apprFor(plan));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_TARGET_OUTSIDE_WORKSPACE");
    expect(commit.calls).toHaveLength(0);
    expect(existsCalls).toHaveLength(0);
  });

  it("REJECTS a create NESTED below the workspace dir (containment requires a DIRECT child note)", async () => {
    const plan = createAt("projects/personal-business/sub/deep.md");
    const { dispatch, commit } = makeDispatch(seedFor(plan));
    const r = await dispatch(apprFor(plan));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_TARGET_OUTSIDE_WORKSPACE");
    expect(commit.calls).toHaveLength(0);
  });

  it("REJECTS a bare/mis-cased path that is not under projects/<ws>/ at all", async () => {
    const plan = createAt("Projects/acme.md"); // capital P, no workspace segment — the old unrealistic shape
    const { dispatch, commit } = makeDispatch(seedFor(plan));
    const r = await dispatch(apprFor(plan));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_TARGET_OUTSIDE_WORKSPACE");
    expect(commit.calls).toHaveLength(0);
  });

  it("REJECTS a prefix-COLLISION sibling workspace (projects/<ws>X/…) — the trailing-slash defense", async () => {
    // personal-business is a strict prefix of personal-businessX; without the trailing `/` in the ws prefix
    // this would slip through. The canonical prefix ends in `/`, so the sibling fails startsWith.
    const plan = createAt("projects/personal-businessX/acme.md");
    const { dispatch, commit, existsCalls } = makeDispatch(seedFor(plan));
    const r = await dispatch(apprFor(plan));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_TARGET_OUTSIDE_WORKSPACE");
    expect(commit.calls).toHaveLength(0);
    expect(existsCalls).toHaveLength(0);
  });

  it("REJECTS a leading-slash ABSOLUTE target (…not under the relative projects/<ws>/ prefix)", async () => {
    const plan = createAt("/projects/personal-business/acme.md");
    const { dispatch, commit } = makeDispatch(seedFor(plan));
    const r = await dispatch(apprFor(plan));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_TARGET_OUTSIDE_WORKSPACE");
    expect(commit.calls).toHaveLength(0);
  });

  it("fails closed with UNSAFE_TARGET_PATH when expectedProjectId slugs to empty (no safe canonical anchor)", async () => {
    // projectNotePath returns null when the projectId has no safe slug — the executor cannot form a workspace
    // prefix, so it rejects BEFORE checking any target (distinct code from the containment reject).
    const plan = { ...createAt("projects/personal-business/x.md"), expectedProjectId: "!!!" };
    const { dispatch, commit, existsCalls } = makeDispatch(seedFor(plan));
    const r = await dispatch(apprFor(plan));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_UNSAFE_TARGET_PATH");
    expect(commit.calls).toHaveLength(0);
    expect(existsCalls).toHaveLength(0);
  });

  it("REJECTS when a LATER create in a multi-create plan is out-of-tree (checks every target)", async () => {
    const plan = {
      ...createAt("projects/personal-business/acme.md"),
      creates: [
        { path: "projects/personal-business/acme.md", title: "Acme", body: "# Acme", frontmatter: { projectId: "acme" } },
        { path: "projects/employer-work/leak.md", title: "Leak", body: "# Leak", frontmatter: { projectId: "acme" } },
      ],
    };
    const { dispatch, commit } = makeDispatch(seedFor(plan));
    const r = await dispatch(apprFor(plan));
    expect(assertErr(r).cause?.code).toBe("SEMANTIC_DISPATCH_TARGET_OUTSIDE_WORKSPACE");
    expect(commit.calls).toHaveLength(0);
  });

  it("ADMITS the canonical projects/<ws>/<leaf>.md target (containment passes → reaches the existence probe)", async () => {
    const plan = createAt("projects/personal-business/acme.md");
    const { dispatch, commit, existsCalls } = makeDispatch(seedFor(plan));
    const r = await dispatch(apprFor(plan));
    expect(isOk(r)).toBe(true);
    expect(commit.calls).toHaveLength(1);
    expect(existsCalls).toEqual([{ path: "projects/personal-business/acme.md", workspaceId: "personal-business" }]);
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
