// Task 15.5 — SourceDispositionRepository DURABILITY across a (simulated) worker restart + the
// FAIL-CLOSED fault surface. spec(§4) spec(§19.2) spec(§16)
//
// The parked-source-of-record replaces an in-memory disposition map that loses parked sources on
// restart. Two load-bearing §16 properties (worker Lesson 3):
//   (1) DURABILITY — a source parked by one repo instance (its full SourceEnvelope + idempotencyKey)
//       is read back by a FRESH repo instance over the SAME on-disk db (survives a worker restart).
//   (2) FAULT ≠ ABSENCE — a store fault on park/get/recordDisposition is a typed `err`, NEVER masked
//       as a benign `ok(undefined)` (not-parked) or a silent `ok` — the caller decides fail-closed.
//
// Server-free + deterministic: a real better-sqlite3 db in a TEMP FILE (mirror
// seen-content-hash-durability / parity-report-durability). "Restart" = CLOSE conn#1, OPEN conn#2.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { isErr, isOk } from "@sow/contracts";
import type { SourceEnvelope } from "@sow/contracts";
import type { SourceDispositionRow } from "../../src/repositories/interfaces";
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
  const dir = mkdtempSync(join(tmpdir(), "sow-sd-"));
  tempDirs.push(dir);
  return join(dir, "ops.db");
}

const envelope = (): SourceEnvelope => ({
  sourceId: "src-durable" as SourceEnvelope["sourceId"],
  workspaceId: "capture-ws" as SourceEnvelope["workspaceId"],
  origin: "https://example.com/x",
  contentHash: "sha256:durable",
  type: "youtube_video",
  sensitivity: "normal",
  routingHints: {},
});
const row = (): SourceDispositionRow => ({
  sourceId: "src-durable",
  sourceEnvelope: envelope(),
  idempotencyKey: "src:capture-ws:sha256:durable",
  state: "queued_for_review",
  dispositionKey: null,
  auditRef: null,
  parkedAt: "2026-07-15T00:00:00.000Z",
  dispositionedAt: null,
});

describe("15.5 SourceDispositionRepository — durable across a worker restart (§4/§19.2/§16)", () => {
  it("survives_restart: a FRESH repo over the SAME on-disk db reads back a prior instance's parked source (incl. the full SourceEnvelope)", async () => {
    const file = tempDbFile();

    const sqlite1 = new Database(file);
    createSqliteSchema(sqlite1);
    const repos1 = createSqliteRepositories(drizzle(sqlite1));
    expect(isOk(await repos1.sourceDisposition.park(row()))).toBe(true);
    sqlite1.close(); // an in-memory map would vanish here

    const sqlite2 = new Database(file);
    const repos2 = createSqliteRepositories(drizzle(sqlite2));
    const got = await repos2.sourceDisposition.getBySourceId("src-durable");
    const absent = await repos2.sourceDisposition.getBySourceId("never-parked");
    sqlite2.close();

    expect(isOk(got) && got.value?.sourceEnvelope).toEqual(envelope()); // durable — the full parked envelope
    expect(isOk(got) && got.value?.idempotencyKey).toBe("src:capture-ws:sha256:durable");
    expect(isOk(absent) && absent.value).toBeUndefined(); // a truly-absent source is ok(undefined), not a fault
  });

  it("fault_is_a_typed_err: an unreachable store ⇒ typed err on park / getBySourceId / recordDisposition — NEVER a masked ok/undefined (Lesson 3)", async () => {
    const file = tempDbFile();
    const sqlite = new Database(file);
    createSqliteSchema(sqlite);
    const repos = createSqliteRepositories(drizzle(sqlite));
    sqlite.close(); // the operational store goes unreachable mid-run

    expect(isErr(await repos.sourceDisposition.park(row()))).toBe(true); // never a masked ok
    const getRes = await repos.sourceDisposition.getBySourceId("src-durable");
    expect(isErr(getRes)).toBe(true); // a fault, NOT a masked ok(undefined) (not-parked)
    if (isErr(getRes)) expect(getRes.error.code).not.toBe("not_found");
    expect(isErr(await repos.sourceDisposition.recordDisposition("src-durable", "k", "a", "2026-07-15T00:00:00.000Z"))).toBe(true);
  });
});
