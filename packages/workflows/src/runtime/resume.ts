// @sow/workflows — slice 7.3: in-flight workflow RESUME decision (LIFE-3, §6, §9).
//
// `planResume` is a PURE, deterministic decision over a re-entered run's durable
// step-ledger. It imports NEITHER @temporalio NOR node:crypto and calls NO
// Date.now()/Math.random() — the ONLY time source is the injected Clock (used to
// stamp a System-Health item on an unrecoverable resume). This keeps it (a)
// Vitest-unit-testable with no Temporal server and (b) safe to import into
// deterministic workflow code later.
//
// The decision, per step:
//   • SKIP — the ledger records the step as committed WITH a receipt. Committed
//     work is NEVER re-run (LIFE-3).
//   • RE-DRIVE — the step is not committed (absent from the ledger). It is
//     re-driven on resume through its activity (external writes reuse the same
//     envelope — see activities/envelopeReuse.ts).
//
// §6 ORDERING: among the RE-DRIVE steps, pending KnowledgeWriter writes are
// applied BEFORE queued GBrain index jobs — an index job re-derives from the
// current Markdown by revisionId and must never precede (and thus never roll back)
// a KW commit. A committed step keeps its ledger position but is SKIPPED (a
// committed GBrain index job is never rolled back).
//
// UNRECOVERABLE state: a ledger entry marked committed but WITHOUT a receipt (a
// torn commit — a KW step whose write-through cannot be safely re-derived) is not
// silently dropped. `planResume` returns a typed `unrecoverable` outcome carrying
// an OPEN `write_through_failed` System-Health item (the 7.5 OBS-1 seam) so the
// run surfaces on the dashboard instead of disappearing.
//
// §16 error convention: no throw across the boundary — the outcome is a closed,
// enumerable discriminated union.
import type { HealthItem } from "@sow/contracts";
import { auditId } from "@sow/contracts";
import type { Clock } from "../ports/operational";

/** The kind of a durable resume step — drives the §6 re-drive ordering. */
export type ResumeStepKind = "knowledge_write" | "gbrain_index" | "external_write";

/**
 * One step of a run's durable plan. `stepId` is the ledger-join key.
 * `revisionId` pins the Markdown revision a KW write / GBrain index job derives
 * from (absent for a pure external write). `idempotencyKey` is the dedup key a
 * re-driven MUTATING step (knowledge_write / external_write) MUST carry so the
 * downstream dedup layers (KnowledgeWriter replay guard, Tool Gateway receipt)
 * recognise the re-drive and refuse to re-commit — re-driving a mutating step
 * WITHOUT its dedup key defeats those guards and re-commits the side effect, so
 * such a step is UNRECOVERABLE. A `gbrain_index` step is re-derived by
 * `revisionId` and needs no idempotencyKey. Pure data — no behavior.
 */
export interface ResumeStep {
  readonly stepId: string;
  readonly kind: ResumeStepKind;
  readonly revisionId?: string;
  readonly idempotencyKey?: string;
}

/**
 * The durable receipt state recorded for a ledger entry. `committed` carries the
 * opaque receipt ref proving the step's side effect landed; `missing` marks a
 * torn commit (recorded as committed but with no receipt) — an unrecoverable
 * signal.
 */
export type ResumeReceipt =
  | { readonly kind: "committed"; readonly ref: string }
  | { readonly kind: "missing" };

/** One durable step-ledger entry: the committed/torn state of a step by id. */
export interface ResumeLedgerEntry {
  readonly stepId: string;
  readonly receipt: ResumeReceipt;
}

/** The input to {@link planResume}: the run's ordered steps + its durable ledger. */
export interface ResumeInput {
  readonly steps: readonly ResumeStep[];
  readonly ledger: readonly ResumeLedgerEntry[];
}

/** The disposition of a single step on resume. */
export type ResumeDisposition = "skip" | "redrive";

/** One planned step: the step + whether to skip (committed) or re-drive it. */
export interface PlannedResumeStep {
  readonly step: ResumeStep;
  readonly disposition: ResumeDisposition;
}

/**
 * The outcome of {@link planResume} — a closed, enumerable set (§16).
 *   • `resume` — a safe resume plan: SKIP the committed steps, RE-DRIVE the rest
 *     in §6 order (committed steps keep their input position; the re-drive set is
 *     ordered KW-before-GBrain-before-external).
 *   • `unrecoverable` — a torn commit was found; carries the OPEN System-Health
 *     item to surface (never a silent drop).
 */
export type ResumeOutcome =
  | { readonly kind: "resume"; readonly plan: readonly PlannedResumeStep[] }
  | { readonly kind: "unrecoverable"; readonly health: HealthItem; readonly tornStepId: string };

// §6 re-drive priority — LOWER sorts first. KnowledgeWriter writes are applied
// before queued GBrain index jobs; external writes drain LAST (they reuse the
// same envelope on resume, so their relative position is not load-bearing, but a
// stable, deterministic order is). This ordering governs the ENTIRE plan (skips
// AND redrives together — see planResume), so a gbrain_index never precedes a
// knowledge_write regardless of disposition.
const REDRIVE_PRIORITY: Record<ResumeStepKind, number> = {
  knowledge_write: 0,
  gbrain_index: 1,
  external_write: 2,
};

/**
 * Plan a resume from a durable step-ledger. Pure + deterministic; the injected
 * clock is used ONLY to stamp the unrecoverable health item. Never throws.
 */
export function planResume(input: ResumeInput, clock: Clock): ResumeOutcome {
  const ledgerByStep = new Map<string, ResumeReceipt>(
    input.ledger.map((e) => [e.stepId, e.receipt] as const),
  );

  // Detect a torn commit FIRST — a ledger entry recorded but WITHOUT a receipt is
  // unrecoverable and must surface a System-Health item rather than resume.
  // Scope this to THIS run's own steps only: a `missing` ledger row for a step
  // NOT in input.steps belongs to a different run and must NOT abort this resume
  // (finding 3 — scanning the whole ledger caused a false-abort).
  for (const step of input.steps) {
    const receipt = ledgerByStep.get(step.stepId);
    if (receipt !== undefined && receipt.kind === "missing") {
      return unrecoverable(
        step.stepId,
        `resume aborted: step ${step.stepId} recorded as committed but its write receipt is missing (torn commit)`,
        clock,
      );
    }
  }

  // A REDRIVABLE mutating step (knowledge_write / external_write) with NO
  // idempotencyKey cannot be safely re-driven — the downstream dedup guards
  // (KnowledgeWriter replay guard, Tool Gateway receipt) key on that dedup key,
  // so re-driving without it re-commits the side effect. Treat as unrecoverable
  // (finding 1). gbrain_index is re-derivable by revisionId and needs no key.
  for (const step of input.steps) {
    const receipt = ledgerByStep.get(step.stepId);
    const committedStep = receipt !== undefined && receipt.kind === "committed";
    if (committedStep) continue; // committed → skipped, never re-driven.
    if (
      (step.kind === "knowledge_write" || step.kind === "external_write") &&
      step.idempotencyKey === undefined
    ) {
      return unrecoverable(
        step.stepId,
        `resume aborted: ${step.kind} step ${step.stepId} must be re-driven but carries no idempotencyKey — re-driving without its dedup key would re-commit the side effect`,
        clock,
      );
    }
  }

  // Classify every step (skip vs redrive), then order the ENTIRE plan (skips AND
  // redrives together) by (§6 REDRIVE_PRIORITY, then input index) — so a
  // gbrain_index NEVER precedes a knowledge_write regardless of disposition
  // (finding 2). Skips remain no-ops but their plan position respects §6.
  const planned: { step: ResumeStep; disposition: ResumeDisposition; index: number }[] =
    input.steps.map((step, index) => {
      const receipt = ledgerByStep.get(step.stepId);
      const disposition: ResumeDisposition =
        receipt !== undefined && receipt.kind === "committed" ? "skip" : "redrive";
      return { step, disposition, index };
    });

  const plan: PlannedResumeStep[] = planned
    .sort((a, b) => {
      const pa = REDRIVE_PRIORITY[a.step.kind];
      const pb = REDRIVE_PRIORITY[b.step.kind];
      return pa !== pb ? pa - pb : a.index - b.index;
    })
    .map(({ step, disposition }) => ({ step, disposition }));

  return { kind: "resume", plan };
}

/** Build the closed `unrecoverable` outcome carrying an OPEN health item. */
function unrecoverable(stepId: string, message: string, clock: Clock): ResumeOutcome {
  return {
    kind: "unrecoverable",
    tornStepId: stepId,
    health: {
      id: `health:resume:${stepId}`,
      failureClass: "write_through_failed",
      severity: "error",
      message,
      auditRef: auditId(`audit:resume:${stepId}`),
      openedAt: clock.now(),
      state: "open",
    },
  };
}
