// @sow/workflows — task 25.2/25.4 (PKG-W3) ACTIVITY: a GENERIC no-inference
// field validator, reused across every family whose "validate" port follows the
// identical shape — draft `{fields, schemaId?}` → validated `{validated:true,
// ...draft}` — ValidateBriefPort (dailyBrief), ValidateReviewPort (periodReview),
// and ValidateProposalPort (crossCalendarScheduling). projectSync's
// ValidateNarrativePort already has its own concrete implementation
// (activities/validateNarrative.ts, pre-existing + tested) and is left
// untouched; this generic core mirrors its exact two-step contract (an OPTIONAL
// injected schema hook, THEN the load-bearing REQ-F-017 no-inference gate) so
// all four families share one behavior even though only three share this file.
//
// PURE + synchronous — no clock/I/O, matches every "validate" port's SYNC
// `Result<...>` (not `Promise<Result<...>>`) signature. NO side effect on a
// rejection (safety rule 2). Never throws.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { validateNoInference } from "@sow/domain";
import type { ExtractionField, NoInferenceRejection } from "@sow/domain";

/** The minimal shape every one of the four "*Draft" candidate types share. */
export interface FieldsDraft {
  readonly fields: Record<string, ExtractionField<unknown>>;
  readonly schemaId?: string;
}

/** The optional injected draft-shape gate (mirrors validateNarrative.ts's hook). */
export type FieldsSchemaCheck<Draft extends FieldsDraft> = (
  draft: Draft,
) => Result<void, { readonly code: "schema_rejected" | "unsupported_claim"; readonly message: string }>;

export interface ValidateFieldsConfig<Draft extends FieldsDraft> {
  readonly schemaCheck?: FieldsSchemaCheck<Draft>;
}

/** The closed, enumerable rejection set every one of the four ports declares. */
export type FieldsRejectionCode = "no_inference_violation" | "schema_rejected" | "unsupported_claim";

export interface FieldsRejection {
  readonly code: FieldsRejectionCode;
  readonly message: string;
  readonly rejections: readonly NoInferenceRejection[];
}

/**
 * Validate a candidate `{fields, schemaId?, ...rest}` draft (no-inference +
 * optional schema hook) — synchronous + pure. On success emits `{validated:true,
 * ...draft}` — preserving EVERY field the draft carried (so a family whose draft
 * has an extra field, like crossCalendarScheduling's `windows`, gets it back on
 * the validated brand unchanged). NO side effect on a rejection. Never throws.
 */
export function validateFieldsNoInference<Draft extends FieldsDraft>(
  draft: Draft,
  config: ValidateFieldsConfig<Draft> = {},
): Result<Draft & { readonly validated: true }, FieldsRejection> {
  if (config.schemaCheck !== undefined) {
    const s = config.schemaCheck(draft);
    if (!s.ok) return err({ code: s.error.code, message: s.error.message, rejections: [] });
  }
  const ni = validateNoInference(draft.fields);
  if (!ni.ok) {
    return err({
      code: "no_inference_violation",
      message: "REQ-F-017: candidate carries an inferred or unbacked field",
      rejections: ni.error,
    });
  }
  return ok({ ...draft, validated: true as const });
}

/**
 * Build a `{validate(draft): Result<...>}` port object over
 * {@link validateFieldsNoInference} — the direct factory shape every port
 * expects (a single-method object, not a bare function).
 */
export function createFieldsValidateActivity<Draft extends FieldsDraft>(
  config: ValidateFieldsConfig<Draft> = {},
): {
  validate(draft: Draft): Result<Draft & { readonly validated: true }, FieldsRejection>;
} {
  return {
    validate(draft: Draft) {
      return validateFieldsNoInference(draft, config);
    },
  };
}
