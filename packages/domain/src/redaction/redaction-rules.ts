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

// ── raw-content-shape detection ──────────────────────────────────────────────
// A prompt or a raw Employer-Work body is not credential-shaped but is still
// forbidden in a log. It is recognized STRUCTURALLY (key-name independent, like the
// GCL raw-content gate): any multi-line string, or any string longer than the
// over-length threshold, is treated as raw content and dropped whole. This is the
// last line of defence so an unrecognized long payload can never survive.

/** A value at/over this length is treated as raw content (dropped whole). */
export const RAW_CONTENT_MAX_LEN = 512;

/** True iff a string looks like raw content (multi-line or over-length). Pure. */
export function looksLikeRawContent(s: string): boolean {
  return s.includes("\n") || s.length > RAW_CONTENT_MAX_LEN;
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
