// TDD (red-first) for src/redaction/gateway-log-redaction.ts (§16). Mirrors the
// provider-boundary redaction: scrub credential-shaped substrings, DROP whole
// raw-content fields (fetched connector content, raw write payloads, response
// bodies), and prove a content hash is judged SAFE (not a credential).
import { describe, it, expect } from "vitest";
import {
  REDACTED,
  DROPPED_FIELD,
  isGatewayLogSafe,
  redactString,
  buildSafeConnectorLog,
  buildSafeToolWriteLog,
} from "../src/redaction/gateway-log-redaction";

describe("isGatewayLogSafe", () => {
  it("passes a plain diagnostic + a sha256 content hash", () => {
    expect(isGatewayLogSafe("connector todoist unreachable after 3 attempts")).toBe(true);
    expect(isGatewayLogSafe("sha256:deadbeefcafe")).toBe(true);
    expect(isGatewayLogSafe("payloadHash sha256:0123abcd matched receipt")).toBe(true);
  });

  it("flags credential-shaped strings + URL basic-auth", () => {
    expect(isGatewayLogSafe("sk-live_ABCDEFGHIJKL")).toBe(false);
    expect(isGatewayLogSafe("-----BEGIN PRIVATE KEY-----")).toBe(false);
    expect(isGatewayLogSafe("https://user:secretpw@drive.example.com/x")).toBe(false);
    expect(isGatewayLogSafe("the api_key was rotated")).toBe(false);
  });
});

describe("redactString", () => {
  it("scrubs an inline API key but keeps surrounding text", () => {
    const out = redactString("auth failed for token gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 now");
    expect(out).toContain("auth failed for token");
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(isGatewayLogSafe(out)).toBe(true);
  });

  it("scrubs a PEM block", () => {
    const pem = "before -----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBg\n-----END PRIVATE KEY----- after";
    const out = redactString(pem);
    expect(out).not.toContain("MIIBVAIBADANBg");
    expect(out).toContain(REDACTED);
    expect(isGatewayLogSafe(out)).toBe(true);
  });

  it("scrubs URL basic-auth userinfo while preserving the host", () => {
    const out = redactString("GET //alice:hunter2@linear.app/api/issues");
    expect(out).toContain("linear.app");
    expect(out).not.toContain("hunter2");
    expect(isGatewayLogSafe(out)).toBe(true);
  });

  it("drops a field whose residual still trips the safety net", () => {
    // A raw secret keyword with no recognized token shape can't be scrubbed inline.
    expect(redactString("db password is correcthorsebatterystaple")).toBe(DROPPED_FIELD);
  });

  it("leaves a sha256 content hash untouched (not a credential)", () => {
    expect(redactString("sha256:deadbeef")).toBe("sha256:deadbeef");
  });
});

describe("buildSafeConnectorLog", () => {
  it("carries only IDs + status + scrubbed diagnostic; raw content field is ABSENT", () => {
    const safe = buildSafeConnectorLog({
      connectorId: "todoist",
      workspaceId: "employer-work",
      status: "connector_unreachable",
      diagnostic: "read failed near cursor cur_42",
      rawContent: "SECRET fetched task body: buy milk; call Bob",
    });
    expect(safe.connectorId).toBe("todoist");
    expect(safe.workspaceId).toBe("employer-work");
    expect(safe.status).toBe("connector_unreachable");
    expect(safe.diagnostic).toBe("read failed near cursor cur_42");
    // Raw fetched content must NOT survive structurally.
    expect("rawContent" in safe).toBe(false);
    expect(JSON.stringify(safe)).not.toContain("buy milk");
  });

  it("scrubs a credential that leaked into the diagnostic", () => {
    const safe = buildSafeConnectorLog({
      connectorId: "github",
      status: "connector_unreachable",
      diagnostic: "401 for gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    });
    expect(safe.diagnostic).toBeDefined();
    expect(isGatewayLogSafe(safe.diagnostic as string)).toBe(true);
    expect(JSON.stringify(safe)).not.toContain("gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  });
});

describe("buildSafeToolWriteLog", () => {
  it("carries only keys + status; raw write payload + response body are ABSENT", () => {
    const safe = buildSafeToolWriteLog({
      targetSystem: "drive",
      canonicalObjectKey: "cok_drive_abc123",
      idempotencyKey: "idem_def456",
      status: "receipt_recorded",
      diagnostic: "matched existing object; reused receipt",
      rawPayload: { title: "Q3 plan", body: "confidential employer content" },
      responseBody: '{"fileId":"1a2b","secret":"x"}',
    });
    expect(safe.targetSystem).toBe("drive");
    expect(safe.canonicalObjectKey).toBe("cok_drive_abc123");
    expect(safe.idempotencyKey).toBe("idem_def456");
    expect(safe.status).toBe("receipt_recorded");
    expect(safe.diagnostic).toBe("matched existing object; reused receipt");
    expect("rawPayload" in safe).toBe(false);
    expect("responseBody" in safe).toBe(false);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("confidential employer content");
    expect(serialized).not.toContain("Q3 plan");
  });
});
