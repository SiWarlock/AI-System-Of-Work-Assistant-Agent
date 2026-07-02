// @sow/workflows — task 7.8: INGESTION-INBOX TRIAGE — the PURE orchestration DRIVER.
//
// Sibling of the 7.6 meeting-closeout + 7.7 source-ingestion drivers: same
// two-layer structure (pure driver + injected activity ports), same foundation
// ports (Clock, the WorkflowRun repo, the 7.5 health sink), same idempotency seam
// (resolveRun). This driver progresses an OWNER TRIAGE of a parked SourceEnvelope
// and RE-ENTERS the 7.7 ingestion pipeline — resolving the ING-4 dead-end
// (ARCHITECTURE.md §9 workflow 5 / REQ-F-010).
//
// ★ TWO-LAYER + SANDBOX (root CLAUDE.md): this driver imports NEITHER @temporalio
// NOR node:crypto and calls NO Date.now()/Math.random(). All time + I/O arrive
// through the injected ports + Clock, so it is Vitest-unit-testable with no Temporal
// server and safe to wrap in a thin @temporalio workflow later. The stable
// disposition key that drives exactly-once recording is computed in the ACTIVITY
// (src/activities/disposition.ts — node:crypto lives there); the driver only
// RECEIVES the recorded/no-op outcome and threads it downstream. Likewise the 7.7
// re-entry (with its resolveRun + KnowledgeWriter + Tool Gateway) lives behind the
// injected {@link ReenterIngestionPort} — the triage driver never re-implements it.
//
// §16 error convention: the driver NEVER throws across a boundary. It folds every
// typed port rejection through the health sink (inv-5: nothing fails silently) and
// returns a discriminated-union-friendly outcome whose `resolved` flag says whether
// the parked source escaped the inbox and re-entered the pipeline.
//
// 7.8 safety invariants this driver makes true:
//   inv-A  the owner disposition is RECORDED EXACTLY ONCE with an audit ref; a
//          re-submitted IDENTICAL disposition is a NO-OP (idempotent) — the record
//          port keys on a stable (source + routing) key, so a re-submit reuses the
//          prior auditRef and drives NO second transition.
//   inv-B  Mac + Telegram dispositions CONVERGE on a SINGLE transition — the record
//          key is CHANNEL-FREE, so the converging second channel is a no-op; there
//          is NO divergent inbox state across channels.
//   inv-C  the routing override RE-SCOPES the source (workspace/project/sensitivity)
//          BEFORE re-processing — the pipeline re-enters on the OVERRIDDEN source.
//   inv-D  re-entry REUSES the SAME idempotencyKey the parked source was first
//          submitted under, so 7.7's resolveRun reuses the run and the downstream
//          KnowledgeWriter commit / Tool Gateway external write are idempotent —
//          ZERO duplicate downstream writes.
//   inv-5  every failure/park class routes through the 7.5 health sink.
import { isOk } from "@sow/contracts";
import type {
  Result,
  WorkflowRunRef,
  FailureClass,
  AuditId,
} from "@sow/contracts";
import type { Clock, WorkflowRunRefRepository } from "../ports/operational";
import { resolveRun } from "../runtime/idempotency";
import type { ResolveRunInput } from "../runtime/idempotency";
import type { WorkflowRunError } from "../runtime/workflowRun";
import type {
  TriageDisposition,
  RecordDispositionPort,
  RescopeSourcePort,
  ReenterIngestionPort,
  TriageHealthSink,
  TriageWorkflowFailure,
  IngestionTriageContext,
} from "../ports/ingestionTriage";

// --- driver input ----------------------------------------------------------

/**
 * The complete input to {@link runIngestionTriage}. `run` is the trigger submission
 * resolved idempotently through the 7.4 seam (resolveRun) — its `idempotencyKey` is
 * THE SAME key the parked source was first submitted under (7.7), which is what
 * makes the re-entry replay-safe (inv-D). `disposition` is the owner decision (the
 * routing override + optional project/sensitivity + the arriving channel).
 *
 * The re-scoped source is NOT caller-supplied: it is DERIVED inside the pipeline by
 * the {@link RescopeSourcePort} from the disposition + the parked source, so the
 * override is applied through the governed seam (inv-C).
 */
export interface IngestionTriageInput {
  readonly run: ResolveRunInput;
  readonly disposition: TriageDisposition;
}

// --- injected dependencies -------------------------------------------------

/**
 * The injected dependency set: the three triage activity ports, the 7.5 health
 * sink, the 7.4 WorkflowRun repository (for resolveRun's idempotency seam), and the
 * injected Clock. Every dependency is a narrow port so the driver stays pure and
 * fully injected-testable (no operational store / 7.7 re-entry adapter / Temporal).
 */
export interface IngestionTriageDeps {
  readonly record: RecordDispositionPort;
  readonly rescope: RescopeSourcePort;
  readonly reenter: ReenterIngestionPort;
  readonly health: TriageHealthSink;
  readonly runs: WorkflowRunRefRepository;
  readonly clock: Clock;
}

// --- driver outcome --------------------------------------------------------

/**
 * The result of a triage drive. `resolved` is true when the parked source was
 * dispositioned AND re-entered the pipeline (escaped the ING-4 dead-end); false on
 * any failure branch (a health item is always surfaced). `context` is the final
 * threaded context (auditRef, no-op flag, re-scoped source, re-entry outcome).
 * `run` is the resolveRun result; `runReused` mirrors resolveRun's `reused` flag.
 * `surfaced` names the health failure routed on a failure branch. Never throws.
 */
export interface IngestionTriageOutcome {
  readonly resolved: boolean;
  readonly context: IngestionTriageContext;
  readonly run: Result<WorkflowRunRef, WorkflowRunError>;
  readonly runReused: boolean;
  readonly surfaced?: TriageWorkflowFailure;
}

// --- failure-class mapping (inv-5: distinct health item per failure class) -

/** Map a triage failure phase to a §16 FailureClass for the health sink. */
function failureClassFor(
  phase: "record" | "rescope" | "reenter",
): FailureClass {
  switch (phase) {
    case "record":
      // A disposition that can't be recorded is a review-inbox conflict.
      return "conflict_review";
    case "rescope":
      return "conflict_review";
    case "reenter":
      // Re-entry drives durable writes; a re-entry failure is a write-through class.
      return "write_through_failed";
    default:
      return "write_through_failed";
  }
}

// --- driver ----------------------------------------------------------------

/**
 * Run the ingestion-inbox triage as a pure, replay-safe driver.
 *
 * Order:
 *   1. resolveRun (7.4 seam) — the SAME idempotencyKey the parked source used is
 *      reused, so no duplicate run is started (inv-D).
 *   2. RECORD the disposition EXACTLY ONCE (inv-A/inv-B) — the record port keys on a
 *      stable (source + routing) key; a re-submit OR the converging second channel is
 *      a `noop` reusing the prior auditRef; a genuine record failure fails closed with
 *      a health item and NO downstream effect (no re-scope, no re-entry).
 *   3. RE-SCOPE the source (inv-C) — apply the owner's workspace/project/sensitivity
 *      override, preserving contentHash; a re-scope failure fails closed (no re-entry).
 *   4. RE-ENTER the 7.7 pipeline (inv-C/inv-D) — on the RE-SCOPED source, REUSING the
 *      SAME idempotencyKey, so the downstream commit/external write are
 *      idempotent-replayed (zero duplicate downstream write). A re-entry failure
 *      surfaces a health item (the disposition is already durably recorded).
 *
 * Every failure branch routes through the health sink (inv-5). Never throws.
 */
export async function runIngestionTriage(
  input: IngestionTriageInput,
  deps: IngestionTriageDeps,
): Promise<IngestionTriageOutcome> {
  // 1. Resolve the run idempotently (7.4). Re-entry reuses the parked source's
  //    idempotencyKey, so a re-submit reuses the existing run (inv-D / LIFE-3).
  const resolved = await resolveRun(input.run, deps.runs, deps.clock);
  const runResult: Result<WorkflowRunRef, WorkflowRunError> = isOk(resolved)
    ? { ok: true, value: resolved.value.run }
    : resolved;
  const runReused = isOk(resolved) ? resolved.value.reused : false;

  let context: IngestionTriageContext = { disposition: input.disposition };

  const surface = async (
    phase: "record" | "rescope" | "reenter",
    message: string,
    auditRef: AuditId,
  ): Promise<IngestionTriageOutcome> => {
    const failure: TriageWorkflowFailure = {
      failureClass: failureClassFor(phase),
      subjectRef: input.disposition.sourceId,
      message,
      auditRef,
    };
    // Route through the health sink — nothing fails silently (inv-5). Even if the
    // sink itself errors we still return unresolved (fail-closed); the sink's own
    // error is the 7.5 seam's concern, not a reason to lose the outcome.
    await deps.health.surface(failure);
    return { resolved: false, context, run: runResult, runReused, surfaced: failure };
  };

  // 2. RECORD the disposition EXACTLY ONCE (inv-A/inv-B). The record port keys on a
  //    stable, CHANNEL-FREE (source + routing) key: the FIRST record moves the inbox
  //    row through its single transition; a re-submit OR the converging second
  //    channel is a `noop` reusing the prior auditRef (no divergent inbox state).
  const recorded = await deps.record.record(input.disposition);
  if (!isOk(recorded)) {
    // The audit ref is unavailable on a record failure; cite the subject id so the
    // health item still carries a stable reference (fail-closed).
    return surface(
      "record",
      `disposition record failed: ${recorded.error.code}`,
      input.disposition.sourceId as unknown as AuditId,
    );
  }
  const auditRef = recorded.value.auditRef;
  const dispositionNoop = recorded.value.outcome === "noop";
  context = { ...context, auditRef, dispositionNoop };

  // 3. RE-SCOPE the source (inv-C). Apply the owner override BEFORE re-processing —
  //    the pipeline must re-enter on the RE-CLASSIFIED source, never the parked one.
  const reScoped = await deps.rescope.rescope(input.disposition);
  if (!isOk(reScoped)) {
    return surface("rescope", `source re-scope failed: ${reScoped.error.code}`, auditRef);
  }
  context = { ...context, reScopedSource: reScoped.value };

  // 4. RE-ENTER the 7.7 pipeline (inv-C/inv-D) on the RE-SCOPED source, REUSING the
  //    SAME idempotencyKey. 7.7's resolveRun reuses the existing run and its
  //    KnowledgeWriter commit + Tool Gateway external write are idempotent — so a
  //    re-entry (or a re-submitted disposition) produces ZERO duplicate downstream
  //    writes.
  const reentered = await deps.reenter.reenter(
    reScoped.value,
    input.run.idempotencyKey,
  );
  if (!isOk(reentered)) {
    return surface("reenter", `pipeline re-entry failed: ${reentered.error.code}`, auditRef);
  }
  context = { ...context, reenter: reentered.value };

  return { resolved: true, context, run: runResult, runReused };
}
