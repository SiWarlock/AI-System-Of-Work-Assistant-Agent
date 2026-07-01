// spec(§5) — AuditSignal: clock-free build for allow+deny; redaction-safety guard; toAuditRecordInput passes AuditRecordSchema.parse
import { describe, it, expect } from "vitest";
import { AuditRecordSchema } from "@sow/contracts";
import {
  buildAuditSignal,
  toAuditRecordInput,
  isRedactionSafe,
  assertRedactionSafe,
  POLICY_DENIAL_HEALTH_CLASS,
  type AuditSignal,
} from "../src/audit-signal";

const base = {
  actor: "policy",
  event: "egress.evaluated",
  refs: ["ref:workspace:ws-1", "sha256:deadbeef"],
  payloadHash: "sha256:cafe",
  beforeSummary: "egress not evaluated",
  afterSummary: "egress allowed to local processor",
};

describe("buildAuditSignal", () => {
  it("produces a clock-free signal for an ALLOW outcome (no denialCode)", () => {
    const sig = buildAuditSignal(base);
    expect(sig.actor).toBe("policy");
    expect(sig.denialCode).toBeUndefined();
    expect("occurredAt" in sig).toBe(false);
    expect("recordedAt" in sig).toBe(false);
  });

  it("produces a signal for a DENY outcome carrying the denialCode + health class", () => {
    const sig = buildAuditSignal({
      ...base,
      event: "egress.denied",
      denialCode: "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED",
      healthSignalClass: POLICY_DENIAL_HEALTH_CLASS,
    });
    expect(sig.denialCode).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    expect(sig.healthSignalClass).toBe(POLICY_DENIAL_HEALTH_CLASS);
  });
});

describe("isRedactionSafe / assertRedactionSafe", () => {
  it("accepts a signal carrying only refs / hashes / codes", () => {
    expect(isRedactionSafe(buildAuditSignal(base))).toBe(true);
    expect(() => assertRedactionSafe(buildAuditSignal(base))).not.toThrow();
  });

  it("rejects a signal whose summary carries raw content", () => {
    const leaky = buildAuditSignal({
      ...base,
      afterSummary: "user said: my password is hunter2 and the deal terms are...",
    });
    expect(isRedactionSafe(leaky)).toBe(false);
  });

  it("rejects a signal carrying a credential-shaped token", () => {
    const leaky = buildAuditSignal({
      ...base,
      refs: ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"],
    });
    expect(isRedactionSafe(leaky)).toBe(false);
  });
});

describe("toAuditRecordInput", () => {
  it("produces an object AuditRecordSchema.parse accepts (impure caller supplies occurredAt)", () => {
    const sig: AuditSignal = buildAuditSignal(base);
    const record = toAuditRecordInput(sig, "2026-01-01T00:00:00.000Z");
    expect(() => AuditRecordSchema.parse(record)).not.toThrow();
    const parsed = AuditRecordSchema.parse(record);
    expect(parsed.timestamps.occurredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.actor).toBe("policy");
  });
});
