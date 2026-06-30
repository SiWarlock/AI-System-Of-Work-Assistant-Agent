// 1.11 — the 5 §3 universal validation rules as PURE, composable predicates.
// "Data crosses into application services only after these rules pass" (§3). Each
// rule returns a typed `Result` with an enumerable rejection `code`; none throws
// (§16 error convention). PURE — no clock/network/random: the schema rule reuses
// the prebuilt 1.2 candidate-data gate; the rest are field-presence predicates.
//
// Enumerable rejection codes (this module): schema_violation (rule a, the gate's),
// missing_key (rule b), unscoped_mutation (rule c), missing_visibility (rule d).
// The no-inference codes (missing_evidence / inferred_owner_or_date) live in the
// sibling `./no-inference` module (REQ-F-017).
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type {
  ExternalWriteEnvelope,
  ProposedAction,
  KnowledgeMutationPlan,
  GclProjection,
} from "@sow/contracts";
import type { SchemaRegistry } from "@sow/contracts/schema/registry";
import { validate } from "./schema-gate";

/** Enumerable rejection codes emitted by the four §3 universal rules here. */
export type UniversalRejectionCode =
  | "schema_violation"
  | "missing_key"
  | "unscoped_mutation"
  | "missing_visibility";

export interface UniversalRejection {
  readonly code: UniversalRejectionCode;
  /** Field names that were missing/empty (rules b/c/d). */
  readonly fields?: readonly string[];
  /** Schema `$id` that failed (rule a). */
  readonly schemaId?: string;
  /** Failing JSON paths from the schema gate (rule a). */
  readonly errors?: readonly { path: string; message: string }[];
}

// arch_gap: §3 says "non-empty"/"carries" without pinning whether a whitespace-
// only string counts as present. The contract schemas use `.min(1)` (length only),
// but a key/level that is pure whitespace cannot serve as a real existence/dedupe
// key or visibility declaration — so this defense-in-depth presence check treats a
// trimmed-empty string as missing (slightly stricter than the contract's min(1)).
const isPresent = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

/**
 * Rule (a) — schema validity (REQ-S-006). Delegate to the 1.2 candidate-data gate
 * and normalize ANY gate err (unknown_schema or schema_violation) into the §3
 * `schema_violation` rejection code, preserving the schemaId + failing paths.
 * `ok(output)` passes the validated value through unchanged.
 */
export function ruleSchemaValid(
  output: unknown,
  schemaId: string,
  registry?: SchemaRegistry,
): Result<unknown, UniversalRejection> {
  const r = registry === undefined ? validate(output, schemaId) : validate(output, schemaId, registry);
  if (r.ok) {
    return r;
  }
  return err({
    code: "schema_violation",
    schemaId: r.error.schemaId,
    errors: r.error.errors,
  });
}

/**
 * Rule (b) — external-write keys (§3/§8, safety rule 3). Every external-write
 * carrier (`ProposedAction` / `ExternalWriteEnvelope`) MUST carry a non-empty
 * `canonicalObjectKey` (pre-write existence check) AND `idempotencyKey` (replay
 * dedupe); else `missing_key`. Field PRESENCE check only — does NOT call the 1.10
 * builders (it verifies the keys were produced, not how).
 */
export function ruleExternalWriteKeys<T extends ProposedAction | ExternalWriteEnvelope>(
  item: T,
): Result<T, UniversalRejection> {
  const fields: string[] = [];
  if (!isPresent(item.canonicalObjectKey)) fields.push("canonicalObjectKey");
  if (!isPresent(item.idempotencyKey)) fields.push("idempotencyKey");
  if (fields.length > 0) {
    return err({ code: "missing_key", fields });
  }
  return ok(item);
}

/**
 * Rule (c) — scoped mutation (REQ-F-006 / §3). Every `KnowledgeMutationPlan` MUST
 * carry a non-empty `workspaceId` AND at least one `sourceRef`; an unscoped or
 * unsourced mutation is the "invented fact" the candidate-data / no-inference
 * rules forbid → `unscoped_mutation`.
 */
export function ruleScopedMutation(
  plan: KnowledgeMutationPlan,
): Result<KnowledgeMutationPlan, UniversalRejection> {
  const fields: string[] = [];
  if (!isPresent(plan.workspaceId)) fields.push("workspaceId");
  if (!Array.isArray(plan.sourceRefs) || plan.sourceRefs.length === 0) {
    fields.push("sourceRefs");
  }
  if (fields.length > 0) {
    return err({ code: "unscoped_mutation", fields });
  }
  return ok(plan);
}

/**
 * Rule (d) — visibility (REQ-F-005 / §6 WS-8). Every `GclProjection` (the single
 * cross-workspace read path) MUST declare a non-empty `visibilityLevel` AND its
 * source `workspaceId`; else `missing_visibility`.
 */
export function ruleVisibilityDeclared(
  projection: GclProjection,
): Result<GclProjection, UniversalRejection> {
  const fields: string[] = [];
  if (!isPresent(projection.visibilityLevel)) fields.push("visibilityLevel");
  if (!isPresent(projection.workspaceId)) fields.push("workspaceId");
  if (fields.length > 0) {
    return err({ code: "missing_visibility", fields });
  }
  return ok(projection);
}
