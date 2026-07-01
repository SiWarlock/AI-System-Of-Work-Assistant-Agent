// spec(§7) — provider health / model-availability gate + degraded modes (5.9).
// Applied AFTER the egress veto, BEFORE budget: an unhealthy (unreachable) or
// secret-unavailable (Keychain locked/denied, LIFE-6) provider is INELIGIBLE for
// the route; dependent jobs are held retryable (never silently dropped) and a
// distinct System Health item (OBS-2) is surfaced. The composed gate also folds
// in pinned-model availability + conformance eligibility. Deterministic, pure
// (the health/availability sources are dependency-injected), never throws (§16).
import { describe, it, expect, vi } from "vitest";
import { isErr, isOk } from "@sow/contracts";
import type { AgentJob, ProviderRoute } from "@sow/contracts";
import { validAgentJob, validProviderRoute } from "@sow/contracts";
import { isRedactionSafe } from "@sow/policy";
import {
  checkProviderHealth,
  providerUnreachableHealthItem,
  providerSecretHealthItem,
  createHealthGate,
  evaluateEligibility,
  PROVIDER_UNREACHABLE_HEALTH_CLASS,
  PROVIDER_SECRET_UNAVAILABLE_HEALTH_CLASS,
  type ProviderHealthProbe,
  type ProviderHealthSource,
} from "../src/broker/provider-health";
import type { ModelAvailabilitySource } from "../src/broker/model-availability";
import { PROVIDER_NONCONFORMANT_HEALTH_CLASS } from "../src/broker/model-availability";

const ROUTE: ProviderRoute = validProviderRoute;
const JOB: AgentJob = validAgentJob;

const healthProbe = (state: ProviderHealthProbe["state"]): ProviderHealthProbe => ({ state });

describe("checkProviderHealth — healthy provider proceeds", () => {
  it("PROCEEDS on a healthy provider with a redaction-safe audit", () => {
    const r = checkProviderHealth(ROUTE, JOB, healthProbe("healthy"));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.audit).toBeDefined();
      expect(isRedactionSafe(r.value.audit!)).toBe(true);
    }
  });
});

describe("checkProviderHealth — unreachable provider is ineligible, held retryable", () => {
  it("DENIES an unreachable provider (degraded, retryable, distinct health class)", () => {
    const r = checkProviderHealth(ROUTE, JOB, healthProbe("unreachable"));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.reason).toBe("provider_unavailable");
      expect(r.error.branch).toBe("failed_retryable"); // never silently dropped
      expect(r.error.retryable).toBe(true);
      expect(r.error.audit.healthSignalClass).toBe(PROVIDER_UNREACHABLE_HEALTH_CLASS);
      expect(isRedactionSafe(r.error.audit)).toBe(true);
    }
  });
});

describe("checkProviderHealth — Keychain locked/denied degrades the provider (LIFE-6)", () => {
  for (const state of ["keychain_locked", "keychain_denied"] as const) {
    it(`DENIES on ${state}: held retryable for re-attempt on unlock`, () => {
      const r = checkProviderHealth(ROUTE, JOB, healthProbe(state));
      expect(isErr(r)).toBe(true);
      if (isErr(r)) {
        expect(r.error.reason).toBe("provider_unavailable");
        expect(r.error.retryable).toBe(true);
        expect(r.error.branch).toBe("failed_retryable");
        expect(r.error.audit.healthSignalClass).toBe(PROVIDER_SECRET_UNAVAILABLE_HEALTH_CLASS);
        expect(isRedactionSafe(r.error.audit)).toBe(true);
      }
    });
  }
});

describe("checkProviderHealth — malformed probe fails closed", () => {
  it("DENIES an unrecognized/malformed health state (never proceeds)", () => {
    const r = checkProviderHealth(ROUTE, JOB, { state: "bogus" } as unknown as ProviderHealthProbe);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("provider_unavailable");
  });
});

describe("health-item builders (OBS-2, id-only refs)", () => {
  it("providerUnreachableHealthItem + providerSecretHealthItem carry their classes", () => {
    expect(providerUnreachableHealthItem(ROUTE, JOB).healthClass).toBe(PROVIDER_UNREACHABLE_HEALTH_CLASS);
    expect(providerSecretHealthItem(ROUTE, JOB, "keychain_locked").healthClass).toBe(
      PROVIDER_SECRET_UNAVAILABLE_HEALTH_CLASS,
    );
    for (const ref of providerUnreachableHealthItem(ROUTE, JOB).refs) expect(ref).not.toMatch(/@/);
  });
});

describe("createHealthGate — composes provider health THEN model availability", () => {
  const okHealth: ProviderHealthSource = () => healthProbe("healthy");
  const okAvail: ModelAvailabilitySource = () => ({ modelPresent: true, conformanceStatus: "passing" });

  it("PROCEEDS when provider is healthy AND the pinned model is present + conformant", async () => {
    const gate = createHealthGate({ health: okHealth, availability: okAvail });
    const r = await gate(ROUTE, JOB);
    expect(isOk(r)).toBe(true);
  });

  it("short-circuits on an unhealthy provider — the availability source is NOT consulted", async () => {
    const availSpy = vi.fn<ModelAvailabilitySource>(() => ({ modelPresent: true, conformanceStatus: "passing" }));
    const gate = createHealthGate({ health: () => healthProbe("unreachable"), availability: availSpy });
    const r = await gate(ROUTE, JOB);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.audit.healthSignalClass).toBe(PROVIDER_UNREACHABLE_HEALTH_CLASS);
    expect(availSpy).not.toHaveBeenCalled();
  });

  it("DENIES a healthy provider whose pinned pair is non-conformant", async () => {
    const gate = createHealthGate({
      health: okHealth,
      availability: () => ({ modelPresent: true, conformanceStatus: "disabled" }),
    });
    const r = await gate(ROUTE, JOB);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.audit.healthSignalClass).toBe(PROVIDER_NONCONFORMANT_HEALTH_CLASS);
  });
});

describe("evaluateEligibility — status exposed to the 5.10 / read-model layer (bullet 5)", () => {
  it("reports eligible=true for a healthy, present, conformant target with no health item", () => {
    const status = evaluateEligibility(ROUTE, JOB, {
      health: () => healthProbe("healthy"),
      availability: () => ({ modelPresent: true, conformanceStatus: "passing" }),
    });
    expect(status.eligible).toBe(true);
    expect(status.healthState).toBe("healthy");
    expect(status.modelAvailable).toBe(true);
    expect(status.conformanceStatus).toBe("passing");
    expect(status.healthItem).toBeUndefined();
  });

  it("reports eligible=false + a distinct health item for an unreachable provider", () => {
    const status = evaluateEligibility(ROUTE, JOB, {
      health: () => healthProbe("unreachable"),
      availability: () => ({ modelPresent: true, conformanceStatus: "passing" }),
    });
    expect(status.eligible).toBe(false);
    expect(status.healthItem?.healthClass).toBe(PROVIDER_UNREACHABLE_HEALTH_CLASS);
  });

  it("reports eligible=false for a healthy provider whose pinned model is absent", () => {
    const status = evaluateEligibility(ROUTE, JOB, {
      health: () => healthProbe("healthy"),
      availability: () => ({ modelPresent: false, conformanceStatus: "passing" }),
    });
    expect(status.eligible).toBe(false);
    expect(status.modelAvailable).toBe(false);
  });
});
