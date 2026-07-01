// spec(§5) — Provider-matrix route resolution (REQ-S-005): deterministic,
// allowlist-bound resolution SOLELY from capabilityDefaults[capability]. No
// implicit/global fallback (absence = fail-closed NO_ROUTE_FOR_CAPABILITY);
// provider-branch route ∉ allowedProviders ⇒ PROVIDER_NOT_ALLOWED; a local route
// whose endpoint is absent from an explicit local-provider config ⇒
// LOCAL_ENDPOINT_NOT_CONFIGURED. Every decision emits a redaction-safe AuditSignal.
import { describe, it, expect } from "vitest";
import type {
  Capability,
  ProviderMatrix,
  ProviderRoute,
} from "@sow/contracts";
import {
  resolveRoute,
  routeProvider,
  type LocalProviderConfig,
} from "../src/provider-matrix";
import { isAllow, isDeny } from "../src/decision";
import { isRedactionSafe } from "../src/audit-signal";

const CAP = "meeting.close" as Capability;
const OTHER_CAP = "note.synthesize" as Capability;

const cloudRoute: ProviderRoute = {
  provider: "claude",
  model: "claude-opus-4",
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
};

const localRoute: ProviderRoute = {
  provider: "ollama",
  model: "llama3.1",
  endpoint: "http://127.0.0.1:11434",
  egressClass: "local",
};

const runtimeRoute: ProviderRoute = {
  runtime: "claude-agent-sdk",
  model: "claude-opus-4",
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
};

const matrix = (over: Partial<ProviderMatrix> = {}): ProviderMatrix => ({
  workspaceId: "ws-matrix-001" as ProviderMatrix["workspaceId"],
  allowedProviders: ["claude"],
  capabilityDefaults: { [CAP]: cloudRoute } as ProviderMatrix["capabilityDefaults"],
  rawCloudEgressEnabled: true,
  ...over,
});

describe("resolveRoute — happy path + determinism", () => {
  it("returns the exact route from capabilityDefaults[capability]", () => {
    const d = resolveRoute(matrix(), CAP);
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) {
      expect(d.value).toEqual(cloudRoute);
      // Surfaces egressClass + endpoint for the downstream egress veto (3.4).
      expect(d.value.egressClass).toBe("cloud");
      expect(d.value.endpoint).toBe("https://api.anthropic.com");
      expect(isRedactionSafe(d.audit)).toBe(true);
    }
  });

  it("is deterministic: same (matrix, capability) → identical route", () => {
    const m = matrix();
    const a = resolveRoute(m, CAP);
    const b = resolveRoute(m, CAP);
    expect(isAllow(a) && isAllow(b)).toBe(true);
    if (isAllow(a) && isAllow(b)) expect(a.value).toEqual(b.value);
  });
});

describe("resolveRoute — fail-closed denials", () => {
  it("capability absent from capabilityDefaults ⇒ NO_ROUTE_FOR_CAPABILITY (no fallback)", () => {
    const d = resolveRoute(matrix(), OTHER_CAP);
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) {
      expect(d.reason).toBe("NO_ROUTE_FOR_CAPABILITY");
      expect(d.audit.denialCode).toBe("NO_ROUTE_FOR_CAPABILITY");
      expect(isRedactionSafe(d.audit)).toBe(true);
    }
  });

  it("provider-branch route whose provider ∉ allowedProviders ⇒ PROVIDER_NOT_ALLOWED", () => {
    // capabilityDefaults points at a `claude` route but allowedProviders omits it.
    const m = matrix({ allowedProviders: ["ollama"] });
    const d = resolveRoute(m, CAP);
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) {
      expect(d.reason).toBe("PROVIDER_NOT_ALLOWED");
      expect(isRedactionSafe(d.audit)).toBe(true);
    }
  });

  it("local route with an endpoint NOT in localConfig ⇒ LOCAL_ENDPOINT_NOT_CONFIGURED", () => {
    const m = matrix({
      allowedProviders: ["ollama"],
      capabilityDefaults: { [CAP]: localRoute } as ProviderMatrix["capabilityDefaults"],
    });
    const cfg: LocalProviderConfig = { allowedLocalEndpoints: ["http://127.0.0.1:9999"] };
    const d = resolveRoute(m, CAP, cfg);
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) {
      expect(d.reason).toBe("LOCAL_ENDPOINT_NOT_CONFIGURED");
      expect(isRedactionSafe(d.audit)).toBe(true);
    }
  });

  it("fail-closed on malformed matrix input ⇒ MALFORMED_POLICY_INPUT (never fail-open)", () => {
    const d = resolveRoute(undefined as unknown as ProviderMatrix, CAP);
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
  });
});

describe("resolveRoute — local-endpoint config", () => {
  it("local route with a LISTED endpoint resolves (allow)", () => {
    const m = matrix({
      allowedProviders: ["ollama"],
      capabilityDefaults: { [CAP]: localRoute } as ProviderMatrix["capabilityDefaults"],
    });
    const cfg: LocalProviderConfig = { allowedLocalEndpoints: ["http://127.0.0.1:11434"] };
    const d = resolveRoute(m, CAP, cfg);
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) expect(d.value).toEqual(localRoute);
  });

  it("local route resolves when no localConfig is supplied (check is skipped)", () => {
    const m = matrix({
      allowedProviders: ["ollama"],
      capabilityDefaults: { [CAP]: localRoute } as ProviderMatrix["capabilityDefaults"],
    });
    const d = resolveRoute(m, CAP);
    expect(isAllow(d)).toBe(true);
  });

  it("localConfig does NOT constrain a cloud route (only local routes are checked)", () => {
    const cfg: LocalProviderConfig = { allowedLocalEndpoints: [] };
    const d = resolveRoute(matrix(), CAP, cfg);
    expect(isAllow(d)).toBe(true);
  });
});

describe("routeProvider helper", () => {
  it("provider-branch route → its ProviderId", () => {
    expect(routeProvider(cloudRoute)).toBe("claude");
  });

  it("runtime-branch route → null", () => {
    expect(routeProvider(runtimeRoute)).toBeNull();
  });
});
