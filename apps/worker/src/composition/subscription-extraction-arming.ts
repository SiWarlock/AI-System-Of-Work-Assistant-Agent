// 18.25 step-6 — the SINGLE default-OFF arming helpers that compose the staged 18.20–18.23 pieces into the
// owner's ENABLE bundle (DORMANT). Three pure helpers:
//
//   • gateSubscriptionOnlyExtraction(opts, deps) — the owner's step-6 BUILDER of the `ProviderTransportGate`:
//     armed ⇒ { providerTransport (subscription deps threaded + a short-TTL-memoized health source), route
//     (the cloud {runtime} subscription route) }; OFF (the shipped default) ⇒ `undefined` + ZERO dep-thunk
//     invocations (byte-equivalent — the factory-spy pin, L23/L27/L58). NO `RealProviderRunnerDeps` registry
//     dep (the eager-consumption ordering fix — `buildSubscriptionArmWiring` below is the boot-composition
//     seam that wires it over the late-bound reader holder). Reachability-WAIVERED (L11): the owner ENABLE
//     (step 6, HARD STOP) calls it — building it arms nothing.
//
//   • resolveSubscriptionArming(providerTransport, env) — the BOOT-side degrade decision. `config.providerTransport`
//     is the SINGLE arming signal (the SAME `isProviderTransportArmed` predicate `selectProviderRunner` reads —
//     one flip, no split-brain, L52). On the ARMED path a subscription-SHADOWING env var (a stale key / gateway
//     redirect) DEGRADES the arm (extraction stays LOCAL/unarmed = fail-closed, ZERO cloud extraction) + surfaces
//     a typed fault — it does NOT crash the worker (L52: degrade+surface, never boot-throw; a persisted armed
//     config + a later-set env var must not take the worker down on restart).
//
// ⛔ THIS SLICE DOES NOT ARM: the shipped default leaves `config.providerTransport` unset ⇒
// `gateSubscriptionOnlyExtraction` is never called + `resolveSubscriptionArming` returns unarmed ⇒
// byte-equivalent. The owner's step-6 flip (set `config.providerTransport` via this builder) + the first real
// run are the HARD LINES (owner+lead-gated).
//
// R18-c: the SIBLING full-registry builder `gateSubscriptionExtraction` (18.24) is DELETED — every non-test
// caller was already wired to this file's `gateSubscriptionOnlyExtraction` successor, and two arming helpers
// on the same rule-5 surface is exactly the split-brain shape 18.36 came from.
import { isErr } from "@sow/contracts";
import type { ProviderRoute } from "@sow/contracts";
import {
  probeClaudeSubscriptionHealth,
  DEFAULT_EXTRACTION_BETAS,
  type ClaudeSubscriptionCompletion,
  type SubscriptionReachabilityCheck,
  type SubscriptionHealthVerdict,
  type HealthGateSources,
} from "@sow/providers";
import {
  isProviderTransportArmed,
  type ProviderTransportGate,
} from "./provider-runner";
import { selectExtractionRoute, DEFAULT_EXTRACTION_MODEL } from "./extraction-route-gate";
import { createSubscriptionHealthSources } from "./subscription-health-sources";
import {
  createSubscriptionOnlyProviderRunner,
  type ExtractionContentResolver,
} from "./subscription-extraction-runner";
import {
  createRealExtractionContentResolver,
  createLateBoundParkedReader,
  type ReaderHolder,
} from "./real-extraction-content-resolver";
import {
  assertSubscriptionAuthEnv,
  type SubscriptionAuthFault,
} from "./subscription-auth-guard";

// ── gateSubscriptionOnlyExtraction — the SUBSCRIPTION-ONLY arm builder (18.25 step-6) ─────────────

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

/** Injected deps for {@link gateSubscriptionOnlyExtraction} — the subscription deps ONLY (no
 *  `RealProviderRunnerDeps`, so NONE of the post-`assembleBackends` registry deps are needed). */
export interface SubscriptionOnlyArmingDeps {
  /** The subscription completion client factory (`() => createClaudeSubscriptionCompletion()`). */
  readonly makeCompletion: () => ClaudeSubscriptionCompletion;
  /** The content-resolution seam factory — the arm wires `createRealExtractionContentResolver` over the
   *  late-bound reader holder (filled post-`assembleBackends`). */
  readonly makeContentResolver: () => ExtractionContentResolver;
  /** The injected reachability check the health probe folds (the real fs/SDK probe binds at the arm). */
  readonly checkReachable: SubscriptionReachabilityCheck;
  /** Injected numeric ms clock for the short-TTL health memoize (the composition root injects it). */
  readonly now: () => number;
  /** Optional short-TTL override; defaults to {@link DEFAULT_HEALTH_PROBE_TTL_MS}. */
  readonly healthTtlMs?: number;
}

/**
 * Compose the SUBSCRIPTION-ONLY owner arm bundle. Same OFF-guard contract as {@link gateSubscriptionExtraction}
 * (STRICT `enabled === true`; else `undefined` with ZERO thunk invocations — byte-equivalent). Armed ⇒ a
 * {@link ProviderTransportGate} whose `make` builds {@link createSubscriptionOnlyProviderRunner} (NO 5-provider
 * registry ⇒ NO post-`assembleBackends` `controller`/`now`/`transport` deps — the eager-consumption ordering
 * fix; only the content resolver's reader is late-bound via its holder) + the short-TTL-memoized health source
 * (rides `gate.healthSource`, never `config.healthSources` — L52) + the armed cloud route. Pure; total.
 */
export function gateSubscriptionOnlyExtraction(
  opts: SubscriptionArmingOpts | undefined,
  deps: SubscriptionOnlyArmingDeps,
): SubscriptionArmingWiring | undefined {
  if (opts?.enabled !== true) return undefined;

  const model = opts.model ?? DEFAULT_EXTRACTION_MODEL;
  const betas = opts.betas ?? DEFAULT_EXTRACTION_BETAS;
  const ttlMs = deps.healthTtlMs ?? DEFAULT_HEALTH_PROBE_TTL_MS;

  const memoProbe = memoizeVerdict(
    () => probeClaudeSubscriptionHealth({ checkReachable: deps.checkReachable }),
    ttlMs,
    deps.now,
  );
  const healthSource = (): HealthGateSources => createSubscriptionHealthSources(memoProbe);

  const providerTransport: ProviderTransportGate = {
    enabled: true,
    // THUNK — the runner + completion + content are constructed ONLY on `make()` (0× at build, factory-spy).
    make: () =>
      createSubscriptionOnlyProviderRunner({
        completion: deps.makeCompletion(),
        content: deps.makeContentResolver(),
        model,
        betas,
      }),
    healthSource,
  };

  return { providerTransport, route: selectExtractionRoute(true) };
}

// ── buildSubscriptionArmWiring — the boot-composition glue: gate over the late-bound reader holder ────────

/** The boot-composition deps for {@link buildSubscriptionArmWiring} — the collaborators available BEFORE
 *  `assembleBackends` (the durable reader is filled into `readerHolder` AFTER, by the caller). */
export interface SubscriptionArmWiringDeps {
  /** The mutable reader holder the caller fills POST-`assembleBackends` (`createReaderHolder()`). */
  readonly readerHolder: ReaderHolder;
  /** The subscription completion client factory (real: `() => createClaudeSubscriptionCompletion()`). */
  readonly makeCompletion: () => ClaudeSubscriptionCompletion;
  /** The injected reachability check the health probe folds (the real fs/SDK probe binds at the arm). */
  readonly checkReachable: SubscriptionReachabilityCheck;
  /** Injected numeric ms clock for the short-TTL health memoize. */
  readonly now: () => number;
}

/**
 * The single boot-composition seam for the subscription arm: it wires `makeContentResolver` as the real
 * {@link createRealExtractionContentResolver} over a {@link createLateBoundParkedReader} bound to the caller's
 * `readerHolder` (the eager-consumption ordering fix — the caller fills the holder after `assembleBackends`),
 * then builds the gate via {@link gateSubscriptionOnlyExtraction}. OFF (opt-in unset / not `enabled === true`)
 * ⇒ `undefined` (byte-equivalent — no gate, no holder use, zero thunk invocations). Pure; total.
 */
export function buildSubscriptionArmWiring(
  opts: SubscriptionArmingOpts | undefined,
  deps: SubscriptionArmWiringDeps,
): SubscriptionArmingWiring | undefined {
  return gateSubscriptionOnlyExtraction(opts, {
    makeCompletion: deps.makeCompletion,
    makeContentResolver: () =>
      createRealExtractionContentResolver({ reader: createLateBoundParkedReader(deps.readerHolder) }),
    checkReachable: deps.checkReachable,
    now: deps.now,
  });
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
