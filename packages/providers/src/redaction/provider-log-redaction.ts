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
// GENERALIZED (task 10.1): the credential-shape DETECTORS + scrub PATTERNS now live
// once in the pure @sow/domain redactor (`redaction-rules.ts`); this module imports
// them instead of keeping a second copy. Only the provider-boundary MARKERS
// (`REDACTED` / `DROPPED_FIELD`) and the provider-specific record shape
// (`buildSafeProviderLog`) remain local — the detector logic is single-sourced.
//
// PURE + DETERMINISTIC: no clock, no I/O, no throw across a boundary. A field
// that cannot be made safe is DROPPED (fail-safe), never logged raw.

import {
  looksUnsafe,
  PEM_BLOCK,
  URL_USERINFO_SEGMENT,
  CREDENTIAL_TOKEN,
} from "@sow/domain";
import type { AgentLogEntry } from "../ports/agent-result";

// --- placeholders -----------------------------------------------------------

/** Replaces an in-line credential-shaped substring inside an otherwise-safe string. */
export const REDACTED = "[REDACTED]" as const;

/**
 * Replaces a WHOLE field that could not be made redaction-safe (e.g. a diagnostic
 * that still trips a sensitive-keyword or an unrecognized credential shape after
 * scrubbing). Fail-safe: the field is dropped rather than emitted raw. Chosen so
 * it is itself redaction-safe (no credential prefix / sensitive keyword / userinfo).
 * Value equals the frozen `@sow/contracts` REDACTED_FIELD marker.
 */
export const DROPPED_FIELD = "[REDACTED:field-dropped]" as const;

/**
 * True iff the string carries no credential-shaped substring and no raw-content /
 * secret marker — i.e. it is safe to emit to a log sink verbatim. Delegates to the
 * single-sourced domain detector. Pure.
 */
export function isProviderLogSafe(value: string): boolean {
  return !looksUnsafe(value);
}

// --- scrubbing --------------------------------------------------------------

/**
 * Scrub credential-shaped substrings from a diagnostic string. Recognized shapes
 * (API-key tokens, PEM blocks, URL basic-auth) are replaced with `REDACTED`,
 * preserving the surrounding non-sensitive text. If the result STILL trips the
 * safety net (an unrecognized credential shape or a residual sensitive keyword
 * such as `password`/`secret`), the whole field is UNREDACTABLE and is dropped to
 * `DROPPED_FIELD` — never emitted raw. Idempotent + pure. Uses the single-sourced
 * @sow/domain patterns + detector; keeps the provider-boundary MARKERS local.
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
