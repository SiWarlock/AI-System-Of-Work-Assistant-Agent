// LogRecord contract test (plan task 10.1, contract portion — §16/§10). RED-first.
// Pins the frozen LogLevel membership + the exact three redaction-marker strings
// (the stable substitution vocabulary the redactor emits before any sink), then
// exercises logRecordSchema accept/reject. NOT an Appendix-A seam model — no
// JSON-Schema registry ceremony (no emitJsonSchema / fieldSet / freezeGenerated).
// PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import {
  LogLevel,
  logLevelSchema,
  logRecordSchema,
  REDACTED_CREDENTIAL,
  REDACTED_RAW,
  REDACTED_FIELD,
} from "../../src/observability/log-record";

// A minimal valid record: only the two required fields.
const minimal = {
  level: "info",
  event: "workflow.status",
} as const;

// A fully-populated record: every optional traceability key + already-redacted
// structured fields carrying a marker value.
const full = {
  level: "error",
  event: "external_write.rejected",
  correlationId: "corr-abc123",
  workflowRunId: "wfr-000777",
  workspaceId: "employer-work",
  fields: { credential: REDACTED_CREDENTIAL, note: "budget breach", attempts: 3 },
  ts: "2026-06-30T12:00:00.000Z",
};

describe("LogRecord contract — spec(§16/§10)", () => {
  // ── Frozen LogLevel membership (the 4-value ordered set) ────────────────────
  it("pins the four LogLevel members in order", () => {
    expect(LogLevel).toEqual(["debug", "info", "warn", "error"]);
  });

  it("accepts every LogLevel member via logLevelSchema", () => {
    for (const lvl of LogLevel) {
      expect(logLevelSchema.safeParse(lvl).success, `level ${lvl} should parse`).toBe(true);
    }
  });

  it("rejects a level outside the frozen set via logLevelSchema", () => {
    expect(logLevelSchema.safeParse("trace").success).toBe(false);
  });

  // ── Frozen redaction-marker vocabulary (exact strings; downstream asserts on these) ─
  it("pins the exact three redaction-marker strings", () => {
    expect(REDACTED_CREDENTIAL).toBe("[REDACTED:credential]");
    expect(REDACTED_RAW).toBe("[REDACTED:raw]");
    expect(REDACTED_FIELD).toBe("[REDACTED:field-dropped]");
  });

  // ── logRecordSchema behaviors ───────────────────────────────────────────────
  it("accepts a minimal record ({level, event})", () => {
    expect(logRecordSchema.safeParse(minimal).success).toBe(true);
  });

  it("accepts a fully-populated record (all traceability keys + redacted fields)", () => {
    expect(logRecordSchema.safeParse(full).success).toBe(true);
  });

  it("rejects an unknown level", () => {
    expect(logRecordSchema.safeParse({ ...minimal, level: "verbose" }).success).toBe(false);
  });

  it("rejects a missing required field (event)", () => {
    const { event: _omit, ...noEvent } = minimal;
    expect(logRecordSchema.safeParse(noEvent).success).toBe(false);
  });

  it("rejects a missing required field (level)", () => {
    const { level: _omit, ...noLevel } = minimal;
    expect(logRecordSchema.safeParse(noLevel).success).toBe(false);
  });
});
