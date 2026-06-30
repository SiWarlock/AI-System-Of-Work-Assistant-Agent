// 1.11 — no-inference rule (REQ-F-017 / MTG-4). Extraction NEVER invents task
// owners or due dates: an unstated value is emitted as the 'TBD' sentinel (or
// routed to clarification), and any concrete claim MUST cite evidence. This is a
// validator hard-reject, not a model preference. PURE + deterministic — no
// clock/network/random; identical input ⇒ identical rejection set (replay-safe).
//
// arch_gap: the concrete meeting.close output schema (which fields exist, which
// are owner/date) is §9 / Phase-7 work — this operates on the ABSTRACT
// evidence-backed extraction-field shape the spec implies, keyed by an opaque
// field name. The two REQ-F-017 codes are split structurally (see below) so both
// stay reachable from the abstract shape:
//   - a concrete value with NO evidence slot at all (`evidenceRef` undefined) is a
//     value presented as fact with no backing whatsoever → `inferred_owner_or_date`
//     (the invented owner/date REQ-F-017 names);
//   - a concrete value WITH an evidence slot that is empty/whitespace (a claim that
//     gestures at backing but supplies none) → `missing_evidence`.
// A 'TBD' value is always allowed regardless of evidenceRef.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";

/** The unstated-value sentinel; emitting it is always allowed (REQ-F-017). */
export const TBD = "TBD" as const;

/**
 * The abstract evidence-backed extraction-field shape. `value` is either a
 * concrete `T` claim or the `'TBD'` sentinel; a concrete claim must carry a
 * non-empty `evidenceRef` pointing at its backing (canonical Markdown / a
 * `SourceEnvelope` span).
 */
export interface ExtractionField<T> {
  readonly value: T | typeof TBD;
  readonly evidenceRef?: string;
}

/** Enumerable no-inference rejection codes (REQ-F-017). */
export type NoInferenceRejectionCode = "missing_evidence" | "inferred_owner_or_date";

export interface NoInferenceRejection {
  readonly code: NoInferenceRejectionCode;
  /** The offending field name. */
  readonly field: string;
}

const hasBacking = (ref: string | undefined): ref is string =>
  typeof ref === "string" && ref.trim().length > 0;

/**
 * Per-field no-inference check (REQ-F-017). Pure + total.
 * - `value === 'TBD'`            → ok (unstated → TBD or clarify), any evidenceRef.
 * - concrete value, no evidence slot (`evidenceRef === undefined`) → inferred_owner_or_date.
 * - concrete value, empty/whitespace evidence slot                 → missing_evidence.
 * - concrete value, non-empty evidenceRef                          → ok.
 */
export function checkExtractionField(
  field: string,
  candidate: ExtractionField<unknown>,
): Result<ExtractionField<unknown>, NoInferenceRejection> {
  if (candidate.value === TBD) {
    return ok(candidate);
  }
  if (candidate.evidenceRef === undefined) {
    return err({ code: "inferred_owner_or_date", field });
  }
  if (!hasBacking(candidate.evidenceRef)) {
    return err({ code: "missing_evidence", field });
  }
  return ok(candidate);
}

/**
 * Aggregate no-inference validator over a field set (REQ-F-017). Returns
 * `ok(fields)` when every field is either 'TBD' or evidence-backed; otherwise
 * `err([...])` with one rejection per offending field, in deterministic
 * insertion order. Pure — no clock/network/random.
 */
export function validateNoInference(
  fields: Record<string, ExtractionField<unknown>>,
): Result<Record<string, ExtractionField<unknown>>, NoInferenceRejection[]> {
  const rejections: NoInferenceRejection[] = [];
  for (const [field, candidate] of Object.entries(fields)) {
    const r = checkExtractionField(field, candidate);
    if (!r.ok) {
      rejections.push(r.error);
    }
  }
  if (rejections.length > 0) {
    return err(rejections);
  }
  return ok(fields);
}
