// spec(§16, §10, safety rule 7) — the SINGLE structured-logger chokepoint (10.1).
//
// createLogger(sink) returns a logger whose ONLY emit path runs the domain
// redactor FIRST, producing a @sow/contracts LogRecord. There is NO code path to
// the sink that bypasses redaction: a raw prompt, a raw Employer-Work field, a
// credential in a field value, and a secret carried by a thrown Error are all
// scrubbed BEFORE the record reaches the sink — even at debug level.
import { describe, it, expect } from "vitest";
import {
  REDACTED_CREDENTIAL,
  REDACTED_RAW,
  REDACTED_FIELD,
  logRecordSchema,
} from "@sow/contracts";
import type { LogRecord } from "@sow/contracts";
import { createLogger } from "../../src/observability/logger";

function capture(): { sink: (r: LogRecord) => void; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { sink: (r) => records.push(r), records };
}

describe("createLogger — the redaction chokepoint", () => {
  it("emits a schema-valid LogRecord with the frozen traceability keys", () => {
    const { sink, records } = capture();
    const log = createLogger(sink);
    log.info("workflow.status", {
      correlationId: "corr-1",
      workflowRunId: "wf-9",
      workspaceId: "employer-work",
      fields: { status: "completed" },
    });
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.level).toBe("info");
    expect(rec.event).toBe("workflow.status");
    expect(rec.correlationId).toBe("corr-1");
    // the emitted record must validate against the frozen contract schema
    expect(logRecordSchema.safeParse(rec).success).toBe(true);
  });

  it("scrubs a credential in a field VALUE before it reaches the sink", () => {
    const { sink, records } = capture();
    const log = createLogger(sink);
    log.error("provider.failed", {
      fields: { status: "sk-Abc123Def456Ghi789Jkl" },
    });
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain("sk-Abc123Def456Ghi789Jkl");
    expect(serialized).toContain(REDACTED_CREDENTIAL);
  });

  it("DROPS a non-allowlisted field to REDACTED_FIELD before the sink (allowlist fail-safe)", () => {
    const { sink, records } = capture();
    const log = createLogger(sink);
    log.info("x", { fields: { mysteryUnknownField: "some value" } });
    const emitted = records[0]!.fields as Record<string, unknown>;
    expect(emitted["mysteryUnknownField"]).toBe(REDACTED_FIELD);
  });

  it("drops a raw prompt / raw Employer-Work field even at DEBUG level (§5)", () => {
    const { sink, records } = capture();
    const log = createLogger(sink);
    log.debug("agent.dispatch", {
      fields: {
        rawContent: "Confidential employer roadmap Q3 headcount and revenue plan for the org",
      },
    });
    const emitted = records[0]!.fields as Record<string, unknown>;
    expect(emitted["rawContent"]).not.toContain("headcount");
    expect(
      emitted["rawContent"] === REDACTED_RAW ||
        emitted["rawContent"] === REDACTED_FIELD,
    ).toBe(true);
  });

  it("drops a SHORT single-line raw value under an allowlisted field before the sink (positive-shape)", () => {
    // adversarial-verify: a short single-line raw Employer-Work sentence (§5) or
    // free-form diagnostic (rule 7) must NOT reach the sink verbatim — the prior
    // length/multiline heuristic passed it through. The chokepoint stays fail-safe.
    const { sink, records } = capture();
    const log = createLogger(sink);
    log.info("agent.dispatch", {
      fields: { status: "acquire ACME for 1.2B keep it quiet", code: "db refused connection" },
    });
    const f = records[0]!.fields as Record<string, unknown>;
    expect(f["status"]).toBe(REDACTED_RAW);
    expect(f["code"]).toBe(REDACTED_RAW);
    expect(JSON.stringify(records[0])).not.toContain("ACME");
  });

  it("still passes bounded structured tokens through the field allowlist (no over-redaction)", () => {
    const { sink, records } = capture();
    const log = createLogger(sink);
    log.info("workflow.status", {
      fields: {
        status: "completed",
        code: "REVISION_STALE",
        event: "workflow.status",
        durationMs: 42,
        retryable: true,
      },
    });
    const f = records[0]!.fields as Record<string, unknown>;
    expect(f["status"]).toBe("completed");
    expect(f["code"]).toBe("REVISION_STALE");
    expect(f["event"]).toBe("workflow.status");
    expect(f["durationMs"]).toBe(42);
    expect(f["retryable"]).toBe(true);
  });

  it("redacts a secret carried by a thrown Error (message/stack/cause) before the record", () => {
    const { sink, records } = capture();
    const log = createLogger(sink);
    const inner = new Error("db token sk_live_0123456789abcdefghij");
    const e = new Error("write failed key sk-Abc123Def456Ghi789Jkl", { cause: inner });
    e.stack = "Error: write failed\n  at h (password=hunter2:1:1)";
    log.errorFrom("worker.crash", e, { correlationId: "corr-2" });
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain("sk-Abc123Def456Ghi789Jkl");
    expect(serialized).not.toContain("sk_live_0123456789abcdefghij");
    expect(serialized).not.toContain("hunter2");
    expect(records[0]!.correlationId).toBe("corr-2");
    expect(records[0]!.level).toBe("error");
  });

  it("exposes only a typed cause .code from an error, never the raw cause object", () => {
    const { sink, records } = capture();
    const log = createLogger(sink);
    const e = new Error("stale", {
      cause: { code: "REVISION_STALE", secretDetail: "sk-Abc123Def456Ghi789Jkl" },
    });
    log.errorFrom("kw.reject", e);
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain("sk-Abc123Def456Ghi789Jkl");
    expect(serialized).not.toContain("secretDetail");
    expect(serialized).toContain("REVISION_STALE");
  });

  it("every emit path (debug/info/warn/error/errorFrom) passes through redaction — no bypass", () => {
    const { sink, records } = capture();
    const log = createLogger(sink);
    const bad = { fields: { leaked: "sk-Abc123Def456Ghi789Jkl" } };
    log.debug("e", bad);
    log.info("e", bad);
    log.warn("e", bad);
    log.error("e", bad);
    log.errorFrom("e", new Error("sk-Abc123Def456Ghi789Jkl"));
    expect(records).toHaveLength(5);
    for (const rec of records) {
      expect(JSON.stringify(rec)).not.toContain("sk-Abc123Def456Ghi789Jkl");
      // and every emitted record is a valid LogRecord
      expect(logRecordSchema.safeParse(rec).success).toBe(true);
    }
  });

  it("drops a whitespace-free raw value (codename / OTP / opaque token) before the sink (per-field type gate)", () => {
    // independent re-verify: the prior SYNTACTIC token-shape gate passed any
    // whitespace-free `[A-Za-z0-9_:.+-]` token. A single-word employer codename, a
    // numeric OTP string, and an opaque base64url token are all whitespace-free but
    // NOT frozen-enum members under these fields → must be redacted at the chokepoint.
    const { sink, records } = capture();
    const log = createLogger(sink);
    log.info("agent.dispatch", {
      fields: {
        status: "ACME", // raw employer codename
        code: "824193", // numeric OTP string
        kind: "dGhpcyImcyBhc2VjcmV0", // opaque base64url token
      },
    });
    const f = records[0]!.fields as Record<string, unknown>;
    expect(f["status"]).toBe(REDACTED_RAW);
    expect(f["code"]).toBe(REDACTED_RAW);
    expect(f["kind"]).toBe(REDACTED_RAW);
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain("ACME");
    expect(serialized).not.toContain("824193");
    expect(serialized).not.toContain("dGhpcyImcyBhc2VjcmV0");
  });

  it("passes real frozen-enum members + ids + numbers through, but not bare words", () => {
    const { sink, records } = capture();
    const log = createLogger(sink);
    log.info("workflow.status", {
      correlationId: "corr-9",
      fields: {
        level: "info",
        failureClass: "connector_unreachable",
        state: "open",
        event: "workflow.status",
        provider: "claude",
        count: 42,
      },
    });
    const f = records[0]!.fields as Record<string, unknown>;
    expect(f["level"]).toBe("info");
    expect(f["failureClass"]).toBe("connector_unreachable");
    expect(f["state"]).toBe("open");
    expect(f["event"]).toBe("workflow.status");
    expect(f["provider"]).toBe("claude");
    expect(f["count"]).toBe(42);
    expect(records[0]!.correlationId).toBe("corr-9");
  });

  it("does not surface a bare-word cause .code from an error (ACME is not a structured code)", () => {
    const { sink, records } = capture();
    const log = createLogger(sink);
    log.errorFrom("kw.reject", new Error("stale", { cause: { code: "ACME" } }));
    const f = records[0]!.fields as Record<string, unknown>;
    expect(f["code"]).toBeUndefined();
    expect(JSON.stringify(records[0])).not.toContain("ACME");
  });

  it("the only exported surface is a factory over a sink — the sink type takes a LogRecord", () => {
    // createLogger requires a sink; there is no exported raw-emit or sink accessor
    // that could be called with an un-redacted record.
    expect(typeof createLogger).toBe("function");
    expect(createLogger.length).toBe(1);
  });
});
