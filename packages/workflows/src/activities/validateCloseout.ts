// @sow/workflows — slice 7.6 ACTIVITY: validate the meeting.close extraction
// (inv-3 — the no-inference rule + the schema gate; a HARD reject, no partial).
//
// This is an ACTIVITY, but a PURE/synchronous one: it composes the @sow/domain
// `validateNoInference` (REQ-F-017) with an INJECTED schema-gate predicate so it is
// unit-testable without a live ajv registry. It implements {@link ValidateExtractionPort}.
//
// SAFETY (inv-3): the gate is a COMPOSITION (discharges LESSONS.md §3 — a single
// gate is never the whole story). It runs in ORDER and SHORT-CIRCUITS:
//   (1) validateNoInference over the extraction's fields — an INFERRED owner/date
//       (a concrete value with no evidenceRef) or missing evidence is a HARD reject
//       (`no_inference_violation`, carrying the per-field REQ-F-017 rejection list).
//   (2) the injected schema gate — a structural/schema failure is `schema_rejected`.
// A rejection at EITHER step returns a typed {@link ValidationRejection} and NO
// ValidatedExtraction is produced — there is no partial result. Only a full pass
// yields the branded `validated:true` extraction (so the driver cannot commit an
// un-validated candidate). Never throws (§16).
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { validateNoInference } from "@sow/domain";
import type {
  ValidateExtractionPort,
  ValidationRejection,
  ValidatedExtraction,
  AgentExtraction,
} from "../ports/meetingCloseout";

/**
 * The injected schema-gate predicate: the candidate-data JSON-Schema gate (ajv + the
 * Zod refine layer) over the extraction's declared output schema. Returns `ok` on a
 * pass, or an err naming the rejection message; the activity folds that onto
 * `schema_rejected`. Synchronous + pure (no ajv registry wiring in this module).
 */
export type MeetingSchemaGate = (
  extraction: AgentExtraction,
) => Result<void, { readonly code: "schema_rejected"; readonly message: string }>;

/** Injected deps for the validate activity: the schema gate. */
export interface ValidateActivityDeps {
  readonly schemaGate: MeetingSchemaGate;
}

/**
 * Build a {@link ValidateExtractionPort} composing the no-inference rule with the
 * injected schema gate (inv-3). No-inference runs FIRST and short-circuits — an
 * inferred field rejects before the schema gate is ever consulted (no partial
 * validation). Never throws.
 */
export function createValidateActivity(
  deps: ValidateActivityDeps,
): ValidateExtractionPort {
  return {
    validate(
      extraction: AgentExtraction,
    ): Result<ValidatedExtraction, ValidationRejection> {
      // (1) no-inference (REQ-F-017) — HARD reject, short-circuit (no partial).
      const noInference = validateNoInference(extraction.fields);
      if (!noInference.ok) {
        return err({
          code: "no_inference_violation",
          message: "REQ-F-017: extraction carries inferred or unsupported field(s)",
          rejections: noInference.error,
        });
      }
      // (2) schema gate — the composed candidate-data gate's structural half.
      const gated = deps.schemaGate(extraction);
      if (!gated.ok) {
        return err({
          code: "schema_rejected",
          message: gated.error.message,
          rejections: [],
        });
      }
      // Full pass → the branded validated extraction.
      const validated: ValidatedExtraction = {
        validated: true,
        fields: extraction.fields,
        ...(extraction.schemaId !== undefined ? { schemaId: extraction.schemaId } : {}),
      };
      return ok(validated);
    },
  };
}
