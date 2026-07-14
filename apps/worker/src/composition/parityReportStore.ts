// @sow/worker — the durable ParityReportStore adapter (task 11.1, §6/§12/§16).
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
//   • `getLatestForRevision` — the repo already returns `ok(undefined)` for a TRUE absence (never
//     reconciled), which passes through as `undefined`; EVERY `err` REJECTS. This is the
//     load-bearing direction: a swallowed fault answered `undefined` would read to the coverage
//     reader as "no report ⇒ degrade" for the WRONG reason — and, worse, silently drop a trust
//     signal the coverage kill-switch reads. A store fault must be visible, never masked.
import { isErr } from "@sow/contracts";
import type { ParityReport } from "@sow/contracts";
import type { DbError, ParityReportRepository } from "@sow/db";

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
