// 1.2 — schema registry self-test. Uses an INLINE fixture zod schema (not a model).
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { emitJsonSchema } from "../../src/schema/emit";
import { buildSchemaRegistry } from "../../src/schema/registry";

describe("buildSchemaRegistry (1.2, REQ-S-006)", () => {
  const schema = emitJsonSchema(z.object({ a: z.string() }).strict(), "sow:fixture");
  const reg = buildSchemaRegistry([schema]);

  it("has() is true for a registered $id", () => {
    expect(reg.has("sow:fixture")).toBe(true);
  });

  it("getValidator validates a conforming object", () => {
    const v = reg.getValidator("sow:fixture");
    expect(v).toBeTypeOf("function");
    expect(v!({ a: "x" })).toBe(true);
  });

  it("ajv strict rejects an unknown extra property", () => {
    const v = reg.getValidator("sow:fixture");
    expect(v!({ a: "x", extra: 1 })).toBe(false);
  });

  it("getValidator returns undefined for an unknown id (never throws)", () => {
    expect(reg.getValidator("sow:none")).toBeUndefined();
  });

  it("ids() contains the registered id", () => {
    expect(reg.ids()).toContain("sow:fixture");
  });
});
