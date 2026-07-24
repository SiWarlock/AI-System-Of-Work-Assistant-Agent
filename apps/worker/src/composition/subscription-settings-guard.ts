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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
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

// 18.39 (B) — NO managed-field enumeration: the MANAGED tier is complete-by-construction via a presence-degrade in
// `assertNoSettingsKeyInjection` (ANY present non-empty managed settings ⇒ degrade), SUBSUMING every managed injecting
// field (apiKeyHelper / hooks / statusLine / headersHelper / any future one) — drift-immune, the settings-file analog
// of 18.40's env allowlist (L73), retiring the per-version managed-field re-verify. `SETTINGS_INJECTION_FIELDS` above
// stays for the NON-managed (user/project/local) defense-in-depth field-scan only. The managed-only soundness still
// depends on the extraction query()'s `settingSources:[]` disabling user/project (⛔ CROSS-FILE COUPLING —
// `packages/providers/src/model/claude-subscription-completion.ts:145`, source-pinned in the test).

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
    // 18.39 (B) — the MANAGED tier is complete-by-construction: ANY present + non-empty managed settings object ⇒
    // fail-safe DEGRADE. Managed is enterprise-locked AND the ONLY tier honored under `settingSources:[]`, so we stop
    // enumerating which managed fields inject (apiKeyHelper / hooks / statusLine / headersHelper / any future field)
    // — drift-immune, the settings-file analog of 18.40's env allowlist inversion (L73), retiring the per-version
    // managed-field re-verify. An EMPTY managed `{}` mints nothing ⇒ clean; a present non-empty managed ⇒ degrade.
    if (src.marker === "managed") {
      if (Object.keys(settings).length > 0) return { code: INJECTION_CODE, marker: src.marker };
      continue;
    }
    // Non-managed tiers (user / project / local — DISABLED by the extraction query()'s `settingSources:[]`, scanned
    // here defense-in-depth only): a benign settings is COMMON (a dev's model pin / permissions), so field-enumerate
    // rather than presence-degrade (a presence-degrade here would permanently false-degrade a legit dev config).
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

/** The macOS managed drop-in fragment dir — read alongside the base managed-settings.json (base then `*.json`
 *  sorted; grounded vs the SDK-bundled claude-code 2.1.201). Managed tier ONLY (the enterprise `.d` case). */
const MANAGED_SETTINGS_D_MACOS = "/Library/Application Support/ClaudeCode/managed-settings.d";

/** The injectable fs surface {@link readManagedFragments} needs (so it's unit-testable with a fake fs). */
export interface FragmentFs {
  readonly existsSync: (path: string) => boolean;
  readonly readdirSync: (path: string) => readonly string[];
  readonly readFileSync: (path: string, encoding: "utf8") => string;
}

/**
 * 18.39 — enumerate the `managed-settings.d/*.json` drop-in fragments as additional `managed`-tier sources so the
 * existing presence scan inspects them too (closes session-104 residual #40 — a fragment injecting `apiKeyHelper`
 * / an `env` shadow is otherwise invisible to the flat-tier reader; the real runtime 2.1.201 reads this dir).
 * Per-fragment PRESENCE (no deep-merge — a merged field is honored regardless of which fragment supplied it, so
 * scanning each independently can't miss an injection + is simpler). Total + FAIL-SAFE (§16/L65): absent dir ⇒
 * `[]`; a `readdir` throw ⇒ ONE synthetic `unreadable` managed source; a malformed / non-object / unreadable
 * `*.json` ⇒ an `unreadable` managed source. Non-`*.json` + dotfiles IGNORED; read in sorted (stable) order.
 * Rule 7 — parses only for field PRESENCE. `fs` is injected (real reader passes node:fs; tests pass a fake).
 * ⚠ re-verify the fragment path/merge vs the SDK-bundled version at the flip (L72).
 */
export function readManagedFragments(fragmentDir: string, fs: FragmentFs): readonly SettingsSourceRead[] {
  let names: readonly string[];
  try {
    if (!fs.existsSync(fragmentDir)) return [];
    names = [...fs.readdirSync(fragmentDir)].filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
  } catch {
    // A dir that exists but readdir throws (perms) ⇒ can't confirm the fragments clean ⇒ ONE synthetic degrade.
    return [{ marker: "managed", outcome: { kind: "unreadable" } }];
  }
  return names.map((name): SettingsSourceRead => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(join(fragmentDir, name), "utf8"));
      if (!isRecord(parsed)) return { marker: "managed", outcome: { kind: "unreadable" } };
      return { marker: "managed", outcome: { kind: "parsed", settings: parsed } };
    } catch {
      return { marker: "managed", outcome: { kind: "unreadable" } };
    }
  });
}

/** The settings-file RELOCATION env vars (18.39, routed from 18.38's Step-8): a set value relocates where the
 *  runtime reads managed settings ⇒ the default-path scan can't be trusted. */
const SETTINGS_RELOCATION_ENV_KEYS = ["CLAUDE_CODE_MANAGED_SETTINGS_PATH", "CLAUDE_CODE_REMOTE_SETTINGS_PATH"] as const;

/**
 * 18.39 — DEGRADE when a settings-path relocation var is set: present ⇒ a synthetic `unreadable` managed source
 * (the guard can't scan a relocated file at the default path — fail-safe; Q5 homed in the settings guard so the
 * 18.38 env set stays auth/egress-shadows only). Honoring the redirect (scanning the relocated file) is a noted
 * follow-up, NOT required for GATE-1. `undefined` when neither var is set (byte-equivalent).
 */
export function relocationDegradeSource(env: Record<string, string | undefined>): SettingsSourceRead | undefined {
  return SETTINGS_RELOCATION_ENV_KEYS.some((key) => env[key] !== undefined)
    ? { marker: "managed", outcome: { kind: "unreadable" } }
    : undefined;
}

/** The macOS enterprise MANAGED-PREFERENCES plist tier (18.39 Step-8 review) — a THIRD managed source the runtime
 *  reads on macOS (bundle `com.anthropic.claudecode`), device-level + per-user, carrying the SAME managed-settings
 *  schema (apiKeyHelper/env/hooks/…) and surviving `settingSources:[]` like managed-settings.json. We do NOT parse
 *  the plist (binary/XML, not JSON) — PRESENCE ⇒ can't confirm clean ⇒ fail-safe DEGRADE (§16/L65). Written by
 *  root/MDM only; on a non-MDM machine the paths are absent ⇒ no source ⇒ byte-equivalent. Operability caveat: an
 *  MDM Mac with a claudecode managed-preferences plist degrades the armed run → flip-runbook reconciliation. */
function managedPreferencesPlistPaths(): readonly string[] {
  const base = "/Library/Managed Preferences";
  const device = `${base}/com.anthropic.claudecode.plist`;
  let username: string | undefined;
  try {
    username = userInfo().username;
  } catch {
    username = undefined; // can't resolve the user ⇒ cover the device-level path only (still fail-safe)
  }
  return username !== undefined && username.length > 0
    ? [device, `${base}/${username}/com.anthropic.claudecode.plist`]
    : [device];
}

/** Presence-degrade for the managed-preferences plist tier: a present plist ⇒ ONE synthetic `unreadable` managed
 *  source (we can't JSON-scan a plist ⇒ fail-safe). `fs` injected for testability. Absent ⇒ no source. */
export function readManagedPreferencesPlists(
  plistPaths: readonly string[],
  fs: { readonly existsSync: (path: string) => boolean },
): readonly SettingsSourceRead[] {
  const out: SettingsSourceRead[] = [];
  for (const path of plistPaths) {
    let present: boolean;
    try {
      present = fs.existsSync(path);
    } catch {
      present = true; // can't check ⇒ fail-safe assume present (degrade)
    }
    if (present) out.push({ marker: "managed", outcome: { kind: "unreadable" } });
  }
  return out;
}

/**
 * The real Claude-Code settings-hierarchy reader (the concrete default boot injects on the armed path). Reads the
 * FULL MANAGED tier — base `managed-settings.json` + `managed-settings.d/*.json` fragments + the enterprise
 * managed-preferences plist (18.39) — then the project-local/project/user tiers highest→lowest (honoring
 * `CLAUDE_CONFIG_DIR` for the user tier), and appends a relocation-degrade source when a settings-path relocation
 * var is set. Reachability-WAIVERED (L11): the real fs is touched only on the owner-armed boot; tests inject fakes.
 * NB: only the MANAGED tier has a `.d`/plist + honored `hooks`/`statusLine` — user/project settings are disabled by
 * the extraction query()'s `settingSources:[]` (the coupling, source-pinned in the test).
 */
export const readClaudeCodeSettings: SettingsHierarchyReader = () => {
  const configDir = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
  const cwd = process.cwd();
  const sources: SettingsSourceRead[] = [
    readOneSettingsFile("managed", MANAGED_SETTINGS_MACOS),
    ...readManagedFragments(MANAGED_SETTINGS_D_MACOS, { existsSync, readdirSync, readFileSync }),
    ...readManagedPreferencesPlists(managedPreferencesPlistPaths(), { existsSync }),
    readOneSettingsFile("project-local", join(cwd, ".claude", "settings.local.json")),
    readOneSettingsFile("project", join(cwd, ".claude", "settings.json")),
    readOneSettingsFile("user", join(configDir, "settings.json")),
  ];
  const reloc = relocationDegradeSource(process.env);
  return reloc !== undefined ? [...sources, reloc] : sources;
};
