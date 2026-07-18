// 18.23 step 0 — the ANTHROPIC_API_KEY-unset armed-path guard (staged ENABLE; DORMANT).
//
// Option B runs extraction on the Claude SUBSCRIPTION (ambient local `claude` login). A set/stale
// ANTHROPIC_API_KEY SHADOWS the subscription profile by the Agent SDK's resolution precedence — so on the
// ARMED path the worker MUST run with it UNSET. This guard REFUSES fail-closed (a boot-visible typed error,
// NOT a silent raw-API fallback) when the key is set on the armed path.
//
// CO-GATED with arming (STRICT `=== true`): the default (unarmed) path NEVER reads env, so the shipped
// default is byte-equivalent — a worker that legitimately has a key set for other uses is unaffected until
// the owner arms. Rule 7: the fault is CODE-ONLY — the key VALUE is never read into the result.
//
// Reachability-WAIVERED (L11): NO production caller this slice — boot calls this on the armed path at the
// owner ENABLE (step 6, HARD STOP), alongside the route/health/transport arming (one flip).
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";

/** A redaction-safe fault (code-only; the env VALUE is NEVER surfaced — rule 7). */
export interface SubscriptionAuthFault {
  readonly code: "anthropic_key_set_on_armed_path";
}

/**
 * The credential env vars that SHADOW the subscription profile by the Agent SDK's resolution precedence
 * (a set env var here makes the SDK use that credential instead of the ambient `claude` subscription login).
 *
 * ⚠ INCOMPLETE-BY-DESIGN: `ANTHROPIC_API_KEY` is the arch-named + Context7-confirmed shadowing var. The SDK
 * recognizes OTHER credential/base-url overrides (e.g. `ANTHROPIC_AUTH_TOKEN`, gateway/base-url vars) that
 * can ALSO displace the subscription login — a missed one is a silent FAIL-OPEN. Enumerating the FULL set
 * against the LIVE Agent-SDK docs (claude-api / Context7) is a HARD flip precondition (#13, owner step-6);
 * extend this constant then. A `some()` over this set keeps the guard extensible without a logic change.
 */
export const SUBSCRIPTION_SHADOWING_ENV_KEYS = ["ANTHROPIC_API_KEY"] as const;

/**
 * On the ARMED subscription path, refuse fail-closed if ANY subscription-shadowing env var is set. STRICT
 * `=== true` on `armed` (a truthy-not-`true` value ⇒ unarmed, never reads env — L28); co-gated so the
 * default path is byte-equivalent. The refusal is a typed `Result` err (boot maps it to a boot-visible
 * fail-closed error, never a silent fallback — §16). Rule 7: the fault is code-only — no env VALUE is read
 * into the result. Pure apart from the injected/default env read; never throws.
 */
export function assertSubscriptionAuthEnv(
  armed: boolean,
  env: Record<string, string | undefined> = process.env,
): Result<void, SubscriptionAuthFault> {
  if (armed === true && SUBSCRIPTION_SHADOWING_ENV_KEYS.some((k) => env[k] !== undefined)) {
    return err({ code: "anthropic_key_set_on_armed_path" });
  }
  return ok(undefined);
}
