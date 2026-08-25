// 18.34 — native ALLOWLISTED .env loading for Electron main.
//
// Pure + electron-free so it compiles under tsconfig.node.json and no window/electron import reaches a test
// (apps/desktop LESSONS §3). Parses .env CONTENTS (the caller does the fs read + applies the plan) and returns
// ONLY the recognized SOW_* config vars to hydrate + a classified skip list. Replaces dev.sh's blanket
// `source .env` (which would hydrate ANY key, incl. secrets/shadowing vars).
//
// SAFETY (ARCHITECTURE §5/§16): the gate is the SOW_* ALLOWLIST. A subscription-shadowing / egress-redirect
// var or a secret is not `SOW_*`, so it is STRUCTURALLY never hydrated — a plaintext .env cannot shadow the
// Claude subscription, redirect egress, or auto-load a secret (Keychain stays the sole secret path). This is
// defense-in-depth over the armed-boot guard `assertSubscriptionAuthEnv` (worker-side). Existing process.env
// WINS (a real shell/CI export beats .env). Warnings name the KEY only — never a value (rule 7).

/** The recognized SOW_* config allowlist — the ONLY keys this loader hydrates. Keep in sync with the
 *  `process.env["SOW_*"]` reads in main/index.ts (startWorker) + worker-host/index.ts (SOW_MANAGE_TEMPORAL,
 *  read in the forked child which inherits main's process.env). No shadowing var or secret is `SOW_*`. */
export const RECOGNIZED_SOW_ENV_KEYS: readonly string[] = [
  "SOW_MANAGE_TEMPORAL",
  "SOW_TEMPORAL_ADDRESS",
  "SOW_VAULT_ROOT",
  "SOW_INGEST_WATCH",
  "SOW_INGEST_WORKSPACE",
  "SOW_WORKER_NODE",
  "SOW_SUBSCRIPTION_ARM",
  "SOW_SUBSCRIPTION_MODEL",
  "SOW_EGRESS_ALLOWED_PROCESSORS",
  "SOW_SUBSCRIPTION_REACHABILITY_LIVE",
];

// The subscription-shadowing / egress-redirect env set, MIRRORED verbatim (same order, same section
// comments) from the canonical source `apps/worker/src/composition/subscription-auth-guard.ts`
// (`SUBSCRIPTION_SHADOWING_ENV_KEYS`). It is a MIRROR, not a runtime import — `@sow/worker`'s
// `subscription-auth-guard.ts` does `import { ok, err } from "@sow/contracts"` (the BARREL, not a deep
// path), and a runtime `@sow/worker` import into the Electron main tier would drag that barrel's zod/ajv
// graph into the bundle, tripping the 9.18 bundle-leanness regression guard
// (`test/bundle/main-bundle-resolution.test.ts` — asserts the emitted main bundle has no `require("zod")`/
// `require("ajv")`); externalizing it instead reproduces the exact 9.18 raw-`.ts`-`require` crash (LESSONS
// §17). So this stays a plain-data copy, used ONLY for the ESCALATED warning — never the gate.
//
// ⚠ Drift note: this set affects ONLY the warning SPECIFICITY, NEVER the gate — the gate is (and stays) the
// `RECOGNIZED_SOW_ENV_KEYS` allowlist above, so a stale copy here merely downgrades a shadowing key's
// `skipped[].reason` from `"shadowing"` to `"not_recognized"`; the key is still skipped (not on the SOW_*
// allowlist) and still never hydrated — behavior is unchanged for every key. Drift is caught NOT by this
// comment but by `test/main/dotenv-shadowing-parity.test.ts`, which imports the canonical worker export
// directly (a test file, never bundled into main, so it carries no bundle-leanness constraint) and asserts
// set-equality against this mirror both ways.
export const DESKTOP_SUBSCRIPTION_SHADOWING_ENV_KEYS: readonly string[] = [
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
];

/** Why a parsed .env key was NOT hydrated. Carries the KEY only — never a value (rule 7). */
export type SkipReason = "not_recognized" | "shadowing" | "already_set";
export interface SkippedEntry {
  readonly key: string;
  readonly reason: SkipReason;
}
export interface DotenvLoadResult {
  /** Recognized SOW_* keys (not already set in the env) → their .env values, for the caller to apply. */
  readonly hydrate: Record<string, string>;
  /** Every parsed key that was NOT hydrated, with its reason (drives the caller's skip/warn). */
  readonly skipped: readonly SkippedEntry[];
}

/**
 * Minimal, dependency-free `.env` parser (no `dotenv`): `KEY=VALUE` per line, split on the FIRST `=`, key +
 * value trimmed, one pair of matching surrounding quotes stripped, blank lines + FULL-LINE `#` comments
 * skipped, an optional leading `export ` dropped. Last value wins on a duplicate key. An EMPTY value (`KEY=`
 * or `KEY=""`) is treated as UNSET (not emitted) — so a blank line-value can't clobber a consumer's `?? default`
 * with `""` (e.g. `SOW_VAULT_ROOT=` → the default vault path, not an empty root). An inline `#` is NOT a comment
 * (it stays part of the value — quote or omit it). Not safety-load-bearing — the SOW_* allowlist is the gate,
 * so a parse quirk can never hydrate a shadowing key. Accumulates into a null-prototype object so a hostile
 * `__proto__=`/`constructor=` line lands as an inert own key (surfaced as a `not_recognized` skip), never a
 * prototype mutation.
 */
function parseDotenv(contents: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    if (key === "") continue;
    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value === "") continue; // an empty value is "unset", not `""` (don't clobber a consumer's default)
    out[key] = value;
  }
  return out;
}

/**
 * Compute the allowlisted hydrate plan from `.env` contents. `undefined` contents (absent/unreadable .env) ⇒
 * a no-op plan. Pure: touches neither `process.env` nor the filesystem — the caller reads the file and applies
 * `hydrate`. A recognized SOW_* key already present in `existingEnv` is skipped `already_set` (existing wins);
 * any other key is skipped `shadowing` (if in the inlined shadowing set) or `not_recognized`.
 */
export function loadAllowlistedDotenv(
  contents: string | undefined,
  existingEnv: NodeJS.ProcessEnv,
): DotenvLoadResult {
  if (contents === undefined) return { hydrate: {}, skipped: [] };
  const parsed = parseDotenv(contents);
  const hydrate: Record<string, string> = {};
  const skipped: SkippedEntry[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!RECOGNIZED_SOW_ENV_KEYS.includes(key)) {
      skipped.push({
        key,
        reason: DESKTOP_SUBSCRIPTION_SHADOWING_ENV_KEYS.includes(key) ? "shadowing" : "not_recognized",
      });
      continue;
    }
    if (existingEnv[key] !== undefined) {
      skipped.push({ key, reason: "already_set" });
      continue;
    }
    hydrate[key] = value;
  }
  return { hydrate, skipped };
}
