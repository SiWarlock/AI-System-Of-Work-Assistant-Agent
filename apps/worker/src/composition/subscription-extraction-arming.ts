// 18.24 step-6 — the SINGLE default-OFF arming helpers that compose the staged 18.20–18.23 pieces into the
// owner's ENABLE bundle (DORMANT). Two pure helpers:
//
//   • gateSubscriptionExtraction(opts, deps) — the owner's step-6 BUILDER of the `ProviderTransportGate`:
//     armed ⇒ { providerTransport (subscription deps threaded + a short-TTL-memoized health source), route
//     (the cloud {runtime} subscription route) }; OFF (the shipped default) ⇒ `undefined` + ZERO dep-thunk
//     invocations (byte-equivalent — the factory-spy pin, L23/L27/L58). Reachability-WAIVERED (L11): the owner
//     ENABLE (step 6, HARD STOP) calls it — building it arms nothing.
//
//   • resolveSubscriptionArming(providerTransport, env) — the BOOT-side degrade decision. `config.providerTransport`
//     is the SINGLE arming signal (the SAME `isProviderTransportArmed` predicate `selectProviderRunner` reads —
//     one flip, no split-brain, L52). On the ARMED path a subscription-SHADOWING env var (a stale key / gateway
//     redirect) DEGRADES the arm (extraction stays LOCAL/unarmed = fail-closed, ZERO cloud extraction) + surfaces
//     a typed fault — it does NOT crash the worker (L52: degrade+surface, never boot-throw; a persisted armed
//     config + a later-set env var must not take the worker down on restart).
//
// ⛔ THIS SLICE DOES NOT ARM: the shipped default leaves `config.providerTransport` unset ⇒ `gateSubscriptionExtraction`
// is never called + `resolveSubscriptionArming` returns unarmed ⇒ byte-equivalent. The owner's step-6 flip (set
// `config.providerTransport` via this builder) + the first real run are the HARD LINES (owner+lead-gated).
import { isErr } from "@sow/contracts";
import type { ProviderRoute } from "@sow/contracts";
import {
  probeClaudeSubscriptionHealth,
  DEFAULT_EXTRACTION_BETAS,
  type ClaudeSubscriptionCompletion,
  type SubscriptionReachabilityCheck,
  type SubscriptionHealthVerdict,
  type HealthGateSources,
  type ProviderRunner,
} from "@sow/providers";
import {
  buildRealProviderTransportGate,
} from "./real-provider-transport-gate";
import {
  isProviderTransportArmed,
  type ProviderTransportGate,
  type RealProviderRunnerDeps,
} from "./provider-runner";
import { selectExtractionRoute, DEFAULT_EXTRACTION_MODEL } from "./extraction-route-gate";
import { createSubscriptionHealthSources } from "./subscription-health-sources";
import type { ExtractionContentResolver } from "./subscription-extraction-runner";
import {
  assertSubscriptionAuthEnv,
  type SubscriptionAuthFault,
} from "./subscription-auth-guard";

// ── gateSubscriptionExtraction — the owner step-6 gate BUILDER (dormant) ──────────────────────

/** The default short-TTL window (ms) the health probe is memoized over so one reachability check feeds
 *  BOTH HealthGateSources dimensions per gate evaluation (kills the double-probe, subscription-health-sources.ts:22). */
export const DEFAULT_HEALTH_PROBE_TTL_MS = 5_000;

/** The owner-set arming input (OWNER-CONFIG, never hardcoded — L2). Presence + STRICT `enabled === true` arms. */
export interface SubscriptionArmingOpts {
  /** STRICT `=== true` to arm; anything else ⇒ OFF (dormant, byte-equivalent). */
  readonly enabled?: boolean;
  /** The owner-configured extraction model id; defaults to `DEFAULT_EXTRACTION_MODEL` (re-confirm-at-flip). */
  readonly model?: string;
  /** SDK beta flags; defaults to `DEFAULT_EXTRACTION_BETAS`. */
  readonly betas?: readonly string[];
}

/** Injected collaborators — all THUNKS/values so the OFF path constructs NOTHING (factory-spy-pinned). */
export interface SubscriptionArmingDeps {
  /** The base run-leg deps `createRealProviderRunner` needs, MINUS `subscription` (this helper threads that in). */
  readonly runnerDeps: RealProviderRunnerDeps;
  /** The subscription completion client factory (`() => createClaudeSubscriptionCompletion()`). */
  readonly makeCompletion: () => ClaudeSubscriptionCompletion;
  /**
   * The content-resolution seam factory (fake in tests; the real `createRealExtractionContentResolver({reader})`
   * binds at ENABLE — its `reader` is a post-`assembleBackends` late-bind, see the #13 note in `boot.ts`).
   */
  readonly makeContentResolver: () => ExtractionContentResolver;
  /** The injected reachability check the health probe folds (fake in tests; the real fs/SDK check at ENABLE). */
  readonly checkReachable: SubscriptionReachabilityCheck;
  /** Injected numeric ms clock for the short-TTL health memoize (never `Date.now()` — the composition root injects it). */
  readonly now: () => number;
  /** Optional short-TTL override for the health memoize; defaults to {@link DEFAULT_HEALTH_PROBE_TTL_MS}. */
  readonly healthTtlMs?: number;
  /** Optional runner-factory override (test factory-spy); defaults inside `buildRealProviderTransportGate`. */
  readonly createRunner?: (deps: RealProviderRunnerDeps) => ProviderRunner;
}

/** The owner's step-6 wiring bundle — the gate (the single arming signal) + the armed cloud route. */
export interface SubscriptionArmingWiring {
  readonly providerTransport: ProviderTransportGate;
  readonly route: ProviderRoute;
}

/** Short-TTL memoize so one reachability probe feeds BOTH HealthGateSources dimensions per gate evaluation
 *  (item vi). A verdict is re-produced only after `ttlMs` elapses on the injected clock; a split/unhealthy
 *  verdict still fails closed downstream (no false-green, L52). */
function memoizeVerdict(
  produce: () => SubscriptionHealthVerdict,
  ttlMs: number,
  now: () => number,
): () => SubscriptionHealthVerdict {
  let cache: { readonly at: number; readonly verdict: SubscriptionHealthVerdict } | undefined;
  return () => {
    const t = now();
    if (cache !== undefined && t - cache.at < ttlMs) return cache.verdict;
    const verdict = produce();
    cache = { at: t, verdict };
    return verdict;
  };
}

/**
 * Compose the owner's step-6 bundle from the staged helpers. OFF guard FIRST + STRICT `=== true` on
 * `opts.enabled` (a truthy-not-`true` value ⇒ `undefined`, never arms — L28) ⇒ returns `undefined` with ZERO
 * dep-thunk invocations (byte-equivalent shipped default; factory-spy-pinned). Armed ⇒ the wiring bundle: the
 * `ProviderTransportGate` (subscription deps THUNKED so nothing constructs until `gate.make()`, the memoized
 * real health source riding `gate.healthSource` — never `config.healthSources`, L52) + the armed cloud route.
 * Pure; total.
 */
export function gateSubscriptionExtraction(
  opts: SubscriptionArmingOpts | undefined,
  deps: SubscriptionArmingDeps,
): SubscriptionArmingWiring | undefined {
  if (opts?.enabled !== true) return undefined;

  const model = opts.model ?? DEFAULT_EXTRACTION_MODEL;
  const betas = opts.betas ?? DEFAULT_EXTRACTION_BETAS;
  const ttlMs = deps.healthTtlMs ?? DEFAULT_HEALTH_PROBE_TTL_MS;

  // The real health source: a short-TTL-memoized probe folded into HealthGateSources. The memoize is at the
  // BINDING (not the pure wrap) so one `checkReachable` feeds both dimensions per gate evaluation (item vi).
  const memoProbe = memoizeVerdict(
    () => probeClaudeSubscriptionHealth({ checkReachable: deps.checkReachable }),
    ttlMs,
    deps.now,
  );
  const healthSource = (): HealthGateSources => createSubscriptionHealthSources(memoProbe);

  // Thread the subscription deps into the run-leg deps as THUNKS — nothing constructs until `gate.make()`.
  const runnerDeps: RealProviderRunnerDeps = {
    ...deps.runnerDeps,
    subscription: {
      completion: deps.makeCompletion,
      content: deps.makeContentResolver,
      model,
      betas,
    },
  };

  const providerTransport = buildRealProviderTransportGate({
    runnerDeps,
    healthSource,
    ...(deps.createRunner !== undefined ? { createRunner: deps.createRunner } : {}),
  });

  return { providerTransport, route: selectExtractionRoute(true) };
}

// ── resolveSubscriptionArming — the boot-side degrade decision (#2: degrade-arming, never boot-crash) ─────

/** The resolved arm decision boot acts on. `effectiveArmed` is the ONLY thing that arms the transport/route/
 *  ContextRef; a set shadowing var refuses the arm (`authRefused`) + carries the typed fault to surface. */
export interface SubscriptionArmingResolution {
  /** The raw arming signal (`isProviderTransportArmed` — the SAME predicate `selectProviderRunner` reads). */
  readonly armed: boolean;
  /** ARMED path + a subscription-shadowing env var set ⇒ the arm is refused (degrade to local). */
  readonly authRefused: boolean;
  /** `armed && !authRefused` — the effective arm boot uses to forward the transport + swap the route/ContextRef. */
  readonly effectiveArmed: boolean;
  /** The typed, code-only fault to surface (present iff `authRefused`; rule 7 — no env VALUE). */
  readonly authFault?: SubscriptionAuthFault;
}

/**
 * Resolve whether boot ACTUALLY arms the subscription extraction. `armed` is the single
 * {@link isProviderTransportArmed} signal (no split-brain, L52). On the armed path a subscription-shadowing env
 * var (a stale key / gateway redirect that would displace the ambient `claude` login) REFUSES the arm — the
 * result carries `effectiveArmed: false` + the typed fault so boot degrades to LOCAL/unarmed extraction
 * (fail-closed, ZERO cloud extraction) AND surfaces the fault loudly — NEVER a worker-wide boot-throw (L52:
 * degrade+surface). The unarmed default never consults env (byte-equivalent). Pure; total.
 */
export function resolveSubscriptionArming(
  providerTransport: ProviderTransportGate | undefined,
  env: Record<string, string | undefined> = process.env,
): SubscriptionArmingResolution {
  const armed = isProviderTransportArmed(providerTransport);
  const authResult = assertSubscriptionAuthEnv(armed, env);
  if (isErr(authResult)) {
    return { armed, authRefused: true, effectiveArmed: false, authFault: authResult.error };
  }
  return { armed, authRefused: false, effectiveArmed: armed };
}
