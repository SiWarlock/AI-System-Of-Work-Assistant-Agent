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

/** A redaction-safe fault (code-only; the env VALUE is NEVER surfaced — rule 7).
 *  NB: the `code` string is LEGACY (coined when the guard watched only `ANTHROPIC_API_KEY`); it now covers the
 *  full auth-shadowing + egress-redirect set below. Kept unchanged deliberately — a rename is a contract change
 *  for zero safety gain (the code is code-only + already redaction-safe). */
export interface SubscriptionAuthFault {
  readonly code: "anthropic_key_set_on_armed_path";
}

/**
 * The credential/base-url env vars that SHADOW the subscription profile by the Agent SDK's resolution
 * precedence (a set env var here makes the SDK use that credential/endpoint instead of the ambient `claude`
 * subscription login → wrong billing or redirected egress). The Agent SDK `query()` runs on Claude Code, so
 * Claude Code's auth/egress env vars apply.
 *
 * 18.28 — the FULL grounded set, now ENUMERATED (was deferred-to-flip in 18.24; this closes the
 * `/phase-exit 18` crossing-gate security-MEDIUM). Runbook `phase-18-subscription-enable-decision.md`
 * CHECKPOINT-1 RESULT; Context7 `/nothflare/claude-agent-sdk-docs`:
 *   • Class A — auth-shadowing (WHICH auth/provider): `ANTHROPIC_API_KEY` (the arch-named primary),
 *     `ANTHROPIC_AUTH_TOKEN` (custom bearer), `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` (switch to
 *     AWS Bedrock / GCP Vertex — a different provider/auth/egress).
 *   • Class B — egress-redirect (content could go elsewhere / be intercepted): `ANTHROPIC_BASE_URL`,
 *     `ANTHROPIC_API_URL` (proxy/base-url redirect — a proxy can inspect/inject creds),
 *     `ANTHROPIC_CUSTOM_HEADERS` (injects arbitrary request headers the SDK forwards — an auth/egress override),
 *     and the standard proxy vars that route ALL traffic through a proxy — `HTTP_PROXY` / `HTTPS_PROXY` /
 *     `ALL_PROXY`, enumerated in BOTH cases (`http_proxy` / `https_proxy` / `all_proxy`) because Node/undici
 *     (`EnvHttpProxyAgent`) + `proxy-from-env` honor the lowercase forms too — a missed case is a silent
 *     fail-OPEN. `NO_PROXY` / `no_proxy` are DELIBERATELY EXCLUDED: a bypass allowlist is not a redirect, so
 *     watching it would false-positive-DEGRADE a legitimate config (do not "helpfully" add it).
 * A `some()` over this set keeps the guard extensible without a logic change (L61); over-inclusion is the
 * fail-safe direction (a watched var the SDK doesn't honor only degrades the owner-gated armed path).
 *
 * ⚠ NOT covered here — the `apiKeyHelper` CAVEAT: Claude Code's `apiKeyHelper` *settings* entry can inject an
 * API key BYPASSING env. The owner MUST confirm the deployment's Claude Code settings carry no
 * `apiKeyHelper` / API-key injection (a #13 owner step-6 precondition — an out-of-band settings check, not an
 * env var this guard can see). A final re-verify of this set against the LIVE Agent-SDK docs at the flip stays
 * a HARD precondition (the SDK's honored set can change) — and reconsider borderline TLS-interception ENABLERS
 * there (e.g. `NODE_EXTRA_CA_CERTS`, which alone redirects nothing but lets a rogue CA decrypt a proxy tunnel;
 * inert unless a now-watched proxy var is also set) — but the guard no longer ships a known-incomplete set.
 */
export const SUBSCRIPTION_SHADOWING_ENV_KEYS = [
  // Class A — auth-shadowing:
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  // Class B — egress-redirect (both proxy cases — Node honors lowercase; NO_PROXY excluded, see above):
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

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
