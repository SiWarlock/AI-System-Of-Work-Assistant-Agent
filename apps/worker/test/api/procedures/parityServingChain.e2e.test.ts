// Task 13.10 (B4) — the serve-time parity read chain END-TO-END over a REAL parityReports repo. This is the
// integration proof for the composition-root CLOSING slice: the B3 recorder writes a clean revision-matched
// ParityReport into a real @sow/db ParityReportRepository, and the B1 store-bound B2 reader reads it back to
// green the two PARITY coverage legs (cleanForServing + coverageComplete) — while the overall verdict STILL
// degrades on the DEFERRED oracleBuildOk (rebuild-oracle) leg (honest no-false-green). It proves the exact
// write→read chain boot binds in B4 (`createServingCoverageReader({ store: createParityReportStoreAdapter(
// backends.repos.parityReports) })`), closing the B2 store-consuming reachability waiver. spec(§6) spec(§7)
//
// A REAL sqlite repo (better-sqlite3, the parity_reports table only) — a genuine ParityReportRepository, not a
// fake; mirrors the B1 durability test. (The repo contract is dialect-agnostic + both-dialect-tested in
// @sow/db, so sqlite here proves the chain without a pglite async spin-up.)
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, it, expect } from "vitest";
import { ok, validParityReport, type ParityReport, type RevisionId, type GbrainPin } from "@sow/contracts";
import { createSqliteRepositories, type ParityReportRepository } from "@sow/db";
import { isDegradedCoverage, type ReconcilerOutcome } from "@sow/knowledge";
import {
  createParityReportStoreAdapter,
  createParityReportRecorderAdapter,
  recordReconcileOutcome,
} from "../../../src/composition/parityReportStore";
import { createServingCoverageReader } from "../../../src/api/procedures/servingContextBootReaders";
import { deriveServingCoverage } from "../../../src/api/procedures/servingContextLoader";

const WS = "ws-personal";
const REV = "rev-1" as unknown as RevisionId;
const CLOCK = "2026-07-13T00:00:00.000Z";

// A valid pin + a matching running probe ⇒ pinValid TRUE, so the ONLY false leg is `oracleBuildOk` — the
// degrade is attributable to the deferred rebuild-oracle leg, not the pin (isolates the honest no-false-green).
const PIN = {
  gbrainSha: "abc1234def",
  indexSchemaVersion: 1,
  validatedOn: "2026-01-01T00:00:00.000Z",
  writeThroughEnabled: false,
} as unknown as GbrainPin;
const READER_DEPS = {
  pin: PIN,
  resolveRunning: (): { sha: string; indexSchemaVersion: number } => ({ sha: "abc1234def", indexSchemaVersion: 1 }),
  now: (): string => CLOCK,
};

// The 0006 sqlite migration DDL for parity_reports (the one table this chain touches).
const PARITY_TABLE_DDL = `CREATE TABLE \`parity_reports\` (
  \`reportId\` text PRIMARY KEY NOT NULL,
  \`workspaceId\` text NOT NULL,
  \`reconciledAtRevision\` text NOT NULL,
  \`recordedAt\` text NOT NULL,
  \`payload\` text NOT NULL
);`;

/** A fresh in-memory better-sqlite3 ParityReportRepository — a REAL repo (the parity_reports table only). */
function realParityRepo(): ParityReportRepository {
  const db = new Database(":memory:");
  db.exec(PARITY_TABLE_DDL);
  return createSqliteRepositories(drizzle(db)).parityReports;
}

/** A clean reconcile outcome scoped to `rev` (both serving booleans true, no divergences). */
function cleanOutcome(rev: string): ReconcilerOutcome {
  const report: ParityReport = {
    ...validParityReport,
    reportId: `rep-${rev}` as ParityReport["reportId"],
    workspaceId: WS as unknown as ParityReport["workspaceId"],
    reconciledAtRevision: rev as unknown as ParityReport["reconciledAtRevision"],
    divergences: [],
    cleanForServing: true,
    coverageComplete: true,
  };
  return { report, divergences: report.divergences, healthItems: [], coverageComplete: true };
}

describe("parity serving chain e2e (B4) — write→read round-trip over a REAL sqlite parityReports repo", () => {
  it("parity_chain_greens_both_parity_legs_e2e", async () => {
    const repo = realParityRepo();
    // seed a clean revision-matched report through the B3 recorder (a genuine write→read round-trip)
    const disposition = await recordReconcileOutcome(
      ok(cleanOutcome("rev-1")),
      createParityReportRecorderAdapter(repo, () => CLOCK),
    );
    expect(disposition.kind).toBe("recorded");
    // the store-bound reader reads it back ⇒ deriveServingCoverage greens the two PARITY legs (+ real pinValid)
    const reader = createServingCoverageReader({ ...READER_DEPS, store: createParityReportStoreAdapter(repo) });
    const coverage = deriveServingCoverage(await reader(WS, REV));
    expect(coverage.cleanForServing).toBe(true);
    expect(coverage.coverageComplete).toBe(true);
    expect(coverage.pinValid).toBe(true);
  });

  it("parity_chain_still_degrades_on_oracle_build_ok_e2e", async () => {
    const repo = realParityRepo();
    await recordReconcileOutcome(ok(cleanOutcome("rev-1")), createParityReportRecorderAdapter(repo, () => CLOCK));
    const reader = createServingCoverageReader({ ...READER_DEPS, store: createParityReportStoreAdapter(repo) });
    const coverage = deriveServingCoverage(await reader(WS, REV));
    // HONEST no-false-green: the parity legs + pin are green, but oracleBuildOk (the rebuild-oracle leg, DEFERRED)
    // is false ⇒ the AND-composed verdict STILL degrades. Full green admission awaits the rebuild-oracle leg.
    expect(coverage.oracleBuildOk).toBe(false);
    expect(isDegradedCoverage(coverage)).toBe(true);
  });

  it("parity_chain_stale_revision_degrades_e2e", async () => {
    const repo = realParityRepo();
    // record a clean report scoped to a NON-head revision
    await recordReconcileOutcome(ok(cleanOutcome("rev-STALE")), createParityReportRecorderAdapter(repo, () => CLOCK));
    const reader = createServingCoverageReader({ ...READER_DEPS, store: createParityReportStoreAdapter(repo) });
    // the reader queries the store by the HEAD revision (rev-1); the stale report is stored under rev-STALE, so
    // the revision-scoped store query returns NOTHING ⇒ parity undefined ⇒ both parity legs false ⇒ degrade.
    // The staleness kill-switch fires end-to-end through the REAL store (the store's query key IS revision-scoped).
    const coverage = deriveServingCoverage(await reader(WS, REV));
    expect(coverage.cleanForServing).toBe(false);
    expect(coverage.coverageComplete).toBe(false);
    // pinValid STAYS true — proving the degrade is the missing revision-scoped row (a TRUE absence), not a
    // swallowed store fault (a reject would collapse ALL legs incl. pinValid to false — a different cause).
    expect(coverage.pinValid).toBe(true);
    expect(isDegradedCoverage(coverage)).toBe(true);
  });
});
