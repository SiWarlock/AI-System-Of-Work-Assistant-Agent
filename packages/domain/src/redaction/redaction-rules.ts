// @sow/domain — the CANONICAL pure redaction classifier (task 10.1, §16 / safety
// rule 7). This is the single source of truth for "is this string / field / value
// safe to log" — the credential-shape detectors, the raw-content-shape detectors,
// and the known-safe field-name ALLOWLIST. `packages/providers` and the worker's
// logger both depend on THIS module rather than keeping their own copies.
//
// The credential-shape detectors were factored here from
// `packages/providers/src/redaction/provider-log-redaction.ts` (the prior local
// copy) and EXTENDED with (a) raw-content-shape detection (multi-line / over-length
// values that indicate a prompt or raw Employer-Work body) and (b) the field-name
// allowlist that drives the fail-safe field classifier in `redact.ts`.
//
// PURE + DETERMINISTIC: no clock, no I/O, no throw across a boundary, no mutable
// module state. Every predicate is total over its input.
import {
  REDACTED_CREDENTIAL,
  REDACTED_RAW,
  REDACTED_FIELD,
  // Frozen enum arrays — the ACTUAL literal vocabularies a diagnostic field value is
  // validated against by TYPE. A value is emitted un-redacted ONLY when it is a
  // provable member of the frozen enum appropriate to its field (rule c), never
  // because it merely LOOKS structured. Imported as arrays (not regex-approximated)
  // so the gate can never drift from the contract.
  LogLevel,
  EventName,
  FailureClass,
  HealthState,
  ApprovalStatus,
  RemediationState,
  ProvenanceOrigin,
  FactKind,
  TargetSystem,
  ProviderId,
  GbrainAllowedOp,
} from "@sow/contracts";

// ── frozen-marker neutralization ─────────────────────────────────────────────
// The frozen substitution markers are safe by CONSTRUCTION, but one of them
// (`[REDACTED:credential]`) contains the literal word "credential", which the
// SENSITIVE_KEYWORD net below would otherwise flag — causing an already-scrubbed
// string to be needlessly dropped whole (and breaking idempotency). So the safety
// net strips the known markers before testing. This is the ONLY place markers are
// special-cased; they never re-introduce a real secret.
const MARKER_LITERALS: readonly string[] = [
  REDACTED_CREDENTIAL,
  REDACTED_RAW,
  REDACTED_FIELD,
];

function stripMarkers(s: string): string {
  let out = s;
  for (const m of MARKER_LITERALS) out = out.split(m).join(" ");
  return out;
}

// ── credential-shape detection (mirrors the prior provider copy) ─────────────

// Credential-shaped prefixes (provider API keys, cloud creds, PEM blocks, JWTs).
// A content hash such as "sha256:deadbeef" does NOT match any of these.
export const CREDENTIAL_PREFIX =
  /(sk-[a-z0-9]|sk_(live|test)|xox[baprs]-|gh[pousr]_|AKIA[0-9A-Z]{16}|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\.)/i;

// Sensitive keywords that indicate a raw-content / secret leak. Deliberately omits
// "token" so a structured status code (e.g. AUTH_TOKEN_INVALID) is not a false hit.
export const SENSITIVE_KEYWORD =
  /\b(pass(word|wd)|secret|api[_-]?key|bearer|credential|private[_ -]?key|passphrase)\b/i;

// A URL userinfo credential (`scheme://user:pass@host` or `//user:pass@host`).
export const URL_USERINFO_CREDENTIAL = /\/\/[^/\s:@]+:[^/\s@]+@/;

/**
 * True iff the string trips a credential/secret detector — i.e. it is NOT safe to
 * emit verbatim. The scrubbing net in `redact.ts` re-checks against this after a
 * scrub pass and fail-safe drops the whole field when it still trips. Pure.
 */
export function looksUnsafe(s: string): boolean {
  const probe = stripMarkers(s);
  return (
    CREDENTIAL_PREFIX.test(probe) ||
    SENSITIVE_KEYWORD.test(probe) ||
    URL_USERINFO_CREDENTIAL.test(probe)
  );
}

// ── scrub patterns (global, for in-line substitution) ────────────────────────

// A full PEM block (BEGIN … END). Matched (and removed) first so residual key
// material never survives; a truncated/BEGIN-only block is caught by the
// `CREDENTIAL_PREFIX` `-----BEGIN` net → fail-safe drop.
export const PEM_BLOCK = /-----BEGIN[\s\S]*?-----END[^-]*-----/g;

// A URL basic-auth `user:pass@` segment — the credential portion is replaced, the
// host is preserved for diagnostics.
export const URL_USERINFO_SEGMENT = /(\/\/)[^/\s:@]+:[^/\s@]+@/g;

// Recognized credential TOKENS (the concrete shapes CREDENTIAL_PREFIX detects).
// Replacing the whole token with a marker both scrubs the secret and clears the
// prefix so the scrubbed result is redaction-safe.
export const CREDENTIAL_TOKEN =
  /(sk-[A-Za-z0-9][A-Za-z0-9_-]{6,}|sk_(?:live|test)_[A-Za-z0-9]{6,}|xox[baprs]-[A-Za-z0-9-]{6,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+)?)/g;

// ── raw-content classification — PER-FIELD TYPE / VOCABULARY gate ────────────
// A prompt or a raw Employer-Work body is not credential-shaped but is still
// forbidden in a log. Two prior designs were both REFUTED by independent re-verify:
//   (v0) a NEGATIVE length/multiline heuristic (`includes("\n") || length > 512`)
//        let a SHORT single-line raw sentence through; and
//   (v1) a SYNTACTIC token-shape gate (`/^[A-Za-z0-9_:.+-]+$/`, len<=128) let ANY
//        WHITESPACE-FREE raw token through — shape alone cannot tell `ACME` (raw
//        employer codename) from `todoist` (safe enum), `824193` (OTP) from a count,
//        or an opaque base64url session token from a system id.
//
// The correct gate validates by TYPE, per field. A string value under an allowlisted
// field is emitted UN-redacted ONLY when it is PROVABLY safe by type (§10.1 fail-safe
// default REDACT):
//   (a) a number / boolean / null value passes (handled in redact.ts by typeof);
//   (b) an ISO-8601 timestamp string passes under a timestamp-typed field (ts/*At);
//   (c) a string that is a MEMBER of the KNOWN FROZEN ENUM appropriate to its field
//       passes — validated against the ACTUAL enum arrays, never a regex;
//   (d) an ID string under an ID-named key (correlationId/workflowRunId/workspaceId
//       and *Id / *Ref suffixes) passes if it matches a bounded id charset — ids are
//       §16-loggable and system-generated (never raw content);
//   (e) EVERYTHING ELSE — any other string, any value under an unrecognized key, any
//       free-form message / any whitespace-free token that is not a known enum member
//       and not an id-named field — is REDACTED. No generic bounded-token pass path
//       remains: shape never grants a pass on its own.

/**
 * Legacy over-length threshold, retained for the conformance corpus (which builds an
 * over-length body as `RAW_CONTENT_MAX_LEN + N`). A value at/over this length is
 * unambiguously raw. NOT the decision boundary — the decision is per-field TYPE.
 */
export const RAW_CONTENT_MAX_LEN = 512;

/**
 * Bounded cap for a single safe token (id or structured code). A system id / ISO-8601
 * timestamp / structured code is comfortably under this; anything longer is raw
 * regardless of shape. Deliberately well below RAW_CONTENT_MAX_LEN.
 */
export const SAFE_TOKEN_MAX_LEN = 128;

/**
 * The bounded ID charset. System-generated ids/refs (correlation/workflow-run/
 * workspace/plan/action ids) use a lower conservative charset: alphanumerics plus
 * `-` `_` `:` `.`. Whitespace-free + bounded. Only APPLIED under an id-named key.
 */
export const SAFE_STRUCTURED_TOKEN = /^[A-Za-z0-9_:.-]+$/;

/**
 * True iff `s` is a bounded, whitespace-free id token (the id-named-key charset).
 * This is NOT a general pass gate — it is applied ONLY to values under id-named keys
 * (rule d). A value passing this shape under a NON-id field is still REDACTED. Pure.
 */
export function isSafeStructuredToken(s: string): boolean {
  return s.length > 0 && s.length <= SAFE_TOKEN_MAX_LEN && SAFE_STRUCTURED_TOKEN.test(s);
}

// ── frozen-enum vocabularies (built from the ACTUAL @sow/contracts arrays) ────
// A diagnostic field value passes ONLY if it is a member of the frozen vocabulary
// for its field. Built by lower-casing membership into Sets so the check is O(1) and
// can never drift from the contract (arrays imported, not regex-approximated).
const asSet = (...groups: readonly (readonly string[])[]): ReadonlySet<string> =>
  new Set<string>(groups.flat());

// `status` — lifecycle / health / approval / remediation states. The §9 workflow
// state taxonomy is an OPEN string in the contract (WorkflowRunRef.state, arch_gap),
// so its terminal-lifecycle literals are enumerated here explicitly (the only bare
// words admitted, and only under `status`). Employer codenames are NOT members.
const LIFECYCLE_STATUS: readonly string[] = [
  "ok",
  "pending",
  "queued",
  "scheduled",
  "running",
  "started",
  "in_progress",
  "retrying",
  "succeeded",
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "skipped",
  "timed_out",
  "degraded",
  "healthy",
  "unhealthy",
];
const KNOWN_STATUS = asSet(
  LIFECYCLE_STATUS,
  HealthState, // open · acknowledged · resolved
  ApprovalStatus, // pending · approved · edited · rejected · deferred · expired
  RemediationState, // pending · materializing · materialized · purged · dismissed
);

// `kind` — categorical taxonomies. A `kind` value passes iff it is a member of a
// frozen kind vocabulary. `meeting_close` is a ProvenanceOrigin member.
const KNOWN_KIND = asSet(
  FactKind, // page · link · timeline · tag · frontmatter_value
  ProvenanceOrigin, // human · meeting_close · ingestion · gbrain_proposal · parity_remediation
  TargetSystem, // calendar · todoist · linear · asana · drive · github · telegram
  GbrainAllowedOp, // search · graph · timeline · schema_read · health · contained_synthesis
);

// `event` — the §10 push-stream event catalog (EventName) plus dotted event tokens
// from the same namespace (log events are a superset of the closed catalog).
const KNOWN_EVENT = asSet(EventName);

// A dotted / snake event-name token: lower-case segments joined by `.` or `_`, at
// least two segments (so a bare word like `acme` is NOT an event). e.g.
// `workflow.status`, `agent.dispatch`, `read_model.change`. Bounded, whitespace-free.
export const EVENT_NAME_TOKEN = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/;

// A structured cause/status CODE: UPPER_SNAKE with at least one underscore, e.g.
// `REVISION_STALE`, `AUTH_DENIED`. Requires ≥2 UPPER segments so a bare word like
// `ACME` (single segment) is NOT a code, and digits-only (`824193`) is not a code.
export const STRUCTURED_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

// ISO-8601 timestamp (date, or date-time with optional fractional seconds + zone).
// Only applied under timestamp-typed fields (ts / *At). Whitespace-free, bounded.
export const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;

/** Frozen membership helpers — validate against the ACTUAL enum arrays. Pure. */
const inEnum = (set: ReadonlySet<string>, v: string): boolean => set.has(v);

/**
 * The per-field decision: is string `value` under field `key` PROVABLY safe to emit
 * verbatim by TYPE? Returns false for every value that is not provably safe — the
 * caller then routes it to REDACTED_RAW (or the credential scrub runs first in
 * redact.ts). This is the single authority for rule (b)/(c)/(d). Pure + total.
 *
 * NOTE: credential-shape screening happens in `redact.ts` BEFORE this gate is
 * consulted, so a credential-shaped string is scrubbed to REDACTED_CREDENTIAL rather
 * than reaching here. This gate only decides enum/id/timestamp membership.
 */
export function isSafeFieldValue(key: string, value: string): boolean {
  if (value.length === 0 || value.length > SAFE_TOKEN_MAX_LEN) return false;
  // (c) per-field frozen vocabulary FIRST — a key that has a dedicated enum
  // validator uses it even when its NAME ends in `Id`/`Ref`. `providerId` is a
  // fixed categorical enum (ProviderId), NOT a system-generated id, so it must be
  // enum-validated: were the id-named short-circuit (d) allowed to run first, the
  // `Id` suffix would silently defeat this case and let a raw codename / OTP /
  // opaque token pass under `providerId` (redaction re-verify HIGH). A key WITHOUT
  // a dedicated case falls through to the generic id/timestamp rules below.
  switch (key) {
    case "level":
      return inEnum(LOG_LEVEL_SET, value);
    case "failureClass":
      return inEnum(FAILURE_CLASS_SET, value);
    case "state":
      return inEnum(HEALTH_STATE_SET, value);
    case "status":
      return inEnum(KNOWN_STATUS, value);
    case "kind":
      return inEnum(KNOWN_KIND, value);
    case "event":
      return inEnum(KNOWN_EVENT, value) || EVENT_NAME_TOKEN.test(value);
    case "code":
      // a stable cause/status code: known structured UPPER_SNAKE, an EventName-style
      // token, or a known enum member — never a bare word or an OTP.
      return (
        STRUCTURED_CODE.test(value) ||
        inEnum(FAILURE_CLASS_SET, value) ||
        inEnum(KNOWN_STATUS, value)
      );
    case "provider":
    case "providerId":
      return inEnum(PROVIDER_ID_SET, value);
    case "targetSystem":
      return inEnum(TARGET_SYSTEM_SET, value);
    case "transport":
      return value === "http";
    case "capability":
      // Capability is an OPEN branded id upstream; accept only a dotted/snake token
      // (e.g. `meeting.close`), never a bare raw word.
      return EVENT_NAME_TOKEN.test(value);
    default:
      break; // no dedicated vocabulary — fall to the generic id/timestamp rules.
  }
  // (d) id-named keys → bounded id charset (system-generated, §16-loggable).
  if (isIdNamedKey(key)) return isSafeStructuredToken(value);
  // (b) timestamp-typed keys → ISO-8601 only.
  if (isTimestampKey(key)) return ISO_8601.test(value);
  // Any other allowlisted key with a STRING value has no frozen vocabulary to
  // validate against → not provably safe → redact (fail-safe default).
  return false;
}

const LOG_LEVEL_SET = asSet(LogLevel);
const FAILURE_CLASS_SET = asSet(FailureClass);
const HEALTH_STATE_SET = asSet(HealthState);
const PROVIDER_ID_SET = asSet(ProviderId);
const TARGET_SYSTEM_SET = asSet(TargetSystem);

// ── field-name shape helpers (id-named / timestamp-named keys) ────────────────
// §16: correlation/workflow-run/workspace ids + any `*Id` / `*Ref` key names a
// system-generated identifier — never raw content — so those may pass on the id
// charset. Timestamp-named keys carry an ISO-8601 instant.
const EXPLICIT_ID_KEYS: ReadonlySet<string> = new Set<string>([
  "correlationId",
  "workflowRunId",
  "workspaceId",
  "runId",
  "jobId",
  "planId",
  "actionId",
  "approvalId",
  "revisionId",
  "factIdentity",
  "sourceId",
  "reportId",
  "idempotencyKey",
]);

/** True iff `key` names a system-generated id/ref (id charset applies). Pure. */
export function isIdNamedKey(key: string): boolean {
  if (EXPLICIT_ID_KEYS.has(key)) return true;
  return /(?:Id|Ref)$/.test(key);
}

/** True iff `key` names a timestamp field (ISO-8601 value applies). Pure. */
export function isTimestampKey(key: string): boolean {
  return key === "ts" || /At$/.test(key);
}

/**
 * True iff a string must be treated as RAW content — the field-INDEPENDENT floor
 * used by `redactString`/`redactMessageLike` for message/stack strings that carry NO
 * field context. A message/stack is NEVER a known enum member (it is free-form prose
 * or an id at best), so the only strings this admits verbatim are bounded id-charset
 * tokens; everything else (any whitespace, over the cap, a sentence, an opaque token,
 * an OTP) is raw. Pure + total. Field-scoped values go through `isSafeFieldValue`.
 */
export function looksLikeRawContent(s: string): boolean {
  return !isSafeStructuredToken(s);
}

// ── field-name ALLOWLIST ─────────────────────────────────────────────────────
// The ONLY field names whose (scalar) values may be considered for pass-through.
// A DENYLIST is insufficient — an UNRECOGNIZED field must default to REDACTED, so
// this is the exhaustive allowlist of known-safe structured field names. Anything
// not in this set is dropped to `REDACTED_FIELD` by `redactRecord`, value unseen.
//
// These are the §16 traceability keys + typed, non-content status/diagnostic
// fields that are safe to carry in a structured log line. NONE of them is a prompt,
// a raw body, or a secret; a value under an allowlisted name is STILL re-screened
// for a credential/raw shape before pass-through (defence in depth).
export const SAFE_FIELD_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // structured container (LogRecord.fields) — recursed, not passed through
  "fields",
  // §16 traceability
  "correlationId",
  "workflowRunId",
  "workspaceId",
  "runId",
  "jobId",
  "planId",
  "actionId",
  "approvalId",
  "revisionId",
  "factIdentity",
  "sourceId",
  "reportId",
  "idempotencyKey",
  // typed, non-content diagnostics
  "event",
  "level",
  "status",
  "state", // HealthState / workflow-run state — validated by frozen-enum vocabulary
  "kind",
  "failureClass",
  "code", // stable cause code only (never a raw message)
  "errorMessage", // ALREADY redacted via redactError before it lands (re-screened)
  "errorStack", // ALREADY redacted via redactError before it lands (re-screened)
  "retryable",
  "provider",
  "providerId",
  "capability",
  "targetSystem",
  "transport",
  "durationMs",
  "attempt",
  "count",
  "ts",
  "timestampMs",
]);

/** True iff a field NAME is on the known-safe allowlist. Pure. */
export function isAllowlistedField(name: string): boolean {
  return SAFE_FIELD_ALLOWLIST.has(name);
}
