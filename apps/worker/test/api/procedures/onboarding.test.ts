// Task 14.1 (worker leg) — the `onboarding` tRPC procedure. RED-first spec.
//
// `onboarding.createWorkspace` is the production onboarding command: it validates
// the candidate onboarding input at the transport edge (candidate-data gate), calls
// the injected `OnboardingCommandPort.provisionWorkspace` (the real binding wraps
// the composition `provisionWorkspace` over @sow/db), and returns a typed UI-safe
// provisioned summary — never throws, never echoes a raw driver cause (§16 / safety
// rule 7). The procedure runs behind the 8.1 auth gate via `authedResolver`.
//
// Exercised through the REAL tRPC caller path (`createCallerFactory`) with a FAKE
// port — the real port binding is the boot/integrator step (composition tests pin
// the real `provisionWorkspace`).
import { describe, it, expect } from "vitest";
import { isErr, isOk, type Result, type FailureVariant } from "@sow/contracts";
import { createCallerFactory, router, type ApiContext } from "../../../src/api/trpc";
import {
  buildOnboardingRouter,
  type OnboardingCommandPort,
} from "../../../src/api/procedures/onboarding";
import type {
  ProvisionWorkspaceSpec,
  ProvisionedWorkspace,
  ProvisionWorkspaceError,
} from "../../../src/composition/provisionWorkspace";

// An authed / unauthed ApiContext (the 8.1 gate outcome the resolver reads first).
const AUTHED_CTX: ApiContext = { auth: { ok: true, value: { authenticated: true } } };
const UNAUTH_CTX: ApiContext = {
  auth: { ok: false, error: { kind: "validation_rejected", message: "unauthenticated", retryable: false } },
};

const VALID_INPUT = {
  id: "employer-work",
  name: "Employer Work",
  type: "employer_work",
  vaultRoot: "/vaults/employer-work",
  gbrainBrainId: "brain-employer",
  preset: "professional",
};

// A FAKE OnboardingCommandPort — records each provisionWorkspace call so a test can
// assert the parsed spec is threaded through, and returns a canned Result.
class FakeOnboardingPort implements OnboardingCommandPort {
  calls: ProvisionWorkspaceSpec[] = [];
  constructor(
    private readonly outcome: (spec: ProvisionWorkspaceSpec) => Result<ProvisionedWorkspace, ProvisionWorkspaceError>,
  ) {}
  async provisionWorkspace(spec: ProvisionWorkspaceSpec): Promise<Result<ProvisionedWorkspace, ProvisionWorkspaceError>> {
    this.calls.push(spec);
    return this.outcome(spec);
  }
}

function okOutcome(spec: ProvisionWorkspaceSpec): Result<ProvisionedWorkspace, ProvisionWorkspaceError> {
  return { ok: true, value: { id: spec.id, registryMember: true, preset: spec.preset } };
}

function caller(port: OnboardingCommandPort, ctx: ApiContext = AUTHED_CTX) {
  const appRouter = router({ onboarding: buildOnboardingRouter({ onboarding: port }) });
  return createCallerFactory(appRouter)(ctx);
}

describe("onboarding.createWorkspace procedure (14.1)", () => {
  it("onboarding_create_round_trips: validates input, calls provisionWorkspace, returns a typed provisioned summary (member=true) [spec(§19.1)][spec(§11)]", async () => {
    const port = new FakeOnboardingPort(okOutcome);
    const c = caller(port);
    const res = await c.onboarding.createWorkspace(VALID_INPUT);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.workspaceId).toBe("employer-work");
      expect(res.value.registryMember).toBe(true);
    }
    // The parsed onboarding inputs were threaded to the port (id/name/type/vaultRoot/gbrainBrainId/preset).
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]).toMatchObject({
      id: "employer-work",
      name: "Employer Work",
      type: "employer_work",
      vaultRoot: "/vaults/employer-work",
      gbrainBrainId: "brain-employer",
      preset: "professional",
    });
  });

  it("onboarding_create_idempotent: a second create for the same id succeeds idempotently (re-entrant onboarding) [spec(§19.1)]", async () => {
    const port = new FakeOnboardingPort(okOutcome);
    const c = caller(port);
    const first = await c.onboarding.createWorkspace(VALID_INPUT);
    const second = await c.onboarding.createWorkspace(VALID_INPUT);
    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true); // no error on re-create (idempotency is provisionWorkspace's contract)
    if (isOk(second)) expect(second.value.workspaceId).toBe("employer-work");
  });

  it("onboarding_error_is_typed_no_raw: a provisioning fault surfaces a stable code, never the raw driver cause (§16 / safety rule 7) [spec(§16)]", async () => {
    const port = new FakeOnboardingPort(() => ({
      ok: false,
      error: { code: "store_fault", message: "postgres: FATAL connection SECRET-DSN refused" },
    }));
    const c = caller(port);
    const res = await c.onboarding.createWorkspace(VALID_INPUT);
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      // Redaction-safe: the raw driver message never crosses the boundary.
      expect(JSON.stringify(res.error)).not.toContain("SECRET-DSN");
      expect(JSON.stringify(res.error)).not.toContain("postgres");
    }
  });

  it("createWorkspace_rejects_malformed_input: a bad preset / unknown type is a typed validation_rejected, never a throw (candidate-data gate) [spec(§19.1)]", async () => {
    const port = new FakeOnboardingPort(okOutcome);
    const c = caller(port);
    const badPreset = await c.onboarding.createWorkspace({ ...VALID_INPUT, preset: "enterprise" });
    const badType = await c.onboarding.createWorkspace({ ...VALID_INPUT, type: "not_a_type" });
    const missingName = await c.onboarding.createWorkspace({ ...VALID_INPUT, name: "" });
    expect(isErr(badPreset)).toBe(true);
    expect(isErr(badType)).toBe(true);
    expect(isErr(missingName)).toBe(true);
    // A malformed input never reaches provisioning.
    expect(port.calls).toHaveLength(0);
  });

  it("createWorkspace_requires_auth: an unauthenticated caller gets the interceptor's typed err (never provisions) [spec(§19.1)]", async () => {
    const port = new FakeOnboardingPort(okOutcome);
    const c = caller(port, UNAUTH_CTX);
    const res = await c.onboarding.createWorkspace(VALID_INPUT);
    expect(isErr(res)).toBe(true);
    expect(port.calls).toHaveLength(0); // resolver body never ran
  });
});
