// spec(§7) — broker route resolution: SOLELY capabilityDefaults[capability] for
// the JOB'S OWN workspace. Reuses @sow/policy resolveRoute (no re-implementation);
// adds the workspace-binding guard; NO hard-wired reference runtime (a runtime
// branch route is routable). Fail-closed on absence / mismatch.
import { describe, it, expect } from "vitest";
import type { AgentJob, ProviderMatrix, ProviderRoute, WorkspaceId } from "@sow/contracts";
import { validAgentJob, validProviderRoute } from "@sow/contracts";
import { isAllow, isDeny } from "@sow/policy";
import { resolveJobRoute } from "../src/broker/route-resolution";

// A matrix pinned to the JOB'S workspace (validAgentJob.workspaceId === "ws-001").
function matrixFor(route: ProviderRoute, allowed: ProviderMatrix["allowedProviders"]): ProviderMatrix {
  return {
    workspaceId: validAgentJob.workspaceId,
    allowedProviders: allowed,
    capabilityDefaults: { "meeting.close": route } as ProviderMatrix["capabilityDefaults"],
    rawCloudEgressEnabled: true,
  };
}

describe("resolveJobRoute — matrix capabilityDefaults for the job's workspace", () => {
  it("resolves the route configured for the capability", () => {
    const d = resolveJobRoute(validAgentJob, matrixFor(validProviderRoute, ["claude"]));
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) expect(d.value).toEqual(validProviderRoute);
  });

  it("denies (fail-closed) when the matrix is for a DIFFERENT workspace — no cross-workspace route", () => {
    const foreign: ProviderMatrix = {
      ...matrixFor(validProviderRoute, ["claude"]),
      workspaceId: "ws-someone-else" as WorkspaceId,
    };
    const d = resolveJobRoute(validAgentJob, foreign);
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
  });

  it("denies with NO_ROUTE_FOR_CAPABILITY when the capability has no default (no implicit fallback)", () => {
    const jobOther: AgentJob = { ...validAgentJob, capability: "daily.brief" as AgentJob["capability"] };
    const d = resolveJobRoute(jobOther, matrixFor(validProviderRoute, ["claude"]));
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("NO_ROUTE_FOR_CAPABILITY");
  });

  it("denies PROVIDER_NOT_ALLOWED when the resolved provider is outside allowedProviders", () => {
    const d = resolveJobRoute(validAgentJob, matrixFor(validProviderRoute, ["openai"]));
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("PROVIDER_NOT_ALLOWED");
  });

  it("routes a RUNTIME-branch target too — no hard-wired reference runtime (matrix may route the critical path anywhere conformant)", () => {
    const runtimeRoute: ProviderRoute = {
      runtime: "hermes",
      model: "claude-opus-4",
      endpoint: "http://localhost:7071",
      egressClass: "local",
    };
    const d = resolveJobRoute(validAgentJob, matrixFor(runtimeRoute, ["claude"]));
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) expect(d.value).toEqual(runtimeRoute);
  });
});
