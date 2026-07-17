// 18.3 (B-rescoped) — the meeting extraction leg's two worker-only deliverables:
//   1. `mapAcceptedMeetingExtraction` — the meeting `mapCandidate` GATES on the accepted broker
//      outcome instead of blindly echoing the injected extraction: only an ACCEPTED outcome
//      (whose run-leg output passed the broker schema gate) carries a committable candidate, so
//      its extraction traces through; a NON-accepted outcome yields an EMPTY extraction the
//      downstream candidate-data gate rejects (no commit).
//   2. `createMeetingExtractionSchemaGate` — a REAL structural candidate-data gate (rule 2 /
//      REQ-S-006) over the meeting extraction's fields, replacing the `() => ok(undefined)` stub.
//      Composed with `validateNoInference` (REQ-F-017 — already live) inside the production-
//      reachable `ValidateExtractionPort` (createValidateActivity).
//
// SAFE-BUILD: the run leg is 18.1's dormant stub — no real model/prompt executes; these are pure
// deterministic validators. The FAITHFUL evidence-bearing extraction reconstruction from the
// accepted candidate is deferred to the first-class `agent_extraction` BrokerCandidate (task #18)
// — the current KMP stand-in candidate discards `ExtractionField.evidenceRef`, which REQ-F-017
// keys on, so it is unreconstructable worker-only.
//
// PURE — the schema gate NEVER coerces (no default-fill); it only decides ok/reject. Never throws.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type { AgentExtraction, MeetingSchemaGate } from "@sow/workflows";
import type { BrokerOutcome } from "@sow/providers";

/** A structural-gate rejection (the shape {@link MeetingSchemaGate} returns). */
type SchemaGateReject = { readonly code: "schema_rejected"; readonly message: string };

/**
 * Gate the meeting `mapCandidate` on the broker verdict. Only an ACCEPTED `BrokerOutcome` whose
 * candidate is present (the schema-gate-validated run-leg output) authorizes the extraction to
 * trace through; a rejection (or an accepted-but-candidate-less outcome) yields an EMPTY
 * extraction, which the downstream candidate-data gate (`ValidateExtractionPort`: the structural
 * gate + no-inference) rejects — no commit. This is the tightening over the prior
 * `(_outcome) => params.meetingExtraction` blind-ignore. Pure; never throws.
 */
export function mapAcceptedMeetingExtraction(
  outcome: BrokerOutcome,
  extraction: AgentExtraction,
): AgentExtraction {
  if (!outcome.ok || outcome.value.candidate === undefined) {
    return { fields: {} };
  }
  // The accepted, schema-gate-validated candidate traces through as the extraction. (Faithful
  // evidence-bearing reconstruction FROM the candidate is task #18; the KMP stand-in discards
  // evidenceRef, so REQ-F-017 can't be re-derived from it worker-only.)
  return extraction;
}

/** A value is a well-formed `ExtractionField.value` iff it is a string/number/boolean (the `TBD`
 *  sentinel is the string "TBD", so it's covered). NOT null/undefined (absence is expressed as
 *  `TBD`, never null), NOT an object/array/function (the model must not emit a structured value). */
function isPrimitiveOrTbd(v: unknown): boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * Build the REAL meeting-extraction structural schema gate (rule 2 / REQ-S-006) — the
 * candidate-data gate's structural half that `createValidateActivity` composes with
 * `validateNoInference`. It validates the extraction's fields are well-formed `ExtractionField`s
 * ({ value: primitive|TBD, evidenceRef?: string }) and non-empty; a malformed field ⇒
 * `schema_rejected`. PURE + total — it NEVER coerces (no default-fill), only decides; never throws.
 * Reuses the existing `ExtractionField` shape (no new frozen model). The concrete required-field
 * catalog (which named fields a meeting extraction must carry) is a §9 arch_gap — this gate pins
 * the STRUCTURE, not the field catalog.
 */
export function createMeetingExtractionSchemaGate(): MeetingSchemaGate {
  return (extraction: AgentExtraction): Result<void, SchemaGateReject> => {
    const fields = extraction.fields;
    if (fields === null || typeof fields !== "object") {
      return err({ code: "schema_rejected", message: "meeting extraction has no fields map" });
    }
    const keys = Object.keys(fields);
    if (keys.length === 0) {
      return err({ code: "schema_rejected", message: "meeting extraction carries no fields" });
    }
    for (const key of keys) {
      const f = (fields as Record<string, unknown>)[key];
      if (f === null || typeof f !== "object" || !("value" in f)) {
        return err({
          code: "schema_rejected",
          message: `field '${key}' is not a well-formed ExtractionField`,
        });
      }
      if (!isPrimitiveOrTbd((f as { value: unknown }).value)) {
        return err({
          code: "schema_rejected",
          message: `field '${key}' value is not a primitive or TBD`,
        });
      }
      const evidenceRef = (f as { evidenceRef?: unknown }).evidenceRef;
      if (evidenceRef !== undefined && typeof evidenceRef !== "string") {
        return err({
          code: "schema_rejected",
          message: `field '${key}' evidenceRef is not a string`,
        });
      }
    }
    return ok(undefined);
  };
}
