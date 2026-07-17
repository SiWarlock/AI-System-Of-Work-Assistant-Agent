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
// deterministic validators. 18.12b/CP-2 (GATE-1 consumer): `mapAcceptedMeetingExtraction` now
// RECONSTRUCTS the extraction FAITHFULLY from the first-class `agent_extraction` BrokerCandidate
// (CP-1) — each field's value + `evidenceRef` preserved intact, so `validateNoInference` (REQ-F-017)
// runs on the model's REAL evidence, replacing the KMP stand-in's `evidenceRef`-discarding echo. The
// reconstruction is production-reachable only once the arming bundle switches the job outputSchemaId
// → `sow:agent-extraction` (owner-gated, #13 Finding C) — reachability-WAIVERED here (L11), its LOGIC
// unit-proven in meeting-extraction.test.ts (the GATE-1 payoff).
//
// PURE — the schema gate NEVER coerces (no default-fill); it only decides ok/reject. Never throws.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type { AgentExtraction, MeetingSchemaGate } from "@sow/workflows";
import type { BrokerOutcome } from "@sow/providers";

/** A structural-gate rejection (the shape {@link MeetingSchemaGate} returns). */
type SchemaGateReject = { readonly code: "schema_rejected"; readonly message: string };

/**
 * Reconstruct the meeting extraction from the broker verdict (18.12b/CP-2). Only an ACCEPTED
 * `BrokerOutcome` carrying an `agent_extraction` candidate authorizes an extraction — its
 * `extraction.fields` are reconstructed FAITHFULLY (value + `evidenceRef` preserved intact) into
 * the `AgentExtraction` the downstream `ValidateExtractionPort` (structural gate + no-inference /
 * REQ-F-017) validates. A rejection, an accepted-but-candidate-less outcome, OR a non-`agent_extraction`
 * accepted candidate (the legacy KMP stand-in — still valid for other legs, but carrying no
 * evidence-bearing extraction) yields an EMPTY extraction, which the gate rejects — no commit (L46).
 * This replaces the prior evidenceRef-discarding echo of the injected extraction. Pure; never throws.
 */
export function mapAcceptedMeetingExtraction(outcome: BrokerOutcome): AgentExtraction {
  if (!outcome.ok || outcome.value.candidate === undefined) {
    return { fields: {} };
  }
  const candidate = outcome.value.candidate;
  if (candidate.kind !== "agent_extraction") {
    // A legacy non-`agent_extraction` accepted candidate (the KMP stand-in — still valid for other legs)
    // carries no evidence-bearing extraction to reconstruct ⇒ EMPTY, which the downstream candidate-data
    // gate rejects (no commit — L46 division of labor).
    return { fields: {} };
  }
  // FAITHFUL reconstruction FROM the accepted `agent_extraction` candidate (18.12b / GATE-1): each field's
  // value + evidenceRef preserved INTACT, so `validateNoInference` (REQ-F-017) runs on the model's REAL
  // evidence — replacing the KMP stand-in's evidenceRef-DISCARDING echo. The @sow/contracts
  // AgentExtractionCandidate and the @sow/workflows AgentExtraction share the `{ value, evidenceRef? }`
  // field shape (no port widening, flag-1); the broker schema gate already Zod-parsed the candidate (flag-3).
  // A null-prototype accumulator so a hostile `__proto__`/`constructor` field key (structurally
  // blocklisted upstream by CP-1's schema, L51) can never swap this map's prototype even if a future
  // gate change let one through — the mapper is self-defending independent of which schema gates it.
  const fields: AgentExtraction["fields"] = Object.create(null) as AgentExtraction["fields"];
  for (const [key, f] of Object.entries(candidate.extraction.fields)) {
    fields[key] =
      f.evidenceRef !== undefined
        ? { value: f.value, evidenceRef: f.evidenceRef }
        : { value: f.value };
  }
  return { fields };
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
