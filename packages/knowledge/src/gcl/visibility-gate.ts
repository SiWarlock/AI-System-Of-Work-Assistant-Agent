// GCL Visibility Gate (§6, task 4.10; REQ-F-005 / WS-8 / §5). The SINGLE
// cross-workspace read path — sanitized, visibility-validated `GclProjection`s
// are the only shape that crosses a workspace boundary, and a direct cross-brain
// raw retrieval is denied outright (agents may not issue cross-brain GBrain
// queries — safety rule 4 / workspace isolation).
//
// `admitProjection` is a COMPOSED candidate-data gate (LESSONS §3 — NEVER ajv
// alone): ajv structural `validate()` ∘ the model's Zod `.parse` (which recovers
// the raw-content-shaped-key refine that JSON-Schema drops) ∘ the §5 policy
// `validateProjectionVisibility` predicate. A projection carrying raw content OR
// exceeding the source workspace's default visibility is HARD-rejected with a
// typed reason — never downgraded-and-stored (§3 P3 / §5). Pure + fail-closed;
// returns a typed `Result`, never throws across the boundary (§16).
import { GclProjectionSchema, GCL_PROJECTION_SCHEMA_ID, ok, err } from "@sow/contracts";
import type { GclProjection, Workspace, VisibilityLevel, Result } from "@sow/contracts";
import { validate } from "@sow/domain";
import type { SchemaRegistry } from "@sow/contracts/schema/registry";
import {
  validateProjectionVisibility,
  denyDirectCrossWorkspaceRaw,
  isAllow,
  type CrossWorkspaceRawRequest,
} from "@sow/policy";

/** A single JSON-path-tagged validation issue (redaction-safe: path + message only). */
export interface GateIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Enumerable rejection reasons the Visibility Gate can emit (§16 — a closed set,
 * never a thrown error). `raw_content_present` and `visibility_exceeds_source`
 * are the two HARD-reject safety cases (§3 P3 / §5): the gate refuses them, it
 * does NOT sanitize-and-downgrade.
 */
export type GclGateError =
  | { readonly code: "schema_rejected"; readonly stage: "ajv" | "zod"; readonly issues: readonly GateIssue[] }
  | { readonly code: "raw_content_present"; readonly issues: readonly GateIssue[] }
  | {
      readonly code: "visibility_exceeds_source";
      readonly declaredLevel: VisibilityLevel;
      readonly sourceDefault: VisibilityLevel;
      readonly message: string;
    }
  | { readonly code: "malformed_policy_input"; readonly message: string };

/** Result alias for an admission decision. */
export type GclAdmitResult = Result<GclProjection, GclGateError>;

/**
 * Admit a candidate cross-workspace projection through the Visibility Gate.
 *
 * Composition (each stage fail-closed; first failure wins):
 *  1. ajv structural gate against `sow:gcl-projection` (REQ-S-006).
 *  2. Zod `.parse` — recovers the raw-content-shaped-key refine ajv drops; a
 *     failure whose issue path is `sanitizedPayload` is classified as the
 *     dedicated `raw_content_present` HARD reject.
 *  3. §5 `validateProjectionVisibility` — over-visibility ⇒ `visibility_exceeds_source`
 *     HARD reject; a workspace mismatch / malformed input ⇒ `malformed_policy_input`.
 *
 * On success returns the validated projection UNCHANGED (the gate never mutates
 * visibility or strips content — a candidate is either clean or rejected).
 */
export function admitProjection(
  candidate: unknown,
  sourceWorkspace: Workspace,
  registry?: SchemaRegistry,
): GclAdmitResult {
  // (1) ajv structural gate. Note: ajv's `additionalProperties:{}` on
  // sanitizedPayload does NOT catch raw-content keys — that is Zod's job (2).
  const structural =
    registry === undefined
      ? validate(candidate, GCL_PROJECTION_SCHEMA_ID)
      : validate(candidate, GCL_PROJECTION_SCHEMA_ID, registry);
  if (!structural.ok) {
    return err({
      code: "schema_rejected",
      stage: "ajv",
      issues: structural.error.errors ?? [
        { path: structural.error.schemaId, message: structural.error.code },
      ],
    });
  }

  // (2) Zod parse — recovers the `.refine` rules JSON-Schema drops (LESSONS §3),
  // specifically the raw-content-shaped-key ban on sanitizedPayload.
  const parsed = GclProjectionSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues: GateIssue[] = parsed.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    // A refine failure anchored at sanitizedPayload is a raw-content leak — the
    // dedicated HARD-reject variant (structural shape already passed ajv above).
    const rawContent = issues.some((i) => i.path === "sanitizedPayload");
    return err(rawContent ? { code: "raw_content_present", issues } : { code: "schema_rejected", stage: "zod", issues });
  }

  const projection: GclProjection = parsed.data;

  // (3) §5 visibility predicate — the source-default ceiling + workspace pin.
  const decision = validateProjectionVisibility(projection, sourceWorkspace);
  if (!isAllow(decision)) {
    if (decision.reason === "VISIBILITY_EXCEEDS_SOURCE") {
      return err({
        code: "visibility_exceeds_source",
        declaredLevel: projection.visibilityLevel,
        sourceDefault: sourceWorkspace.defaultVisibility,
        message: decision.message,
      });
    }
    return err({ code: "malformed_policy_input", message: decision.message });
  }

  return ok(decision.value);
}

/** Enumerable denial reasons for a direct cross-workspace raw-retrieval guard. */
export type CrossWorkspaceRawDenial =
  | { readonly code: "direct_cross_workspace_raw_denied"; readonly message: string }
  | { readonly code: "malformed_policy_input"; readonly message: string };

/**
 * The GCL is the SINGLE cross-workspace read path: a direct cross-workspace /
 * cross-brain RAW retrieval is denied (WS-8 / safety rule 4) unless it is a
 * same-workspace request or rides the SOLE exception — a recorded Level-3
 * owner-approved link. Wraps the §5 `denyDirectCrossWorkspaceRaw` predicate into
 * a typed `Result` so this package is the enforcement point. Fail-closed.
 */
export function guardCrossWorkspaceRawRead(
  req: CrossWorkspaceRawRequest,
): Result<{ permitted: true }, CrossWorkspaceRawDenial> {
  const decision = denyDirectCrossWorkspaceRaw(req);
  if (isAllow(decision)) {
    return ok(decision.value);
  }
  if (decision.reason === "DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL") {
    return err({ code: "direct_cross_workspace_raw_denied", message: decision.message });
  }
  return err({ code: "malformed_policy_input", message: decision.message });
}
