// @sow/workflows — task 7.14: CROSS-STORE DELETION SAGA — PURE orchestration
// DRIVER (the most safety-critical §9 workflow of this wave).
//
// A sibling of the 7.6 meeting-closeout / 7.7 source-ingestion / 7.12
// cross-calendar-scheduling drivers: same two-layer structure (pure driver +
// injected activity ports), same foundation ports (Clock, WorkflowRunRefRepository,
// the 7.5 health sink), same idempotency seam (resolveRun). It progresses a
// deletion run THROUGH a LOCAL `deletionSagaMachine` (defined via the @sow/domain
// `defineMachine` primitive — @sow/domain ships no deletion machine, so this
// workflow owns its state alphabet, exactly how the 6 domain machines + the 7.10 /
// 7.12 sibling drivers each define theirs) over INJECTED activity ports, an injected
// Clock, and the 7.5 health sink.
//
// ★ TWO-LAYER + SANDBOX (root CLAUDE.md): this driver imports NEITHER @temporalio NOR
// node:crypto and calls NO Date.now()/Math.random(). All time + I/O arrive through
// injected ports + Clock, so it is Vitest-unit-testable with no Temporal server and
// safe to wrap in a thin @temporalio workflow later (that wrapper + its SOW_TEMPORAL
// integration test are the worker-wiring wave's job — NOT this file). Per-step
// idempotency KEYS + the DERIVED deletion plan are computed in the ACTIVITIES
// (node:crypto lives there — src/activities/deletionPlan.ts /
// src/activities/compensateDeletion.ts). The driver only RECEIVES the derived plan
// and drives it downstream.
//
// §16 error convention: the driver NEVER throws across a boundary. It folds every
// typed port rejection onto a distinct deletionSagaMachine state and routes it
// through the health sink (inv-5: nothing fails silently). The returned outcome is a
// discriminated-union-friendly record whose `state` is the machine state the pipeline
// finally rested in.
//
// 7.14 safety invariants (REQ-F-013 / REQ-F-018 / RET-3 / Flow 7) this driver makes
// true:
//   inv-1  EXPLICIT owner-intent gate (REQ-F-013): a deletion runs ONLY on validated,
//          explicit owner intent. Missing/implicit intent → intent_rejected with NO
//          durable step; the saga never infers a deletion.
//   inv-2  HUMAN-OWNED PRESERVATION (REQ-F-018 / RET-3): automated pruning NEVER
//          removes a human-owned Markdown region. The DERIVED deletion plan is built
//          from validated intent + the retention-policy window and REFUSES a human-
//          owned region (the deriver either skips it or fails closed) — the guard
//          runs over the ACTUAL plan regions, never a decoy descriptor. A plan the
//          deriver cannot make preservation-safe → plan_rejected, NO commit.
//   inv-3  ORDERED, per-step-IDEMPOTENT execution: (1) Markdown tombstone via
//          KnowledgeWriter (THE COMMIT POINT — the sole Markdown writer, safety rule
//          1) → (2) GBrain purge/re-index → (3) event-store tombstone (history
//          PRESERVED, NOT hard-deleted) → (4) read-model + external-ref
//          reconciliation. Each step keyed for idempotent replay.
//   inv-4  CRASH MID-SAGA re-drives IDEMPOTENTLY: resolveRun reuses a seen run and
//          each step is a no-op on replay (tombstone by plan key; purge idempotent;
//          event tombstone append-once; reconciliation converges) — a re-drive leaves
//          NO orphaned reference and NO resurrected GBrain index entry, and NO second
//          tombstone. Re-running a COMPLETED deletion is a whole-saga no-op.
//   inv-5  PARTIAL failure after the commit point drives a COMPENSATING/retry state
//          (never a silent rollback of the durable tombstone) surfaced via the 7.5
//          health sink; a dangling external ref is reconciled or surfaced, never left
//          silently. Every failure/park class emits a DISTINCT 7.5 health item.
import { isOk } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  WorkflowRunRef,
  KnowledgeMutationPlan,
  AuditId,
  FailureClass,
} from "@sow/contracts";
import { defineMachine } from "@sow/domain";
import type { StateMachine } from "@sow/domain";
import type { Clock, WorkflowRunRefRepository } from "../ports/operational";
import { resolveRun } from "../runtime/idempotency";
import type { ResolveRunInput } from "../runtime/idempotency";
import type { WorkflowRunError } from "../runtime/workflowRun";

// ===========================================================================
// PORT SEAM (inline — this slice owns exactly 3 files; the sibling drivers keep
// their seam in src/ports/<name>.ts, but the 7.14 slice is scoped to the driver +
// its two activities, so the seam is co-located here and the activities import it
// from this module). Every port is PURE + workflow-safe: it declares ONLY types +
// interfaces (erasable under verbatimModuleSyntax), imports NOTHING from
// @temporalio / node:crypto, and every method returns a typed Result — never throws
// across the boundary (§16). The port error sets are DECOUPLED from the concrete
// adapter error shapes: they are the deletion-saga vocabulary the driver reasons in,
// mapped onto the deletionSagaMachine states.
// ===========================================================================

// --- (0) the deletion subject + retention policy ---------------------------

/**
 * The retention policy the deletion honors (RET-3). `rawAudioAfterAuditedSynthesis`
 * gates raw meeting audio removal on an AUDITED synthesis having happened; other raw
 * content is removed only after a configurable window (default 30 days). The deriver
 * reads these to decide which regions are prune-eligible — a region inside its
 * retention window is NOT pruned. Human-owned regions are NEVER pruned regardless of
 * window (inv-2).
 */
export interface RetentionPolicy {
  /** Raw audio may be pruned ONLY once an audited synthesis exists (RET-3 default). */
  readonly rawAudioRequiresAuditedSynthesis: boolean;
  /** Configurable window (days) after which OTHER raw content is prune-eligible (default 30). */
  readonly rawRetentionDays: number;
}

/** The default RET-3 retention posture (raw audio gated; other raw after 30d). */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  rawAudioRequiresAuditedSynthesis: true,
  rawRetentionDays: 30,
};

/**
 * The deletion subject: WHAT the owner asked to delete. It is a LOGICAL identity (a
 * note/subject ref + the bound workspace) — NOT a caller-supplied plan. The deletion
 * plan (which regions to tombstone) is DERIVED from this + the retention policy in
 * the buildPlan ACTIVITY, so a caller can never inject a plan that prunes a
 * human-owned region or redirects the write.
 */
export interface DeletionSubject {
  /** The logical subject identity to delete (e.g. a note slug / meeting id). */
  readonly subjectRef: string;
  /** WS-2/WS-4: the workspace the deletion is BOUND to (every durable step targets it). */
  readonly workspaceId: WorkspaceId;
  /** Optional detail the deriver maps onto retention (e.g. "raw_audio"). */
  readonly contentClass?: string;
}

// --- (1) VerifyIntentPort — inv-1: EXPLICIT owner intent (REQ-F-013) --------

/**
 * The proof an EXPLICIT owner deletion intent was verified. A distinct
 * `readonly verified: true` brand so the driver cannot build a plan from an
 * unverified request: only a {@link VerifyIntentPort} produces one. It carries the
 * subject the intent authorized + the actor who authorized it (for the audit trail).
 */
export interface VerifiedIntent {
  readonly verified: true;
  readonly subject: DeletionSubject;
  /** The owner/actor who explicitly authorized the deletion (audit — never inferred). */
  readonly authorizedBy: string;
}

/**
 * Closed, enumerable intent-verification failure set (§16 — never thrown). REQ-F-013:
 *   • `no_explicit_intent` — the request carries no explicit, owner-authorized
 *     deletion intent (implicit / inferred) → intent_rejected, NO durable step.
 *   • `intent_unauthorized` — the actor is not the data owner / lacks authority.
 *   • `verify_failed`       — the verifier itself failed.
 */
export type VerifyIntentErrorCode =
  | "no_explicit_intent"
  | "intent_unauthorized"
  | "verify_failed";

export interface VerifyIntentError {
  readonly code: VerifyIntentErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Verify the deletion carries EXPLICIT, owner-authorized intent (REQ-F-013 / Flow 7).
 * A deletion NEVER runs on implicit/inferred intent — the saga is refused at this gate
 * before ANY durable step. Returns a {@link VerifiedIntent} (the only way to produce
 * one) on success. Never throws.
 */
export interface VerifyIntentPort {
  verify(
    subject: DeletionSubject,
  ): Promise<Result<VerifiedIntent, VerifyIntentError>>;
}

// --- (2) BuildDeletionPlanPort — inv-2: derive + human-owned preservation ---

/**
 * The DERIVED deletion plan: the KnowledgeMutationPlan that tombstones the subject's
 * DERIVED/automated regions (THE Markdown mutation KnowledgeWriter commits) plus the
 * ordered downstream-step descriptors. BOTH are DERIVED from the {@link VerifiedIntent}
 * + retention policy — never caller-supplied — so:
 *   • `plan.workspaceId` is stamped from the BOUND workspace (WS-2/WS-4), never a
 *     caller field;
 *   • the plan tombstones ONLY prune-eligible, NON-human-owned regions (inv-2 /
 *     REQ-F-018 / RET-3) — a human-owned region is provably excluded because the
 *     deriver refuses to include it (a preservation-unsafe subject fails closed).
 * `preservedRegions` records the human-owned regions the deriver DELIBERATELY kept
 * (proof the preservation ran over the real regions, not a decoy). `purgeKey` /
 * `eventTombstoneKey` / `reconcileKey` are the per-step idempotency keys (computed in
 * the ACTIVITY via node:crypto) that make each downstream step replay-safe (inv-4).
 */
export interface DerivedDeletionPlan {
  /** THE COMMIT POINT plan (region-bounded tombstone of automated regions only). */
  readonly plan: KnowledgeMutationPlan;
  /** Human-owned regions DELIBERATELY preserved (inv-2 — never in `plan`). */
  readonly preservedRegions: readonly string[];
  /**
   * A deterministic hash over the ACTUAL tombstone patch set (region ids + patch
   * identities, canonicalized + sorted so it is order-independent + replay-stable).
   * It is folded into ALL per-step keys (planId/purgeKey/eventTombstoneKey/
   * reconcileKey) so an identical re-derived plan replays to identical keys (inv-4)
   * while a legitimately-different plan (regions added/removed, or a re-materialized
   * subject) gets a fresh key set — closing the content-blindness gap where a changed
   * patch set was silently discarded under a stale plan key. The driver uses it as a
   * belt-and-suspenders same-key/same-content check at the commit point (fail-closed).
   */
  readonly contentDiscriminator: string;
  /** Idempotency key for the GBrain purge/re-index step (replay no-op). */
  readonly purgeKey: string;
  /** Idempotency key for the event-store tombstone append (append-once). */
  readonly eventTombstoneKey: string;
  /** Idempotency key for the read-model + external-ref reconciliation. */
  readonly reconcileKey: string;
}

/**
 * Closed, enumerable plan-build failure set (§16 — never thrown):
 *   • `human_owned_only`   — EVERY region of the subject is human-owned (REQ-F-018 /
 *     RET-3): there is NOTHING the automated saga may prune → plan_rejected, NO
 *     commit (the deletion is refused, never a partial human-owned prune).
 *   • `retention_blocked`  — the subject is still inside its retention window (raw
 *     audio without an audited synthesis, or other raw before the window) → refused.
 *   • `unmappable_subject` — the deriver cannot project the subject onto tombstone
 *     regions (fail-closed, never a guessed plan).
 *   • `build_failed`       — the derivation failed for another reason.
 */
export type BuildDeletionPlanFailureCode =
  | "human_owned_only"
  | "retention_blocked"
  | "unmappable_subject"
  | "build_failed";

export interface BuildDeletionPlanFailure {
  readonly code: BuildDeletionPlanFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * DERIVE the deletion plan FROM the {@link VerifiedIntent} + retention policy (inv-2 /
 * inv-3 governance seam). The plan is built HERE — never accepted from the caller —
 * so `plan.workspaceId` is stamped from the bound workspace and the tombstone covers
 * ONLY prune-eligible, non-human-owned regions (REQ-F-018 / RET-3). A subject with
 * only human-owned regions, or still inside its retention window, is REFUSED
 * (fail-closed). The per-step idempotency keys are computed in the ACTIVITY
 * (node:crypto) so the driver's replay safety holds. Never throws.
 */
export interface BuildDeletionPlanPort {
  build(
    intent: VerifiedIntent,
    retention: RetentionPolicy,
  ): Promise<Result<DerivedDeletionPlan, BuildDeletionPlanFailure>>;
}

// --- (3) TombstoneMarkdownPort — inv-3 step 1: THE COMMIT POINT -------------

/**
 * The successful Markdown-tombstone commit. `revisionId` is the committed revision;
 * `replayed` is true on an idempotent REPLAY of a prior tombstone under the same plan
 * key (no second write / audit — inv-4).
 */
export interface TombstoneCommitSuccess {
  readonly revisionId: string;
  readonly replayed: boolean;
  /**
   * The content discriminator that was ACTUALLY committed under this plan key (the
   * hash the {@link DerivedDeletionPlan} carries). Optional so existing adapters that
   * do not record it stay compatible; when present, the driver asserts it matches the
   * CURRENT derived plan's discriminator. With the discriminator folded into the plan
   * key this holds by construction, so a mismatch means a same-key/different-content
   * collision — the driver FAILS CLOSED to a compensating/health state rather than
   * silently accepting a replay of stale content (defense-in-depth for the
   * content-blindness finding).
   */
  readonly committedContentDiscriminator?: string;
}

/**
 * Closed, enumerable Markdown-tombstone failure set (§16 — never thrown), mirroring
 * the @sow/knowledge WriteFailure variants the activity folds:
 *   • `write_conflict`      — a compare-revision precondition clash.
 *   • `ownership_violation` — the plan targeted a region outside the bound workspace
 *     OR a human-owned region slipped through (defense-in-depth — KnowledgeWriter
 *     rejects it; inv-2).
 *   • `human_owned_region`  — KnowledgeWriter refused because a target region is
 *     human-owned (REQ-F-018) — the LAST-LINE preservation guard.
 *   • `commit_failed`       — the underlying commit failed for another reason.
 */
export type TombstoneFailureCode =
  | "write_conflict"
  | "ownership_violation"
  | "human_owned_region"
  | "commit_failed";

export interface TombstoneFailure {
  readonly code: TombstoneFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Commit the Markdown tombstone through the KnowledgeWriter (safety rule 1: the SOLE
 * Markdown writer — THE COMMIT POINT of the saga, inv-3 step 1). IDEMPOTENT by the
 * plan's key (inv-4): a prior tombstone returns `replayed:true` with the SAME
 * revisionId — no second write, no double-tombstone. KnowledgeWriter is the last-line
 * preservation guard: it refuses a human-owned region (`human_owned_region`). Never
 * throws.
 */
export interface TombstoneMarkdownPort {
  tombstone(
    plan: KnowledgeMutationPlan,
  ): Promise<Result<TombstoneCommitSuccess, TombstoneFailure>>;
}

// --- (4) PurgeGbrainPort — inv-3 step 2: GBrain purge/re-index -------------

/** Closed, enumerable GBrain purge failure set (§16 — never thrown). */
export type PurgeGbrainErrorCode = "purge_failed" | "reindex_failed";

export interface PurgeGbrainError {
  readonly code: PurgeGbrainErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Purge the tombstoned subject from GBrain and re-index (inv-3 step 2). Runs strictly
 * AFTER the Markdown tombstone (keyed by the plan's revision + purgeKey), ASYNC +
 * IDEMPOTENT — purging an already-purged subject is a no-op, so a crash-replay leaves
 * NO resurrected GBrain index entry (inv-4). A purge failure AFTER the commit is a
 * typed err the driver folds to a COMPENSATING state (never a rollback of the durable
 * tombstone — inv-5). Never throws.
 */
export interface PurgeGbrainPort {
  purge(
    revisionId: string,
    purgeKey: string,
  ): Promise<Result<void, PurgeGbrainError>>;
}

// --- (5) TombstoneEventStorePort — inv-3 step 3: history PRESERVED ----------

/** Closed, enumerable event-store tombstone failure set (§16 — never thrown). */
export type EventTombstoneErrorCode = "append_failed" | "conflict";

export interface EventTombstoneError {
  readonly code: EventTombstoneErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Append a TOMBSTONE record to the append-only event store (inv-3 step 3). This
 * PRESERVES history — it is a NEW tombstone record, NEVER a hard-delete of prior
 * events (the operational-truth immutability rule). APPEND-ONCE by `eventTombstoneKey`
 * (inv-4): a replay that finds the tombstone already present is a no-op, never a
 * second tombstone. A failure AFTER the commit folds to a COMPENSATING state. Never
 * throws.
 */
export interface TombstoneEventStorePort {
  tombstone(
    subjectRef: string,
    eventTombstoneKey: string,
  ): Promise<Result<void, EventTombstoneError>>;
}

// --- (6) ReconcileRefsPort — inv-3 step 4 / inv-5: dangling refs ------------

/**
 * The reconciliation outcome. `danglingRefs` names any external references that could
 * NOT be reconciled (they are surfaced, never left silently — inv-5). An empty list
 * is a clean reconciliation.
 */
export interface ReconcileOutcome {
  /** External refs that remain dangling (surfaced via health — inv-5). Empty = clean. */
  readonly danglingRefs: readonly string[];
}

/** Closed, enumerable reconciliation failure set (§16 — never thrown). */
export type ReconcileErrorCode = "reconcile_failed" | "read_model_rebuild_failed";

export interface ReconcileError {
  readonly code: ReconcileErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Reconcile the read-model + external references after the tombstone (inv-3 step 4).
 * Rebuilds the affected read-model rows and reconciles external refs, IDEMPOTENT by
 * `reconcileKey`. A dangling external ref is RETURNED in `danglingRefs` (surfaced via
 * health, inv-5) — never left silently; the driver folds a non-empty dangling set to
 * a COMPENSATING state so it retries. A hard failure folds to COMPENSATING too. Never
 * throws.
 */
export interface ReconcileRefsPort {
  reconcile(
    subjectRef: string,
    reconcileKey: string,
  ): Promise<Result<ReconcileOutcome, ReconcileError>>;
}

// --- (7) DeletionHealthSink — inv-5: the failure sink (reuses 7.5 shape) ----

/**
 * A deletion-saga failure to surface. Structurally a subset of the 7.5
 * `WorkflowFailure` seam — the driver routes EVERY failure/park/compensating class
 * through the sink so nothing fails silently (inv-5 / §16).
 */
export interface DeletionWorkflowFailure {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
}

/** What surfacing did — proof the failure was routed somewhere (inv-5). */
export interface DeletionSurfaceOutcome {
  readonly routedToHealth: boolean;
  readonly routedToOutbox: boolean;
}

/** Closed, enumerable health-sink failure set (§16 — never thrown). */
export interface DeletionHealthSinkError {
  readonly code: "surface_failed" | "outbox_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * The failure sink the driver routes every deletion-saga failure/park/compensating
 * class through (inv-5). In production this is backed by the 7.5
 * `surfaceWorkflowFailure`; the driver depends only on this narrow port so it stays
 * pure + injected-testable. Never throws.
 */
export interface DeletionHealthSink {
  surface(
    failure: DeletionWorkflowFailure,
  ): Promise<Result<DeletionSurfaceOutcome, DeletionHealthSinkError>>;
}

// ===========================================================================
// LOCAL STATE MACHINE (defineMachine — @sow/domain ships none for 7.14)
// ===========================================================================

/**
 * The full deletion-saga state alphabet (Flow 7). Ordered happy path:
 *   requested → intent_verified → plan_built → markdown_tombstoned (COMMIT POINT)
 *            → gbrain_purged → events_tombstoned → refs_reconciled → deleted
 * Park/failure states each carry a pinned recovery back-edge so the machine stays
 * total. `compensating` is the POST-COMMIT partial-failure state (a step after the
 * durable tombstone failed): it re-drives the remaining steps and lands `deleted` (a
 * later successful re-drive) or `compensation_pending` (a persistent partial — parked
 * for retry). Pre-commit rejections (`intent_rejected`, `plan_rejected`,
 * `commit_failed`) are terminal-for-this-run parks with NO durable tombstone.
 */
export const DELETION_SAGA_STATES = [
  "requested",
  "intent_verified",
  "plan_built",
  "markdown_tombstoned",
  "gbrain_purged",
  "events_tombstoned",
  "refs_reconciled",
  // terminal happy
  "deleted",
  // pre-commit rejections (NO durable step happened)
  "intent_rejected",
  "plan_rejected",
  "commit_failed",
  // post-commit partial-failure recovery
  "compensating",
  "compensation_pending",
] as const;

export type DeletionSagaState = (typeof DELETION_SAGA_STATES)[number];

// Adjacency table. `deleted` is the sole happy terminal. Pre-commit rejections are
// terminal parks. `compensating` re-drives the remaining post-commit steps: it can
// reach `deleted` (recovery succeeded) OR `compensation_pending` (still partial —
// parked for a later re-drive). `compensation_pending` re-enters `compensating` on a
// re-drive. Each post-commit step can enter `compensating` on failure.
const deletionSagaTransitions: Readonly<
  Record<DeletionSagaState, readonly DeletionSagaState[]>
> = {
  requested: ["intent_verified", "intent_rejected"],
  intent_verified: ["plan_built", "plan_rejected"],
  plan_built: ["markdown_tombstoned", "commit_failed"],
  // THE COMMIT POINT landed — every downstream failure is a COMPENSATING branch,
  // never a rollback of the durable tombstone (inv-5).
  markdown_tombstoned: ["gbrain_purged", "compensating"],
  gbrain_purged: ["events_tombstoned", "compensating"],
  events_tombstoned: ["refs_reconciled", "compensating"],
  refs_reconciled: ["deleted", "compensating"],
  // compensating re-drives remaining steps: recover → deleted, or park → pending.
  compensating: ["deleted", "compensation_pending"],
  compensation_pending: ["compensating"],
  // terminal happy
  deleted: [],
  // pre-commit terminal parks (no durable tombstone)
  intent_rejected: [],
  plan_rejected: [],
  commit_failed: [],
};

/** The local, PURE + TOTAL deletion-saga machine (defineMachine — never throws). */
export const deletionSagaMachine: StateMachine<DeletionSagaState> =
  defineMachine<DeletionSagaState>(deletionSagaTransitions);

// ===========================================================================
// DRIVER INPUT / DEPS / OUTCOME
// ===========================================================================

/**
 * The complete input to {@link runDeletionSaga}. `run` is the trigger submission
 * resolved idempotently through the 7.4 seam (resolveRun); `subject` is WHAT the
 * owner asked to delete (a logical identity + the bound workspace); `retention` is
 * the RET-3 policy to honor (defaults to {@link DEFAULT_RETENTION_POLICY}).
 *
 * The deletion PLAN is NOT caller-supplied — it is DERIVED inside the governed
 * pipeline by {@link BuildDeletionPlanPort} from the VERIFIED intent + retention, so
 * a caller cannot inject a plan that prunes a human-owned region or redirects the
 * write to another workspace.
 */
export interface DeletionSagaInput {
  readonly run: ResolveRunInput;
  readonly subject: DeletionSubject;
  readonly retention?: RetentionPolicy;
}

/**
 * The injected dependency set: the deletion-saga activity ports, the 7.5 health sink,
 * the 7.4 WorkflowRun repository (for resolveRun's idempotency seam), and the injected
 * Clock. Every dependency is a narrow port so the driver stays pure and fully
 * injected-testable (no KnowledgeWriter / GBrain / event store / Temporal).
 */
export interface DeletionSagaDeps {
  readonly verifyIntent: VerifyIntentPort;
  readonly buildPlan: BuildDeletionPlanPort;
  readonly tombstoneMarkdown: TombstoneMarkdownPort;
  readonly purgeGbrain: PurgeGbrainPort;
  readonly tombstoneEvents: TombstoneEventStorePort;
  readonly reconcileRefs: ReconcileRefsPort;
  readonly health: DeletionHealthSink;
  readonly runs: WorkflowRunRefRepository;
  readonly clock: Clock;
}

/**
 * The result of a deletion-saga drive. `state` is the machine state the pipeline
 * rested in (the happy terminal `deleted`, a pre-commit reject park, or a
 * post-commit `compensating`/`compensation_pending`). `revisionId` is the committed
 * tombstone revision (present once the COMMIT POINT landed). `preservedRegions` names
 * the human-owned regions the deriver kept (proof inv-2 ran). `danglingRefs` names
 * external refs surfaced-not-silenced (inv-5). `run`/`runReused` mirror resolveRun.
 * `surfaced` names the routed health failure on a failure/park branch. Never throws.
 */
export interface DeletionSagaOutcome {
  readonly state: DeletionSagaState;
  readonly revisionId?: string;
  readonly preservedRegions: readonly string[];
  readonly danglingRefs: readonly string[];
  readonly run: Result<WorkflowRunRef, WorkflowRunError>;
  readonly runReused: boolean;
  readonly surfaced?: DeletionWorkflowFailure;
}

// --- machine-transition helper ---------------------------------------------

/**
 * Walk an ORDERED list of successor states, asserting each edge is legal. The machine
 * is pure + total (never throws); an illegal edge stops the cursor at the last legal
 * state rather than crashing, keeping the driver total (§16). Returns the last legal
 * state reached (so a mis-pinned edge can never silently "teleport" the cursor past a
 * forbidden edge — e.g. plan_built→deleted would stop at plan_built).
 */
function advance(
  from: DeletionSagaState,
  through: readonly DeletionSagaState[],
): DeletionSagaState {
  let cursor = from;
  for (const to of through) {
    const stepped = deletionSagaMachine.transition(cursor, to);
    if (!isOk(stepped)) return cursor;
    cursor = stepped.value;
  }
  return cursor;
}

// --- failure-class mapping (inv-5: distinct health item per failure class) --

/** Map a deletion-saga resting state to a §16 FailureClass for the health sink. */
function failureClassFor(state: DeletionSagaState): FailureClass {
  switch (state) {
    case "intent_rejected":
      return "conflict_review";
    case "plan_rejected":
      return "conflict_review";
    case "commit_failed":
      return "write_through_failed";
    case "compensating":
      return "write_through_failed";
    case "compensation_pending":
      return "parity_defect";
    default:
      return "write_through_failed";
  }
}

// ===========================================================================
// DRIVER
// ===========================================================================

/**
 * Run the cross-store deletion saga as a pure, replay-safe driver (Flow 7 /
 * REQ-F-013 / REQ-F-018 / RET-3).
 *
 * Order (each durable step keyed for idempotent replay — inv-4):
 *   1. resolveRun (7.4 seam) — a seen idempotencyKey reuses the run (re-running a
 *      completed deletion re-drives the same run to the same terminal — a no-op).
 *   2. VERIFY explicit owner intent (inv-1 / REQ-F-013) — implicit/unauthorized →
 *      intent_rejected with NO durable step.
 *   3. DERIVE the deletion plan from the verified intent + retention (inv-2 /
 *      REQ-F-018 / RET-3) — a human-owned-only subject or a retention-blocked subject
 *      → plan_rejected with NO commit; the plan tombstones ONLY prune-eligible,
 *      non-human-owned regions, stamped with the bound workspace.
 *   4. STEP 1 (THE COMMIT POINT): tombstone Markdown via KnowledgeWriter (inv-3) —
 *      idempotent by the plan key (no double-tombstone on replay). A failure →
 *      commit_failed with NO downstream step. KnowledgeWriter is the last-line
 *      human-owned preservation guard.
 *   5. STEP 2: purge/re-index GBrain (inv-3) — a failure AFTER the commit →
 *      compensating (never a rollback of the durable tombstone).
 *   6. STEP 3: append an event-store tombstone (history PRESERVED, NOT hard-deleted)
 *      — append-once; a failure → compensating.
 *   7. STEP 4: reconcile read-model + external refs — a dangling ref is surfaced
 *      (never silent) → compensating; a hard failure → compensating.
 *   8. deleted (happy terminal).
 *
 * Every failure/park/compensating branch routes through the health sink (inv-5) and
 * returns the resting machine state. A crash mid-saga re-driven from the start
 * produces NO double-tombstone and NO resurrected GBrain entry. Never throws.
 */
export async function runDeletionSaga(
  input: DeletionSagaInput,
  deps: DeletionSagaDeps,
): Promise<DeletionSagaOutcome> {
  // 1. Resolve the run idempotently (7.4). A seen idempotencyKey reuses the existing
  //    run — the whole saga is safe to re-drive from the start (inv-4 / LIFE-3).
  const resolved = await resolveRun(input.run, deps.runs, deps.clock);
  const runResult: Result<WorkflowRunRef, WorkflowRunError> = isOk(resolved)
    ? { ok: true, value: resolved.value.run }
    : resolved;
  const runReused = isOk(resolved) ? resolved.value.reused : false;

  const retention = input.retention ?? DEFAULT_RETENTION_POLICY;

  // The machine cursor starts at the initial state.
  let state: DeletionSagaState = "requested";
  let revisionId: string | undefined;
  let preservedRegions: readonly string[] = [];

  const surface = async (
    failState: DeletionSagaState,
    message: string,
    danglingRefs: readonly string[] = [],
  ): Promise<DeletionSagaOutcome> => {
    const failure: DeletionWorkflowFailure = {
      failureClass: failureClassFor(failState),
      subjectRef: input.subject.subjectRef,
      message,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    // Route through the health sink — nothing fails silently (inv-5). Even if the
    // sink itself errors we still return the failure state (fail-closed); the sink's
    // own error is the 7.5 seam's concern, not a reason to lose the machine state.
    await deps.health.surface(failure);
    return {
      state: failState,
      ...(revisionId !== undefined ? { revisionId } : {}),
      preservedRegions,
      danglingRefs,
      run: runResult,
      runReused,
      surfaced: failure,
    };
  };

  // 2. VERIFY explicit owner intent (inv-1 / REQ-F-013). A deletion NEVER runs on
  //    implicit/inferred intent — refuse BEFORE any durable step.
  const verified = await deps.verifyIntent.verify(input.subject);
  if (!isOk(verified)) {
    state = advance(state, ["intent_rejected"]);
    return surface(state, `deletion intent not verified: ${verified.error.code}`);
  }

  // 3. DERIVE the deletion plan FROM the verified intent + retention (inv-2 /
  //    REQ-F-018 / RET-3). The plan is NEVER caller-supplied; it tombstones ONLY
  //    prune-eligible, non-human-owned regions and is stamped with the BOUND
  //    workspace. A human-owned-only or retention-blocked subject → plan_rejected
  //    with NO commit (buildPlan runs BEFORE the COMMIT POINT).
  state = advance(state, ["intent_verified"]);
  const built = await deps.buildPlan.build(verified.value, retention);
  if (!isOk(built)) {
    state = advance(state, ["plan_rejected"]);
    return surface(state, `deletion plan refused: ${built.error.code}`);
  }
  const derived = built.value;
  // Capture the DELIBERATELY-preserved human-owned regions (proof inv-2 ran over the
  // real plan, not a decoy) so the outcome carries it even on a later failure branch.
  preservedRegions = derived.preservedRegions;
  state = advance(state, ["plan_built"]);

  // 4. STEP 1 — THE COMMIT POINT: tombstone Markdown via KnowledgeWriter (inv-3 step
  //    1 / safety rule 1). IDEMPOTENT by the plan key (inv-4): a replay reuses the
  //    prior revision — NO double-tombstone. KnowledgeWriter is the last-line
  //    human-owned preservation guard (`human_owned_region`). A failure HARD-STOPS
  //    at commit_failed with NO downstream step (no partial cross-store deletion).
  const committed = await deps.tombstoneMarkdown.tombstone(derived.plan);
  if (!isOk(committed)) {
    state = advance(state, ["commit_failed"]);
    return surface(state, `markdown tombstone failed: ${committed.error.code}`);
  }
  // BELT-AND-SUSPENDERS (content-blindness finding): the returned revision MUST
  // correspond to the CURRENT derived plan. With the content discriminator folded into
  // the plan key a same-key replay carries the same content BY CONSTRUCTION; still, if
  // the port reports a committed discriminator that DIFFERS from the current plan's,
  // that is a same-key/different-content collision — FAIL CLOSED to a compensating
  // state (surfaced via health, inv-5), NEVER silently accept a replay of stale content
  // and report `deleted`.
  if (
    committed.value.committedContentDiscriminator !== undefined &&
    committed.value.committedContentDiscriminator !== derived.contentDiscriminator
  ) {
    revisionId = committed.value.revisionId;
    state = advance(state, ["markdown_tombstoned", "compensating"]);
    return compensate(
      state,
      "markdown tombstone replay returned a revision whose content does not match the current derived plan (same-key/different-content collision) — fail-closed",
    );
  }
  revisionId = committed.value.revisionId;
  state = advance(state, ["markdown_tombstoned"]);

  // --- POST-COMMIT: the durable tombstone stands. Every downstream failure is a
  //     COMPENSATING branch (never a rollback) surfaced via health (inv-5). ---

  // 5. STEP 2 — purge/re-index GBrain (inv-3 step 2). Idempotent by purgeKey: a
  //    crash-replay leaves NO resurrected GBrain index entry (inv-4). A failure →
  //    compensating (the durable tombstone stands).
  const purged = await deps.purgeGbrain.purge(revisionId, derived.purgeKey);
  if (!isOk(purged)) {
    state = advance(state, ["compensating"]);
    return compensate(state, `gbrain purge failed (tombstone stands): ${purged.error.code}`);
  }
  state = advance(state, ["gbrain_purged"]);

  // 6. STEP 3 — append an event-store TOMBSTONE (inv-3 step 3). History is PRESERVED
  //    (a new tombstone record, NOT a hard-delete). Append-once by eventTombstoneKey
  //    (inv-4). A failure → compensating.
  const eventTombstoned = await deps.tombstoneEvents.tombstone(
    input.subject.subjectRef,
    derived.eventTombstoneKey,
  );
  if (!isOk(eventTombstoned)) {
    state = advance(state, ["compensating"]);
    return compensate(
      state,
      `event-store tombstone failed (history preserved, tombstone stands): ${eventTombstoned.error.code}`,
    );
  }
  state = advance(state, ["events_tombstoned"]);

  // 7. STEP 4 — reconcile read-model + external refs (inv-3 step 4 / inv-5). A
  //    dangling external ref is SURFACED (never left silently); a non-empty dangling
  //    set OR a hard failure → compensating so it retries.
  const reconciled = await deps.reconcileRefs.reconcile(
    input.subject.subjectRef,
    derived.reconcileKey,
  );
  if (!isOk(reconciled)) {
    state = advance(state, ["compensating"]);
    return compensate(state, `ref reconciliation failed: ${reconciled.error.code}`);
  }
  if (reconciled.value.danglingRefs.length > 0) {
    // inv-5: a dangling ref is reconciled-or-surfaced, NEVER left silently.
    state = advance(state, ["compensating"]);
    return compensate(
      state,
      `${reconciled.value.danglingRefs.length} external ref(s) dangling — surfaced for reconciliation`,
      reconciled.value.danglingRefs,
    );
  }
  state = advance(state, ["refs_reconciled"]);

  // 8. deleted (happy terminal).
  state = advance(state, ["deleted"]);
  return {
    state,
    revisionId,
    preservedRegions,
    danglingRefs: [],
    run: runResult,
    runReused,
  };

  // --- compensation helper (closure over the surfacing + outcome fields) ------

  /**
   * Surface a POST-COMMIT partial failure as a compensating outcome (inv-5). The
   * durable tombstone stands; the saga is re-drivable from the start (each remaining
   * step is idempotent), so the resting state is `compensating` (a re-drive retries
   * the remaining steps). This helper never rolls the tombstone back.
   */
  async function compensate(
    failState: DeletionSagaState,
    message: string,
    danglingRefs: readonly string[] = [],
  ): Promise<DeletionSagaOutcome> {
    return surface(failState, message, danglingRefs);
  }
}
