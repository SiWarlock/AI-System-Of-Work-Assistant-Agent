// 1.2 — schema registry (REQ-S-006). Maps schemaId ($id) -> compiled ajv
// validator. An unknown id yields `undefined` (the gate turns that into a typed
// rejection) — getValidator NEVER throws. Strict ajv + format assertions so
// provider drift cannot smuggle unknown fields. PURE at the registry surface
// (the default registry reads schema files lazily, once, on first use).
//
// `SchemaRegistry` + `buildSchemaRegistry` are defined in `../index.ts` (the
// fs-FREE half, reachable from the @sow/contracts barrel) and re-exported here
// so every existing importer of THIS module (deep import
// `@sow/contracts/schema/registry`, e.g. packages/domain/src/validation/
// schema-gate.ts) keeps working unchanged. This module keeps the node:fs-backed
// `defaultSchemaRegistry` — deliberately NOT re-exported from the barrel, so
// `@sow/contracts`'s public surface stays free of Node built-ins.
import type { ValidateFunction } from "ajv";
import { readdirSync, readFileSync } from "node:fs";
import { buildSchemaRegistry } from "../index";
import type { SchemaRegistry } from "../index";

export { buildSchemaRegistry };
export type { SchemaRegistry };

function loadSchemasFromDir(): Record<string, unknown>[] {
  try {
    const dir = new URL("../../schemas", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".schema.json"));
    return files.map(
      (f) =>
        JSON.parse(
          readFileSync(new URL(`../../schemas/${f}`, import.meta.url), "utf8"),
        ) as Record<string, unknown>,
    );
  } catch {
    // Missing/empty schemas dir => empty registry (no throw).
    return [];
  }
}

let cached: SchemaRegistry | undefined;
function lazy(): SchemaRegistry {
  if (cached === undefined) {
    cached = buildSchemaRegistry(loadSchemasFromDir());
  }
  return cached;
}

/**
 * Process-wide registry over `packages/contracts/schemas/*.schema.json`, built
 * lazily (and cached) on first method call. Behaves as an empty registry when
 * the schemas dir is missing or empty.
 */
export const defaultSchemaRegistry: SchemaRegistry = {
  has: (id: string): boolean => lazy().has(id),
  getValidator: (id: string): ValidateFunction | undefined => lazy().getValidator(id),
  ids: (): string[] => lazy().ids(),
};
