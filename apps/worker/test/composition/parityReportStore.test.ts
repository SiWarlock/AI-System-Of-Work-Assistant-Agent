// Task 11.1 (B1) — createParityReportStoreAdapter: the @sow/db ParityReportRepository →
// serve-time ParityReportStore read-port bridge at the composition root (§12/§16).
//
// Proves the port MAPPING + the FAIL-CLOSED contract with an injectable fake repo (the durability
// of the substrate itself is proven by the @sow/db durability + contract suites; this isolates the
// bridge logic). The load-bearing fail-closed direction: a real store fault on the coverage LOOKUP
// must REJECT — never resolve `undefined`, which the coverage reader would read as "never reconciled
// ⇒ degrade" (the wrong reason) OR, worse if a future caller inverts the sense, as "clean/absent".
// A GENUINE absence is `ok(undefined)` and passes through as `undefined` (a true no-report).
import { describe, it, expect } from "vitest";
import { ok, err, validParityReport, type ParityReport, type Result } from "@sow/contracts";
import type { DbError, DbResult, ParityReportRepository } from "@sow/db";
import {
  createParityReportStoreAdapter,
  type ParityReportStore,
} from "../../src/composition/parityReportStore";

const REPORT = validParityReport;

/**
 * A fake repo whose `getLatestForRevision` returns a caller-supplied `DbResult` — so a test can
 * inject a fault, a true absence (`ok(undefined)`), or a hit, and assert the bridge's behavior.
 * `record` is inert here (the serve-time port does not expose it — it stays on the repo for B3).
 */
function fakeRepo(get: Result<ParityReport | undefined, DbError>): ParityReportRepository {
  return {
    getLatestForRevision: (): DbResult<ParityReport | undefined> => Promise.resolve(get),
    record: (): DbResult<void> => Promise.resolve(ok(undefined)),
  };
}

describe("createParityReportStoreAdapter — port mapping (B1)", () => {
  it("ok(report) → the ParityReport (structurally intact, incl. divergences[])", async () => {
    const store: ParityReportStore = createParityReportStoreAdapter(fakeRepo(ok(REPORT)));
    const got = await store.getLatestForRevision("ws-001", "rev-001");
    expect(got).toEqual(REPORT);
  });

  it("ok(undefined) → undefined (a TRUE absence passes through, never a fault)", async () => {
    const store = createParityReportStoreAdapter(fakeRepo(ok(undefined)));
    await expect(store.getLatestForRevision("ws-none", "rev-none")).resolves.toBeUndefined();
  });
});

describe("createParityReportStoreAdapter — fail-closed contract (§16)", () => {
  // The load-bearing fail-closed direction: a REAL fault must REJECT, not resolve undefined —
  // else the coverage reader treats a store outage as "no report" (a degrade for the wrong reason,
  // and a trust-signal the kill-switch must never silently lose).
  for (const code of ["unavailable", "serialization_failure", "conflict", "unknown"] as const) {
    it(`REJECTS on a real ${code} fault (never a false 'no report present')`, async () => {
      const fault: DbError = { code, message: `boom (${code})` };
      const store = createParityReportStoreAdapter(fakeRepo(err(fault)));
      await expect(store.getLatestForRevision("ws-001", "rev-001")).rejects.toThrow(code);
    });
  }

  it("the rejection keeps the DbError code but NOT the opaque driver cause (safety rule 7)", async () => {
    const fault: DbError = { code: "unknown", message: "surface", cause: { secret: "RAW" } };
    const store = createParityReportStoreAdapter(fakeRepo(err(fault)));
    await expect(store.getLatestForRevision("ws-001", "rev-001")).rejects.toThrow(/unknown/);
    await store.getLatestForRevision("ws-001", "rev-001").catch((e: unknown) => {
      expect(String(e)).not.toContain("RAW");
    });
  });
});
