// spec(§12) — Drizzle repository contract-test posture (both-dialect, REQ-D-003)
// Unit 2.9 — THE REPOSITORY CONTRACT SUITE (the Phase-2 capstone, REQ-D-003 / §12).
//
// ONE parameterized suite that runs IDENTICALLY against BOTH operational-store
// adapters and asserts BEHAVIORAL EQUIVALENCE. Adapter divergence — a case that
// passes on SQLite but fails on Postgres (or vice versa) — is a FAILURE that
// BLOCKS RELEASE (§4 "adapter divergence → release blocked"). The mechanism is a
// `describe.each` over a fixtures table: every `it` below is authored once and
// executed once per adapter, so the SAME assertions must hold for both dialects.
//
// FIXTURES (deterministic, no external server):
//   - sqlite          → createSqliteRepositories(drizzle(new Database(':memory:')))
//   - postgres-pglite → createPostgresRepositories(drizzle(new PGlite()))  (real PG16, in-process)
//   - postgres-docker → OPTIONAL, gated on `process.env.SOW_PG_DOCKER === '1'`:
//       spins a real `postgres:16` container (node-postgres), runs the identical
//       suite, tears the container down. SKIPPED by default (one-line note below) —
//       §12 still treats the default pglite run as a REAL (non-mocked) Postgres.
//
// COVERAGE: every repository interface (CRUD / append / get / list / tombstone
// round-trips) + the four operational-truth invariants from unit 2.5 exercised
// THROUGH the adapters (event-log append-only; audit immutable / tombstone-only;
// approval exactly-once compare-and-set incl. a concurrent / stale-CAS case;
// read-model rebuild vs. not-rebuildable operational truth) + the §16 error
// convention (NO method throws across the boundary — every failure is a typed
// `Result<T, DbError>` with an enumerable `DbErrorCode`).
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isErr,
  isOk,
  validApproval,
  validAuditRecord,
  validGclProjection,
  validHealthItem,
  validProviderProfile,
  validWorkflowRunRef,
  validWorkspace,
  type Approval,
  type ApprovalId,
  type AuditId,
  type HealthItem,
  type Result,
  type WorkflowId,
  type WorkflowRunRef,
  type WorkspaceId,
} from "@sow/contracts";
import type {
  ApprovalRepository,
  AuditRepository,
  ConnectorCursorRecord,
  ConnectorCursorRepository,
  DbError,
  DbErrorCode,
  EventLogRecord,
  EventLogRepository,
  GclProjectionRepository,
  HealthItemRepository,
  InstanceLeaseRepository,
  LeaseRecordRow,
  OutboxEntry,
  OutboxRepository,
  ProviderStateRepository,
  ReadModelRecord,
  ReadModelRepository,
  ScheduleBookkeepingRecord,
  ScheduleBookkeepingRepository,
  WorkflowRunRefRepository,
  WorkspaceConfigRepository,
  WriteReceiptRepository,
  WriteReceiptRow,
} from "../../src/repositories/interfaces";
import { createSqliteRepositories } from "../../src/adapters/sqlite/index";
import { createPostgresRepositories } from "../../src/adapters/postgres/index";
import * as pgSchema from "../../src/schema/pg/index";
import { createSqliteSchema } from "../adapters/create-sqlite-schema";
import { createPgSchema } from "../adapters/create-pg-schema";

// ── the dialect-agnostic repository surface both factories return ──────────────
// `SqliteRepositories` and `PostgresRepositories` are structurally identical (one
// repo per §4 domain, each typed by the SAME interface). Declaring the common
// shape here lets the parameterized cases hold either adapter's repos behind one
// static type — which is itself a contract assertion (the surfaces cannot drift).
interface OperationalRepositories {
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
  readonly writeReceipts: WriteReceiptRepository;
  readonly healthItems: HealthItemRepository;
  readonly scheduleBookkeeping: ScheduleBookkeepingRepository;
  readonly instanceLeases: InstanceLeaseRepository;
}

interface AdapterHandle {
  readonly repos: OperationalRepositories;
  readonly teardown: () => Promise<void>;
}

interface AdapterCase {
  readonly name: string;
  readonly setup: () => Promise<AdapterHandle>;
}

// The closed §16 taxonomy — every typed error MUST carry one of these codes.
const DB_ERROR_CODES: readonly DbErrorCode[] = [
  "not_found",
  "conflict",
  "constraint_violation",
  "serialization_failure",
  "unavailable",
  "unknown",
];

// ── fixtures ──────────────────────────────────────────────────────────────────
const sqliteFixture: AdapterCase = {
  name: "sqlite",
  setup: async () => {
    const sqlite = new Database(":memory:");
    createSqliteSchema(sqlite);
    const repos = createSqliteRepositories(drizzleSqlite(sqlite));
    return {
      repos,
      teardown: async () => {
        sqlite.close();
      },
    };
  },
};

const pglitePgFixture: AdapterCase = {
  name: "postgres-pglite",
  setup: async () => {
    const client = new PGlite();
    await createPgSchema(client);
    const repos = createPostgresRepositories(drizzlePglite(client));
    return {
      repos,
      teardown: async () => {
        await client.close();
      },
    };
  },
};

// Optional Docker-pg fixture (postgres:16 via node-postgres). Constructed ONLY when
// SOW_PG_DOCKER === '1'; spins/tears the container with `docker run`/`docker rm`.
// Same `pg-core` schema DDL as the pglite helper, run through the node-postgres pool.
const PG_TABLES: readonly PgTable[] = [
  pgSchema.workspaceConfig,
  pgSchema.eventLog,
  pgSchema.workflowRunRefs,
  pgSchema.auditRecords,
  pgSchema.approvals,
  pgSchema.outbox,
  pgSchema.connectorCursors,
  pgSchema.providerProfiles,
  pgSchema.readModels,
  pgSchema.gclProjections,
  pgSchema.writeReceipts,
  pgSchema.healthItems,
  pgSchema.scheduleBookkeeping,
  pgSchema.instanceLeases,
];

function pgDdlStatements(): string[] {
  return PG_TABLES.map((table) => {
    const cfg = getTableConfig(table);
    const defs: string[] = cfg.columns.map((col) => {
      let def = `"${col.name}" ${col.getSQLType()}`;
      if (col.notNull) def += " NOT NULL";
      if (col.primary) def += " PRIMARY KEY";
      if (col.isUnique) def += " UNIQUE";
      return def;
    });
    for (const pk of cfg.primaryKeys) {
      const cols = pk.columns.map((c) => `"${c.name}"`).join(", ");
      defs.push(`PRIMARY KEY (${cols})`);
    }
    // Table-level UNIQUE constraints (WW-1: workflow_run_refs.idempotencyKey +
    // write_receipts.idempotencyKey) — the cross-process no-double-write guard.
    for (const uq of cfg.uniqueConstraints) {
      const cols = uq.columns.map((c) => `"${c.name}"`).join(", ");
      defs.push(`UNIQUE (${cols})`);
    }
    return `CREATE TABLE IF NOT EXISTS "${cfg.name}" (\n  ${defs.join(",\n  ")}\n);`;
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function dockerPgFixture(): AdapterCase {
  const container = `sow-contract-pg-${process.pid}-${Date.now()}`;
  const port = Number(process.env.SOW_PG_DOCKER_PORT ?? "54329");
  const conn = `postgresql://sow:sow@127.0.0.1:${port}/sow_contract`;
  return {
    name: "postgres-docker",
    setup: async () => {
      const { execFileSync } = await import("node:child_process");
      execFileSync(
        "docker",
        [
          "run", "-d", "--rm", "--name", container,
          "-e", "POSTGRES_USER=sow",
          "-e", "POSTGRES_PASSWORD=sow",
          "-e", "POSTGRES_DB=sow_contract",
          "-p", `${port}:5432`,
          "postgres:16",
        ],
        { stdio: "pipe" },
      );
      const { Pool } = await import("pg");
      const { drizzle: drizzlePg } = await import("drizzle-orm/node-postgres");
      const pool = new Pool({ connectionString: conn });
      // Readiness: retry `select 1` until the server accepts connections (~60s cap).
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        try {
          await pool.query("select 1");
          ready = true;
        } catch {
          await sleep(1000);
        }
      }
      if (!ready) {
        execFileSync("docker", ["rm", "-f", container], { stdio: "pipe" });
        throw new Error("postgres:16 Docker container never became ready");
      }
      for (const stmt of pgDdlStatements()) await pool.query(stmt);
      const repos = createPostgresRepositories(drizzlePg(pool));
      return {
        repos,
        teardown: async () => {
          await pool.end();
          execFileSync("docker", ["rm", "-f", container], { stdio: "pipe" });
        },
      };
    },
  };
}

const dockerEnabled = process.env.SOW_PG_DOCKER === "1";
const ADAPTERS: readonly AdapterCase[] = [
  sqliteFixture,
  pglitePgFixture,
  ...(dockerEnabled ? [dockerPgFixture()] : []),
];
if (!dockerEnabled) {
  // The default. One-line SKIP note — set SOW_PG_DOCKER=1 to additionally run the
  // suite against a real postgres:16 Docker container via node-postgres.
  // eslint-disable-next-line no-console
  console.info(
    "[repository-contract] SKIP optional Docker-pg run (SOW_PG_DOCKER!=1); default fixtures = sqlite + postgres-pglite (real in-process PG16).",
  );
}

// ── Result unwrap helpers (a typed err where ok was expected is a test failure) ─
function unwrap<T>(r: Result<T, DbError>): T {
  if (!isOk(r)) throw new Error(`expected ok, got err: ${JSON.stringify(r.error)}`);
  return r.value;
}
function unwrapErr<T>(r: Result<T, DbError>): DbError {
  if (!isErr(r)) throw new Error(`expected err, got ok: ${JSON.stringify(r)}`);
  return r.error;
}

// ── DTO factories (non-frozen operational records) ────────────────────────────
function evt(over: Partial<EventLogRecord> & Pick<EventLogRecord, "eventId">): EventLogRecord {
  return {
    eventName: "workflow.started",
    occurredAt: "2026-06-30T00:00:00.000Z",
    recordedAt: "2026-06-30T00:00:00.000Z",
    ...over,
  };
}
function outboxEntry(over: Partial<OutboxEntry> & Pick<OutboxEntry, "outboxId">): OutboxEntry {
  return {
    actionRef: "act-001",
    workspaceId: "ws-001",
    targetSystem: "todoist",
    canonicalObjectKey: "todoist:task:x",
    idempotencyKey: `idem-${over.outboxId}`,
    payloadHash: "sha256:deadbeef",
    status: "proposed",
    payload: { title: "do the thing" },
    attempts: 0,
    enqueuedAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    ...over,
  };
}
function cursor(
  over: Partial<ConnectorCursorRecord> & Pick<ConnectorCursorRecord, "connectorId" | "workspaceId">,
): ConnectorCursorRecord {
  return {
    status: "healthy",
    updatedAt: "2026-06-30T00:00:00.000Z",
    ...over,
  };
}
function readModel(over: Partial<ReadModelRecord> & Pick<ReadModelRecord, "readModelKey">): ReadModelRecord {
  return {
    workspaceId: "ws-001",
    data: { count: 1 },
    rebuiltAt: "2026-06-30T00:00:00.000Z",
    ...over,
  };
}
function writeReceiptRow(
  over: Partial<WriteReceiptRow> &
    Pick<WriteReceiptRow, "targetSystem" | "canonicalObjectKey" | "idempotencyKey">,
): WriteReceiptRow {
  return {
    payloadHash: "sha256:deadbeef",
    receipt: {
      externalObjectId: `ext-${over.canonicalObjectKey}`,
      recordedAt: "2026-06-30T00:00:05.000Z",
    },
    recordedAt: "2026-06-30T00:00:05.000Z",
    ...over,
  };
}
function health(over: Partial<HealthItem> = {}): HealthItem {
  return { ...validHealthItem, ...over };
}
function bk(
  over: Partial<ScheduleBookkeepingRecord> & Pick<ScheduleBookkeepingRecord, "scheduleId">,
): ScheduleBookkeepingRecord {
  return {
    lastRunWall: "2026-06-30T00:00:00.000Z",
    ...over,
  };
}
function lease(over: Partial<LeaseRecordRow> & Pick<LeaseRecordRow, "taskQueue">): LeaseRecordRow {
  return {
    ownerId: "worker-A",
    acquiredAt: "2026-06-30T00:00:00.000Z",
    expiresAt: "2026-06-30T00:00:30.000Z",
    generation: 1,
    ...over,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// THE PARAMETERIZED CONTRACT — one authoring, run once per adapter fixture.
// ══════════════════════════════════════════════════════════════════════════════
describe.each(ADAPTERS)("repository contract :: $name", (adapter) => {
  let handle: AdapterHandle;
  let repos: OperationalRepositories;

  beforeEach(async () => {
    handle = await adapter.setup();
    repos = handle.repos;
  });
  afterEach(async () => {
    await handle.teardown();
  });

  // ── factory surface ──────────────────────────────────────────────────────────
  describe("factory surface", () => {
    it("exposes one repository per operational-store domain", () => {
      expect(typeof repos.workspaceConfig.get).toBe("function");
      expect(typeof repos.eventLog.append).toBe("function");
      expect(typeof repos.workflowRunRefs.create).toBe("function");
      expect(typeof repos.audit.append).toBe("function");
      expect(typeof repos.approvals.applyTransition).toBe("function");
      expect(typeof repos.outbox.enqueue).toBe("function");
      expect(typeof repos.connectorCursors.upsert).toBe("function");
      expect(typeof repos.providerState.upsert).toBe("function");
      expect(typeof repos.readModels.put).toBe("function");
      expect(typeof repos.gclProjections.upsert).toBe("function");
      expect(typeof repos.writeReceipts.reserve).toBe("function");
      expect(typeof repos.healthItems.put).toBe("function");
      expect(typeof repos.scheduleBookkeeping.put).toBe("function");
      expect(typeof repos.instanceLeases.compareAndSet).toBe("function");
    });
  });

  // ── workspace config (MUTABLE upsert aggregate) ──────────────────────────────
  describe("WorkspaceConfigRepository", () => {
    it("upsert → get round-trips the whole aggregate incl. nested json", async () => {
      expect(unwrap(await repos.workspaceConfig.upsert(validWorkspace))).toEqual(validWorkspace);
      const got = unwrap(await repos.workspaceConfig.get(validWorkspace.id));
      expect(got).toEqual(validWorkspace);
      expect(got.egressPolicy).toEqual(validWorkspace.egressPolicy);
      expect(got.providerMatrix).toEqual(validWorkspace.providerMatrix);
    });

    it("upsert is idempotent-by-key: a second upsert UPDATEs in place, no conflict", async () => {
      unwrap(await repos.workspaceConfig.upsert(validWorkspace));
      const renamed = { ...validWorkspace, name: "Acme API (renamed)" };
      expect(unwrap(await repos.workspaceConfig.upsert(renamed)).name).toBe("Acme API (renamed)");
      const list = unwrap(await repos.workspaceConfig.list());
      expect(list).toHaveLength(1);
      expect(list[0]?.name).toBe("Acme API (renamed)");
    });

    it("get on a missing id returns a typed not_found (never throws)", async () => {
      expect(unwrapErr(await repos.workspaceConfig.get(validWorkspace.id)).code).toBe("not_found");
    });
  });

  // ── event log (APPEND-ONLY forward scan) ─────────────────────────────────────
  describe("EventLogRepository", () => {
    it("append then readSince(null) returns events in forward order", async () => {
      unwrap(await repos.eventLog.append(evt({ eventId: "e1", recordedAt: "2026-06-30T00:00:01.000Z" })));
      unwrap(await repos.eventLog.append(evt({ eventId: "e2", recordedAt: "2026-06-30T00:00:02.000Z" })));
      unwrap(await repos.eventLog.append(evt({ eventId: "e3", recordedAt: "2026-06-30T00:00:03.000Z" })));
      const all = unwrap(await repos.eventLog.readSince(null, 10));
      expect(all.map((e) => e.eventId)).toEqual(["e1", "e2", "e3"]);
    });

    it("readSince(cursor) scans strictly AFTER the cursor, capped by limit", async () => {
      unwrap(await repos.eventLog.append(evt({ eventId: "e1", recordedAt: "2026-06-30T00:00:01.000Z" })));
      unwrap(await repos.eventLog.append(evt({ eventId: "e2", recordedAt: "2026-06-30T00:00:02.000Z" })));
      unwrap(await repos.eventLog.append(evt({ eventId: "e3", recordedAt: "2026-06-30T00:00:03.000Z" })));
      expect(unwrap(await repos.eventLog.readSince("e1", 10)).map((e) => e.eventId)).toEqual(["e2", "e3"]);
      expect(unwrap(await repos.eventLog.readSince("e1", 1)).map((e) => e.eventId)).toEqual(["e2"]);
    });

    it("byWorkflow filters to one workflow's events; optional fields round-trip (NULL→undefined)", async () => {
      unwrap(
        await repos.eventLog.append(evt({ eventId: "e1", workflowId: "wf-1", workspaceId: "ws-001", payload: { a: 1 } })),
      );
      unwrap(await repos.eventLog.append(evt({ eventId: "e2", workflowId: "wf-2" })));
      const wf1 = unwrap(await repos.eventLog.byWorkflow("wf-1" as WorkflowId));
      expect(wf1.map((e) => e.eventId)).toEqual(["e1"]);
      expect(wf1[0]?.payload).toEqual({ a: 1 });
      expect(wf1[0]?.workspaceId).toBe("ws-001");
      const wf2 = unwrap(await repos.eventLog.byWorkflow("wf-2" as WorkflowId));
      expect(wf2[0]?.workspaceId).toBeUndefined();
      expect(wf2[0]?.payload).toBeUndefined();
    });

    it("appending a duplicate eventId is a typed conflict (append-only PK)", async () => {
      unwrap(await repos.eventLog.append(evt({ eventId: "e1" })));
      expect(unwrapErr(await repos.eventLog.append(evt({ eventId: "e1" }))).code).toBe("conflict");
    });

    it("readSince with an unknown cursor returns a typed not_found", async () => {
      expect(unwrapErr(await repos.eventLog.readSince("nope", 10)).code).toBe("not_found");
    });
  });

  // ── workflow run registry (idempotent replay reuse) ──────────────────────────
  describe("WorkflowRunRefRepository", () => {
    it("create → get / getByIdempotencyKey round-trips, incl. auditRefs json", async () => {
      unwrap(await repos.workflowRunRefs.create(validWorkflowRunRef));
      expect(unwrap(await repos.workflowRunRefs.get(validWorkflowRunRef.workflowId))).toEqual(validWorkflowRunRef);
      const byKey = unwrap(await repos.workflowRunRefs.getByIdempotencyKey(validWorkflowRunRef.idempotencyKey));
      expect(byKey.workflowId).toBe(validWorkflowRunRef.workflowId);
    });

    it("updateState mutates state; appendAuditRef grows the audit trail append-only", async () => {
      unwrap(await repos.workflowRunRefs.create(validWorkflowRunRef));
      expect(
        unwrap(await repos.workflowRunRefs.updateState(validWorkflowRunRef.workflowId, "completed")).state,
      ).toBe("completed");
      const grown = unwrap(
        await repos.workflowRunRefs.appendAuditRef(validWorkflowRunRef.workflowId, "audit-002" as AuditId),
      );
      expect(grown.auditRefs).toEqual([...validWorkflowRunRef.auditRefs, "audit-002"]);
    });

    it("getByIdempotencyKey on a novel key returns not_found (drives replay reuse)", async () => {
      expect(unwrapErr(await repos.workflowRunRefs.getByIdempotencyKey("never-seen")).code).toBe("not_found");
    });

    it("create with a duplicate workflowId is a typed conflict", async () => {
      unwrap(await repos.workflowRunRefs.create(validWorkflowRunRef));
      expect(unwrapErr(await repos.workflowRunRefs.create(validWorkflowRunRef)).code).toBe("conflict");
    });

    // WW-1 (B) no-double-run guard (§9 / LIFE-3): a SECOND create carrying the SAME
    // idempotencyKey but a DIFFERENT workflowId must be a typed `conflict` (the loser
    // of the cross-process race), NOT a silent second insert (which would start a
    // duplicate run). getByIdempotencyKey then returns the FIRST (winner) row so
    // resolveRun can reconcile the loser to the winner (exactly-once).
    it("create with a duplicate idempotencyKey (different workflowId) is a typed conflict; the winner row survives", async () => {
      unwrap(await repos.workflowRunRefs.create(validWorkflowRunRef));
      const dupKey: WorkflowRunRef = {
        ...validWorkflowRunRef,
        workflowId: "wf-would-be-dup" as WorkflowId,
      };
      expect(unwrapErr(await repos.workflowRunRefs.create(dupKey)).code).toBe("conflict");
      // The winner (first) row is the one indexed by the idempotencyKey — the loser's
      // candidate workflowId was NEVER persisted (no duplicate run).
      const byKey = unwrap(await repos.workflowRunRefs.getByIdempotencyKey(validWorkflowRunRef.idempotencyKey));
      expect(byKey.workflowId).toBe(validWorkflowRunRef.workflowId);
      expect(unwrapErr(await repos.workflowRunRefs.get("wf-would-be-dup" as WorkflowId)).code).toBe("not_found");
    });

    it("updateState on a missing workflow returns not_found", async () => {
      expect(unwrapErr(await repos.workflowRunRefs.updateState(validWorkflowRunRef.workflowId, "failed")).code).toBe(
        "not_found",
      );
    });
  });

  // ── audit trail (APPEND-ONLY / IMMUTABLE; summaries only) ─────────────────────
  describe("AuditRepository", () => {
    it("append → query round-trips; filters AND-combine; ref containment matches", async () => {
      unwrap(await repos.audit.append(validAuditRecord));
      unwrap(
        await repos.audit.append({ ...validAuditRecord, actor: "user:cody", event: "approval.decided", refs: ["appr-001"] }),
      );
      unwrap(
        await repos.audit.append({ ...validAuditRecord, actor: "user:cody", event: "approval.decided", refs: ["appr-002"] }),
      );
      expect(unwrap(await repos.audit.query({ actor: "KnowledgeWriter" }, 10))).toHaveLength(1);
      expect(unwrap(await repos.audit.query({ event: "approval.decided" }, 10))).toHaveLength(2);
      expect(unwrap(await repos.audit.query({ actor: "user:cody", event: "approval.decided" }, 10))).toHaveLength(2);
      const byRef = unwrap(await repos.audit.query({ ref: "appr-001" }, 10));
      expect(byRef).toHaveLength(1);
      expect(byRef[0]?.refs).toContain("appr-001");
    });

    it("query honors the limit cap (forward order)", async () => {
      for (let i = 0; i < 5; i++) unwrap(await repos.audit.append({ ...validAuditRecord, refs: [`r${i}`] }));
      expect(unwrap(await repos.audit.query({}, 2))).toHaveLength(2);
    });

    it("round-trips + scope-filters the optional workspaceId (the §9.5 recent-changes projector's WS-8 filter)", async () => {
      unwrap(await repos.audit.append({ ...validAuditRecord, event: "e.pb", workspaceId: "personal-business" }));
      unwrap(await repos.audit.append({ ...validAuditRecord, event: "e.ew", workspaceId: "employer-work" }));
      unwrap(await repos.audit.append({ ...validAuditRecord, event: "e.global" })); // no workspaceId (a global event)
      // the workspace filter returns ONLY that workspace's rows; a NULL-workspace (global) row is NOT returned.
      const pb = unwrap(await repos.audit.query({ workspaceId: "personal-business" }, 10));
      expect(pb).toHaveLength(1);
      expect(pb[0]?.workspaceId).toBe("personal-business");
      expect(pb[0]?.event).toBe("e.pb");
      expect(unwrap(await repos.audit.query({ workspaceId: "employer-work" }, 10))).toHaveLength(1);
      // an unscoped query still sees all three (incl. the global one, whose workspaceId is null/undefined).
      expect(unwrap(await repos.audit.query({}, 10))).toHaveLength(3);
    });
  });

  // ── approvals (exactly-once compare-and-set transition) ──────────────────────
  describe("ApprovalRepository", () => {
    it("create → get / listByStatus round-trips", async () => {
      unwrap(await repos.approvals.create(validApproval));
      expect(unwrap(await repos.approvals.get(validApproval.id))).toEqual(validApproval);
      expect(unwrap(await repos.approvals.listByStatus("pending")).map((a) => a.id)).toEqual([validApproval.id]);
    });

    it("optional snoozeUntil round-trips for a deferred approval (null↔undefined)", async () => {
      const deferred: Approval = { ...validApproval, status: "deferred", snoozeUntil: "2026-07-01T00:00:00.000Z" };
      unwrap(await repos.approvals.create(deferred));
      const got = unwrap(await repos.approvals.get(deferred.id));
      expect(got.snoozeUntil).toBe("2026-07-01T00:00:00.000Z");
      expect(got.expiresAt).toBeUndefined();
    });

    it("applyTransition is EXACTLY ONCE: the winning CAS applies (applied:true), a true replay is an idempotent no-op (applied:false) returning ok(current)", async () => {
      unwrap(await repos.approvals.create(validApproval));
      const next: Approval = { ...validApproval, status: "approved" };
      // A GENUINE durable transition: the record moves to the target AND `applied` is
      // true — this caller caused it (only it may drive a downstream dispatch).
      const first = unwrap(await repos.approvals.applyTransition(validApproval.id, "pending", next));
      expect(first.approval.status).toBe("approved");
      expect(first.applied).toBe(true);
      // A TRUE replay (same expectedFrom + same target as the landed transition) is
      // an idempotent no-op: it returns ok(current) with `applied` FALSE (it did NOT
      // cause the transition), NOT a second apply and NOT a conflict — matching the
      // Approval domain machine's idempotentTerminalReentry AND closing the
      // exactly-once TOCTOU (the caller learns it must not dispatch again).
      const replay = unwrap(await repos.approvals.applyTransition(validApproval.id, "pending", next));
      expect(replay.approval.status).toBe("approved");
      expect(replay.applied).toBe(false);
      expect(unwrap(await repos.approvals.get(validApproval.id)).status).toBe("approved");
    });

    it("applyTransition on a missing approval returns not_found", async () => {
      const next: Approval = { ...validApproval, status: "approved" };
      expect(unwrapErr(await repos.approvals.applyTransition(validApproval.id, "pending", next)).code).toBe("not_found");
    });

    it("create with a duplicate id is a typed conflict", async () => {
      unwrap(await repos.approvals.create(validApproval));
      expect(unwrapErr(await repos.approvals.create(validApproval)).code).toBe("conflict");
    });
  });

  // ── outbox (idempotency gate + due-query tombstoning) ────────────────────────
  describe("OutboxRepository", () => {
    it("enqueue → get / getByIdempotencyKey round-trips incl. payload + writeReceipt json", async () => {
      unwrap(await repos.outbox.enqueue(outboxEntry({ outboxId: "o1" })));
      expect(unwrap(await repos.outbox.get("o1")).outboxId).toBe("o1");
      const byKey = unwrap(await repos.outbox.getByIdempotencyKey("idem-o1"));
      expect(byKey.outboxId).toBe("o1");
      expect(byKey.payload).toEqual({ title: "do the thing" });
    });

    it("getByIdempotencyKey on a novel key returns not_found (the §8 replay gate)", async () => {
      expect(unwrapErr(await repos.outbox.getByIdempotencyKey("never")).code).toBe("not_found");
    });

    it("update advances status + receipt; a terminal (receipt_recorded) entry drops out of listDue", async () => {
      unwrap(await repos.outbox.enqueue(outboxEntry({ outboxId: "o1" })));
      const committed = unwrap(
        await repos.outbox.update({
          ...outboxEntry({ outboxId: "o1" }),
          status: "receipt_recorded",
          writeReceipt: { externalObjectId: "ext-1", recordedAt: "2026-06-30T00:00:05.000Z" },
          attempts: 1,
          updatedAt: "2026-06-30T00:00:05.000Z",
        }),
      );
      expect(committed.status).toBe("receipt_recorded");
      expect(unwrap(await repos.outbox.get("o1")).writeReceipt).toEqual({
        externalObjectId: "ext-1",
        recordedAt: "2026-06-30T00:00:05.000Z",
      });
      expect(unwrap(await repos.outbox.listDue("2026-06-30T01:00:00.000Z", 10))).toHaveLength(0);
    });

    it("listDue returns non-terminal entries whose nextAttemptAt has elapsed; future retries are excluded", async () => {
      unwrap(await repos.outbox.enqueue(outboxEntry({ outboxId: "due-now", status: "proposed" })));
      unwrap(
        await repos.outbox.enqueue(
          outboxEntry({ outboxId: "retry-elapsed", status: "retry_queued", nextAttemptAt: "2026-06-30T00:30:00.000Z" }),
        ),
      );
      unwrap(
        await repos.outbox.enqueue(
          outboxEntry({ outboxId: "retry-future", status: "retry_queued", nextAttemptAt: "2026-06-30T23:59:00.000Z" }),
        ),
      );
      const due = unwrap(await repos.outbox.listDue("2026-06-30T01:00:00.000Z", 10));
      expect(due.map((e) => e.outboxId).sort()).toEqual(["due-now", "retry-elapsed"]);
    });

    it("enqueue with a duplicate outboxId is a typed conflict", async () => {
      unwrap(await repos.outbox.enqueue(outboxEntry({ outboxId: "o1" })));
      expect(unwrapErr(await repos.outbox.enqueue(outboxEntry({ outboxId: "o1" }))).code).toBe("conflict");
    });
  });

  // ── connector cursors (composite-key upsert) ─────────────────────────────────
  describe("ConnectorCursorRepository", () => {
    it("upsert advances the cursor for one (connector, workspace); get + listByConnector round-trip", async () => {
      unwrap(await repos.connectorCursors.upsert(cursor({ connectorId: "gcal", workspaceId: "ws-001", cursor: "c1" })));
      unwrap(await repos.connectorCursors.upsert(cursor({ connectorId: "gcal", workspaceId: "ws-002", cursor: "c2" })));
      expect(unwrap(await repos.connectorCursors.get("gcal", "ws-001")).cursor).toBe("c1");

      unwrap(
        await repos.connectorCursors.upsert(
          cursor({ connectorId: "gcal", workspaceId: "ws-001", cursor: "c1-next", status: "degraded" }),
        ),
      );
      const advanced = unwrap(await repos.connectorCursors.get("gcal", "ws-001"));
      expect(advanced.cursor).toBe("c1-next");
      expect(advanced.status).toBe("degraded");
      expect(unwrap(await repos.connectorCursors.listByConnector("gcal"))).toHaveLength(2);
    });

    it("get on a missing (connector, workspace) returns not_found", async () => {
      expect(unwrapErr(await repos.connectorCursors.get("gcal", "ws-zzz")).code).toBe("not_found");
    });
  });

  // ── provider state (no-secret; conformance mutation) ─────────────────────────
  describe("ProviderStateRepository", () => {
    it("upsert → get / list round-trips incl. capabilities + costCaps json", async () => {
      unwrap(await repos.providerState.upsert(validProviderProfile));
      const got = unwrap(
        await repos.providerState.get(
          validProviderProfile.provider,
          validProviderProfile.endpoint,
          validProviderProfile.model,
        ),
      );
      expect(got).toEqual(validProviderProfile);
      expect(unwrap(await repos.providerState.list())).toHaveLength(1);
    });

    it("setConformanceStatus updates only conformanceStatus and returns the full profile", async () => {
      unwrap(await repos.providerState.upsert(validProviderProfile));
      const updated = unwrap(
        await repos.providerState.setConformanceStatus(
          validProviderProfile.provider,
          validProviderProfile.endpoint,
          validProviderProfile.model,
          "failing",
        ),
      );
      expect(updated.conformanceStatus).toBe("failing");
      expect(updated.capabilities).toEqual(validProviderProfile.capabilities);
    });

    it("setConformanceStatus on a missing profile returns not_found", async () => {
      expect(unwrapErr(await repos.providerState.setConformanceStatus("claude", "https://x", "m", "passing")).code).toBe(
        "not_found",
      );
    });
  });

  // ── read models (REBUILDABLE: put/clear are legal here) ──────────────────────
  describe("ReadModelRepository", () => {
    it("put → get round-trips; a second put for the same key UPDATEs in place", async () => {
      unwrap(await repos.readModels.put(readModel({ readModelKey: "system_health", data: { ok: 1 } })));
      expect(unwrap(await repos.readModels.get("system_health", "ws-001")).data).toEqual({ ok: 1 });
      unwrap(await repos.readModels.put(readModel({ readModelKey: "system_health", data: { ok: 2 } })));
      expect(unwrap(await repos.readModels.get("system_health", "ws-001")).data).toEqual({ ok: 2 });
    });

    it("a global (workspaceId null) read model round-trips distinctly from a scoped one", async () => {
      unwrap(await repos.readModels.put(readModel({ readModelKey: "global_rollup", workspaceId: undefined, data: { g: 1 } })));
      unwrap(await repos.readModels.put(readModel({ readModelKey: "global_rollup", workspaceId: "ws-001", data: { s: 1 } })));
      expect(unwrap(await repos.readModels.get("global_rollup", null)).data).toEqual({ g: 1 });
      expect(unwrap(await repos.readModels.get("global_rollup", "ws-001")).data).toEqual({ s: 1 });
    });

    it("get on a missing read model returns not_found", async () => {
      expect(unwrapErr(await repos.readModels.get("nope", null)).code).toBe("not_found");
    });
  });

  // ── gcl projections (DERIVED; composite-key upsert, the WS-8 read path) ──────
  describe("GclProjectionRepository", () => {
    it("upsert → get round-trips incl. sanitizedPayload + sourceRefs json", async () => {
      unwrap(await repos.gclProjections.upsert(validGclProjection));
      const got = unwrap(
        await repos.gclProjections.get(
          validGclProjection.workspaceId,
          validGclProjection.projectionType,
          validGclProjection.visibilityLevel,
        ),
      );
      expect(got).toEqual(validGclProjection);
    });

    it("listByWorkspace / listByVisibility scope correctly", async () => {
      unwrap(await repos.gclProjections.upsert(validGclProjection));
      unwrap(
        await repos.gclProjections.upsert({
          ...validGclProjection,
          projectionType: "task_rollup",
          visibilityLevel: "sanitized",
        }),
      );
      expect(unwrap(await repos.gclProjections.listByWorkspace(validGclProjection.workspaceId))).toHaveLength(2);
      expect(unwrap(await repos.gclProjections.listByVisibility("coordination"))).toHaveLength(1);
      expect(unwrap(await repos.gclProjections.listByVisibility("sanitized"))).toHaveLength(1);
    });

    it("upsert on the same (workspace, type, visibility) key UPDATEs in place", async () => {
      unwrap(await repos.gclProjections.upsert(validGclProjection));
      unwrap(await repos.gclProjections.upsert({ ...validGclProjection, sanitizedPayload: { busySlots: 9 } }));
      const got = unwrap(
        await repos.gclProjections.get(
          validGclProjection.workspaceId,
          validGclProjection.projectionType,
          validGclProjection.visibilityLevel,
        ),
      );
      expect(got.sanitizedPayload).toEqual({ busySlots: 9 });
      expect(unwrap(await repos.gclProjections.listByWorkspace(validGclProjection.workspaceId))).toHaveLength(1);
    });

    it("get on a missing projection returns not_found", async () => {
      expect(unwrapErr(await repos.gclProjections.get(validGclProjection.workspaceId, "nope", "coordination")).code).toBe(
        "not_found",
      );
    });
  });

  // ── write receipts (WW-1: the no-duplicate-external-write reserve, safety rule 3) ─
  // The DB-backed reserve() is the CROSS-PROCESS backstop the in-process ReceiptStore
  // cannot give: reserve INSERTs a placeholder under a UNIQUE (targetSystem,
  // canonicalObjectKey) key. The winner (INSERTed) gets {kind:"reserved"} and may
  // create; a concurrent reserve BEFORE the receipt lands gets {kind:"in_progress"}
  // (another worker mid-write — must NOT create); after put(receipt) a reserve gets
  // {kind:"committed"} with the record (reuse it → zero duplicate external write).
  describe("WriteReceiptRepository (WW-1 reserve — safety rule 3)", () => {
    it("first reserve WINS ({kind:'reserved'}); a second reserve BEFORE put is {kind:'in_progress'}", async () => {
      const first = unwrap(await repos.writeReceipts.reserve("todoist", "todoist:task:x"));
      expect(first.kind).toBe("reserved");
      // Second worker races on the SAME object identity before any receipt is put:
      // it must NOT win the reservation (no create), it observes in_progress.
      const second = unwrap(await repos.writeReceipts.reserve("todoist", "todoist:task:x"));
      expect(second.kind).toBe("in_progress");
    });

    it("after put(receipt) a reserve is {kind:'committed'} carrying the record (reuse, zero dup write)", async () => {
      unwrap(await repos.writeReceipts.reserve("linear", "linear:issue:7"));
      unwrap(
        await repos.writeReceipts.put(
          writeReceiptRow({
            targetSystem: "linear",
            canonicalObjectKey: "linear:issue:7",
            idempotencyKey: "idem-linear-7",
          }),
        ),
      );
      const outcome = unwrap(await repos.writeReceipts.reserve("linear", "linear:issue:7"));
      expect(outcome.kind).toBe("committed");
      if (outcome.kind !== "committed") return;
      expect(outcome.record.idempotencyKey).toBe("idem-linear-7");
      expect(outcome.record.receipt).toEqual({
        externalObjectId: "ext-linear:issue:7",
        recordedAt: "2026-06-30T00:00:05.000Z",
      });
    });

    it("getByIdempotencyKey / getByCanonicalObjectKey round-trip a committed receipt; misses are not_found", async () => {
      unwrap(await repos.writeReceipts.reserve("github", "github:issue:42"));
      unwrap(
        await repos.writeReceipts.put(
          writeReceiptRow({
            targetSystem: "github",
            canonicalObjectKey: "github:issue:42",
            idempotencyKey: "idem-gh-42",
          }),
        ),
      );
      expect(unwrap(await repos.writeReceipts.getByIdempotencyKey("idem-gh-42")).canonicalObjectKey).toBe(
        "github:issue:42",
      );
      expect(unwrap(await repos.writeReceipts.getByCanonicalObjectKey("github", "github:issue:42")).idempotencyKey).toBe(
        "idem-gh-42",
      );
      expect(unwrapErr(await repos.writeReceipts.getByIdempotencyKey("nope")).code).toBe("not_found");
      expect(unwrapErr(await repos.writeReceipts.getByCanonicalObjectKey("github", "nope")).code).toBe("not_found");
    });

    it("release frees a still-RESERVED placeholder so a retry can re-reserve", async () => {
      expect(unwrap(await repos.writeReceipts.reserve("todoist", "todoist:task:r")).kind).toBe("reserved");
      // The create faulted before a receipt landed → release the reservation.
      unwrap(await repos.writeReceipts.release("todoist", "todoist:task:r"));
      // A later retry / outbox drain may now re-claim it and win again.
      expect(unwrap(await repos.writeReceipts.reserve("todoist", "todoist:task:r")).kind).toBe("reserved");
    });

    it("release REFUSES to delete a COMMITTED row (a committed reservation stays committed)", async () => {
      unwrap(await repos.writeReceipts.reserve("linear", "linear:issue:c"));
      unwrap(
        await repos.writeReceipts.put(
          writeReceiptRow({
            targetSystem: "linear",
            canonicalObjectKey: "linear:issue:c",
            idempotencyKey: "idem-linear-c",
          }),
        ),
      );
      // release must be a no-op on a committed row — NEVER delete the exactly-once proof.
      unwrap(await repos.writeReceipts.release("linear", "linear:issue:c"));
      // Still committed: a reserve reuses the receipt (never re-opens the create path).
      const after = unwrap(await repos.writeReceipts.reserve("linear", "linear:issue:c"));
      expect(after.kind).toBe("committed");
      if (after.kind !== "committed") return;
      expect(after.record.idempotencyKey).toBe("idem-linear-c");
    });

    it("put is idempotent — upgrading a reservation to committed twice keeps ONE committed row", async () => {
      unwrap(await repos.writeReceipts.reserve("drive", "drive:file:z"));
      const row = writeReceiptRow({
        targetSystem: "drive",
        canonicalObjectKey: "drive:file:z",
        idempotencyKey: "idem-drive-z",
      });
      unwrap(await repos.writeReceipts.put(row));
      // A replayed put for the same object identity must not conflict — idempotent upgrade.
      unwrap(await repos.writeReceipts.put(row));
      const outcome = unwrap(await repos.writeReceipts.reserve("drive", "drive:file:z"));
      expect(outcome.kind).toBe("committed");
    });

    it("idempotencyKey is GLOBALLY UNIQUE: reusing it for a DIFFERENT object identity is a typed conflict", async () => {
      unwrap(await repos.writeReceipts.reserve("todoist", "todoist:task:a"));
      unwrap(
        await repos.writeReceipts.put(
          writeReceiptRow({
            targetSystem: "todoist",
            canonicalObjectKey: "todoist:task:a",
            idempotencyKey: "idem-shared",
          }),
        ),
      );
      // A different object identity must NOT be committable under the SAME idempotencyKey.
      unwrap(await repos.writeReceipts.reserve("todoist", "todoist:task:b"));
      expect(
        unwrapErr(
          await repos.writeReceipts.put(
            writeReceiptRow({
              targetSystem: "todoist",
              canonicalObjectKey: "todoist:task:b",
              idempotencyKey: "idem-shared",
            }),
          ),
        ).code,
      ).toBe("conflict");
    });

    it("distinct object identities that COLLIDE under a naive colon-joined synthetic key each reserve + commit independently (WW-1 injective-identity regression)", async () => {
      // Regression for the adversarial-verify HIGH: a synthetic placeholder key
      // `reserve:${targetSystem}:${canonicalObjectKey}` is NOT injective —
      // ('slack','C123:456') and ('slack:C123','456') both fold to the SAME
      // 'reserve:slack:C123:456'. The second, never-reserved object must NOT be
      // blocked by a spurious UNIQUE(idempotencyKey) collision. With NULL placeholders
      // (object identity = the composite PK) both reserve cleanly, on BOTH dialects.
      const a = unwrap(await repos.writeReceipts.reserve("slack", "C123:456"));
      expect(a.kind).toBe("reserved");
      const b = unwrap(await repos.writeReceipts.reserve("slack:C123", "456"));
      expect(b.kind).toBe("reserved"); // NOT a spurious conflict / in_progress
      // Both commit independently under distinct real replay keys.
      unwrap(
        await repos.writeReceipts.put(
          writeReceiptRow({ targetSystem: "slack", canonicalObjectKey: "C123:456", idempotencyKey: "idem-slack-a" }),
        ),
      );
      unwrap(
        await repos.writeReceipts.put(
          writeReceiptRow({ targetSystem: "slack:C123", canonicalObjectKey: "456", idempotencyKey: "idem-slack-b" }),
        ),
      );
      expect(unwrap(await repos.writeReceipts.getByCanonicalObjectKey("slack", "C123:456")).idempotencyKey).toBe(
        "idem-slack-a",
      );
      expect(unwrap(await repos.writeReceipts.getByCanonicalObjectKey("slack:C123", "456")).idempotencyKey).toBe(
        "idem-slack-b",
      );
      // A later reserve on each now observes its OWN committed receipt (no cross-talk).
      expect(unwrap(await repos.writeReceipts.reserve("slack", "C123:456")).kind).toBe("committed");
      expect(unwrap(await repos.writeReceipts.reserve("slack:C123", "456")).kind).toBe("committed");
    });
  });

  // ── health items (OBS-1/OBS-2: §10.3 dedupe upsert + lifecycle) ──────────────
  // The DB-backed HealthItemStore is the Phase-10 concrete table behind the Phase-7
  // in-memory fake: one DISTINCT item per dedupe key ((failureClass, subjectRef)),
  // so a repeat failure of the SAME class UPSERTs (bumps occurrenceCount, refreshes
  // lastSeen, advances the lifecycle) rather than spawning a duplicate item.
  describe("HealthItemRepository (OBS-2 §10.3 dedupe)", () => {
    it("first put INSERTs; getByDedupeKey round-trips the frozen HealthItem model", async () => {
      const item = health({ id: "h1", failureClass: "parity_defect", message: "DB-only fact" });
      unwrap(await repos.healthItems.put(item, "parity_defect::fact-7", "fact-7", "2026-06-30T00:00:01.000Z"));
      const got = unwrap(await repos.healthItems.getByDedupeKey("parity_defect::fact-7"));
      expect(got).toEqual(item);
    });

    it("getByDedupeKey on an unseen key is a typed not_found (never throws)", async () => {
      expect(unwrapErr(await repos.healthItems.getByDedupeKey("never")).code).toBe("not_found");
    });

    it("a repeat put under the SAME dedupe key UPSERTs (no duplicate) — one item in list, lifecycle advances", async () => {
      const key = "sync_lagging::gcal";
      const first = health({ id: "h1", failureClass: "sync_lagging", state: "open", message: "sync behind" });
      unwrap(await repos.healthItems.put(first, key, "gcal", "2026-06-30T00:00:01.000Z"));
      // Same class recurs → same dedupe key → the SAME item advances (acknowledged),
      // NOT a second row. openedAt is preserved from the first sighting.
      const again = health({ id: "h1", failureClass: "sync_lagging", state: "acknowledged", message: "still behind" });
      unwrap(await repos.healthItems.put(again, key, "gcal", "2026-06-30T00:05:00.000Z"));
      const all = unwrap(await repos.healthItems.list());
      expect(all).toHaveLength(1); // deduped — never a duplicate item
      const got = unwrap(await repos.healthItems.getByDedupeKey(key));
      expect(got.state).toBe("acknowledged");
      expect(got.message).toBe("still behind");
      expect(got.openedAt).toBe(first.openedAt); // openedAt preserved across the dedupe
    });

    it("two DISTINCT dedupe keys are two DISTINCT items; list is most-recently-seen first", async () => {
      unwrap(await repos.healthItems.put(health({ id: "a", failureClass: "parity_defect" }), "k-a", "sa", "2026-06-30T00:00:01.000Z"));
      unwrap(await repos.healthItems.put(health({ id: "b", failureClass: "sync_lagging" }), "k-b", "sb", "2026-06-30T00:00:09.000Z"));
      const all = unwrap(await repos.healthItems.list());
      expect(all.map((h) => h.id)).toEqual(["b", "a"]); // b seen later → first
    });

    it("a resolved item round-trips resolvedAt (state ⇔ resolvedAt lifecycle coupling)", async () => {
      const resolved = health({
        id: "h1",
        failureClass: "parity_defect",
        state: "resolved",
        resolvedAt: "2026-06-30T01:00:00.000Z",
      });
      unwrap(await repos.healthItems.put(resolved, "k-res", "s-res", "2026-06-30T01:00:00.000Z"));
      const got = unwrap(await repos.healthItems.getByDedupeKey("k-res"));
      expect(got.state).toBe("resolved");
      expect(got.resolvedAt).toBe("2026-06-30T01:00:00.000Z");
    });
  });

  // ── schedule bookkeeping (LIFE-5: last-run wall + clock-jump-safe monotonic) ──
  describe("ScheduleBookkeepingRepository (LIFE-5)", () => {
    it("put → getBookkeeping round-trips wall + optional monotonic pair", async () => {
      unwrap(
        await repos.scheduleBookkeeping.put(
          bk({
            scheduleId: "daily-rollup",
            lastRunWall: "2026-06-30T06:00:00.000Z",
            lastRunMonotonicMs: 123456,
            lastRunMonotonicEpoch: "boot-1",
          }),
        ),
      );
      const got = unwrap(await repos.scheduleBookkeeping.getBookkeeping("daily-rollup"));
      expect(got).toEqual({
        scheduleId: "daily-rollup",
        lastRunWall: "2026-06-30T06:00:00.000Z",
        lastRunMonotonicMs: 123456,
        lastRunMonotonicEpoch: "boot-1",
      });
    });

    it("the first run has no monotonic reading — optional fields round-trip NULL→undefined", async () => {
      unwrap(await repos.scheduleBookkeeping.put(bk({ scheduleId: "hourly", lastRunWall: "2026-06-30T07:00:00.000Z" })));
      const got = unwrap(await repos.scheduleBookkeeping.getBookkeeping("hourly"));
      expect(got.lastRunMonotonicMs).toBeUndefined();
      expect(got.lastRunMonotonicEpoch).toBeUndefined();
    });

    it("a second put for the same schedule UPDATEs in place (advances the reading)", async () => {
      unwrap(await repos.scheduleBookkeeping.put(bk({ scheduleId: "s1", lastRunWall: "2026-06-30T00:00:00.000Z" })));
      unwrap(
        await repos.scheduleBookkeeping.put(
          bk({ scheduleId: "s1", lastRunWall: "2026-06-30T01:00:00.000Z", lastRunMonotonicMs: 999, lastRunMonotonicEpoch: "boot-2" }),
        ),
      );
      const got = unwrap(await repos.scheduleBookkeeping.getBookkeeping("s1"));
      expect(got.lastRunWall).toBe("2026-06-30T01:00:00.000Z");
      expect(got.lastRunMonotonicMs).toBe(999);
    });

    it("getBookkeeping on an unseen schedule is a typed not_found", async () => {
      expect(unwrapErr(await repos.scheduleBookkeeping.getBookkeeping("nope")).code).toBe("not_found");
    });
  });

  // ── instance leases (LIFE-1: single-active-instance atomic compare-and-set) ───
  // compareAndSet is the atomic acquire/renew: it commits IFF the stored record
  // equals `expected` (undefined = first acquire). Contention is ok(false), NEVER a
  // throw — the loser retries. The win/lose decision is the shared pure decideLeaseCas.
  describe("InstanceLeaseRepository (LIFE-1 compareAndSet)", () => {
    it("FIRST acquire (expected undefined) WINS on an empty slot; get round-trips the record", async () => {
      const l = lease({ taskQueue: "sow-main", ownerId: "worker-A", generation: 1 });
      expect(unwrap(await repos.instanceLeases.compareAndSet(undefined, l))).toBe(true);
      expect(unwrap(await repos.instanceLeases.get("sow-main"))).toEqual(l);
    });

    it("a SECOND first-acquire against an already-held slot LOSES (ok(false), no throw)", async () => {
      unwrap(await repos.instanceLeases.compareAndSet(undefined, lease({ taskQueue: "sow-main", ownerId: "worker-A" })));
      // Contender B also thinks the slot is empty → it LOSES the race (no double-hold).
      const lost = unwrap(
        await repos.instanceLeases.compareAndSet(undefined, lease({ taskQueue: "sow-main", ownerId: "worker-B" })),
      );
      expect(lost).toBe(false);
      // The original holder is unchanged (no silent overwrite).
      expect(unwrap(await repos.instanceLeases.get("sow-main")).ownerId).toBe("worker-A");
    });

    it("RENEW WINS when the stored record EXACTLY matches expected; the fencing generation bumps", async () => {
      const held = lease({ taskQueue: "sow-main", ownerId: "worker-A", generation: 1 });
      unwrap(await repos.instanceLeases.compareAndSet(undefined, held));
      // Same owner renews from its exact held record → wins; generation advances.
      const renewed = lease({ taskQueue: "sow-main", ownerId: "worker-A", generation: 2, expiresAt: "2026-06-30T00:01:00.000Z" });
      expect(unwrap(await repos.instanceLeases.compareAndSet(held, renewed))).toBe(true);
      const got = unwrap(await repos.instanceLeases.get("sow-main"));
      expect(got.generation).toBe(2);
      expect(got.expiresAt).toBe("2026-06-30T00:01:00.000Z");
    });

    it("a stale RENEW (expected no longer matches the stored record) LOSES — no overwrite", async () => {
      const held = lease({ taskQueue: "sow-main", ownerId: "worker-A", generation: 1 });
      unwrap(await repos.instanceLeases.compareAndSet(undefined, held));
      // Worker A took over to generation 2 (a legitimate renew).
      const gen2 = lease({ taskQueue: "sow-main", ownerId: "worker-A", generation: 2 });
      unwrap(await repos.instanceLeases.compareAndSet(held, gen2));
      // Worker B tries to renew from the now-STALE gen-1 pre-image → it LOSES (the
      // fencing generation moved on); the stored record is untouched.
      const stale = lease({ taskQueue: "sow-main", ownerId: "worker-B", generation: 2 });
      expect(unwrap(await repos.instanceLeases.compareAndSet(held, stale))).toBe(false);
      const got = unwrap(await repos.instanceLeases.get("sow-main"));
      expect(got.ownerId).toBe("worker-A");
      expect(got.generation).toBe(2);
    });

    it("reclaim: a fresh acquire that matches the CURRENT record takes over from an expired holder", async () => {
      const a = lease({ taskQueue: "sow-main", ownerId: "worker-A", generation: 1 });
      unwrap(await repos.instanceLeases.compareAndSet(undefined, a));
      // Worker B observes A's (expired) lease and CAS-swaps itself in from A's exact
      // record — the takeover wins because expected == the stored record.
      const b = lease({ taskQueue: "sow-main", ownerId: "worker-B", generation: 2, acquiredAt: "2026-06-30T00:02:00.000Z" });
      expect(unwrap(await repos.instanceLeases.compareAndSet(a, b))).toBe(true);
      expect(unwrap(await repos.instanceLeases.get("sow-main")).ownerId).toBe("worker-B");
    });

    it("get on an unheld task queue is a typed not_found", async () => {
      expect(unwrapErr(await repos.instanceLeases.get("no-queue")).code).toBe("not_found");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // OPERATIONAL-TRUTH INVARIANTS (unit 2.5) — exercised THROUGH the adapters so the
  // SAME behavior holds on both dialects (the divergence-blocking core of 2.9).
  // ══════════════════════════════════════════════════════════════════════════════
  describe("operational-truth invariants (§4 / 2.5)", () => {
    it("Invariant 1 — event log is APPEND-ONLY: only `append` writes; no in-place mutator exists, and a re-append is a conflict", async () => {
      // Structural: the append-only repo surface exposes NO update/delete writer.
      const surface = repos.eventLog as unknown as Record<string, unknown>;
      expect(surface["update"]).toBeUndefined();
      expect(surface["delete"]).toBeUndefined();
      // Behavioral: a logged event cannot be overwritten — re-appending its id is a conflict.
      unwrap(await repos.eventLog.append(evt({ eventId: "ev-1", payload: { v: 1 } })));
      expect(unwrapErr(await repos.eventLog.append(evt({ eventId: "ev-1", payload: { v: 2 } }))).code).toBe("conflict");
      // The original is untouched (no silent overwrite).
      const all = unwrap(await repos.eventLog.readSince(null, 10));
      expect(all).toHaveLength(1);
      expect(all[0]?.payload).toEqual({ v: 1 });
    });

    it("Invariant 2 — audit is IMMUTABLE / tombstone-only: no in-place mutator; a correction is a NEW record, both retained", async () => {
      // Structural: audit exposes only append + query (no update / hard-delete).
      const surface = repos.audit as unknown as Record<string, unknown>;
      expect(surface["update"]).toBeUndefined();
      expect(surface["delete"]).toBeUndefined();
      // Behavioral: a "correction" is expressed as a NEW (tombstone) record; the
      // original stays in the trail — history is never edited away.
      const original = { ...validAuditRecord, event: "knowledge.write", refs: ["plan-1"] };
      const correction = { ...validAuditRecord, event: "knowledge.write.corrected", refs: ["plan-1", "tombstone:plan-1"] };
      unwrap(await repos.audit.append(original));
      unwrap(await repos.audit.append(correction));
      const trail = unwrap(await repos.audit.query({ ref: "plan-1" }, 10));
      expect(trail).toHaveLength(2);
      expect(trail.map((r) => r.event)).toEqual(["knowledge.write", "knowledge.write.corrected"]);
    });

    it("Invariant 3 — approval transitions are EXACTLY-ONCE: a true replay is an idempotent no-op, a stale different-target CAS loses (no double-apply)", async () => {
      unwrap(await repos.approvals.create(validApproval)); // status: pending
      const approve: Approval = { ...validApproval, status: "approved" };
      const reject: Approval = { ...validApproval, status: "rejected" };
      // Contender A (e.g. Mac) wins the pending→approved compare-and-set —
      // a GENUINE durable transition → applied:true (only it may dispatch).
      const won = unwrap(await repos.approvals.applyTransition(validApproval.id, "pending", approve));
      expect(won.approval.status).toBe("approved");
      expect(won.applied).toBe(true);
      // A TRUE replay of the winning transition (same expectedFrom + same target)
      // is an idempotent no-op: ok(current) with applied:FALSE (it did NOT cause the
      // transition, so it must not dispatch), never a second apply (REQ-F-012).
      const replay = unwrap(await repos.approvals.applyTransition(validApproval.id, "pending", approve));
      expect(replay.approval.status).toBe("approved");
      expect(replay.applied).toBe(false);
      // Contender B (e.g. Telegram) arrives with the SAME, now-stale `pending`
      // expectation but a DIFFERENT target (reject) → it loses; no second apply.
      expect(unwrapErr(await repos.approvals.applyTransition(validApproval.id, "pending", reject)).code).toBe("conflict");
      // Exactly-once: the persisted verdict is the winner's, unchanged by replay/loser.
      expect(unwrap(await repos.approvals.get(validApproval.id)).status).toBe("approved");
    });

    it("Invariant 4 — read models are REBUILDABLE: clear drops a family, a re-put reconstructs the projection", async () => {
      unwrap(await repos.readModels.put(readModel({ readModelKey: "system_health", workspaceId: "ws-001", data: { ok: 1 } })));
      unwrap(await repos.readModels.put(readModel({ readModelKey: "system_health", workspaceId: "ws-002", data: { ok: 1 } })));
      // Drop the whole read-model family ahead of a rebuild (legal — derived, not truth).
      unwrap(await repos.readModels.clear("system_health"));
      expect(unwrapErr(await repos.readModels.get("system_health", "ws-001")).code).toBe("not_found");
      // Rebuild reconstructs the projection from (operational truth + Markdown).
      unwrap(await repos.readModels.put(readModel({ readModelKey: "system_health", workspaceId: "ws-001", data: { ok: 42 } })));
      expect(unwrap(await repos.readModels.get("system_health", "ws-001")).data).toEqual({ ok: 42 });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // §16 ERROR CONVENTION — NO repository method throws across the boundary; every
  // failure is a typed Result<T, DbError> carrying an enumerable DbErrorCode.
  // ══════════════════════════════════════════════════════════════════════════════
  describe("§16 — typed Result on error, never a thrown exception", () => {
    it("every repository's failure path returns a typed err (no try/catch needed) with an enumerable code", async () => {
      const errs: DbError[] = [
        unwrapErr(await repos.workspaceConfig.get("ws-absent" as WorkspaceId)),
        unwrapErr(await repos.eventLog.readSince("cursor-absent", 10)),
        unwrapErr(await repos.workflowRunRefs.get("wf-absent" as WorkflowId)),
        unwrapErr(await repos.workflowRunRefs.getByIdempotencyKey("key-absent")),
        unwrapErr(await repos.approvals.get("appr-absent" as ApprovalId)),
        unwrapErr(
          await repos.approvals.applyTransition("appr-absent" as ApprovalId, "pending", {
            ...validApproval,
            status: "approved",
          }),
        ),
        unwrapErr(await repos.outbox.get("ob-absent")),
        unwrapErr(await repos.outbox.getByIdempotencyKey("idem-absent")),
        unwrapErr(await repos.connectorCursors.get("conn-absent", "ws-absent")),
        unwrapErr(await repos.providerState.get("claude", "https://absent", "m-absent")),
        unwrapErr(await repos.readModels.get("rm-absent", null)),
        unwrapErr(await repos.gclProjections.get("ws-absent" as WorkspaceId, "nope", "coordination")),
        unwrapErr(await repos.writeReceipts.getByIdempotencyKey("wr-absent")),
        unwrapErr(await repos.writeReceipts.getByCanonicalObjectKey("todoist", "wr-absent")),
        unwrapErr(await repos.healthItems.getByDedupeKey("hi-absent")),
        unwrapErr(await repos.scheduleBookkeeping.getBookkeeping("sched-absent")),
        unwrapErr(await repos.instanceLeases.get("lease-absent")),
      ];
      for (const e of errs) {
        expect(DB_ERROR_CODES).toContain(e.code);
        expect(typeof e.message).toBe("string");
      }
    });

    it("conflict failures (duplicate-key writes) are typed errs, not exceptions", async () => {
      unwrap(await repos.eventLog.append(evt({ eventId: "dup" })));
      unwrap(await repos.approvals.create(validApproval));
      unwrap(await repos.outbox.enqueue(outboxEntry({ outboxId: "dup" })));
      unwrap(await repos.workflowRunRefs.create(validWorkflowRunRef));
      expect(unwrapErr(await repos.eventLog.append(evt({ eventId: "dup" }))).code).toBe("conflict");
      expect(unwrapErr(await repos.approvals.create(validApproval)).code).toBe("conflict");
      expect(unwrapErr(await repos.outbox.enqueue(outboxEntry({ outboxId: "dup" }))).code).toBe("conflict");
      expect(unwrapErr(await repos.workflowRunRefs.create(validWorkflowRunRef)).code).toBe("conflict");
    });
  });
});
