// GATE-1 end-to-end (CP-1 / task 18.11, REQ-F-017) — the crossing's REQ-F-017
// hard gate. Proves the frozen `sow:agent-extraction` contract carries per-field
// `evidenceRef` FAITHFULLY into `validateNoInference`: a schema-valid extraction
// is structurally accepted by the domain validator, and the validator's verdict
// keys on the SAME `evidenceRef` the schema preserved.
//
// This is the anti-KMP-stand-in proof. Before CP-1 the meeting/source legs rode a
// KMP stand-in (`sow:knowledge-mutation-plan`) that DISCARDS per-field
// `evidenceRef`; arming a real model over it would let an invented owner/date
// (a concrete value with NO evidence) slip past `validateNoInference` because the
// evidence signal was gone. With the first-class `agent_extraction` schema the
// evidence survives, so `checkExtractionField`'s `inferred_owner_or_date` reject
// fires on real model extractions exactly as it does here.
//
// domain → contracts is the allowed import direction (domain depends on
// contracts), so this composition test lives in domain, not contracts.
import { describe, expect, it } from "vitest";
import { AgentExtractionCandidateSchema } from "@sow/contracts";
import { validateNoInference } from "../../src/validation/no-inference";
import type { ExtractionField } from "../../src/validation/no-inference";

/** Parse a raw candidate through the frozen contract schema, then hand the
 *  validated field-map to the domain no-inference validator — the exact GATE-1
 *  flow (raw model output → candidate-data schema gate → REQ-F-017 validator). */
function parseThenValidate(raw: unknown) {
  const parsed = AgentExtractionCandidateSchema.safeParse(raw);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("fixture is not schema-valid");
  // The frozen contract's field shape is structurally an ExtractionField map, so
  // the domain validator consumes it directly (no re-mapping, no evidence loss).
  const fields = parsed.data.fields as Record<string, ExtractionField<unknown>>;
  return validateNoInference(fields);
}

describe("GATE-1 — agent_extraction evidence reaches validateNoInference (REQ-F-017)", () => {
  it("a schema-valid evidence-bearing extraction PASSES validateNoInference", () => {
    // owner: concrete value + evidenceRef (backed) ; dueDate: TBD park value.
    const r = parseThenValidate({
      fields: {
        owner: { value: "Alice", evidenceRef: "transcript#L12" },
        dueDate: { value: "TBD" },
      },
    });
    expect(r.ok).toBe(true);
  });

  it("a schema-valid concrete value with NO evidenceRef is REJECTED as inferred_owner_or_date (the anti-KMP-stand-in pin)", () => {
    // This candidate is STRUCTURALLY valid (evidenceRef is optional in the
    // schema) — exactly the shape a hostile/hallucinating model emits when it
    // INVENTS an owner. Because the frozen schema preserved the (absent)
    // evidenceRef faithfully, validateNoInference catches the inference.
    const r = parseThenValidate({ fields: { owner: { value: "Alice" } } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContainEqual({ code: "inferred_owner_or_date", field: "owner" });
    }
  });

  it("a schema-valid concrete value with an EMPTY/whitespace evidenceRef is REJECTED as missing_evidence", () => {
    const r = parseThenValidate({ fields: { dueDate: { value: "2026-07-01", evidenceRef: "   " } } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContainEqual({ code: "missing_evidence", field: "dueDate" });
    }
  });
});
