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
 * 18.38 — RE-GROUNDED against the SDK-BUNDLED claude-code binary (v2.1.201 — the ACTUAL runtime the Agent SDK
 * `@anthropic-ai/claude-agent-sdk` `query()` spawns; verified via the bundled `manifest.json` + `--version`). The
 * standalone `claude` CLI is a SEPARATE, newer artifact (v2.1.216 at grounding time) — do NOT ground on it. A
 * repo-source `strings` re-ground of the shipped binary + a claude-code-guide cross-check vs live docs found
 * 18.37's PUBLIC-DOCS grounding (13→30) under-covered the shipped surface a THIRD time (worker L72: ground against
 * the AUTHORITATIVE RUNTIME-BUNDLED binary, not public docs). Extended 30 → 81 over two Step-8 security re-grounds
 * (the host-managed auth cluster, then a FULL bare-`CLAUDE_` (non-`CLAUDE_CODE_`) namespace sweep that found the
 * OAuth-base/bridge/config-dir redirects + the `CLAUDE_ENV_FILE` dotenv BYPASS). ⛔ This DENYLIST is structurally
 * leaky for a rule-5 egress invariant (a process.env scan can't see a `CLAUDE_ENV_FILE`-injected key) — it ships
 * here as DEFENSE-IN-DEPTH ONLY; completeness-by-construction is the MANDATORY spawn-env allowlist (task 18.40,
 * a HARD §ARM-18 precondition before ANY real vault). SINGLE-SOURCED —
 * `assertSubscriptionAuthEnv` (the `process.env` guard) AND 18.36's `subscription-settings-guard` settings-`env`
 * leg both consume it, so one edit hardens both.
 *   • Class A — auth-shadowing (WHICH auth/provider):
 *     — direct tokens + credential-indirection channels: `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
 *       `CLAUDE_CODE_OAUTH_TOKEN` (+ its `_FILE_DESCRIPTOR` / `_REFRESH_TOKEN` variants), `CLAUDE_CODE_API_KEY_FILE_
 *       DESCRIPTOR`, `ANTHROPIC_IDENTITY_TOKEN`(`_FILE`) — the `*_FILE`/`_FILE_DESCRIPTOR` forms are the easiest
 *       way a credential slips past a name-prefix scan (grounded + corroborated). 18.38 Step-8 re-ground add:
 *       `CLAUDE_API_KEY` (brand alias) + the host-managed auth cluster `CLAUDE_CODE_HFI_BEARER_TOKEN` /
 *       `_SESSION_ACCESS_TOKEN` / `_HOST_CREDS_FILE` / `_HOST_AUTH_ENV_VAR` / `_WEBSOCKET_AUTH_FILE_DESCRIPTOR`
 *       (the cluster the mandatory security-reviewer caught still-unwatched in the same 2.1.201 binary).
 *     — provider / gateway / router / host SWITCHES: `_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` / `_MANTLE` / `_ANTHROPIC_AWS`
 *       (the 5 grounded in claude-code `_HAS_3P_PROVIDER_AT_LOAD`), the `_USE_GATEWAY` + CCR-router `_USE_CCR_V2`
 *       redirect switches, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` (host-provisioned-auth switch — activates the
 *       HOST_AUTH_* cluster above; watch-the-switch, L72), and `_USE_ANTHROPIC_GOOGLE_CLOUD` (the GCP first-party analog of `_ANTHROPIC_AWS` —
 *       FORWARD-safety: absent in the 2.1.201 runtime, present in 2.1.216; over-inclusion is fail-safe). ⭐ L72: the
 *       REAL 2.1.201 fail-open this closes is the DIRECT unwatched vars (gateway/CCR/skip-auth/identity-token/
 *       key-FD/oauth-refresh/redirects); watching EVERY switch is ALSO what keeps the generic-cred exclusion sound.
 *     — SKIP-auth gateway-handoff signals `CLAUDE_CODE_SKIP_{BEDROCK,VERTEX,FOUNDRY,MANTLE,ANTHROPIC_AWS,
 *       ANTHROPIC_GOOGLE_CLOUD}_AUTH`: a "provider creds held by a gateway, don't sign" flag ⇒ leaving the subscription.
 *     — by-presence provider creds: `ANTHROPIC_AWS_API_KEY`/`_AWS_AUTH`, `ANTHROPIC_FOUNDRY_API_KEY`/`_AUTH_TOKEN`,
 *       `ANTHROPIC_BEDROCK_MANTLE_API_KEY`, `ANTHROPIC_GOOGLE_CLOUD_AUTH`, `ANTHROPIC_ENVIRONMENT_KEY`,
 *       `ANTHROPIC_PROFILE` (auth-profile selector — 18.38 Step-8), `AWS_BEARER_TOKEN_BEDROCK` (no
 *       `ANTHROPIC_`/`CLAUDE_CODE_` prefix — matched explicitly), `CCR_OAUTH_TOKEN_FILE`.
 *   • Class B — egress-redirect: `ANTHROPIC_BASE_URL` (the real redirect defense) + `ANTHROPIC_API_URL` (legacy
 *     alias, kept harmless), `CLAUDE_CODE_API_BASE_URL` / `_GB_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, the
 *     per-provider base-URLs (`_BEDROCK_` / `_VERTEX_` / `_FOUNDRY_` / `_AWS_` / `_GOOGLE_CLOUD_` /
 *     `_BEDROCK_MANTLE_ BASE_URL` + `_FOUNDRY_RESOURCE`), `CLAUDE_CODE_CUSTOM_OAUTH_URL`,
 *     `CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` (suppresses the first-party assumption), `ANTHROPIC_UNIX_SOCKET`
 *     (transport → local socket), `ANTHROPIC_CONFIG_DIR` (credential/config-DIR redirect — see the note below),
 *     and the proxy vars in BOTH cases (Node/undici honor lowercase; a missed case = silent fail-OPEN) + the
 *     CC-namespaced `CLAUDE_CODE_PROXY_URL` / `_PROXY_HOST` / `_HTTP_PROXY` / `_HTTPS_PROXY`.
 *   • Class C — mTLS client identity: `CLAUDE_CODE_CLIENT_CERT` / `_CLIENT_KEY` / `_CLIENT_KEY_PASSPHRASE` +
 *     `_CERT_STORE` (a custom cert store): change the client identity → mTLS to a custom endpoint when paired with a redirect.
 * A `some()` over this set keeps the guard extensible without a logic change (L61); over-inclusion is the
 * fail-safe direction (a watched var the SDK doesn't honor only degrades the owner-gated armed path).
 *
 * ⚠ `ANTHROPIC_CONFIG_DIR` follow-up: a set value ALSO relocates where the settings hierarchy / `.credentials.json`
 * resolve. 18.36's `readClaudeCodeSettings` honors `CLAUDE_CONFIG_DIR` for the user tier but not this Anthropic-CLI
 * analog — watching it HERE degrades the arm on presence, but a settings-guard-reads-from-a-redirected-dir
 * hardening is a separate follow-up. The two settings-FILE relocation env vars `CLAUDE_CODE_MANAGED_SETTINGS_PATH`
 * / `CLAUDE_CODE_REMOTE_SETTINGS_PATH` are DELIBERATELY NOT in this env set — they're routed to task 18.39 (the
 * settings-reader must honor the relocation, else a relocated managed-settings.json injecting `apiKeyHelper` is
 * invisible). ⚠ gate-4 op-prereq: `ANTHROPIC_CONFIG_DIR` / `ANTHROPIC_PROFILE` (and the 18.39 SETTINGS_PATH vars)
 * will REFUSE the arm if the SoW deployment legitimately sets them — ensure UNSET on the armed run (no exposure).
 *
 * ⚠ DELIBERATELY EXCLUDED (each does NOT shadow BY PRESENCE ALONE — watching them would permanently FALSE-degrade
 * a legit armed config, the L65 `NO_PROXY`-class): `NO_PROXY`/`no_proxy` (a bypass allowlist, not a redirect);
 * `NODE_EXTRA_CA_CERTS` (a TLS-interception enabler but inert ALONE — redirects nothing unless a watched proxy/
 * base-url is ALSO set — a re-verify note, not watched); the COMMON generic cloud creds `AWS_ACCESS_KEY_ID`/
 * `AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`/`AWS_PROFILE`/`GOOGLE_APPLICATION_CREDENTIALS`/`GCLOUD_PROJECT`/
 * `GOOGLE_CLOUD_PROJECT` — and the AWS/GCP-SDK credential-RESOLUTION vars AS A CLASS (`AWS_CONTAINER_CREDENTIALS_*`,
 * `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, `GOOGLE_EXTERNAL_ACCOUNT_*`, `GOOGLE_TOKEN_INFO_URL`) —
 * inert unless a `USE_*`/skip switch is set, and EVERY provider switch is watched above
 * (⭐ L72 load-bearing: the AWS creds activate under Bedrock/Mantle/ANTHROPIC_AWS, the GOOGLE creds under Vertex/
 * ANTHROPIC_GOOGLE_CLOUD — all watched, so the whole cloud-SDK cred class is soundly excluded); and routing/project-IDs/regions
 * (`ANTHROPIC_VERTEX_PROJECT_ID`/`_AWS_WORKSPACE_ID`/`_WORKSPACE_ID`/`_GOOGLE_CLOUD_PROJECT`/`_GOOGLE_CLOUD_LOCATION`/
 * `_GOOGLE_CLOUD_WORKSPACE_ID`/`CLOUD_ML_REGION` — carry no credential, redirect nothing).
 *
 * ⚠ NOT env-var reachable (backstopped elsewhere): `apiKeyHelper` (a SETTINGS key, above the subscription) —
 * covered by 18.36's `SETTINGS_INJECTION_FIELDS`; the `managed-settings.d/*.json` drop-in fragments the runtime
 * ALSO reads are a settings-reader gap closed by task 18.39; a Claude-apps GATEWAY session outranks even the
 * switches with no single env var (a §ARM-18 deployment-checklist residual). ⛔ A final re-verify vs whichever
 * claude-code version the SDK BUNDLES at the flip stays a HARD precondition (the honored set shifts by version —
 * this ground is 2.1.201; e.g. 2.1.216 adds the GCP provider family already watched here).
 */
export const SUBSCRIPTION_SHADOWING_ENV_KEYS = [
  // Class A — auth-shadowing: direct tokens + credential-indirection channels (the *_FILE(_DESCRIPTOR) variants
  // are the easiest way a credential slips past a name-prefix scan — grounded + corroborated).
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  // Class A — host-managed auth cluster (18.38 Step-8 security re-ground): bearer/access tokens, a creds-file, an
  // auth-env-var indirection, and a websocket auth FD — all supply auth OTHER than the ambient subscription.
  "CLAUDE_CODE_HFI_BEARER_TOKEN",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
  // Class A — provider / gateway / router / host switches (⭐ L72: watching EVERY switch keeps the generic-cred
  // exclusion sound; PROVIDER_MANAGED_BY_HOST activates the HOST_AUTH_* family — watch-the-switch).
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_CCR_V2",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  // Class A — SKIP-auth gateway-handoff signals ("provider creds held by a gateway, don't sign" ⇒ leaving the subscription).
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
  // Class A — by-presence provider credentials (Anthropic-namespaced / Bedrock bearer / CCR-router token).
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_AUTH",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_BEDROCK_MANTLE_API_KEY",
  "ANTHROPIC_GOOGLE_CLOUD_AUTH",
  "ANTHROPIC_ENVIRONMENT_KEY",
  "ANTHROPIC_PROFILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CCR_OAUTH_TOKEN_FILE",
  // Class B — egress-redirect (both proxy cases — Node honors lowercase; NO_PROXY excluded, see above):
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_URL",
  "CLAUDE_CODE_API_BASE_URL",
  "CLAUDE_CODE_GB_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  "CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  "ANTHROPIC_UNIX_SOCKET",
  "ANTHROPIC_CONFIG_DIR",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "CLAUDE_CODE_PROXY_URL",
  "CLAUDE_CODE_PROXY_HOST",
  "CLAUDE_CODE_HTTP_PROXY",
  "CLAUDE_CODE_HTTPS_PROXY",
  // ── bare-CLAUDE_ namespace (18.38 Step-8 re-verify — the mandatory security-reviewer's cross-namespace sweep;
  //    the denylist's structural leak. Completeness-by-construction lands in 18.40 env-scrub; these close the known
  //    bare-CLAUDE_ cred/redirect/switch surface as defense-in-depth):
  "CLAUDE_ENV_FILE", // dotenv pointer → injects arbitrary env into query()'s child, invisible to a process.env scan (a BYPASS)
  "CLAUDE_AI_AUTHORIZE_URL",
  "CLAUDE_AI_ORIGIN",
  "CLAUDE_LOCAL_OAUTH_API_BASE",
  "CLAUDE_LOCAL_OAUTH_APPS_BASE",
  "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
  "CLAUDE_BRIDGE_BASE_URL",
  "CLAUDE_BRIDGE_SESSION_INGRESS_URL",
  "CLAUDE_BRIDGE_OAUTH_TOKEN",
  "CLAUDE_BRIDGE_USE_CCR_V2",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  // Class C — mTLS client certs + cert-store (change the client identity → mTLS to a custom endpoint w/ a redirect):
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  "CLAUDE_CODE_CERT_STORE",
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
