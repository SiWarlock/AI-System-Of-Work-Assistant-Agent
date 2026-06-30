// 1.2 — Zod -> JSON Schema emitter (REQ-S-006 / §12 schema-snapshot posture).
// Produces a self-contained draft-07 schema (no $defs / no $ref) carrying a
// stable $id, so the schema registry can compile each model independently and
// the field-name set can be frozen as a checked-in snapshot. PURE.
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Emit a self-contained JSON Schema (draft-07) for a Zod schema and stamp it
 * with `$id`. `$refStrategy: 'none'` inlines every sub-schema so the result has
 * no `$defs`/`$ref` and can be compiled standalone.
 */
export function emitJsonSchema(schema: ZodTypeAny, $id: string): Record<string, unknown> {
  const result = zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  result["$id"] = $id;
  return result;
}
