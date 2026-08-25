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
    // ⛔⛔ THE `params` DROP HERE IS LOAD-BEARING FOR `### 24.98`'S ajv-SIDE
    // SAFETY ARGUMENT — DO NOT thread `e.params` (or ajv's sibling
    // `e.propertyName`) into the mapping below.
    //
    // CONSEQUENCE if it is added: on a `propertyNames` rejection ajv puts
    // the row-authored offending key ONLY in `params.propertyName` (and the
    // sibling top-level `propertyName` field) — its `message` string is
    // fixed, generic text ("property name must be valid") that echoes
    // nothing, and `additionalProperties`/`enum` rejections are the same
    // (fixed message, key only in `params`). Threading `params` in would
    // route that row-authored key straight into the `path`/`message` this
    // function returns, which `### 24.98`'s GCL audit path (and any other
    // rule-7 sink built from this rejection) reads and PERSISTS — a
    // row-authored key landing in a rule-7 audit record, with every
    // existing test green (the knowledge-side pins never construct a key
    // shaped to trip this, so they cannot see the regression).
    //
    // ⚠ ASYMMETRY: the Zod side of the candidate-data gate DOES carry the
    // rejected key in its own issue `path` (a `.strict()`/`.refine()`
    // rejection's path includes the offending property name) — so threading
    // `params` in here would ALIGN ajv to the UNSAFE side Zod is already
    // on, not bring it up to a safer standard.
    //
    // PRECONDITION for ever revisiting this (`### 24.104`): restoring
    // `params` is safe only once `structuralPathOnly` (the region-name
    // audit-path cut, `packages/knowledge`) is terminator-safe — a line
    // terminator inside the row-authored key must not defeat the cut.
    // SATISFIED as of `### 24.119` (`324a068d`, the `s`-flag fix) —
    // checkable at that commit, not to be re-derived from memory.
    //
    // Pinned: `test/validation/schema-gate.test.ts` (a `propertyNames`
    // rejection's row-authored key never appears anywhere in `errors`).
    const errors = (validator.errors ?? []).map((e) => ({
      path: e.instancePath || e.schemaPath,
      message: e.message ?? "",
    }));
    return err({ code: "schema_violation", schemaId, errors });
  }

  return ok(output);
}
