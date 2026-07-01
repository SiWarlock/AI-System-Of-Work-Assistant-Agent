// spec(§7) — pinned-model availability + conformance eligibility gate (5.9): a
// route whose pinned model is absent at its endpoint is INELIGIBLE (typed
// failure, NEVER a substitute-model fallback); a non-conformant (unknown /
// failing / disabled) provider×capability×model pair is skipped/denied. Every
// outcome is a typed GateResult (never a throw) with a redaction-safe AuditSignal.
import { describe, it, expect } from "vitest";
import { isErr, isOk } from "@sow/contracts";
import type { AgentJob, ProviderRoute, ConformanceStatus } from "@sow/contracts";
import { validAgentJob, validProviderRoute } from "@sow/contracts";
import { isRedactionSafe } from "@sow/policy";
import {
  checkModelAvailability,
  modelUnavailableHealthItem,
  nonconformantHealthItem,
  MODEL_UNAVAILABLE_HEALTH_CLASS,
  PROVIDER_NONCONFORMANT_HEALTH_CLASS,
  type ModelAvailabilityProbe,
} from "../src/broker/model-availability";

const ROUTE: ProviderRoute = validProviderRoute;
const JOB: AgentJob = validAgentJob;

function probe(over: Partial<ModelAvailabilityProbe> = {}): ModelAvailabilityProbe {
  return { modelPresent: true, conformanceStatus: "passing", ...over };
}

describe("checkModelAvailability — pinned model present + conformant", () => {
  it("PROCEEDS when the pinned model is present and the pair is conformance-passing", () => {
    const r = checkModelAvailability(ROUTE, JOB, probe());
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.value).toBeUndefined();
      expect(r.value.audit).toBeDefined();
      expect(isRedactionSafe(r.value.audit!)).toBe(true);
    }
  });
});

describe("checkModelAvailability — pinned model absent (no substitute fallback)", () => {
  it("DENIES with a typed provider_unavailable failure and the model-unavailable health class", () => {
    const r = checkModelAvailability(ROUTE, JOB, probe({ modelPresent: false }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.reason).toBe("provider_unavailable");
      expect(r.error.branch).toBe("failed_retryable");
      expect(r.error.retryable).toBe(true);
      expect(r.error.audit.healthSignalClass).toBe(MODEL_UNAVAILABLE_HEALTH_CLASS);
      // never a substitute-model fallback — the message says so, the audit is safe.
      expect(r.error.message.toLowerCase()).toContain("substitute");
      expect(isRedactionSafe(r.error.audit)).toBe(true);
    }
  });
});

describe("checkModelAvailability — non-conformant pair is skipped/denied (§7)", () => {
  for (const status of ["unknown", "failing", "disabled"] as ConformanceStatus[]) {
    it(`DENIES a "${status}" pair as non-conformant (only "passing" is eligible)`, () => {
      const r = checkModelAvailability(ROUTE, JOB, probe({ conformanceStatus: status }));
      expect(isErr(r)).toBe(true);
      if (isErr(r)) {
        expect(r.error.reason).toBe("provider_unavailable");
        expect(r.error.branch).toBe("failed_retryable");
        expect(r.error.audit.healthSignalClass).toBe(PROVIDER_NONCONFORMANT_HEALTH_CLASS);
        expect(isRedactionSafe(r.error.audit)).toBe(true);
      }
    });
  }

  it("checks conformance BEFORE model presence (a disabled+absent pair denies as non-conformant)", () => {
    const r = checkModelAvailability(ROUTE, JOB, probe({ conformanceStatus: "disabled", modelPresent: false }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.audit.healthSignalClass).toBe(PROVIDER_NONCONFORMANT_HEALTH_CLASS);
    }
  });
});

describe("checkModelAvailability — malformed probe fails closed", () => {
  it("DENIES a null / malformed probe (never proceeds on unknown input)", () => {
    const r = checkModelAvailability(ROUTE, JOB, null as unknown as ModelAvailabilityProbe);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("provider_unavailable");
  });
});

describe("System-Health item builders (OBS-2, redaction-safe)", () => {
  it("modelUnavailableHealthItem carries the class + id-only refs", () => {
    const item = modelUnavailableHealthItem(ROUTE, JOB);
    expect(item.healthClass).toBe(MODEL_UNAVAILABLE_HEALTH_CLASS);
    expect(item.refs).toContain(`ref:job:${JOB.id}`);
    for (const ref of item.refs) expect(ref).not.toMatch(/@/);
  });

  it("nonconformantHealthItem carries the non-conformant class", () => {
    const item = nonconformantHealthItem(ROUTE, JOB);
    expect(item.healthClass).toBe(PROVIDER_NONCONFORMANT_HEALTH_CLASS);
  });
});
