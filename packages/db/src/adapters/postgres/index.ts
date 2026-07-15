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
import { and, asc, desc, eq, gt, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { err, ok, ParityReportSchema, type Result } from "@sow/contracts";
import type {
  Approval,
  AuditRecord,
  GclProjection,
  HealthItem,
  ParityReport,
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
  ParityReportRepository,
  ConnectorInstanceRepository,
  ConnectorInstanceRow,
  ConnectorInstanceState,
  PendingKnowledgeMutation,
  PendingKnowledgeMutationRepository,
  ProjectRegistryRepository,
  ProjectRegistryRow,
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
import * as schema from "../../schema/pg/index";
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

/** All Postgres repositories returned by the factory (one per §4 domain + WW-1 receipts). */
export interface PostgresRepositories {
  readonly workspaceConfig: WorkspaceConfigRepository;
  readonly projectRegistry: ProjectRegistryRepository;
  readonly connectorInstance: ConnectorInstanceRepository;
  readonly eventLog: EventLogRepository;
  readonly workflowRunRefs: WorkflowRunRefRepository;
  readonly audit: AuditRepository;
  readonly approvals: ApprovalRepository;
  readonly outbox: OutboxRepository;
  readonly pendingKnowledgeMutations: PendingKnowledgeMutationRepository;
  readonly knowledgeRevisions: KnowledgeRevisionRepository;
  readonly parityReports: ParityReportRepository;
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

type ParityReportDbRow = typeof schema.parityReports.$inferSelect;

/**
 * Re-gate a stored parity-report `payload` back to a validated {@link ParityReport}, AND verify its
 * OWN identity matches the query key. The whole frozen report was persisted as one json column —
 * CANDIDATE DATA on read-back (§16): a corrupt or unparseable blob (or one violating the model's
 * `.refine`) THROWS here, which the surrounding `run()` catches into a typed `err` (fail-closed —
 * never a half-parsed report). Additionally (WS-8 / safety rule 4 defense-in-depth): the parsed
 * payload's `workspaceId`/`reconciledAtRevision` MUST equal the query-key args — the typed `record`
 * always writes column ≡ payload, so a disagreement is an out-of-band-tampered/corrupt row → a FAULT
 * (throw → typed err), NEVER a cross-workspace surface for a query keyed on the denormalized columns.
 * NOT a verbatim cast like `toCommittedRevision` (the KnowledgeWriter is not this row's sole author).
 */
function toParityReport(
  r: ParityReportDbRow,
  expectedWorkspaceId: string,
  expectedReconciledAtRevision: string,
): ParityReport {
  const report = ParityReportSchema.parse(r.payload);
  if (
    report.workspaceId !== expectedWorkspaceId ||
    report.reconciledAtRevision !== expectedReconciledAtRevision
  ) {
    throw new Error(
      `parity-report identity mismatch: stored payload (${report.workspaceId}/${report.reconciledAtRevision}) disagrees with query key (${expectedWorkspaceId}/${expectedReconciledAtRevision})`,
    );
  }
  return report;
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

// Phase-10 durability row types + mappers (identical to the SQLite adapter's — pg
// text/integer columns round-trip the same JS primitives; only the row TYPES differ).
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

  // Durable typed-Project registry (14.6). Nullable columns (planPath, aliases) map
  // NULL → undefined so the row matches the `ProjectRegistryRow` optional-field shape.
  const toProjectRegistryRow = (r: typeof schema.projectRegistry.$inferSelect): ProjectRegistryRow => ({
    projectId: r.projectId,
    workspaceId: r.workspaceId,
    planPath: r.planPath ?? undefined,
    progressProviders: r.progressProviders,
    aliases: r.aliases ?? undefined,
    title: r.title,
    slug: r.slug,
    lifecycleState: r.lifecycleState,
  });
  const projectRegistry: ProjectRegistryRepository = {
    get: (projectId) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.projectRegistry)
          .where(eq(schema.projectRegistry.projectId, projectId))
          .limit(1);
        const row = rows[0];
        return row ? ok(toProjectRegistryRow(row)) : err(notFound(`project ${projectId}`));
      }),
    resolveRef: (ref) =>
      run(async () => {
        // Portable GLOBAL resolve (no dialect-specific JSON operators — forbidden #2): scan +
        // filter in memory. An exact projectId (PRIMARY KEY, globally unique) match takes
        // PRECEDENCE — a project is ALWAYS resolvable by its own key, never shadowed by another
        // project's colliding alias. Only if no projectId matches do we resolve by alias:
        // exactly-one match resolves; zero OR >1 (an alias shared across workspaces) ⇒ not_found
        // (fail-closed — never an arbitrary cross-workspace pick, safety rule 4).
        const rows = await db.select().from(schema.projectRegistry);
        const byId = rows.find((r) => r.projectId === ref);
        if (byId) return ok(toProjectRegistryRow(byId));
        const byAlias = rows.filter((r) => (r.aliases ?? []).includes(ref));
        const only = byAlias.length === 1 ? byAlias[0] : undefined;
        return only ? ok(toProjectRegistryRow(only)) : err(notFound(`project ref ${ref}`));
      }),
    listByWorkspace: (workspaceId) =>
      run(async () =>
        ok(
          (
            await db
              .select()
              .from(schema.projectRegistry)
              .where(eq(schema.projectRegistry.workspaceId, workspaceId))
          ).map(toProjectRegistryRow),
        ),
      ),
    upsert: (entry) =>
      run(async () => {
        await db
          .insert(schema.projectRegistry)
          .values(entry)
          .onConflictDoUpdate({
            target: schema.projectRegistry.projectId,
            set: {
              workspaceId: entry.workspaceId,
              planPath: entry.planPath ?? null,
              progressProviders: entry.progressProviders,
              aliases: entry.aliases ?? null,
              title: entry.title,
              slug: entry.slug,
              lifecycleState: entry.lifecycleState,
            },
          });
        return ok(entry);
      }),
  };

  // Per-workspace connector-instance config registry (14.2). All flat scalar columns, so the
  // row casts directly to ConnectorInstanceRow (no mapper). Async (no .run()/.get()).
  const connectorInstance: ConnectorInstanceRepository = {
    get: (instanceId) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.connectorInstance)
          .where(eq(schema.connectorInstance.instanceId, instanceId))
          .limit(1);
        const row = rows[0];
        return row ? ok(row as ConnectorInstanceRow) : err(notFound(`connector instance ${instanceId}`));
      }),
    listByWorkspace: (workspaceId) =>
      run(async () =>
        ok(
          (await db
            .select()
            .from(schema.connectorInstance)
            .where(eq(schema.connectorInstance.workspaceId, workspaceId))) as ConnectorInstanceRow[],
        ),
      ),
    upsert: (row) =>
      run(async () => {
        await db
          .insert(schema.connectorInstance)
          .values(row)
          .onConflictDoUpdate({
            target: schema.connectorInstance.instanceId,
            set: {
              connectorId: row.connectorId,
              workspaceId: row.workspaceId,
              tokenRef: row.tokenRef,
              state: row.state,
              cadence: row.cadence,
            },
          });
        return ok(row);
      }),
    setState: (instanceId, state: ConnectorInstanceState) =>
      run(async () => {
        await db
          .update(schema.connectorInstance)
          .set({ state })
          .where(eq(schema.connectorInstance.instanceId, instanceId));
        const rows = await db
          .select()
          .from(schema.connectorInstance)
          .where(eq(schema.connectorInstance.instanceId, instanceId))
          .limit(1);
        const row = rows[0];
        return row ? ok(row as ConnectorInstanceRow) : err(notFound(`connector instance ${instanceId}`));
      }),
    setCadence: (instanceId, cadence) =>
      run(async () => {
        await db
          .update(schema.connectorInstance)
          .set({ cadence })
          .where(eq(schema.connectorInstance.instanceId, instanceId));
        const rows = await db
          .select()
          .from(schema.connectorInstance)
          .where(eq(schema.connectorInstance.instanceId, instanceId))
          .limit(1);
        const row = rows[0];
        return row ? ok(row as ConnectorInstanceRow) : err(notFound(`connector instance ${instanceId}`));
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
        // WW-1 (B) no-double-run guard (§9 / LIFE-3), parity with sqlite: INSERT …
        // ON CONFLICT DO NOTHING over BOTH unique keys (workflowId PK AND
        // idempotencyKey UNIQUE); an empty `.returning()` == a lost race → typed
        // `conflict`. Exactly one racing worker wins; the loser reconciles to the
        // winner (resolveRun re-reads by idempotencyKey → reused).
        const inserted = await db.insert(schema.workflowRunRefs).values(ref).onConflictDoNothing().returning();
        if (inserted.length === 0) {
          return err(conflict(`workflow run conflict (duplicate workflowId or idempotencyKey): ${ref.workflowId}`));
        }
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
        if (filter.workspaceId !== undefined)
          conds.push(eq(schema.auditRecords.workspaceId, filter.workspaceId));
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
    listByStatusAndWorkspace: (status, workspaceId) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.approvals)
          .where(and(eq(schema.approvals.status, status), eq(schema.approvals.workspaceId, workspaceId)));
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

  const pendingKnowledgeMutations: PendingKnowledgeMutationRepository = {
    record: (entry) =>
      run(async () => {
        // First-write-wins insert; a duplicate planId collides on the PK → the driver
        // throws a UNIQUE violation which `run`/`toDbError` maps to a typed `conflict`
        // (the §13.10a idempotency gate — mirrors the outbox `enqueue`).
        await db.insert(schema.pendingKnowledgeMutations).values(entry);
        return ok(entry);
      }),
    get: (planId) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.pendingKnowledgeMutations)
          .where(eq(schema.pendingKnowledgeMutations.planId, planId))
          .limit(1);
        const row = rows[0];
        return row ? ok(toPendingKmp(row)) : err(notFound(`pending-kmp ${planId}`));
      }),
    update: (entry) =>
      run(async () => {
        // §13.10a TOCTOU: ONLY `status` + `settledAt` advance on update. `plan`,
        // `payloadHash`, `workspaceId`, and `recordedAt` are IMMUTABLE post-record
        // (structurally — never in the set-clause) so a post-approval plan-swap is
        // unrepresentable on the update path too, not just on first-write-wins record.
        const rows = await db
          .update(schema.pendingKnowledgeMutations)
          .set({
            status: entry.status,
            settledAt: entry.settledAt ?? null,
          })
          .where(eq(schema.pendingKnowledgeMutations.planId, entry.planId))
          .returning();
        const row = rows[0];
        return row ? ok(toPendingKmp(row)) : err(notFound(`pending-kmp ${entry.planId}`));
      }),
  };

  const knowledgeRevisions: KnowledgeRevisionRepository = {
    getByIdempotencyKey: (idempotencyKey) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.knowledgeRevisions)
          .where(eq(schema.knowledgeRevisions.idempotencyKey, idempotencyKey))
          .limit(1);
        const row = rows[0];
        return row
          ? ok(toCommittedRevision(row))
          : err(notFound(`knowledge-revision ${idempotencyKey}`));
      }),
    record: (revision) =>
      run(async () => {
        // FIRST-WRITE-WINS: a duplicate `idempotencyKey` (the PK) is an idempotent NO-OP
        // (ON CONFLICT DO NOTHING → never two revisions for one key; the exactly-once
        // substrate, §16). Unlike the outbox/pending-kmp `conflict`-on-duplicate, the
        // KnowledgeWriter `record` port returns void (no conflict channel) and a same-key
        // commit IS the same commit — so keeping the FIRST write is the safe, idempotent
        // result (the writer already short-circuits via `getByIdempotencyKey`; this is the
        // defensive backstop for a concurrent/replay writer that raced the short-circuit).
        await db.insert(schema.knowledgeRevisions).values(revision).onConflictDoNothing();
        return ok(undefined);
      }),
  };

  const parityReports: ParityReportRepository = {
    record: (report, recordedAt) =>
      run(async () => {
        // FIRST-WRITE-WINS: a duplicate `reportId` (the PK) is an idempotent NO-OP (ON CONFLICT DO
        // NOTHING) — a `ParityReport` is IMMUTABLE operational truth, never two rows per report id
        // (§16). The full frozen report is stored as one json `payload`; the query-key columns are
        // denormalized copies for the serve-time lookup; `recordedAt` supplies the "latest" ordering.
        await db
          .insert(schema.parityReports)
          .values({
            reportId: report.reportId,
            workspaceId: report.workspaceId,
            reconciledAtRevision: report.reconciledAtRevision,
            recordedAt,
            payload: report,
          })
          .onConflictDoNothing();
        return ok(undefined);
      }),
    getLatestForRevision: (workspaceId, reconciledAtRevision) =>
      run(async () => {
        // The NEWEST report (by `recordedAt`, then `reportId` as a DETERMINISTIC tiebreak) for the
        // (workspace, revision) pair — a re-reconcile supersedes — or `ok(undefined)` for a TRUE
        // absence (never reconciled), DISTINCT from a fault (a thrown driver/parse error → the
        // surrounding run() → typed err). The `reportId` secondary key makes two DISTINCT reports at
        // the SAME `recordedAt` resolve to ONE stable winner IDENTICAL on both dialects — never an
        // arbitrary physical-row pick (a trust-gate + dialect-parity concern; mirrors healthItems).
        // `toParityReport` re-gates the stored payload through `ParityReportSchema.parse` (candidate
        // data on read-back). NOTE: `recordedAt` is text, so DESC is chronological only if the B3
        // write-path caller supplies canonical ISO-8601 (UTC, fixed ms precision) via its clock.
        const rows = await db
          .select()
          .from(schema.parityReports)
          .where(
            and(
              eq(schema.parityReports.workspaceId, workspaceId),
              eq(schema.parityReports.reconciledAtRevision, reconciledAtRevision),
            ),
          )
          .orderBy(desc(schema.parityReports.recordedAt), desc(schema.parityReports.reportId))
          .limit(1);
        const row = rows[0];
        return ok(row ? toParityReport(row, workspaceId, reconciledAtRevision) : undefined);
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

  // WW-1 (A) write-receipt index — the cross-process no-duplicate-external-write
  // backstop (§8 / safety rule 3). BEHAVIORAL PARITY with the sqlite adapter: same
  // reserve/put/release/lookup semantics via the SHARED pure `decideReserve`; only
  // the dialect mechanics differ (async Promises; single-row reads via `.limit(1)`).
  const objectIdentity = (targetSystem: string, canonicalObjectKey: string) =>
    and(
      eq(schema.writeReceipts.targetSystem, targetSystem),
      eq(schema.writeReceipts.canonicalObjectKey, canonicalObjectKey),
    );

  const writeReceipts: WriteReceiptRepository = {
    reserve: (targetSystem, canonicalObjectKey) =>
      run(async (): Promise<Result<ReserveOutcome, DbError>> => {
        // Atomic claim: INSERT a receipt-less placeholder ON CONFLICT DO NOTHING over
        // the (targetSystem, canonicalObjectKey) PK. An empty `.returning()` == the
        // row already existed (this caller LOST the race) — same lost-race idiom as
        // applyTransition. The winner INSERTed → `reserved`.
        const insertedRows = await db
          .insert(schema.writeReceipts)
          .values({
            targetSystem,
            canonicalObjectKey,
            // A reserved placeholder carries NO replay key (NULL) — a synthetic key
            // derived from (targetSystem, canonicalObjectKey) is NOT injective
            // (colon-delimited canonical keys collide: ('slack','a:b') and
            // ('slack:a','b') both -> 'slack:a:b') and could also collide with a real
            // committed key, tripping UNIQUE(idempotencyKey) for an object never
            // reserved. NULL sidesteps both: UNIQUE admits many NULLs, and the object
            // identity (composite PK) is the reserve's uniqueness key. `put` sets the
            // real key at commit.
            idempotencyKey: null,
            payloadHash: "",
            receipt: null,
            recordedAt: new Date(0).toISOString(),
          })
          .onConflictDoNothing({ target: [schema.writeReceipts.targetSystem, schema.writeReceipts.canonicalObjectKey] })
          .returning();
        if (insertedRows.length > 0) {
          return ok({ kind: decideReserve({ inserted: true, existingReceiptPresent: false }) } as ReserveOutcome);
        }
        // Lost the INSERT race → re-read the existing row and classify committed vs
        // in_progress by whether a receipt is present.
        const existingRows = await db
          .select()
          .from(schema.writeReceipts)
          .where(objectIdentity(targetSystem, canonicalObjectKey))
          .limit(1);
        const existing = existingRows[0];
        if (!existing) {
          // Row vanished between the failed INSERT and the re-read (a concurrent
          // release of a placeholder) → in_progress; the caller must NOT create.
          return ok({ kind: "in_progress" } as ReserveOutcome);
        }
        const kind = decideReserve({ inserted: false, existingReceiptPresent: receiptPresent(existing) });
        return kind === "committed"
          ? ok({ kind: "committed", record: toWriteReceipt(existing) })
          : ok({ kind } as ReserveOutcome);
      }),
    getByIdempotencyKey: (idempotencyKey) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.writeReceipts)
          .where(eq(schema.writeReceipts.idempotencyKey, idempotencyKey))
          .limit(1);
        const row = rows[0];
        // Only a COMMITTED row is a real receipt; a reservation placeholder carries a
        // synthetic idempotencyKey and no receipt, so it never matches a real lookup.
        return row && receiptPresent(row)
          ? ok(toWriteReceipt(row))
          : err(notFound(`write-receipt idempotencyKey ${idempotencyKey}`));
      }),
    getByCanonicalObjectKey: (targetSystem, canonicalObjectKey) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.writeReceipts)
          .where(objectIdentity(targetSystem, canonicalObjectKey))
          .limit(1);
        const row = rows[0];
        return row && receiptPresent(row)
          ? ok(toWriteReceipt(row))
          : err(notFound(`write-receipt ${targetSystem}/${canonicalObjectKey}`));
      }),
    put: (row) =>
      run(async (): Promise<Result<void, DbError>> => {
        // Upgrade reserved → committed for the object identity (idempotent). ON
        // CONFLICT (composite PK) DO UPDATE writes the committed envelope + receipt.
        // A duplicate idempotencyKey pointing at a DIFFERENT object identity trips the
        // UNIQUE(idempotencyKey) constraint → the driver throws → `run` maps it to a
        // typed `conflict` (23505; the key is globally unique).
        await db
          .insert(schema.writeReceipts)
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
          });
        return ok(undefined);
      }),
    release: (targetSystem, canonicalObjectKey) =>
      run(async (): Promise<Result<void, DbError>> => {
        // Delete ONLY a still-reserved (receipt-less) placeholder so a retry can
        // re-reserve. NEVER delete a committed row — the receipt IS the exactly-once
        // proof; removing it would re-open a duplicate external write (safety rule 3).
        await db
          .delete(schema.writeReceipts)
          .where(and(objectIdentity(targetSystem, canonicalObjectKey), isNull(schema.writeReceipts.receipt)));
        return ok(undefined);
      }),
  };

  // Phase-10: System-Health item store (OBS-1/OBS-2, §10.3 dedupe upsert). BEHAVIORAL
  // PARITY with the sqlite adapter; only dialect mechanics differ (async Promises).
  const healthItems: HealthItemRepository = {
    getByDedupeKey: (dedupeKey) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.healthItems)
          .where(eq(schema.healthItems.dedupeKey, dedupeKey))
          .limit(1);
        const row = rows[0];
        return row ? ok(toHealthItem(row)) : err(notFound(`health item ${dedupeKey}`));
      }),
    put: (item, dedupeKey, subjectRef, lastSeen) =>
      run(async () => {
        // §10.3 dedupe upsert on the dedupe key: first sight INSERTs (count 1); a
        // repeat UPDATEs the existing row — bump occurrenceCount, refresh lastSeen,
        // overwrite the mutable lifecycle fields, PRESERVE the original openedAt.
        await db
          .insert(schema.healthItems)
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
          });
        return ok(undefined);
      }),
    list: () =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.healthItems)
          .orderBy(desc(schema.healthItems.lastSeen), asc(schema.healthItems.dedupeKey));
        return ok(rows.map(toHealthItem));
      }),
  };

  // Phase-10: durable-schedule bookkeeping store (LIFE-5).
  const scheduleBookkeeping: ScheduleBookkeepingRepository = {
    getBookkeeping: (scheduleId) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.scheduleBookkeeping)
          .where(eq(schema.scheduleBookkeeping.scheduleId, scheduleId))
          .limit(1);
        const row = rows[0];
        return row ? ok(toScheduleBookkeeping(row)) : err(notFound(`schedule ${scheduleId}`));
      }),
    put: (bookkeeping) =>
      run(async () => {
        await db
          .insert(schema.scheduleBookkeeping)
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
          });
        return ok(undefined);
      }),
  };

  // Phase-10: single-active-instance lease store (LIFE-1) — atomic CAS acquire/renew.
  const instanceLeases: InstanceLeaseRepository = {
    get: (taskQueue) =>
      run(async () => {
        const rows = await db
          .select()
          .from(schema.instanceLeases)
          .where(eq(schema.instanceLeases.taskQueue, taskQueue))
          .limit(1);
        const row = rows[0];
        return row ? ok(toLease(row)) : err(notFound(`lease ${taskQueue}`));
      }),
    compareAndSet: (expected, next) =>
      run(async (): Promise<Result<boolean, DbError>> => {
        if (expected === undefined) {
          // FIRST ACQUIRE: atomic INSERT … ON CONFLICT DO NOTHING on the taskQueue PK.
          // An empty `.returning()` == the slot was already taken (this caller LOST).
          const inserted = await db
            .insert(schema.instanceLeases)
            .values({
              taskQueue: next.taskQueue,
              ownerId: next.ownerId,
              acquiredAt: next.acquiredAt,
              expiresAt: next.expiresAt,
              generation: next.generation,
            })
            .onConflictDoNothing({ target: schema.instanceLeases.taskQueue })
            .returning();
          return ok(decideLeaseCas({ expected: undefined, stored: inserted.length > 0 ? undefined : next }));
        }
        // RENEW / RE-ACQUIRE: atomic UPDATE … WHERE every expected field matches (the
        // compare half). Rows affected ⇒ the stored row equalled `expected` ⇒ win.
        const rows = await db
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
          .returning();
        return ok(decideLeaseCas({ expected, stored: rows.length > 0 ? expected : undefined }));
      }),
  };

  return {
    workspaceConfig,
    projectRegistry,
    connectorInstance,
    eventLog,
    workflowRunRefs,
    audit,
    approvals,
    outbox,
    pendingKnowledgeMutations,
    knowledgeRevisions,
    parityReports,
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
