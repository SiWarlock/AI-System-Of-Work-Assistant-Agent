// spec(§5) — PolicyDecision discriminated union: allow/deny construction + guards; every decision carries an AuditSignal
import { describe, it, expect } from "vitest";
import {
  allowDecision,
  denyDecision,
  isAllow,
  isDeny,
  type PolicyDecision,
  type PolicyAllow,
  type PolicyDeny,
} from "../src/decision";
import { buildAuditSignal } from "../src/audit-signal";

const audit = buildAuditSignal({
  actor: "policy",
  event: "provider.route.decided",
  refs: ["ref:workspace:ws-1"],
  payloadHash: "sha256:abc",
  beforeSummary: "no route",
  afterSummary: "route selected",
});

describe("allowDecision", () => {
  it("builds a PolicyAllow carrying value + audit", () => {
    const d: PolicyAllow<number> = allowDecision(42, audit);
    expect(d.decision).toBe("allow");
    expect(d.value).toBe(42);
    expect(d.audit).toBe(audit);
  });

  it("is recognized by isAllow and not isDeny", () => {
    const d: PolicyDecision<number> = allowDecision(1, audit);
    expect(isAllow(d)).toBe(true);
    expect(isDeny(d)).toBe(false);
    if (isAllow(d)) {
      // type narrows to PolicyAllow<number>
      expect(d.value).toBe(1);
    }
  });
});

describe("denyDecision", () => {
  it("builds a PolicyDeny carrying reason + message + audit", () => {
    const denyAudit = buildAuditSignal({
      actor: "policy",
      event: "provider.denied",
      refs: [],
      payloadHash: "sha256:x",
      beforeSummary: "",
      afterSummary: "",
      denialCode: "PROVIDER_NOT_ALLOWED",
    });
    const d: PolicyDeny = denyDecision(
      "PROVIDER_NOT_ALLOWED",
      "provider not in matrix",
      denyAudit,
    );
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("PROVIDER_NOT_ALLOWED");
    expect(d.message).toBe("provider not in matrix");
    expect(d.audit).toBe(denyAudit);
  });

  it("is recognized by isDeny and not isAllow", () => {
    const d: PolicyDecision<number> = denyDecision(
      "MALFORMED_POLICY_INPUT",
      "bad input",
      audit,
    );
    expect(isDeny(d)).toBe(true);
    expect(isAllow(d)).toBe(false);
    if (isDeny(d)) {
      expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
    }
  });
});

describe("every decision carries an AuditSignal", () => {
  it("allow carries audit", () => {
    expect(allowDecision("v", audit).audit).toBeDefined();
  });
  it("deny carries audit", () => {
    expect(denyDecision("APPROVAL_REQUIRED", "m", audit).audit).toBeDefined();
  });
});
