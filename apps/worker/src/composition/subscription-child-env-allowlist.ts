// 18.40 — the subscription spawn-env minimal-allowlist builder (rule-5 completeness-by-construction).
//
// The Agent SDK `query()` `env` option REPLACES the child process env ENTIRELY (grounded sdk.d.ts:1391-1409,
// SDK 0.3.201: "When set, this value REPLACES the subprocess environment entirely — not merged with process.env;
// when omitted, inherits process.env"). On the armed path the worker spawns claude with a MINIMAL ALLOWLIST so
// NO shadow var — known, unknown, future-version, or `CLAUDE_ENV_FILE`-dotenv-injected — can reach the child.
// This is the COMPLETENESS guarantee rule-5 requires; a process.env-scan DENYLIST (18.38) is structurally
// unwinnable (it can't see a `CLAUDE_ENV_FILE`-injected key) and survives only as a defense-in-depth pre-run
// degrade. Drift-immune: retires the "re-verify the shadow set at every claude-code version bump" precondition.
//
// The allowlist carries NO credential/redirect var: the subscription login is AMBIENT — `~/.claude` (reached via
// HOME) + the macOS Keychain (ACL / process-identity based, NOT env). PATH (spawn) + HOME (login discovery) are
// load-bearing; the rest are benign OS locale/tmp/identity vars a CLI may need. Under-allowlisting fails CLOSED
// (the spawn/login errors — never a silent wrong-credential run), so the set starts minimal and expands only if
// the $0 dry-run / real run proves something is needed (see 18.40 Q2, the SDK control-var validation gate).
export const SUBSCRIPTION_CHILD_ENV_ALLOWLIST = [
  // Load-bearing: spawn (find node/bun) + the ambient `~/.claude` subscription login discovery.
  "PATH",
  "HOME",
  // OS-operational (benign — carry no credential, redirect nothing): tmp, identity, locale, shell, terminal, tz.
  "TMPDIR",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "TERM",
  "TZ",
] as const;

/**
 * PURE + TOTAL: build the minimal child env for an armed subscription `query()` spawn. Copies ONLY the
 * allowlisted keys that are PRESENT in `source` (an undefined value is dropped, never carried), so the result
 * is a well-formed `Record<string, string>` containing NOTHING outside the positive allowlist — a shadow var in
 * `source` can never reach the child. Never throws (an empty source ⇒ `{}`). Rule-7-adjacent: it copies the
 * VALUES of operational keys (PATH/HOME — not secrets) but never logs them; no credential key is ever read.
 */
export function buildSubscriptionChildEnvAllowlist(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SUBSCRIPTION_CHILD_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The SINGLE armed-subscription-spawn chokepoint (no split-brain, L52/L71): resolve the scrubbed child env for
 * EVERY `createClaudeSubscriptionCompletion` `query()` spawn — the §ARM-18 extraction arm (boot.ts:1323) AND the
 * §13.10 Copilot real-model path (boot.ts:1767). Returns the minimal allowlist when EITHER subscription feature
 * is enabled (STRICT `=== true` — no truthy-coerce, L28), else `undefined` (⇒ the caller omits `childEnv` ⇒
 * `query()` inherits process.env, byte-equivalent shipped default). Both gates are watched because BOTH spawn the
 * same subscription `query()`; a single uncovered site would inherit raw env and reopen the shadow hole.
 */
export function resolveSubscriptionSpawnChildEnv(
  gates: { readonly subscriptionArmEnabled?: boolean; readonly copilotRealModel?: boolean },
  source: Record<string, string | undefined>,
): Record<string, string> | undefined {
  const anyArmed = gates.subscriptionArmEnabled === true || gates.copilotRealModel === true;
  return anyArmed ? buildSubscriptionChildEnvAllowlist(source) : undefined;
}
