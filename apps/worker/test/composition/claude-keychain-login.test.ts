// 18.25 arm — the spend-free macOS Keychain PRESENCE probe for the local `claude` subscription login. These
// tests drive a FAKE spawnSync-shaped exec — no real `security` binary, no Keychain I/O, no value read. They
// pin: exit 0 ⇒ present; every fault (non-zero / null-status timeout / throw) ⇒ fail-closed false; and the
// rule-7 LOAD-BEARING guarantee that the argv carries NO `-w` (the credential VALUE is never read) over the
// ABSOLUTE bin + an args array (no shell).
import { describe, it, expect } from "vitest";
import {
  detectClaudeKeychainLogin,
  CLAUDE_LOGIN_KEYCHAIN_SERVICE,
  type SecurityPresenceExec,
} from "../../src/composition/claude-keychain-login";

function capture(status: number | null): {
  exec: SecurityPresenceExec;
  calls: { file: string; args: readonly string[] }[];
} {
  const calls: { file: string; args: readonly string[] }[] = [];
  const exec: SecurityPresenceExec = (file, args) => {
    calls.push({ file, args });
    return { status };
  };
  return { exec, calls };
}

describe("detectClaudeKeychainLogin — spend-free Keychain presence probe (18.25 arm)", () => {
  it("present_exit0_is_login_present — status 0 ⇒ true [spec(§7)]", () => {
    expect(detectClaudeKeychainLogin(capture(0).exec)).toBe(true);
  });

  it("absent_notfound_fails_closed — status 44 (errSecItemNotFound) ⇒ false [spec(§16)]", () => {
    expect(detectClaudeKeychainLogin(capture(44).exec)).toBe(false);
  });

  it("timeout_null_status_fails_closed — a null status (timeout/kill) ⇒ false, never a false-green (L52) [spec(§16)]", () => {
    expect(detectClaudeKeychainLogin(capture(null).exec)).toBe(false);
  });

  it("exec_throw_fails_closed — a spawn throw ⇒ false, never escapes the seam [spec(§16)]", () => {
    const exec: SecurityPresenceExec = () => {
      throw new Error("spawn ENOENT boom");
    };
    expect(detectClaudeKeychainLogin(exec)).toBe(false);
  });

  it("presence_only_never_reads_value — argv has NO `-w` (rule 7 — never the credential value), ABSOLUTE bin, no shell, service-only [spec(rule7)]", () => {
    const { exec, calls } = capture(0);
    detectClaudeKeychainLogin(exec);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("/usr/bin/security"); // absolute bin — no PATH hijack
    expect(calls[0]!.args).not.toContain("-w"); // LOAD-BEARING: never read the secret VALUE
    expect(calls[0]!.args).toStrictEqual(["find-generic-password", "-s", CLAUDE_LOGIN_KEYCHAIN_SERVICE]);
  });

  it("default_service_is_the_verified_claude_login — targets the owner-machine-verified service", () => {
    expect(CLAUDE_LOGIN_KEYCHAIN_SERVICE).toBe("Claude Code-credentials");
  });

  it("truthy_not_zero_status_fails_closed — STRICT status===0; a truthy-not-0 status ⇒ false [spec(L28)]", () => {
    for (const s of [1, -1, 44, 255] as number[]) {
      expect(detectClaudeKeychainLogin(capture(s).exec)).toBe(false);
    }
  });
});
