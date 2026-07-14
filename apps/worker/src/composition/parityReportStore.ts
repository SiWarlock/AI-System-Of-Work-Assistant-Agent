// @sow/worker — the durable ParityReport store seams: the serve-time READ port + adapter (task 11.1) and
// the reconcile→store WRITE path — recorder port + adapter + the record-only-on-ok gate (task 13.10 B3).
// §6/§12/§16.
//
// Bridges the REAL @sow/db `ParityReportRepository` onto a NARROW serve-time `ParityReportStore`
// read-port. B2 (brief 053) binds this port into `createServingCoverageReader` so the serving-coverage
// PARITY leg reads the LATEST persisted `ParityReport` for a workspace @ its head revision — the reader
// now CONSUMES this port. What remains DORMANT is the PRODUCTION binding: boot leaves the reader's
// optional `store` dep UNBOUND (⇒ `parity: undefined` ⇒ degrade, byte-equivalent) until B4 binds the
// real `createParityReportStoreAdapter(parityRepo)` + adds the GREEN-admission e2e.
//
// Mirror of `knowledgeRevisionStore.ts` (the composition-root store-adapter precedent): @sow/db
// MUST NOT import worker/serving code (the §2.5 import direction is worker → db), so the
// port-shaped adapter lives HERE at the composition root, where both @sow/db and the worker
// serving layer are visible.
//
// FAIL-CLOSED CONTRACT (§16 + the trust-oracle substrate). The port returns a bare Promise (not a
// Result), so a genuine @sow/db `DbError` fault (unavailable / serialization_failure / conflict /
// unknown — incl. a corrupt stored payload that fails `ParityReportSchema.parse`) is surfaced by
// REJECTING the promise — NEVER by returning a plausible-but-wrong answer.
//   • `getLatestForRevision` (read) — the repo already returns `ok(undefined)` for a TRUE absence (never
//     reconciled), which passes through as `undefined`; EVERY `err` REJECTS. This is the
//     load-bearing direction: a swallowed fault answered `undefined` would read to the coverage
//     reader as "no report ⇒ degrade" for the WRONG reason — and, worse, silently drop a trust
//     signal the coverage kill-switch reads. A store fault must be visible, never masked.
//   • `record` (B3 write) — the recorder adapter REJECTS on every `err`; a write-side fault is visible (the
//     caller degrades + raises health), never a silent ok that would drop a reconciliation result.
//     `recordReconcileOutcome` gates it: it records ONLY a successful `reconcileParity` outcome, VERBATIM
//     (never synthesizing the trust fields), and a reconcile `err` is a typed `skipped_reconcile_error` — a
//     reconcile error is never coerced into a stored clean report.
import { isErr } from "@sow/contracts";
import type { ParityReport, Result } from "@sow/contracts";
import type { DbError, ParityReportRepository } from "@sow/db";
// TYPE-ONLY (no knowledge→db coupling, no knowledge-package edit): the reconciler's output types the B3 gate
// switches on. `reconcileParity` (the FULL task-4.16 producer) is the source — NOT `checkGbrainParity`.
import type { ReconcileError, ReconcilerOutcome } from "@sow/knowledge";

/**
 * The narrow SERVE-TIME read port over the parity-report store — the ONLY surface the next slice's
 * coverage reader consumes. `record` stays on the repo (B3's reconcile→store write path uses it),
 * so this seam is minimal + fakeable.
 */
export interface ParityReportStore {
  /**
   * The latest {@link ParityReport} for `(workspaceId, reconciledAtRevision)`, or `undefined` when
   * none has been reconciled (a TRUE absence). A genuine store fault REJECTS (fail-closed, §16) —
   * never a false `undefined` that would let the coverage reader silently lose a trust signal.
   */
  getLatestForRevision(
    workspaceId: string,
    reconciledAtRevision: string,
  ): Promise<ParityReport | undefined>;
}

/**
 * Surface a genuine @sow/db fault as a rejected promise (the port has no typed error channel).
 * The message keeps the enumerable `DbError.code` so a caller's redacted log line carries the
 * fault class; the opaque driver `cause` is NOT attached (it may carry raw content — safety
 * rule 7). Never called for the `ok(undefined)` absence (which is a value, not a fault).
 */
function faultRejection(op: string, error: DbError): Error {
  return new Error(`operational-store ${op} failed (${error.code}): ${error.message}`);
}

/**
 * Adapt the @sow/db {@link ParityReportRepository} onto the narrow {@link ParityReportStore} port.
 * `getLatestForRevision` passes the repo's `ok` value through (a `ParityReport` or `undefined` — a
 * true absence); any `DbError` REJECTS (fail-closed — see the module header).
 */
export function createParityReportStoreAdapter(repo: ParityReportRepository): ParityReportStore {
  return {
    async getLatestForRevision(
      workspaceId: string,
      reconciledAtRevision: string,
    ): Promise<ParityReport | undefined> {
      const r = await repo.getLatestForRevision(workspaceId, reconciledAtRevision);
      if (isErr(r)) throw faultRejection("parityReport.getLatestForRevision", r.error);
      return r.value;
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// B3 (task 13.10) — the reconcile→store WRITE path: a fail-closed recorder port + the record-only-on-ok gate.
// ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The narrow WRITE port over the parity-report store — persists a reconciliation pass's {@link ParityReport}.
 * Symmetric with {@link ParityReportStore} (the read port). `record` RESOLVES on a durable write (idempotent
 * first-write-wins on `reportId` — a replayed pass is a no-op) and REJECTS on a store `DbError` (fail-closed,
 * §12 — a write fault is visible, never a silent ok). `recordedAt` (store-side "latest" ordering) is supplied
 * by the adapter's injected clock, so this port carries only the report.
 */
export interface ParityReportRecorder {
  record(report: ParityReport): Promise<void>;
}

/**
 * Adapt the @sow/db {@link ParityReportRepository} onto the {@link ParityReportRecorder} write port. Delegates
 * to `repo.record(report, now())` — the injected `now()` stamps the store-side `recordedAt`. Any `DbError`
 * REJECTS via the shared {@link faultRejection} (so the safety-rule-7 no-opaque-cause-leak holds here too).
 */
export function createParityReportRecorderAdapter(
  repo: ParityReportRepository,
  now: () => string,
): ParityReportRecorder {
  return {
    async record(report: ParityReport): Promise<void> {
      const r = await repo.record(report, now());
      if (isErr(r)) throw faultRejection("parityReport.record", r.error);
    },
  };
}

/**
 * The disposition of a {@link recordReconcileOutcome} call — a discriminated union the future reconcile-trigger
 * caller switches on to route health. A `record` store fault is NOT a variant here (it REJECTS the promise), so
 * a genuine store FAULT (degrade + raise health) stays distinguishable from a reconcile ERROR SKIP (§12).
 */
export type ParityRecordDisposition =
  | { readonly kind: "recorded"; readonly report: ParityReport }
  | { readonly kind: "skipped_reconcile_error"; readonly error: ReconcileError };

/**
 * The record-only-on-ok gate over a `reconcileParity` result. On a SUCCESSFUL outcome it records the report
 * VERBATIM (`outcome.value.report` straight through — NEVER synthesizing/defaulting `cleanForServing` or
 * `coverageComplete`, guardrail #2) and returns `{ kind: "recorded" }`; a DIRTY report (`cleanForServing=false`)
 * is recorded too — it is the serve-time degrade signal (operational truth), never dropped. On a reconcile
 * `err` (`workspace_mismatch` / `report_invalid`) it records NOTHING and returns a typed
 * `skipped_reconcile_error` (guardrail #1 — a reconcile error is never coerced into a stored clean report; the
 * caller routes it to health/degrade). A `record` store fault propagates as a REJECTION (fault ≠ skip, §12).
 *
 * DORMANT: no production caller yet — a future Temporal reconcile-trigger slice runs `reconcileParity` and
 * calls this gate, routing `outcome.healthItems` + the skip disposition to health.
 */
export async function recordReconcileOutcome(
  outcome: Result<ReconcilerOutcome, ReconcileError>,
  recorder: ParityReportRecorder,
): Promise<ParityRecordDisposition> {
  if (isErr(outcome)) {
    return { kind: "skipped_reconcile_error", error: outcome.error };
  }
  const { report } = outcome.value;
  await recorder.record(report);
  return { kind: "recorded", report };
}
