// Task 14.1 (worker leg) — the `onboarding` command procedure: create-workspace.
//
// The production onboarding surface. A real user mints a workspace here (§19.1 / §11
// WS-6 first-run): the procedure validates the candidate onboarding input at the
// transport edge (the candidate-data gate), calls the injected `OnboardingCommandPort`
// (the real binding wraps the composition `provisionWorkspace` over `@sow/db`), and
// returns a typed UI-safe provisioned summary.
//
// ONE-WRITER (§7/§8, safety 3) via the injected port: the API never writes the config
// store or the registry directly. §16: never throws across the boundary — every path
// returns `Result<T, FailureVariant>`; a provisioning fault surfaces a STABLE code,
// never the raw driver cause (safety rule 7). Mirrors the `commands.ts` pattern.
import { publicProcedure, router, authedResolver } from "../router";
import {
  ok,
  err,
  failure,
  isWorkspaceType,
  WorkspaceIdSchema,
  type Result,
  type FailureVariant,
  type WorkspaceType,
} from "@sow/contracts";
import {
  provisionWorkspace,
  type ProvisionWorkspaceSpec,
  type ProvisionWorkspaceError,
  type ProvisionedWorkspace,
  type ProvisionWorkspaceDeps,
} from "../../composition/provisionWorkspace";

/**
 * The frozen onboarding preset set — the four §11 first-run presets. Used at the
 * transport edge to NARROW an untrusted input string. Preset consumption
 * (preset → provisioning profile) is task 14.5; here it is a validated captured input.
 */
export const ONBOARDING_PRESETS = ["simple", "professional", "founder", "advanced"] as const;
export type OnboardingPreset = (typeof ONBOARDING_PRESETS)[number];

/**
 * The injected onboarding provisioning port — the procedure's ONLY provisioning I/O.
 * The real binding (boot) wraps the composition `provisionWorkspace` over the durable
 * `WorkspaceConfigRepository` + the fail-closed registry read-model. A fake implements
 * this for unit tests.
 */
export interface OnboardingCommandPort {
  provisionWorkspace(
    spec: ProvisionWorkspaceSpec,
  ): Promise<Result<ProvisionedWorkspace, ProvisionWorkspaceError>>;
}

/** Dependencies for {@link buildOnboardingRouter}. */
export interface OnboardingDeps {
  readonly onboarding: OnboardingCommandPort;
}

/** The renderer-facing provisioned-workspace summary (safe scalars only — no raw content). */
export interface UiSafeProvisionedWorkspace {
  readonly workspaceId: string;
  readonly registryMember: boolean;
  /** The captured preset choice (unpersisted this slice; for 14.5). */
  readonly preset: string;
}

// Bind a real port from the composition path + backends (used at boot). Kept here so
// the port shape and its real binding live together.
/** Build the real {@link OnboardingCommandPort} over the composition `provisionWorkspace`. */
export function createProvisionWorkspacePort(deps: ProvisionWorkspaceDeps): OnboardingCommandPort {
  return {
    provisionWorkspace: (spec) => provisionWorkspace(deps, spec),
  };
}

// ── Input validation (candidate-data gate — PURE, no new dependency) ─────────

/** The validated shape of a `createWorkspace` command input. */
interface CreateWorkspaceInput {
  readonly id: string;
  readonly name: string;
  readonly type: WorkspaceType;
  readonly vaultRoot: string;
  readonly gbrainBrainId: string;
  readonly preset: OnboardingPreset;
}

/** A non-empty-string guard (rejects absent / non-string / whitespace-only). */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** A typed input-validation failure — redaction-safe (only a stable code). */
function invalidInput(code: string): FailureVariant {
  return failure("validation_rejected", "invalid onboarding input", { cause: { code } });
}

/**
 * A PASSTHROUGH tRPC input parser (mirror `commands.ts`): hands the raw client argument
 * to the resolver UNCHANGED so a malformed input is validated INSIDE the handler as a
 * typed `err(validation_rejected)` DATA — never a throw across the boundary (§16). A
 * parser-less `.mutation()` would DISCARD the client input.
 */
const passthroughInput = (raw: unknown): unknown => raw;

/**
 * Validate a raw `createWorkspace` input at the transport edge (the candidate-data
 * gate). Returns a typed `err(validation_rejected)` on any malformed field — never a
 * throw. `type` is narrowed against the frozen `WorkspaceType`; `preset` against the
 * frozen onboarding preset set.
 */
function parseCreateWorkspace(raw: unknown): Result<CreateWorkspaceInput, FailureVariant> {
  if (typeof raw !== "object" || raw === null) return err(invalidInput("CREATE_WORKSPACE_INPUT_SHAPE"));
  const r = raw as Record<string, unknown>;
  const rawId = r["id"];
  if (!isNonEmptyString(rawId)) return err(invalidInput("CREATE_WORKSPACE_ID"));
  // `### 24.84` WORKER LEG (safety rule 7). The contracts leg gave `WorkspaceIdSchema`
  // a bounded slug shape; until this line the create path — the SOLE id-introducing
  // gate — admitted ANY non-empty string, so the shape was DEFINED and NOT ENFORCED.
  //
  // ⛔ `parsedId.error` IS DELIBERATELY DISCARDED. Stating the grounds precisely,
  // because an earlier draft of this comment overstated them in BOTH directions and a
  // reader who checks a false ground concludes the discard is unnecessary:
  //   - What actually contains the rejected value today: NOTHING. Measured against the
  //     installed zod (3.25.76) for every failure mode reachable through this schema —
  //     `invalid_string`/regex, `too_big`, `invalid_type` — no issue payload and no
  //     `error.message` carries the input. So the discard is NOT today's only barrier.
  //   - What IS the barrier, and it is structural: `FailureVariant.cause` is
  //     `{ code: string }` under a `.strict()` schema at BOTH levels
  //     (`packages/contracts/src/primitives/failure.ts`). A value cannot ride out
  //     without a TYPE CHANGE — not by accident.
  //   - Why discard anyway: the zod fact is VERSION- AND ISSUE-KIND-SPECIFIC. Other
  //     issue kinds (`invalid_enum_value`, `invalid_literal`) DO put the value in
  //     `received`, a custom `errorMap` receives `ctx.data`, and zod 4 reshapes issue
  //     payloads. Discarding is the form that does not depend on any of that.
  // ⇒ THE REAL LEAK VECTOR IS A DIRECT ECHO — `cause: { code, received: rawId }`, or a
  // templated message — written by someone making the refusal "more helpful". The value
  // that fails here is exactly the string this arc exists to contain.
  // ⭐ AND THE SUITE IS NOT BLIND TO THAT: `refusal_does_not_echo_the_rejected_id`
  // deep-scans the WHOLE serialized error and reds on any such edit. That pin is the
  // live control for this paragraph — do not delete it as redundant.
  const parsedId = WorkspaceIdSchema.safeParse(rawId);
  if (!parsedId.success) return err(invalidInput("CREATE_WORKSPACE_ID_SHAPE"));
  if (!isNonEmptyString(r["name"])) return err(invalidInput("CREATE_WORKSPACE_NAME"));
  const type = r["type"];
  if (typeof type !== "string" || !isWorkspaceType(type)) return err(invalidInput("CREATE_WORKSPACE_TYPE"));
  if (!isNonEmptyString(r["vaultRoot"])) return err(invalidInput("CREATE_WORKSPACE_VAULT_ROOT"));
  if (!isNonEmptyString(r["gbrainBrainId"])) return err(invalidInput("CREATE_WORKSPACE_GBRAIN_BRAIN_ID"));
  const preset = r["preset"];
  if (typeof preset !== "string" || !(ONBOARDING_PRESETS as readonly string[]).includes(preset)) {
    return err(invalidInput("CREATE_WORKSPACE_PRESET"));
  }
  return ok({
    // The value the brand VALIDATED, not a re-read of `r["id"]`. ⚠ Precisely: a re-read
    // would NOT make the gate decorative — `parsedId.success` is the gate and still
    // refuses. What this buys is that the value PROVISIONED is the value VALIDATED
    // (no validate-then-re-read window), and it stays correct if the schema's transform
    // ever normalizes. Unobservable today: the transform is an identity cast.
    id: parsedId.data,
    name: r["name"],
    type,
    vaultRoot: r["vaultRoot"],
    gbrainBrainId: r["gbrainBrainId"],
    preset: preset as OnboardingPreset,
  });
}

/**
 * Map a `ProvisionWorkspaceError` onto the §16 `FailureVariant` boundary taxonomy.
 * REDACTION-SAFE: only a stable code crosses, never the raw driver cause / message.
 */
function provisionErrorToFailure(e: ProvisionWorkspaceError): FailureVariant {
  switch (e.code) {
    case "invalid_workspace":
      return failure("validation_rejected", "workspace validation rejected", {
        cause: { code: "ONBOARDING_INVALID_WORKSPACE" },
      });
    case "workspace_type_immutable":
      return failure("validation_rejected", "workspace type is immutable", {
        cause: { code: "ONBOARDING_TYPE_IMMUTABLE" },
      });
    case "partial_scaffold":
      // Task 9.21-A: DISTINCT from the generic store fault below — the config row is durably
      // written and only the registry union is incomplete, so the desktop leg (9.21-B) can offer
      // resume rather than a dead end. Never folded back into ONBOARDING_STORE_FAULT.
      return failure("degraded_unavailable", "workspace scaffold incomplete — resume required", {
        retryable: true,
        cause: { code: "ONBOARDING_PARTIAL_SCAFFOLD" },
      });
    case "stored_row_schema_violation":
      // Task 9.36 — PERMANENTLY non-retryable (an out-of-band-corrupted row will not self-heal
      // on retry); distinct from ONBOARDING_STORE_FAULT so a caller never retries it forever.
      return failure("degraded_unavailable", "workspace record failed schema re-validation", {
        retryable: false,
        cause: { code: "ONBOARDING_STORED_ROW_SCHEMA_VIOLATION" },
      });
    case "store_fault":
      return failure("degraded_unavailable", "onboarding store unavailable", {
        retryable: true,
        cause: { code: "ONBOARDING_STORE_FAULT" },
      });
  }
}

// ── Router factory ──────────────────────────────────────────────────────────

/**
 * Build the onboarding router the integrator mounts at `appRouter.onboarding`.
 * `createWorkspace` is a tRPC `.mutation()` (onboarding MUTATES — it mints a workspace)
 * wrapped in the 8.2 `authedResolver` (auth gate + §16 typed boundary) and returns a
 * `Result<T, FailureVariant>` — never throws. Provisioning routes through the injected
 * `OnboardingCommandPort` (§7/§8 one-writer).
 */
export function buildOnboardingRouter(deps: OnboardingDeps) {
  const { onboarding } = deps;
  return router({
    /**
     * Create a workspace (§19.1 onboarding; §11 WS-6 first-run). Validates the candidate
     * input, provisions via the injected port (upsert config + fail-closed registry
     * union), and returns the UI-safe summary. Re-creating the same id is idempotent
     * (the composition path's contract). A fault surfaces a stable code (no raw cause).
     */
    createWorkspace: publicProcedure.input(passthroughInput).mutation(
      authedResolver<unknown, UiSafeProvisionedWorkspace>(
        async (_ctx, input): Promise<Result<UiSafeProvisionedWorkspace, FailureVariant>> => {
          const parsed = parseCreateWorkspace(input);
          if (!parsed.ok) return err(parsed.error);
          const res = await onboarding.provisionWorkspace(parsed.value);
          if (!res.ok) return err(provisionErrorToFailure(res.error));
          return ok({
            workspaceId: res.value.id,
            registryMember: res.value.registryMember,
            preset: res.value.preset,
          });
        },
      ),
    ),
  });
}
