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
import { and, asc, eq, isNull, lte, notInArray, or, sql, gt } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { err, ok, type Result } from "@sow/contracts";
import type {
  Approval,
  AuditRecord,
  GclProjection,
  ProviderProfile,
  Workspace,
  WorkflowRunRef,
} from "@sow/contracts";
import type {
  ApprovalRepository,
  AuditQuery,
  AuditRepository,
  ConnectorCursorRecord,
  ConnectorCursorRepository,
  DbError,
  EventLogRecord,
  EventLogRepository,
  GclProjectionRepository,
  OutboxEntry,
  OutboxRepository,
  ProviderStateRepository,
  ReadModelRecord,
  ReadModelRepository,
  WorkflowRunRefRepository,
  WorkspaceConfigRepository,
} from "../../repositories/interfaces";
import * as schema from "../../schema/index";
import {
  casVerdictToResult,
  decideApprovalCas,
  invariantToDbErrorCode,
  type CasVerdict,
} from "../../invariants/operational-truth";
import { notFound, toDbError } from "./errors";

/**
 * Bridge the pure invariant CAS verdict onto the adapter's §16 DbError taxonomy.
 * The exactly-once SEMANTICS live once in `decideApprovalCas`/`casVerdictToResult`
 * (unit 2.5, shared by both dialects); this only re-codes an InvariantViolation as
 * the adapter's enumerable DbError so the rejection re-emits cleanly.
 */
function casDbResult<T>(verdict: CasVerdict, applied: T, current: T): Result<T, DbError> {
  const r = casVerdictToResult(verdict, applied, current);
  return r.ok ? r : err({ code: invariantToDbErrorCode(r.error.code), message: r.error.message });
}

/** All ten SQLite repositories returned by the factory (one per §4 domain). */
export interface SqliteRepositories {
  readonly workspaceConfig: WorkspaceConfigRepository;
  readonly eventLog: EventLogRepository;
  readonly workflowRunRefs: WorkflowRunRefRepository;
  readonly audit: AuditRepository;
  readonly approvals: ApprovalRepository;
  readonly outbox: OutboxRepository;
  readonly connectorCursors: ConnectorCursorRepository;
  readonly providerState: ProviderStateRepository;
  readonly readModels: ReadModelRepository;
  readonly gclProjections: GclProjectionRepository;
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
type CursorRow = typeof schema.connectorCursors.$inferSelect;
type ReadModelRow = typeof schema.readModels.$inferSelect;

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
    actionRef: r.actionRef,
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
        db.insert(schema.workflowRunRefs).values(ref).run();
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
            actionRef: next.actionRef,
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

  return {
    workspaceConfig,
    eventLog,
    workflowRunRefs,
    audit,
    approvals,
    outbox,
    connectorCursors,
    providerState,
    readModels,
    gclProjections,
  };
}
