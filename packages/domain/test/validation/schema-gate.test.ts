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
});
