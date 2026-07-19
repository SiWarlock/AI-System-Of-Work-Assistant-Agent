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
];

// The subscription-shadowing / egress-redirect env set, INLINED verbatim from the canonical source
// `apps/worker/src/composition/subscription-auth-guard.ts:56` (`SUBSCRIPTION_SHADOWING_ENV_KEYS`). It is not
// barrel-exported from `@sow/worker`, and a deep import would drag a node-heavy worker edge into the main tier
// (LESSONS §5) — so it is copied here for the ESCALATED warning only. ⚠ Drift note: this set affects ONLY the
// warning SPECIFICITY, NEVER the gate — a stale copy merely downgrades a shadowing key's warn from "shadowing"
// to "not_recognized"; the key is still skipped (not on the SOW_* allowlist) and still safe.
// TODO(barrel-export SUBSCRIPTION_SHADOWING_ENV_KEYS): expose it from @sow/worker so a later slice single-sources this.
const SUBSCRIPTION_SHADOWING_ENV_KEYS: readonly string[] = [
  // Class A — auth-shadowing:
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  // Class B — egress-redirect (both proxy cases; NO_PROXY deliberately excluded — a bypass allowlist, not a redirect):
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
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
      skipped.push({ key, reason: SUBSCRIPTION_SHADOWING_ENV_KEYS.includes(key) ? "shadowing" : "not_recognized" });
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
