// Task 8.4 (b) — the ingestion-triage disposition command: re-enter the
// ingestion pipeline reusing the SAME idempotencyKey (replay-safe), resolving the
// ING-4 dead-end (workflow 5).
//
// REPLAY-SAFE, ONE-WRITER. A triage disposition (accept/reject/reroute/…) on an
// item in the ingestion inbox re-enters the ingestion pipeline. It MUST reuse the
// caller-supplied `idempotencyKey` verbatim so the re-entry is deduped by the
// pipeline (a replay / a double-click / a cross-channel double-apply lands the
// SAME key → one effect). The command DISPATCHES ONLY via the injected Temporal
// dispatch port (`TriagePort.reenterIngestion`); it NEVER writes an external
// system or Markdown directly (§7/§8, safety 3).
//
// §16: never throws — every path returns `Result<T, FailureVariant>`. PURE-ish:
// no I/O of its own; the re-entry effect goes through the injected port.
import {
  ok,
  err,
  isErr,
  type Result,
  type FailureVariant,
} from "@sow/contracts";

/**
 * The disposition a human assigns to an ingestion-inbox item during triage.
 * OPEN string set here (the upstream disposition taxonomy is unspecified — an
 * arch_gap on SourceEnvelope.sensitivity/routingHints), NOT a closed enum, so the
 * command layer stays forward-compatible; the pipeline validates the concrete set.
 */
export type TriageDisposition = string;

/**
 * The injected Temporal / Tool-Gateway dispatch port for re-entering ingestion.
 * The command layer's ONLY triage effect. The real binding starts / signals the
 * ingestion workflow through the worker's Temporal client (reusing the
 * idempotency key as the workflow's dedupe id); a fake implements it for tests.
 * NOTE: the command NEVER writes Markdown or an external system directly — the
 * pipeline (KnowledgeWriter / Tool Gateway) is the only writer (§7/§8).
 */
export interface TriagePort {
  /**
   * Re-enter the ingestion pipeline for `sourceId` under `disposition`, REUSING
   * `idempotencyKey` verbatim (replay-safe, ING-4). Returns the reused key so the
   * caller/renderer can correlate; never throws (§16).
   */
  reenterIngestion(input: {
    sourceId: string;
    idempotencyKey: string;
    disposition: TriageDisposition;
  }): Promise<Result<{ idempotencyKey: string }, FailureVariant>>;
}

/** The result surface of a triage-disposition command. */
export interface TriageDispositionResult {
  /** The idempotency key reused for the re-entry (the ING-4 replay-safety proof). */
  readonly idempotencyKey: string;
}

/**
 * Execute an ingestion-triage disposition (ING-4, workflow 5). Re-enters the
 * ingestion pipeline through the injected `TriagePort`, REUSING the caller's
 * `idempotencyKey` verbatim so a replay / double-apply lands the SAME key → one
 * effect. The command performs NO direct write — the pipeline is the only writer.
 */
export async function disposeTriageCommand(
  deps: { triage: TriagePort },
  input: { sourceId: string; idempotencyKey: string; disposition: TriageDisposition },
): Promise<Result<TriageDispositionResult, FailureVariant>> {
  const r = await deps.triage.reenterIngestion({
    sourceId: input.sourceId,
    idempotencyKey: input.idempotencyKey,
    disposition: input.disposition,
  });
  if (isErr(r)) {
    return err(r.error);
  }
  return ok({ idempotencyKey: r.value.idempotencyKey });
}
