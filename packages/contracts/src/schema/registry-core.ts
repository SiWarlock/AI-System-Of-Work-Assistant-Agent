// 1.2 — schema registry CORE (REQ-S-006). The PURE half of the schema registry:
// the `SchemaRegistry` interface + `buildSchemaRegistry`, over ajv + ajv-formats
// only. No node:fs — this module is reachable from the @sow/contracts BARREL
// (`export * from "./schema/registry-core"`), so it must stay free of Node
// built-ins for the barrel to be usable from a bundled/sandboxed context (e.g.
// a Temporal workflow bundle). The fs-backed `defaultSchemaRegistry` (which
// loads `packages/contracts/schemas/*.schema.json` off disk) stays in
// `./registry.ts`, which re-exports this module's surface for its existing
// deep importers (`@sow/contracts/schema/registry`).
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";

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
