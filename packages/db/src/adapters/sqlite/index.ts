// SQLite operational-store adapter (task 2.3, §4 / REQ-D-002/003, §16).
//
// Implements EVERY repository interface (repositories/interfaces.ts) against
// `drizzle-orm/better-sqlite3` + the sqlite-core schema. SQLite is the local V1
// default (§13). The Postgres adapter (2.4) and the both-dialect repository
// CONTRACT suite (2.9) are separate tasks; this file is SQLite-only.
//
// ERROR CONVENTION (§16): NOTHING throws across a repository boundary. Every
// method returns a typed `Result<T, DbError>` — driver throws are caught and
// mapped to the closed `DbErrorCode` taxonomy (./errors.ts); an empty lookup is
// a typed `not_found`, never an exception. better-sqlite3 is synchronous, so the
// `async` methods do no real awaiting — they exist to satisfy the I/O-describing
// (Promise-returning) interface contract.
//
// BOUNDARY (§4): this adapter persists ONLY operational state. The append-only /
// tombstone / exactly-once shapes the interfaces describe are honored here —
// append-only logs expose no in-place mutate/delete, approvals advance by an
// atomic compare-and-set, and only the REBUILDABLE read-model store exposes a
// destructive `clear`.
import { and, asc, desc, eq, isNull, lte, notInArray, or, sql, gt } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { err, ok, type Result } from "@sow/contracts";
import type {
  Approval,
  AuditRecord,
  GclProjection,
  HealthItem,
  ProviderProfile,
  Workspace,
  WorkflowRunRef,
} from "@sow/contracts";
import type {
  ApprovalRepository,
  ApprovalTransitionOutcome,
  AuditQuery,
  AuditRepository,
  CommittedRevisionRow,
  ConnectorCursorRecord,
  ConnectorCursorRepository,
  DbError,
  EventLogRecord,
  EventLogRepository,
  GclProjectionRepository,
  HealthItemRepository,
  InstanceLeaseRepository,
  KnowledgeRevisionRepository,
  LeaseRecordRow,
  OutboxEntry,
  OutboxRepository,
  PendingKnowledgeMutation,
  PendingKnowledgeMutationRepository,
  ProviderStateRepository,
  ReadModelRecord,
  ReadModelRepository,
  ReserveOutcome,
  ScheduleBookkeepingRecord,
  ScheduleBookkeepingRepository,
  WorkflowRunRefRepository,
  WorkspaceConfigRepository,
  WriteReceiptRepository,
  WriteReceiptRow,
} from "../../repositories/interfaces";
import * as schema from "../../schema/index";
import {
  casVerdictToOutcome,
  decideApprovalCas,
  decideLeaseCas,
  decideReserve,
  invariantToDbErrorCode,
  type CasVerdict,
} from "../../invariants/operational-truth";
import { conflict, notFound, toDbError } from "./errors";

/**
 * Bridge the pure invariant CAS verdict onto the adapter's §16 DbError taxonomy,
 * SURFACING the apply-vs-noop `applied` flag (exactly-once, REQ-F-012 — closes the
 * TOCTOU: a genuine durable transition returns `applied:true`; an idempotent no-op
 * — replay OR concurrent same-target contender — returns `applied:false`, both `ok`).
 * The exactly-once SEMANTICS live once in `decideApprovalCas`/`casVerdictToOutcome`
 * (unit 2.5, shared by both dialects); this only re-codes an InvariantViolation as
 * the adapter's enumerable DbError so the rejection re-emits cleanly.
 */
function casDbResult(
  verdict: CasVerdict,
  applied: Approval,
  current: Approval,
): Result<ApprovalTransitionOutcome, DbError> {
  const r = casVerdictToOutcome(verdict, applied, current);
  return r.ok
    ? ok({ approval: r.value.value, applied: r.value.applied })
    : err({ code: invariantToDbErrorCode(r.error.code), message: r.error.message });
}

/** All SQLite repositories returned by the factory (one per §4 domain + WW-1 receipts). */
export interface SqliteRepositories {
  readonly workspaceConfig: WorkspaceConfigRepository;
  readonly eventLog: EventLogRepository;
  readonly workflowRunRefs: WorkflowRunRefRepository;
  readonly audit: AuditRepository;
  readonly approvals: ApprovalRepository;
  readonly outbox: OutboxRepository;
  readonly pendingKnowledgeMutations: PendingKnowledgeMutationRepository;
  readonly knowledgeRevisions: KnowledgeRevisionRepository;
  readonly connectorCursors: ConnectorCursorRepository;
  readonly providerState: ProviderStateRepository;
  readonly readModels: ReadModelRepository;
  readonly gclProjections: GclProjectionRepository;
  readonly writeReceipts: WriteReceiptRepository;
  readonly healthItems: HealthItemRepository;
  readonly scheduleBookkeeping: ScheduleBookkeepingRepository;
  readonly instanceLeases: InstanceLeaseRepository;
}

// §9 Proposed-External-Action TERMINAL states — a tombstoned outbox entry never
// re-surfaces in the due-dispatch query (§8 exactly-once: replay reuses receipt).
const OUTBOX_TERMINAL = ["receipt_recorded", "rejected", "expired"] as const;

/** Run a synchronous unit-of-work, translating any driver throw to a typed err. */
function run<T>(fn: () => Result<T, DbError>): Promise<Result<T, DbError>> {
  try {
    return Promise.resolve(fn());
  } catch (cause) {
    return Promise.resolve(err(toDbError(cause)));
  }
}

// ── row → DTO mappers (DB NULL → contract `undefined` for optional fields) ────
type EventLogRow = typeof schema.eventLog.$inferSelect;
type ApprovalRow = typeof schema.approvals.$inferSelect;
type OutboxRow = typeof schema.outbox.$inferSelect;
type PendingKmpRow = typeof schema.pendingKnowledgeMutations.$inferSelect;
type KnowledgeRevisionDbRow = typeof schema.knowledgeRevisions.$inferSelect;
type CursorRow = typeof schema.connectorCursors.$inferSelect;
type ReadModelRow = typeof schema.readModels.$inferSelect;
type WriteReceiptDbRow = typeof schema.writeReceipts.$inferSelect;

function toEventLog(r: EventLogRow): EventLogRecord {
  return {
    eventId: r.eventId,
    eventName: r.eventName,
    workspaceId: r.workspaceId ?? undefined,
    correlationId: r.correlationId ?? undefined,
    workflowId: r.workflowId ?? undefined,
    payload: r.payload ?? undefined,
    occurredAt: r.occurredAt,
    recordedAt: r.recordedAt,
  };
}

function toApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    // §13.10a — actionRef/planRef are nullable columns (exactly one is set, per subjectKind);
    // DB NULL → contract `undefined`. The contract refine re-asserts the subject exclusivity.
    actionRef: r.actionRef ?? undefined,
    planRef: r.planRef ?? undefined,
    subjectKind: r.subjectKind,
    workspaceId: r.workspaceId,
    status: r.status,
    actor: r.actor,
    channel: r.channel,
    payloadHash: r.payloadHash,
    snoozeUntil: r.snoozeUntil ?? undefined,
    expiresAt: r.expiresAt ?? undefined,
  };
}

function toOutbox(r: OutboxRow): OutboxEntry {
  return {
    outboxId: r.outboxId,
    actionRef: r.actionRef,
    workspaceId: r.workspaceId,
    targetSystem: r.targetSystem,
    canonicalObjectKey: r.canonicalObjectKey,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    status: r.status,
    payload: r.payload ?? undefined,
    writeReceipt: r.writeReceipt ?? undefined,
    attempts: r.attempts,
    enqueuedAt: r.enqueuedAt,
    nextAttemptAt: r.nextAttemptAt ?? undefined,
    updatedAt: r.updatedAt,
  };
}

function toPendingKmp(r: PendingKmpRow): PendingKnowledgeMutation {
  return {
    planId: r.planId,
    workspaceId: r.workspaceId,
    // `plan` is a json column → already a structured value (candidate data — the
    // executor re-validates through KnowledgeMutationPlanSchema, never trusts it raw).
    plan: r.plan,
    payloadHash: r.payloadHash,
    status: r.status,
    recordedAt: r.recordedAt,
    settledAt: r.settledAt ?? undefined,
  };
}

function toCommittedRevision(r: KnowledgeRevisionDbRow): CommittedRevisionRow {
  return {
    revisionId: r.revisionId,
    baseRevisionId: r.baseRevisionId,
    idempotencyKey: r.idempotencyKey,
    planId: r.planId,
    actor: r.actor,
    sourceEventRef: r.sourceEventRef,
    // `workflowRunRef` + `auditRecord` are json columns → already structured values. They were
    // written verbatim by the KnowledgeWriter (not candidate data), so they are cast back to the
    // DTO's contract types without re-validation (the writer is the sole author — safety rule 1).
    workflowRunRef: r.workflowRunRef as CommittedRevisionRow["workflowRunRef"],
    auditRecord: r.auditRecord as CommittedRevisionRow["auditRecord"],
    committedAt: r.committedAt,
  };
}

function toCursor(r: CursorRow): ConnectorCursorRecord {
  return {
    connectorId: r.connectorId,
    workspaceId: r.workspaceId,
    cursor: r.cursor ?? undefined,
    status: r.status,
    lastSyncAt: r.lastSyncAt ?? undefined,
    nextSyncAt: r.nextSyncAt ?? undefined,
    updatedAt: r.updatedAt,
  };
}

function toReadModel(r: ReadModelRow): ReadModelRecord {
  return {
    readModelKey: r.readModelKey,
    workspaceId: r.workspaceId ?? undefined,
    data: r.data,
    rebuiltAt: r.rebuiltAt,
  };
}

function toWriteReceipt(r: WriteReceiptDbRow): WriteReceiptRow {
  if (r.idempotencyKey === null) {
    // Invariant: toWriteReceipt is only called on a COMMITTED row (receiptPresent),
    // which always carries the real key set by `put`. A reserved placeholder's NULL
    // key must never surface as a committed receipt — fail closed if it somehow does.
    throw new Error("invariant: committed write-receipt row has a null idempotencyKey");
  }
  return {
    targetSystem: r.targetSystem,
    canonicalObjectKey: r.canonicalObjectKey,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    receipt: (r.receipt ?? undefined) as WriteReceiptRow["receipt"],
    recordedAt: r.recordedAt,
  };
}

/** A stored receipt row is COMMITTED iff its `receipt` proof is present (§8). */
function receiptPresent(r: WriteReceiptDbRow): boolean {
  return r.receipt !== null && r.receipt !== undefined;
}

// Phase-10 durability row types + mappers (DB NULL → contract `undefined`).
type HealthItemDbRow = typeof schema.healthItems.$inferSelect;
type ScheduleBookkeepingDbRow = typeof schema.scheduleBookkeeping.$inferSelect;
type LeaseDbRow = typeof schema.instanceLeases.$inferSelect;

/** Row → the frozen HealthItem seam model (drops the persistence-only dedupe cols). */
function toHealthItem(r: HealthItemDbRow): HealthItem {
  return {
    id: r.id,
    failureClass: r.failureClass as HealthItem["failureClass"],
    severity: r.severity,
    message: r.message,
    auditRef: r.auditRef as HealthItem["auditRef"],
    openedAt: r.openedAt,
    state: r.state as HealthItem["state"],
    resolvedAt: r.resolvedAt ?? undefined,
    parityReportRef: (r.parityReportRef ?? undefined) as HealthItem["parityReportRef"],
    factIdentity: (r.factIdentity ?? undefined) as HealthItem["factIdentity"],
  };
}

function toScheduleBookkeeping(r: ScheduleBookkeepingDbRow): ScheduleBookkeepingRecord {
  return {
    scheduleId: r.scheduleId,
    lastRunWall: r.lastRunWall,
    lastRunMonotonicMs: r.lastRunMonotonicMs ?? undefined,
    lastRunMonotonicEpoch: r.lastRunMonotonicEpoch ?? undefined,
  };
}

function toLease(r: LeaseDbRow): LeaseRecordRow {
  return {
    taskQueue: r.taskQueue,
    ownerId: r.ownerId,
    acquiredAt: r.acquiredAt,
    expiresAt: r.expiresAt,
    generation: r.generation,
  };
}

// ── the factory ──────────────────────────────────────────────────────────────
/** Build every operational-store repository over one better-sqlite3 Drizzle db. */
export function createSqliteRepositories(db: BetterSQLite3Database): SqliteRepositories {
  const workspaceConfig: WorkspaceConfigRepository = {
    get: (id) =>
      run(() => {
        const row = db.select().from(schema.workspaceConfig).where(eq(schema.workspaceConfig.id, id)).get();
        return row ? ok(row as Workspace) : err(notFound(`workspace ${id}`));
      }),
    list: () => run(() => ok(db.select().from(schema.workspaceConfig).all() as Workspace[])),
    upsert: (ws) =>
      run(() => {
        db.insert(schema.workspaceConfig)
          .values(ws)
          .onConflictDoUpdate({
            target: schema.workspaceConfig.id,
            set: {
              name: ws.name,
              type: ws.type,
              dataOwner: ws.dataOwner,
              markdownRepoPath: ws.markdownRepoPath,
              gbrainBrainId: ws.gbrainBrainId,
              defaultVisibility: ws.defaultVisibility,
              egressPolicy: ws.egressPolicy,
              providerMatrix: ws.providerMatrix,
            },
          })
          .run();
        return ok(ws);
      }),
  };

  const eventLog: EventLogRepository = {
    append: (record) =>
      run(() => {
        db.insert(schema.eventLog).values(record).run();
        return ok(undefined);
      }),
    readSince: (afterEventId, limit) =>
      run(() => {
        // arch_gap: the event journal has no monotonic sequence column, so the
        // forward-scan total order + cursor semantics are under-specified upstream.
        // Chosen here: order by (recordedAt, eventId); a non-null cursor whose
        // eventId is unknown is `not_found`. The cross-dialect contract (2.9) must
        // pin one total order — recordedAt ties on coarse clocks would diverge.
        if (afterEventId === null) {
          const rows = db
            .select()
            .from(schema.eventLog)
            .orderBy(asc(schema.eventLog.recordedAt), asc(schema.eventLog.eventId))
            .limit(limit)
            .all();
          return ok(rows.map(toEventLog));
        }
        const cursor = db.select().from(schema.eventLog).where(eq(schema.eventLog.eventId, afterEventId)).get();
        if (!cursor) return err(notFound(`event ${afterEventId}`));
        const rows = db
          .select()
          .from(schema.eventLog)
          .where(
            or(
              gt(schema.eventLog.recordedAt, cursor.recordedAt),
              and(eq(schema.eventLog.recordedAt, cursor.recordedAt), gt(schema.eventLog.eventId, afterEventId)),
            ),
          )
          .orderBy(asc(schema.eventLog.recordedAt), asc(schema.eventLog.eventId))
          .limit(limit)
          .all();
        return ok(rows.map(toEventLog));
      }),
    byWorkflow: (workflowId) =>
      run(() => {
        const rows = db
          .select()
          .from(schema.eventLog)
          .where(eq(schema.eventLog.workflowId, workflowId))
          .orderBy(asc(schema.eventLog.recordedAt), asc(schema.eventLog.eventId))
          .all();
        return ok(rows.map(toEventLog));
      }),
  };

  const workflowRunRefs: WorkflowRunRefRepository = {
    create: (ref) =>
      run(() => {
        // WW-1 (B) no-double-run guard (§9 / LIFE-3): INSERT … ON CONFLICT DO NOTHING
        // over BOTH unique keys (the workflowId PK AND the idempotencyKey UNIQUE), then
        // an empty `.returning()` == a lost race (the SAME lost-race idiom as
        // applyTransition). Two workers that both saw getByIdempotencyKey==not_found
        // cannot BOTH insert: exactly one wins; the loser gets a typed `conflict` and
        // reconciles to the winner (resolveRun re-reads by idempotencyKey → reused).
        const inserted = db.insert(schema.workflowRunRefs).values(ref).onConflictDoNothing().returning().all();
        if (inserted.length === 0) {
          return err(conflict(`workflow run conflict (duplicate workflowId or idempotencyKey): ${ref.workflowId}`));
        }
        return ok(ref);
      }),
    get: (workflowId) =>
      run(() => {
        const row = db.select().from(schema.workflowRunRefs).where(eq(schema.workflowRunRefs.workflowId, workflowId)).get();
        return row ? ok(row as WorkflowRunRef) : err(notFound(`workflow ${workflowId}`));
      }),
    getByIdempotencyKey: (idempotencyKey) =>
      run(() => {
        const row = db
          .select()
          .from(schema.workflowRunRefs)
          .where(eq(schema.workflowRunRefs.idempotencyKey, idempotencyKey))
          .get();
        return row ? ok(row as WorkflowRunRef) : err(notFound(`workflow idempotencyKey ${idempotencyKey}`));
      }),
    updateState: (workflowId, state) =>
      run(() => {
        const rows = db
          .update(schema.workflowRunRefs)
          .set({ state })
          .where(eq(schema.workflowRunRefs.workflowId, workflowId))
          .returning()
          .all();
        const row = rows[0];
        return row ? ok(row as WorkflowRunRef) : err(notFound(`workflow ${workflowId}`));
      }),
    appendAuditRef: (workflowId, auditRef) =>
      run(() => {
        const cur = db.select().from(schema.workflowRunRefs).where(eq(schema.workflowRunRefs.workflowId, workflowId)).get();
        if (!cur) return err(notFound(`workflow ${workflowId}`));
        const auditRefs = [...cur.auditRefs, auditRef];
        const rows = db
          .update(schema.workflowRunRefs)
          .set({ auditRefs })
          .where(eq(schema.workflowRunRefs.workflowId, workflowId))
          .returning()
          .all();
        const row = rows[0];
        return row ? ok(row as WorkflowRunRef) : err(notFound(`workflow ${workflowId}`));
      }),
  };

  const audit: AuditRepository = {
    append: (record) =>
      run(() => {
        db.insert(schema.auditRecords).values(record).run();
        return ok(undefined);
      }),
    query: (filter: AuditQuery, limit) =>
      run(() => {
        const conds = [];
        if (filter.actor !== undefined) conds.push(eq(schema.auditRecords.actor, filter.actor));
        if (filter.event !== undefined) conds.push(eq(schema.auditRecords.event, filter.event));
        if (filter.workspaceId !== undefined)
          conds.push(eq(schema.auditRecords.workspaceId, filter.workspaceId));
        // arch_gap: audit has no surrogate id (parity bars one) — its only row
        // identity is SQLite's implicit `rowid`, used here for append/forward
        // order. `rowid` is SQLite-only; the Postgres adapter (2.4) needs an
        // equivalent insertion-order key, and the dialect-agnostic forward order
        // is under-specified until 2.9 names it.
        const rows = db
          .select()
          .from(schema.auditRecords)
          .where(conds.length > 0 ? and(...conds) : undefined)
          .orderBy(sql`rowid`)
          .all() as AuditRecord[];
        const ref = filter.ref;
        const matched = ref === undefined ? rows : rows.filter((r) => r.refs.some((x) => x === ref));
        return ok(matched.slice(0, limit));
      }),
  };

  const approvals: ApprovalRepository = {
    create: (approval) =>
      run(() => {
        db.insert(schema.approvals).values(approval).run();
        return ok(approval);
      }),
    get: (id) =>
      run(() => {
        const row = db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
        return row ? ok(toApproval(row)) : err(notFound(`approval ${id}`));
      }),
    listByStatus: (status) =>
      run(() => {
        const rows = db.select().from(schema.approvals).where(eq(schema.approvals.status, status)).all();
        return ok(rows.map(toApproval));
      }),
    listByStatusAndWorkspace: (status, workspaceId) =>
      run(() => {
        const rows = db
          .select()
          .from(schema.approvals)
          .where(and(eq(schema.approvals.status, status), eq(schema.approvals.workspaceId, workspaceId)))
          .all();
        return ok(rows.map(toApproval));
      }),
    applyTransition: (id, expectedFromStatus, next) =>
      run(() => {
        // Exactly-once CAS (REQ-F-012, §9), decided by the shared 2.5 invariant so
        // sqlite + pg agree: a true replay (expected==current && target==current)
        // is an idempotent no-op returning ok(current); a stale different-target CAS
        // (or a move out of a tombstoned/terminal record) is a typed conflict; an
        // absent record is not_found. Never a double-apply, never a resurrection.
        const currentRow = db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
        if (!currentRow) return err(notFound(`approval ${id}`));
        const current = toApproval(currentRow);
        const verdict = decideApprovalCas(current.status, expectedFromStatus, next.status);
        if (verdict.kind !== "apply") return casDbResult(verdict, current, current);
        // Winner: perform the conditional write (WHERE status=expectedFrom is the
        // atomic compare half). `apply` implies current===expectedFrom, so the row
        // matches; a missing row means a concurrent writer moved it → stale.
        const rows = db
          .update(schema.approvals)
          .set({
            // §13.10a — the subject (actionRef/planRef/subjectKind) is immutable across a status
            // transition; `next` carries it forward, so writing it here is a faithful no-op that keeps
            // the row === the transitioned model. Nullable refs use the `?? null` idiom.
            actionRef: next.actionRef ?? null,
            planRef: next.planRef ?? null,
            subjectKind: next.subjectKind,
            status: next.status,
            actor: next.actor,
            channel: next.channel,
            payloadHash: next.payloadHash,
            snoozeUntil: next.snoozeUntil ?? null,
            expiresAt: next.expiresAt ?? null,
          })
          .where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, expectedFromStatus)))
          .returning()
          .all();
        const row = rows[0];
        return row
          ? casDbResult({ kind: "apply" }, toApproval(row), current)
          : casDbResult({ kind: "stale_conflict" }, current, current);
      }),
  };

  const outbox: OutboxRepository = {
    enqueue: (entry) =>
      run(() => {
        db.insert(schema.outbox).values(entry).run();
        return ok(entry);
      }),
    get: (outboxId) =>
      run(() => {
        const row = db.select().from(schema.outbox).where(eq(schema.outbox.outboxId, outboxId)).get();
        return row ? ok(toOutbox(row)) : err(notFound(`outbox ${outboxId}`));
      }),
    getByIdempotencyKey: (idempotencyKey) =>
      run(() => {
        const row = db.select().from(schema.outbox).where(eq(schema.outbox.idempotencyKey, idempotencyKey)).get();
        return row ? ok(toOutbox(row)) : err(notFound(`outbox idempotencyKey ${idempotencyKey}`));
      }),
    listDue: (now, limit) =>
      run(() => {
        // arch_gap: outbox `status` is open text (no frozen §9 Proposed-External-
        // Action enum in scope), so "due" is derived: NOT in the terminal set
        // (receipt_recorded|rejected|expired) AND nextAttemptAt is null or elapsed.
        const rows = db
          .select()
          .from(schema.outbox)
          .where(
            and(
              notInArray(schema.outbox.status, [...OUTBOX_TERMINAL]),
              or(isNull(schema.outbox.nextAttemptAt), lte(schema.outbox.nextAttemptAt, now)),
            ),
          )
          .orderBy(asc(schema.outbox.enqueuedAt), asc(schema.outbox.outboxId))
          .limit(limit)
          .all();
        return ok(rows.map(toOutbox));
      }),
    update: (entry) =>
      run(() => {
        const rows = db
          .update(schema.outbox)
          .set({
            actionRef: entry.actionRef,
            workspaceId: entry.workspaceId,
            targetSystem: entry.targetSystem,
            canonicalObjectKey: entry.canonicalObjectKey,
            idempotencyKey: entry.idempotencyKey,
            payloadHash: entry.payloadHash,
            status: entry.status,
            payload: entry.payload ?? null,
            writeReceipt: entry.writeReceipt ?? null,
            attempts: entry.attempts,
            enqueuedAt: entry.enqueuedAt,
            nextAttemptAt: entry.nextAttemptAt ?? null,
            updatedAt: entry.updatedAt,
          })
          .where(eq(schema.outbox.outboxId, entry.outboxId))
          .returning()
          .all();
        const row = rows[0];
        return row ? ok(toOutbox(row)) : err(notFound(`outbox ${entry.outboxId}`));
      }),
  };

  const pendingKnowledgeMutations: PendingKnowledgeMutationRepository = {
    record: (entry) =>
      run(() => {
        // First-write-wins insert; a duplicate planId collides on the PK → the driver
        // throws a UNIQUE violation which `run`/`toDbError` maps to a typed `conflict`
        // (the §13.10a idempotency gate — mirrors the outbox `enqueue`).
        db.insert(schema.pendingKnowledgeMutations).values(entry).run();
        return ok(entry);
      }),
    get: (planId) =>
      run(() => {
        const row = db
          .select()
          .from(schema.pendingKnowledgeMutations)
          .where(eq(schema.pendingKnowledgeMutations.planId, planId))
          .get();
        return row ? ok(toPendingKmp(row)) : err(notFound(`pending-kmp ${planId}`));
      }),
    update: (entry) =>
      run(() => {
        // §13.10a TOCTOU: ONLY `status` + `settledAt` advance on update. `plan`,
        // `payloadHash`, `workspaceId`, and `recordedAt` are IMMUTABLE post-record
        // (structurally — never in the set-clause) so a post-approval plan-swap is
        // unrepresentable on the update path too, not just on first-write-wins record.
        const rows = db
          .update(schema.pendingKnowledgeMutations)
          .set({
            status: entry.status,
            settledAt: entry.settledAt ?? null,
          })
          .where(eq(schema.pendingKnowledgeMutations.planId, entry.planId))
          .returning()
          .all();
        const row = rows[0];
        return row ? ok(toPendingKmp(row)) : err(notFound(`pending-kmp ${entry.planId}`));
      }),
  };

  const knowledgeRevisions: KnowledgeRevisionRepository = {
    getByIdempotencyKey: (idempotencyKey) =>
      run(() => {
        const row = db
          .select()
          .from(schema.knowledgeRevisions)
          .where(eq(schema.knowledgeRevisions.idempotencyKey, idempotencyKey))
          .get();
        return row
          ? ok(toCommittedRevision(row))
          : err(notFound(`knowledge-revision ${idempotencyKey}`));
      }),
    record: (revision) =>
      run(() => {
        // FIRST-WRITE-WINS: a duplicate `idempotencyKey` (the PK) is an idempotent NO-OP
        // (ON CONFLICT DO NOTHING → never two revisions for one key; the exactly-once
        // substrate, §16). Unlike the outbox/pending-kmp `conflict`-on-duplicate, the
        // KnowledgeWriter `record` port returns void (no conflict channel) and a same-key
        // commit IS the same commit — so keeping the FIRST write is the safe, idempotent
        // result (the writer already short-circuits via `getByIdempotencyKey`; this is the
        // defensive backstop for a concurrent/replay writer that raced the short-circuit).
        db.insert(schema.knowledgeRevisions).values(revision).onConflictDoNothing().run();
        return ok(undefined);
      }),
  };

  const connectorCursors: ConnectorCursorRepository = {
    get: (connectorId, workspaceId) =>
      run(() => {
        const row = db
          .select()
          .from(schema.connectorCursors)
          .where(and(eq(schema.connectorCursors.connectorId, connectorId), eq(schema.connectorCursors.workspaceId, workspaceId)))
          .get();
        return row ? ok(toCursor(row)) : err(notFound(`cursor ${connectorId}/${workspaceId}`));
      }),
    upsert: (record) =>
      run(() => {
        db.insert(schema.connectorCursors)
          .values(record)
          .onConflictDoUpdate({
            target: [schema.connectorCursors.connectorId, schema.connectorCursors.workspaceId],
            set: {
              cursor: record.cursor ?? null,
              status: record.status,
              lastSyncAt: record.lastSyncAt ?? null,
              nextSyncAt: record.nextSyncAt ?? null,
              updatedAt: record.updatedAt,
            },
          })
          .run();
        return ok(record);
      }),
    listByConnector: (connectorId) =>
      run(() => {
        const rows = db
          .select()
          .from(schema.connectorCursors)
          .where(eq(schema.connectorCursors.connectorId, connectorId))
          .all();
        return ok(rows.map(toCursor));
      }),
  };

  const providerState: ProviderStateRepository = {
    get: (provider, endpoint, model) =>
      run(() => {
        const row = db
          .select()
          .from(schema.providerProfiles)
          .where(
            and(
              eq(schema.providerProfiles.provider, provider),
              eq(schema.providerProfiles.endpoint, endpoint),
              eq(schema.providerProfiles.model, model),
            ),
          )
          .get();
        return row ? ok(row as ProviderProfile) : err(notFound(`provider ${provider}/${endpoint}/${model}`));
      }),
    list: () => run(() => ok(db.select().from(schema.providerProfiles).all() as ProviderProfile[])),
    upsert: (profile) =>
      run(() => {
        db.insert(schema.providerProfiles)
          .values(profile)
          .onConflictDoUpdate({
            target: [schema.providerProfiles.provider, schema.providerProfiles.endpoint, schema.providerProfiles.model],
            set: {
              capabilities: profile.capabilities,
              egressClass: profile.egressClass,
              costCaps: profile.costCaps,
              conformanceStatus: profile.conformanceStatus,
            },
          })
          .run();
        return ok(profile);
      }),
    setConformanceStatus: (provider, endpoint, model, conformanceStatus) =>
      run(() => {
        const rows = db
          .update(schema.providerProfiles)
          .set({ conformanceStatus })
          .where(
            and(
              eq(schema.providerProfiles.provider, provider),
              eq(schema.providerProfiles.endpoint, endpoint),
              eq(schema.providerProfiles.model, model),
            ),
          )
          .returning()
          .all();
        const row = rows[0];
        return row ? ok(row as ProviderProfile) : err(notFound(`provider ${provider}/${endpoint}/${model}`));
      }),
  };

  const readModels: ReadModelRepository = {
    get: (readModelKey, workspaceId) =>
      run(() => {
        const cond =
          workspaceId === null
            ? and(eq(schema.readModels.readModelKey, readModelKey), isNull(schema.readModels.workspaceId))
            : and(eq(schema.readModels.readModelKey, readModelKey), eq(schema.readModels.workspaceId, workspaceId));
        const row = db.select().from(schema.readModels).where(cond).get();
        return row ? ok(toReadModel(row)) : err(notFound(`read-model ${readModelKey}/${workspaceId ?? "*"}`));
      }),
    put: (record) =>
      run(() => {
        // arch_gap: the read_models schema declares NO unique constraint on the
        // logical key (readModelKey, workspaceId) — it's deferred to the 2.6
        // migration/index layer. Until that index exists, `put` cannot use a true
        // onConflict upsert, so it does an atomic delete-then-insert of the key
        // (rebuildable store, §4 — a destructive op is legal here).
        const cond =
          record.workspaceId === undefined || record.workspaceId === null
            ? and(eq(schema.readModels.readModelKey, record.readModelKey), isNull(schema.readModels.workspaceId))
            : and(eq(schema.readModels.readModelKey, record.readModelKey), eq(schema.readModels.workspaceId, record.workspaceId));
        db.transaction((tx) => {
          tx.delete(schema.readModels).where(cond).run();
          tx.insert(schema.readModels)
            .values({
              readModelKey: record.readModelKey,
              workspaceId: record.workspaceId ?? null,
              data: record.data,
              rebuiltAt: record.rebuiltAt,
            })
            .run();
        });
        return ok(record);
      }),
    clear: (readModelKey) =>
      run(() => {
        db.delete(schema.readModels).where(eq(schema.readModels.readModelKey, readModelKey)).run();
        return ok(undefined);
      }),
  };

  const gclProjections: GclProjectionRepository = {
    get: (workspaceId, projectionType, visibilityLevel) =>
      run(() => {
        const row = db
          .select()
          .from(schema.gclProjections)
          .where(
            and(
              eq(schema.gclProjections.workspaceId, workspaceId),
              eq(schema.gclProjections.projectionType, projectionType),
              eq(schema.gclProjections.visibilityLevel, visibilityLevel),
            ),
          )
          .get();
        return row ? ok(row as GclProjection) : err(notFound(`gcl ${workspaceId}/${projectionType}/${visibilityLevel}`));
      }),
    upsert: (projection) =>
      run(() => {
        db.insert(schema.gclProjections)
          .values(projection)
          .onConflictDoUpdate({
            target: [
              schema.gclProjections.workspaceId,
              schema.gclProjections.projectionType,
              schema.gclProjections.visibilityLevel,
            ],
            set: {
              sanitizedPayload: projection.sanitizedPayload,
              sourceRefs: projection.sourceRefs,
            },
          })
          .run();
        return ok(projection);
      }),
    listByWorkspace: (workspaceId) =>
      run(() => {
        const rows = db.select().from(schema.gclProjections).where(eq(schema.gclProjections.workspaceId, workspaceId)).all();
        return ok(rows as GclProjection[]);
      }),
    listByVisibility: (visibilityLevel) =>
      run(() => {
        const rows = db
          .select()
          .from(schema.gclProjections)
          .where(eq(schema.gclProjections.visibilityLevel, visibilityLevel))
          .all();
        return ok(rows as GclProjection[]);
      }),
  };

  // WW-1 (A) write-receipt index — the cross-process no-duplicate-external-write
  // backstop (§8 / safety rule 3). reserve is a UNIQUE-key INSERT on the object
  // identity; the shared pure `decideReserve` classes the outcome so sqlite + pg
  // agree.
  const objectIdentity = (targetSystem: string, canonicalObjectKey: string) =>
    and(
      eq(schema.writeReceipts.targetSystem, targetSystem),
      eq(schema.writeReceipts.canonicalObjectKey, canonicalObjectKey),
    );

  const writeReceipts: WriteReceiptRepository = {
    reserve: (targetSystem, canonicalObjectKey) =>
      run((): Result<ReserveOutcome, DbError> => {
        // Atomic claim: INSERT a receipt-less placeholder ON CONFLICT DO NOTHING over
        // the (targetSystem, canonicalObjectKey) PK. An empty `.returning()` == the
        // row already existed (this caller LOST the race) — the same lost-race idiom
        // as applyTransition. The winner INSERTed → `reserved`.
        const insertedRows = db
          .insert(schema.writeReceipts)
          .values({
            targetSystem,
            canonicalObjectKey,
            // Placeholder envelope fields; `put` overwrites them with the committed
            // envelope. A reserved placeholder carries NO replay key (NULL) — a
            // synthetic key derived from (targetSystem, canonicalObjectKey) is NOT
            // injective (colon-delimited canonical keys collide: ('slack','a:b') and
            // ('slack:a','b') both -> 'slack:a:b') and could also collide with a real
            // committed key, tripping UNIQUE(idempotencyKey) for an object that was
            // never reserved. NULL sidesteps both: UNIQUE admits many NULLs, and the
            // object identity (composite PK) is the reserve's uniqueness key.
            idempotencyKey: null,
            payloadHash: "",
            receipt: null,
            recordedAt: new Date(0).toISOString(),
          })
          .onConflictDoNothing({ target: [schema.writeReceipts.targetSystem, schema.writeReceipts.canonicalObjectKey] })
          .returning()
          .all();
        if (insertedRows.length > 0) {
          return ok({ kind: decideReserve({ inserted: true, existingReceiptPresent: false }) } as ReserveOutcome);
        }
        // Lost the INSERT race → re-read the existing row and classify committed
        // (receipt present → reuse) vs in_progress (no receipt → another worker mid-write).
        const existing = db.select().from(schema.writeReceipts).where(objectIdentity(targetSystem, canonicalObjectKey)).get();
        if (!existing) {
          // The row vanished between the failed INSERT and the re-read (a concurrent
          // release of a placeholder). Treat as in_progress — the caller must NOT
          // create; a retry will re-reserve cleanly.
          return ok({ kind: "in_progress" } as ReserveOutcome);
        }
        const kind = decideReserve({ inserted: false, existingReceiptPresent: receiptPresent(existing) });
        return kind === "committed"
          ? ok({ kind: "committed", record: toWriteReceipt(existing) })
          : ok({ kind } as ReserveOutcome);
      }),
    getByIdempotencyKey: (idempotencyKey) =>
      run(() => {
        const row = db.select().from(schema.writeReceipts).where(eq(schema.writeReceipts.idempotencyKey, idempotencyKey)).get();
        // Only a COMMITTED row is a real receipt; a reservation placeholder carries a
        // synthetic idempotencyKey and no receipt, so it never matches a real lookup.
        return row && receiptPresent(row)
          ? ok(toWriteReceipt(row))
          : err(notFound(`write-receipt idempotencyKey ${idempotencyKey}`));
      }),
    getByCanonicalObjectKey: (targetSystem, canonicalObjectKey) =>
      run(() => {
        const row = db.select().from(schema.writeReceipts).where(objectIdentity(targetSystem, canonicalObjectKey)).get();
        return row && receiptPresent(row)
          ? ok(toWriteReceipt(row))
          : err(notFound(`write-receipt ${targetSystem}/${canonicalObjectKey}`));
      }),
    put: (row) =>
      run((): Result<void, DbError> => {
        // Upgrade reserved → committed for the object identity (idempotent). ON
        // CONFLICT (the composite PK) DO UPDATE writes the committed envelope +
        // receipt. A duplicate idempotencyKey pointing at a DIFFERENT object identity
        // trips the UNIQUE(idempotencyKey) constraint → the driver throws → `run`
        // maps it to a typed `conflict` (the key is globally unique).
        db.insert(schema.writeReceipts)
          .values({
            targetSystem: row.targetSystem,
            canonicalObjectKey: row.canonicalObjectKey,
            idempotencyKey: row.idempotencyKey,
            payloadHash: row.payloadHash,
            receipt: row.receipt ?? null,
            recordedAt: row.recordedAt,
          })
          .onConflictDoUpdate({
            target: [schema.writeReceipts.targetSystem, schema.writeReceipts.canonicalObjectKey],
            set: {
              idempotencyKey: row.idempotencyKey,
              payloadHash: row.payloadHash,
              receipt: row.receipt ?? null,
              recordedAt: row.recordedAt,
            },
          })
          .run();
        return ok(undefined);
      }),
    release: (targetSystem, canonicalObjectKey) =>
      run((): Result<void, DbError> => {
        // Delete ONLY a still-reserved (receipt-less) placeholder so a retry can
        // re-reserve. NEVER delete a committed row — the receipt IS the exactly-once
        // proof; removing it would re-open a duplicate external write (safety rule 3).
        db.delete(schema.writeReceipts)
          .where(and(objectIdentity(targetSystem, canonicalObjectKey), isNull(schema.writeReceipts.receipt)))
          .run();
        return ok(undefined);
      }),
  };

  // Phase-10: System-Health item store (OBS-1/OBS-2, §10.3 dedupe upsert).
  const healthItems: HealthItemRepository = {
    getByDedupeKey: (dedupeKey) =>
      run(() => {
        const row = db.select().from(schema.healthItems).where(eq(schema.healthItems.dedupeKey, dedupeKey)).get();
        return row ? ok(toHealthItem(row)) : err(notFound(`health item ${dedupeKey}`));
      }),
    put: (item, dedupeKey, subjectRef, lastSeen) =>
      run(() => {
        // §10.3 dedupe upsert on the dedupe key: first sight INSERTs (count 1); a
        // repeat UPDATEs the existing row — bump occurrenceCount, refresh lastSeen,
        // overwrite the mutable lifecycle fields, PRESERVE the original openedAt (the
        // conflict `set` deliberately omits openedAt + occurrenceCount-reset).
        db.insert(schema.healthItems)
          .values({
            dedupeKey,
            subjectRef,
            id: item.id,
            failureClass: item.failureClass,
            severity: item.severity,
            message: item.message,
            auditRef: item.auditRef,
            openedAt: item.openedAt,
            state: item.state,
            resolvedAt: item.resolvedAt ?? null,
            parityReportRef: item.parityReportRef ?? null,
            factIdentity: item.factIdentity ?? null,
            lastSeen,
            occurrenceCount: 1,
          })
          .onConflictDoUpdate({
            target: schema.healthItems.dedupeKey,
            set: {
              // Lifecycle + latest-observation fields refresh; openedAt stays put.
              id: item.id,
              severity: item.severity,
              message: item.message,
              auditRef: item.auditRef,
              state: item.state,
              resolvedAt: item.resolvedAt ?? null,
              parityReportRef: item.parityReportRef ?? null,
              factIdentity: item.factIdentity ?? null,
              lastSeen,
              occurrenceCount: sql`${schema.healthItems.occurrenceCount} + 1`,
            },
          })
          .run();
        return ok(undefined);
      }),
    list: () =>
      run(() => {
        const rows = db
          .select()
          .from(schema.healthItems)
          .orderBy(desc(schema.healthItems.lastSeen), asc(schema.healthItems.dedupeKey))
          .all();
        return ok(rows.map(toHealthItem));
      }),
  };

  // Phase-10: durable-schedule bookkeeping store (LIFE-5).
  const scheduleBookkeeping: ScheduleBookkeepingRepository = {
    getBookkeeping: (scheduleId) =>
      run(() => {
        const row = db
          .select()
          .from(schema.scheduleBookkeeping)
          .where(eq(schema.scheduleBookkeeping.scheduleId, scheduleId))
          .get();
        return row ? ok(toScheduleBookkeeping(row)) : err(notFound(`schedule ${scheduleId}`));
      }),
    put: (bookkeeping) =>
      run(() => {
        db.insert(schema.scheduleBookkeeping)
          .values({
            scheduleId: bookkeeping.scheduleId,
            lastRunWall: bookkeeping.lastRunWall,
            lastRunMonotonicMs: bookkeeping.lastRunMonotonicMs ?? null,
            lastRunMonotonicEpoch: bookkeeping.lastRunMonotonicEpoch ?? null,
          })
          .onConflictDoUpdate({
            target: schema.scheduleBookkeeping.scheduleId,
            set: {
              lastRunWall: bookkeeping.lastRunWall,
              lastRunMonotonicMs: bookkeeping.lastRunMonotonicMs ?? null,
              lastRunMonotonicEpoch: bookkeeping.lastRunMonotonicEpoch ?? null,
            },
          })
          .run();
        return ok(undefined);
      }),
  };

  // Phase-10: single-active-instance lease store (LIFE-1) — atomic CAS acquire/renew.
  const instanceLeases: InstanceLeaseRepository = {
    get: (taskQueue) =>
      run(() => {
        const row = db.select().from(schema.instanceLeases).where(eq(schema.instanceLeases.taskQueue, taskQueue)).get();
        return row ? ok(toLease(row)) : err(notFound(`lease ${taskQueue}`));
      }),
    compareAndSet: (expected, next) =>
      run((): Result<boolean, DbError> => {
        if (expected === undefined) {
          // FIRST ACQUIRE: atomic INSERT … ON CONFLICT DO NOTHING on the taskQueue PK.
          // An empty `.returning()` == the slot was already taken (this caller LOST).
          const inserted = db
            .insert(schema.instanceLeases)
            .values({
              taskQueue: next.taskQueue,
              ownerId: next.ownerId,
              acquiredAt: next.acquiredAt,
              expiresAt: next.expiresAt,
              generation: next.generation,
            })
            .onConflictDoNothing({ target: schema.instanceLeases.taskQueue })
            .returning()
            .all();
          return ok(decideLeaseCas({ expected: undefined, stored: inserted.length > 0 ? undefined : next }));
          // NB: on a WIN (inserted) the shared verdict is decideLeaseCas(undefined,
          // undefined)=true; on a LOSS we pass a non-undefined `stored` so the verdict
          // is false — the pure helper is the single source of the win/lose decision.
        }
        // RENEW / RE-ACQUIRE: atomic UPDATE … WHERE every expected field matches (the
        // compare half). Rows affected ⇒ the stored row equalled `expected` ⇒ win.
        const rows = db
          .update(schema.instanceLeases)
          .set({
            ownerId: next.ownerId,
            acquiredAt: next.acquiredAt,
            expiresAt: next.expiresAt,
            generation: next.generation,
          })
          .where(
            and(
              eq(schema.instanceLeases.taskQueue, expected.taskQueue),
              eq(schema.instanceLeases.ownerId, expected.ownerId),
              eq(schema.instanceLeases.acquiredAt, expected.acquiredAt),
              eq(schema.instanceLeases.expiresAt, expected.expiresAt),
              eq(schema.instanceLeases.generation, expected.generation),
            ),
          )
          .returning()
          .all();
        // Interpret via the shared pure verdict: a matched-and-updated row is the WIN;
        // 0 rows means the stored record diverged from `expected` → LOSS.
        return ok(decideLeaseCas({ expected, stored: rows.length > 0 ? expected : undefined }));
      }),
  };

  return {
    workspaceConfig,
    eventLog,
    workflowRunRefs,
    audit,
    approvals,
    outbox,
    pendingKnowledgeMutations,
    knowledgeRevisions,
    connectorCursors,
    providerState,
    readModels,
    gclProjections,
    writeReceipts,
    healthItems,
    scheduleBookkeeping,
    instanceLeases,
  };
}
