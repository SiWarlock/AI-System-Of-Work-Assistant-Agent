// 1.11 — no-inference (REQ-F-017 / MTG-4) over an ABSTRACT evidence-backed
// extraction-field shape. A concrete (non-TBD) claim MUST cite evidence; an
// unstated value is emitted as 'TBD' (always allowed) or routed to clarification.
// PURE + deterministic — no clock/network/random.
import { describe, it, expect } from "vitest";
import type { ExtractionField } from "../../src/validation/no-inference";
import {
  checkExtractionField,
  validateNoInference,
} from "../../src/validation/no-inference";

describe("checkExtractionField (REQ-F-017, per-field)", () => {
  it("allows a 'TBD' value with no evidenceRef (unstated → TBD)", () => {
    const f: ExtractionField<string> = { value: "TBD" };
    const r = checkExtractionField("owner", f);
    expect(r.ok).toBe(true);
  });

  it("allows a 'TBD' value even when an evidenceRef is present", () => {
    const f: ExtractionField<string> = { value: "TBD", evidenceRef: "src:1#L4" };
    const r = checkExtractionField("dueDate", f);
    expect(r.ok).toBe(true);
  });

  it("passes a concrete value backed by a non-empty evidenceRef", () => {
    const f: ExtractionField<string> = { value: "Alice", evidenceRef: "src:1#L4" };
    const r = checkExtractionField("owner", f);
    expect(r.ok).toBe(true);
  });

  it("rejects a concrete value with NO evidenceRef as inferred_owner_or_date", () => {
    const f: ExtractionField<string> = { value: "Alice" };
    const r = checkExtractionField("owner", f);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("inferred_owner_or_date");
      expect(r.error.field).toBe("owner");
    }
  });

  it("rejects a concrete value with an empty/whitespace evidenceRef as missing_evidence", () => {
    const f: ExtractionField<string> = { value: "2026-07-01", evidenceRef: "   " };
    const r = checkExtractionField("dueDate", f);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("missing_evidence");
      expect(r.error.field).toBe("dueDate");
    }
  });
});

describe("validateNoInference (REQ-F-017, aggregate)", () => {
  it("passes a field set that is all-TBD or all-backed", () => {
    const r = validateNoInference({
      owner: { value: "Alice", evidenceRef: "src:1#L4" },
      dueDate: { value: "TBD" },
    });
    expect(r.ok).toBe(true);
  });

  it("aggregates every rejection across the field set", () => {
    const r = validateNoInference({
      owner: { value: "Bob" }, // inferred_owner_or_date
      dueDate: { value: "2026-07-01", evidenceRef: "" }, // missing_evidence
      title: { value: "TBD" }, // allowed
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.length).toBe(2);
      const codes = r.error.map((e) => e.code).sort();
      expect(codes).toEqual(["inferred_owner_or_date", "missing_evidence"]);
      const fields = r.error.map((e) => e.field).sort();
      expect(fields).toEqual(["dueDate", "owner"]);
    }
  });

  it("returns ok for an empty field set (nothing to infer)", () => {
    const r = validateNoInference({});
    expect(r.ok).toBe(true);
  });
});
