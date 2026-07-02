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

  it("the only exported surface is a factory over a sink — the sink type takes a LogRecord", () => {
    // createLogger requires a sink; there is no exported raw-emit or sink accessor
    // that could be called with an un-redacted record.
    expect(typeof createLogger).toBe("function");
    expect(createLogger.length).toBe(1);
  });
});
