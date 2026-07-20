// 18.35 — the pure `resolveArmCheckReachable` resolver: bind the real SPEND-FREE subscription reachability
// probe into bootWorker's `checkReachable` ONLY behind a NEW, INDEPENDENT reachability-enable OFF-lock.
//
// The last unbound §ARM-18 arm seam. `probeSubscriptionReachability` (@sow/providers, 18.26) + the macOS
// Keychain-PRESENCE detector `detectClaudeKeychainLogin` (18.25) both exist but bind in NO production path —
// so today the ENABLE needs a CODE patch, not a config flip. This resolver makes the eventual arming a clean
// one-step crossing: it returns the real spend-free probe thunk IFF the subscription arm is enabled AND the
// reachability-enable signal is present; otherwise `FAIL_CLOSED_REACHABILITY` (HEALTH UNAVAILABLE), byte-
// equivalent to today. So an env-only subscription arm (`enabled:true` alone) STAYS HEALTH-denied BY DESIGN —
// the reachability-enable is a distinct OFF-lock (L8/27/52/68), and the FLIP stays owner+lead-gated.
//
// SPEND-FREE (the probe is Keychain PRESENCE `-s`, no `-w`, + SDK module-RESOLVABILITY — no query()/completion,
// provider L10) + NO egress + NO key provisioning. Reachability-WAIVERED (L11): the boot bind is exercised by
// typecheck + `/wired`; the resolver's contract is pinned by the sibling unit suite. Building this arms NOTHING.
import { probeSubscriptionReachability, type SubscriptionReachability, type SubscriptionReachabilityCheck } from "@sow/providers";
import { detectClaudeKeychainLogin } from "./claude-keychain-login";

/** The owner-set reachability-enable env var (Option A — read at the boot root; the worker child inherits main's
 *  `process.env`, index.ts:134 forks with no `env` filter). Single-sourced (L5/L37) so boot.ts + the desktop
 *  `.env`-allowlist follow-up reference one literal. Independent of `SOW_SUBSCRIPTION_ARM` — a distinct OFF-lock. */
export const REACHABILITY_LIVE_ENV_VAR = "SOW_SUBSCRIPTION_REACHABILITY_LIVE";

/**
 * The resolver's fail-closed floor: a reachability check that yields `undefined` ⇒ HEALTH UNAVAILABLE (never a
 * false-green, L52). This is the shipped-default value and the every-non-armed-path value; moving it here (from
 * boot.ts) makes it the resolver's own floor + preserves the referential identity the OFF-path pins assert.
 */
export const FAIL_CLOSED_REACHABILITY: SubscriptionReachabilityCheck = () => undefined;

/**
 * The PRODUCTION defaults the resolver's `deps` fall back to on the armed+enabled path. The `detectLogin`
 * default MUST be the live macOS Keychain-PRESENCE detector `detectClaudeKeychainLogin` — NOT 18.26's file-path
 * `detectClaudeLogin`, which fails closed on macOS BY DESIGN (provider L10); defaulting to the file-path detector
 * would leave the armed+enabled path silently HEALTH-denied FOREVER (fail-SAFE, so an injected-deps test can't
 * catch it — hence the referenceable constant + its identity pin). Exposed so that pin needs no I/O.
 */
export const ARM_REACHABILITY_DEFAULTS = {
  probe: probeSubscriptionReachability,
  detectLogin: detectClaudeKeychainLogin,
} as const;

/** The plain-data arming slice this resolver reads — the subset of `BootConfig.subscriptionArm` it needs: the
 *  `enabled` OFF-guard axis + the explicit `checkReachable` test/-live injection seam (Q3, preserved). */
export interface SubscriptionArmReachabilityInput {
  readonly enabled?: boolean;
  readonly checkReachable?: SubscriptionReachabilityCheck;
}

/** Injected primitives (fakeable spies in tests; the real spend-free defaults are {@link ARM_REACHABILITY_DEFAULTS}).
 *  Both are wired into the returned thunk ONLY on the armed+enabled path — never touched on any fail-closed path. */
export interface ArmCheckReachableDeps {
  /** The spend-free reachability probe (defaults to {@link ARM_REACHABILITY_DEFAULTS.probe}). */
  readonly probe?: (deps: { readonly detectLogin: () => boolean }) => SubscriptionReachability;
  /** The login-presence detector folded into the probe (defaults to {@link ARM_REACHABILITY_DEFAULTS.detectLogin}). */
  readonly detectLogin?: () => boolean;
}

/** Strict opt-in: only the exact tokens arm — never a truthy-coerce (mirrors the sibling `SOW_SUBSCRIPTION_ARM`
 *  read; worker L28). A `"false"`/`"0"`/`""`/arbitrary-truthy/non-string value ⇒ NOT enabled. */
function isReachabilityLiveEnabled(raw: string | undefined): boolean {
  return raw === "1" || raw === "true";
}

/**
 * Resolve the effective `checkReachable` for the subscription arm. Order (fail-closed by construction):
 *   1. an explicitly injected `checkReachable` (the test/-live seam) WINS — preserves the existing inject-a-fake
 *      pathway boot reads via `config.subscriptionArm?.checkReachable` (Q3);
 *   2. OFF-guard FIRST (AND-lock, L57) — a disabled/absent arm ⇒ `FAIL_CLOSED_REACHABILITY`, regardless of the
 *      signal (a reachability signal can NEVER arm a disabled gate; the OFF guard precedes the signal read);
 *   3. STRICT enable-signal (L28) — only `"1"`/`"true"` arms; anything else ⇒ `FAIL_CLOSED_REACHABILITY`;
 *   4. armed AND enabled ⇒ construct the real spend-free probe thunk (the probe/detector wired ONLY here — the
 *      OFF path constructs NOTHING, so the shipped default is byte-equivalent to today, L23/L27).
 * Pure; total. Building/returning the thunk performs NO I/O — the probe runs only when the health gate invokes it.
 */
export function resolveArmCheckReachable(
  subscriptionArm: SubscriptionArmReachabilityInput | undefined,
  enableSignal: string | undefined,
  deps: ArmCheckReachableDeps = {},
): SubscriptionReachabilityCheck {
  if (subscriptionArm?.checkReachable !== undefined) return subscriptionArm.checkReachable;
  if (subscriptionArm?.enabled !== true) return FAIL_CLOSED_REACHABILITY;
  if (!isReachabilityLiveEnabled(enableSignal)) return FAIL_CLOSED_REACHABILITY;
  const probe = deps.probe ?? ARM_REACHABILITY_DEFAULTS.probe;
  const detectLogin = deps.detectLogin ?? ARM_REACHABILITY_DEFAULTS.detectLogin;
  return () => probe({ detectLogin });
}
