// Phase-1 contract-freeze coverage (REQ-S-006). Proves the schema gate covers
// EVERY frozen model: the default registry compiles all schemas under ajv strict
// without throwing, its id set is exactly the on-disk schema set, and every
// model's exported `*_SCHEMA_ID` resolves to a registered, compiled validator.
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { defaultSchemaRegistry } from "../../src/schema/registry";
import * as contracts from "../../src/index";

function schemaFiles(): string[] {
  const dir = new URL("../../schemas", import.meta.url);
  return readdirSync(dir).filter((f) => f.endsWith(".schema.json"));
}

// Every exported constant whose name ends in `_SCHEMA_ID` and whose value is a
// string is a frozen model's schema id (collected from the barrel, not hand-listed).
function exportedSchemaIds(): { name: string; id: string }[] {
  return Object.entries(contracts as Record<string, unknown>)
    .filter(([name, value]) => name.endsWith("_SCHEMA_ID") && typeof value === "string")
    .map(([name, value]) => ({ name, id: value as string }));
}

describe("defaultSchemaRegistry — full frozen-surface coverage (REQ-S-006)", () => {
  it("compiles every schema under ajv strict without throwing", () => {
    // Building the lazy registry compiles every schema with strict:true; any
    // non-compiling schema (unknown keyword, bad $id) would throw here.
    expect(() => defaultSchemaRegistry.ids()).not.toThrow();
  });

  it("registers exactly one validator per schemas/*.schema.json", () => {
    const files = schemaFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(defaultSchemaRegistry.ids().length).toBe(files.length);
  });

  it("registers a unique $id for every schema file (no $id collision)", () => {
    const ids = defaultSchemaRegistry.ids();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("registers a compiled validator for every model's exported *_SCHEMA_ID", () => {
    const exported = exportedSchemaIds();
    // Sanity: the barrel actually surfaces the frozen models' ids.
    expect(exported.length).toBeGreaterThanOrEqual(schemaFiles().length);
    for (const { name, id } of exported) {
      expect(defaultSchemaRegistry.has(id), `${name} (${id}) not registered`).toBe(true);
      expect(
        defaultSchemaRegistry.getValidator(id),
        `${name} (${id}) has no compiled validator`,
      ).toBeTypeOf("function");
    }
  });
});
