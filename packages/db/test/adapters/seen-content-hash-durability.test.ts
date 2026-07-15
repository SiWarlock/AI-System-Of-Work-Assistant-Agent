// Task 15.4 — SeenContentHashRepository DURABILITY across a (simulated) worker restart + the
// FAIL-CLOSED fault surface. spec(§4) spec(§19.2) spec(§16)
//
// The Flow-4 dedupe store replaces an in-memory dedupe that loses exactly-once across restart. Its
// two load-bearing §16 properties (worker Lesson 3):
//   (1) DURABILITY — a hash recorded by one repo instance is a `has`-hit for a FRESH repo instance
//       over the SAME on-disk db (survives a worker restart). An in-memory Map would lose it.
//   (2) FAULT ≠ NOT-SEEN — a store fault on `has`/`record` is a typed `err`, NEVER masked as a
//       benign `false` (not-seen) or a silent `ok` — the caller decides fail-closed (a masked
//       not-seen would re-dispatch, a masked ok would silently lose the dedupe record).
//   (3) FIRST-WRITE-WINS — re-recording the same key is idempotent (ON CONFLICT DO NOTHING); the
//       ORIGINAL seenAt is preserved (a later record never overwrites the first-seen timestamp).
//
// Server-free + deterministic: a real better-sqlite3 db in a TEMP FILE (not :memory:, which cannot
// survive a close). "Restart" = CLOSE the first connection, OPEN a fresh one over the same file.
// Mirror of parity-report-durability.test.ts / knowledge-revision-durability.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { isErr, isOk } from "@sow/contracts";
import type { SeenContentHashRow } from "../../src/repositories/interfaces";
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

function tempDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "sow-sch-"));
  tempDirs.push(dir);
  return join(dir, "ops.db");
}

const ws = (s: string): SeenContentHashRow["workspaceId"] => s as SeenContentHashRow["workspaceId"];
const row = (over: Partial<SeenContentHashRow> = {}): SeenContentHashRow => ({
  workspaceId: ws("ws-a"),
  contentHash: "hash-durable",
  seenAt: "2026-07-15T00:00:00.000Z",
  ...over,
});

describe("15.4 SeenContentHashRepository — durable across a worker restart (§4/§19.2/§16)", () => {
  it("survives_restart: a FRESH repo over the SAME on-disk db sees a prior instance's recorded hash (has=true)", async () => {
    const file = tempDbFile();

    // ── worker run #1: create schema, record a hash, SHUT DOWN ──
    const sqlite1 = new Database(file);
    createSqliteSchema(sqlite1);
    const repos1 = createSqliteRepositories(drizzle(sqlite1));
    expect(isOk(await repos1.seenContentHash.record(row()))).toBe(true);
    sqlite1.close(); // an in-memory store would vanish here

    // ── worker run #2 (RESTART): brand-new connection + FRESH repo over the same file ──
    const sqlite2 = new Database(file);
    const repos2 = createSqliteRepositories(drizzle(sqlite2));
    const seen = await repos2.seenContentHash.has({ workspaceId: ws("ws-a"), contentHash: "hash-durable" });
    const fresh = await repos2.seenContentHash.has({ workspaceId: ws("ws-a"), contentHash: "never-recorded" });
    sqlite2.close();

    expect(isOk(seen) && seen.value).toBe(true); // durable — survived the restart
    expect(isOk(fresh) && fresh.value).toBe(false); // a truly-unseen hash is still false
  });

  it("fault_is_a_typed_err_both_directions: an unreachable store ⇒ typed err on has AND record — NEVER a masked false/ok (fault ≠ not-seen; Lesson 3)", async () => {
    const file = tempDbFile();
    const sqlite = new Database(file);
    createSqliteSchema(sqlite);
    const repos = createSqliteRepositories(drizzle(sqlite));
    sqlite.close(); // the operational store goes unreachable mid-run

    const hasRes = await repos.seenContentHash.has({ workspaceId: ws("ws-a"), contentHash: "hash-1" });
    const recRes = await repos.seenContentHash.record(row());
    expect(isErr(hasRes)).toBe(true); // a fault, NOT a masked false (which would re-dispatch)
    if (isErr(hasRes)) expect(hasRes.error.code).not.toBe("not_found");
    expect(isErr(recRes)).toBe(true); // a fault, NOT a masked ok (which would silently lose the dedupe)
  });

  it("first_write_wins_preserves_original_seenAt: re-recording the same key is idempotent and does NOT overwrite the first-seen timestamp", async () => {
    const file = tempDbFile();
    const sqlite = new Database(file);
    createSqliteSchema(sqlite);
    const repos = createSqliteRepositories(drizzle(sqlite));
    expect(isOk(await repos.seenContentHash.record(row({ seenAt: "2026-01-01T00:00:00.000Z" })))).toBe(true);
    // A second record of the same (workspaceId, contentHash) with a LATER seenAt must be a no-op.
    expect(isOk(await repos.seenContentHash.record(row({ seenAt: "2027-12-31T00:00:00.000Z" })))).toBe(true);
    // Raw read: the ORIGINAL seenAt is preserved (ON CONFLICT DO NOTHING, not DO UPDATE).
    const stored = sqlite
      .prepare("SELECT seenAt FROM seen_content_hash WHERE workspaceId = ? AND contentHash = ?")
      .get("ws-a", "hash-durable") as { seenAt: string } | undefined;
    sqlite.close();
    expect(stored?.seenAt).toBe("2026-01-01T00:00:00.000Z"); // first-write-wins
  });
});
