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
import {
  ok,
  err,
  isOk,
  validParityReport,
  type Result,
  type ParityReport,
  type RevisionId,
  type WorkspaceId,
  type FactIdentity,
  type MdContentSha,
  type GbrainPin,
} from "@sow/contracts";
import { createSqliteRepositories, type ParityReportRepository } from "@sow/db";
import {
  isDegradedCoverage,
  computePageProvenance,
  stampProvenance,
  serializeStampFieldValue,
  type ReconcilerOutcome,
  type CanonicalVaultSnapshot,
  type SecretsPort,
  type SecretUnresolved,
  type StamperDeps,
} from "@sow/knowledge";
import {
  createParityReportStoreAdapter,
  createParityReportRecorderAdapter,
  recordReconcileOutcome,
} from "../../../src/composition/parityReportStore";
import {
  createServingCoverageReader,
  type ServingCoverageReaderDeps,
} from "../../../src/api/procedures/servingContextBootReaders";
import {
  deriveServingCoverage,
  createServingContextLoader,
} from "../../../src/api/procedures/servingContextLoader";

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

// ── 19.9 — the one missing pin: an ALL-FOUR-LEGS-TRUE READY case + a shipped-default DEGRADE case ──────
const WS_BRAND = WS as unknown as WorkspaceId;
const SIGNING_REF = "kw-key";
const SIGNING_KEY = new Uint8Array(32).fill(7);

class FakeSecretsPort implements SecretsPort {
  constructor(private readonly keys: Record<string, Uint8Array>) {}
  resolveSigningKey(ref: string): Promise<Result<Uint8Array, SecretUnresolved>> {
    const k = this.keys[ref];
    return Promise.resolve(k !== undefined ? ok(k) : err({ code: "secret_unresolved", ref }));
  }
}
const stamperDeps: StamperDeps = {
  secrets: new FakeSecretsPort({ [SIGNING_REF]: SIGNING_KEY }),
  signingKeyRef: SIGNING_REF,
};

/** Stamp a note exactly as the KnowledgeWriter does (mirrors servingContextLoader.test.ts's helper) so the
 *  loader's deriveCanonicalFacts sees a real, admissible page fact — never a hand-built allow-set. */
async function stampNote(path: string, base: string): Promise<string> {
  const page = computePageProvenance(path, base);
  if (page === null) throw new Error("no slug");
  const minted = await stampProvenance(
    {
      workspaceId: WS_BRAND,
      factIdentity: page.pageIdentity as FactIdentity,
      originPath: path,
      mdContentSha: page.pageSha as MdContentSha,
      kwRevision: REV,
      sourceEventRef: "src-1",
      committedAt: CLOCK,
    },
    stamperDeps,
  );
  if (!minted.ok) throw new Error("mint failed");
  const value = serializeStampFieldValue(minted.value);
  const close = base.indexOf("\n---\n", 4);
  return `${base.slice(0, close)}\nkwStamp: ${value}${base.slice(close)}`;
}

async function stampedSnapshot(): Promise<CanonicalVaultSnapshot> {
  const path = "notes/acme.md";
  const stamped = await stampNote(path, "---\ntitle: Acme\n---\nprose");
  return { workspaceId: WS_BRAND, revisionId: REV, files: new Map([[path, stamped]]) };
}

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

  // 19.9 — deriveServingCoverage/createServingContextLoader already read all four legs with strict
  // `=== true` and no hardcoded green (there is no leg-ASSEMBLY code to write); what was missing was a
  // test that actually reaches READY through the loader with every leg genuinely true.
  it("parity_chain_all_four_legs_true_reaches_READY_e2e", async () => {
    const repo = realParityRepo();
    await recordReconcileOutcome(ok(cleanOutcome("rev-1")), createParityReportRecorderAdapter(repo, () => CLOCK));
    // The 4th (deferred) leg: a fake resolveOracleBuild returning true, alongside the already-green
    // parity legs (via the real store-bound reader, as above) and the valid pin (via READER_DEPS).
    const readServingCoverage = createServingCoverageReader({
      ...READER_DEPS,
      store: createParityReportStoreAdapter(repo),
      resolveOracleBuild: () => true,
    });
    // Sanity: the coverage reader itself now greens all four legs (isolates "the reader is green" from
    // "the loader reaches READY off it" — two different things that could each independently break).
    const coverage = deriveServingCoverage(await readServingCoverage(WS, REV));
    expect(coverage).toEqual({ cleanForServing: true, coverageComplete: true, pinValid: true, oracleBuildOk: true });
    expect(isDegradedCoverage(coverage)).toBe(false);

    const loader = createServingContextLoader({
      readCommittedVault: () => stampedSnapshot(),
      readServingCoverage,
      secrets: stamperDeps.secrets,
      signingKeyRef: stamperDeps.signingKeyRef,
    });
    const r = await loader(WS);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.mode).toBe("ready");
    if (r.value.mode !== "ready") return;
    expect(isDegradedCoverage(r.value.context.coverage)).toBe(false);
    expect(r.value.context.allowSet.facts.some((f) => String(f.fact.factIdentity) === "page:acme")).toBe(true);
  });

  // 19.9 — the shipped-default configuration (no ParityReportStore bound, no resolveOracleBuild bound —
  // exactly the deps shape boot.ts constructs when config.copilotProvenanceStamping is unset/off) still
  // DEGRADES even over a perfectly valid, stamped vault: nothing gates green by omission.
  it("parity_chain_shipped_default_degrades_e2e (no store, no resolveOracleBuild bound)", async () => {
    const shippedDefaultDeps: ServingCoverageReaderDeps = {
      pin: PIN,
      resolveRunning: () => undefined, // no cached startup probe bound — the shipped default
      now: () => CLOCK,
      // store OMITTED, resolveOracleBuild OMITTED — the real byte-equivalent shipped-default shape.
    };
    const readServingCoverage = createServingCoverageReader(shippedDefaultDeps);
    const loader = createServingContextLoader({
      readCommittedVault: () => stampedSnapshot(), // the vault itself is fine — coverage alone must degrade it
      readServingCoverage,
      secrets: stamperDeps.secrets,
      signingKeyRef: stamperDeps.signingKeyRef,
    });
    const r = await loader(WS);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.mode).toBe("degraded");
  });
});
