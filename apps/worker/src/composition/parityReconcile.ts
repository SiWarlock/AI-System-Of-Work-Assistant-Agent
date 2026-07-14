// Task 13.10 (reconcile-TRIGGER arc, piece A) — the pure worker-side reconcile-pass composition. spec(§6) spec(§12)
//
// runReconcilePass is the composition seam every later arc piece wires into: it RUNS one reconciliation pass
// (reconcileParity over the injected request) → persists the outcome through the B3 record-only-on-ok gate
// (recordReconcileOutcome) → routes the reconciler's ready-made HealthItems through an injected sink → returns
// the ParityRecordDisposition. It owns COMPOSITION only: never input construction (a later piece builds `req`
// from a real GbrainReadGrant DB projection + the canonical set) and never trigger scheduling / burst-collapse.
//
// Fail-closed BOTH directions (§12):
//   • a reconcile err (workspace_mismatch / report_invalid) is a typed `skipped_reconcile_error` — records
//     nothing, routes nothing (never coerced into a stored clean pass);
//   • a store `record` fault REJECTS (via recordReconcileOutcome) BEFORE any health routing — the pass did not
//     durably land, so its health items are NOT surfaced (the caller degrades + raises a store-fault item);
//   • a health-sink fault PROPAGATES — a trust-defect signal is never silently dropped.
//
// DORMANT: no production caller yet — the reconcile TRIGGER (a later piece) supplies the request + real bindings.
import { isOk } from "@sow/contracts";
import type { HealthItem } from "@sow/contracts";
import { reconcileParity } from "@sow/knowledge";
import type { ReconcileRequest, ReconcilerDeps } from "@sow/knowledge";
import {
  recordReconcileOutcome,
  type ParityReportRecorder,
  type ParityRecordDisposition,
} from "./parityReportStore";

/**
 * The narrow health sink piece A routes the reconciler's ready-made {@link HealthItem}s through. `record`
 * RESOLVES on a durable surface and REJECTS on a fault (fail-closed — the caller must not silently drop a
 * trust-defect signal). The shape matches exactly what the reconciler produces (a `HealthItem`, no lossy
 * decomposition); the REAL binding — re-project each item through the worker `HealthSurface` for OBS-2 dedupe
 * (so a parity defect recurring every pass bumps ONE item's occurrence count, not a fresh id-keyed row) — is
 * decided + wired at the piece (D/F) where `HealthSurface` is in scope. (Step-2.5 pre-delegated decision #1 = (a).)
 */
export interface ReconcileHealthSink {
  record(item: HealthItem): Promise<void>;
}

/** The injected collaborators for one reconcile pass — all fakeable; the two real bindings stay owner-gated. */
export interface RunReconcilePassDeps {
  /** Deterministic id minters + clock for {@link reconcileParity} (id/clock injection, never wall-clock). */
  readonly reconcilerDeps: ReconcilerDeps;
  /** The fail-closed B3 write port — persists the pass's `ParityReport` (REJECTS on a store fault). */
  readonly recorder: ParityReportRecorder;
  /** The fail-closed sink the reconciler's `HealthItem`s route through, in order. */
  readonly healthSink: ReconcileHealthSink;
}

/**
 * Run one reconciliation pass: reconcile → record (only on ok) → route the ready-made health items in order.
 * Returns the {@link ParityRecordDisposition}; REJECTS on a store `record` fault or a health-sink fault (§12).
 */
export async function runReconcilePass(
  req: ReconcileRequest,
  deps: RunReconcilePassDeps,
): Promise<ParityRecordDisposition> {
  const outcome = reconcileParity(req, deps.reconcilerDeps);
  // recordReconcileOutcome REJECTS on a store fault BEFORE returning, so a "recorded" disposition means the
  // pass durably landed. Route health ONLY then; `isOk` narrows the outcome so we can read its health items
  // (TypeScript can't infer ok-ness from the disposition tag alone).
  const disposition = await recordReconcileOutcome(outcome, deps.recorder);
  if (disposition.kind === "recorded" && isOk(outcome)) {
    for (const item of outcome.value.healthItems) {
      await deps.healthSink.record(item);
    }
  }
  return disposition;
}
