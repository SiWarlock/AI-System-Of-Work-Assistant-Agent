// 18.36 — the settings-level key-injection guard (armed-path ONLY; DORMANT). Closes a §ARM-18 CHECKPOINT-1
// residual: the ONE shadow the 18.28 process.env guard (subscription-auth-guard.ts) structurally CANNOT see.
//
// The Agent SDK `query()` runs the Claude Code harness, which resolves credentials first-match-wins AND honors
// Claude Code `settings.json` — so an `apiKeyHelper` (a command whose stdout becomes the key) or a settings-
// injected `env.ANTHROPIC_API_KEY` would make a "subscription" run silently authenticate with a RAW API key
// (real metered spend), invisible to the `process.env`-only scan. On the ARMED boot path this detects a
// settings-level key injection (PRESENCE only — never the value, rule 7) and DEGRADES the arm fail-closed
// (boot strips the transport gate → extraction stays local/stub; NEVER a worker crash, §16/L52).
//
// Grounded vs LIVE Claude-Code docs (claude-code-guide, 2026-07-20; settings.md / authentication.md /
// env-vars.md / agent-sdk): the injecting mechanisms are (1) top-level cred-MINTING fields
// {@link SETTINGS_INJECTION_FIELDS}; (2) the settings `env` block whose KEYS shadow exactly like process.env
// (reuse 18.28's set — a settings `env.X` == `process.env.X`); read across the settings hierarchy: managed
// (macOS `/Library/Application Support/ClaudeCode/managed-settings.json` — survives `settingSources:[]`) →
// project-local → project → user `~/.claude/settings.json` (honoring `CLAUDE_CONFIG_DIR`).
//
// ⚠ Re-verify the field set + file paths vs live docs at the flip (the SDK's honored surface shifts by version
// — the L56/L65 discipline). Over-inclusion is fail-safe (a spurious degrade hits only the owner-gated armed
// path) EXCEPT where a field is COMMON in a legit subscription config — `model`/`availableModels`/`forceLogin*`
// are DELIBERATELY EXCLUDED (a model pin / `forceLoginMethod:"claudeai"` is not a credential; watching them
// PERMANENTLY false-degrades the legit armed config — the L65 `NO_PROXY`-exclusion class).
//
// ⚠ NOT covered (the file-scan can't see it): a programmatic `query({ env / managedSettings })` — the worker's
// OWN subscription adapter must not inject a key-bearing env/managedSettings (deployment-checklist backstop,
// §ARM-18 CHECKPOINT-1). Reachability-WAIVERED (L11): boot calls this on the armed path at the owner ENABLE.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SUBSCRIPTION_SHADOWING_ENV_KEYS } from "./subscription-auth-guard";

/** The closed set of settings-hierarchy tiers (highest→lowest precedence). A fault marker is one of these (or
 *  `"hierarchy"` when the reader itself faulted) — rule 7: a file TIER name, never file content / a value. */
export type SettingsSourceMarker = "managed" | "project-local" | "project" | "user";

/** The parse outcome for one settings source. `absent` ⇒ clean (the common case); `unreadable` ⇒ exists but
 *  read/parse failed / not a settings object ⇒ fail-safe DEGRADE; `parsed` ⇒ the shallow settings object. */
export type SettingsSourceOutcome =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "parsed"; readonly settings: Record<string, unknown> };

/** One resolved settings source: its tier marker (rule 7 — never the content) + its parse outcome. */
export interface SettingsSourceRead {
  readonly marker: SettingsSourceMarker;
  readonly outcome: SettingsSourceOutcome;
}

/** The injected settings-hierarchy reader: returns EVERY source across the tiers. Real default
 *  {@link readClaudeCodeSettings} reads the files; tests inject a fake. */
export type SettingsHierarchyReader = () => readonly SettingsSourceRead[];

/** A redaction-safe fault (code-only + a file-tier marker; the key VALUE / command string is NEVER read or
 *  surfaced — rule 7). Distinct code from the 18.28 env-shadow refusal so the boot log tells them apart. */
export interface SettingsInjectionFault {
  readonly code: "settings_key_injection_on_armed_path";
  readonly marker: SettingsSourceMarker | "hierarchy";
}

/** Top-level `settings.json` fields that DIRECTLY mint/inject a credential (grounded vs live Claude-Code docs).
 *  `apiKeyHelper` (command → key), `awsAuthRefresh` / `awsCredentialExport` (Bedrock cred scripts), and
 *  `gcpAuthRefresh` (18.37 — the Vertex analog of the AWS cred scripts). EXPLICIT EXTENSIBLE (L61): add a field
 *  the live surface names at re-verify. EXCLUDES `model`/`availableModels`/`forceLogin*` (common/ambiguous ⇒
 *  permanent false-degrade — see the header). The settings `env` block's shadowing KEYS are handled separately
 *  via 18.28's {@link SUBSCRIPTION_SHADOWING_ENV_KEYS} (extended to the full provider surface in 18.37). */
export const SETTINGS_INJECTION_FIELDS = [
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
] as const;

const INJECTION_CODE = "settings_key_injection_on_armed_path" as const;

/** A top-level cred-minting field is injecting iff PRESENT + non-empty: an empty/whitespace command mints no
 *  key (never a false-degrade on a vestigial empty field); a non-string present value ⇒ fail-safe injecting. */
function isInjectingTopLevel(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * PURE + TOTAL + FAIL-CLOSED: inspect each settings source for a key injection. A top-level cred-minting field
 * (present + non-empty) OR a settings `env` block carrying a subscription-shadowing KEY ⇒ a typed fault; an
 * `unreadable` source (can't confirm clean) ⇒ fail-safe DEGRADE; the reader itself throwing ⇒ DEGRADE. Returns
 * the FIRST fault (highest-precedence tier first), else `undefined`. PRESENCE only — the key value / command
 * string is NEVER read or surfaced (rule 7); an `apiKeyHelper` command is never executed. Never throws.
 *
 * The `env`-block leg uses PRESENCE-of-key (`!== undefined`), parity with 18.28's `assertSubscriptionAuthEnv`:
 * an EMPTY `env.ANTHROPIC_API_KEY` still wins its resolution-precedence slot and shadows the subscription, so
 * it must NOT fail-open on a blank value (distinct from the top-level cred-minting fields).
 */
export function assertNoSettingsKeyInjection(
  read: SettingsHierarchyReader,
): SettingsInjectionFault | undefined {
  let sources: readonly SettingsSourceRead[];
  try {
    sources = read();
  } catch {
    // §16/L65 — the reader faulting can't confirm clean ⇒ fail-safe degrade (code-only, rule 7).
    return { code: INJECTION_CODE, marker: "hierarchy" };
  }
  for (const src of sources) {
    if (src.outcome.kind === "absent") continue;
    if (src.outcome.kind === "unreadable") return { code: INJECTION_CODE, marker: src.marker };
    const settings = src.outcome.settings;
    if (SETTINGS_INJECTION_FIELDS.some((field) => isInjectingTopLevel(settings[field]))) {
      return { code: INJECTION_CODE, marker: src.marker };
    }
    const envBlock = settings["env"];
    if (isRecord(envBlock) && SUBSCRIPTION_SHADOWING_ENV_KEYS.some((key) => envBlock[key] !== undefined)) {
      return { code: INJECTION_CODE, marker: src.marker };
    }
  }
  return undefined;
}

/**
 * The armed-path gate: run the settings guard ONLY when the arm is effectively enabled. STRICT `=== true`
 * (L28) — a truthy-not-`true` value ⇒ unarmed ⇒ the reader is NEVER invoked (factory-spy zero-invocation ⇒
 * the shipped default never touches the settings files, byte-equivalent, L23/L44). Pure; total.
 */
export function guardSettingsOnArmedPath(
  armed: boolean,
  read: SettingsHierarchyReader,
): SettingsInjectionFault | undefined {
  if (armed !== true) return undefined;
  return assertNoSettingsKeyInjection(read);
}

// ── the real settings-hierarchy reader (the arm's ready-to-inject default; reachability-waivered) ──────────

/** The macOS managed-settings file — the enterprise-policy tier that survives `settingSources:[]` (grounded). */
const MANAGED_SETTINGS_MACOS = "/Library/Application Support/ClaudeCode/managed-settings.json";

/** Read one settings file into a {@link SettingsSourceRead}: absent ⇒ clean; a non-object / read-or-parse
 *  throw ⇒ unreadable (fail-safe degrade). Total — never throws. Rule 7: parses only for FIELD PRESENCE. */
function readOneSettingsFile(marker: SettingsSourceMarker, path: string): SettingsSourceRead {
  if (!existsSync(path)) return { marker, outcome: { kind: "absent" } };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return { marker, outcome: { kind: "unreadable" } };
    return { marker, outcome: { kind: "parsed", settings: parsed } };
  } catch {
    return { marker, outcome: { kind: "unreadable" } };
  }
}

/**
 * The real Claude-Code settings-hierarchy reader (the concrete default boot injects on the armed path). Reads
 * the four file tiers highest→lowest, honoring `CLAUDE_CONFIG_DIR` for the user tier. Reachability-WAIVERED
 * (L11): exercised via the injected fake in tests; the real fs is touched only on the owner-armed boot.
 * NB: the managed `managed-settings.d/*.json` drop-in fragments are not enumerated here — a re-verify residual.
 */
export const readClaudeCodeSettings: SettingsHierarchyReader = () => {
  const configDir = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
  const cwd = process.cwd();
  return [
    readOneSettingsFile("managed", MANAGED_SETTINGS_MACOS),
    readOneSettingsFile("project-local", join(cwd, ".claude", "settings.local.json")),
    readOneSettingsFile("project", join(cwd, ".claude", "settings.json")),
    readOneSettingsFile("user", join(configDir, "settings.json")),
  ];
};
