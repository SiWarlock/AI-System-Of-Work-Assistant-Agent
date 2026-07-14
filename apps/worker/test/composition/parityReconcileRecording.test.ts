// Task 13.10 (B3) — the worker-side parity reconcile→store WRITE path. spec(§6) spec(§12)
//
// Two seams, both fail-closed, feeding the serve-time trust-gate coverage source (B1/B2):
//   • createParityReportRecorderAdapter(repo, now) — a narrow ParityReportRecorder write-port over the
//     @sow/db ParityReportRepository.record; supplies recordedAt from the injected clock and REJECTS on a
//     DbError (a store fault is VISIBLE, never a silent ok — mirrors the B1 read adapter).
//   • recordReconcileOutcome(outcome, recorder) — the record-only-on-ok gate: on a successful reconcileParity
//     outcome it records the report VERBATIM (guardrail #2 — never synthesizing cleanForServing/coverageComplete);
//     a reconcile err is NEVER coerced into a stored clean report (guardrail #1 — a typed skipped_reconcile_error
//     disposition the future caller routes to health/degrade). A record DbError REJECTS (fault ≠ skip, §12).
//
// The reconciler's OUTPUT TYPES (ReconcilerOutcome/ReconcileError) are imported type-only from @sow/knowledge —
// no knowledge-package edit, no knowledge→db coupling (the gate lives worker-side at the composition root).
import { describe, it, expect } from "vitest";
import { ok, err, validParityReport, type ParityReport, type Result } from "@sow/contracts";
import type { DbError, DbResult, ParityReportRepository } from "@sow/db";
import type { ReconcilerOutcome, ReconcileError } from "@sow/knowledge";
import {
  createParityReportRecorderAdapter,
  recordReconcileOutcome,
  type ParityReportRecorder,
} from "../../src/composition/parityReportStore";

const REPORT = validParityReport;
const CLOCK = "2026-07-13T00:00:00.000Z";

/** A successful reconcile outcome wrapping REPORT (the gate reads only `outcome.value.report`). */
const OUTCOME: ReconcilerOutcome = {
  report: REPORT,
  divergences: REPORT.divergences,
  healthItems: [],
  coverageComplete: REPORT.coverageComplete,
};

/**
 * A fake @sow/db ParityReportRepository: `record` resolves the caller-supplied `DbResult` (an ok or a fault) and
 * optionally spies its `(report, recordedAt)`; `getLatestForRevision` is inert (the write path never calls it).
 */
function fakeRepo(
  recordResult: Result<void, DbError>,
  spy?: (report: ParityReport, recordedAt: string) => void,
): ParityReportRepository {
  return {
    record: (report, recordedAt): DbResult<void> => {
      spy?.(report, recordedAt);
      return Promise.resolve(recordResult);
    },
    getLatestForRevision: (): DbResult<ParityReport | undefined> => Promise.resolve(ok(undefined)),
  };
}

/** A fake ParityReportRecorder: records the report it was handed, or REJECTS (a store fault). */
function fakeRecorder(
  behavior: { reject?: boolean } = {},
  spy?: (report: ParityReport) => void,
): ParityReportRecorder {
  return {
    record: (report): Promise<void> => {
      spy?.(report);
      return behavior.reject
        ? Promise.reject(new Error("operational-store parityReport.record failed (unavailable): boom"))
        : Promise.resolve();
    },
  };
}

describe("createParityReportRecorderAdapter — the fail-closed write port (B3)", () => {
  it("recorder_adapter_records_via_repo", async () => {
    // delegates to repo.record with the report + the injected clock's recordedAt, and resolves
    const calls: Array<[ParityReport, string]> = [];
    const adapter = createParityReportRecorderAdapter(
      fakeRepo(ok(undefined), (report, recordedAt) => calls.push([report, recordedAt])),
      () => CLOCK,
    );
    await expect(adapter.record(REPORT)).resolves.toBeUndefined();
    expect(calls).toEqual([[REPORT, CLOCK]]);
  });

  it("recorder_adapter_rejects_on_db_fault", async () => {
    // a repo DbError ⇒ the adapter REJECTS (a store fault is visible, never a silent ok — §12 fail-closed)
    const fault: DbError = { code: "unavailable", message: "store down" };
    const adapter = createParityReportRecorderAdapter(fakeRepo(err(fault)), () => CLOCK);
    await expect(adapter.record(REPORT)).rejects.toThrow(/unavailable/);
  });

  it("recorder_adapter_rejection_keeps_code_not_opaque_cause (rule 7)", async () => {
    const fault: DbError = { code: "unknown", message: "surface", cause: { secret: "RAW" } };
    const adapter = createParityReportRecorderAdapter(fakeRepo(err(fault)), () => CLOCK);
    // CAPTURE the rejection reason and assert UNCONDITIONALLY — a `.catch(cb)` callback silently no-ops if
    // the adapter ever RESOLVED, a vacuous green on the exact safety-rule-7 property this test pins.
    const thrown = await adapter.record(REPORT).then(
      () => {
        throw new Error("expected the recorder adapter to REJECT on a DbError, but it resolved");
      },
      (e: unknown) => e,
    );
    expect(String(thrown)).toContain("unknown"); // the enumerable DbError.code crosses
    expect(String(thrown)).not.toContain("RAW"); // the opaque driver `cause` does NOT
  });
});

describe("recordReconcileOutcome — the record-only-on-ok gate (B3)", () => {
  it("record_reconcile_outcome_ok_records_verbatim", async () => {
    // guardrail #2: the reconciler's report is recorded BYTE-EQUAL (same reference — no field synthesis)
    const recorded: ParityReport[] = [];
    const disposition = await recordReconcileOutcome(ok(OUTCOME), fakeRecorder({}, (r) => recorded.push(r)));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toBe(OUTCOME.report); // verbatim pass-through, cleanForServing/coverageComplete untouched
    expect(disposition).toEqual({ kind: "recorded", report: OUTCOME.report });
  });

  it("record_reconcile_outcome_workspace_mismatch_never_records", async () => {
    // guardrail #1: a reconcile err is NEVER coerced into a stored clean report — record nothing, typed skip
    const error: ReconcileError = { code: "workspace_mismatch", canonical: "ws-a", db: "ws-b" };
    const recorded: ParityReport[] = [];
    const disposition = await recordReconcileOutcome(err(error), fakeRecorder({}, (r) => recorded.push(r)));
    expect(recorded).toHaveLength(0);
    expect(disposition).toEqual({ kind: "skipped_reconcile_error", error });
  });

  it("record_reconcile_outcome_report_invalid_never_records", async () => {
    const error: ReconcileError = { code: "report_invalid", detail: "schema gate rejected" };
    const recorded: ParityReport[] = [];
    const disposition = await recordReconcileOutcome(err(error), fakeRecorder({}, (r) => recorded.push(r)));
    expect(recorded).toHaveLength(0);
    expect(disposition).toEqual({ kind: "skipped_reconcile_error", error });
  });

  it("record_reconcile_outcome_propagates_record_fault", async () => {
    // a record DbError REJECTS through the gate (fault ≠ skip) — the caller degrades on the fault, NOT a
    // silent "skipped" disposition (§12 fail-closed both directions: fault and skip stay distinguishable)
    await expect(recordReconcileOutcome(ok(OUTCOME), fakeRecorder({ reject: true }))).rejects.toThrow(/unavailable/);
  });

  it("record_reconcile_outcome_dirty_report_still_recorded", async () => {
    // a DIRTY report (cleanForServing=false — a HARD divergence found) on a successful reconcile IS recorded
    // verbatim: it is operational truth (the serve-time signal that makes serving DEGRADE), never dropped
    const dirty: ParityReport = { ...REPORT, cleanForServing: false };
    const dirtyOutcome: ReconcilerOutcome = { ...OUTCOME, report: dirty, coverageComplete: false };
    const recorded: ParityReport[] = [];
    const disposition = await recordReconcileOutcome(ok(dirtyOutcome), fakeRecorder({}, (r) => recorded.push(r)));
    expect(recorded[0]).toBe(dirty);
    expect(disposition).toEqual({ kind: "recorded", report: dirty });
  });
});
