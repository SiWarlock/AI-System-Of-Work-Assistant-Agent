// Operational-store repository interface CONTRACTS (Unit 1.14, §4 / REQ-D-002).
//
// PURE TypeScript: this file imports NO drizzle (no driver), ONLY type-level
// contracts from `@sow/contracts`. That keeps the §2.5 import direction intact —
// `packages/domain` can depend on these interfaces without pulling a database
// driver (REQ-D-002: domain depends on repository interfaces, never a concrete
// adapter). The SQLite + Postgres implementations and the both-dialect
// repository CONTRACT SUITE live in §4 / Phase-2 / worker (REQ-D-003) — OUT OF
// SCOPE here.
//
// ERROR CONVENTION (§16): every method returns a typed `Result<T, DbError>` and
// NEVER throws across the boundary; `DbError.code` is an enumerable closed set.
// Methods are async (`Promise<...>`) because the implementations perform I/O —
// the PURITY rule (no clock/random/I/O) governs `packages/domain` builders, not
// these I/O-describing interfaces.
//
// CLASSIFICATION (§4 boundaries) is stated per repository:
//   - OPERATIONAL TRUTH (not rebuildable): event log, audit, approvals, outbox,
//     connector cursors, workflow-run registry, provider state, workspace config.
//   - REBUILDABLE: read models (droppable + rebuildable from operational truth +
//     Markdown).
//   - DERIVED: GCL projections (rebuildable from the GCL master + source facts).
// APPEND-ONLY / TOMBSTONE domains expose no in-place mutator beyond status
// transitions; that is encoded in the method set + the comments below.
import type {
  Approval,
  AuditRecord,
  GclProjection,
  HealthItem,
  ParityReport,
  ProjectLifecycleState,
  ProviderProfile,
  Result,
  WorkflowRunRef,
  Workspace,
  WorkspaceId,
  WriteReceipt,
} from "@sow/contracts";

// --- typed error surface (enumerable codes; never thrown) ---

/** Closed, enumerable failure taxonomy for every repository operation. */
export type DbErrorCode =
  | "not_found"
  | "conflict" // PK/unique violation OR optimistic-concurrency revision mismatch
  | "constraint_violation"
  | "serialization_failure" // transaction retry-able (§4)
  | "unavailable" // §4 DB-unavailable degraded mode
  | "unknown";

export interface DbError {
  readonly code: DbErrorCode;
  readonly message: string;
  /** Underlying driver cause, kept opaque so callers never depend on a driver. */
  readonly cause?: unknown;
}

/** Convenience alias — every repository method resolves to this shape. */
export type DbResult<T> = Promise<Result<T, DbError>>;

// --- operational DTOs for domains with no 1:1 frozen Appendix-A model ---
// (These are operational records, deliberately NOT frozen seam contracts.)

/** Append-only control-plane event-journal record (§4/§16). */
export interface EventLogRecord {
  readonly eventId: string;
  readonly eventName: string;
  readonly workspaceId?: string;
  readonly correlationId?: string;
  readonly workflowId?: string;
  /** SUMMARY/metadata only — never raw content (§16). */
  readonly payload?: unknown;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

/** External-write outbox entry (§8/§9): a ProposedAction + envelope + receipt. */
export interface OutboxEntry {
  readonly outboxId: string;
  readonly actionRef: string;
  readonly workspaceId: string;
  readonly targetSystem: string;
  readonly canonicalObjectKey: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  /** §9 Proposed-External-Action machine state. */
  readonly status: string;
  /** To-dispatch payload (no secrets — Keychain refs resolved at dispatch). */
  readonly payload?: unknown;
  /** WriteReceipt once committed (exactly-once proof, §8). */
  readonly writeReceipt?: unknown;
  readonly attempts: number;
  readonly enqueuedAt: string;
  readonly nextAttemptAt?: string;
  readonly updatedAt: string;
}

/** Per-connector × per-workspace sync cursor (§8 Connector Gateway). */
export interface ConnectorCursorRecord {
  readonly connectorId: string;
  readonly workspaceId: string;
  readonly cursor?: string;
  readonly status: string;
  readonly lastSyncAt?: string;
  readonly nextSyncAt?: string;
  readonly updatedAt: string;
}

/** Rebuildable dashboard/UI read-model record (§4/§16). */
export interface ReadModelRecord {
  readonly readModelKey: string;
  readonly workspaceId?: string;
  /** SUMMARY/metadata only. */
  readonly data: unknown;
  readonly rebuiltAt: string;
}

// --- Phase-10 durability DTOs (LIFE-1 / LIFE-5 / OBS-2) ---
// The concrete persistence rows behind the Phase-7 @sow/workflows in-memory fake
// ports (HealthItemStore / ScheduleStore / InstanceLeaseStore). These DTOs live in
// @sow/db (NOT imported from @sow/workflows — that would invert the package
// dependency direction) and are STRUCTURALLY compatible with the port DTOs so the
// worker layer adapts a @sow/db repo onto each port (mirrors how the write-receipt
// repo is adapted onto the integrations `ReceiptStore`).

/**
 * Durable per-schedule bookkeeping (LIFE-5) — the last run's wall-clock reading
 * plus its OPTIONAL clock-jump-safe monotonic reading + epoch. Catch-up compares
 * the monotonic delta only when the epoch matches (a prior-boot reading is
 * ignored); the wall reading is the display/first-run fallback. Structurally the
 * @sow/workflows `ScheduleBookkeeping` port DTO.
 */
export interface ScheduleBookkeepingRecord {
  readonly scheduleId: string;
  readonly lastRunWall: string;
  readonly lastRunMonotonicMs?: number;
  readonly lastRunMonotonicEpoch?: string;
}

/**
 * A single-active-instance lease row (LIFE-1). One row per Temporal task queue;
 * `ownerId` is the worker instance currently holding it; `expiresAt` is the ISO
 * fence past which the lease is stale + reclaimable; `generation` is the
 * monotonically-increasing FENCING TOKEN (bumped on a fresh acquire, preserved on
 * a same-owner renew) that closes the sleep-paused-prior-holder window TTL alone
 * cannot. Structurally the @sow/workflows `LeaseRecord` port DTO.
 */
export interface LeaseRecordRow {
  readonly taskQueue: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly generation: number;
}

/**
 * One persisted external-write RECEIPT INDEX row (WW-1, §8 / safety rule 3).
 * Indexed by the OBJECT IDENTITY (targetSystem + canonicalObjectKey — the reserve's
 * unique key) AND the GLOBALLY-UNIQUE §8 replay key (idempotencyKey). `receipt` is
 * the vendor proof-of-write, ABSENT until the write commits (a row with no receipt
 * is a live RESERVATION — another worker mid-write). `targetSystem` is an OPEN
 * string at this boundary (the enum lives in @sow/contracts; the worker adapter
 * maps it), matching the outbox row's `targetSystem` convention.
 */
export interface WriteReceiptRow {
  readonly targetSystem: string;
  readonly canonicalObjectKey: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  /** The vendor WriteReceipt proof — ABSENT while reserved, present once committed. */
  readonly receipt?: WriteReceipt;
  readonly recordedAt: string;
}

/**
 * The outcome of an atomic `reserve` on the write-receipt index (WW-1, §8 / safety
 * rule 3). A CLOSED union that classes what the caller MUST do — this is the
 * cross-process no-duplicate-external-write gate:
 *   - `reserved`    — THIS caller INSERTed the placeholder: it is the WINNER and is
 *                     the ONLY caller permitted to issue the external create.
 *   - `in_progress` — a row exists but has NO receipt yet: another worker is
 *                     mid-write. The caller must NOT create (hold/retry).
 *   - `committed`   — a row exists WITH a receipt: the object was already written.
 *                     Reuse the receipt (`record`) → ZERO duplicate external write.
 */
export type ReserveOutcome =
  | { readonly kind: "reserved" }
  | { readonly kind: "in_progress" }
  | { readonly kind: "committed"; readonly record: WriteReceiptRow };

// --- repository contracts (one per operational-store domain) ---

/**
 * Workspace config — OPERATIONAL TRUTH, MUTABLE (not append-only, not
 * rebuildable). The owner edits governance posture; `upsert` persists the whole
 * validated aggregate.
 */
export interface WorkspaceConfigRepository {
  get(id: Workspace["id"]): DbResult<Workspace>;
  list(): DbResult<Workspace[]>;
  upsert(workspace: Workspace): DbResult<Workspace>;
}

/**
 * One external progress-provider mapping stored on a project-registry row. Mirrors
 * the `@sow/workflows` `ProgressProvider` STRUCTURALLY (a plain {connectorId,
 * remoteHandle} pair) — `@sow/db` must NOT import `@sow/workflows` (dep direction is
 * workflows → db), so the shape is re-declared here as a db-owned operational field.
 */
export interface ProjectRegistryProvider {
  readonly connectorId: string;
  readonly remoteHandle: string;
}

/**
 * The durable typed-Project REGISTRY row (task 14.6, §4/§6) — OPERATIONAL resolution
 * truth, MUTABLE. This is the persisted mirror of the `@sow/workflows`
 * `ProjectRegistryEntry` port type; the worker's production `ResolveRegistryPort` maps
 * this Row ↔ that Entry at the worker boundary (Q1: no contract promotion; db can't
 * import the workflow-port type). It is a RESOLUTION INDEX — NEVER a second Project
 * writer: the canonical Project (Markdown frontmatter) stays KnowledgeWriter-owned
 * (safety rule 1). `progressProviders`/`aliases` persist as one json column each.
 */
export interface ProjectRegistryRow {
  /** Stable project id — the registry PRIMARY KEY (globally unique). */
  readonly projectId: string;
  /** The BOUND workspace (WS-2) — the durable write target; server-resolved, never caller-set. */
  readonly workspaceId: WorkspaceId;
  /** The canonical status-doc (IMPLEMENTATION_PLAN) path the deterministic parser reads (optional). */
  readonly planPath?: string;
  /** External PM progress providers (deterministic status sources) — json column; empty ⇒ plan-only. */
  readonly progressProviders: readonly ProjectRegistryProvider[];
  /** Aliases the registry maps to this project (cross-referencing) — json column (optional). */
  readonly aliases?: readonly string[];
  /** Display title (seeds note frontmatter / dashboard). */
  readonly title: string;
  /** Canonical note slug (display/frontmatter only — the note PATH is derived from workspaceId, WS-8). */
  readonly slug: string;
  /** Current lifecycle state (§13.5 seed). */
  readonly lifecycleState: ProjectLifecycleState;
}

/**
 * Durable typed-Project registry — OPERATIONAL resolution truth, MUTABLE (14.6, §4/§6).
 * `resolveRef` is GLOBAL by design: the projectSync `ResolveRegistryPort.resolve(ctx)`
 * carries only a `projectRef` (no workspaceId — WS-8 anti-smuggle), so a ref resolves
 * by projectId OR alias across the store; the WS-8 control is the worker port's
 * membership gate on the RESOLVED row's workspaceId (never a caller field), plus
 * ambiguous-alias ⇒ `not_found` (fail-closed). `listByWorkspace` is a workspace-scoped
 * primitive — FUTURE callers (15.8/18.6) MUST pass a workspaceId the caller is
 * authorized for; it must never become a cross-workspace enumeration path.
 */
export interface ProjectRegistryRepository {
  /** Create or overwrite a registry row (keyed by projectId). */
  upsert(entry: ProjectRegistryRow): DbResult<ProjectRegistryRow>;
  /** Fetch a row by its projectId primary key; absent ⇒ typed `not_found`. */
  get(projectId: string): DbResult<ProjectRegistryRow>;
  /**
   * Resolve a GLOBAL ref (a projectId OR an alias) to its single row. An exact projectId
   * (PRIMARY KEY) match takes PRECEDENCE — a project is ALWAYS resolvable by its own key,
   * never shadowed by another project's colliding alias. Only if no projectId matches is
   * the ref resolved by alias: no match ⇒ typed `not_found`; an alias matching >1 row
   * (across workspaces) ⇒ `not_found` (fail-closed — never an arbitrary cross-workspace
   * pick, safety rule 4).
   */
  resolveRef(ref: string): DbResult<ProjectRegistryRow>;
  /** List all rows for a workspace (workspace-scoped; see the interface note on WS-8). */
  listByWorkspace(workspaceId: WorkspaceId): DbResult<ProjectRegistryRow[]>;
}

/** Operator enable/pause state of a connector instance (a config toggle — not a live-run signal). */
export type ConnectorInstanceState = "enabled" | "paused";

/**
 * The durable per-workspace CONNECTOR-INSTANCE config record (task 14.2, §4/§8) —
 * OPERATIONAL config, MUTABLE. It is what the Phase-16 connector composition + Phase-23
 * per-vendor arming later CONSUME; it is CONFIG ONLY — NO live vendor call, and it holds an
 * opaque `tokenRef` REFERENCE (a Keychain key id), NEVER credential/token bytes (safety
 * rule 7 — SecretsPort/Keychain resolve the reference at arming, never this record).
 * `instanceId` is a synthetic PK (a workspace may have >1 instance of the same vendor).
 */
export interface ConnectorInstanceRow {
  /** Synthetic connector-instance id — the registry PRIMARY KEY. */
  readonly instanceId: string;
  /** The connector/vendor id (e.g. "google-drive", "linear"). */
  readonly connectorId: string;
  /** The BOUND workspace (WS-2/WS-8 anchor) — server-resolved, never caller-set; IMMUTABLE. */
  readonly workspaceId: WorkspaceId;
  /** Opaque Keychain REFERENCE to the credential — NEVER the secret bytes (rule 7). */
  readonly tokenRef: string;
  /** Operator enable/pause toggle (config only). */
  readonly state: ConnectorInstanceState;
  /** Opaque cadence expression (cron/interval) — consumed by the Phase-25 scheduler. */
  readonly cadence: string;
}

/**
 * Durable per-workspace connector-instance config registry — OPERATIONAL config, MUTABLE
 * (14.2, §4/§8). `listByWorkspace` is a workspace-scoped primitive — FUTURE callers (the
 * Phase-16 connector composition) MUST pass a workspaceId the caller is authorized for; it
 * must never become a cross-workspace enumeration path.
 */
export interface ConnectorInstanceRepository {
  /**
   * Create or overwrite an instance record (keyed by instanceId). NOTE: the workspace-binding
   * IMMUTABILITY invariant (an existing instanceId's workspaceId never changes) is enforced at
   * the COMPOSITION layer (`registerConnectorInstance`'s get-before-upsert guard), NOT
   * structurally here — a direct caller (a future Phase-16 consumer) MUST preserve an existing
   * row's workspaceId (never rebind it across the isolation boundary, WS-8).
   */
  upsert(row: ConnectorInstanceRow): DbResult<ConnectorInstanceRow>;
  /** Fetch a record by its instanceId primary key; absent ⇒ typed `not_found`. */
  get(instanceId: string): DbResult<ConnectorInstanceRow>;
  /** List all instance records for a workspace (workspace-scoped; see the note above). */
  listByWorkspace(workspaceId: WorkspaceId): DbResult<ConnectorInstanceRow[]>;
  /** Set the enable/pause state of an existing instance; absent ⇒ typed `not_found`. */
  setState(instanceId: string, state: ConnectorInstanceState): DbResult<ConnectorInstanceRow>;
  /** Set the cadence of an existing instance; absent ⇒ typed `not_found`. */
  setCadence(instanceId: string, cadence: string): DbResult<ConnectorInstanceRow>;
}

/**
 * Event log — OPERATIONAL TRUTH, APPEND-ONLY. No update/delete in place; reads
 * are forward scans. Records are never mutated after `append`.
 */
export interface EventLogRepository {
  append(record: EventLogRecord): DbResult<void>;
  /** Forward scan after `afterEventId` (null = from the start), capped by `limit`. */
  readSince(afterEventId: string | null, limit: number): DbResult<EventLogRecord[]>;
  byWorkflow(workflowId: WorkflowRunRef["workflowId"]): DbResult<EventLogRecord[]>;
}

/**
 * Workflow-run registry — OPERATIONAL TRUTH (idempotent replay reuses the run,
 * §9). MUTABLE `state`; `auditRefs` grow append-only. Co-located with the event
 * log domain (no dedicated Unit-1.14 file) — see schema/event-log.ts.
 */
export interface WorkflowRunRefRepository {
  create(ref: WorkflowRunRef): DbResult<WorkflowRunRef>;
  get(workflowId: WorkflowRunRef["workflowId"]): DbResult<WorkflowRunRef>;
  /** Idempotency lookup — drives replay reuse (returns not_found when novel). */
  getByIdempotencyKey(idempotencyKey: WorkflowRunRef["idempotencyKey"]): DbResult<WorkflowRunRef>;
  updateState(workflowId: WorkflowRunRef["workflowId"], state: WorkflowRunRef["state"]): DbResult<WorkflowRunRef>;
  appendAuditRef(workflowId: WorkflowRunRef["workflowId"], auditRef: WorkflowRunRef["auditRefs"][number]): DbResult<WorkflowRunRef>;
}

/**
 * Audit trail — OPERATIONAL TRUTH, APPEND-ONLY. `append` is the only writer;
 * corrections are new records, never in-place edits. Records carry SUMMARIES +
 * a payload hash, never raw content (§16) — see schema/audit.ts.
 */
export interface AuditRepository {
  append(record: AuditRecord): DbResult<void>;
  /** Filtered forward query (e.g. by actor/event/ref), capped by `limit`. */
  query(filter: AuditQuery, limit: number): DbResult<AuditRecord[]>;
}

/** Narrow audit query — every field optional (AND-combined). */
export interface AuditQuery {
  readonly actor?: string;
  readonly event?: string;
  /** Match records whose `refs` include this opaque ref. */
  readonly ref?: string;
  /**
   * Match records attributed to this workspace (the §9.5 recent-changes projector's scope filter).
   * NOTE: this matches on the STORED workspaceId equality — a record with a NULL workspaceId (a global
   * control-plane event) is NOT returned by a workspace-scoped query, which is the intended WS-8 posture.
   */
  readonly workspaceId?: string;
}

/**
 * The outcome of an EXACTLY-ONCE approval compare-and-set. `approval` is the
 * record AFTER the operation resolved. `applied` distinguishes the two `ok`
 * outcomes the CAS produces and is LOAD-BEARING for exactly-once callers:
 *   - `applied: true`  — THIS call caused a genuine durable transition
 *                        (current === expectedFrom → the record moved to `next`).
 *   - `applied: false` — an idempotent no-op: the desired end-state ALREADY held
 *                        (a Temporal replay OR a concurrent second-channel CAS that
 *                        did NOT cause the transition). `approval` is the current
 *                        already-applied record; NO durable write happened.
 * Only the genuine transitioner (`applied: true`) may drive a downstream side
 * effect (dispatch) — a no-op contender must NOT (REQ-F-012, §9 exactly-once).
 */
export interface ApprovalTransitionOutcome {
  readonly approval: Approval;
  readonly applied: boolean;
}

/**
 * Approvals inbox — OPERATIONAL TRUTH. Append-on-create, then MUTABLE status via
 * EXACTLY-ONCE transitions (REQ-F-012); a terminal status (approved|edited|
 * rejected|expired) is the TOMBSTONE — there is no hard delete.
 */
export interface ApprovalRepository {
  create(approval: Approval): DbResult<Approval>;
  get(id: Approval["id"]): DbResult<Approval>;
  listByStatus(status: Approval["status"]): DbResult<Approval[]>;
  /**
   * List approvals in `status` for ONE workspace (WS-4 inbox scoping). An EQUALITY
   * filter on `workspaceId` — the §9.8 inbox path (`readModel.pendingApprovals`)
   * routes through this so a workspace inbox surfaces ONLY its own cards. Legacy
   * sentinel-workspace rows never match a real workspace id (fail-closed excluded).
   */
  listByStatusAndWorkspace(
    status: Approval["status"],
    workspaceId: Approval["workspaceId"],
  ): DbResult<Approval[]>;
  /**
   * Apply a single approval transition EXACTLY ONCE. `expectedFromStatus` makes
   * the write a compare-and-set. The `ok` outcome carries `applied`:
   *   - a genuine durable transition (current === expectedFrom) → `applied: true`
   *     with the NEXT record;
   *   - an idempotent no-op (the record already sits in the target — a replay OR a
   *     concurrent same-target contender) → `applied: false` with the CURRENT
   *     record and NO durable write;
   *   - a stale/lost CAS (the record moved to a DIFFERENT non-target state, or is a
   *     different tombstone) → a typed `conflict`;
   *   - an absent record → `not_found`.
   * Surfacing `applied` closes the exactly-once TOCTOU: the caller learns whether
   * IT caused the transition (and may dispatch) vs merely observed it already done.
   */
  applyTransition(
    id: Approval["id"],
    expectedFromStatus: Approval["status"],
    next: Approval,
  ): DbResult<ApprovalTransitionOutcome>;
}

/**
 * External-write outbox — OPERATIONAL TRUTH. Append-on-enqueue; status advances
 * through the §9 machine; a terminal status (receipt_recorded|rejected|expired)
 * is the TOMBSTONE. Replay reuses a recorded receipt → zero duplicate external
 * writes (§8).
 */
export interface OutboxRepository {
  enqueue(entry: OutboxEntry): DbResult<OutboxEntry>;
  get(outboxId: string): DbResult<OutboxEntry>;
  /** Idempotency lookup — the §8 replay gate (returns not_found when novel). */
  getByIdempotencyKey(idempotencyKey: string): DbResult<OutboxEntry>;
  /** Entries awaiting dispatch/retry whose nextAttemptAt has elapsed. */
  listDue(now: string, limit: number): DbResult<OutboxEntry[]>;
  /** Advance an entry's status / receipt / backoff bookkeeping (no hard delete). */
  update(entry: OutboxEntry): DbResult<OutboxEntry>;
}

/**
 * A §6 KnowledgeMutationPlan recorded PENDING owner approval — the SEMANTIC-write
 * sibling of the external-write {@link OutboxEntry} (§13.10a). The Copilot KMP-propose
 * sink (Slice E) records the derived, validated plan keyed by its `planId`; the pending
 * {@link Approval} carries `subjectKind: "semantic_mutation"` + `planRef === planId`
 * pointing here; on approval the executor (Slice F) re-fetches by `planId` and commits
 * the plan through KnowledgeWriter (safety rule 1 — never a direct write).
 */
export interface PendingKnowledgeMutation {
  readonly planId: string;
  /** WS-8 scope — the plan's server-bound workspace (matches the Approval + the KMP). */
  readonly workspaceId: string;
  /**
   * The serialized KnowledgeMutationPlan. CANDIDATE DATA on read-back: the executor
   * MUST re-validate it through `KnowledgeMutationPlanSchema` before `applyPlan` (a
   * stored blob is never trusted — REQ-S-006 / safety rule 2).
   */
  readonly plan: unknown;
  /**
   * Hash over the plan. MUST equal the pending `Approval.payloadHash` — the §13.10a
   * TOCTOU gate: the sink first-write-wins, and a same-`planId` record carrying a
   * DIVERGENT `payloadHash` is rejected (a swapped-plan attack is unrepresentable).
   */
  readonly payloadHash: string;
  /** Lifecycle: `pending` → `committed` | `rejected`. A terminal status is the tombstone. */
  readonly status: string;
  readonly recordedAt: string;
  /** The terminal-transition instant (set when the executor commits or rejects). */
  readonly settledAt?: string;
}

/**
 * Pending-KMP store — OPERATIONAL TRUTH (the semantic-write sibling of the Outbox, not
 * rebuildable — §4/§16). Append-on-record keyed by `planId`; status advances
 * `pending → committed | rejected`; a terminal status is the TOMBSTONE. The executor
 * re-fetches by `planId` on approval and is LIFE-3 resume-idempotent (a replay sees a
 * `committed` row and skips — no double KnowledgeWriter commit).
 */
export interface PendingKnowledgeMutationRepository {
  /** First-write-wins insert; a duplicate `planId` is a typed `conflict` (idempotency). */
  record(entry: PendingKnowledgeMutation): DbResult<PendingKnowledgeMutation>;
  get(planId: string): DbResult<PendingKnowledgeMutation>;
  /**
   * Advance ONLY `status` + `settledAt` (no hard delete). `plan`, `payloadHash`,
   * `workspaceId`, and `recordedAt` are IMMUTABLE post-record — the adapters do NOT
   * write them in the update set-clause, so a post-approval plan-swap is
   * unrepresentable on the update path too (§13.10a TOCTOU: the "swapped-plan is
   * unrepresentable" guarantee holds for BOTH record and update, structurally).
   */
  update(entry: PendingKnowledgeMutation): DbResult<PendingKnowledgeMutation>;
}

/**
 * A durable KnowledgeWriter commit record — the persisted shape of the knowledge-layer
 * `CommittedRevision` (packages/knowledge revision.ts). STRUCTURALLY IDENTICAL to it (the
 * worker-layer store adapter copies field-for-field so a divergence is a compile error); it
 * is redefined here because @sow/db MUST NOT import @sow/knowledge (the §2.5 import direction
 * is knowledge → db, never the reverse). `workflowRunRef` + `auditRecord` are @sow/contracts
 * seam types — persisted as one json column each; the AuditRecord carries SUMMARIES ONLY (§16).
 */
export interface CommittedRevisionRow {
  readonly revisionId: string;
  readonly baseRevisionId: string;
  /** The KnowledgeWriter idempotency key — the store identity (exactly-once PK). */
  readonly idempotencyKey: string;
  readonly planId: string;
  readonly actor: string;
  readonly sourceEventRef: string;
  readonly workflowRunRef: WorkflowRunRef;
  readonly auditRecord: AuditRecord;
  readonly committedAt: string;
}

/**
 * Knowledge-revision store — OPERATIONAL TRUTH (§4 / §6 / §16), the DURABLE substrate behind
 * the KnowledgeWriter's idempotent-replay short-circuit. Append-only, keyed by the writer's
 * `idempotencyKey`; NOT rebuildable (a lost row re-opens a duplicate commit). Replaces the
 * worker's in-memory `Map` stub — the persisted row survives a worker restart (the exactly-once
 * substrate), which the in-memory map cannot. The worker-layer adapter maps this onto the
 * @sow/knowledge `KnowledgeRevisionStore` port at the composition root (fail-closed: a real
 * fault REJECTS — never a false "no prior commit" that would let the writer double-commit).
 */
export interface KnowledgeRevisionRepository {
  /**
   * Idempotency lookup by the KnowledgeWriter `idempotencyKey` (returns `not_found` when
   * unseen — the writer reads this BEFORE any write to short-circuit a replay).
   */
  getByIdempotencyKey(idempotencyKey: string): DbResult<CommittedRevisionRow>;
  /**
   * Persist a freshly committed revision — FIRST-WRITE-WINS, idempotent no-op on a duplicate
   * `idempotencyKey` (`ok(void)` either way; never two revisions for one key — the exactly-once
   * substrate). The writer already short-circuits via `getByIdempotencyKey`, so a same-key
   * `record` is a defensive backstop (a concurrent/replay writer that raced the short-circuit).
   */
  record(revision: CommittedRevisionRow): DbResult<void>;
}

/**
 * Parity-report store — OPERATIONAL TRUTH (§4 / §6 / §12 / §16), the durable SERVE-TIME source the
 * Knowledge-layer serving-gate coverage leg reads. Persists the revision-scoped {@link ParityReport}
 * the ParityReconciler emits each pass, keyed by `reportId` (the exactly-once PK). NOT rebuildable
 * (the model header: "not rebuildable — backed up, never reconstructed"). Append-on-record,
 * first-write-wins; a `ParityReport` is IMMUTABLE per `reportId`. The whole frozen report (incl. its
 * embedded `Divergence[]`) is stored as ONE json column — CANDIDATE DATA on read-back: the adapter
 * MUST re-gate it through `ParityReportSchema.parse`, so a corrupt/unparseable blob FAILS CLOSED
 * (a typed err, never a half-parsed report). The worker-layer adapter maps this onto a narrow
 * serve-time `ParityReportStore` read-port at the composition root (B2 binds it; DORMANT until then).
 */
export interface ParityReportRepository {
  /**
   * Persist a reconciliation report — FIRST-WRITE-WINS, idempotent no-op on a duplicate `reportId`
   * (`ok(void)` either way; never two rows for one report id — a `ParityReport` is immutable
   * operational truth, §16). `recordedAt` is store-side "latest"-ordering metadata (caller-supplied
   * via an injected clock; the timestamp-free `ParityReport` carries none). A genuine store fault
   * (unavailable / serialization_failure / unknown …) is a typed `err(DbError)` — NEVER masked as
   * `ok` (a silently-dropped report is a §16 nothing-fails-silently hole on the trust substrate).
   */
  record(report: ParityReport, recordedAt: string): DbResult<void>;
  /**
   * The MOST-RECENTLY-RECORDED report for `(workspaceId, reconciledAtRevision)`, or `ok(undefined)`
   * when none exists — a TRUE absence, distinguishable from a fault (`err(DbError)`, §16), so the
   * serve-time coverage reader degrades on a fault without treating it as "no report". Newest-wins
   * (by `recordedAt`): a re-reconcile at the same revision supersedes. A stored payload that fails
   * `ParityReportSchema.parse` is a fault (`err`), never a half-parsed report.
   */
  getLatestForRevision(
    workspaceId: string,
    reconciledAtRevision: string,
  ): DbResult<ParityReport | undefined>;
}

/**
 * Connector cursors — OPERATIONAL TRUTH (a lost cursor forces a full re-sync, so
 * it is not rebuildable). One cursor per (connectorId, workspaceId); `upsert`
 * advances it.
 */
export interface ConnectorCursorRepository {
  get(connectorId: string, workspaceId: string): DbResult<ConnectorCursorRecord>;
  upsert(record: ConnectorCursorRecord): DbResult<ConnectorCursorRecord>;
  listByConnector(connectorId: string): DbResult<ConnectorCursorRecord[]>;
}

/**
 * Provider state — OPERATIONAL STATE, MUTABLE (conformanceStatus updated by §12
 * runs). Keyed by (provider, endpoint, model). NO secret material (REQ-S-003) —
 * see schema/provider-state.ts.
 */
export interface ProviderStateRepository {
  get(
    provider: ProviderProfile["provider"],
    endpoint: ProviderProfile["endpoint"],
    model: ProviderProfile["model"],
  ): DbResult<ProviderProfile>;
  list(): DbResult<ProviderProfile[]>;
  upsert(profile: ProviderProfile): DbResult<ProviderProfile>;
  setConformanceStatus(
    provider: ProviderProfile["provider"],
    endpoint: ProviderProfile["endpoint"],
    model: ProviderProfile["model"],
    conformanceStatus: ProviderProfile["conformanceStatus"],
  ): DbResult<ProviderProfile>;
}

/**
 * Read models — REBUILDABLE (§4/§16): the whole store can be dropped and rebuilt
 * from operational truth + Markdown. `rebuild`/`clear` exist precisely because
 * these rows are derived, not authoritative.
 */
export interface ReadModelRepository {
  get(readModelKey: string, workspaceId: string | null): DbResult<ReadModelRecord>;
  put(record: ReadModelRecord): DbResult<ReadModelRecord>;
  /** Drop a read-model family ahead of a rebuild (rebuildable, not truth). */
  clear(readModelKey: string): DbResult<void>;
}

/**
 * GCL projections — DERIVED (rebuildable from the GCL master + source facts).
 * The SINGLE cross-workspace read path (WS-8); rows are sanitized views, never
 * raw content — see schema/gcl-projections.ts.
 */
export interface GclProjectionRepository {
  get(
    workspaceId: GclProjection["workspaceId"],
    projectionType: GclProjection["projectionType"],
    visibilityLevel: GclProjection["visibilityLevel"],
  ): DbResult<GclProjection>;
  upsert(projection: GclProjection): DbResult<GclProjection>;
  listByWorkspace(workspaceId: GclProjection["workspaceId"]): DbResult<GclProjection[]>;
  listByVisibility(visibilityLevel: GclProjection["visibilityLevel"]): DbResult<GclProjection[]>;
}

/**
 * Write-receipt index — OPERATIONAL TRUTH (WW-1, §8 / safety rule 3). The
 * cross-process backstop the §8 Tool Gateway's in-process `ReceiptStore` cannot
 * give: `reserve` is a UNIQUE-CONSTRAINT INSERT on the object identity
 * (targetSystem, canonicalObjectKey), so at most ONE concurrent caller across ALL
 * processes wins the right to create the external object → zero duplicate external
 * writes. The row is APPEND-on-reserve, then MUTABLE reserved → committed via
 * `put`; NOT rebuildable (a lost receipt would re-open a committed write to a
 * duplicate). This interface uses ONLY @sow/contracts / @sow/db-local types — it
 * MUST NOT import @sow/integrations (wrong dependency direction; the worker layer
 * adapts this @sow/db repo onto the integrations `ReceiptStore` interface).
 */
export interface WriteReceiptRepository {
  /**
   * Atomically claim the exclusive right to CREATE the object identified by
   * (targetSystem, canonicalObjectKey). Backed by an `INSERT … ON CONFLICT DO
   * NOTHING` on the composite key: an INSERT that lands → `{kind:"reserved"}` (this
   * caller is the winner). An empty result (the row already existed) is re-read and
   * classified by whether a receipt is present → `{kind:"committed", record}` (reuse
   * it) or `{kind:"in_progress"}` (another worker mid-write; do NOT create). Two
   * concurrent reserves for the same object NEVER both get `{kind:"reserved"}`.
   */
  reserve(targetSystem: string, canonicalObjectKey: string): DbResult<ReserveOutcome>;
  /** Replay lookup by the §8 idempotency key (returns not_found when unseen). */
  getByIdempotencyKey(idempotencyKey: string): DbResult<WriteReceiptRow>;
  /** Pre-write existence check by object identity (returns not_found when unseen). */
  getByCanonicalObjectKey(targetSystem: string, canonicalObjectKey: string): DbResult<WriteReceiptRow>;
  /**
   * Record the receipt once the external write commits — UPGRADES the reserved
   * placeholder to committed (idempotent: a replayed put for the same object
   * identity is a no-op, never a conflict). A duplicate idempotencyKey pointing at a
   * DIFFERENT object identity is a typed `conflict` (the key is globally unique).
   */
  put(row: WriteReceiptRow): DbResult<void>;
  /**
   * Release a still-RESERVED placeholder (the create faulted) so a retry may
   * re-reserve. NEVER deletes a COMMITTED row (a receipt supersedes the reservation
   * — deleting the exactly-once proof would re-open a duplicate write); a release on
   * a committed row is a safe no-op.
   */
  release(targetSystem: string, canonicalObjectKey: string): DbResult<void>;
}

/**
 * System-Health item store (OBS-1/OBS-2) — OPERATIONAL TRUTH, MUTABLE via a
 * DEDUPE UPSERT keyed on a caller-supplied dedupe key ((failureClass, subjectRef)
 * per §10.3): repeated failures of the SAME class do NOT spawn duplicate items —
 * they bump `occurrenceCount` + refresh `lastSeen` and the mutable lifecycle
 * fields (state → open|acknowledged|resolved, severity, message, resolvedAt),
 * PRESERVING the original `openedAt`. NOT rebuildable (a lost item drops an open
 * failure's audit-linked history). The stored `HealthItem` is the frozen
 * @sow/contracts seam model; the dedupe key + lastSeen + occurrenceCount are
 * persistence-only columns not part of the model. Adapts onto the @sow/workflows
 * `HealthItemStore` port (get-by-dedupe / put / list) at the worker layer.
 */
export interface HealthItemRepository {
  /** Dedupe lookup — the §10.3 identity gate (returns not_found when unseen). */
  getByDedupeKey(dedupeKey: string): DbResult<HealthItem>;
  /**
   * Upsert the item under `dedupeKey` (the §10.3 identity; `subjectRef` is the
   * dedupe subject stored alongside it). First sight INSERTs (occurrenceCount 1);
   * a repeat UPDATEs the existing row (occurrenceCount + 1, lastSeen refreshed,
   * lifecycle fields overwritten, openedAt preserved) — never a duplicate row.
   */
  put(item: HealthItem, dedupeKey: string, subjectRef: string, lastSeen: string): DbResult<void>;
  /** The dashboard set — every item, most-recently-seen first. */
  list(): DbResult<HealthItem[]>;
}

/**
 * Durable-schedule bookkeeping store (LIFE-5) — OPERATIONAL TRUTH, MUTABLE via an
 * upsert keyed on `scheduleId`. `getBookkeeping` returns the last-run readings the
 * clock-jump-safe catch-up compares against; `put` advances them. NOT rebuildable
 * (a lost row re-fires or starves a schedule). Adapts onto the @sow/workflows
 * `ScheduleStore` port at the worker layer.
 */
export interface ScheduleBookkeepingRepository {
  getBookkeeping(scheduleId: string): DbResult<ScheduleBookkeepingRecord>;
  put(bookkeeping: ScheduleBookkeepingRecord): DbResult<void>;
}

/**
 * Single-active-instance lease store (LIFE-1) — OPERATIONAL TRUTH, MUTABLE via an
 * ATOMIC compare-and-set. `compareAndSet` commits `next` IFF the currently-stored
 * row equals `expected` (an absent lease is `expected: undefined` — first acquire),
 * returning `true` on success and `false` when another instance won the race —
 * contention is a boolean verdict, NEVER a throw (§16). The CAS SEMANTICS live once
 * in the pure `decideLeaseCas`/`leaseRecordsEqual` (shared by both dialects so they
 * provably agree). NOT rebuildable (a lost lease breaks the exactly-once spine).
 * Adapts onto the @sow/workflows `InstanceLeaseStore` port at the worker layer.
 */
export interface InstanceLeaseRepository {
  get(taskQueue: string): DbResult<LeaseRecordRow>;
  /**
   * Atomically acquire/renew: commit `next` IFF the stored record equals `expected`
   * (`expected: undefined` = first acquire against an empty slot). `ok(true)` = this
   * caller won the lease; `ok(false)` = it lost the race (another instance holds it).
   * A driver/store failure is a typed `err(DbError)` (never a throw across §16).
   */
  compareAndSet(
    expected: LeaseRecordRow | undefined,
    next: LeaseRecordRow,
  ): DbResult<boolean>;
}
