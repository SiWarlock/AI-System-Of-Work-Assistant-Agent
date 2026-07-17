// @sow/providers — Claude extraction REQUEST leg (CP-2 / 18.12a, §19.5 / §9 / REQ-F-017).
//
// Builds the Claude structured-output request for an `agent_extraction` job: the
// Anthropic `output_config.format` json_schema block (grounded on Context7,
// /llmstxt/platform_claude_llms_txt) keyed off the JOB's `outputSchemaId` (locked
// decision #2 — the schema id comes from the job, NEVER the candidate) + the
// deterministic extraction prompt.
//
// LESSON 3 (back-verify the wire shape, don't trust a convention): Anthropic
// structured outputs REJECT reference keywords ($ref / $def / definitions) and
// require the schema INLINED — a bare `{ $id }` carries NO structural constraint, so
// arming it would leave the model unconstrained and the gate would reject everything.
// This leg therefore RESOLVES the schema id → its full inline JSON Schema (via the
// same contracts registry the domain schema-gate validates against) and FAILS CLOSED
// on an unresolved id — it never emits a schemaless / unconstrained request.
//
// SAFE-BUILD: this pins the request SHAPE deterministically; the model's actual output
// (evidenceRef faithfulness) is eval-at-flip. The candidate-data gate (ajv + Zod,
// REQ-S-006) remains the safety backstop regardless of the model-side constraint.
import { ok, err, isErr } from "@sow/contracts";
import type { AgentJob, Result } from "@sow/contracts";
import { defaultSchemaRegistry } from "@sow/contracts/schema/registry";

/**
 * Deterministic extraction instruction (REQ-F-017 no-inference): the model extracts
 * structured fields and MUST cite a verbatim source span in `evidenceRef` for every
 * concrete value; any value not stated in the source is the `"TBD"` park sentinel
 * (never an invented owner/date). The model's adherence is eval-at-flip.
 */
export const MEETING_EXTRACTION_PROMPT: string = [
  "Extract the structured closeout fields from the meeting transcript.",
  "For every field with a concrete value, set evidenceRef to the verbatim source span it was taken from.",
  'If a field is not explicitly stated in the transcript, set its value to "TBD" and omit evidenceRef —',
  "never infer or invent an owner, date, or any other value (REQ-F-017).",
].join(" ");

/**
 * Resolve a registered schema id → its full inline JSON Schema object. Anthropic
 * structured outputs require the schema inlined (no `$ref`); a bare `{ $id }` carries
 * no constraint. Returns `undefined` for an unknown id — the builder fails closed.
 */
export type SchemaResolver = (schemaId: string) => Record<string, unknown> | undefined;

/**
 * Default resolver over the process-wide contracts registry — the SAME seam the
 * domain schema-gate validates against (`@sow/contracts/schema/registry`). The
 * compiled ajv validator carries its source schema on `.schema`; an unknown id or a
 * non-object schema resolves to `undefined` (fail-closed at the builder). Never throws
 * (`Map.get` + the registry's documented no-throw contract). Every registered schema
 * carries a non-empty `$id` (`buildSchemaRegistry` requires it), so a bare/empty
 * unconstrained `{}` schema is unregisterable — a resolved schema is always structural.
 */
export const registrySchemaResolver: SchemaResolver = (schemaId) => {
  const schema = defaultSchemaRegistry.getValidator(schemaId)?.schema;
  return typeof schema === "object" && schema !== null ? (schema as Record<string, unknown>) : undefined;
};

/** The Claude structured-output config — the schema is INLINED (never a bare `$id` ref). */
export interface ClaudeExtractionOutputConfig {
  readonly format: {
    readonly type: "json_schema";
    readonly schema: Record<string, unknown>;
  };
}

/** Enumerable fault of building the request. `schema_unresolved` = the id names no
 *  registered schema, so no constrainable request can be built (fail-closed, §16). */
export interface ExtractionRequestFault {
  readonly code: "schema_unresolved";
  readonly schemaId: string;
}

/**
 * Build the Claude structured-output config for an extraction job: resolve the given
 * `outputSchemaId` (locked #2 — the JOB's id) to its full inline schema and carry it
 * under `output_config.format`. Fails closed with a typed `schema_unresolved` when the
 * id names no registered schema — NEVER emits a schemaless / unconstrained request.
 */
export function buildClaudeExtractionOutputConfig(
  outputSchemaId: string,
  resolve: SchemaResolver = registrySchemaResolver,
): Result<ClaudeExtractionOutputConfig, ExtractionRequestFault> {
  const schema = resolve(outputSchemaId);
  if (schema === undefined) return err({ code: "schema_unresolved", schemaId: outputSchemaId });
  // Shallow-copy so the armed request never ALIASES the live registry schema object
  // (the same object ajv compiled the structural gate from) — an arming-time top-level
  // edit (e.g. stripping the draft `$schema`/`$id` keys) must not mutate the shared
  // validation schema. Nested nodes are still shared; arming must treat them read-only.
  return ok({ format: { type: "json_schema", schema: { ...schema } } });
}

/** The full meeting-extraction request leg: the inline structured-output config + the
 *  deterministic extraction prompt. Reachability-waivered producer (L11) — the live
 *  consumer is the real arming transport; the worker reconstruction lands in 18.12b. */
export interface AgentExtractionRequest {
  readonly outputConfig: ClaudeExtractionOutputConfig;
  readonly prompt: string;
}

/**
 * Assemble the Claude meeting-extraction request from an `AgentJob`: the inline
 * structured-output config keyed off `job.outputSchemaId` + the extraction prompt.
 * Propagates the `schema_unresolved` fail-closed fault.
 */
export function buildMeetingExtractionRequest(
  job: AgentJob,
  resolve: SchemaResolver = registrySchemaResolver,
): Result<AgentExtractionRequest, ExtractionRequestFault> {
  const cfg = buildClaudeExtractionOutputConfig(job.outputSchemaId, resolve);
  if (isErr(cfg)) return cfg;
  return ok({ outputConfig: cfg.value, prompt: MEETING_EXTRACTION_PROMPT });
}
