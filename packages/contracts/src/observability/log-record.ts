// LogRecord — the structured-log record type (plan task 10.1, contract portion,
// §16 traceability / §10 API). This is what the mandatory redaction layer emits
// for every structured log line, BEFORE it reaches any sink. This file freezes
// only the record TYPE + the marker vocabulary that both the worker's logger sink
// and the §10 API layer reference; the ACTUAL redaction classifier/allowlist and
// the single-chokepoint logger sink are domain/worker (task 10.1 impl, built
// later). PURE — no app/adapter imports; only zod.
//
// This is NOT an Appendix-A seam model: no JSON-Schema registry ceremony, no
// `*_SCHEMA_ID`, no field-set snapshot. The focused Zod schema below is for
// runtime validation at the §10 API boundary only.
import { z } from "zod";

// ── LogLevel (const tuple + z.enum + inferred type — shared-enums pattern) ──────
// The frozen four-value severity ladder. Const tuple is the single source of the
// literal set; the union type is inferred from the schema.
export const LogLevel = ["debug", "info", "warn", "error"] as const;
export const logLevelSchema = z.enum(LogLevel);
export type LogLevel = z.infer<typeof logLevelSchema>;

// ── Redaction markers (stable substitution vocabulary) ──────────────────────────
// The redactor substitutes these fixed markers so downstream parsing + tests can
// assert on log SHAPE without ever seeing a secret or raw content. Stable strings
// — never localize, never reformat (a change is a cross-layer breaking change for
// every log consumer + test that matches on them).
//   REDACTED_CREDENTIAL — a resolved secret / credential value was removed (REQ-S-007).
//   REDACTED_RAW        — raw imported/untrusted content was removed.
//   REDACTED_FIELD      — an entire non-allowlisted field was dropped (not just its value).
export const REDACTED_CREDENTIAL = "[REDACTED:credential]" as const;
export const REDACTED_RAW = "[REDACTED:raw]" as const;
export const REDACTED_FIELD = "[REDACTED:field-dropped]" as const;

// ── LogRecord ───────────────────────────────────────────────────────────────────
// Explicit interface = the exported TS type; `logRecordSchema` below is annotated
// `z.ZodType<LogRecord>` so the two can never silently drift (a mismatch is a
// compile error). No branded fields here, so the single-type-arg annotation
// suffices (input === output).
export interface LogRecord {
  level: LogLevel;
  // The stable event/log-point name (e.g. "workflow.status"). Open string — the
  // §10 event catalog is a distinct closed union; log events are a superset.
  event: string;
  // §16 traceability keys — correlate a line to a request/job and its workflow run.
  correlationId?: string;
  workflowRunId?: string;
  // The workspace the line belongs to (drives workspace-scoped log routing/filtering).
  workspaceId?: string;
  // Structured, ALREADY-REDACTED key/values — never raw content, never secrets.
  // The redactor has already substituted the markers above / dropped fields before
  // a value lands here; this type does not (and cannot) re-enforce that at runtime.
  fields?: Record<string, unknown>;
  // ISO-8601 datetime the line was produced (caller-supplied; no clock in contracts).
  ts?: string;
}

export const logRecordSchema: z.ZodType<LogRecord> = z
  .object({
    level: logLevelSchema,
    event: z.string().min(1),
    correlationId: z.string().min(1).optional(),
    workflowRunId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    ts: z.string().datetime().optional(),
  })
  .strict();
