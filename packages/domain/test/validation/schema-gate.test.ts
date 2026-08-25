// 1.2 — candidate-data gate self-test (PURE). Uses an INLINE fixture registry.
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { emitJsonSchema } from "@sow/contracts/schema/emit";
import { buildSchemaRegistry } from "@sow/contracts/schema/registry";
import { validate } from "../../src/validation/schema-gate";

describe("schema-gate validate (1.2, REQ-S-006)", () => {
  const reg = buildSchemaRegistry([
    emitJsonSchema(z.object({ a: z.string() }).strict(), "sow:fixture"),
  ]);

  it("returns ok(output) for conforming output", () => {
    const r = validate({ a: "x" }, "sow:fixture", reg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: "x" });
  });

  it("returns schema_violation with a path for non-conforming output", () => {
    const r = validate({ a: 1 }, "sow:fixture", reg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("schema_violation");
      expect(r.error.schemaId).toBe("sow:fixture");
      expect(r.error.errors?.length).toBeGreaterThan(0);
      expect(typeof r.error.errors![0]!.path).toBe("string");
    }
  });

  it("returns unknown_schema for an unregistered id", () => {
    const r = validate({}, "sow:none", reg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("unknown_schema");
      expect(r.error.schemaId).toBe("sow:none");
    }
  });

  // ### 24.104 — regression pin for the comment above the error-mapping in
  // `validate()`: ajv puts a `propertyNames`-rejection's row-authored
  // offending key ONLY in `params`/`propertyName` (measured directly, both
  // sit outside `path`/`message`), never in `message` — so `params` staying
  // dropped is what keeps a row-authored key out of a rule-7 audit record.
  // This pin fails the moment a future edit threads `e.params` (or reads
  // ajv's sibling `propertyName` field) into the returned errors.
  //
  // The schema's `propertyNames.pattern` is a fixed STRUCTURAL rule
  // (kebab-case) independent of any specific key value — unlike a pattern
  // that spells the forbidden key literally (e.g. a negative lookahead
  // baked from the value itself), which would make ajv's generic "must
  // match pattern <schema-pattern>" message echo the row-authored value for
  // an unrelated reason and falsely pass this pin. The row-authored key
  // below (secret-shaped, uppercase + punctuation) is rejected BY the
  // structural rule without ever appearing IN it.
  it("never surfaces a row-authored key from a propertyNames rejection — the key sits ONLY in ajv's params/propertyName (### 24.104)", () => {
    const keyedReg = buildSchemaRegistry([
      {
        $id: "sow:fixture-propertynames-24-104",
        type: "object",
        propertyNames: { pattern: "^[a-z][a-z0-9-]*$" },
        additionalProperties: true,
      },
    ]);
    const rowAuthoredKey = "SuperSecretApiKey123!";
    const r = validate({ [rowAuthoredKey]: "value" }, "sow:fixture-propertynames-24-104", keyedReg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("schema_violation");
      // The row-authored key must not appear ANYWHERE in the mapped errors —
      // not in path, not in message.
      expect(JSON.stringify(r.error.errors)).not.toContain(rowAuthoredKey);
    }
  });
});
