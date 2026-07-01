// TDD (red-first) for src/health/health-signal.ts (§16 OBS-2). Pure, clock-free
// builders that emit a GatewayHealthSignal whose failureClass is a real
// FailureClass member, whose message is redaction-safe, and whose dedupe key is
// stable per (class, subject).
import { describe, it, expect } from "vitest";
import { FailureClass } from "@sow/contracts";
import {
  CONNECTOR_UNREACHABLE_HEALTH_CLASS,
  WRITE_THROUGH_BLOCKED_HEALTH_CLASS,
  SCHEMA_REJECTION_HEALTH_CLASS,
  buildConnectorHealthSignal,
  buildToolWriteHealthSignal,
  healthDedupeKey,
} from "../src/health/health-signal";
import { isGatewayLogSafe } from "../src/redaction/gateway-log-redaction";

const isFailureClass = (c: string): boolean =>
  (FailureClass as readonly string[]).includes(c);

describe("health-class constants", () => {
  it("are all valid FailureClass members", () => {
    expect(isFailureClass(CONNECTOR_UNREACHABLE_HEALTH_CLASS)).toBe(true);
    expect(isFailureClass(WRITE_THROUGH_BLOCKED_HEALTH_CLASS)).toBe(true);
    expect(isFailureClass(SCHEMA_REJECTION_HEALTH_CLASS)).toBe(true);
  });

  it("map to the expected enum values", () => {
    expect(CONNECTOR_UNREACHABLE_HEALTH_CLASS).toBe("connector_unreachable");
    expect(WRITE_THROUGH_BLOCKED_HEALTH_CLASS).toBe("write_through_failed");
    expect(SCHEMA_REJECTION_HEALTH_CLASS).toBe("schema_rejection");
  });
});

describe("buildConnectorHealthSignal", () => {
  it("emits connector_unreachable with a redaction-safe message + subjectRef", () => {
    const sig = buildConnectorHealthSignal({
      connectorId: "todoist",
      workspaceId: "employer-work",
      reason: "3 attempts exhausted",
    });
    expect(sig.failureClass).toBe("connector_unreachable");
    expect(isFailureClass(sig.failureClass)).toBe(true);
    expect(sig.subjectRef).toContain("todoist");
    expect(isGatewayLogSafe(sig.message)).toBe(true);
    expect(sig.refs).toContain("employer-work");
  });

  it("scrubs a credential that leaks into the reason", () => {
    const sig = buildConnectorHealthSignal({
      connectorId: "github",
      workspaceId: "personal-business",
      reason: "401 for gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    });
    expect(isGatewayLogSafe(sig.message)).toBe(true);
    expect(sig.message).not.toContain("gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  });
});

describe("buildToolWriteHealthSignal", () => {
  it("emits write_through_failed for a blocked outbox drain", () => {
    const sig = buildToolWriteHealthSignal({
      subjectRef: "cok_drive_abc",
      reason: "outbox drain blocked; target unreachable",
      kind: "write_through_failed",
    });
    expect(sig.failureClass).toBe("write_through_failed");
    expect(isFailureClass(sig.failureClass)).toBe(true);
    expect(sig.subjectRef).toBe("cok_drive_abc");
    expect(isGatewayLogSafe(sig.message)).toBe(true);
  });

  it("emits schema_rejection for a candidate-gate failure", () => {
    const sig = buildToolWriteHealthSignal({
      subjectRef: "action_42",
      reason: "envelope failed the candidate gate",
      kind: "schema_rejection",
    });
    expect(sig.failureClass).toBe("schema_rejection");
    expect(isFailureClass(sig.failureClass)).toBe(true);
  });
});

describe("healthDedupeKey", () => {
  it("is stable per (failureClass, subjectRef)", () => {
    const a = buildToolWriteHealthSignal({
      subjectRef: "cok_x",
      reason: "reason one",
      kind: "write_through_failed",
    });
    const b = buildToolWriteHealthSignal({
      subjectRef: "cok_x",
      reason: "a totally different reason",
      kind: "write_through_failed",
    });
    // Same class + subject → same dedupe key regardless of message.
    expect(healthDedupeKey(a)).toBe(healthDedupeKey(b));
    expect(healthDedupeKey(a)).toBe("write_through_failed|cok_x");
  });

  it("differs when the subject differs", () => {
    const a = buildToolWriteHealthSignal({
      subjectRef: "cok_x",
      reason: "r",
      kind: "write_through_failed",
    });
    const b = buildToolWriteHealthSignal({
      subjectRef: "cok_y",
      reason: "r",
      kind: "write_through_failed",
    });
    expect(healthDedupeKey(a)).not.toBe(healthDedupeKey(b));
  });

  it("differs when the class differs for the same subject", () => {
    const a = buildToolWriteHealthSignal({
      subjectRef: "s",
      reason: "r",
      kind: "write_through_failed",
    });
    const b = buildToolWriteHealthSignal({
      subjectRef: "s",
      reason: "r",
      kind: "schema_rejection",
    });
    expect(healthDedupeKey(a)).not.toBe(healthDedupeKey(b));
  });
});
