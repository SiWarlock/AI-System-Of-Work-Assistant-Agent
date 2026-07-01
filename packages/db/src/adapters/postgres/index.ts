// Postgres operational-store adapter (task 2.4, §4 / REQ-D-002/003, §16).
//
// Implements EVERY repository interface (repositories/interfaces.ts) against the
// pg-core schema (schema/pg/*). DRIVER-AGNOSTIC: the factory takes a Drizzle
// `PgDatabase` handle, so the SAME adapter runs over `drizzle-orm/pglite` (the
// deterministic, server-free PG16 used in tests + the 2.9 contract suite) AND
// `drizzle-orm/node-postgres` (production + the optional Docker-pg gate). Postgres is
// the hosted-compatible store — a REAL working implementation, NOT a stub (§12).
//
// BEHAVIORAL PARITY WITH 2.3 (REQ-D-003): every method matches the SQLite adapter's
// semantics so the single both-dialect contract suite (2.9) passes against both. The
// only differences are dialect mechanics, NOT behavior:
//   - async I/O: pg/pglite query builders are Promises (no sync `.get()/.all()/.run()`
//     like better-sqlite3); single-row reads use `.limit(1)` then `[0]`.
//   - json: pg `json()` columns round-trip native JS objects (no text (de)serialize),
//     so the row→DTO mappers are byte-identical to the SQLite ones.
//   - audit forward order: SQLite uses the implicit `rowid`; Postgres has none, so the
//     append-only audit scan orders by the system `ctid` (physical/insertion order on
//     an append-only heap — see the arch_gap on `audit.query`).
//   - error mapping: SQLSTATE → the same closed DbErrorCode taxonomy (./errors.ts).
//   - upsert/RETURNING: pg-core `onConflictDoUpdate` + `.returning()` mirror sqlite-core.
//
// ERROR CONVENTION (§16): NOTHING throws across a repository boundary. Every method
// returns a typed `Result<T, DbError>` — driver throws are caught and mapped to the
// closed `DbErrorCode` set; an empty lookup is a typed `not_found`, never an exception.
//
// BOUNDARY (§4): this adapter persists ONLY operational state. Append-only logs expose
// no in-place mutate/delete, approvals advance by an atomic compare-and-set, and only
// the REBUILDABLE read-model store exposes a destructive `clear`.
import { and, asc, eq, gt, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
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
import * as schema from "../../schema/pg/index";
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

/** All ten Postgres repositories returned by the factory (one per §4 domain). */
export interface PostgresRepositories {
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

/** Run an async unit-of-work, translating any driver throw to a typed err. */
async function run<T>(fn: () => Promise<Result<T, DbError>>): Promise<Result<T, DbError>> {
  try {
    return await fn();
  } catch (cause) {
    return err(toDbError(cause));
  }
}

// ── row → DTO mappers (DB NULL → contract `undefined` for optional fields) ────
// pg `json()` columns return native JS objects, so these mappers are identical to the
// SQLite adapter's — only the inferred row TYPES come from the pg-core schema.
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
/**
 * Build every operational-store repository over one Postgres Drizzle db. Generic over
 * the driver's query-result HKT so it accepts BOTH `PgliteDatabase` (test/contract
 * suite) and `NodePgDatabase` (prod / Docker-pg) — the adapter never hard-binds a
 * driver (REQ-D-003: dialect-agnostic above the adapter boundary).
 */
export function createPostgresRepositories<TQueryResult extends PgQueryResultHKT>(
  db: PgDatabase<TQueryResult>,
): PostgresRepositories {
  const workspaceConfig: WorkspaceConfigRepository = {
    get: (id) =>
      run(async () => {
        const rows = await db.select().from(schema.workspaceConfig).where(eq(schema.workspaceConfig.id, id)).limit(1);
        const row = rows[0];
        return row ? ok(row as Workspace) : err(notFound(`workspace ${id}`));
      }),
    list: () => run(async () => ok((await db.select().from(schema.workspaceConfig)) as Workspace[])),
    upsert: (ws) =>
      run(async () => {
        await db
          .insert(schema.workspaceConfig)
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
          });
        return ok(ws);
      }),
  };

  const eventLog: EventLogRepository = {
    append: (record) =>
      run(async () => {
        await db.insert(schema.eventLog).values(record);
        return ok(undefined);
      }),
    readSince: (afterEventId, limit) =>
      run(async () => {
        // arch_gap: the event journal has no monotonic sequence column, so the
        // forward-scan total order + cursor semantics are under-specified upstream.
        // Chosen here (PARITY with the SQLite adapter): order by (recordedAt, eventId);
        // a non-null cursor whose eventId is unknown is `not_found`. The cross-dialect
        // contract (2.9) must pin one total order — recordedAt ties on coarse clocks
        // would diverge.
        if (afterEventId === null) {
          const rows = await db
            .select()
            .from(schema.eventLog)
            .orderBy(asc(schema.eventLog.recordedAt), asc(schema.eventLog.eventId))
            .limit(limit);
          return ok(rows.map(toEventLog));
        }
        const cursorRows = await db
          .select()
          .from(schema.eventLog)
          .where(eq(schema.eventLog.eventId, afterEventId))
          .limit(1);
        const cursor = cursorRows[0];
        if (!cursor) return err(notFound(`event ${afterEventId}`));
        const rows = await db
          .select()
          .from(schema.eventLog)
          .where(
            or(
              gt(schema.eventLog.recordedAt, cursor.recordedAt),
              and(eq(schema.eventLog.recordedAt, cursor.recordedAt), gt(schema.eventLog.eventId, afterEventId)),
            ),
          )
          .orderBy(asc(schema.eventLog.recordedAt), asc(schema.eventLog.eventId))
          .limit(limit);
        return ok(rows.map(toEventLog));
      }),
    byWorkflow: (workflowId) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.eventLog)
          .where(eq(schema.eventLog.workflowId, workflowId))
          .orderBy(asc(schema.eventLog.recordedAt), asc(schema.eventLog.eventId));
        return ok(rows.map(toEventLog));
      }),
  };

  const workflowRunRefs: WorkflowRunRefRepository = {
    create: (ref) =>
      run(async () => {
        await db.insert(schema.workflowRunRefs).values(ref);
        return ok(ref);
      }),
    get: (workflowId) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.workflowRunRefs)
          .where(eq(schema.workflowRunRefs.workflowId, workflowId))
          .limit(1);
        const row = rows[0];
        return row ? ok(row as WorkflowRunRef) : err(notFound(`workflow ${workflowId}`));
      }),
    getByIdempotencyKey: (idempotencyKey) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.workflowRunRefs)
          .where(eq(schema.workflowRunRefs.idempotencyKey, idempotencyKey))
          .limit(1);
        const row = rows[0];
        return row ? ok(row as WorkflowRunRef) : err(notFound(`workflow idempotencyKey ${idempotencyKey}`));
      }),
    updateState: (workflowId, state) =>
      run(async () => {
        const rows = await db
          .update(schema.workflowRunRefs)
          .set({ state })
          .where(eq(schema.workflowRunRefs.workflowId, workflowId))
          .returning();
        const row = rows[0];
        return row ? ok(row as WorkflowRunRef) : err(notFound(`workflow ${workflowId}`));
      }),
    appendAuditRef: (workflowId, auditRef) =>
      run(async () => {
        const curRows = await db
          .select()
          .from(schema.workflowRunRefs)
          .where(eq(schema.workflowRunRefs.workflowId, workflowId))
          .limit(1);
        const cur = curRows[0];
        if (!cur) return err(notFound(`workflow ${workflowId}`));
        const auditRefs = [...cur.auditRefs, auditRef];
        const rows = await db
          .update(schema.workflowRunRefs)
          .set({ auditRefs })
          .where(eq(schema.workflowRunRefs.workflowId, workflowId))
          .returning();
        const row = rows[0];
        return row ? ok(row as WorkflowRunRef) : err(notFound(`workflow ${workflowId}`));
      }),
  };

  const audit: AuditRepository = {
    append: (record) =>
      run(async () => {
        await db.insert(schema.auditRecords).values(record);
        return ok(undefined);
      }),
    query: (filter: AuditQuery, limit) =>
      run(async () => {
        const conds = [];
        if (filter.actor !== undefined) conds.push(eq(schema.auditRecords.actor, filter.actor));
        if (filter.event !== undefined) conds.push(eq(schema.auditRecords.event, filter.event));
        // arch_gap: audit has no surrogate id (parity bars one) — its only row identity
        // is the engine's implicit insertion order. SQLite uses `rowid`; Postgres has
        // no rowid, so this uses the system `ctid` (physical row location). On an
        // APPEND-ONLY heap with no updates/deletes (which audit is, by §4) `ctid` ==
        // insertion order, matching the SQLite adapter's forward scan. The
        // dialect-agnostic forward order remains under-specified until 2.9 names it.
        const rows = (await db
          .select()
          .from(schema.auditRecords)
          .where(conds.length > 0 ? and(...conds) : undefined)
          .orderBy(sql`ctid`)) as AuditRecord[];
        const ref = filter.ref;
        const matched = ref === undefined ? rows : rows.filter((r) => r.refs.some((x) => x === ref));
        return ok(matched.slice(0, limit));
      }),
  };

  const approvals: ApprovalRepository = {
    create: (approval) =>
      run(async () => {
        await db.insert(schema.approvals).values(approval);
        return ok(approval);
      }),
    get: (id) =>
      run(async () => {
        const rows = await db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).limit(1);
        const row = rows[0];
        return row ? ok(toApproval(row)) : err(notFound(`approval ${id}`));
      }),
    listByStatus: (status) =>
      run(async () => {
        const rows = await db.select().from(schema.approvals).where(eq(schema.approvals.status, status));
        return ok(rows.map(toApproval));
      }),
    applyTransition: (id, expectedFromStatus, next) =>
      run(async () => {
        // Exactly-once CAS (REQ-F-012, §9), decided by the shared 2.5 invariant so
        // sqlite + pg agree: a true replay (expected==current && target==current)
        // is an idempotent no-op returning ok(current); a stale different-target CAS
        // (or a move out of a tombstoned/terminal record) is a typed conflict; an
        // absent record is not_found. Never a double-apply, never a resurrection.
        const currentRows = await db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).limit(1);
        const currentRow = currentRows[0];
        if (!currentRow) return err(notFound(`approval ${id}`));
        const current = toApproval(currentRow);
        const verdict = decideApprovalCas(current.status, expectedFromStatus, next.status);
        if (verdict.kind !== "apply") return casDbResult(verdict, current, current);
        // Winner: perform the conditional write (WHERE status=expectedFrom is the
        // atomic compare half). `apply` implies current===expectedFrom, so the row
        // matches; a missing row means a concurrent writer moved it → stale.
        const rows = await db
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
          .returning();
        const row = rows[0];
        return row
          ? casDbResult({ kind: "apply" }, toApproval(row), current)
          : casDbResult({ kind: "stale_conflict" }, current, current);
      }),
  };

  const outbox: OutboxRepository = {
    enqueue: (entry) =>
      run(async () => {
        await db.insert(schema.outbox).values(entry);
        return ok(entry);
      }),
    get: (outboxId) =>
      run(async () => {
        const rows = await db.select().from(schema.outbox).where(eq(schema.outbox.outboxId, outboxId)).limit(1);
        const row = rows[0];
        return row ? ok(toOutbox(row)) : err(notFound(`outbox ${outboxId}`));
      }),
    getByIdempotencyKey: (idempotencyKey) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.outbox)
          .where(eq(schema.outbox.idempotencyKey, idempotencyKey))
          .limit(1);
        const row = rows[0];
        return row ? ok(toOutbox(row)) : err(notFound(`outbox idempotencyKey ${idempotencyKey}`));
      }),
    listDue: (now, limit) =>
      run(async () => {
        // arch_gap: outbox `status` is open text (no frozen §9 Proposed-External-Action
        // enum in scope), so "due" is derived: NOT in the terminal set
        // (receipt_recorded|rejected|expired) AND nextAttemptAt is null or elapsed.
        const rows = await db
          .select()
          .from(schema.outbox)
          .where(
            and(
              notInArray(schema.outbox.status, [...OUTBOX_TERMINAL]),
              or(isNull(schema.outbox.nextAttemptAt), lte(schema.outbox.nextAttemptAt, now)),
            ),
          )
          .orderBy(asc(schema.outbox.enqueuedAt), asc(schema.outbox.outboxId))
          .limit(limit);
        return ok(rows.map(toOutbox));
      }),
    update: (entry) =>
      run(async () => {
        const rows = await db
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
          .returning();
        const row = rows[0];
        return row ? ok(toOutbox(row)) : err(notFound(`outbox ${entry.outboxId}`));
      }),
  };

  const connectorCursors: ConnectorCursorRepository = {
    get: (connectorId, workspaceId) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.connectorCursors)
          .where(
            and(
              eq(schema.connectorCursors.connectorId, connectorId),
              eq(schema.connectorCursors.workspaceId, workspaceId),
            ),
          )
          .limit(1);
        const row = rows[0];
        return row ? ok(toCursor(row)) : err(notFound(`cursor ${connectorId}/${workspaceId}`));
      }),
    upsert: (record) =>
      run(async () => {
        await db
          .insert(schema.connectorCursors)
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
          });
        return ok(record);
      }),
    listByConnector: (connectorId) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.connectorCursors)
          .where(eq(schema.connectorCursors.connectorId, connectorId));
        return ok(rows.map(toCursor));
      }),
  };

  const providerState: ProviderStateRepository = {
    get: (provider, endpoint, model) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.providerProfiles)
          .where(
            and(
              eq(schema.providerProfiles.provider, provider),
              eq(schema.providerProfiles.endpoint, endpoint),
              eq(schema.providerProfiles.model, model),
            ),
          )
          .limit(1);
        const row = rows[0];
        return row ? ok(row as ProviderProfile) : err(notFound(`provider ${provider}/${endpoint}/${model}`));
      }),
    list: () => run(async () => ok((await db.select().from(schema.providerProfiles)) as ProviderProfile[])),
    upsert: (profile) =>
      run(async () => {
        await db
          .insert(schema.providerProfiles)
          .values(profile)
          .onConflictDoUpdate({
            target: [schema.providerProfiles.provider, schema.providerProfiles.endpoint, schema.providerProfiles.model],
            set: {
              capabilities: profile.capabilities,
              egressClass: profile.egressClass,
              costCaps: profile.costCaps,
              conformanceStatus: profile.conformanceStatus,
            },
          });
        return ok(profile);
      }),
    setConformanceStatus: (provider, endpoint, model, conformanceStatus) =>
      run(async () => {
        const rows = await db
          .update(schema.providerProfiles)
          .set({ conformanceStatus })
          .where(
            and(
              eq(schema.providerProfiles.provider, provider),
              eq(schema.providerProfiles.endpoint, endpoint),
              eq(schema.providerProfiles.model, model),
            ),
          )
          .returning();
        const row = rows[0];
        return row ? ok(row as ProviderProfile) : err(notFound(`provider ${provider}/${endpoint}/${model}`));
      }),
  };

  const readModels: ReadModelRepository = {
    get: (readModelKey, workspaceId) =>
      run(async () => {
        const cond =
          workspaceId === null
            ? and(eq(schema.readModels.readModelKey, readModelKey), isNull(schema.readModels.workspaceId))
            : and(eq(schema.readModels.readModelKey, readModelKey), eq(schema.readModels.workspaceId, workspaceId));
        const rows = await db.select().from(schema.readModels).where(cond).limit(1);
        const row = rows[0];
        return row ? ok(toReadModel(row)) : err(notFound(`read-model ${readModelKey}/${workspaceId ?? "*"}`));
      }),
    put: (record) =>
      run(async () => {
        // arch_gap: the read_models schema declares NO unique constraint on the logical
        // key (readModelKey, workspaceId) — it's deferred to the 2.6 migration/index
        // layer. Until that index exists, `put` cannot use a true onConflict upsert, so
        // it does an atomic delete-then-insert of the key inside one transaction
        // (rebuildable store, §4 — a destructive op is legal here). Matches the SQLite
        // adapter; Postgres `transaction` is async so it is awaited.
        const cond =
          record.workspaceId === undefined || record.workspaceId === null
            ? and(eq(schema.readModels.readModelKey, record.readModelKey), isNull(schema.readModels.workspaceId))
            : and(
                eq(schema.readModels.readModelKey, record.readModelKey),
                eq(schema.readModels.workspaceId, record.workspaceId),
              );
        await db.transaction(async (tx) => {
          await tx.delete(schema.readModels).where(cond);
          await tx.insert(schema.readModels).values({
            readModelKey: record.readModelKey,
            workspaceId: record.workspaceId ?? null,
            data: record.data,
            rebuiltAt: record.rebuiltAt,
          });
        });
        return ok(record);
      }),
    clear: (readModelKey) =>
      run(async () => {
        await db.delete(schema.readModels).where(eq(schema.readModels.readModelKey, readModelKey));
        return ok(undefined);
      }),
  };

  const gclProjections: GclProjectionRepository = {
    get: (workspaceId, projectionType, visibilityLevel) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.gclProjections)
          .where(
            and(
              eq(schema.gclProjections.workspaceId, workspaceId),
              eq(schema.gclProjections.projectionType, projectionType),
              eq(schema.gclProjections.visibilityLevel, visibilityLevel),
            ),
          )
          .limit(1);
        const row = rows[0];
        return row ? ok(row as GclProjection) : err(notFound(`gcl ${workspaceId}/${projectionType}/${visibilityLevel}`));
      }),
    upsert: (projection) =>
      run(async () => {
        await db
          .insert(schema.gclProjections)
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
          });
        return ok(projection);
      }),
    listByWorkspace: (workspaceId) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.gclProjections)
          .where(eq(schema.gclProjections.workspaceId, workspaceId));
        return ok(rows as GclProjection[]);
      }),
    listByVisibility: (visibilityLevel) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.gclProjections)
          .where(eq(schema.gclProjections.visibilityLevel, visibilityLevel));
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
