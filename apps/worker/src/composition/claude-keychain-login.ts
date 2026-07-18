// 18.25 arm — the spend-free macOS Keychain PRESENCE probe for the local `claude` subscription login.
//
// The concrete `detectLogin` primitive the owner ARM injects into 18.26's `probeSubscriptionReachability`
// ({detectLogin, resolveSdk}) → the subscription HEALTH gate. Claude Code (Mac-first) stores the subscription
// login in the macOS KEYCHAIN, so 18.26's DEFAULT file-path detector (`DEFAULT_CLAUDE_LOGIN_PATH`) fails closed
// on macOS — this is the real, live-verified detector that reaches a genuine GREEN CP2.
//
// SPEND-FREE + rule 7 (LOAD-BEARING): PRESENCE ONLY — the argv carries NO `-w`, so the CLI never reads/prints
// the credential VALUE; only the process exit STATUS crosses (0 ⇒ present). No token bytes are ever loaded or
// surfaced. This mirrors the Phase-17 `security`-CLI machinery (Lesson 10): the ABSOLUTE `SECURITY_BIN` (no
// PATH hijack) + an args ARRAY (never a shell string) + a bounded timeout. Fail-closed / total (§16 / L52): a
// non-zero exit, a null status (timeout/kill), or a throw ⇒ `false` ⇒ HEALTH UNAVAILABLE ⇒ the arm HALTs safe
// (never a false-green).
//
// Reachability-WAIVERED (L11): no production caller — the owner ARM (18.25, step 6) injects it via
// `config.subscriptionArm.checkReachable = () => probeSubscriptionReachability({ detectLogin: detectClaudeKeychainLogin })`.
// Worker-verified: a Node `spawnSync` of `/usr/bin/security find-generic-password -s "Claude Code-credentials"`
// returns exit 0 with no GUI prompt (metadata-level query — the item's ACL gates the `-w` VALUE, not presence).
import { spawnSync } from "node:child_process";
import { SECURITY_BIN } from "../secrets/keychain-backend";

/** The macOS Keychain service the Claude Code subscription login is stored under (owner-machine verified). The
 *  account is the OS user; a service-only presence query matches it and avoids coupling to the username. */
export const CLAUDE_LOGIN_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** Bound the presence check so a hung `security` call fails closed (never blocks the armed boot). */
export const SECURITY_PRESENCE_TIMEOUT_MS = 5_000;

/**
 * A synchronous, spawnSync-shaped presence exec (injected in tests; the real `spawnSync` default). Returns
 * only the exit `status` — NEVER stdout (there is nothing to read: the query carries no `-w`).
 */
export type SecurityPresenceExec = (
  file: string,
  args: readonly string[],
) => { readonly status: number | null };

const defaultPresenceExec: SecurityPresenceExec = (file, args) =>
  spawnSync(file, args as string[], {
    stdio: ["ignore", "ignore", "ignore"], // no stdout captured — presence is the exit status only
    timeout: SECURITY_PRESENCE_TIMEOUT_MS,
  });

/**
 * SPEND-FREE + rule 7: is the local `claude` subscription login PRESENT in the macOS Keychain? Runs
 * `security find-generic-password -s "<service>"` (PRESENCE ONLY — NO `-w`, so the credential value is never
 * read) via the ABSOLUTE `SECURITY_BIN` + an args ARRAY (no shell). Fail-closed: a non-zero exit / null status
 * (timeout) / a throw ⇒ `false`. Total — never throws. `exec` + `service` are injectable (tests inject `exec`).
 */
export function detectClaudeKeychainLogin(
  exec: SecurityPresenceExec = defaultPresenceExec,
  service: string = CLAUDE_LOGIN_KEYCHAIN_SERVICE,
): boolean {
  try {
    const { status } = exec(SECURITY_BIN, ["find-generic-password", "-s", service]);
    return status === 0;
  } catch {
    // §16 — a spawn failure / ENOENT / timeout never escapes; fail closed (HEALTH UNAVAILABLE, arm HALTs safe).
    return false;
  }
}
