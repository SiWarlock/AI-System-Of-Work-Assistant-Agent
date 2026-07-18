// @sow/providers — subscription REACHABILITY probe (18.26, §19.5 / §7).
//
// The real, SPEND-FREE reachability check for the Claude subscription arm's HEALTH gate: produces the
// `{loginPresent, sdkReachable}` signal that 18.22's probeClaudeSubscriptionHealth({checkReachable})
// consumes (strict `=== true`, providers Lesson 9). The worker injects it at the owner ARM (18.25) via
// config.subscriptionArm.checkReachable → probeClaudeSubscriptionHealth → createSubscriptionHealthSources →
// gate.healthSource. DORMANT + reachability-waivered (L11) until then.
//
// SPEND-FREE — the LOAD-BEARING constraint: this module imports NO SDK and makes NO query()/completion (a
// completion at CP2 would spend before the gated run). Readiness is proven by two definitively-spend-free
// signals: (a) the local `claude` login credential is PRESENT (fs EXISTENCE only — the SDK auto-uses that
// login per the Agent SDK docs; Context7 /nothflare/claude-agent-sdk-docs) and (b) the
// `@anthropic-ai/claude-agent-sdk` module is RESOLVABLE (module resolution ≠ import, no execution).
// `Query.accountInfo()`/`tokenSource` is DELIBERATELY NOT used — Context7 does not confirm it is spend-free
// and it requires a live query() session (spawns the Claude Code CLI), a possible CP2 spend (L55/L56).
//
// FAIL-CLOSED + total (§16 / L52): every fold catches a throw and requires strict `=== true`, so any
// fault / ambiguity / truthy-coercion ⇒ that dimension FALSE — never a false-green. Rule 7: only the two
// booleans ever cross; no credential VALUE is read (existence-only) or surfaced.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SubscriptionReachability } from "./subscription-health-probe";

/** Injectable spend-free readiness primitives (fakeable in tests; the concrete defaults are below). */
export interface SubscriptionReachabilityProbeDeps {
  readonly detectLogin: () => boolean;
  readonly resolveSdk: () => boolean;
}

/** Fail-closed fold: strict `=== true`, and a throw folds to false (never a false-green). */
function safeTrue(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

/**
 * PURE + TOTAL + FAIL-CLOSED: fold the two spend-free primitives into the `{loginPresent, sdkReachable}`
 * signal 18.22 consumes. Deps default to the concrete primitives below, so the arm can inject it
 * ready-to-use (or override just `detectLogin` with the live-verified login path). SPEND-FREE by
 * construction; never throws.
 */
export function probeSubscriptionReachability(
  deps: Partial<SubscriptionReachabilityProbeDeps> = {},
): SubscriptionReachability {
  const detectLogin = deps.detectLogin ?? detectClaudeLogin;
  const resolveSdk = deps.resolveSdk ?? resolveAgentSdk;
  return {
    loginPresent: safeTrue(detectLogin),
    sdkReachable: safeTrue(resolveSdk),
  };
}

// ── concrete spend-free primitives (the arm's ready-to-inject defaults) ───────────────────────────────

/**
 * L55 PLACEHOLDER (dated 2026-07-18) — a CANDIDATE local `claude` login credential path, NOT verified
 * against the live Claude Code auth. Claude Code (Mac-first) stores the subscription login in the macOS
 * KEYCHAIN, so on macOS this FILE is typically ABSENT ⇒ detectClaudeLogin fails CLOSED (loginPresent:false)
 * ⇒ HEALTH UNAVAILABLE ⇒ the arm HALTs at CP2 (safe — never a false-green). The arm MUST inject the
 * live-verified login detector (e.g. a Keychain-presence probe) at flip and re-verify this path then.
 */
export const DEFAULT_CLAUDE_LOGIN_PATH: string = join(homedir(), ".claude", ".credentials.json");

/** Injectable fs-existence check (fake in tests; the real `existsSync` default). */
export type PathExists = (path: string) => boolean;

/**
 * SPEND-FREE + rule 7: is the local `claude` login credential PRESENT? Checks fs EXISTENCE ONLY — it never
 * reads the file's contents, so no token/credential bytes are ever loaded or surfaced. Fail-closed: an
 * absent path, a non-`true` existence, or a throw ⇒ false. `path` + `exists` are injectable (the arm
 * overrides `path` with the live-verified location; tests inject `exists`).
 */
export function detectClaudeLogin(
  path: string = DEFAULT_CLAUDE_LOGIN_PATH,
  exists: PathExists = existsSync,
): boolean {
  try {
    return exists(path) === true;
  } catch {
    return false;
  }
}

/** Injectable module resolver (fake in tests; the real createRequire default). */
export type ModuleResolver = (id: string) => string;

const AGENT_SDK_MODULE = "@anthropic-ai/claude-agent-sdk";
const defaultModuleResolver: ModuleResolver = (id) => createRequire(import.meta.url).resolve(id);

/**
 * SPEND-FREE: is `@anthropic-ai/claude-agent-sdk` RESOLVABLE? Uses module RESOLUTION only (returns the
 * resolved path); it does NOT import/execute the SDK and makes no query()/completion. Fail-closed: an
 * unresolvable module or a throw ⇒ false. The resolver is injectable for tests.
 */
export function resolveAgentSdk(resolve: ModuleResolver = defaultModuleResolver): boolean {
  try {
    const resolved = resolve(AGENT_SDK_MODULE);
    // Strict parity with detectClaudeLogin's `=== true` (L52 no-truthy fail-closed ethos): require a
    // non-empty resolved PATH, not merely "did not throw" — a resolver returning ""/undefined fails CLOSED.
    return typeof resolved === "string" && resolved.length > 0;
  } catch {
    return false;
  }
}
