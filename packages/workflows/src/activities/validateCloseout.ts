// @sow/workflows — slice 7.6 ACTIVITY: validate the meeting.close extraction
// (inv-3 — the no-inference rule + the schema gate; a HARD reject, no partial).
//
// This is an ACTIVITY, but a PURE/synchronous one: it composes the @sow/domain
// `validateNoInference` (REQ-F-017) with an INJECTED schema-gate predicate so it is
// unit-testable without a live ajv registry. It implements {@link ValidateExtractionPort}.
//
// SAFETY (inv-3): the gate is a COMPOSITION (discharges LESSONS.md §3 — a single
// gate is never the whole story). It runs in ORDER and SHORT-CIRCUITS:
//   (0) a STRUCTURAL pre-check that `fields` is a map at all — `validateNoInference` iterates it
//       with `Object.entries`, which THROWS on null/undefined, so an unusable map is folded to a
//       typed `schema_rejected` (§16) via the injected gate before step (1) can run.
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

/** The prefix the real wired gate uses for its three field-NAMING rejections: the quoted key that
 *  follows is model-authored (drawn from the untrusted transcript/source). Its presence is the
 *  only signal this module has that a message interpolates foreign text. */
const FIELD_MESSAGE_PREFIX = "field '";

/**
 * The real wired gate's (`createMeetingExtractionSchemaGate`) three field-naming ROLE phrases,
 * verbatim and in full — the fixed, SoW-authored tail of `field '<key>' <role>`. This is a
 * TABLE, not a parse: {@link safeSchemaGateMessage} emits an ENTRY of this table rather than a
 * span cut out of the incoming message, which is what makes a hostile key structurally unable to
 * contribute a byte (see that function's comment). No phrase is a suffix of another, so at most
 * one can match a given message tail.
 */
const FIELD_ROLE_PHRASES = [
  "is not a well-formed ExtractionField",
  "value is not a primitive or TBD",
  "evidenceRef is not a string",
] as const;

/** A `field '<key>' …` message whose role phrase this build does not recognise (a gate change, or
 *  a differently-wired gate). The key still has to be dropped, so the whole message is replaced —
 *  distinctly, so an operator can tell this apart from the known roles. */
const UNRECOGNISED_FIELD_ROLE = "field rejected by the schema gate under an unrecognised role";

/**
 * Fold the injected schema gate's rejection message onto a safe diagnostic (SAFETY RULE 7,
 * incidental text, never the payload). The real wired gate emits FIVE distinct messages; two of
 * them ("meeting extraction has no fields map" / "meeting extraction carries no fields") name no
 * field at all — they mean the model returned NOTHING, a provider/prompt problem an operator
 * needs to see, so they cross UNCHANGED. The other three interpolate the extraction's OWN field
 * NAME, so only the field's ROLE is kept and the key dropped, keeping the diagnostic actionable
 * without carrying foreign text (restored 2026-08-27, reverting an earlier pass that collapsed
 * all five onto one fixed literal — CLAUDE.md "THE BAR IS INVERTED: restore unless removal is
 * clearly justified"). Every driver (meetingCloseout.ts / hermesAutomation.ts /
 * sourceIngestion.ts) still branches on the fixed `.code` alone, never `.message`.
 *
 * WHAT MAKES THE KEY UNABLE TO LEAK, precisely: on the `field '` arm every returned byte comes
 * from a module-local literal — a {@link FIELD_ROLE_PHRASES} entry or
 * {@link UNRECOGNISED_FIELD_ROLE} — and NO span of `message` is ever copied out. The incoming
 * text is only ever TESTED (`startsWith` / `endsWith`), never captured. A hostile key can
 * therefore change WHICH literal is selected but can never add text to the result. This replaces
 * a capture-the-suffix regex whose own comment claimed the opposite: `/^field '.*?' (.+)$/` binds
 * to the FIRST `' `, so a key containing `' ` pushed its own tail into the kept suffix (verified
 * leak — the C3 finding).
 *
 * ⚠ LIMIT — this is NOT a claim that no gate message can carry model text. A message that does
 * not start with `field '` crosses VERBATIM. That is safe for the REAL wired gate specifically,
 * because its other two messages are fixed literals interpolating nothing; it is a property of
 * THAT gate, not of this function. An injected gate that interpolated model text into a message
 * shaped differently would cross it.
 */
function safeSchemaGateMessage(message: string): string {
  if (!message.startsWith(FIELD_MESSAGE_PREFIX)) {
    return message;
  }
  // `endsWith` (not a capture): the gate appends the role AFTER the closing `' `, so the REAL
  // role is always the message's tail even when the key embeds a decoy separator or impersonates
  // another role phrase.
  const role = FIELD_ROLE_PHRASES.find((phrase) => message.endsWith(` ${phrase}`));
  return role !== undefined ? `field ${role}` : UNRECOGNISED_FIELD_ROLE;
}

/**
 * The SoW-authored diagnostic for a `fields` value this activity cannot iterate, used ONLY when
 * the injected gate passed it anyway. Deliberately worded apart from the gate's own "has no
 * fields map" so an operator can tell the two apart: this one means the GATE accepted a map the
 * activity then refused (a gate/wiring problem), not that the gate rejected the extraction.
 */
const UNUSABLE_FIELDS_MESSAGE = "meeting extraction fields are not a usable field map";

/**
 * Is `fields` the `Record<string, ExtractionField<unknown>>` the port declares? The declared type
 * says yes, but the value arrives from a broker/provider at runtime, so it is candidate data like
 * any other. This matters mechanically, not just hygienically: `validateNoInference` iterates it
 * with `Object.entries`, which THROWS a raw TypeError on null/undefined — across the activity
 * boundary, violating §16.
 */
function isFieldsMap(fields: unknown): fields is AgentExtraction["fields"] {
  return typeof fields === "object" && fields !== null && !Array.isArray(fields);
}

/**
 * Build a {@link ValidateExtractionPort} composing the no-inference rule with the
 * injected schema gate (inv-3). For a USABLE fields map, no-inference runs FIRST and
 * short-circuits — an inferred field rejects before the schema gate is ever consulted
 * (no partial validation). The one exception is step (0) below: a map no-inference
 * cannot iterate goes to the gate first, because no-inference would throw on it.
 * Never throws.
 */
export function createValidateActivity(
  deps: ValidateActivityDeps,
): ValidateExtractionPort {
  return {
    validate(
      extraction: AgentExtraction,
    ): Result<ValidatedExtraction, ValidationRejection> {
      // (0) STRUCTURAL pre-check (§16 — never throw across the boundary). `validateNoInference`
      // iterates `fields` with `Object.entries`, which throws on null/undefined, so a structurally
      // unusable map has to be decided BEFORE it runs. It is decided by the injected GATE, not
      // here — that is the gate's job, and routing it there is what makes the gate's own
      // field-less branch ("meeting extraction has no fields map") reachable through this
      // activity at all; the operator still learns the model returned NOTHING, which is a
      // provider/prompt problem rather than a validation one. If the gate passes such a map
      // anyway, this still fails CLOSED under a fixed local diagnostic (safety rule 2: a
      // structurally unusable candidate never becomes a branded ValidatedExtraction).
      const candidateFields: unknown = extraction.fields;
      if (!isFieldsMap(candidateFields)) {
        const structural = deps.schemaGate(extraction);
        return err({
          code: "schema_rejected",
          message: structural.ok
            ? UNUSABLE_FIELDS_MESSAGE
            : safeSchemaGateMessage(structural.error.message),
          rejections: [],
        });
      }
      // (1) no-inference (REQ-F-017) — HARD reject, short-circuit (no partial).
      const noInference = validateNoInference(candidateFields);
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
        // SAFETY RULE 7 (incidental, NOT the payload). Of the REAL wired gate's five messages,
        // only the three `field '<key>' …` ones carry model-authored text; the key is dropped and
        // the role kept, while the two field-less diagnostics cross. That coverage is a property
        // of THAT gate — see safeSchemaGateMessage's ⚠ LIMIT note for what an arbitrary injected
        // gate could still cross. `code` is always the fixed literal "schema_rejected" (this gate
        // has no other outcome); every driver branches on it alone.
        return err({
          code: "schema_rejected",
          message: safeSchemaGateMessage(gated.error.message),
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
