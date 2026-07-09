// §13.10a — Slice F: on-approval → KnowledgeWriter executor (worker side).
//
// THE MOST SAFETY-CRITICAL SLICE of the Copilot semantic-write bridge: this is where a
// Copilot-PROPOSED KnowledgeMutationPlan FIRST commits real canonical Markdown — and ONLY
// when the owner approves the pending §9.8 card, ONLY through KnowledgeWriter (the SOLE
// autonomous Markdown writer, safety rule 1), NEVER a direct/auto write (safety rules 1+2).
//
// SEAM. `DispatchApprovalFn = (approval) => Promise<Result<void, FailureVariant>>` is the
// downstream side-effect port `decideApprovalCommand` drives — and ONLY on a genuine,
// applied, exactly-once transition (a no-op contender never re-dispatches). The approval it
// hands us is the NEXT record: its `status` is the decided status and its immutable subject
// (`subjectKind`/`planRef`/`payloadHash`/`workspaceId`) is carried forward verbatim from the
// pending card (see approvalCommands `nextRecord`). We ROUTE off `subjectKind`:
//   • external_action  → the existing Tool-Gateway external-write dispatch (unchanged).
//   • semantic_mutation → this executor (commit the referenced KMP).
// `createApprovalDispatchRouter` is that split; `createSemanticMutationDispatch` is the
// semantic branch. Compose them — never wire the semantic branch raw as the whole dispatcher
// (it no-ops on a non-semantic card, which would silently drop external writes).
//
// ENFORCED PRECONDITIONS on an approved semantic card (each pinned by a test):
//   1. subjectKind === "semantic_mutation" (else not our card).
//   2. planRef present (the frozen Approval refine guarantees it for a semantic card; a
//      defensive re-check fails closed regardless).
//   3. Fetch the pending KMP by planRef. Missing → fail closed (never commit a phantom plan).
//   4. Idempotency (LIFE-3): a row already `committed` → skip. A re-approve/replay must NOT
//      double-commit. (The writer is ALSO idempotent by the plan's idempotencyKey — this is
//      the fast, operational-truth layer on top.)
//   5. FG-1 (WS-8, safety rule 4): the row's workspace MUST equal the approval's. A
//      cross-workspace planId must never drive a commit into the wrong workspace.
//   6. FG-2 (TOCTOU, safety rule 3): re-hash the STORED blob and compare against the FROZEN
//      `Approval.payloadHash` (not the row's own copy — defense-in-depth). A swapped/tampered
//      plan diverges → fail closed. (The pending-KMP store makes the plan immutable post-record,
//      so an honest store yields equality; this catches an out-of-band DB write.)
//   7. Candidate-data gate (safety rule 2 / REQ-S-006): re-validate the stored blob through
//      `KnowledgeMutationPlanSchema` before commit. A stored blob is NEVER trusted raw. (The
//      writer re-runs the FULL ajv+Zod+scoped gate too; this is the cheap first gate.)
//   8. Commit via `CommitKnowledgePort` (which wraps `applyPlan` — WriteFailure → a bounded,
//      redaction-safe cause code; never throws).
//   9. On success mark the row `committed` + `settledAt`; on a rejected decision mark
//      `rejected`. `update` only advances status/settledAt (plan/hash/workspace immutable).
//
// REDACTION (safety rule 7): every failure crosses as a `FailureVariant` carrying ONLY a
// stable cause code + static message — never a raw DbError, WriteFailure cause, path, or
// content. Never throws across the boundary (§16).
//
// DORMANT. Nothing wires this live yet: prod `dispatchApproval` is a no-op stub
// (apps/desktop/worker-host). The live wiring (route the router into `dispatchApproval`
// behind a boot flag) lands with Slice G's runner + is GATED on the §13.10a go-live gates
// (see the notes below). This slice is the pure, unit-tested executor.
import { ok, err, isOk } from "@sow/contracts";
import type { Approval, KnowledgeMutationPlan, Result, FailureVariant, WorkspaceId } from "@sow/contracts";
import { KnowledgeMutationPlanSchema } from "@sow/contracts";
import { failure } from "@sow/contracts";
import type { DbError, PendingKnowledgeMutation, PendingKnowledgeMutationRepository } from "@sow/db";
import type { CommitKnowledgePort, KnowledgeCommitFailure } from "@sow/workflows";
import { payloadHash } from "@sow/integrations";
import type { DispatchApprovalFn } from "./approvalCommands";

/**
 * Injected deps for the semantic-mutation executor. Minimal by design: the pending-KMP store
 * (fetch by planRef + advance status), the KnowledgeWriter commit port (the SOLE writer,
 * idempotent by the plan's idempotencyKey), and an injected ISO-8601 clock (keeps `settledAt`
 * deterministic under test).
 *
 * ⚠ GO-LIVE (base revision): the commit port MUST resolve `expectedBaseRevision` against the
 * LIVE on-disk vault at commit time — a commit-on-approval happens long after propose, so a
 * FIXED base revision (the proof-spine wiring) would spuriously `write_conflict`. This is a
 * wiring concern of whoever constructs the port at go-live, not of this pure executor.
 */
export interface SemanticMutationDispatchDeps {
  readonly pendingKmp: PendingKnowledgeMutationRepository;
  readonly commit: CommitKnowledgePort;
  /**
   * §13.10a gate 1 (slug-collision) — read the target note's frontmatter `projectId`, WS-8-scoped to the
   * given workspace. Returns `undefined` when the note is absent or carries no `projectId`. Used to verify
   * a copilot-propose NotePatch hits the RIGHT project's note (`safeNoteSlug` is lossy). Never throws —
   * a read fault is a typed `FailureVariant`.
   */
  readonly readNoteProjectId: NoteProjectIdReader;
  /**
   * §13.10a gate 1 (create-clobber) — does a note ALREADY exist at this path, WS-8-scoped? Keyed on REAL
   * file existence, NOT `projectId` presence: a NoteCreate `renderCreate`-OVERWRITES the whole file, so a
   * create over ANY pre-existing note (a colliding project note, a human note, a note lacking/mis-framing
   * `projectId`) is a data-loss write. Using `readNoteProjectId !== undefined` as an existence proxy would
   * MISS an existing note that carries no parseable `projectId` — so this is a distinct probe. Never throws.
   */
  readonly noteExists: NoteExistsProbe;
  /** Injected clock (ISO-8601) — the terminal-transition instant stamped on the settled row. */
  readonly now: () => string;
}

/**
 * Reads a note's frontmatter `projectId` (WS-8-scoped). `undefined` ⇒ note absent OR no `projectId` key.
 *
 * ⚠ CONTRACT (the concrete impl MUST honor — the gate-1 comparison is raw-string equality): return the
 * UNESCAPED RAW scalar — the inverse of the KnowledgeWriter's frontmatter `serializeScalar`, which quotes
 * + escapes a value that is not a safe plain scalar (§13.10a gate 2). A reader that returns the QUOTED
 * on-disk form (e.g. `"2024-x"` for raw `2024-x`) would false-REJECT every legitimate re-proposal of a
 * project whose id isn't a safe plain scalar. Never throws — a read fault is a typed `FailureVariant`.
 */
export type NoteProjectIdReader = (
  path: string,
  workspaceId: WorkspaceId,
) => Promise<Result<string | undefined, FailureVariant>>;

/**
 * Does a note EXIST at `path` (WS-8-scoped)? `true` ⇒ occupied (a create would overwrite it). Keyed on
 * real file existence, independent of frontmatter — so a note that lacks or mis-frames `projectId` still
 * reads as existing. Never throws — a read fault is a typed `FailureVariant` (the executor fails closed).
 */
export type NoteExistsProbe = (
  path: string,
  workspaceId: WorkspaceId,
) => Promise<Result<boolean, FailureVariant>>;

/** Redaction-safe rejection: a stable cause code + static message; never a raw cause. */
function reject(kind: FailureVariant["kind"], code: string, message: string): FailureVariant {
  return failure(kind, message, { cause: { code } });
}

/** Fold a pending-KMP-store DbError into a bounded, redaction-safe variant (only the code crosses). */
function dbErrorToFailure(e: DbError): FailureVariant {
  switch (e.code) {
    case "conflict":
      return failure("write_conflict", "semantic dispatch: store conflict", {
        cause: { code: "SEMANTIC_DISPATCH_STORE_CONFLICT" },
      });
    case "not_found":
      return failure("validation_rejected", "semantic dispatch: pending plan not found", {
        cause: { code: "SEMANTIC_DISPATCH_PLAN_NOT_FOUND" },
      });
    case "constraint_violation":
      return failure("write_conflict", "semantic dispatch: store rejected", {
        cause: { code: "SEMANTIC_DISPATCH_STORE_CONSTRAINT" },
      });
    case "serialization_failure":
      return failure("degraded_unavailable", "semantic dispatch: store retryable", {
        retryable: true,
        cause: { code: "SEMANTIC_DISPATCH_STORE_SERIALIZATION" },
      });
    case "unavailable":
      return failure("degraded_unavailable", "semantic dispatch: store unavailable", {
        retryable: true,
        cause: { code: "SEMANTIC_DISPATCH_STORE_UNAVAILABLE" },
      });
    case "unknown":
    default:
      return failure("degraded_unavailable", "semantic dispatch: store error", {
        cause: { code: "SEMANTIC_DISPATCH_STORE_UNKNOWN" },
      });
  }
}

/**
 * Fold a KnowledgeWriter commit failure onto a bounded, redaction-safe variant. The closed
 * `KnowledgeCommitFailureCode` set maps as: schema/write-conflict pass through their kind;
 * ownership/secret fold to `validation_rejected` (a policy breach, not retryable); an
 * infra `commit_failed` is `degraded_unavailable` + retryable. The writer's `cause` (which
 * may carry a path/secret/raw error) is DROPPED — only the stable code crosses.
 */
function commitFailureToVariant(f: KnowledgeCommitFailure): FailureVariant {
  switch (f.code) {
    case "schema_rejected":
      return reject("schema_rejected", "SEMANTIC_DISPATCH_COMMIT_SCHEMA_REJECTED", "semantic dispatch: commit schema rejected");
    case "write_conflict":
      return reject("write_conflict", "SEMANTIC_DISPATCH_COMMIT_WRITE_CONFLICT", "semantic dispatch: commit revision conflict");
    case "ownership_violation":
      return reject("validation_rejected", "SEMANTIC_DISPATCH_COMMIT_OWNERSHIP_VIOLATION", "semantic dispatch: commit ownership violation");
    case "secret_found":
      return reject("validation_rejected", "SEMANTIC_DISPATCH_COMMIT_SECRET_FOUND", "semantic dispatch: commit blocked by secret scan");
    case "commit_failed":
    default:
      return failure("degraded_unavailable", "semantic dispatch: commit failed", {
        retryable: true,
        cause: { code: "SEMANTIC_DISPATCH_COMMIT_FAILED" },
      });
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The SEMANTIC branch of the approval dispatcher: commit an approved Copilot-proposed KMP
 * through KnowledgeWriter, or settle a rejected one. See the module header for the full
 * precondition chain. Never throws (§16); every failure is a redaction-safe `FailureVariant`.
 */
export function createSemanticMutationDispatch(deps: SemanticMutationDispatchDeps): DispatchApprovalFn {
  return async (approval: Approval): Promise<Result<void, FailureVariant>> => {
    // (1) Not our card. Under the router this is unreachable for external_action; wired raw it
    // is a deliberate no-op (the external branch owns that write) — compose via the router.
    if (approval.subjectKind !== "semantic_mutation") {
      return ok(undefined);
    }

    // (2) A semantic card MUST carry a planRef (the frozen Approval refine guarantees it). A
    // defensive re-check fails closed — a semantic card without a plan reference is unactionable.
    const planRef = approval.planRef;
    if (planRef === undefined) {
      return err(reject("validation_rejected", "SEMANTIC_DISPATCH_MISSING_PLAN_REF", "semantic dispatch: card missing planRef"));
    }
    const planId = String(planRef);

    if (approval.status === "rejected") {
      return settleRejected(deps, approval, planId);
    }
    // Only an APPROVED decision commits. edited/deferred/expired/pending leave the plan pending
    // (a semantic card offers no edit path — the KMP is TOCTOU-frozen; editing is unrepresentable).
    if (approval.status !== "approved") {
      return ok(undefined);
    }

    // (3) Fetch the pending KMP. Missing → fail closed (never commit a phantom plan).
    const fetched = await deps.pendingKmp.get(planId);
    if (!isOk(fetched)) return err(dbErrorToFailure(fetched.error));
    const row = fetched.value;

    // (4) Idempotency (LIFE-3): a committed row skips — a re-approve/replay must not double-commit.
    if (row.status === "committed") return ok(undefined);
    // A terminal-but-not-committed row (e.g. already rejected) must NOT be resurrected by a stray approve.
    if (row.status !== "pending") {
      return err(reject("write_conflict", "SEMANTIC_DISPATCH_ROW_NOT_PENDING", "semantic dispatch: pending plan is not in a committable state"));
    }

    // (5) FG-1 (WS-8): the row's workspace MUST equal the approval's (=== the plan's).
    if (row.workspaceId !== String(approval.workspaceId)) {
      return err(reject("validation_rejected", "SEMANTIC_DISPATCH_WORKSPACE_MISMATCH", "semantic dispatch: row/approval workspace mismatch"));
    }

    // (6) FG-2 (TOCTOU): object-guard, then re-hash the STORED blob and compare against the
    // FROZEN Approval.payloadHash (defense-in-depth against an out-of-band store mutation).
    //
    // PERSISTENCE INVARIANT this comparison depends on: `payloadHash(row.plan)` must reproduce
    // the hash the sink stamped onto the card. It does IFF the plan survives the store's JSON
    // round-trip WITHOUT a canonical-form change. `payloadHash` (@sow/integrations) maps a
    // present-`undefined` value to a sentinel, but a JSON round-trip DROPS undefined-valued keys —
    // so a KMP carrying a schema-legal present-`undefined` value (e.g. an explicit
    // `frontmatter[k]: undefined` / `FrontmatterPatch.value: undefined`) would re-hash differently
    // and this check would fail CLOSED (a spurious "diverged" — never a wrong commit). Today's sole
    // producer (`deriveCopilotProjectKnowledgePlan`) emits NO undefined values, so the invariant
    // holds. ⚠ GO-LIVE HARDENING: before admitting a producer that can emit present-`undefined`,
    // the sink + this executor must hash the PERSISTED (round-tripped) form on both sides.
    if (!isRecord(row.plan)) {
      return err(reject("schema_rejected", "SEMANTIC_DISPATCH_PLAN_NOT_OBJECT", "semantic dispatch: stored plan is not an object"));
    }
    if (payloadHash(row.plan) !== approval.payloadHash) {
      return err(reject("write_conflict", "SEMANTIC_DISPATCH_PAYLOAD_DIVERGED", "semantic dispatch: stored plan diverges from the approved hash"));
    }

    // (7) Candidate-data gate: re-validate the stored blob before commit (never trust it raw).
    const parsed = KnowledgeMutationPlanSchema.safeParse(row.plan);
    if (!parsed.success) {
      return err(reject("schema_rejected", "SEMANTIC_DISPATCH_SCHEMA_REJECTED", "semantic dispatch: stored plan failed the candidate gate"));
    }
    const plan: KnowledgeMutationPlan = parsed.data;
    // Defense-in-depth: the VALIDATED plan's own workspace must match the row's WS-8 scope.
    if (String(plan.workspaceId) !== row.workspaceId) {
      return err(reject("validation_rejected", "SEMANTIC_DISPATCH_PLAN_WORKSPACE_MISMATCH", "semantic dispatch: validated plan workspace mismatch"));
    }

    // (7a) SUPPORTED-KIND gate (defense-in-depth): the Copilot semantic-propose contract emits ONLY creates +
    // patches (`deriveCopilotProjectKnowledgePlan` hardcodes linkMutations/frontmatterUpdates empty). Gate 1
    // below covers ONLY those two kinds — so a plan carrying a `frontmatterUpdate`/`linkMutation` would be
    // UNGUARDED (e.g. a frontmatterUpdate to a note DELETED since propose resurrects a near-empty note, which
    // the writer's create-branch ownership check permits). Reject any such plan fail-closed. Unreachable via
    // today's producer; this backstops a future one before it can bypass the target checks.
    if (plan.frontmatterUpdates.length > 0 || plan.linkMutations.length > 0) {
      return err(reject("validation_rejected", "SEMANTIC_DISPATCH_UNSUPPORTED_MUTATION_KIND", "semantic dispatch: propose plan carries an unsupported mutation kind (only creates/patches are gate-checked)"));
    }

    // (7b) GATE 1 (slug-collision, §13.10a residual #1): every write TARGET must belong to the intended
    // project. `safeNoteSlug` is lossy, so distinct raw projectIds can collide onto one note path — a
    // proposal for project B must never touch project A's note. For a PATCH: the existing note's
    // frontmatter `projectId` MUST equal the plan's stamped `expectedProjectId` (Slice B). For a CREATE:
    // the target path MUST NOT already EXIST — `renderCreate` OVERWRITES the whole file, so a create over
    // ANY pre-existing note (a colliding project note, or an ordinary note that carries no `projectId`) is
    // a data-loss write; the create check keys on REAL existence, NOT `projectId` presence (a `projectId`
    // proxy would MISS an unattributed note → silent overwrite). Both fail CLOSED (absent expectedProjectId,
    // read fault, a patch mismatch, or an occupied create path).
    // ⚠ TOCTOU residual (go-live hardening): this reads the target here; KnowledgeWriter re-reads at
    //    commit. The window is one synchronous dispatch (no human gate between) and the compare-revision
    //    precondition guards a concurrent WHOLE-vault change, but does not bind THIS read to the writer's.
    if (plan.patches.length > 0 || plan.creates.length > 0) {
      const expected = plan.expectedProjectId;
      if (expected === undefined) {
        return err(reject("validation_rejected", "SEMANTIC_DISPATCH_MISSING_EXPECTED_PROJECT_ID", "semantic dispatch: propose plan missing expectedProjectId"));
      }
      for (const patch of plan.patches) {
        const target = await deps.readNoteProjectId(patch.path, plan.workspaceId);
        if (!isOk(target)) return err(target.error); // read fault → fail-closed (already a redaction-safe variant)
        if (target.value !== expected) {
          return err(reject("validation_rejected", "SEMANTIC_DISPATCH_PATCH_TARGET_MISMATCH", "semantic dispatch: patch target note does not belong to the intended project"));
        }
      }
      for (const create of plan.creates) {
        const exists = await deps.noteExists(create.path, plan.workspaceId);
        if (!isOk(exists)) return err(exists.error); // read fault → fail-closed
        if (exists.value) {
          return err(reject("validation_rejected", "SEMANTIC_DISPATCH_CREATE_TARGET_EXISTS", "semantic dispatch: create target note already exists (would overwrite)"));
        }
      }
    }

    // (8) Commit through KnowledgeWriter (idempotent by the plan's idempotencyKey; never throws).
    const committed = await deps.commit.commit(plan);
    if (!isOk(committed)) return err(commitFailureToVariant(committed.error));

    // (9) Mark the row committed. If THIS write fails after a successful commit, the Markdown is
    // already durably (and idempotently) written — the writer's replay makes any re-drive a no-op —
    // so surfacing the store fault (not a double-commit) is the correct, safe outcome.
    const settled = await deps.pendingKmp.update({ ...row, status: "committed", settledAt: deps.now() });
    if (!isOk(settled)) return err(dbErrorToFailure(settled.error));
    return ok(undefined);
  };
}

/**
 * Settle a REJECTED semantic card: mark the pending-KMP row `rejected` (no commit). Idempotent
 * (an already-rejected row is a no-op); refuses to reject an already-committed plan.
 */
async function settleRejected(
  deps: SemanticMutationDispatchDeps,
  approval: Approval,
  planId: string,
): Promise<Result<void, FailureVariant>> {
  const fetched = await deps.pendingKmp.get(planId);
  if (!isOk(fetched)) return err(dbErrorToFailure(fetched.error));
  const row = fetched.value;
  if (row.status === "rejected") return ok(undefined); // idempotent
  if (row.status === "committed") {
    return err(reject("write_conflict", "SEMANTIC_DISPATCH_REJECT_AFTER_COMMIT", "semantic dispatch: cannot reject a committed plan"));
  }
  // WS-8 guard on the reject path too (defense-in-depth — never touch another workspace's row).
  if (row.workspaceId !== String(approval.workspaceId)) {
    return err(reject("validation_rejected", "SEMANTIC_DISPATCH_WORKSPACE_MISMATCH", "semantic dispatch: row/approval workspace mismatch"));
  }
  const settled = await deps.pendingKmp.update({ ...row, status: "rejected", settledAt: deps.now() });
  if (!isOk(settled)) return err(dbErrorToFailure(settled.error));
  return ok(undefined);
}

/**
 * The approval dispatcher: route an applied approval to its subject-specific side effect.
 * `semantic_mutation` → the KnowledgeWriter executor; anything else (external_action) → the
 * existing Tool-Gateway external-write dispatch. This is the ONLY intended composition point —
 * the semantic branch must never be wired as the whole dispatcher (it no-ops on external cards).
 */
export function createApprovalDispatchRouter(deps: {
  readonly semantic: DispatchApprovalFn;
  readonly external: DispatchApprovalFn;
}): DispatchApprovalFn {
  return (approval: Approval): Promise<Result<void, FailureVariant>> =>
    approval.subjectKind === "semantic_mutation" ? deps.semantic(approval) : deps.external(approval);
}
