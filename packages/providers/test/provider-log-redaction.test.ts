// spec(§7) — provider-boundary log redaction (5.6 / §16): strip credential-shaped
// strings + raw-content fields before any log sink; fail safe by dropping the field.
import { describe, it, expect } from "vitest";
import type { AgentLogEntry } from "../src/ports/agent-result";
import {
  REDACTED,
  DROPPED_FIELD,
  redactString,
  isProviderLogSafe,
  redactLogEntry,
  redactLogs,
  buildSafeProviderLog,
} from "../src/redaction/provider-log-redaction";

describe("redactString — credential-shaped string scrubbing", () => {
  it("scrubs an OpenAI-style key and preserves surrounding diagnostic text", () => {
    const out = redactString("call failed with key sk-Abc123Def456Ghi789 at endpoint");
    expect(out).not.toContain("sk-Abc123Def456Ghi789");
    expect(out).toContain(REDACTED);
    expect(out).toContain("call failed");
    expect(out).toContain("endpoint");
  });

  it("scrubs Slack, GitHub, AWS, and JWT credential tokens", () => {
    for (const secret of [
      "xoxb-123456789012-abcdefghijkl",
      "ghp_0123456789abcdef0123456789abcdef0123",
      "AKIA0123456789ABCDEF",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SIGNpart",
    ]) {
      const out = redactString(`token=${secret} tail`);
      expect(out).not.toContain(secret);
      expect(isProviderLogSafe(out)).toBe(true);
    }
  });

  it("scrubs a full PEM private-key block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEArandombytes\n-----END RSA PRIVATE KEY-----";
    const out = redactString(`loaded ${pem} ok`);
    expect(out).not.toContain("MIIEowIBAAKCAQEArandombytes");
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(isProviderLogSafe(out)).toBe(true);
  });

  it("scrubs URL userinfo basic-auth credentials", () => {
    const out = redactString("connecting to https://alice:s3cr3tpw@host.local/api");
    expect(out).not.toContain("alice:s3cr3tpw@");
    expect(out).toContain("host.local");
    expect(isProviderLogSafe(out)).toBe(true);
  });

  it("returns a clean diagnostic string unchanged", () => {
    const clean = "route resolved: provider=claude capability=meeting.close status=completed";
    expect(redactString(clean)).toBe(clean);
  });

  it("output is always redaction-safe (invariant)", () => {
    for (const s of [
      "sk-Abc123Def456Ghi789",
      "password=hunter2",
      "bearer some-opaque-token-value",
      "-----BEGIN CERTIFICATE-----only-begin-no-end",
      "https://u:p@h/x",
      "totally clean",
    ]) {
      expect(isProviderLogSafe(redactString(s))).toBe(true);
    }
  });

  it("is idempotent", () => {
    const s = "call failed key sk-Abc123Def456Ghi789 and password=hunter2";
    const once = redactString(s);
    expect(redactString(once)).toBe(once);
  });
});

describe("isProviderLogSafe", () => {
  it("is true for clean text and false for credential/keyword/userinfo markers", () => {
    expect(isProviderLogSafe("provider=claude status=completed")).toBe(true);
    expect(isProviderLogSafe("here is sk-Abc123Def456Ghi789")).toBe(false);
    expect(isProviderLogSafe("the password is here")).toBe(false);
    expect(isProviderLogSafe("bearer abc")).toBe(false);
    expect(isProviderLogSafe("//user:pass@host")).toBe(false);
  });
});

describe("fail-safe field dropping", () => {
  it("drops (does not raw-log) a field that stays unsafe after scrubbing", () => {
    const out = redactString("db password=hunter2 rejected");
    expect(out).toBe(DROPPED_FIELD);
    expect(out).not.toContain("hunter2");
    expect(isProviderLogSafe(out)).toBe(true);
  });

  it("DROPPED_FIELD and REDACTED are themselves redaction-safe", () => {
    expect(isProviderLogSafe(DROPPED_FIELD)).toBe(true);
    expect(isProviderLogSafe(REDACTED)).toBe(true);
  });
});

describe("redactLogEntry / redactLogs", () => {
  it("scrubs the message and preserves level + timestamp", () => {
    const entry: AgentLogEntry = {
      level: "error",
      message: "auth failed with key sk-Abc123Def456Ghi789",
      timestampMs: 42,
    };
    const out = redactLogEntry(entry);
    expect(out.level).toBe("error");
    expect(out.timestampMs).toBe(42);
    expect(out.message).not.toContain("sk-Abc123Def456Ghi789");
    expect(isProviderLogSafe(out.message)).toBe(true);
  });

  it("drops the message of an unredactable log line rather than emitting raw", () => {
    const out = redactLogEntry({ level: "warn", message: "secret=topsecretvalue" });
    expect(out.message).toBe(DROPPED_FIELD);
    expect(out.message).not.toContain("topsecretvalue");
  });

  it("maps over every entry", () => {
    const logs: readonly AgentLogEntry[] = [
      { level: "info", message: "start" },
      { level: "error", message: "key sk-Abc123Def456Ghi789" },
    ];
    const out = redactLogs(logs);
    expect(out).toHaveLength(2);
    expect(out[0]?.message).toBe("start");
    expect(out[1]?.message).not.toContain("sk-Abc123Def456Ghi789");
  });
});

describe("buildSafeProviderLog — default-level record", () => {
  it("keeps only correlation/workflow IDs + typed status + redacted logs; drops raw payloads", () => {
    const rec = buildSafeProviderLog({
      correlationId: "corr-123",
      workflowRunId: "wf-run-999",
      providerId: "claude",
      status: "completed",
      prompt: "SYSTEM: you are... user secret sk-Abc123Def456Ghi789",
      rawContent: "raw Employer-Work meeting transcript body",
      response: { hidden: "sk-Abc123Def456Ghi789" },
      logs: [{ level: "info", message: "dispatched" }],
    });
    expect(rec.correlationId).toBe("corr-123");
    expect(rec.workflowRunId).toBe("wf-run-999");
    expect(rec.providerId).toBe("claude");
    expect(rec.status).toBe("completed");
    expect(rec.logs).toHaveLength(1);
    // no raw-payload keys leak onto the record
    expect(Object.keys(rec)).not.toContain("prompt");
    expect(Object.keys(rec)).not.toContain("rawContent");
    expect(Object.keys(rec)).not.toContain("response");
    // no substring of any raw payload survives anywhere in the serialized record
    const serialized = JSON.stringify(rec);
    expect(serialized).not.toContain("sk-Abc123Def456Ghi789");
    expect(serialized).not.toContain("meeting transcript body");
    expect(serialized).not.toContain("SYSTEM: you are");
  });

  it("omits absent optional fields and defaults logs to an empty array", () => {
    const rec = buildSafeProviderLog({ status: "cancelled" });
    expect(rec.status).toBe("cancelled");
    expect(rec.logs).toEqual([]);
    expect(Object.keys(rec)).not.toContain("correlationId");
    expect(Object.keys(rec)).not.toContain("workflowRunId");
    expect(Object.keys(rec)).not.toContain("providerId");
  });

  it("scrubs a credential-shaped id defensively rather than passing it through", () => {
    const rec = buildSafeProviderLog({ correlationId: "sk-Abc123Def456Ghi789" });
    expect(rec.correlationId).not.toContain("sk-Abc123Def456Ghi789");
  });
});
