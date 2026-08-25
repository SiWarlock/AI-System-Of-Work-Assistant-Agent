// @sow/workflows — task 7.19: AUTOMATED RETENTION-PRUNING SCHEDULED WORKFLOW —
// PURE orchestration DRIVER (RET-1 / RET-3 / REQ-F-018 / §16.4).
//
// A sibling of the 7.11 period-review / 7.10 daily-brief scheduled drivers: same
// two-layer structure (pure driver + injected activity ports), same foundation ports
// (Clock, WorkflowRunRefRepository, ScheduleStore, the 7.5 health sink), same
// idempotency seam (resolveRun), same LIFE-2 durable-schedule catch-up
// (collapsedNextRunFromClock) so a missed prune schedule COLLAPSES to ONE run on wake
// rather than a thundering herd of once-per-missed-occurrence runs.
//
// ★ WHAT IT DOES (RET-1 / §16.4): a durable scheduled sweep enforcing the configurable
// retention policy on ASSISTANT-HELD raw capture ONLY (voice/audio, OCR intermediates,
// cached payloads). Raw audio is deleted only after an AUDITED synthesis exists; other
// raw payloads are pruned after a configurable window (default 30d, reusing the
// canonical {@link RetentionPolicy}). Pruning operates ONLY on assistant-held copies —
// externally-authoritative sources (Granola transcripts, Calendar events) are kept as
// LINKS and NEVER re-stored or pruned (§10.1). An undispositioned parked source (still
// needed for triage re-entry) is NEVER pruned.
//
// ★ RET-3 ONE-WRITER (safety rule 1): any Markdown removal routes ONLY through the
// injected KnowledgeWriter tombstone port ({@link PruneTombstonePort}) — the driver has
// NO raw fs/markdown delete path — and NEVER removes human-owned sections or derived
// semantic notes (the {@link PrunePolicyPort} excludes them from selection). The
// operational-store raw-payload deletion is a direct repo delete of assistant-held
// copies only.
//
// ★ TWO-LAYER + SANDBOX (root CLAUDE.md): this driver imports NEITHER @temporalio NOR
// node:crypto and calls NO Date.now()/Math.random(). All time + I/O arrive through the
// injected ports + Clock, so it is Vitest-unit-testable with no Temporal server and safe
// to wrap in a thin @temporalio workflow later. The live schedule registration is
// owner-gated §19.12 (output-workflow arming) and is NOT wired here — this file is built
// DORMANT (mirrors periodReview/dailyBrief/deletionSaga).
//
// §16 error convention: the driver NEVER throws across a boundary. It folds every typed
// port rejection onto a distinct retentionPruneMachine failure STATE and routes it
// through the health sink (nothing fails silently). No new FailureClass member — reuses
// `missed_or_late_schedule` (a missed/late prune), `db_unavailable` (a store-read /
// candidate-selection fault), and `write_through_failed` (a KW-removal or store-delete
// fault).
import { isOk } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  WorkflowRunRef,
  KnowledgeMutationPlan,
  FailureClass,
  AuditId,
} from "@sow/contracts";
import { defineMachine } from "@sow/domain";
import type { StateMachine } from "@sow/domain";
import type { Clock, WorkflowRunRefRepository, ScheduleStore } from "../ports/operational";
import { resolveRun } from "../runtime/idempotency";
import type { ResolveRunInput } from "../runtime/idempotency";
import type { WorkflowRunError } from "../runtime/workflowRun";
import { collapsedNextRunFromClock } from "../runtime/catchUpWindow";
import { advanceBookkeeping } from "../runtime/clock";
// The canonical RET-3 policy is single-sourced in deletionSaga.ts (imported for internal
// use only — NOT re-exported: the barrel's flat `export *` would collide on a duplicate
// re-export; consumers reference it from `./deletionSaga`).
import { DEFAULT_RETENTION_POLICY } from "./deletionSaga";
import type { RetentionPolicy } from "./deletionSaga";

// ===========================================================================
// (A) The local retentionPruneMachine (state alphabet + adjacency)
// ===========================================================================
//
// Defined via the @sow/domain `defineMachine` primitive (the domain package ships no
// retention-prune machine; the workflow owns its own state alphabet, exactly as the
// 7.10/7.11/7.14 sibling drivers do). PURE + TOTAL: legal edges return ok(to), illegal
// edges return a typed err — the machine never throws.

/** The closed retention-prune state alphabet. */
export const RETENTION_PRUNE_STATES = [
  // happy path
  "scheduled",
  "candidates_selected",
  "removed",
  // recovery / park
  "no_run_due",
  "selection_failed",
  "tombstone_failed",
  "purge_failed",
  // terminal
  "done",
] as const;

export type RetentionPruneState = (typeof RETENTION_PRUNE_STATES)[number];

// Adjacency table. Terminal `done` maps to []. Failure/park states each carry a pinned
// recovery/retry back-edge (a non-terminal state needs ≥1 outgoing edge) so the machine
// is total; the driver only walks the happy edges + the pinned failure-entry edges.
const retentionPruneTransitions: Readonly<
  Record<RetentionPruneState, readonly RetentionPruneState[]>
> = {
  // scheduled → select candidates, OR park (nothing due, LIFE-2 collapse to zero), OR a
  // candidate-selection fault.
  scheduled: ["candidates_selected", "no_run_due", "selection_failed"],
  // candidates_selected → remove the due set, OR a KW-tombstone / store-delete fault.
  candidates_selected: ["removed", "tombstone_failed", "purge_failed"],
  // removed → done.
  removed: ["done"],
  // failure/park back-edges (each non-terminal state has ≥1 outgoing edge).
  no_run_due: ["scheduled"],
  selection_failed: ["scheduled"],
  tombstone_failed: ["candidates_selected"],
  purge_failed: ["candidates_selected"],
  // terminal
  done: [],
};

/** The local retention-prune machine (defined via the @sow/domain primitive). */
export const retentionPruneMachine: StateMachine<RetentionPruneState> =
  defineMachine<RetentionPruneState>(retentionPruneTransitions);

// ===========================================================================
// (B) The retention-prune activity PORTS (the seam the driver reasons in)
// ===========================================================================
//
// Declared HERE (the driver owns them, mirroring the 7.11 period-review seam). Each port
// is PURE + workflow-safe (types only; no @temporalio / node:crypto). The error sets are
// DECOUPLED from concrete adapter shapes — they are the retention-prune vocabulary mapped
// onto the machine failure states. §16: every port returns a typed Result, never throws.

/** The lifecycle state of a parked source (mirrors @sow/db `SourceDispositionState`). */
export type PrunableDispositionState = "queued_for_review" | "dispositioned";

/**
 * A single ASSISTANT-HELD raw-capture record the retention prune considers. The prune
 * operates ONLY on assistant-held copies — `externallyAuthoritative` sources (Granola
 * transcripts, Calendar events) are kept as LINKS and never selected (§10.1);
 * `humanOwned` + `derived` content are NEVER pruned (RET-3). `capturedAt` drives the
 * configurable-window age; `auditedSynthesisExists` gates raw audio (RET-3 — raw audio is
 * removed only after an audited synthesis). `dispositionState==="queued_for_review"`
 * marks an undispositioned parked source (still needed for triage re-entry) — retained.
 * `markdownRemoval`, when present, is the region-bounded KnowledgeWriter tombstone plan
 * for a raw region backing this payload — the ONLY Markdown mutation the driver may make
 * (routed through {@link PruneTombstonePort}); a payload with no Markdown region is purely
 * an operational-store copy deleted directly.
 */
export interface PrunableRecord {
  readonly recordId: string;
  readonly workspaceId: WorkspaceId;
  /** Retention class: "raw_audio" | "raw" | "derived" | … (only raw/raw_audio are prune-eligible). */
  readonly contentClass: string;
  /** True IFF this is an assistant-held copy (the ONLY prune candidate class). */
  readonly assistantHeld: boolean;
  /** True IFF this is an externally-authoritative source kept as a LINK (§10.1) — never pruned. */
  readonly externallyAuthoritative: boolean;
  /** True IFF a human authored/owns this content (RET-3) — never pruned. */
  readonly humanOwned: boolean;
  /** ISO capture time (drives the configurable-window age check). */
  readonly capturedAt?: string;
  /** True IFF an audited synthesis over this raw audio already exists (RET-3 raw-audio gate). */
  readonly auditedSynthesisExists?: boolean;
  /** A parked source's disposition state — an undispositioned parked source is NOT pruned (re-entry). */
  readonly dispositionState?: PrunableDispositionState;
  /** True IFF this record was already pruned (idempotence — a re-run skips it). */
  readonly alreadyPruned?: boolean;
  /** The region-bounded KnowledgeWriter tombstone plan (RET-3), when a Markdown region backs this payload. */
  readonly markdownRemoval?: KnowledgeMutationPlan;
}

// --- (B1) PrunePolicyPort — the SELECTION activity seam --------------------

/** The selection request: the bound workspace, the retention policy, and the clock reading. */
export interface PruneSelectionRequest {
  readonly workspaceId: WorkspaceId;
  readonly retention: RetentionPolicy;
  /** The injected clock's `now()` reading — the age comparison runs against this (not Date.now()). */
  readonly now: string;
}

/** Why a candidate was NOT selected (observability + audit — proof the guard ran). */
export type PruneSkipReason =
  | "not_assistant_held"
  | "externally_authoritative"
  | "human_owned"
  | "derived_note"
  | "undispositioned_parked"
  | "already_pruned"
  | "inside_window"
  | "unknown_class";

/** A skipped candidate + the reason it was retained. */
export interface PruneSkip {
  readonly recordId: string;
  readonly reason: PruneSkipReason;
}

/** The selection verdict: the DUE set + the deliberately-retained set. */
export interface PruneSelection {
  readonly due: readonly PrunableRecord[];
  readonly skipped: readonly PruneSkip[];
}

/**
 * Closed, enumerable selection failure set (§16 — never thrown). `enumeration_failed` is
 * a candidate-enumeration/store-READ fault — its §16 home is `db_unavailable`, since no
 * write was ever attempted — see {@link failureClassFor}.
 */
export type PrunePolicyErrorCode = "enumeration_failed";
export interface PrunePolicyError {
  readonly code: PrunePolicyErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * SELECT the assistant-held records DUE for prune under the retention policy (RET-3). The
 * decision is DERIVED from the record set + the policy + the clock — never caller-supplied
 * — so an externally-authoritative link, a human-owned/derived note, an undispositioned
 * parked source, or a record still inside its window is provably never in the due set.
 * Never throws.
 */
export interface PrunePolicyPort {
  select(request: PruneSelectionRequest): Promise<Result<PruneSelection, PrunePolicyError>>;
}

// --- (B2) PruneTombstonePort — RET-3 one-writer (KnowledgeWriter) ----------

/** A successful Markdown-tombstone commit. `replayed` is true on an idempotent replay. */
export interface PruneTombstoneSuccess {
  readonly revisionId: string;
  readonly replayed: boolean;
}

/**
 * Closed, enumerable Markdown-tombstone failure set (§16 — never thrown), mirroring the
 * @sow/knowledge WriteFailure variants the 7.14 deletion saga folds. `human_owned_region`
 * is the LAST-LINE preservation guard: KnowledgeWriter refuses a human-owned region even
 * if selection somehow let one through (defense-in-depth, RET-3).
 */
export type PruneTombstoneFailureCode =
  | "write_conflict"
  | "ownership_violation"
  | "human_owned_region"
  | "commit_failed";
export interface PruneTombstoneFailure {
  readonly code: PruneTombstoneFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Commit the region-bounded Markdown tombstone through the KnowledgeWriter (safety rule 1:
 * the SOLE Markdown writer — RET-3 one-writer). The driver's ONLY Markdown-mutation path;
 * there is NO raw fs/markdown delete. IDEMPOTENT by the plan key (a prior tombstone returns
 * `replayed:true`). Never throws.
 */
export interface PruneTombstonePort {
  tombstone(
    plan: KnowledgeMutationPlan,
  ): Promise<Result<PruneTombstoneSuccess, PruneTombstoneFailure>>;
}

// --- (B3) PrunablePayloadStore — direct repo delete of assistant-held copies

/** Closed, enumerable payload-store failure set (§16 — never thrown). */
export interface PrunablePayloadStoreError {
  readonly code: "delete_failed" | "not_found";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Delete the ASSISTANT-HELD operational-store copy of a pruned payload (a direct repo
 * delete — NOT a Markdown mutation; that goes through {@link PruneTombstonePort}). Pruning
 * touches assistant-held copies ONLY; externally-authoritative sources are never here.
 * IDEMPOTENT: deleting an already-absent record is a benign no-op. Never throws.
 */
export interface PrunablePayloadStore {
  delete(recordId: string): Promise<Result<void, PrunablePayloadStoreError>>;
}

// --- (B4) PruneAuditPort — each removal is audit-logged --------------------

/** The audit record for a single prune removal (RET-1: idempotent + audit-logged). */
export interface PruneAuditEntry {
  readonly recordId: string;
  readonly workspaceId: WorkspaceId;
  /** The KnowledgeWriter tombstone revision, when the removal included a Markdown region. */
  readonly revisionId?: string;
}

/** Closed, enumerable audit-sink failure set (§16 — never thrown). */
export interface PruneAuditError {
  readonly code: "audit_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Audit-log a single prune removal (RET-1). The driver routes to this sink but does NOT
 * branch on its result (mirrors the 7.5 health sink) — the audit adapter owns its own
 * durability/retry. Never throws.
 */
export interface PruneAuditPort {
  record(entry: PruneAuditEntry): Promise<Result<void, PruneAuditError>>;
}

// --- (B5) RetentionPruneHealthSink — the failure sink (7.5 shape) ----------

export interface RetentionPruneFailure {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
}
export interface RetentionPruneSurfaceOutcome {
  readonly routedToHealth: boolean;
  readonly routedToOutbox: boolean;
}
export interface RetentionPruneHealthSinkError {
  readonly code: "surface_failed" | "outbox_failed";
  readonly message: string;
  readonly cause?: unknown;
}
export interface RetentionPruneHealthSink {
  surface(
    failure: RetentionPruneFailure,
  ): Promise<Result<RetentionPruneSurfaceOutcome, RetentionPruneHealthSinkError>>;
}

// ===========================================================================
// (C) The driver
// ===========================================================================

/**
 * The complete input to {@link runRetentionPrune}. `run` is the trigger submission resolved
 * idempotently through the 7.4 seam. `scheduleId` + `intervalMs` + `catchUpWindowMs` drive
 * the LIFE-2 collapse. `workspaceId` is the bound workspace the sweep prunes (WS-2).
 * `retention` defaults to {@link DEFAULT_RETENTION_POLICY} (30d / raw-audio-after-synthesis).
 */
export interface RetentionPruneInput {
  readonly run: ResolveRunInput;
  readonly scheduleId: string;
  readonly intervalMs: number;
  readonly catchUpWindowMs: number;
  readonly workspaceId: WorkspaceId;
  readonly retention?: RetentionPolicy;
}

/**
 * The injected dependency set: the selection activity, the RET-3 KnowledgeWriter tombstone
 * port, the assistant-held payload store, the audit sink, the 7.5 health sink, the 7.4
 * WorkflowRun repository (resolveRun), the 7.2 durable-schedule store, and the injected
 * Clock. Every dependency is a narrow port so the driver stays pure and injected-testable.
 */
export interface RetentionPruneDeps {
  readonly policy: PrunePolicyPort;
  readonly tombstone: PruneTombstonePort;
  readonly store: PrunablePayloadStore;
  readonly audit: PruneAuditPort;
  readonly health: RetentionPruneHealthSink;
  readonly runs: WorkflowRunRefRepository;
  readonly schedule: ScheduleStore;
  readonly clock: Clock;
}

/**
 * The result of a retention-prune drive. `state` is the machine state the pipeline rested
 * in (`done`, a failure/park state, or `no_run_due`). `removedRecordIds` names the pruned
 * records (proof of the sweep). `preservedCount` is how many candidates were deliberately
 * retained (proof the guard ran). `collapsed` is true when >1 due occurrence collapsed into
 * one run (LIFE-2). `surfaced` names the health failure routed on a failure/park branch.
 * Never throws.
 */
export interface RetentionPruneOutcome {
  readonly state: RetentionPruneState;
  readonly run: Result<WorkflowRunRef, WorkflowRunError>;
  readonly runReused: boolean;
  readonly collapsed: boolean;
  readonly removedRecordIds: readonly string[];
  readonly preservedCount?: number;
  readonly surfaced?: RetentionPruneFailure;
}

/**
 * Advance the local machine cursor through an ORDERED list of successor states, asserting
 * each edge is legal. The domain machine is pure + total (never throws); an illegal edge
 * stops the cursor at the last legal state rather than crashing, keeping the driver total
 * (§16). Returns the last legal state reached.
 */
function advance(
  from: RetentionPruneState,
  through: readonly RetentionPruneState[],
): RetentionPruneState {
  let cursor = from;
  for (const to of through) {
    const step = retentionPruneMachine.transition(cursor, to);
    if (!isOk(step)) return cursor;
    cursor = step.value;
  }
  return cursor;
}

/** Map a retention-prune failure state to a §16 FailureClass for the health sink. NO new member. */
function failureClassFor(state: RetentionPruneState): FailureClass {
  switch (state) {
    case "no_run_due":
      // A missed/late (or not-yet-elapsed) prune schedule — the LIFE-2 miss class.
      return "missed_or_late_schedule";
    case "selection_failed":
      // A store-read / candidate-enumeration fault — no write was ever attempted, so this
      // is a §16 `db_unavailable`, not a write-through failure.
      return "db_unavailable";
    case "tombstone_failed":
      // A KnowledgeWriter Markdown-removal fault.
      return "write_through_failed";
    case "purge_failed":
      // An assistant-held payload store-delete fault.
      return "write_through_failed";
    default:
      return "write_through_failed";
  }
}

/**
 * Run the retention-prune sweep as a pure, replay-safe driver (RET-1 / RET-3 / REQ-F-018).
 *
 * Order (each durable step keyed for idempotent replay):
 *   1. resolveRun (7.4 seam) — a seen idempotencyKey reuses the existing run.
 *   2. LIFE-2 catch-up: collapse (possibly many) missed occurrences to a single run (NO
 *      run due ⇒ park in no_run_due with NO durable write; `collapsed` when >1).
 *   3. SELECT the due assistant-held records via the prune policy (RET-3 exclusions). A
 *      selection fault folds to selection_failed.
 *   4. Remove each due record: (a) RET-3 one-writer — any Markdown removal routes ONLY
 *      through the KnowledgeWriter tombstone port; (b) delete the assistant-held
 *      operational copy directly; (c) audit-log the removal. A KW-tombstone fault folds to
 *      tombstone_failed; a store-delete fault to purge_failed — with ZERO further removals.
 *   5. advance the durable schedule bookkeeping + done.
 *
 * Every failure/park branch routes through the health sink. Never throws.
 */
export async function runRetentionPrune(
  input: RetentionPruneInput,
  deps: RetentionPruneDeps,
): Promise<RetentionPruneOutcome> {
  // 1. Resolve the run idempotently (7.4). A seen idempotencyKey reuses the run.
  const resolved = await resolveRun(input.run, deps.runs, deps.clock);
  const runResult: Result<WorkflowRunRef, WorkflowRunError> = isOk(resolved)
    ? { ok: true, value: resolved.value.run }
    : resolved;
  const runReused = isOk(resolved) ? resolved.value.reused : false;

  const retention = input.retention ?? DEFAULT_RETENTION_POLICY;
  let state: RetentionPruneState = "scheduled";
  let collapsed = false;
  const removedRecordIds: string[] = [];

  const surface = async (
    failState: RetentionPruneState,
    message: string,
  ): Promise<RetentionPruneOutcome> => {
    const failure: RetentionPruneFailure = {
      failureClass: failureClassFor(failState),
      subjectRef: input.run.workflowId,
      message,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    // Route through the health sink — nothing fails silently. Even if the sink itself
    // errors we still return the failure state (fail-closed).
    await deps.health.surface(failure);
    return { state: failState, run: runResult, runReused, collapsed, removedRecordIds, surfaced: failure };
  };

  // 2. LIFE-2 catch-up: collapse missed occurrences to a SINGLE run (7.2). A first-ever run
  //    (no bookkeeping) skips catch-up and proceeds.
  const bookkeeping = await deps.schedule.getBookkeeping(input.scheduleId);
  if (bookkeeping !== undefined) {
    const catchUp = collapsedNextRunFromClock(bookkeeping, deps.clock, {
      intervalMs: input.intervalMs,
      catchUpWindowMs: input.catchUpWindowMs,
    });
    if (catchUp.nextRun === null) {
      // Nothing catchable due — park in no_run_due with NO durable write.
      state = advance(state, ["no_run_due"]);
      return surface(state, "no retention-prune run due — schedule not yet elapsed");
    }
    collapsed = catchUp.collapsed;
  }

  // 3. SELECT the due assistant-held records (RET-3 exclusions applied in the activity).
  const selected = await deps.policy.select({
    workspaceId: input.workspaceId,
    retention,
    now: deps.clock.now(),
  });
  if (!isOk(selected)) {
    state = advance(state, ["selection_failed"]);
    return surface(state, `prune candidate selection failed (store-read/selection fault): ${selected.error.code}`);
  }
  state = advance(state, ["candidates_selected"]);
  const selection = selected.value;

  // 4. Remove each due record. Markdown removal FIRST (RET-3 one-writer — the commit
  //    point), then the operational copy, then the audit.
  for (const rec of selection.due) {
    let revisionId: string | undefined;
    // (a) RET-3 one-writer: any Markdown removal routes ONLY through the KnowledgeWriter
    //     tombstone port. The driver has NO raw fs/markdown delete path.
    if (rec.markdownRemoval !== undefined) {
      const tombstoned = await deps.tombstone.tombstone(rec.markdownRemoval);
      if (!isOk(tombstoned)) {
        state = advance(state, ["tombstone_failed"]);
        return surface(state, `markdown tombstone failed for ${rec.recordId}: ${tombstoned.error.code}`);
      }
      revisionId = tombstoned.value.revisionId;
    }
    // (b) Delete the assistant-held operational-store copy (direct repo delete).
    const deleted = await deps.store.delete(rec.recordId);
    if (!isOk(deleted)) {
      state = advance(state, ["purge_failed"]);
      return surface(state, `payload delete failed for ${rec.recordId}: ${deleted.error.code}`);
    }
    // (c) Audit-log the removal (routed, not branched-on — like the health sink).
    await deps.audit.record({
      recordId: rec.recordId,
      workspaceId: rec.workspaceId,
      ...(revisionId !== undefined ? { revisionId } : {}),
    });
    removedRecordIds.push(rec.recordId);
  }
  state = advance(state, ["removed"]);

  // 5. Advance the durable schedule bookkeeping + done.
  await deps.schedule.put(advanceBookkeeping(input.scheduleId, deps.clock));
  state = advance(state, ["done"]);
  return {
    state,
    run: runResult,
    runReused,
    collapsed,
    removedRecordIds,
    preservedCount: selection.skipped.length,
  };
}
