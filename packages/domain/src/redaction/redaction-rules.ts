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

// ⛔ THE SUBSTITUTE MATTERS, AND A SPACE WAS THE WRONG ONE (task 24.120).
// `URL_USERINFO_CREDENTIAL`'s second character class is `[^/\s@]+` — it admits a
// marker's own characters (`[`, `]`, `:`) and excludes WHITESPACE. So a marker
// landing inside a `//user:pass@host` span BROKE the span and the value stopped
// being refused: `//user:REALSECRET[REDACTED:raw]@host` was classified SAFE while
// carrying a real surviving secret.
//
// It is exactly ONE of the three nets, for a structural reason worth keeping:
// every `CREDENTIAL_PREFIX` alternative is a contiguous literal/class run that
// admits no `[`, so a marker inside it already breaks the match with or without
// substitution; `SENSITIVE_KEYWORD` is `\b`-delimited and a space, a `]` and a `^`
// are all non-word, so its verdict never changes. `URL_USERINFO_CREDENTIAL` is the
// only net whose class admits a marker's alphabet while excluding the substitute.
//
// ⭐ REQUIREMENT ON ANY FILLER, and it is checked rather than remembered: the
// filler must behave as ONE OPAQUE TOKEN — it must never match where an opaque
// token would not. `test/redaction/marker-filler-property.test.ts` derives that
// from the live patterns (`P1'` substitution + `P1''` insertion). `-`, `_` and `.`
// FAIL it (they are members of a pattern's alphabet and would BRIDGE two fragments
// into a match); deleting the marker outright fails it too, and so does a space —
// the incumbent is itself a member of `private[_ -]?key`'s alphabet.
export const SPAN_PRESERVING_FILLER = "^";

// The historical substitute. RETAINED AS A SECOND ARM below, not replaced: on its
// own it is the defect above, but removing it would ADMIT values that are refused
// today (`private[REDACTED:raw]key`), and whether those matches are real
// detections or artefacts the space manufactures is UNMEASURED. Task 24.120 ruled
// `(C')` rather than decide it; the availability candidate lives on `### 24.123`.
const LEGACY_SPACE_FILLER = " ";

function stripMarkers(s: string, filler: string): string {
  let out = s;
  for (const m of MARKER_LITERALS) out = out.split(m).join(filler);
  return out;
}

// ── credential-shape detection (mirrors the prior provider copy) ─────────────

// Credential-shaped prefixes (provider API keys, cloud creds, PEM blocks, JWTs).
// A content hash such as "sha256:deadbeef" does NOT match any of these.
//
// task 24.124 — the leading `sk-[a-z0-9]` alternative gained a `\b` word
// boundary. Unbounded, it matched "sk-" as a substring ANYWHERE, so any word
// ending in "sk" followed by `-` and an alphanumeric tripped this net:
// `TASK-1`, `RISK-001`, `Full-Disk-Access` (pre-existing lowercase-only, then
// widened to every casing by task 24.110's `/i` fix — measured there at 9
// newly-rejected of 612 Markdown files atop 236 already-rejected, and pinned
// deliberately in `packages/policy/test/audit-signal.test.ts`'s
// `known_false_positives_are_pinned_so_the_class_is_not_INVISIBLE`, whose own
// comment named "a word boundary" as the durable remedy).
//
// ⚠ THE TRADE, MEASURED (task 24.124, `test/redaction/credential-prefix-word-
// boundary.test.ts`): AVAILABILITY improves (fewer benign values refused) at a
// real, non-zero LEAK-direction cost — a credential token glued DIRECTLY onto a
// preceding word character with no separator (`keysk-liveABC...`) is no longer
// caught by THIS alternative. Measured over this repo's own tracked Markdown
// corpus (668 files / 93,160 lines): the OLD (unbounded) predicate refused 1279
// lines end-to-end (all three credential nets); the NEW predicate refuses 1044;
// 235 lines are newly admitted, every sampled one ordinary prose, none a
// credential shape. Accepted: every OTHER credential-shape alternative here
// (xox/gh_/AKIA/-----BEGIN/eyJ) is unaffected — only the two-character,
// no-distinctive-charset `sk-` alternative had this failure mode, and a real
// leaked secret overwhelmingly appears after a delimiter (`=`, `:`, whitespace,
// or line start), not glued to a preceding word.
//
// PRODUCER-FIRST: this is the canonical copy. `packages/policy`'s
// independently-maintained copy (task 24.110's (C') union did not replace it)
// gets the identical fix in the same commit round — never the copy alone.
export const CREDENTIAL_PREFIX =
  /(\bsk-[a-z0-9]|sk_(live|test)|xox[baprs]-|gh[pousr]_|AKIA[0-9A-Z]{16}|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\.)/i;

// Sensitive keywords that indicate a raw-content / secret leak. Deliberately omits
// "token" so a structured status code (e.g. AUTH_TOKEN_INVALID) is not a false hit.
export const SENSITIVE_KEYWORD =
  /\b(pass(word|wd)|secret|api[_-]?key|bearer|credential|private[_ -]?key|passphrase)\b/i;

// A URL userinfo credential (`scheme://user:pass@host` or `//user:pass@host`).
export const URL_USERINFO_CREDENTIAL = /\/\/[^/\s:@]+:[^/\s@]+@/;

// The nets `looksUnsafe` consults, as ONE list rather than three hardcoded calls.
// WHY IT IS A LIST (task 24.120): the marker-neutralization property guard
// REFLECTS OVER THIS ARRAY rather than naming nets individually. With three
// hardcoded `.test()` calls a fourth net could be added and the guard would never
// see it — so the guard could go stale, which is the one thing it exists not to
// do. Adding a net here adds its guard cases automatically.
//
// ⛔ FROZEN DELIBERATELY, AND IT IS A RULE-7 CONCERN, NOT TIDINESS. An exported
// mutable array hands every importer of `@sow/domain` a handle on this predicate's
// contents: a `push`/`splice`/reassign would silently disable a credential net
// while `looksUnsafe` kept returning `false` and every test stayed green. That
// exposure is created by the list shape itself and does not exist for the three
// hardcoded calls it replaces. Pinned by `the net list cannot be mutated`.
//
// ⛔ EVERY NET HERE MUST BE NON-GLOBAL. `.test()` on a `/g` regex advances
// `lastIndex` and alternates true/false across calls, which would make this
// predicate call-count-dependent and fail INTERMITTENTLY. The list shape makes
// adding a net feel trivial, so this is enforced by a pin (`every net is
// non-global`) rather than left to this comment.
//
// ⭐ THE TWO CONTROLS INTERLOCK, AND NEITHER IS SUFFICIENT ALONE: the FREEZE closes
// the ARRAY (nothing can be added, removed or replaced), the non-global pin closes
// the ELEMENTS (nothing already in it carries call-to-call state). A frozen array
// of stateful regexes is still an intermittently-wrong predicate; a list of
// stateless regexes that any importer can empty is still a disabled one.
export const CREDENTIAL_NETS: readonly RegExp[] = Object.freeze([
  CREDENTIAL_PREFIX,
  SENSITIVE_KEYWORD,
  URL_USERINFO_CREDENTIAL,
]);

/**
 * True iff the string trips a credential/secret detector — i.e. it is NOT safe to
 * emit verbatim. The scrubbing net in `redact.ts` re-checks against this after a
 * scrub pass and fail-safe drops the whole field when it still trips. Pure.
 */
export function looksUnsafe(s: string): boolean {
  // TWO ARMS, and they are DELIBERATELY NOT SYMMETRIC — writing them as one loop
  // over a filler list would hide the asymmetry that decides where the guard binds:
  //
  //   * the SPAN-PRESERVING arm can return SAFE where the legacy arm returned
  //     UNSAFE, so it is the arm that can ADMIT. It is alphabet-guarded.
  //   * the LEGACY SPACE arm is FAIL-SAFE: a space can only ever manufacture EXTRA
  //     refusals (it is in `private[_ -]?key`'s alphabet), never admit. An arm that
  //     cannot return SAFE where an opaque token would not needs no alphabet guard.
  //
  // Their disjunction refuses a SUPERSET of the pre-24.120 predicate for every
  // input — monotone BY CONSTRUCTION, not by corpus measurement — so this change
  // cannot admit anything that was refused before.
  const spanPreserving = stripMarkers(s, SPAN_PRESERVING_FILLER);
  const legacy = stripMarkers(s, LEGACY_SPACE_FILLER);
  return (
    CREDENTIAL_NETS.some((net) => net.test(spanPreserving)) ||
    CREDENTIAL_NETS.some((net) => net.test(legacy))
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
/**
 * The per-field frozen vocabularies. ONE TABLE rather than a `switch`, and the
 * reason is task 24.132 rather than tidiness: `hasFieldVocabulary` below must
 * answer "does this key have a vocabulary at all?", and a hand-written second
 * list answering that would be A SECOND HAND-MAINTAINED SET GUARDING THE FIRST —
 * `### 24.133`'s class exactly, where a parity guard is only as wide as its
 * hand-kept fixture list. Both functions now read THIS table, so they cannot
 * disagree about which keys are covered.
 *
 * ⛔ ORDER IS LOAD-BEARING AND IS PRESERVED FROM THE `switch` THIS REPLACES: a key
 * with a dedicated vocabulary is validated by it EVEN WHEN its name ends in
 * `Id`/`Ref`. `providerId` is a fixed categorical enum, NOT a system-generated id;
 * if the id-named rule ran first, the `Id` suffix would silently defeat the enum
 * and let a raw codename / OTP / opaque token pass under `providerId`.
 */
const FIELD_VOCABULARY: ReadonlyMap<string, (value: string) => boolean> = new Map([
  ["level", (v: string): boolean => inEnum(LOG_LEVEL_SET, v)],
  ["failureClass", (v: string): boolean => inEnum(FAILURE_CLASS_SET, v)],
  ["state", (v: string): boolean => inEnum(HEALTH_STATE_SET, v)],
  ["status", (v: string): boolean => inEnum(KNOWN_STATUS, v)],
  ["kind", (v: string): boolean => inEnum(KNOWN_KIND, v)],
  ["event", (v: string): boolean => inEnum(KNOWN_EVENT, v) || EVENT_NAME_TOKEN.test(v)],
  // a stable cause/status code: known structured UPPER_SNAKE, an EventName-style
  // token, or a known enum member — never a bare word or an OTP.
  [
    "code",
    (v: string): boolean =>
      STRUCTURED_CODE.test(v) || inEnum(FAILURE_CLASS_SET, v) || inEnum(KNOWN_STATUS, v),
  ],
  ["provider", (v: string): boolean => inEnum(PROVIDER_ID_SET, v)],
  ["providerId", (v: string): boolean => inEnum(PROVIDER_ID_SET, v)],
  ["targetSystem", (v: string): boolean => inEnum(TARGET_SYSTEM_SET, v)],
  ["transport", (v: string): boolean => v === "http"],
  // Capability is an OPEN branded id upstream; accept only a dotted/snake token
  // (e.g. `meeting.close`), never a bare raw word.
  ["capability", (v: string): boolean => EVENT_NAME_TOKEN.test(v)],
]);

/**
 * True iff `key` has ANY vocabulary `isSafeFieldValue` can judge it against — a
 * dedicated validator, the id-named rule, or the timestamp rule.
 *
 * ⛔ WHY THIS EXISTS, AND IT IS A RULE-5/7 CONCERN (task 24.132): for a key with NO
 * vocabulary, `isSafeFieldValue` returns `false` for EVERY possible value, so
 * enforcing it there would not tighten anything — it would delete the field. This
 * predicate is what lets `redactAllowlistedValue` enforce the type gate exactly
 * where the gate can actually judge, instead of choosing between "enforce nowhere"
 * and "delete diagnostics."
 *
 * ⭐ DERIVED, NOT DECLARED: it reads `FIELD_VOCABULARY` and the same two predicates
 * `isSafeFieldValue` reads. There is no second list to keep in sync — a field that
 * gains or loses a vocabulary changes both answers in the same edit, by
 * construction. A comment saying "keep these in sync" would not have been enough.
 */
export function hasFieldVocabulary(key: string): boolean {
  return FIELD_VOCABULARY.has(key) || isIdNamedKey(key) || isTimestampKey(key);
}

export function isSafeFieldValue(key: string, value: string): boolean {
  if (value.length === 0 || value.length > SAFE_TOKEN_MAX_LEN) return false;
  // (c) per-field frozen vocabulary FIRST — see the ORDER note on FIELD_VOCABULARY.
  const validator = FIELD_VOCABULARY.get(key);
  if (validator !== undefined) return validator(value);
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
