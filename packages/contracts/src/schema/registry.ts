// 1.2 — schema registry (REQ-S-006). Maps schemaId ($id) -> compiled ajv
// validator. An unknown id yields `undefined` (the gate turns that into a typed
// rejection) — getValidator NEVER throws. Strict ajv + format assertions so
// provider drift cannot smuggle unknown fields. PURE at the registry surface
// (the default registry reads schema files lazily, once, on first use).
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { readdirSync, readFileSync } from "node:fs";

export interface SchemaRegistry {
  has(id: string): boolean;
  getValidator(id: string): ValidateFunction | undefined;
  ids(): string[];
}

/**
 * Build a registry over a set of self-contained JSON Schemas, each keyed by its
 * own `$id`. Compiles every schema up front under `strict: true` + formats.
 */
export function buildSchemaRegistry(schemas: Record<string, unknown>[]): SchemaRegistry {
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);

  const validators = new Map<string, ValidateFunction>();
  const idList: string[] = [];

  for (const schema of schemas) {
    const id = schema["$id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("buildSchemaRegistry: every schema must carry a non-empty string $id");
    }
    const validate = ajv.compile(schema);
    validators.set(id, validate);
    idList.push(id);
  }

  return {
    has: (id: string): boolean => validators.has(id),
    getValidator: (id: string): ValidateFunction | undefined => validators.get(id),
    ids: (): string[] => [...idList],
  };
}

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
