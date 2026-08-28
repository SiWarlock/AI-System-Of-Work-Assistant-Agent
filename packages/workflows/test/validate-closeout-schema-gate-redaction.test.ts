// R3 — spec(safety rule 7) — SCOPE: the INCIDENTAL schema-gate rejection TEXT on the ERR arm of
// validateCloseout.ts's `createValidateActivity` — never the OK arm's `fields: extraction.fields`
// PAYLOAD (the validated extraction that becomes the committed note — pinned separately by
// `payload-integrity-pins.test.ts`; root CLAUDE.md's "THE SCOPE BOUNDARY" forbids touching it).
//
// With the REAL wired gate bound (apps/worker/src/composition/buildActivities.ts:736,
// `createMeetingExtractionSchemaGate`), a structural rejection folds the extraction's OWN field
// NAME — model-authored, drawn from an untrusted transcript/source — into THREE of its five
// possible messages as `field '<key>' ...` (apps/worker/src/composition/meeting-extraction.ts).
// Confirmed over real backends this can read e.g. `field 'owner_PZN9F3A1BSECRET-leak' value is not
// a...`. Every driver of `ValidateExtractionPort` (meetingCloseout.ts / hermesAutomation.ts /
// sourceIngestion.ts workflows) branches ONLY on `.error.code` when surfacing a rejection — never
// `.error.message` — so nothing downstream consumes the raw text; there is no functional reason to
// widen the redaction past the model-authored fragment. This suite pins:
//   (1) the poisoned field-NAME text is DROPPED — never crosses — while the field's ROLE ("value
//       is not a primitive or TBD") is RESTORED, and the closed `code` ("schema_rejected") still
//       crosses byte-identically;
//   (2) the gate's two field-LESS messages ("meeting extraction has no fields map" / "... carries
//       no fields") name no model-authored text at all and cross UNCHANGED — restored 2026-08-27,
//       reverting an earlier pass that collapsed all five schema-gate messages onto one fixed
//       literal (CLAUDE.md "THE BAR IS INVERTED: restore unless removal is clearly justified");
//   (3) the no_inference_violation branch (a DIFFERENT, already-static message, untouched by this
//       fix) still carries its per-field `rejections` list unredacted — proving the fix stayed
//       scoped to the schema-gate branch only;
//   (4) the OK arm's `fields`/`schemaId` still cross INTACT, unredacted.
import { describe, it, expect } from "vitest";
import { err, ok, isErr, isOk } from "@sow/contracts";
import { createValidateActivity } from "../src/activities/validateCloseout";
import { makeAgentExtraction } from "./support/meeting-fakes";

const POISON_FIELD_NAME = "owner_PZN9F3A1BSECRET-leak";

describe("spec(rule 7 / R3) validateCloseout — schema-gate rejection TEXT is redacted on the ERR arm only", () => {
  it("a poisoned field-name message from the wired gate never crosses, but the field's ROLE is restored; the code does", () => {
    const port = createValidateActivity({
      schemaGate: () =>
        err({
          code: "schema_rejected",
          message: `field '${POISON_FIELD_NAME}' value is not a primitive or TBD`,
        }),
    });
    const res = port.validate(makeAgentExtraction());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("schema_rejected");
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(POISON_FIELD_NAME);
    // The field's ROLE (the SoW-authored part) is RESTORED — the operator still learns WHAT was
    // wrong with the field, just not WHICH field (model-authored, dropped).
    expect(res.error.message).toBe("field value is not a primitive or TBD");
  });

  it("the gate's two field-LESS messages (the model returned nothing) cross UNCHANGED — no model-authored text to redact", () => {
    for (const message of ["meeting extraction has no fields map", "meeting extraction carries no fields"]) {
      const port = createValidateActivity({ schemaGate: () => err({ code: "schema_rejected", message }) });
      const res = port.validate(makeAgentExtraction());
      expect(isErr(res)).toBe(true);
      if (!isErr(res)) continue;
      expect(res.error.message).toBe(message);
    }
  });

  it("distinct field-role rejections render distinctly (mutation-provable: a fixed literal would collapse them to one string)", () => {
    const portA = createValidateActivity({
      schemaGate: () => err({ code: "schema_rejected", message: `field '${POISON_FIELD_NAME}' is not a well-formed ExtractionField` }),
    });
    const portB = createValidateActivity({
      schemaGate: () => err({ code: "schema_rejected", message: `field '${POISON_FIELD_NAME}' evidenceRef is not a string` }),
    });
    const resA = portA.validate(makeAgentExtraction());
    const resB = portB.validate(makeAgentExtraction());
    expect(isErr(resA)).toBe(true);
    expect(isErr(resB)).toBe(true);
    if (!isErr(resA) || !isErr(resB)) return;
    expect(resA.error.message).toBe("field is not a well-formed ExtractionField");
    expect(resB.error.message).toBe("field evidenceRef is not a string");
    expect(resA.error.message).not.toBe(resB.error.message);
  });

  it("the no_inference_violation branch is UNAFFECTED — its static message + per-field rejections still cross", () => {
    const port = createValidateActivity({ schemaGate: () => ok(undefined) });
    const res = port.validate(
      makeAgentExtraction({ fields: { owner: { value: "Alice" }, dueDate: { value: "TBD" as never } } }),
    );
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("no_inference_violation");
    expect(res.error.rejections.length).toBeGreaterThan(0);
    expect(res.error.message).toBe("REQ-F-017: extraction carries inferred or unsupported field(s)");
  });

  it("the OK arm's fields/schemaId still cross INTACT — the ERR-arm redaction never touches the payload", () => {
    const extraction = makeAgentExtraction();
    const port = createValidateActivity({ schemaGate: () => ok(undefined) });
    const res = port.validate(extraction);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.fields).toBe(extraction.fields); // reference-identical, never a redacted copy
    expect(res.value.schemaId).toBe(extraction.schemaId);
  });
});

// ---------------------------------------------------------------------------
// (5) C3 finding 1 — §16: a structurally unusable `fields` map must FOLD, never THROW
// ---------------------------------------------------------------------------
//
// `validateNoInference` iterates `fields` with `Object.entries`, which throws a raw TypeError
// ("Cannot convert undefined or null to object") on null/undefined. Because no-inference ran
// FIRST and unguarded, `validate({ fields: null })` threw ACROSS the activity boundary (§16
// violation) and the real wired gate's OWN field-less branch ("meeting extraction has no fields
// map", apps/worker/src/composition/meeting-extraction.ts) was unreachable through this activity.
// These pin the fold: a typed rejection, the gate consulted so its field-less diagnostic reaches
// the operator (the model returned NOTHING — a provider/prompt problem), and fail-closed even
// when the injected gate is lenient.

/** Mirrors the real wired gate's two field-less branches (createMeetingExtractionSchemaGate). */
const fieldLessGate = (extraction: { readonly fields: unknown }) => {
  const fields = extraction.fields;
  if (fields === null || typeof fields !== "object") {
    return err({ code: "schema_rejected" as const, message: "meeting extraction has no fields map" });
  }
  if (Object.keys(fields).length === 0) {
    return err({ code: "schema_rejected" as const, message: "meeting extraction carries no fields" });
  }
  return ok(undefined);
};

describe("spec(§16 / C3) validateCloseout — a structurally unusable fields map FOLDS to a typed rejection", () => {
  it("`{ fields: null }` does NOT throw and returns schema_rejected (mutation-provable: running no-inference first throws a TypeError)", () => {
    const port = createValidateActivity({ schemaGate: fieldLessGate });
    const bad = { fields: null } as unknown as Parameters<typeof port.validate>[0];
    expect(() => port.validate(bad)).not.toThrow();
    const res = port.validate(bad);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("schema_rejected");
    expect(res.error.rejections).toEqual([]);
  });

  it("the gate's OWN field-less branch is now REACHABLE — its diagnostic crosses VERBATIM so the operator learns the model returned nothing", () => {
    const port = createValidateActivity({ schemaGate: fieldLessGate });
    for (const bad of [{ fields: null }, { fields: undefined }]) {
      const res = port.validate(bad as unknown as Parameters<typeof port.validate>[0]);
      expect(isErr(res)).toBe(true);
      if (!isErr(res)) continue;
      // Mutation-provable: a fixed local literal (never consulting the gate) would not equal this.
      expect(res.error.message).toBe("meeting extraction has no fields map");
    }
  });

  it("an EMPTY-but-valid fields map still reaches the gate's second field-less branch (the guard did not swallow it)", () => {
    const port = createValidateActivity({ schemaGate: fieldLessGate });
    const res = port.validate(makeAgentExtraction({ fields: {} }));
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.message).toBe("meeting extraction carries no fields");
  });

  it("fails CLOSED even when the injected gate is LENIENT — a malformed map never yields a branded ValidatedExtraction", () => {
    const port = createValidateActivity({ schemaGate: () => ok(undefined) });
    for (const bad of [{ fields: null }, { fields: undefined }, { fields: "SECRET-transcript-text" }, { fields: 7 }, { fields: [] }]) {
      const res = port.validate(bad as unknown as Parameters<typeof port.validate>[0]);
      expect(isErr(res)).toBe(true);
      if (!isErr(res)) continue;
      expect(res.error.code).toBe("schema_rejected");
      // The SoW-authored fall-back diagnostic — distinct from the gate's own wording, so an
      // operator can tell "the gate passed a map this activity cannot use" from "the gate rejected".
      expect(res.error.message).toBe("meeting extraction fields are not a usable field map");
      expect(JSON.stringify(res)).not.toContain("SECRET-transcript-text");
    }
  });
});

// ---------------------------------------------------------------------------
// (6) C3 finding 2 — a HOSTILE field key must contribute NO fragment to the kept text
// ---------------------------------------------------------------------------
//
// The prior redaction used /^field '.*?' (.+)$/ and its doc comment claimed the non-greedy key
// match "resolves against the LAST `' ` before the role phrase, never leaking a key fragment".
// That is FALSE — non-greedy binds to the FIRST `' `, so a key containing `' ` pushes its own
// tail into the captured suffix. Verified: key `' owner_PZN9F3A1BSECRET-leak` yielded
// `field owner_PZN9F3A1BSECRET-leak' value is not a primitive or TBD`.

/** A key whose own text contains the `' ` separator the old capture bound to. */
const HOSTILE_KEY = `' ${POISON_FIELD_NAME}`;

describe("spec(rule 7 / C3) validateCloseout — a hostile field key contributes ZERO bytes to the kept diagnostic", () => {
  it("a key containing `' ` leaks no fragment (mutation-provable: the old non-greedy capture put the whole key tail in the message)", () => {
    for (const role of [
      "is not a well-formed ExtractionField",
      "value is not a primitive or TBD",
      "evidenceRef is not a string",
    ]) {
      const port = createValidateActivity({
        schemaGate: () => err({ code: "schema_rejected", message: `field '${HOSTILE_KEY}' ${role}` }),
      });
      const res = port.validate(makeAgentExtraction());
      expect(isErr(res)).toBe(true);
      if (!isErr(res)) continue;
      expect(JSON.stringify(res)).not.toContain(POISON_FIELD_NAME);
      // …and the role is still resolved CORRECTLY despite the decoy separator inside the key.
      expect(res.error.message).toBe(`field ${role}`);
    }
  });

  it("a key that impersonates a DIFFERENT role still resolves to the gate's REAL (trailing) role", () => {
    const port = createValidateActivity({
      schemaGate: () =>
        err({
          code: "schema_rejected",
          message: `field '${POISON_FIELD_NAME}' evidenceRef is not a string' value is not a primitive or TBD`,
        }),
    });
    const res = port.validate(makeAgentExtraction());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.message).toBe("field value is not a primitive or TBD");
    expect(JSON.stringify(res)).not.toContain(POISON_FIELD_NAME);
  });

  it("a field-naming message with an UNRECOGNISED role folds to a fixed literal rather than letting the key cross", () => {
    const port = createValidateActivity({
      schemaGate: () =>
        err({ code: "schema_rejected", message: `field '${POISON_FIELD_NAME}' fails a role this build does not know` }),
    });
    const res = port.validate(makeAgentExtraction());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(JSON.stringify(res)).not.toContain(POISON_FIELD_NAME);
    expect(res.error.message).toBe("field rejected by the schema gate under an unrecognised role");
  });
});
