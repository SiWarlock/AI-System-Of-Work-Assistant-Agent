// 18.1 — the REAL ModelProviderPort transport bound into the broker's run leg,
// behind the default-OFF `config.providerTransport` dormancy gate.
//
// This is the worker-composition swap of `createStubProviderRunner`: a real
// `ProviderRunner` that resolves the matrix-vetted route → its providerId → the
// resolved `ModelProviderPort` adapter (a worker-local registry over the five DI-ready
// factories), drives `complete`, and maps ProviderOutput → AgentResult / ProviderError
// → GateDeny — NEVER throwing (§16; the broker awaits the run leg without a guard).
//
// SAFETY:
//   • the provider key resolves through the injected 17.3 lock-routing `getSecret`
//     accessor; a missing/locked key degrades to `auth_unavailable` ⇒ the job is HELD
//     RETRYABLE through the never-reject `KeychainLockController` (LIFE-6 re-drive) and a
//     keychain-locked HealthItem is minted by the accessor — NO plaintext fallback, NO
//     terminal reject (safety rule 7 / L21/L29);
//   • local (loopback) routes are validated against the explicit allowlist inside the
//     local adapters (safety rule 5 — zero-egress); an off-allowlist endpoint is rejected
//     `invalid_request` before any dispatch;
//   • the broker owns the fixed-order pipeline — the egress veto still runs BEFORE this
//     run leg (§7); binding the real runner changes no ordering.
//
// SAFE BUILD (dormant): the gate ships DEFAULT-OFF (`config.providerTransport` unset ⇒
// the byte-identical stub; L16/L27). The real runner is constructed + unit-tested against
// FAKE transports/facade — but the concrete network `HttpTransport` client + a real
// endpoint/key are the OWNER CROSSING (bound via the gate's `make` at that flip). Nothing
// here opens a socket, provisions a key, or spends.
import { ok, err, isOk } from "@sow/contracts";
import type { AgentJob, ProviderRoute, ProviderId } from "@sow/contracts";
import {
  createClaudeModelProvider,
  createOpenAiModelProvider,
  createOpenRouterModelProvider,
  createOllamaModelProvider,
  createLmStudioModelProvider,
  makeAgentResult,
  type ProviderRunner,
  type GateDeny,
  type EnforcedBudget,
  type JobBranch,
  type ModelProviderPort,
  type ProviderRequest,
  type ProviderError,
  type HttpTransport,
  type SecretsAccessor,
  type ProviderLogSink,
  type HealthGateSources,
} from "@sow/providers";
import { buildAuditSignal, type AuditSignal } from "@sow/policy";
import { createLockRoutingSecretsAccessor } from "../secrets/keychain-boot";
import { buildSecretRef, type KnownProvider } from "../secrets/secretRefConvention";
import type { KeychainLockController } from "../lifecycle/degraded/keychain-locked";

// ── the default-OFF dormancy gate (mirrors WriteTransportGate / selectAdapterTransport) ─

/**
 * The default-OFF owner gate for the real ModelProvider {@link ProviderRunner}. BOTH locks
 * are required to select the real runner, and each alone keeps it OFF (AND-composed
 * OFF-locks): `enabled` STRICTLY `=== true` AND `make` an owner-provisioned factory.
 * Absent/false either lock ⇒ the deterministic stub — so the shipped default (unset) is
 * BYTE-EQUIVALENT + fully dormant, and a real model call is enabled ONLY by deliberate
 * owner config, never a hardcoded call site (§19.5; safety-rule-adjacent). Mirrors
 * `WriteTransportGate`. The real factory ships UNBOUND.
 */
export interface ProviderTransportGate {
  /** STRICT `=== true` to arm the real runner; anything else ⇒ stub. */
  readonly enabled?: boolean;
  /** Owner-provisioned real-runner factory; unbound ⇒ stub (never invoked on OFF). */
  readonly make?: () => ProviderRunner;
  /**
   * Owner-provisioned real HEALTH/availability source (18.14/CP-4), AND-locked to this SAME
   * arming (one flip arms BOTH run + health — no split-brain). Selected by
   * {@link selectHealthSources} ONLY on the armed path; armed-but-unbound ⇒
   * {@link UNAVAILABLE_HEALTH_SOURCES} (fail-closed), NEVER the always-green stub.
   */
  readonly healthSource?: () => HealthGateSources;
}

/**
 * Select the broker's run-leg {@link ProviderRunner}, honouring the default-OFF gate.
 * Guard FIRST, STRICT `=== true` + `typeof make === "function"` (type-robust on BOTH
 * locks; a JSON-sourced config with a truthy-but-not-`true` `enabled` or a non-function
 * `make` fails CLOSED to the stub, never arms, never throws at boot). Shipped default
 * (`config.providerTransport` unset) ⇒ the EXACT stub instance — byte-equivalent + dormant.
 * The real factory is NEVER invoked on the OFF path. Mirrors `selectAdapterTransport`.
 */
export function selectProviderRunner(
  gate: ProviderTransportGate | undefined,
  stub: ProviderRunner,
): ProviderRunner {
  if (gate?.enabled === true && typeof gate.make === "function") {
    return gate.make();
  }
  return stub;
}

/**
 * A fail-closed {@link HealthGateSources} reporting the provider UNREACHABLE — the broker's
 * HEALTH gate DENIES (retryable) AND surfaces an OBS-2 System Health item. Selected on the
 * ARMED path when the owner armed the runner but did NOT provide a real `healthSource`: the
 * always-green stub is NEVER used under a real transport (that would false-green a
 * dead/unreachable provider), so an incomplete arming bundle fails CLOSED + LOUD (a
 * provider-unreachable deny with a health item), never a silent stub-green admit.
 */
export const UNAVAILABLE_HEALTH_SOURCES: HealthGateSources = Object.freeze({
  health: () => ({ state: "unreachable" as const }),
  // `availability` is NEVER consulted on this path — createHealthGate/evaluateEligibility
  // short-circuit on the non-healthy `unreachable` health dimension before availability is
  // read. It is set defensively fail-closed (modelPresent:false / failing) so even a future
  // consumer that reordered the dimensions would still DENY, never admit.
  availability: () => ({ modelPresent: false, conformanceStatus: "failing" as const }),
});

/**
 * Select the broker's HEALTH {@link HealthGateSources}, AND-LOCKED to the SAME default-OFF
 * arming as {@link selectProviderRunner} (one owner flip arms BOTH the run leg and the health
 * source — no split-brain where the transport is real but health stays stub-green). Guard
 * FIRST, STRICT `=== true` + `typeof make === "function"` (type-robust; a truthy-but-not-`true`
 * `enabled` fails CLOSED to the stub, never arms). Shipped default (`gate` unset/dormant) ⇒ the
 * EXACT `stub` instance — byte-equivalent + dormant, and the real `healthSource` factory is
 * NEVER invoked on the OFF path. On the ARMED path the always-green stub is NEVER used: the
 * owner-provisioned `healthSource` is selected, or — if the arming bundle omitted it —
 * {@link UNAVAILABLE_HEALTH_SOURCES} (fail-closed), so a real transport can never ride a
 * false-green health source. Mirrors {@link selectProviderRunner}.
 */
export function selectHealthSources(
  gate: ProviderTransportGate | undefined,
  stub: HealthGateSources,
): HealthGateSources {
  if (gate?.enabled === true && typeof gate.make === "function") {
    return typeof gate.healthSource === "function" ? gate.healthSource() : UNAVAILABLE_HEALTH_SOURCES;
  }
  return stub;
}

// ── the real runner ─────────────────────────────────────────────────────────────

/** Injected deps for the real run leg. All fakeable; no socket opened here. */
export interface RealProviderRunnerDeps {
  /** The injected model-layer HTTP transport (a FAKE in tests; the real fetch client is
   *  bound by the owner-crossing `make`). NEVER opened here. */
  readonly transport: HttpTransport;
  /** The 17.3 `getSecret` facade (buildKeychainSecrets); `undefined` ⇒ every resolve fails
   *  closed to `missing` (dormant — no creds, provider degrades). */
  readonly facade?: SecretsAccessor;
  /** The never-reject {@link KeychainLockController} (L21/L29): the lock ROUTER for the
   *  getSecret accessor AND the holder for a credential-degraded job. */
  readonly controller: KeychainLockController;
  /** The explicit loopback allowlist for local (ollama / lm_studio) routes (rule 5). */
  readonly allowedEndpoints: readonly string[];
  /** Injected wall clock (ISO-8601) — never Date.now(). */
  readonly now: () => string;
  /** Optional redacted provider-boundary log sink. */
  readonly logSink?: ProviderLogSink;
}

const RUNNER_ACTOR = "provider:runner" as const;
const RUNNER_MARKER = "provider:runner-decision" as const;

/** A redaction-safe run-leg audit signal — refs the job + a safe summary, never a secret. */
function runnerAudit(job: AgentJob, event: string, afterSummary: string): AuditSignal {
  return buildAuditSignal({
    actor: RUNNER_ACTOR,
    event,
    refs: [`ref:job:${job.id}`],
    payloadHash: RUNNER_MARKER,
    beforeSummary: "provider run leg",
    afterSummary,
  });
}

/**
 * Map a typed {@link ProviderError} to a {@link GateDeny}. Redaction-safe: the message
 * names the error KIND only (never the provider's own message — the adapter already
 * redacts, but the run-leg deny stays kind-only to be safe, rule 7). The retryable-branch
 * is derived from the error's own `retryable` flag (steers the broker's retryable/terminal
 * routing); a `cancelled` kind rides the distinct `provider_cancelled` reason.
 */
function denyFromProviderError(perr: ProviderError, job: AgentJob): GateDeny {
  const branch: JobBranch = perr.retryable ? "failed_retryable" : "failed_terminal";
  const reason =
    perr.kind === "cancelled"
      ? "provider_cancelled"
      : perr.kind === "auth_unavailable" || perr.kind === "model_unavailable"
        ? // a key/model that isn't available is a "provider unavailable" degrade (the
          // held-retryable credential path rides this), not a generic provider error.
          "provider_unavailable"
        : "provider_error";
  return {
    reason,
    message: `provider run failed (${perr.kind})`,
    audit: runnerAudit(job, "provider.run.failed", `provider run leg denied (${perr.kind})`),
    branch,
    retryable: perr.retryable,
  };
}

/** A fail-closed, terminal `provider_unavailable` deny (an unbound agentic leg / unknown
 *  provider / an unexpected fault) — redaction-safe, never retryable. */
function denyUnavailable(job: AgentJob, message: string): GateDeny {
  return {
    reason: "provider_unavailable",
    message,
    audit: runnerAudit(job, "provider.run.unavailable", message),
    branch: "failed_terminal",
    retryable: false,
  };
}

/** Build the resolved {@link ProviderRequest} from the vetted route + job + enforced budget.
 *  Input material is passed by REFERENCE (`contextRefs`) — never inlined (redaction-safe, 5.6). */
function buildProviderRequest(
  route: ProviderRoute,
  job: AgentJob,
  budget: EnforcedBudget,
): ProviderRequest {
  return {
    route,
    model: route.model,
    capability: job.capability,
    inputRefs: job.contextRefs,
    outputSchemaId: job.outputSchemaId,
    budget: {
      maxRuntimeSeconds: budget.maxRuntimeSeconds,
      ...(budget.maxCostUsd !== undefined ? { maxCostUsd: budget.maxCostUsd } : {}),
    },
    idempotencyKey: job.idempotencyKey,
  };
}

/**
 * Build the real ModelProviderPort run leg (§19.5). The worker-local registry binds each
 * of the five DI-ready adapters over the injected transport; cloud adapters resolve their
 * key through the 17.3 lock-routing accessor at the 17.4 `providers/<id>` secret-ref; local
 * adapters carry the loopback allowlist. Total — never throws across the boundary (§16).
 */
export function createRealProviderRunner(deps: RealProviderRunnerDeps): ProviderRunner {
  const { transport, facade, controller, allowedEndpoints, now, logSink } = deps;
  const logOpt = logSink !== undefined ? { logSink } : {};

  // The per-cloud-provider lock-routing getSecret accessor (17.3): a `locked` resolution
  // routes to controller.onKeychainLocked (mints the keychain-locked HealthItem) + returns
  // the fail-closed Err — NEVER a plaintext fallback (rule 7). `facade` unbound ⇒ every
  // resolve fails closed to `missing` (dormant, byte-equivalent).
  const secretsFor = (provider: ProviderId): SecretsAccessor =>
    createLockRoutingSecretsAccessor(facade, controller, provider, now);

  // The cloud secret-ref per the 17.4 convention (`keychain://providers/<providerId>`). A
  // known cloud provider always composes; a `null` is a composition-time misconfig (fail
  // fast, L39) — reached only on the armed path, never on the OFF default.
  const cloudSecretRef = (provider: KnownProvider): string => {
    const ref = buildSecretRef({ kind: "provider", provider });
    if (ref === null) {
      throw new Error(`provider-runner: no secret-ref for provider '${provider}'`);
    }
    return ref;
  };

  const registry = new Map<ProviderId, ModelProviderPort>([
    ["claude", createClaudeModelProvider({ transport, secrets: secretsFor("claude"), secretRef: cloudSecretRef("claude"), ...logOpt })],
    ["openai", createOpenAiModelProvider({ transport, secrets: secretsFor("openai"), secretRef: cloudSecretRef("openai"), ...logOpt })],
    ["openrouter", createOpenRouterModelProvider({ transport, secrets: secretsFor("openrouter"), secretRef: cloudSecretRef("openrouter"), ...logOpt })],
    ["ollama", createOllamaModelProvider({ transport, allowedEndpoints, ...logOpt })],
    ["lm_studio", createLmStudioModelProvider({ transport, allowedEndpoints, ...logOpt })],
  ]);

  return async (route, job, budget, signal) => {
    try {
      // Only a `provider`-branch (ModelProviderPort) route is bound in this slice; a
      // `runtime`-branch (AgentRuntimePort) route is the DORMANT agentic leg — fail closed
      // to a typed deny (never a silent no-op).
      if (!("provider" in route)) {
        return err(
          denyUnavailable(job, "agentic runtime route not bound in the safe-build model runner"),
        );
      }
      const providerId: ProviderId = route.provider;
      const port = registry.get(providerId);
      if (port === undefined) {
        return err(denyUnavailable(job, `no model adapter registered for provider '${providerId}'`));
      }

      const res = await port.complete(buildProviderRequest(route, job, budget), signal);
      if (isOk(res)) {
        const out = res.value;
        return ok({
          value: makeAgentResult({
            status: out.status,
            candidateOutput: out.candidateOutput,
            usage: out.usage,
            logs: out.logs,
          }),
        });
      }

      const perr = res.error;
      if (perr.kind === "auth_unavailable") {
        // The key is missing/locked — HOLD the job RETRYABLE through the never-reject
        // controller (LIFE-6 re-drive; the keychain-locked HealthItem was already minted by
        // the lock-routing accessor on a `locked` resolution). No plaintext, no terminal
        // reject (rule 7 / L21/L29). `holdJob` never rejects; its Result is not load-bearing here.
        await controller.holdJob(job.id, { subjectRef: providerId });
      }
      return err(denyFromProviderError(perr, job));
    } catch {
      // §16 — the run leg is TOTAL (the broker awaits it without a guard). A rogue throw
      // fails closed, redaction-safe (no cause echoed into the deny).
      return err(denyUnavailable(job, "provider run leg faulted"));
    }
  };
}
