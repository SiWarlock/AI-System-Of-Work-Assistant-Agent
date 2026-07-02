// @sow/worker — the SINGLE structured-logger chokepoint (task 10.1, §16 / §10 /
// safety rule 7). `createLogger(sink)` returns a logger whose ONLY emit path runs
// the @sow/domain redactor (redactRecord / redactError) FIRST, then produces a
// @sow/contracts `LogRecord` and hands it to the sink. There is NO code path to the
// sink that bypasses redaction: the sink is captured in the closure and is never
// exposed; every level method funnels through the one private `emit`.
//
// SELF-CONTAINED: exports a factory the worker composition root mounts. It does NOT
// wire itself into the worker bootstrap. No I/O of its own (the sink owns the
// actual write); pure funnel + redaction. §16: never throws across the boundary —
// a thrown Error handed to `errorFrom` is redacted, not propagated.
import { logRecordSchema } from "@sow/contracts";
import type { LogRecord, LogLevel } from "@sow/contracts";
import { redactRecord, redactError } from "@sow/domain";

/**
 * The sink a logger writes REDACTED records to. It only ever receives a
 * fully-redacted, schema-valid `LogRecord` — never raw fields, never a raw Error.
 */
export type LogSink = (record: LogRecord) => void;

/**
 * The structured metadata a caller may attach to a log line. The §16 traceability
 * keys are lifted onto the record top-level (each re-screened defensively); `fields`
 * is the structured payload that goes through the field-level allowlist classifier.
 * Every value here is treated as UNTRUSTED and redacted before it reaches the sink.
 */
export interface LogMeta {
  readonly correlationId?: string;
  readonly workflowRunId?: string;
  readonly workspaceId?: string;
  readonly fields?: Record<string, unknown>;
  /** Caller-supplied ISO-8601 timestamp (no clock in this pure funnel). */
  readonly ts?: string;
}

/** The logger surface. Every method redacts BEFORE the sink; there is no raw path. */
export interface Logger {
  debug(event: string, meta?: LogMeta): void;
  info(event: string, meta?: LogMeta): void;
  warn(event: string, meta?: LogMeta): void;
  error(event: string, meta?: LogMeta): void;
  /**
   * Log a thrown value at `error` level with its message/stack/cause redacted to a
   * log-safe projection (closes the unlogged-egress gap). The redacted error lands
   * under allowlisted, non-content field names (`errorMessage`, `errorStack`,
   * `code`) so it survives the field classifier.
   */
  errorFrom(event: string, err: unknown, meta?: LogMeta): void;
}

// `errorMessage` / `errorStack` are added to the allowlist-safe surface here by
// pre-scrubbing them via redactError (their VALUES are already redaction-safe when
// they reach the record); they are NOT credential/raw shaped after redaction.
const ERROR_MESSAGE_KEY = "errorMessage";
const ERROR_STACK_KEY = "errorStack";
const CAUSE_CODE_KEY = "code";

/**
 * Build the single logger over `sink`. The sink is captured privately; the ONLY way
 * to reach it is `emit`, which redacts first. Pure factory (no I/O, no clock).
 */
export function createLogger(sink: LogSink): Logger {
  // The one-and-only path to the sink. Redacts meta.fields via the domain field
  // classifier, lifts the (defensively re-screened) traceability keys, validates
  // the assembled record against the frozen schema, and only then calls the sink.
  const emit = (
    level: LogLevel,
    event: string,
    meta: LogMeta | undefined,
    extraFields: Record<string, unknown> | undefined,
  ): void => {
    const mergedRawFields: Record<string, unknown> = {
      ...(meta?.fields ?? {}),
      ...(extraFields ?? {}),
    };
    const redactedFields = redactRecord(mergedRawFields);

    // The traceability keys are allowlisted; wrap each in a one-key redactRecord so
    // a credential-shaped id is scrubbed rather than passed through verbatim.
    const record: LogRecord = { level, event };
    if (meta?.correlationId !== undefined) {
      record.correlationId = coerceId(
        redactRecord({ correlationId: meta.correlationId })["correlationId"],
      );
    }
    if (meta?.workflowRunId !== undefined) {
      record.workflowRunId = coerceId(
        redactRecord({ workflowRunId: meta.workflowRunId })["workflowRunId"],
      );
    }
    if (meta?.workspaceId !== undefined) {
      record.workspaceId = coerceId(
        redactRecord({ workspaceId: meta.workspaceId })["workspaceId"],
      );
    }
    if (meta?.ts !== undefined) record.ts = meta.ts;
    if (Object.keys(redactedFields).length > 0) record.fields = redactedFields;

    // Defence in depth: only emit a record the frozen schema accepts. If assembly
    // somehow produced a non-conforming record, drop to a minimal safe record
    // rather than throw across the boundary (§16) or leak.
    const parsed = logRecordSchema.safeParse(record);
    sink(parsed.success ? parsed.data : { level, event });
  };

  return {
    debug: (event, meta) => emit("debug", event, meta, undefined),
    info: (event, meta) => emit("info", event, meta, undefined),
    warn: (event, meta) => emit("warn", event, meta, undefined),
    error: (event, meta) => emit("error", event, meta, undefined),
    errorFrom: (event, err, meta) => {
      const red = redactError(err);
      const extra: Record<string, unknown> = {
        [ERROR_MESSAGE_KEY]: red.message,
      };
      if (red.stack !== undefined) extra[ERROR_STACK_KEY] = red.stack;
      if (red.causeCode !== undefined) extra[CAUSE_CODE_KEY] = red.causeCode;
      emit("error", event, meta, extra);
    },
  };
}

/**
 * Coerce a classifier output back to the `string | undefined` a traceability slot
 * expects. A redacted id is a string (marker); a dropped/non-string is omitted so
 * the schema's `.min(1)` optional-string constraint is never violated.
 */
function coerceId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
