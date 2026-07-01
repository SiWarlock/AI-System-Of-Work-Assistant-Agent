// @sow/providers — provider-boundary log redaction (task 5.6, §16).
//
// The MANDATORY redaction layer the ModelProviderPort/AgentRuntimePort adapters
// (5.7/5.8) + the Broker run over EVERY diagnostic BEFORE it reaches a log sink.
// It strips credential-shaped strings (API keys, PEM blocks, URL basic-auth) and
// DROPS raw-content fields (provider prompts, raw Employer-Work content,
// `AgentResult.logs` that stay unsafe) so a raw prompt or secret never lands in a
// log. Prompts/raw payloads are never emitted at default level; only
// correlation/workflow-run IDs + a typed status + credential-scrubbed diagnostic
// lines survive (`buildSafeProviderLog`).
//
// Mirrors the @sow/policy redaction approach (audit-signal `isRedactionSafe`: the
// credential-prefix / sensitive-keyword / URL-userinfo patterns) rather than
// importing it — policy's `isRedactionSafe` operates on an `AuditSignal` shape,
// whereas the provider boundary scrubs arbitrary diagnostic strings + log lines.
//
// PURE + DETERMINISTIC: no clock, no I/O, no throw across a boundary. A field
// that cannot be made safe is DROPPED (fail-safe), never logged raw.

import type { AgentLogEntry } from "../ports/agent-result";

// --- placeholders -----------------------------------------------------------

/** Replaces an in-line credential-shaped substring inside an otherwise-safe string. */
export const REDACTED = "[REDACTED]" as const;

/**
 * Replaces a WHOLE field that could not be made redaction-safe (e.g. a diagnostic
 * that still trips a sensitive-keyword or an unrecognized credential shape after
 * scrubbing). Fail-safe: the field is dropped rather than emitted raw. Chosen so
 * it is itself redaction-safe (no credential prefix / sensitive keyword / userinfo).
 */
export const DROPPED_FIELD = "[REDACTED:field-dropped]" as const;

// --- detection (mirrors @sow/policy audit-signal) ---------------------------

// Credential-shaped prefixes (provider API keys, cloud creds, PEM blocks, JWTs).
// A content hash such as "sha256:deadbeef" does NOT match any of these.
const CREDENTIAL_PREFIX =
  /(sk-[a-z0-9]|sk_(live|test)|xox[baprs]-|gh[pousr]_|AKIA[0-9A-Z]{16}|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\.)/i;

// Sensitive keywords that indicate a raw-content / secret leak. Deliberately omits
// "token" so a structured status code (e.g. AUTH_TOKEN_INVALID) is not a false hit.
const SENSITIVE_KEYWORD =
  /\b(pass(word|wd)|secret|api[_-]?key|bearer|credential|private[_ -]?key|passphrase)\b/i;

// A URL userinfo credential (`scheme://user:pass@host` or `//user:pass@host`).
const URL_USERINFO_CREDENTIAL = /\/\/[^/\s:@]+:[^/\s@]+@/;

function looksUnsafe(s: string): boolean {
  return (
    CREDENTIAL_PREFIX.test(s) ||
    SENSITIVE_KEYWORD.test(s) ||
    URL_USERINFO_CREDENTIAL.test(s)
  );
}

/**
 * True iff the string carries no credential-shaped substring and no raw-content /
 * secret marker — i.e. it is safe to emit to a log sink verbatim. Pure.
 */
export function isProviderLogSafe(value: string): boolean {
  return !looksUnsafe(value);
}

// --- scrubbing --------------------------------------------------------------

// A full PEM block (BEGIN … END). Matched (and removed) first so the residual
// key material never survives; the surrounding CREDENTIAL_PREFIX `-----BEGIN`
// check then guards a truncated/BEGIN-only block via the fail-safe drop.
const PEM_BLOCK = /-----BEGIN[\s\S]*?-----END[^-]*-----/g;

// A URL basic-auth `user:pass@` segment — the credential portion is replaced,
// the host is preserved for diagnostics.
const URL_USERINFO_SEGMENT = /(\/\/)[^/\s:@]+:[^/\s@]+@/g;

// Recognized credential TOKENS (the concrete shapes CREDENTIAL_PREFIX detects).
// Replacing the whole token with a placeholder both scrubs the secret and clears
// the prefix so the scrubbed result is redaction-safe.
const CREDENTIAL_TOKEN =
  /(sk-[A-Za-z0-9][A-Za-z0-9_-]{6,}|sk_(?:live|test)_[A-Za-z0-9]{6,}|xox[baprs]-[A-Za-z0-9-]{6,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+)?)/g;

/**
 * Scrub credential-shaped substrings from a diagnostic string. Recognized shapes
 * (API-key tokens, PEM blocks, URL basic-auth) are replaced with `REDACTED`,
 * preserving the surrounding non-sensitive text. If the result STILL trips the
 * safety net (an unrecognized credential shape or a residual sensitive keyword
 * such as `password`/`secret`), the whole field is UNREDACTABLE and is dropped to
 * `DROPPED_FIELD` — never emitted raw. Idempotent + pure.
 */
export function redactString(value: string): string {
  const scrubbed = value
    .replace(PEM_BLOCK, REDACTED)
    .replace(URL_USERINFO_SEGMENT, `$1${REDACTED}@`)
    .replace(CREDENTIAL_TOKEN, REDACTED);
  if (looksUnsafe(scrubbed)) return DROPPED_FIELD;
  return scrubbed;
}

// --- log entries ------------------------------------------------------------

/**
 * Redact one isolated diagnostic line: the message is credential-scrubbed (or
 * dropped if unredactable); `level` + `timestampMs` are structured non-content
 * fields and pass through unchanged. Pure.
 */
export function redactLogEntry(entry: AgentLogEntry): AgentLogEntry {
  return {
    level: entry.level,
    message: redactString(entry.message),
    ...(entry.timestampMs !== undefined ? { timestampMs: entry.timestampMs } : {}),
  };
}

/** Redact every entry in a log array. Pure; returns a fresh array. */
export function redactLogs(
  logs: readonly AgentLogEntry[],
): readonly AgentLogEntry[] {
  return logs.map(redactLogEntry);
}

// --- default-level record ---------------------------------------------------

/**
 * The candidate fields an adapter/Broker might want to log at the provider
 * boundary. `prompt` / `rawContent` / `response` are RAW payloads — they are
 * NEVER emitted at default level and never reach the output record. `logs` are
 * isolated diagnostic lines (credential-scrubbed). The IDs + status are the only
 * default-level surface.
 */
export interface ProviderLogFields {
  readonly correlationId?: string;
  readonly workflowRunId?: string;
  readonly providerId?: string;
  readonly status?: string;
  readonly logs?: readonly AgentLogEntry[];
  /** Raw provider prompt — dropped, never logged at default level. */
  readonly prompt?: string;
  /** Raw (e.g. Employer-Work) content — dropped, never logged at default level. */
  readonly rawContent?: string;
  /** Raw provider response — dropped, never logged at default level. */
  readonly response?: unknown;
}

/**
 * The redacted record safe to hand a default-level log sink: correlation /
 * workflow-run IDs + a typed status + credential-scrubbed diagnostic lines ONLY.
 * Raw prompt/content/response fields are structurally absent.
 */
export interface SafeProviderLog {
  readonly correlationId?: string;
  readonly workflowRunId?: string;
  readonly providerId?: string;
  readonly status?: string;
  readonly logs: readonly AgentLogEntry[];
}

/**
 * Build the default-level provider-boundary log record. Drops raw payloads
 * (prompt/rawContent/response) entirely; carries only IDs + typed status +
 * redacted logs. IDs/status/providerId are themselves run through `redactString`
 * defensively (a malformed id that looks credential-shaped is scrubbed/dropped,
 * never passed through). Optional fields absent on the input are omitted. Pure.
 */
export function buildSafeProviderLog(
  fields: ProviderLogFields,
): SafeProviderLog {
  return {
    ...(fields.correlationId !== undefined
      ? { correlationId: redactString(fields.correlationId) }
      : {}),
    ...(fields.workflowRunId !== undefined
      ? { workflowRunId: redactString(fields.workflowRunId) }
      : {}),
    ...(fields.providerId !== undefined
      ? { providerId: redactString(fields.providerId) }
      : {}),
    ...(fields.status !== undefined ? { status: redactString(fields.status) } : {}),
    logs: fields.logs !== undefined ? redactLogs(fields.logs) : [],
  };
}
