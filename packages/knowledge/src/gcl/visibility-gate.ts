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
import { buildRefusalSignal, type RefusalIssue } from "../audit/validation-refusal";
import {
  validateProjectionVisibility,
  denyDirectCrossWorkspaceRaw,
  isAllow,
  type CrossWorkspaceRawRequest,
  type ProjectionTypeVisibilityTaxonomy,
  type DenialReason,
  type AuditSignal,
} from "@sow/policy";

// ── `### 24.98` — the schema-stage rejection signal ─────────────────────────────────────────────
// ⛔ ASSEMBLED FROM NON-ROW-DERIVED MATERIAL ONLY: the closed `stage` literal, issue PATHS, and a
// COUNT. ⚠ `GateIssue.message` IS EXCLUDED CATEGORICALLY and this is the line where the wrong edit
// would happen (`L187`): `message` is validator-authored and MEASURED to echo row content — Zod's
// `invalid_enum_value` embeds the received value, and `unrecognized_keys` embeds a key the ROW
// author chose. Threading `issues` wholesale would route row content onto a rule-7 surface, where
// `isRedactionSafe` would then REFUSE the write — reproducing the very silence this task removes,
// with the suite green. `L73`: make the unsafe content unrepresentable rather than detecting it.
// ⚠ PATHS ARE SAFE BY A PROPERTY OF THE SCHEMAS, NOT OF THE VALIDATORS — the invalidating condition,
// and it holds on BOTH stages for the same structural reason: the only unbounded-key region is
// `sanitizedPayload`, which accepts anything on either side (`z.record(z.string(), z.unknown())` in
// Zod; `additionalProperties:{}` in JSON Schema), so neither validator can raise a per-entry issue
// there and no row-authored key can reach a path. ⛔ GIVE THAT REGION A REAL SCHEMA AND ROW-AUTHORED
// KEYS BECOME RAISEABLE UNDER THAT REGION — ⛔ AND THAT IS NOW HARMLESS BY CONSTRUCTION, NOT BY
// ARGUMENT: `structuralPathOnly` cuts every path at `sanitizedPayload`, so a row-authored key cannot
// reach `refs` even then. ⚠ THE PREVIOUS WORDING HERE CLAIMED "the pins catch it," AND NO SUCH PIN
// EXISTED — security review executed the condition and produced a real leak ref against a fully
// green suite. That was this slice's own thesis inverted: a control asserted rather than built.
// It is pinned now (`a_row_authored_key_cannot_reach_refs_under_a_tightened_stand_in`), through a
// deliberately-TIGHTENED stand-in registry — the mirror of the permissive one.
// ⚠ AJV SIDE, ONE LINE ELSEWHERE: `packages/domain/src/validation/schema-gate.ts` maps ajv errors as
// `{path, message}` and DROPS `e.params` — the only place ajv puts the row-authored key
// (`params.additionalProperty`). If anyone threads `params` into that mapping, this argument dies on
// the ajv stage. (Cross-area file; flagged rather than edited from here.)
const GCL_GATE_ACTOR = "knowledge:gcl-gate" as const;
// A payloadHash-shaped decision marker — a fixed constant, never a hash of the candidate. Mirrors
// `visibility.ts`'s VISIBILITY_PAYLOAD_MARKER convention: the identity rides the refs, the row never does.
const SCHEMA_REJECTED_PAYLOAD_MARKER = "knowledge:gcl-schema-rejection" as const;

// ⚠ The ref-count bound that used to live here (dedupe-then-cap, drop reported) moved WITH the
// assembly into `src/audit/validation-refusal.ts` and is shared by all five channels. Deliberately
// NOT restated here: two copies of a security-relevant cap means raising one silently leaves a
// stale, authoritative-looking number beside the reasoning for it.

// ⛔⛔ THE ROW-AUTHORED-KEY CUT — WHY THE SAFETY ARGUMENT DOES NOT DEPEND ON A SCHEMA PROPERTY.
// `sanitizedPayload` is this projection's only free-form-key region; truncating a path there means a
// key the ROW author chose can never appear in `refs`, EVEN IF a future schema gives that region a
// real subschema and starts raising per-entry issues under it. That replaced an ARGUMENT with a
// CONSTRUCTION: the earlier posture ("no per-entry issue can be raised there today") was true and
// contingent on a schema nobody promised to keep, and security review EXECUTED the invalidating
// condition to produce a real leak ref against a fully green suite —
// `isRedactionSafe` could not help, because `audit-signal.ts` names an employer project codename as
// precisely what its credential-shape heuristic misses (`contracts L73`: make it unrepresentable).
// ⭐ `### 24.103` — THE CUT AND THE BOUNDED ASSEMBLY NOW LIVE IN `src/audit/validation-refusal.ts`,
// keyed by candidate schema id; `sanitizedPayload` is this schema's entry in `FREE_FORM_KEY_REGIONS`,
// derived by the same two-surface walk as the other three. Both path dialects are handled there.
// ⛔ THE BEHAVIOUR IS UNCHANGED AND THAT IS LOAD-BEARING: this channel is the DISCRIMINATING CONTROL
// for `### 24.103`'s census — the one channel that already resolved `audit=true`, which is what
// proves the selector separates covered from uncovered. A control whose behaviour moved when it was
// refactored is no longer a control, so the signal's exact field values are pinned byte-for-byte in
// `validation-refusal-audit.test.ts` from a capture taken BEFORE the re-expression.
function schemaRejectedSignal(stage: "ajv" | "zod", issues: readonly GateIssue[]): AuditSignal {
  return buildRefusalSignal({
    actor: GCL_GATE_ACTOR,
    event: `gcl.projection.schema_rejected.${stage}`,
    refPrefix: "gcl-issue-path",
    payloadHash: SCHEMA_REJECTED_PAYLOAD_MARKER,
    beforeSummary: `gcl projection candidate refused at the ${stage} schema stage`,
    schemaId: GCL_PROJECTION_SCHEMA_ID,
    issues,
  });
}

/**
 * A single JSON-path-tagged validation issue.
 * ⛔ `path` IS redaction-safe; `message` IS NOT — corrected by `### 24.98`. This docblock previously
 * claimed "redaction-safe: path + message only", which asserted a property of `path` and then quietly
 * extended it to `message`. MEASURED: Zod's `invalid_enum_value` embeds the received value and
 * `unrecognized_keys` embeds a row-authored key. Never put `message` on an audit surface.
 */
export type GateIssue = RefusalIssue;

/**
 * Enumerable rejection reasons the Visibility Gate can emit (§16 — a closed set,
 * never a thrown error). `raw_content_present` and `visibility_exceeds_source`
 * are the two HARD-reject safety cases (§3 P3 / §5): the gate refuses them, it
 * does NOT sanitize-and-downgrade.
 */
// task 24.33: the three policy-decision-derived variants below (visibility_exceeds_source,
// visibility_type_mismatch, malformed_policy_input) carry an OPTIONAL `audit` — the
// `PolicyDecision`'s mandatory `AuditSignal`, threaded outward instead of dropped
// (`denialToGateError` is the only constructor of these three and always has one available).
// ⛔ REWRITTEN BY `### 24.98`, NOT STRUCK (`L153` half 1) — the original claim was:
// *"`schema_rejected`/`raw_content_present` never carry one — pure ajv/Zod shape failures with no
// `PolicyDecision`/`AuditSignal` behind them at all … adding the field there would imply a
// capability that can never manifest."*
// ⭐ IT REMAINS TRUE FOR `raw_content_present` and is now FALSE FOR `schema_rejected`, and the
// reason it expired is worth more than the correction: it held only while write-time and read-time
// validated against ONE schema, so a stored row could not be shape-invalid. ⛔ ROWS OUTLIVE SCHEMAS.
// `### 24.84` tightens the write-side shape; a row written before it becomes shape-invalid on READ,
// and refusing it silently is the gap `### 24.98` closes. The "capability that can never manifest"
// manifested — which is exactly why the statement is corrected here rather than deleted.
// ⚠ PRECISION, because it is what stops the correction being over-read (security review): only the
// CONCLUSION expired. The PREMISE — no `PolicyDecision`/`AuditSignal` sits behind a shape failure —
// is STILL TRUE. `### 24.98` does not thread a policy signal outward; it MINTS a gate-local one. The
// original was right that there is nothing to THREAD and wrong that there is therefore nothing to
// RECORD.
// ⚠ `raw_content_present` still mints nothing: it has no `PolicyDecision` behind it and its own
// pin (`raw_content_present_still_carries_no_signal`) exists so this rewrite cannot quietly widen.
export type GclGateError =
  | {
      readonly code: "schema_rejected";
      readonly stage: "ajv" | "zod";
      readonly issues: readonly GateIssue[];
      // ⛔ REQUIRED, not optional (`### 24.98`): the compiler then forces every construction site OF
      // THIS UNION to build one, so a new `GclGateError` rejection path cannot ship silently
      // signal-less. ⚠ SCOPED DELIBERATELY — it is NOT a package-wide guarantee:
      // `gbrain/remediation/generative-proposal-intake.ts` constructs a structurally identical
      // `{code:"schema_rejected", stage, issues}` on its OWN local union with no signal at all, and
      // the compiler forces nothing there because it is a different type (security review; flagged,
      // not absorbed). ⚠ The cost is real and recorded — requiring the field created a rule-7
      // construction at the ajv site, and a third at a test fixture, that had no test until this slice.
      readonly audit: AuditSignal;
    }
  | { readonly code: "raw_content_present"; readonly issues: readonly GateIssue[] }
  | {
      readonly code: "visibility_exceeds_source";
      readonly declaredLevel: VisibilityLevel;
      readonly sourceDefault: VisibilityLevel;
      readonly message: string;
      readonly audit?: AuditSignal;
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
      readonly audit?: AuditSignal;
    }
  | { readonly code: "malformed_policy_input"; readonly message: string; readonly audit?: AuditSignal };

/**
 * Extract a deny's `AuditSignal`, when the variant carries one (task 24.33).
 * ⛔ CORRECTED BY `### 24.98`, AND THE CORRECTION IS THE POINT: this docblock still asserted that
 * `schema_rejected` has "none to extract" — eleven lines above `case "schema_rejected": return
 * error.audit;` — and it POINTED THE READER at the `GclGateError` block, which by then said the
 * opposite. ⚠ The task's acceptance named ONE block to rewrite; the same claim had a second home on
 * the only consumer of the type, and fixing only the named site left the false copy as the one a
 * caller reads. A claim change owes a claim SWEEP, exactly as a rename owes a citation sweep.
 * ⇒ CURRENT: `schema_rejected` carries a gate-MINTED signal; `raw_content_present` carries none. Switches on `.code` with the same
 * `assertNever`-style exhaustiveness guard as `denialToGateError`/`denialToCrossWorkspaceRawDenial`
 * (this file's own convention, code-quality review) rather than a structural `"audit" in error`
 * check — a future 6th `GclGateError` variant is a compile error here, not a silent `undefined`.
 */
export function auditOf(error: GclGateError): AuditSignal | undefined {
  switch (error.code) {
    // `### 24.98` — `schema_rejected` now CARRIES a signal, so this stays a pure EXTRACTOR: the
    // minting happens at the rejection sites. A function named "extract" must not mint.
    case "schema_rejected":
      return error.audit;
    case "raw_content_present":
      return undefined;
    case "visibility_exceeds_source":
    case "visibility_type_mismatch":
    case "malformed_policy_input":
      return error.audit;
    default: {
      const _exhaustive: never = error;
      void _exhaustive;
      return undefined;
    }
  }
}

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
    const issues = structural.error.errors ?? [
      { path: structural.error.schemaId, message: structural.error.code },
    ];
    return err({ code: "schema_rejected", stage: "ajv", issues, audit: schemaRejectedSignal("ajv", issues) });
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
    return err(
      rawContent
        ? { code: "raw_content_present", issues }
        : { code: "schema_rejected", stage: "zod", issues, audit: schemaRejectedSignal("zod", issues) },
    );
  }

  const projection: GclProjection = parsed.data;

  // (3) §5 visibility predicate — the source-default ceiling + the projectionType
  // derivation (task 24.18), each an independent gate + workspace pin.
  const decision = validateProjectionVisibility(projection, sourceWorkspace, taxonomy);
  if (!isAllow(decision)) {
    return err(
      denialToGateError(decision.reason, decision.message, projection, sourceWorkspace, decision.audit),
    );
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
 * `audit` (task 24.33) is OPTIONAL and threaded straight into the three
 * policy-decision variants when the caller has one (`admitProjection` always does —
 * `decision.audit` is mandatory on `PolicyDecision`) — the exhaustive unit tests below
 * call this directly without a 5th arg and are unaffected (no `audit` key on the result).
 */
export function denialToGateError(
  reason: DenialReason,
  message: string,
  projection: GclProjection,
  sourceWorkspace: Workspace,
  audit?: AuditSignal,
): GclGateError {
  switch (reason) {
    case "VISIBILITY_EXCEEDS_SOURCE":
      return {
        code: "visibility_exceeds_source",
        declaredLevel: projection.visibilityLevel,
        sourceDefault: sourceWorkspace.defaultVisibility,
        message,
        ...(audit !== undefined ? { audit } : {}),
      };
    case "VISIBILITY_TYPE_MISMATCH":
      return {
        code: "visibility_type_mismatch",
        declaredLevel: projection.visibilityLevel,
        projectionType: projection.projectionType,
        message,
        ...(audit !== undefined ? { audit } : {}),
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
      return { code: "malformed_policy_input", message, ...(audit !== undefined ? { audit } : {}) };
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
  return err(denialToCrossWorkspaceRawDenial(decision.reason, decision.message));
}

/**
 * Map a §5 `DenialReason` to this guard's `CrossWorkspaceRawDenial` (task
 * 24.38 / L134, fourth instance this round — the prior form was an un-guarded
 * single `===` check + trailing return that silently absorbed the other 14
 * members into `malformed_policy_input`). EXHAUSTIVE over all 15
 * `DenialReason` members, terminated with the same `assertNever`-style guard
 * as `denialToGateError` above (task 24.36's landed pattern, this same file).
 * `denyDirectCrossWorkspaceRaw` can genuinely only ever emit 2 of the 15
 * (`DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL`/`MALFORMED_POLICY_INPUT`); the other
 * 13 are grouped under one fail-closed `malformed_policy_input` mapping
 * (matching `FAIL_CLOSED_DENIAL`'s own designation), each its OWN explicit
 * case, not a `default:` catch-all. Exported so every member is directly
 * unit-testable, not only the 2 reachable through a real call.
 */
export function denialToCrossWorkspaceRawDenial(
  reason: DenialReason,
  message: string,
): CrossWorkspaceRawDenial {
  switch (reason) {
    case "DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL":
      return { code: "direct_cross_workspace_raw_denied", message };
    case "MALFORMED_POLICY_INPUT":
    case "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED":
    case "UNTRUSTED_CONTENT_MUTATING_TOOL":
    case "WRITE_ADAPTER_OUTSIDE_GATEWAY":
    case "PROVIDER_NOT_ALLOWED":
    case "NO_ROUTE_FOR_CAPABILITY":
    case "PROCESSOR_NOT_ALLOWED":
    case "LOCAL_ENDPOINT_NOT_CONFIGURED":
    case "NON_LOOPBACK_LOCAL_TREATED_AS_EGRESS":
    case "VISIBILITY_EXCEEDS_SOURCE":
    case "VISIBILITY_TYPE_MISMATCH":
    case "APPROVAL_REQUIRED":
    case "AUTH_TOKEN_INVALID":
    case "ORIGIN_NOT_ALLOWED":
      return { code: "malformed_policy_input", message };
    default: {
      // A new DenialReason member reaches here as a non-`never` type → tsc
      // error, forcing a deliberate mapping decision above (mirrors
      // denialToGateError / defaultSeverityForFailureClass). Never a
      // `default:` that silently absorbs a real reason.
      const _exhaustive: never = reason;
      void _exhaustive;
      return { code: "malformed_policy_input", message };
    }
  }
}
