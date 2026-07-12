// Task 11.1 — KnowledgeRevisionRepository DURABILITY across a (simulated) worker restart.
// spec(§4) spec(§6) spec(§16)
//
// The LOAD-BEARING property of the durable KnowledgeRevisionStore: a revision recorded by
// one repo instance is visible to a FRESH repo instance over the SAME on-disk database — i.e.
// it SURVIVES a worker restart. The prior in-memory `Map` stub (apps/worker boot.ts
// `inertRevisions`) FAILS this: its state is per-process, so a restarted worker would see no
// prior commit for the idempotencyKey and RE-COMMIT (a duplicate KnowledgeWriter write). This
// is the exactly-once substrate — the reason the store must be a persisted table, not a Map.
//
// Server-free + deterministic: a real better-sqlite3 database materialized in a TEMP FILE (not
// `:memory:`, which cannot survive a close), the schema created via the same DDL-from-schema
// helper the adapter tests use. "Restart" = CLOSE the first connection and OPEN a brand-new
// one over the same file, then build a FRESH `createSqliteRepositories` over it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { isErr, isOk, validAuditRecord, validWorkflowRunRef } from "@sow/contracts";
import type { CommittedRevisionRow } from "../../src/repositories/interfaces";
import { createSqliteRepositories } from "../../src/adapters/sqlite/index";
import { createSqliteSchema } from "./create-sqlite-schema";

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/** A fresh temp-file db path (NOT :memory: — the file must outlive a connection close). */
function tempDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "sow-kr-"));
  tempDirs.push(dir);
  return join(dir, "ops.db");
}

const REVISION: CommittedRevisionRow = {
  revisionId: "rev:durable",
  baseRevisionId: "rev:0000",
  idempotencyKey: "idem-restart",
  planId: "plan-durable",
  actor: "KnowledgeWriter",
  sourceEventRef: "evt-durable",
  workflowRunRef: validWorkflowRunRef,
  auditRecord: validAuditRecord,
  committedAt: "2026-07-12T00:00:00.000Z",
};

describe("11.1 KnowledgeRevisionRepository — durable across a worker restart (§4/§6/§16)", () => {
  it("a FRESH repo instance over the SAME on-disk db sees a prior instance's recorded revision", async () => {
    const file = tempDbFile();

    // ── worker run #1: create schema, record a revision, then SHUT DOWN ───────────
    const sqlite1 = new Database(file);
    createSqliteSchema(sqlite1);
    const repos1 = createSqliteRepositories(drizzle(sqlite1));
    const recorded = await repos1.knowledgeRevisions.record(REVISION);
    expect(isOk(recorded)).toBe(true);
    sqlite1.close(); // the worker process exits — the in-memory Map would vanish here

    // ── worker run #2 (RESTART): brand-new connection + FRESH repo over the same file ─
    const sqlite2 = new Database(file);
    const repos2 = createSqliteRepositories(drizzle(sqlite2));
    const got = await repos2.knowledgeRevisions.getByIdempotencyKey("idem-restart");
    sqlite2.close();

    // Durable: the record survived the restart (a Map-backed store returns not_found here).
    expect(isOk(got)).toBe(true);
    if (!isOk(got)) return;
    expect(got.value.revisionId).toBe("rev:durable");
    expect(got.value.planId).toBe("plan-durable");
    expect(got.value.idempotencyKey).toBe("idem-restart");
    // The json columns survive the round-trip through disk structurally intact.
    expect(got.value.workflowRunRef).toEqual(validWorkflowRunRef);
    expect(got.value.auditRecord).toEqual(validAuditRecord);
  });

  it("an idempotencyKey never recorded returns not_found on a fresh instance (no phantom rows)", async () => {
    const file = tempDbFile();
    const sqlite1 = new Database(file);
    createSqliteSchema(sqlite1);
    const repos1 = createSqliteRepositories(drizzle(sqlite1));
    await repos1.knowledgeRevisions.record(REVISION);
    sqlite1.close();

    const sqlite2 = new Database(file);
    const repos2 = createSqliteRepositories(drizzle(sqlite2));
    const got = await repos2.knowledgeRevisions.getByIdempotencyKey("never-recorded");
    sqlite2.close();
    expect(isErr(got)).toBe(true);
    if (!isErr(got)) return;
    expect(got.error.code).toBe("not_found");
  });
});
