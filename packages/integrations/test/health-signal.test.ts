// TDD (red-first) for src/health/health-signal.ts (§16 OBS-2). Pure, clock-free
// builders that emit a GatewayHealthSignal whose failureClass is a real
// FailureClass member, whose message is redaction-safe, and whose dedupe key is
// stable per (class, subject).
import { describe, it, expect } from "vitest";
import { FailureClass } from "@sow/contracts";
import {
  CONNECTOR_UNREACHABLE_HEALTH_CLASS,
  CONNECTOR_COVERAGE_DEGRADED_HEALTH_CLASS,
  WRITE_THROUGH_FAILED_HEALTH_CLASS,
  SCHEMA_REJECTION_HEALTH_CLASS,
  buildConnectorHealthSignal,
  buildConnectorCoverageDegradeSignal,
  buildToolWriteHealthSignal,
  healthDedupeKey,
} from "../src/health/health-signal";
import { isGatewayLogSafe } from "../src/redaction/gateway-log-redaction";

const isFailureClass = (c: string): boolean =>
  (FailureClass as readonly string[]).includes(c);

describe("health-class constants", () => {
  it("are all valid FailureClass members", () => {
    expect(isFailureClass(CONNECTOR_UNREACHABLE_HEALTH_CLASS)).toBe(true);
    expect(isFailureClass(CONNECTOR_COVERAGE_DEGRADED_HEALTH_CLASS)).toBe(true);
    expect(isFailureClass(WRITE_THROUGH_FAILED_HEALTH_CLASS)).toBe(true);
    expect(isFailureClass(SCHEMA_REJECTION_HEALTH_CLASS)).toBe(true);
  });

  it("map to the expected enum values", () => {
    expect(CONNECTOR_UNREACHABLE_HEALTH_CLASS).toBe("connector_unreachable");
    // arch_gap: no dedicated coverage-degrade member in the frozen enum — reuses
    // `sync_lagging` (the least-wrong "ingested set is behind full coverage").
    // FLAGGED as carry-forward.
    expect(CONNECTOR_COVERAGE_DEGRADED_HEALTH_CLASS).toBe("sync_lagging");
    expect(WRITE_THROUGH_FAILED_HEALTH_CLASS).toBe("write_through_failed");
    expect(SCHEMA_REJECTION_HEALTH_CLASS).toBe("schema_rejection");
  });
});

describe("buildConnectorCoverageDegradeSignal (16.4 · §8/§16)", () => {
  it("emits the coverage-degrade class with a redaction-safe message + connectorId subject + workspace ref", () => {
    const sig = buildConnectorCoverageDegradeSignal({
      connectorId: "drive",
      workspaceId: "employer-work",
      reason: "incompleteSearch: partial corpora coverage",
    });
    expect(sig.failureClass).toBe(CONNECTOR_COVERAGE_DEGRADED_HEALTH_CLASS);
    expect(isFailureClass(sig.failureClass)).toBe(true);
    expect(sig.subjectRef).toContain("drive");
    expect(isGatewayLogSafe(sig.message)).toBe(true);
    expect(sig.refs).toContain("employer-work");
  });

  it("routes the reason through redactString — a recognized credential shape is scrubbed (rule 7)", () => {
    // Proves the builder pipes `reason` through the mandatory gateway redaction (defense in
    // depth): a recognized credential TOKEN (here an `sk-` key) is replaced, so no secret
    // that leaked into the reason survives into the health message.
    const leaked = "sk-live0123456789ABCDEFxyz";
    const sig = buildConnectorCoverageDegradeSignal({
      connectorId: "drive",
      workspaceId: "personal-business",
      reason: `partial coverage; stray creds ${leaked}`,
    });
    expect(isGatewayLogSafe(sig.message)).toBe(true);
    expect(sig.message).not.toContain(leaked);
    expect(sig.message).toContain("[REDACTED]");
  });

  it("has a dedupe key stable per (coverage class, connectorId)", () => {
    const a = buildConnectorCoverageDegradeSignal({ connectorId: "drive", workspaceId: "ws-1", reason: "r1" });
    const b = buildConnectorCoverageDegradeSignal({ connectorId: "drive", workspaceId: "ws-2", reason: "different" });
    expect(healthDedupeKey(a)).toBe(healthDedupeKey(b));
    // Distinct from an UNREACHABLE signal for the same connector (different class).
    const unreachable = buildConnectorHealthSignal({ connectorId: "drive", workspaceId: "ws-1", reason: "down" });
    expect(healthDedupeKey(a)).not.toBe(healthDedupeKey(unreachable));
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

  // 24.21: the union previously collapsed a precondition HOLD (never attempted)
  // and an errored ATTEMPT into one `write_through_failed` member. These four
  // cases split them: two new kinds, a regression pin on the two originals, and
  // a dedupe-key split so a hold and a failed attempt on the same subject never
  // coalesce into one HealthItem.
  it("kind 'write_through_blocked' maps to write_through_blocked / severity warn (a precondition hold, not an errored attempt)", () => {
    const sig = buildToolWriteHealthSignal({
      subjectRef: "cok_drive_hold",
      reason: "write-through blocked by a precondition gate",
      kind: "write_through_blocked",
    });
    expect(sig.failureClass).toBe("write_through_blocked");
    expect(isFailureClass(sig.failureClass)).toBe(true);
    expect(sig.severity).toBe("warn");
  });

  it("kind 'outbox_blocked' maps to outbox_blocked / severity error (a gated outbox is operator-actionable)", () => {
    const sig = buildToolWriteHealthSignal({
      subjectRef: "outbox",
      reason: "outbox depth exceeds threshold",
      kind: "outbox_blocked",
    });
    expect(sig.failureClass).toBe("outbox_blocked");
    expect(isFailureClass(sig.failureClass)).toBe(true);
    expect(sig.severity).toBe("error");
  });

  it("REGRESSION PIN (both directions): 'write_through_failed' still maps write_through_failed/warn; 'schema_rejection' still maps schema_rejection/warn", () => {
    const failed = buildToolWriteHealthSignal({
      subjectRef: "cok_drive_abc",
      reason: "attempt errored",
      kind: "write_through_failed",
    });
    expect(failed.failureClass).toBe("write_through_failed");
    expect(failed.severity).toBe("warn");

    const rejected = buildToolWriteHealthSignal({
      subjectRef: "action_42",
      reason: "candidate gate rejected",
      kind: "schema_rejection",
    });
    expect(rejected.failureClass).toBe("schema_rejection");
    expect(rejected.severity).toBe("warn");
  });

  it("healthDedupeKey differs for a HOLD (write_through_blocked) vs an ERRORED ATTEMPT (write_through_failed) on the SAME subjectRef", () => {
    const hold = buildToolWriteHealthSignal({
      subjectRef: "cok_drive_same",
      reason: "held pending reconnect",
      kind: "write_through_blocked",
    });
    const failedAttempt = buildToolWriteHealthSignal({
      subjectRef: "cok_drive_same",
      reason: "attempt errored",
      kind: "write_through_failed",
    });
    expect(healthDedupeKey(hold)).not.toBe(healthDedupeKey(failedAttempt));
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
