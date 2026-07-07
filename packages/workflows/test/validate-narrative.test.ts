// P3c — the concrete ValidateNarrativePort. Pins: (a) the LOAD-BEARING no-inference gate over draft.fields
// (REQ-F-017 — the exact representation that becomes the committed prose), (b) the ValidatedNarrative brand is
// the only output on success (the commit-authorizing token), (c) the ajv/Zod SCHEMA gate is NOT re-run by
// default (it is owned upstream by the broker's candidate-data gate — verified in
// packages/providers/src/broker/schema-gate.ts), and (d) an optional injected narrative-schema hook stays
// reachable for a future pinned narrative schema.
import { describe, it, expect } from "vitest";
import { isOk } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { ExtractionField } from "@sow/domain";
import { createValidateNarrativePort } from "../src/activities/validateNarrative";
import type { ProgressNarrativeDraft } from "../src/ports/projectSync";

const field = (value: string, evidenceRef = "canonical:ref"): ExtractionField<string> => ({ value, evidenceRef });

const validDraft: ProgressNarrativeDraft = {
  fields: {
    explanation: field("shipped the auth redesign"),
    blocker: { value: TBD }, // unstated → allowed by no-inference
  },
  schemaId: "sow:project-narrative",
};

describe("createValidateNarrativePort", () => {
  it("passes an evidence-backed / TBD draft and emits the ValidatedNarrative brand", () => {
    const port = createValidateNarrativePort();
    const r = port.validate(validDraft);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.validated).toBe(true);
      expect(r.value.fields).toBe(validDraft.fields);
      expect(r.value.schemaId).toBe("sow:project-narrative");
    }
  });

  it("carries no schemaId through when the draft omitted it", () => {
    const port = createValidateNarrativePort();
    const r = port.validate({ fields: { x: field("done") } });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.schemaId).toBeUndefined();
  });

  it("REJECTS a draft that fabricates an unstated field (REQ-F-017 no-inference) — no brand", () => {
    // a concrete value with NO evidence slot → inferred_owner_or_date.
    const port = createValidateNarrativePort();
    const r = port.validate({ fields: { owner: { value: "Alice" } } });
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) {
      expect(r.error.code).toBe("no_inference_violation");
      expect(r.error.rejections.map((x) => x.field)).toContain("owner");
      expect(r.error.rejections[0]?.code).toBe("inferred_owner_or_date");
    }
  });

  it("REJECTS a concrete value with an empty evidence slot (missing_evidence)", () => {
    const port = createValidateNarrativePort();
    const r = port.validate({ fields: { claim: { value: "shipped", evidenceRef: "   " } } });
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) {
      expect(r.error.code).toBe("no_inference_violation");
      expect(r.error.rejections[0]?.code).toBe("missing_evidence");
    }
  });

  it("does NOT re-run a schema gate by default (upstream broker owns it) — a draft with no evidence-issues passes regardless of schemaId", () => {
    // even an unknown/absent schemaId passes: the ajv/Zod gate already ran at the broker on the raw output.
    const port = createValidateNarrativePort();
    expect(isOk(port.validate({ fields: { x: field("ok") }, schemaId: "sow:not-a-registered-schema" }))).toBe(true);
  });

  it("runs an INJECTED narrative-schema hook when configured, and folds its rejection to schema_rejected", () => {
    const port = createValidateNarrativePort({
      narrativeSchema: (draft) =>
        "explanation" in draft.fields
          ? { ok: true, value: undefined }
          : { ok: false, error: { code: "schema_rejected", message: "narrative missing explanation" } },
    });
    // passes the hook (has explanation) + no-inference
    expect(isOk(port.validate({ fields: { explanation: field("done") } }))).toBe(true);
    // fails the hook → schema_rejected, BEFORE any commit
    const r = port.validate({ fields: { other: field("done") } });
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) expect(r.error.code).toBe("schema_rejected");
  });

  it("the injected schema hook runs BEFORE no-inference (a schema-invalid draft rejects as schema_rejected, not no_inference)", () => {
    const port = createValidateNarrativePort({
      narrativeSchema: () => ({ ok: false, error: { code: "schema_rejected", message: "bad shape" } }),
    });
    // this draft ALSO has a no-inference violation (unbacked owner); the schema hook wins (runs first).
    const r = port.validate({ fields: { owner: { value: "Bob" } } });
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) expect(r.error.code).toBe("schema_rejected");
  });
});
