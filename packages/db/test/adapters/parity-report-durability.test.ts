// Task 11.1 (B1) — ParityReportRepository DURABILITY across a (simulated) worker restart +
// the FAIL-CLOSED payload gate. spec(§4) spec(§6) spec(§16)
//
// The serve-time coverage kill-switch reads the latest ParityReport for a workspace @ revision;
// a false "clean report present" is a trust-gate defeat, so the store's two §16 properties matter:
//   (1) DURABILITY — a report recorded by one repo instance is visible to a FRESH repo instance
//       over the SAME on-disk database (survives a worker restart). An in-memory Map would lose it.
//   (2) FAULT ≠ ABSENCE — a stored payload that fails `ParityReportSchema.parse` is a FAULT (typed
//       `err`), never folded to a silent `undefined` absence (which reads as "never reconciled ⇒
//       degrade" — the wrong reason). A genuinely-absent (workspace,revision) is `ok(undefined)`.
//
// Server-free + deterministic: a real better-sqlite3 database in a TEMP FILE (not `:memory:`, which
// cannot survive a close), the schema created via the same DDL-from-schema helper the adapter tests
// use. "Restart" = CLOSE the first connection and OPEN a brand-new one over the same file. The
// malformed-payload row is inserted RAW (bypassing the repo's typed `record`) to simulate a corrupt
// on-disk blob the read-back gate must reject. Mirror of `knowledge-revision-durability.test.ts`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { isErr, isOk, validParityReport, validDivergence, type ParityReport } from "@sow/contracts";
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
  const dir = mkdtempSync(join(tmpdir(), "sow-pr-"));
  tempDirs.push(dir);
  return join(dir, "ops.db");
}

// A dirty-but-valid report carrying a non-empty divergences[] — proves the embedded Divergence
// class round-trips through disk (a soft divergence is allowed with cleanForServing:false).
const REPORT: ParityReport = {
  ...validParityReport,
  reportId: "report-durable" as ParityReport["reportId"],
  workspaceId: "ws-001" as ParityReport["workspaceId"],
  reconciledAtRevision: "rev-durable" as ParityReport["reconciledAtRevision"],
  divergences: [validDivergence],
  cleanForServing: false,
};

describe("11.1 ParityReportRepository — durable across a worker restart (§4/§6/§16)", () => {
  it("a FRESH repo over the SAME on-disk db sees a prior instance's recorded report (incl. divergences[])", async () => {
    const file = tempDbFile();

    // ── worker run #1: create schema, record a report, then SHUT DOWN ──────────────
    const sqlite1 = new Database(file);
    createSqliteSchema(sqlite1);
    const repos1 = createSqliteRepositories(drizzle(sqlite1));
    const recorded = await repos1.parityReports.record(REPORT, "2026-07-13T00:00:00.000Z");
    expect(isOk(recorded)).toBe(true);
    sqlite1.close(); // the worker process exits — an in-memory store would vanish here

    // ── worker run #2 (RESTART): brand-new connection + FRESH repo over the same file ─
    const sqlite2 = new Database(file);
    const repos2 = createSqliteRepositories(drizzle(sqlite2));
    const got = await repos2.parityReports.getLatestForRevision("ws-001", "rev-durable");
    sqlite2.close();

    // Durable: the report survived the restart, schema-parse-equal to what was recorded.
    expect(isOk(got)).toBe(true);
    if (!isOk(got)) return;
    expect(got.value).toEqual(REPORT);
  });

  it("an unknown (workspace, revision) returns ok(undefined) — a TRUE absence, never a fault", async () => {
    const file = tempDbFile();
    const sqlite = new Database(file);
    createSqliteSchema(sqlite);
    const repos = createSqliteRepositories(drizzle(sqlite));
    const got = await repos.parityReports.getLatestForRevision("ws-nope", "rev-nope");
    sqlite.close();
    expect(isOk(got)).toBe(true);
    if (!isOk(got)) return;
    expect(got.value).toBeUndefined();
  });

  it("record surfaces a real store fault as a typed err — NEVER a masked ok (§16 write direction)", async () => {
    // Force a DbError on the INSERT path: create the schema + repo, then CLOSE the handle so the
    // store is unreachable. A `record` that swallowed the driver throw into `ok()` would silently
    // lose a parity report — a §16 "nothing fails silently" hole on the trust-oracle's substrate
    // (fail-SAFE — a lost write ⇒ coverage degrades — but still a hole, so pin it here, not in B3).
    const file = tempDbFile();
    const sqlite = new Database(file);
    createSqliteSchema(sqlite);
    const repos = createSqliteRepositories(drizzle(sqlite));
    sqlite.close(); // the operational store goes unreachable mid-run
    const res = await repos.parityReports.record(REPORT, "2026-07-13T00:00:00.000Z");
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    // A fault, not a masked absence — consistent with the ok(undefined)=absence / err=fault model.
    expect(res.error.code).not.toBe("not_found");
  });

  it("a stored payload that fails ParityReportSchema.parse surfaces a typed err (FAULT), not undefined (ABSENCE)", async () => {
    const file = tempDbFile();
    const sqlite = new Database(file);
    createSqliteSchema(sqlite);
    // Insert a CORRUPT payload directly (bypass the repo's typed record) — valid JSON but NOT a
    // ParityReport (missing every required field). The read-back gate must reject it, fail-closed.
    sqlite
      .prepare(
        'INSERT INTO "parity_reports" ("reportId","workspaceId","reconciledAtRevision","recordedAt","payload") VALUES (?,?,?,?,?)',
      )
      .run("report-bad", "ws-corrupt", "rev-corrupt", "2026-07-13T00:00:00.000Z", JSON.stringify({ garbage: true }));

    const repos = createSqliteRepositories(drizzle(sqlite));
    const got = await repos.parityReports.getLatestForRevision("ws-corrupt", "rev-corrupt");
    sqlite.close();

    // A fault is a typed err — DISTINGUISHABLE from a true absence (ok(undefined)): the coverage
    // reader must degrade on a fault, never treat a corrupt row as "no report".
    expect(isErr(got)).toBe(true);
    if (!isErr(got)) return;
    expect(got.error.code).not.toBe("not_found");
    expect(["constraint_violation", "serialization_failure", "unavailable", "unknown", "conflict"]).toContain(
      got.error.code,
    );
  });

  it("a stored payload whose OWN workspaceId/revision disagree with the query-key columns is a typed err (WS-8 fail-closed), never a cross-workspace surface", async () => {
    const file = tempDbFile();
    const sqlite = new Database(file);
    createSqliteSchema(sqlite);
    // A TAMPERED row: the denormalized query-key COLUMNS say (ws-tamper, rev-tamper) — so the query
    // FINDS it — but the embedded payload is a valid ParityReport claiming a DIFFERENT workspace and
    // revision (ws-other/rev-other). The typed `record` can NEVER produce this (it writes column ≡
    // payload); only out-of-band tampering/corruption can. The read-back identity gate (safety rule 4
    // / WS-8 defense-in-depth) must reject it as a FAULT, so a query for ws-tamper cannot surface
    // ws-other's report. Fault ≠ absence: err, not ok(undefined).
    const mismatchedPayload: ParityReport = {
      ...REPORT,
      reportId: "report-tampered" as ParityReport["reportId"],
      workspaceId: "ws-other" as ParityReport["workspaceId"],
      reconciledAtRevision: "rev-other" as ParityReport["reconciledAtRevision"],
    };
    sqlite
      .prepare(
        'INSERT INTO "parity_reports" ("reportId","workspaceId","reconciledAtRevision","recordedAt","payload") VALUES (?,?,?,?,?)',
      )
      .run(
        "report-tampered",
        "ws-tamper",
        "rev-tamper",
        "2026-07-13T00:00:00.000Z",
        JSON.stringify(mismatchedPayload),
      );

    const repos = createSqliteRepositories(drizzle(sqlite));
    const got = await repos.parityReports.getLatestForRevision("ws-tamper", "rev-tamper");
    sqlite.close();

    expect(isErr(got)).toBe(true);
    if (!isErr(got)) return;
    expect(got.error.code).not.toBe("not_found");
  });
});
