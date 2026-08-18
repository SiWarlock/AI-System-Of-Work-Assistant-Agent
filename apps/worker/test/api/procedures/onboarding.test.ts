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

  // ── `### 24.84` WORKER LEG — the brand is ENFORCED at create (safety rule 7) ──
  //
  // The contracts leg (`25ae6c49`) gave `WorkspaceIdSchema` a bounded slug shape.
  // Until this leg, `parseCreateWorkspace` gated the id on `isNonEmptyString` alone
  // and returned it raw ⇒ the shape was DEFINED and NOT ENFORCED, and the create
  // path was the sole id-introducing gate. These pins close that.

  // spec(§5) — a non-conforming id is REFUSED at create, by CODE, never a throw.
  // `ws_employer` is the underscore-bearing legacy shape `### 24.99` cited: it is a
  // perfectly good non-empty string, which is exactly why the old gate admitted it.
  it("non_conforming_workspace_id_is_refused_at_create: the brand runs, and the refusal carries its own code [spec(§5)]", async () => {
    const port = new FakeOnboardingPort(okOutcome);
    const res = await caller(port).onboarding.createWorkspace({
      ...VALID_INPUT,
      id: "ws_employer",
    });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.kind).toBe("validation_rejected");
      // A DISTINCT code from the empty/missing case — a reader of the audit trail can
      // tell "no id supplied" from "id supplied, wrong shape".
      expect(res.error.cause?.code).toBe("CREATE_WORKSPACE_ID_SHAPE");
    }
    // Fail-closed: a refused id never reaches provisioning.
    expect(port.calls).toHaveLength(0);
  });

  // spec(§5) — ⛔ THE AVAILABILITY GUARANTEE `### 24.84`'s OWN BINDING GATE NAMES.
  // Rejecting a live id is an availability break, not a hardening. Not a formality:
  // this is the pin that would catch a brand tightened past the real population.
  it.each([["employer-work"], ["personal-business"], ["personal-life"]])(
    "the_three_live_workspace_ids_still_create (%s) [spec(§5)]",
    async (id) => {
      const port = new FakeOnboardingPort(okOutcome);
      const res = await caller(port).onboarding.createWorkspace({ ...VALID_INPUT, id });
      expect(isOk(res)).toBe(true);
      // It really provisioned, with the id intact — not merely "did not error".
      expect(port.calls).toHaveLength(1);
      expect(port.calls[0]?.id).toBe(id);
    },
  );

  // spec(§16) — ⛔ RULE 7. The rejected VALUE must not ride out on the refusal.
  // ⛔⛔ READ THIS BEFORE CITING THIS PIN AS CREDENTIAL COVERAGE — IT IS NOT.
  // The fixture is refused for its UPPERCASE LETTERS, not for being a credential.
  // `WORKSPACE_ID_RE` is `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/`, so the lowercase sibling
  // `sk-ant-api03-abc123def456` — same credential shape — ACCEPTS, BY DESIGN, and
  // `packages/contracts/test/primitives/zod-brands.test.ts` pins that acceptance
  // deliberately (`zod-brands.ts`: "⛔ WHAT THIS IS NOT: a credential detector").
  // ⇒ this pin asserts the NON-ECHO property only. The `visibility.ts` residual landing
  // in this same commit turns on the opposite claim — "a shape gate does NOT close"
  // the credential-reaching-the-audit case — and an auditor censusing "what pins the
  // credential case" must not read this green line as closing it.
  it("refusal_does_not_echo_the_rejected_id: the refusal carries no trace of the rejected value [spec(§16)]", async () => {
    const credentialShaped = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv";
    const port = new FakeOnboardingPort(okOutcome);
    const res = await caller(port).onboarding.createWorkspace({
      ...VALID_INPUT,
      id: credentialShaped,
    });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.cause?.code).toBe("CREATE_WORKSPACE_ID_SHAPE");
      // Deep scan of the WHOLE serialized error, not a field-by-field check — a
      // field-by-field check only covers the fields someone thought of.
      expect(JSON.stringify(res.error)).not.toContain(credentialShaped);
      expect(JSON.stringify(res.error)).not.toContain("sk-ant-api03");
    }
    expect(port.calls).toHaveLength(0);
  });

  // spec(§19.1) — no behaviour drifts sideways. The pre-existing sibling pin asserts a
  // bare `isErr` for these; this asserts each refusal's CODE (`### 24.101` — a bare
  // falsity cannot detect a refusal that starts passing for the wrong reason).
  it("create_still_rejects_the_other_malformed_inputs, each by its own code [spec(§19.1)]", async () => {
    const port = new FakeOnboardingPort(okOutcome);
    const c = caller(port);
    const cases: readonly (readonly [Record<string, unknown>, string])[] = [
      [{ id: "" }, "CREATE_WORKSPACE_ID"],
      [{ name: "" }, "CREATE_WORKSPACE_NAME"],
      [{ type: "not_a_type" }, "CREATE_WORKSPACE_TYPE"],
      [{ vaultRoot: "" }, "CREATE_WORKSPACE_VAULT_ROOT"],
      [{ gbrainBrainId: "" }, "CREATE_WORKSPACE_GBRAIN_BRAIN_ID"],
      [{ preset: "enterprise" }, "CREATE_WORKSPACE_PRESET"],
      // ⛔ THE `max(64)` BOUND. Without this row every pin here is satisfied by a
      // CHARSET-ONLY predicate, so swapping `WorkspaceIdSchema.safeParse` for a bare
      // `WORKSPACE_ID_RE.test` — a plausible "drop the zod call" edit — would keep the
      // suite green while silently removing bounded-input hygiene from the sole
      // id-introducing gate. 65 chars is otherwise a perfectly valid slug.
      [{ id: "a".repeat(65) }, "CREATE_WORKSPACE_ID_SHAPE"],
    ];
    for (const [patch, code] of cases) {
      const res = await c.onboarding.createWorkspace({ ...VALID_INPUT, ...patch });
      expect(isErr(res)).toBe(true);
      if (isErr(res)) expect(res.error.cause?.code).toBe(code);
    }
    expect(port.calls).toHaveLength(0);
  });

  it("createWorkspace_requires_auth: an unauthenticated caller gets the interceptor's typed err (never provisions) [spec(§19.1)]", async () => {
    const port = new FakeOnboardingPort(okOutcome);
    const c = caller(port, UNAUTH_CTX);
    const res = await c.onboarding.createWorkspace(VALID_INPUT);
    expect(isErr(res)).toBe(true);
    expect(port.calls).toHaveLength(0); // resolver body never ran
  });

  it("onboarding_partial_scaffold_is_distinguishable: a registerWorkspace-fault partial reaches the transport as a DISTINCT FailureVariant, never the generic store-fault one (task 9.21-A) [spec(§16)][spec(§11)]", async () => {
    const port = new FakeOnboardingPort(() => ({
      ok: false,
      error: {
        code: "partial_scaffold",
        message: "workspace config written; registry union incomplete",
        configWritten: true,
        incompleteStep: "registry_union",
      },
    }));
    const c = caller(port);
    const res = await c.onboarding.createWorkspace(VALID_INPUT);
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      // Distinguishable from the generic store-fault cause — never folded back into it (9.21-A).
      expect(res.error.cause?.code).toBe("ONBOARDING_PARTIAL_SCAFFOLD");
      expect(res.error.cause?.code).not.toBe("ONBOARDING_STORE_FAULT");
      // Redaction-safe: no raw driver detail (there is none in this outcome, but the mapping must not
      // introduce any — §16 / rule 7).
      expect(JSON.stringify(res.error)).not.toContain("registry union incomplete");
    }
  });

  it("onboarding_stored_row_schema_violation_is_distinguishable_and_non_retryable: a corrupt stored row reaches the transport as its OWN FailureVariant, never store-fault, never retryable (task 9.36) [spec(§16)]", async () => {
    const port = new FakeOnboardingPort(() => ({
      ok: false,
      error: { code: "stored_row_schema_violation", message: "workspace config read failed re-validation" },
    }));
    const c = caller(port);
    const res = await c.onboarding.createWorkspace(VALID_INPUT);
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.cause?.code).toBe("ONBOARDING_STORED_ROW_SCHEMA_VIOLATION");
      expect(res.error.cause?.code).not.toBe("ONBOARDING_STORE_FAULT");
      // PERMANENTLY non-retryable — a corrupt row will not self-heal on retry (design question 5).
      expect(res.error.retryable).toBe(false);
    }
  });
});
