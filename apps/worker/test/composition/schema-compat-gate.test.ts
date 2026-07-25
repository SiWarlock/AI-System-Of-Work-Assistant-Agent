// spec(§4) spec(§13) — task 11.2: the openDatabase app↔schema compat BOOT GATE (worker wiring).
//
// The compat gate is wired inside `openDatabase` (backends.ts), AFTER opening the
// connection and BEFORE `applyMigrations`: an incompatible on-disk schema refuses to boot
// with a typed repair throw (fail-closed, in the same style as the existing migration-
// failure throw) — no silent forward-only break (worker forbidden #4 / §4/§13). Genesis
// (a fresh DB, no migration history) is NOT a refusal — it migrates to target.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { isOk } from "@sow/contracts";
import { CURRENT_SCHEMA_VERSION, assertBootSchemaCompatible } from "@sow/db";

import { openDatabase, WORKER_APP_VERSION } from "../../src/composition/backends";

const CASE_TIMEOUT_MS = 30_000;

describe("openDatabase — §4/§13 app↔schema-version compat boot gate", () => {
  it(
    "genesis boots clean: a fresh in-memory DB passes the gate + migrates (no refusal)",
    async () => {
      const opened = await openDatabase({ dbPath: ":memory:" });
      // The gate did NOT refuse genesis; the operational repositories were built.
      expect(opened.repos).toBeDefined();
      opened.conn.close();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "an on-disk schema AHEAD of the app refuses to boot (fail-closed typed throw, never applyMigrations)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "sow-compat-gate-"));
      const dbFile = join(dir, "ops.db");
      try {
        // 1. Genesis boot creates + migrates the file DB (marker → target, history present).
        const first = await openDatabase({ dbPath: dbFile });
        first.conn.close();

        // 2. Force the on-disk marker AHEAD of what this app supports.
        const raw = new Database(dbFile);
        raw.pragma("user_version = 99");
        raw.close();

        // 3. Re-open → the compat gate refuses to boot with the typed repair.
        await expect(openDatabase({ dbPath: dbFile })).rejects.toThrow(
          /schema_ahead_of_app|newer app|refusing to start/i,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CASE_TIMEOUT_MS,
  );

  it("WORKER_APP_VERSION stays coherent with the compat table + CURRENT_SCHEMA_VERSION (drift guard)", () => {
    // A schema bump that forgets to bump WORKER_APP_VERSION (or add its compat-table row)
    // would make the worker refuse to boot after the first post-upgrade migration
    // (schema_ahead_of_app / unknown_app_version). Catch that drift at test time: the
    // shipping app version MUST be able to operate a DB at the current target schema.
    const r = assertBootSchemaCompatible(
      { version: CURRENT_SCHEMA_VERSION, hasMigrationHistory: true },
      WORKER_APP_VERSION,
    );
    expect(isOk(r)).toBe(true);
  });
});
