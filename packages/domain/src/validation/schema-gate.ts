// 1.2 — the candidate-data gate (REQ-S-006 / §3 universal rule). Model/provider/
// agent output is candidate data until it passes this gate: an unknown schema id
// or an ajv-invalid payload is a typed rejection, never a usable value. PURE —
// the registry is prebuilt; no clock/network/random.
import { defaultSchemaRegistry } from "@sow/contracts/schema/registry";
import type { SchemaRegistry } from "@sow/contracts/schema/registry";
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";

export type SchemaRejection = {
  code: "unknown_schema" | "schema_violation";
  schemaId: string;
  errors?: { path: string; message: string }[];
};

/**
 * Validate `output` against the schema registered under `schemaId`.
 * - unknown id  -> err(unknown_schema)
 * - ajv-invalid -> err(schema_violation) with failing JSON paths
 * - valid       -> ok(output)
 */
export function validate(
  output: unknown,
  schemaId: string,
  registry: SchemaRegistry = defaultSchemaRegistry,
): Result<unknown, SchemaRejection> {
  const validator = registry.getValidator(schemaId);
  if (validator === undefined) {
    return err({ code: "unknown_schema", schemaId });
  }

  const valid = validator(output);
  if (!valid) {
    const errors = (validator.errors ?? []).map((e) => ({
      path: e.instancePath || e.schemaPath,
      message: e.message ?? "",
    }));
    return err({ code: "schema_violation", schemaId, errors });
  }

  return ok(output);
}
