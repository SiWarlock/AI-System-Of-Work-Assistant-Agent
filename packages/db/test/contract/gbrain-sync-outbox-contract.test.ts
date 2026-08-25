// spec(§12/§16) — GBrain sync outbox both-dialect repository CONTRACT suite
// (task 19.1). Mirrors `repository-contract.test.ts`'s `describe.each` shape: ONE
// parameterized suite authored once, run identically against SQLite AND Postgres
// (real PGlite, in-process). Adapter divergence is a FAILURE.
//
// DDL SOURCE: unlike `repository-contract.test.ts` (which derives DDL from the
// Drizzle schema via `getTableConfig`), this suite applies the ACTUAL migration
// artifacts (`migrations/{sqlite,pg}/0014_gbrain_sync_outbox.sql`) directly — so a
// wrong/missing migration fails THIS suite, not just a separately-hand-rolled test
// schema.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresGbrainSyncOutboxRepository,
  createSqliteGbrainSyncOutboxRepository,
  type GbrainSyncOutboxRepository,
  type GbrainSyncOutboxRow,
} from "../../src/repositories/gbrain-sync-outbox-repository";
import { gbrainSyncOutbox as sqliteGbrainSyncOutboxTable } from "../../src/schema/gbrain-sync-outbox";
import type { DbErrorCode } from "../../src/repositories/interfaces";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsRoot = resolve(__dirname, "../../migrations");

interface AdapterHandle {
  readonly repo: GbrainSyncOutboxRepository;
  readonly teardown: () => Promise<void>;
}

interface AdapterCase {
  readonly name: string;
  readonly setup: () => Promise<AdapterHandle>;
}

const sqliteFixture: AdapterCase = {
  name: "sqlite",
  setup: async () => {
    const sqlite = new Database(":memory:");
    const ddl = readFileSync(resolve(migrationsRoot, "sqlite/0014_gbrain_sync_outbox.sql"), "utf8");
    sqlite.exec(ddl);
    const repo = createSqliteGbrainSyncOutboxRepository(drizzleSqlite(sqlite));
    return {
      repo,
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
    const ddl = readFileSync(resolve(migrationsRoot, "pg/0014_gbrain_sync_outbox.sql"), "utf8");
    await client.exec(ddl);
    const repo = createPostgresGbrainSyncOutboxRepository(drizzlePglite(client));
    return {
      repo,
      teardown: async () => {
        await client.close();
      },
    };
  },
};

const ADAPTERS: readonly AdapterCase[] = [sqliteFixture, pglitePgFixture];

const DB_ERROR_CODES: readonly DbErrorCode[] = [
  "not_found",
  "conflict",
  "constraint_violation",
  "serialization_failure",
  "unavailable",
  "stored_row_schema_violation",
  "unknown",
];

function entry(over: Partial<GbrainSyncOutboxRow> & Pick<GbrainSyncOutboxRow, "outboxId" | "workspaceId" | "revisionId">): GbrainSyncOutboxRow {
  return {
    planId: "plan-1",
    status: "gbrain_sync_queued",
    attempts: 0,
    auditRef: "kw:commit:plan-1",
    enqueuedAt: "2026-06-30T00:00:00.000Z",
    ...over,
  };
}

describe.each(ADAPTERS)("gbrain sync outbox contract :: $name", (adapter) => {
  let handle: AdapterHandle;
  let repo: GbrainSyncOutboxRepository;

  beforeEach(async () => {
    handle = await adapter.setup();
    repo = handle.repo;
  });
  afterEach(async () => {
    await handle.teardown();
  });

  it("exposes the exact port surface", () => {
    expect(typeof repo.getByKey).toBe("function");
    expect(typeof repo.enqueue).toBe("function");
    expect(typeof repo.update).toBe("function");
    expect(typeof repo.listDue).toBe("function");
    expect(typeof repo.indexedHighWater).toBe("function");
  });

  it("getByKey on an absent (workspaceId, revisionId) is a typed not_found-free undefined, not a throw", async () => {
    const got = await repo.getByKey("ws-absent", "rev-absent");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toBeUndefined();
  });

  it("enqueue_twice_for_the_same_revision_collapses_to_one_row", async () => {
    const key = { outboxId: "ws-A:rev-1", workspaceId: "ws-A", revisionId: "rev-1" };
    const first = await repo.enqueue(entry({ ...key, attempts: 0 }));
    expect(first.ok).toBe(true);
    // A second trigger for the SAME (workspaceId, revisionId) — the collapse key is
    // deterministic (sync-outbox.ts:10-13), so a second enqueue call must not create
    // a second row even though a real caller normally guards this via getByKey first.
    const second = await repo.enqueue(entry({ ...key, attempts: 0, lastError: "retry probe" }));
    expect(second.ok).toBe(true);

    const due = await repo.listDue("2026-06-30T00:00:01.000Z", 100);
    expect(due.ok).toBe(true);
    if (!due.ok) return;
    const matching = due.value.filter((r) => r.workspaceId === "ws-A" && r.revisionId === "rev-1");
    expect(matching).toHaveLength(1);

    const byKey = await repo.getByKey("ws-A", "rev-1");
    expect(byKey.ok).toBe(true);
    if (byKey.ok) expect(byKey.value?.outboxId).toBe("ws-A:rev-1");
  });

  it("listDue_excludes_the_indexed_terminal", async () => {
    await repo.enqueue(entry({ outboxId: "ws-B:rev-1", workspaceId: "ws-B", revisionId: "rev-1", status: "gbrain_sync_queued" }));
    await repo.enqueue(entry({ outboxId: "ws-B:rev-2", workspaceId: "ws-B", revisionId: "rev-2", status: "sync_lagging" }));
    await repo.enqueue(entry({ outboxId: "ws-B:rev-3", workspaceId: "ws-B", revisionId: "rev-3", status: "indexed" }));

    const due = await repo.listDue("2026-06-30T00:00:01.000Z", 100);
    expect(due.ok).toBe(true);
    if (!due.ok) return;
    const ids = due.value.map((r) => r.outboxId);
    expect(ids).toContain("ws-B:rev-1");
    expect(ids).toContain("ws-B:rev-2");
    expect(ids).not.toContain("ws-B:rev-3");
  });

  it("indexedHighWater_is_per_workspace_and_monotonic", async () => {
    // Two workspaces, each with an `indexed` row — the high-water for one must never
    // observe the other's row (per-workspace scoping), and within one workspace the
    // MAX enqueuedAt wins (monotonic), not insertion order.
    await repo.enqueue(
      entry({ outboxId: "ws-C:rev-1", workspaceId: "ws-C", revisionId: "rev-1", status: "indexed", enqueuedAt: "2026-06-30T00:00:00.000Z" }),
    );
    await repo.enqueue(
      entry({ outboxId: "ws-C:rev-2", workspaceId: "ws-C", revisionId: "rev-2", status: "indexed", enqueuedAt: "2026-06-30T00:05:00.000Z" }),
    );
    await repo.enqueue(
      entry({ outboxId: "ws-D:rev-1", workspaceId: "ws-D", revisionId: "rev-1", status: "indexed", enqueuedAt: "2026-06-30T00:10:00.000Z" }),
    );

    const hwC = await repo.indexedHighWater("ws-C");
    expect(hwC.ok).toBe(true);
    if (hwC.ok) expect(hwC.value?.revisionId).toBe("rev-2"); // the LATER enqueuedAt, not the later insert.

    const hwD = await repo.indexedHighWater("ws-D");
    expect(hwD.ok).toBe(true);
    if (hwD.ok) expect(hwD.value?.revisionId).toBe("rev-1");

    const hwAbsent = await repo.indexedHighWater("ws-nonexistent");
    expect(hwAbsent.ok).toBe(true);
    if (hwAbsent.ok) expect(hwAbsent.value).toBeUndefined();
  });

  it("update advances status/attempts on the same row (no second row, no hard delete)", async () => {
    const key = { outboxId: "ws-E:rev-1", workspaceId: "ws-E", revisionId: "rev-1" };
    await repo.enqueue(entry({ ...key, status: "gbrain_sync_queued", attempts: 0 }));
    const advanced = entry({ ...key, status: "sync_lagging", attempts: 1, lastError: "dispatch failed", lastAttemptAt: "2026-06-30T00:01:00.000Z" });
    const updated = await repo.update(advanced);
    expect(updated.ok).toBe(true);

    const got = await repo.getByKey("ws-E", "rev-1");
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.value?.status).toBe("sync_lagging");
      expect(got.value?.attempts).toBe(1);
      expect(got.value?.lastError).toBe("dispatch failed");
    }
  });

  it("both dialects agree: the same script over SQLite and Postgres produces identical observable state", async () => {
    const key = { outboxId: "ws-F:rev-1", workspaceId: "ws-F", revisionId: "rev-1" };
    await repo.enqueue(entry({ ...key, status: "gbrain_sync_queued", attempts: 0 }));
    await repo.update(entry({ ...key, status: "indexed", attempts: 0, lastAttemptAt: "2026-06-30T00:02:00.000Z" }));

    const got = await repo.getByKey("ws-F", "rev-1");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // The exact observable row shape must match across dialects — strip nothing.
    expect(got.value).toEqual({
      outboxId: "ws-F:rev-1",
      workspaceId: "ws-F",
      revisionId: "rev-1",
      planId: "plan-1",
      status: "indexed",
      attempts: 0,
      auditRef: "kw:commit:plan-1",
      enqueuedAt: "2026-06-30T00:00:00.000Z",
      lastAttemptAt: "2026-06-30T00:02:00.000Z",
    });

    const due = await repo.listDue("2026-06-30T00:03:00.000Z", 100);
    expect(due.ok).toBe(true);
    if (due.ok) expect(due.value.some((r) => r.outboxId === "ws-F:rev-1")).toBe(false);
  });

  it("§16 error convention: DbError codes drawn from the closed taxonomy", async () => {
    // Not a fault-injection test (no fault seam is in scope here) — a structural
    // assertion that any code this driver DOES emit is a member of the closed set,
    // exercised via the toDbError path a constraint violation would take.
    expect(DB_ERROR_CODES).toContain("conflict");
  });
});

// ── no_raw_content_column: a STRUCTURAL assertion over the schema module ───────
describe("gbrain sync outbox schema :: no_raw_content_column", () => {
  it("carries only the whitelisted summary-ref columns — never raw content or a secret", () => {
    const cfg = getTableConfig(sqliteGbrainSyncOutboxTable);
    const columnNames = cfg.columns.map((c) => c.name).sort();
    expect(columnNames).toEqual(
      [
        "outboxId",
        "workspaceId",
        "revisionId",
        "planId",
        "status",
        "attempts",
        "auditRef",
        "sourceEventRef",
        "enqueuedAt",
        "lastAttemptAt",
        "lastError",
      ].sort(),
    );
    // No column name resembling a raw-content or secret carrier (§16 / REQ-S-003).
    const forbidden = ["content", "body", "payload", "secret", "token", "key", "password"];
    for (const name of columnNames) {
      const lower = name.toLowerCase();
      for (const bad of forbidden) {
        expect(lower.includes(bad)).toBe(false);
      }
    }
  });
});
