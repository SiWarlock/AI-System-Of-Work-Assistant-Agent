// Unit 2.3 — SQLite adapter (drizzle-orm/better-sqlite3) for every operational-
// store repository interface (§4 / REQ-D-002/003, §16 error convention).
//
// Deterministic + server-free: every case runs against `new Database(':memory:')`
// with the schema materialized by the create-tables helper. The adapter NEVER
// throws across the boundary — every method returns a typed Result<T, DbError>
// (§16); failures are asserted as typed `err` values with an enumerable code, not
// caught exceptions. Coverage: ≥1 round-trip per repo plus the boundary
// behaviors the interfaces pin (append-only forward scan, exactly-once approval
// compare-and-set, outbox idempotency + due-query tombstoning, read-model
// rebuild/clear, PK-conflict mapping, not_found on missing).
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isErr,
  isOk,
  validApproval,
  validAuditRecord,
  validGclProjection,
  validProviderProfile,
  validWorkflowRunRef,
  validWorkspace,
  type Approval,
  type AuditId,
  type Result,
  type WorkflowId,
} from "@sow/contracts";
import type { DbError } from "../../src/repositories/interfaces";
import type {
  ConnectorCursorRecord,
  EventLogRecord,
  OutboxEntry,
  ReadModelRecord,
} from "../../src/repositories/interfaces";
import { createSqliteRepositories } from "../../src/adapters/sqlite/index";
import { createSqliteSchema } from "./create-sqlite-schema";

// ── harness ──────────────────────────────────────────────────────────────────
let sqlite: InstanceType<typeof Database>;
let db: BetterSQLite3Database;
let repos: ReturnType<typeof createSqliteRepositories>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  createSqliteSchema(sqlite);
  db = drizzle(sqlite);
  repos = createSqliteRepositories(db);
});
afterEach(() => {
  sqlite.close();
});

// Result unwrap helpers (a typed err in a place we expected ok is a test failure).
function unwrap<T>(r: Result<T, DbError>): T {
  if (!isOk(r)) throw new Error(`expected ok, got err: ${JSON.stringify(r.error)}`);
  return r.value;
}
function unwrapErr<T>(r: Result<T, DbError>): DbError {
  if (!isErr(r)) throw new Error(`expected err, got ok: ${JSON.stringify(r)}`);
  return r.error;
}

// ── DTO factories (non-frozen operational records) ───────────────────────────
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
function cursor(over: Partial<ConnectorCursorRecord> & Pick<ConnectorCursorRecord, "connectorId" | "workspaceId">): ConnectorCursorRecord {
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

// ── factory smoke ────────────────────────────────────────────────────────────
describe("createSqliteRepositories — factory surface (2.3)", () => {
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
  });
});

// ── workspace config (MUTABLE upsert) ────────────────────────────────────────
describe("WorkspaceConfigRepository (sqlite)", () => {
  it("upsert → get round-trips the whole aggregate incl. nested json", async () => {
    expect(unwrap(await repos.workspaceConfig.upsert(validWorkspace))).toEqual(validWorkspace);
    const got = unwrap(await repos.workspaceConfig.get(validWorkspace.id));
    expect(got).toEqual(validWorkspace);
    expect(got.egressPolicy).toEqual(validWorkspace.egressPolicy);
    expect(got.providerMatrix).toEqual(validWorkspace.providerMatrix);
  });

  it("upsert is idempotent-by-key: a second upsert UPDATEs in place, no conflict", async () => {
    await repos.workspaceConfig.upsert(validWorkspace);
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
describe("EventLogRepository (sqlite)", () => {
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

  it("byWorkflow filters to one workflow's events; optional fields round-trip", async () => {
    unwrap(await repos.eventLog.append(evt({ eventId: "e1", workflowId: "wf-1", workspaceId: "ws-001", payload: { a: 1 } })));
    unwrap(await repos.eventLog.append(evt({ eventId: "e2", workflowId: "wf-2" })));
    const wf1 = unwrap(await repos.eventLog.byWorkflow("wf-1" as WorkflowId));
    expect(wf1.map((e) => e.eventId)).toEqual(["e1"]);
    expect(wf1[0]?.payload).toEqual({ a: 1 });
    expect(wf1[0]?.workspaceId).toBe("ws-001");
    // an event with no workspaceId/payload comes back with those omitted (not null)
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
describe("WorkflowRunRefRepository (sqlite)", () => {
  it("create → get / getByIdempotencyKey round-trips, incl. auditRefs json", async () => {
    unwrap(await repos.workflowRunRefs.create(validWorkflowRunRef));
    expect(unwrap(await repos.workflowRunRefs.get(validWorkflowRunRef.workflowId))).toEqual(validWorkflowRunRef);
    const byKey = unwrap(await repos.workflowRunRefs.getByIdempotencyKey(validWorkflowRunRef.idempotencyKey));
    expect(byKey.workflowId).toBe(validWorkflowRunRef.workflowId);
  });

  it("updateState mutates state; appendAuditRef grows the audit trail append-only", async () => {
    unwrap(await repos.workflowRunRefs.create(validWorkflowRunRef));
    expect(unwrap(await repos.workflowRunRefs.updateState(validWorkflowRunRef.workflowId, "completed")).state).toBe("completed");
    const grown = unwrap(await repos.workflowRunRefs.appendAuditRef(validWorkflowRunRef.workflowId, "audit-002" as AuditId));
    expect(grown.auditRefs).toEqual([...validWorkflowRunRef.auditRefs, "audit-002"]);
  });

  it("getByIdempotencyKey on a novel key returns not_found (drives replay reuse)", async () => {
    expect(unwrapErr(await repos.workflowRunRefs.getByIdempotencyKey("never-seen")).code).toBe("not_found");
  });

  it("create with a duplicate workflowId is a typed conflict", async () => {
    unwrap(await repos.workflowRunRefs.create(validWorkflowRunRef));
    expect(unwrapErr(await repos.workflowRunRefs.create(validWorkflowRunRef)).code).toBe("conflict");
  });

  it("updateState on a missing workflow returns not_found", async () => {
    expect(unwrapErr(await repos.workflowRunRefs.updateState(validWorkflowRunRef.workflowId, "failed")).code).toBe("not_found");
  });
});

// ── audit trail (APPEND-ONLY; summaries only) ────────────────────────────────
describe("AuditRepository (sqlite)", () => {
  it("append → query round-trips; filters AND-combine; ref containment matches", async () => {
    unwrap(await repos.audit.append(validAuditRecord));
    unwrap(await repos.audit.append({ ...validAuditRecord, actor: "user:cody", event: "approval.decided", refs: ["appr-001"] }));
    unwrap(await repos.audit.append({ ...validAuditRecord, actor: "user:cody", event: "approval.decided", refs: ["appr-002"] }));

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
});

// ── approvals (exactly-once compare-and-set transition) ──────────────────────
describe("ApprovalRepository (sqlite)", () => {
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

  it("applyTransition is EXACTLY ONCE: the winning CAS applies, the replay is a typed conflict no-op", async () => {
    unwrap(await repos.approvals.create(validApproval));
    const next: Approval = { ...validApproval, status: "approved" };
    expect(unwrap(await repos.approvals.applyTransition(validApproval.id, "pending", next)).status).toBe("approved");
    // record is now `approved`; a replay from the stale `pending` expectation loses
    const replay = await repos.approvals.applyTransition(validApproval.id, "pending", next);
    expect(unwrapErr(replay).code).toBe("conflict");
    // and the persisted status is unchanged (no second apply)
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
describe("OutboxRepository (sqlite)", () => {
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
    expect(unwrap(await repos.outbox.get("o1")).writeReceipt).toEqual({ externalObjectId: "ext-1", recordedAt: "2026-06-30T00:00:05.000Z" });
    expect(unwrap(await repos.outbox.listDue("2026-06-30T01:00:00.000Z", 10))).toHaveLength(0);
  });

  it("listDue returns non-terminal entries whose nextAttemptAt has elapsed; future retries are excluded", async () => {
    unwrap(await repos.outbox.enqueue(outboxEntry({ outboxId: "due-now", status: "proposed" })));
    unwrap(await repos.outbox.enqueue(outboxEntry({ outboxId: "retry-elapsed", status: "retry_queued", nextAttemptAt: "2026-06-30T00:30:00.000Z" })));
    unwrap(await repos.outbox.enqueue(outboxEntry({ outboxId: "retry-future", status: "retry_queued", nextAttemptAt: "2026-06-30T23:59:00.000Z" })));
    const due = unwrap(await repos.outbox.listDue("2026-06-30T01:00:00.000Z", 10));
    expect(due.map((e) => e.outboxId).sort()).toEqual(["due-now", "retry-elapsed"]);
  });

  it("enqueue with a duplicate outboxId is a typed conflict", async () => {
    unwrap(await repos.outbox.enqueue(outboxEntry({ outboxId: "o1" })));
    expect(unwrapErr(await repos.outbox.enqueue(outboxEntry({ outboxId: "o1" }))).code).toBe("conflict");
  });
});

// ── connector cursors (composite-key upsert) ─────────────────────────────────
describe("ConnectorCursorRepository (sqlite)", () => {
  it("upsert advances the cursor for one (connector, workspace); get + listByConnector round-trip", async () => {
    unwrap(await repos.connectorCursors.upsert(cursor({ connectorId: "gcal", workspaceId: "ws-001", cursor: "c1" })));
    unwrap(await repos.connectorCursors.upsert(cursor({ connectorId: "gcal", workspaceId: "ws-002", cursor: "c2" })));
    expect(unwrap(await repos.connectorCursors.get("gcal", "ws-001")).cursor).toBe("c1");

    // advancing the SAME key UPDATEs in place (no duplicate, no conflict)
    unwrap(await repos.connectorCursors.upsert(cursor({ connectorId: "gcal", workspaceId: "ws-001", cursor: "c1-next", status: "degraded" })));
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
describe("ProviderStateRepository (sqlite)", () => {
  it("upsert → get / list round-trips incl. capabilities + costCaps json", async () => {
    unwrap(await repos.providerState.upsert(validProviderProfile));
    const got = unwrap(await repos.providerState.get(validProviderProfile.provider, validProviderProfile.endpoint, validProviderProfile.model));
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
    expect(unwrapErr(await repos.providerState.setConformanceStatus("claude", "https://x", "m", "passing")).code).toBe("not_found");
  });
});

// ── read models (REBUILDABLE: put/clear are legal here) ──────────────────────
describe("ReadModelRepository (sqlite)", () => {
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

  it("clear drops a read-model family ahead of a rebuild; get then returns not_found", async () => {
    unwrap(await repos.readModels.put(readModel({ readModelKey: "system_health", workspaceId: "ws-001" })));
    unwrap(await repos.readModels.put(readModel({ readModelKey: "system_health", workspaceId: "ws-002" })));
    unwrap(await repos.readModels.clear("system_health"));
    expect(unwrapErr(await repos.readModels.get("system_health", "ws-001")).code).toBe("not_found");
  });

  it("get on a missing read model returns not_found", async () => {
    expect(unwrapErr(await repos.readModels.get("nope", null)).code).toBe("not_found");
  });
});

// ── gcl projections (DERIVED; composite-key upsert, the WS-8 read path) ──────
describe("GclProjectionRepository (sqlite)", () => {
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
    unwrap(await repos.gclProjections.upsert({ ...validGclProjection, projectionType: "task_rollup", visibilityLevel: "sanitized" }));
    expect(unwrap(await repos.gclProjections.listByWorkspace(validGclProjection.workspaceId))).toHaveLength(2);
    expect(unwrap(await repos.gclProjections.listByVisibility("coordination"))).toHaveLength(1);
    expect(unwrap(await repos.gclProjections.listByVisibility("sanitized"))).toHaveLength(1);
  });

  it("upsert on the same (workspace, type, visibility) key UPDATEs in place", async () => {
    unwrap(await repos.gclProjections.upsert(validGclProjection));
    unwrap(await repos.gclProjections.upsert({ ...validGclProjection, sanitizedPayload: { busySlots: 9 } }));
    const got = unwrap(
      await repos.gclProjections.get(validGclProjection.workspaceId, validGclProjection.projectionType, validGclProjection.visibilityLevel),
    );
    expect(got.sanitizedPayload).toEqual({ busySlots: 9 });
    expect(unwrap(await repos.gclProjections.listByWorkspace(validGclProjection.workspaceId))).toHaveLength(1);
  });

  it("get on a missing projection returns not_found", async () => {
    expect(unwrapErr(await repos.gclProjections.get(validGclProjection.workspaceId, "nope", "coordination")).code).toBe("not_found");
  });
});
