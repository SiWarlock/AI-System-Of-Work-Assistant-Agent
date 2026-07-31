// 1.2 — Zod -> JSON Schema emitter (REQ-S-006 / §12 schema-snapshot posture).
// Produces a self-contained draft-07 schema (no $defs / no $ref) carrying a
// stable $id, so the schema registry can compile each model independently and
// the field-name set can be frozen as a checked-in snapshot. PURE.
import type { ZodTypeAny } from "zod";
import type { ZodObjectDef } from "zod/v3";
import { zodToJsonSchema, type PostProcessCallback } from "zod-to-json-schema";

/**
 * The reserved-key blocklist the policy below enforces on the JSON-Schema
 * side. Exported so a model's own Zod-side guard (13.8g-C: `.catchall()` has
 * no key-schema slot, so a model built that way needs its OWN mechanism, e.g.
 * a `z.preprocess` walking raw keys) shares this EXACT pattern rather than
 * re-typing an equivalent regex that could silently drift from this one.
 */
export const RESERVED_CATCHALL_KEY_PATTERN = "^(?!(?:__proto__|prototype|constructor)$)";

/**
 * POLICY (13.8g-C), not a one-off fix for one model: any object schema built
 * with a REAL (non-never) `.catchall()` gets `propertyNames` merged onto its
 * generated JSON Schema, unconditionally, for every model that ever reaches
 * for this shape. WHY: `z.object({...}).catchall(X)` has no key-schema slot
 * the way `z.record(keySchema, X)` does — its declared keys are fixed TS
 * literals and its catchall bucket validates VALUES only, never key NAMES —
 * so a container that mixes declared per-key overrides with an open catchall
 * bucket (needed when a schema wants per-field capability inside an
 * open-key-set record) would otherwise ship with NO structural guard against
 * a prototype-pollution-shaped key reaching that bucket, silently reopening
 * the ajv<->Zod parity gap a prior security review closed (see
 * `agent-extraction.ts`'s own header). Applying this as a blanket emitter
 * rule, rather than a per-model opt-in, makes the omission UNREPRESENTABLE
 * for every future model that reaches for `.catchall()` — a per-model opt-in
 * is something a future implementer can simply forget to add; this can't be,
 * because it isn't a step anyone has to remember. Confirmed INERT for any
 * object WITHOUT a real catchall, and confirmed to affect exactly one model
 * today (`agent-extraction.ts`) — both pinned in `test/schema/emit.test.ts`,
 * which censuses every real `.catchall(` call site so that count can't
 * quietly go stale as new models are added.
 *
 * ⛔ NAMED, NOT SILENT, GAP: `.passthrough()` (`unknownKeys: 'passthrough'`) has
 * the IDENTICAL silent-`__proto__`-drop hazard as a real catchall, and is NOT
 * covered by this policy — its generated schema is `additionalProperties: true`
 * with no catchall def for this rule to key off of. Zero uses in this package
 * today (grepped). If a future model reaches for `.passthrough()` on an
 * open-key-set object, this policy will NOT protect it; that model needs its
 * own guard, same as `.catchall()` needed one before 13.8g-C.
 */
const guardCatchallPropertyNames: PostProcessCallback = (jsonSchema, def) => {
  if (jsonSchema === undefined || !("typeName" in def) || def.typeName !== "ZodObject") {
    return jsonSchema;
  }
  const objectDef = def as unknown as ZodObjectDef;
  if (objectDef.catchall._def.typeName === "ZodNever") {
    return jsonSchema;
  }
  return { ...jsonSchema, propertyNames: { pattern: RESERVED_CATCHALL_KEY_PATTERN } };
};

/**
 * Emit a self-contained JSON Schema (draft-07) for a Zod schema and stamp it
 * with `$id`. `$refStrategy: 'none'` inlines every sub-schema so the result has
 * no `$defs`/`$ref` and can be compiled standalone. Applies the catchall
 * `propertyNames` policy above to every model uniformly (13.8g-C) — inert for
 * every model that doesn't use `.catchall()`.
 */
export function emitJsonSchema(schema: ZodTypeAny, $id: string): Record<string, unknown> {
  const result = zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
    postProcess: guardCatchallPropertyNames,
  }) as Record<string, unknown>;
  result["$id"] = $id;
  return result;
}
