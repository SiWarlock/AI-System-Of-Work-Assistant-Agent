// Unit 2.5 — operational-truth invariants (§4 boundary + DATA_MODEL).
//
// PURE TypeScript — no Drizzle, no driver, no clock/random/I/O. These are the
// REUSABLE guard helpers + predicates + typed contract for the operational-store
// invariants. WIRING (as of the Phase-2 reconcile): both the SQLite and Postgres
// adapters IMPORT `decideApprovalCas` + `casVerdictToResult` and call them at
// their `applyTransition` write path, so the exactly-once approval CAS (Invariant
// 3) has ONE shared implementation across dialects. The append-only (Inv. 1),
// immutable/tombstone (Inv. 2), and rebuild-exclusion (Inv. 4) guards are upheld
// STRUCTURALLY at the adapter surface (no in-place mutator/delete is exposed on
// those repos) and are additionally available here for any caller that must
// gate a write explicitly. This unit owns the invariant TESTS
// (test/invariants/operational-truth.test.ts); the parameterized repository
// contract suite (test/contract) exercises the wired CAS through both adapters.
//
// Four load-bearing invariants (§4 boundary / §16 Backup & Recovery / DATA_MODEL
// "Operational Store Domains"):
//
//   1. APPEND-ONLY (event log) — only `append` writes; never update/delete of a
//      logged event. A delete/update attempt is a typed rejection.
//   2. IMMUTABLE / TOMBSTONE-ONLY (audit) — no in-place mutation; a correction is
//      a NEW tombstone record, never an edit. Hard-delete is rejected.
//   3. EXACTLY-ONCE (approval transitions) — atomic compare-and-set on
//      (id, expectedStatus). A stale CAS loses (no double-apply); replay of the
//      identical transition is an idempotent no-op (Mac+Telegram parity,
//      REQ-F-012, §9 "exactly once across channels").
//   4. REBUILDABLE vs NOT (read models vs operational truth) — read models are
//      rebuildable from operational truth + Markdown; the operational-truth set
//      (event log / audit / approvals / outboxes / connector cursors) is NOT
//      rebuildable and is EXCLUDED from any destructive rebuild.
//
// ERROR CONVENTION (§16): every guard returns a typed `Result<T, InvariantViolation>`
// and NEVER throws across the boundary. `invariantToDbErrorCode` maps a violation
// onto the adapter's enumerable `DbErrorCode` so the rejection re-emits cleanly.
import { err, ok, type Result } from "@sow/contracts";
import type { ApprovalStatus } from "@sow/contracts";
import type { DbErrorCode, LeaseRecordRow } from "../repositories/interfaces";

// --- operational-store domains + their durability class (§4 boundaries) ------

/** Every app-owned operational-store domain (matches the §4/DATA_MODEL list). */
export type OperationalDomain =
  | "event_log"
  | "audit"
  | "approvals"
  | "outboxes"
  | "connector_cursors"
  | "workflow_runs"
  | "provider_state"
  | "workspace_config"
  | "write_receipts"
  // Phase-10 durability tables (LIFE-1 / LIFE-5 / OBS-2) backing the Phase-7
  // in-memory fake ports (health_items / schedule_bookkeeping / instance_leases).
  | "health_items"
  | "schedule_bookkeeping"
  | "instance_leases"
  | "read_models"
  | "gcl_projections";

/**
 * Durability class drives rebuildability (§4 Backup & Recovery):
 *   - `operational_truth` — authoritative, NOT rebuildable (must be backed up).
 *   - `rebuildable`       — read models; droppable + reconstructable from truth.
 *   - `derived`           — re-derivable from a master (e.g. GCL projections); a
 *                            rebuild MAY recompute it, so it is rebuildable too.
 */
export type DurabilityClass = "operational_truth" | "rebuildable" | "derived";

/**
 * The five §4-named operational-truth domains — "event log / audit / approvals /
 * outboxes / connector cursors are operational truth and are not rebuildable".
 * Load-bearing: a destructive rebuild must EXCLUDE every member.
 */
export const OPERATIONAL_TRUTH_DOMAINS = [
  "event_log",
  "audit",
  "approvals",
  "outboxes",
  "connector_cursors",
] as const satisfies readonly OperationalDomain[];

/**
 * Per-domain durability. The §4 five are operational truth; read models are
 * rebuildable; GCL projections are derived (re-derivable). Workflow runs,
 * provider state, workspace config, and write_receipts are operational state that
 * is likewise NOT a read-model and therefore NOT a rebuild target — classified as
 * operational_truth so a rebuild never drops them (matches the repository
 * interface classification, §4). write_receipts holds the external-write
 * exactly-once proofs (WW-1 / §8 / safety rule 3): losing it would let a rebuilt
 * worker re-issue an already-committed external write, so it is authoritative
 * truth that MUST survive a rebuild, never re-derivable.
 */
export const DOMAIN_DURABILITY: Record<OperationalDomain, DurabilityClass> = {
  event_log: "operational_truth",
  audit: "operational_truth",
  approvals: "operational_truth",
  outboxes: "operational_truth",
  connector_cursors: "operational_truth",
  workflow_runs: "operational_truth",
  provider_state: "operational_truth",
  workspace_config: "operational_truth",
  write_receipts: "operational_truth",
  // Phase-10 durability tables — authoritative operational state, NOT read models:
  //   - health_items: the System-Health dedupe/lifecycle records (OBS-1/OBS-2); a
  //     lost item drops an open failure's audit-linked history.
  //   - schedule_bookkeeping: LIFE-5 last-run wall+monotonic readings; a lost row
  //     re-fires or starves a schedule (the clock-jump-safe catch-up loses its base).
  //   - instance_leases: LIFE-1 single-active-instance lease + fencing token; a lost
  //     lease lets two workers process concurrently (the exactly-once spine breaks).
  // None is re-derivable from Markdown/truth, so all are excluded from a rebuild.
  health_items: "operational_truth",
  schedule_bookkeeping: "operational_truth",
  instance_leases: "operational_truth",
  read_models: "rebuildable",
  gcl_projections: "derived",
};

/** Durability class of a domain. */
export function durabilityOf(domain: OperationalDomain): DurabilityClass {
  return DOMAIN_DURABILITY[domain];
}

/** True when a domain can be dropped + rebuilt (read models + derived stores). */
export function isRebuildable(domain: OperationalDomain): boolean {
  const d = durabilityOf(domain);
  return d === "rebuildable" || d === "derived";
}

/** True when a domain is authoritative operational truth (NOT rebuildable). */
export function isOperationalTruth(domain: OperationalDomain): boolean {
  return durabilityOf(domain) === "operational_truth";
}

// --- typed invariant-violation surface ---------------------------------------

/** Closed, enumerable invariant-violation taxonomy (the adapters re-emit these). */
export type InvariantCode =
  | "append_only_violation" // attempted update/delete on an append-only domain
  | "immutable_violation" // attempted in-place edit/hard-delete of an immutable domain
  | "rebuild_truth_excluded" // attempted destructive rebuild of operational truth
  | "stale_transition"; // CAS lost the race / targeted a tombstoned record

/** A typed invariant rejection (never thrown — returned in an `Err`). */
export interface InvariantViolation {
  readonly code: InvariantCode;
  readonly message: string;
  /** The operational domain whose invariant was violated. */
  readonly domain: OperationalDomain;
}

/**
 * Map an invariant violation onto the adapter's `DbErrorCode` (§16). Structural
 * violations are constraint violations; a lost compare-and-set is a conflict
 * (PK/optimistic-concurrency mismatch family) so a replay is an idempotent no-op.
 */
export function invariantToDbErrorCode(code: InvariantCode): DbErrorCode {
  switch (code) {
    case "append_only_violation":
    case "immutable_violation":
    case "rebuild_truth_excluded":
      return "constraint_violation";
    case "stale_transition":
      return "conflict";
  }
}

// --- Invariant 1: APPEND-ONLY event log --------------------------------------

/** A write a caller attempts against the append-only event log. */
export type AppendOnlyOp = "append" | "update" | "delete";

/**
 * Guard the event log's append-only discipline: only `append` is permitted; any
 * `update`/`delete` of a logged event is a typed rejection (§4 / DATA_MODEL —
 * "append-only where practical", treated as a hard invariant here).
 */
export function assertAppendOnly(op: AppendOnlyOp): Result<void, InvariantViolation> {
  if (op === "append") return ok(undefined);
  return err({
    code: "append_only_violation",
    domain: "event_log",
    message: `event log is append-only; '${op}' of a logged event is forbidden (§4)`,
  });
}

// --- Invariant 2: IMMUTABLE / TOMBSTONE-ONLY audit ---------------------------

/**
 * A write a caller attempts against the audit trail. `append` adds a record;
 * `tombstone` appends a NEW tombstone/correction record (the only sanctioned way
 * to "correct" history); `update`/`delete` are in-place mutations and forbidden.
 */
export type AuditWriteOp = "append" | "tombstone" | "update" | "delete";

/**
 * Guard the audit trail's immutable/tombstone-only discipline (§4 / §16): a
 * record is never edited or hard-deleted in place; a correction is expressed as a
 * NEW tombstone record. `append` and `tombstone` are inserts and allowed;
 * `update` and `delete` are rejected.
 */
export function assertAuditWrite(op: AuditWriteOp): Result<void, InvariantViolation> {
  if (op === "append" || op === "tombstone") return ok(undefined);
  return err({
    code: "immutable_violation",
    domain: "audit",
    message: `audit is immutable/tombstone-only; '${op}' is forbidden — corrections are new tombstone records (§16)`,
  });
}

// --- Invariant 3: EXACTLY-ONCE approval compare-and-set ----------------------

/** Terminal approval statuses — the TOMBSTONE set; no transition leaves them. */
export const TERMINAL_APPROVAL_STATUSES = [
  "approved",
  "edited",
  "rejected",
  "expired",
] as const satisfies readonly ApprovalStatus[];

/** True when a status is terminal (a tombstone; exactly-once already resolved). */
export function isTerminalApprovalStatus(status: ApprovalStatus): boolean {
  return (TERMINAL_APPROVAL_STATUSES as readonly ApprovalStatus[]).includes(status);
}

/**
 * The verdict of an atomic compare-and-set on an approval (id, expectedStatus):
 *   - `apply`           — current === expectedFrom: this caller WINS, perform the write.
 *   - `idempotent_noop` — the desired end-state already holds (replay, or a
 *                          concurrent contender for the SAME target): do NOT apply
 *                          again; return the already-applied record.
 *   - `stale_conflict`  — the record moved to a different state (lost the race) or
 *                          is already tombstoned: a typed no-op, never a 2nd apply.
 */
export type CasVerdict =
  | { readonly kind: "apply" }
  | { readonly kind: "idempotent_noop" }
  | { readonly kind: "stale_conflict" };

/**
 * Decide an approval compare-and-set from the three observed statuses. PURE — the
 * adapter performs the atomic conditional write (e.g. `UPDATE … WHERE id=? AND
 * status=expectedFrom`) and uses this to interpret the outcome the same way on
 * both dialects. Transition LEGALITY (which status may follow which) is the §9
 * domain state machine's job, not this primitive's — this only enforces the
 * exactly-once / no-double-apply / no-resurrect-a-tombstone CAS semantics.
 */
export function decideApprovalCas(
  current: ApprovalStatus,
  expectedFrom: ApprovalStatus,
  next: ApprovalStatus,
): CasVerdict {
  // Replay / same-target contender: the end-state already holds → no 2nd apply.
  if (current === next) return { kind: "idempotent_noop" };
  // Cannot transition OUT of a tombstoned/terminal approval (exactly-once landed).
  if (isTerminalApprovalStatus(current)) return { kind: "stale_conflict" };
  // The compare half of compare-and-set: only the matching expectation wins.
  if (current === expectedFrom) return { kind: "apply" };
  // The record advanced to some other non-terminal state — this CAS lost.
  return { kind: "stale_conflict" };
}

/**
 * Map a CAS verdict onto a typed `Result` the adapter returns:
 *   - `apply`           → ok(applied)  (the record after the transition)
 *   - `idempotent_noop` → ok(current)  (the already-applied record; replay-safe)
 *   - `stale_conflict`  → err(stale_transition) (the loser; never a 2nd apply)
 */
export function casVerdictToResult<T>(
  verdict: CasVerdict,
  applied: T,
  current: T,
): Result<T, InvariantViolation> {
  switch (verdict.kind) {
    case "apply":
      return ok(applied);
    case "idempotent_noop":
      return ok(current);
    case "stale_conflict":
      return err({
        code: "stale_transition",
        domain: "approvals",
        message:
          "approval transition lost the compare-and-set (stale expectedStatus or tombstoned record); no second apply (REQ-F-012, §9)",
      });
  }
}

/**
 * The value of a resolved CAS `ok` outcome, carrying the apply-vs-noop `kind` the
 * caller needs for exactly-once. This SURFACES the distinction `casVerdictToResult`
 * collapses (both `apply` and `idempotent_noop` return `ok`) so the caller learns
 * whether IT caused the durable transition.
 */
export interface CasOutcome<T> {
  /** The record after the CAS resolved (next on apply; current on a no-op). */
  readonly value: T;
  /** True IFF this CAS caused a genuine durable transition (`apply`). */
  readonly applied: boolean;
}

/**
 * Map a CAS verdict onto a typed `Result<CasOutcome<T>, InvariantViolation>` that
 * THREADS the apply-vs-noop kind (closing the exactly-once TOCTOU — REQ-F-012, §9):
 *   - `apply`           → ok({ value: applied, applied: true })  (genuine transition)
 *   - `idempotent_noop` → ok({ value: current, applied: false }) (replay / same-target
 *                          contender — did NOT cause the transition; NO durable write)
 *   - `stale_conflict`  → err(stale_transition) (the loser; never a 2nd apply)
 * Both `ok` outcomes keep replay idempotent (no error); only `applied` differs.
 */
export function casVerdictToOutcome<T>(
  verdict: CasVerdict,
  applied: T,
  current: T,
): Result<CasOutcome<T>, InvariantViolation> {
  switch (verdict.kind) {
    case "apply":
      return ok({ value: applied, applied: true });
    case "idempotent_noop":
      return ok({ value: current, applied: false });
    case "stale_conflict":
      return err({
        code: "stale_transition",
        domain: "approvals",
        message:
          "approval transition lost the compare-and-set (stale expectedStatus or tombstoned record); no second apply (REQ-F-012, §9)",
      });
  }
}

// --- Invariant 4: read models REBUILDABLE, operational truth is NOT ----------

/**
 * Guard a destructive rebuild target: a rebuild routine may reconstruct a
 * rebuildable domain (read models, derived projections) but must NEVER drop /
 * rebuild operational truth — that set is recoverable only via the §16 backup,
 * not by re-derivation. An operational-truth target is a typed rejection.
 */
export function assertRebuildTarget(domain: OperationalDomain): Result<void, InvariantViolation> {
  if (isRebuildable(domain)) return ok(undefined);
  return err({
    code: "rebuild_truth_excluded",
    domain,
    message: `'${domain}' is operational truth and is NOT rebuildable; it is excluded from any destructive rebuild and recovered only from backup (§4 / §16)`,
  });
}

// --- WW-1: write-receipt RESERVE classification (§8 / safety rule 3) ---------

/**
 * The three KINDS a write-receipt `reserve` resolves to — the closed cross-process
 * no-duplicate-external-write verdict (WW-1, §8 / safety rule 3). Mirrors the
 * `ReserveOutcome` union in `repositories/interfaces.ts` at the KIND level (the
 * adapter attaches the committed `record`); kept here so BOTH the sqlite and
 * postgres adapters classify the SAME atomic-INSERT outcome IDENTICALLY (the §4
 * "adapter divergence → release blocked" bar).
 */
export type ReserveKind = "reserved" | "in_progress" | "committed";

/**
 * Decide a write-receipt reserve from the two observed facts of the atomic
 * UNIQUE-key INSERT on the object identity (targetSystem, canonicalObjectKey). PURE
 * — the adapter performs the `INSERT … ON CONFLICT DO NOTHING` (whose empty
 * `.returning()` == the row already existed, the SAME lost-race idiom as
 * `applyTransition`), re-reads the pre-existing row, and calls this to interpret the
 * outcome the same way on both dialects:
 *   - `inserted: true`               → `reserved`   (this caller won; it may create).
 *   - existing row WITH a receipt     → `committed`  (already written; reuse it).
 *   - existing row WITHOUT a receipt  → `in_progress` (another worker mid-write; do
 *                                                       NOT create — hold/retry).
 * Two concurrent reserves for the same object can NEVER both be `reserved`: exactly
 * one INSERT lands (`inserted: true`); the other sees the row and is classified
 * in_progress/committed.
 */
export function decideReserve(input: {
  readonly inserted: boolean;
  readonly existingReceiptPresent: boolean;
}): ReserveKind {
  if (input.inserted) return "reserved";
  return input.existingReceiptPresent ? "committed" : "in_progress";
}

// --- LIFE-1: single-active-instance lease compare-and-set (§9 durability) -----

/**
 * Full structural equality over EVERY fenced field of a lease record — the
 * "compare" half of the lease compare-and-set. A renew/re-acquire only wins when
 * the stored row matches the caller's expectation EXACTLY (owner + timestamps +
 * fencing generation), so a stale holder whose `generation` moved on cannot renew
 * a lease a newer holder already took. `undefined` expresses the EMPTY slot (a
 * first-acquire expectation): two empties are vacuously equal; an empty never
 * equals a concrete row (and vice versa).
 */
export function leaseRecordsEqual(
  a: LeaseRecordRow | undefined,
  b: LeaseRecordRow | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b; // both undefined ⇒ equal
  return (
    a.taskQueue === b.taskQueue &&
    a.ownerId === b.ownerId &&
    a.acquiredAt === b.acquiredAt &&
    a.expiresAt === b.expiresAt &&
    a.generation === b.generation
  );
}

/**
 * The two observed facts of a lease compare-and-set: the caller's `expected`
 * pre-image (`undefined` = it expects an EMPTY slot / first acquire) and the
 * `stored` row currently in the table (`undefined` = the slot is empty).
 */
export interface LeaseCasFacts {
  readonly expected: LeaseRecordRow | undefined;
  readonly stored: LeaseRecordRow | undefined;
}

/**
 * Decide a single-active-instance lease compare-and-set (LIFE-1). PURE — the
 * adapter performs the ATOMIC conditional write (an `INSERT … ON CONFLICT DO
 * NOTHING` for the first-acquire case, or an `UPDATE … WHERE <all expected fields
 * match>` for a renew/re-acquire) and calls this to interpret the outcome the SAME
 * way on both dialects. The CAS WINS (`true`) IFF the currently-stored record
 * equals the caller's expectation (an empty expectation against an empty slot, or
 * an exact pre-image match); any divergence — a slot already taken, a lease moved
 * to a newer owner/generation, or a reclaimed slot — LOSES (`false`). Contention
 * is a boolean verdict, NEVER a throw (§16 fail-closed) — the loser retries.
 */
export function decideLeaseCas(facts: LeaseCasFacts): boolean {
  return leaseRecordsEqual(facts.expected, facts.stored);
}
