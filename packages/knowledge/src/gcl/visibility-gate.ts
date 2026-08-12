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
  type ProjectionTypeVisibilityTaxonomy,
  type DenialReason,
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
  // task 24.18 (WS-1/F14): the declared level is not permitted for the
  // projection's projectionType — a DERIVATION mismatch, distinct from
  // `visibility_exceeds_source` (a ceiling breach). Keep the two separate; see
  // `@sow/policy` `VISIBILITY_TYPE_MISMATCH` vs `VISIBILITY_EXCEEDS_SOURCE`.
  | {
      readonly code: "visibility_type_mismatch";
      readonly declaredLevel: VisibilityLevel;
      readonly projectionType: string;
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
 *     HARD reject; a projectionType/visibilityLevel derivation mismatch ⇒
 *     `visibility_type_mismatch` HARD reject (task 24.18, independent of the
 *     ceiling check); a workspace mismatch / malformed input ⇒ `malformed_policy_input`.
 *
 * On success returns the validated projection UNCHANGED (the gate never mutates
 * visibility or strips content — a candidate is either clean or rejected).
 *
 * `taxonomy` is an optional injected `ProjectionTypeVisibilityTaxonomy` forwarded
 * to `validateProjectionVisibility` (default: `@sow/policy`'s empty production
 * default — see task 24.18). Omitted, this call's behavior is byte-identical to
 * before 24.18.
 */
export function admitProjection(
  candidate: unknown,
  sourceWorkspace: Workspace,
  registry?: SchemaRegistry,
  taxonomy?: ProjectionTypeVisibilityTaxonomy,
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

  // (3) §5 visibility predicate — the source-default ceiling + the projectionType
  // derivation (task 24.18), each an independent gate + workspace pin.
  const decision = validateProjectionVisibility(projection, sourceWorkspace, taxonomy);
  if (!isAllow(decision)) {
    return err(denialToGateError(decision.reason, decision.message, projection, sourceWorkspace));
  }

  return ok(decision.value);
}

/**
 * Map a §5 `DenialReason` to this gate's `GclGateError` (task 24.36 / L134,
 * third instance this round — the prior form was an un-guarded `if`/`if`/
 * trailing-return that silently absorbed any reason besides the two explicit
 * checks into `malformed_policy_input`, contradicting its own adjacent comment).
 * EXHAUSTIVE over all 15 `DenialReason` members (4 `HardDenial` + 11
 * `SupportDenial`), terminated with an `assertNever`-style guard mirroring
 * `global-markdown-reconcile.ts`'s `gateReason` (task 24.30's landed pattern) —
 * a future 16th member is a compile error here, not a silent absorption.
 * `validateProjectionVisibility` can genuinely only ever emit 3 of the 15
 * (`VISIBILITY_EXCEEDS_SOURCE`/`VISIBILITY_TYPE_MISMATCH`/`MALFORMED_POLICY_INPUT`
 * — verified by reading its full body); the other 12 are grouped under one
 * fail-closed `malformed_policy_input` mapping (matching `FAIL_CLOSED_DENIAL`'s
 * own designation as the default deny code), each its OWN explicit case, not a
 * `default:` catch-all. Exported so every member is directly unit-testable, not
 * only the 3 reachable through a real `validateProjectionVisibility` call.
 */
export function denialToGateError(
  reason: DenialReason,
  message: string,
  projection: GclProjection,
  sourceWorkspace: Workspace,
): GclGateError {
  switch (reason) {
    case "VISIBILITY_EXCEEDS_SOURCE":
      return {
        code: "visibility_exceeds_source",
        declaredLevel: projection.visibilityLevel,
        sourceDefault: sourceWorkspace.defaultVisibility,
        message,
      };
    case "VISIBILITY_TYPE_MISMATCH":
      return {
        code: "visibility_type_mismatch",
        declaredLevel: projection.visibilityLevel,
        projectionType: projection.projectionType,
        message,
      };
    case "MALFORMED_POLICY_INPUT":
    case "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED":
    case "DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL":
    case "UNTRUSTED_CONTENT_MUTATING_TOOL":
    case "WRITE_ADAPTER_OUTSIDE_GATEWAY":
    case "PROVIDER_NOT_ALLOWED":
    case "NO_ROUTE_FOR_CAPABILITY":
    case "PROCESSOR_NOT_ALLOWED":
    case "LOCAL_ENDPOINT_NOT_CONFIGURED":
    case "NON_LOOPBACK_LOCAL_TREATED_AS_EGRESS":
    case "APPROVAL_REQUIRED":
    case "AUTH_TOKEN_INVALID":
    case "ORIGIN_NOT_ALLOWED":
      return { code: "malformed_policy_input", message };
    default: {
      // A new DenialReason member reaches here as a non-`never` type → tsc
      // error, forcing a deliberate mapping decision above (mirrors
      // defaultSeverityForFailureClass / 24.30's gateReason). Never a
      // `default:` that silently absorbs a real reason.
      const _exhaustive: never = reason;
      void _exhaustive;
      return { code: "malformed_policy_input", message };
    }
  }
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
