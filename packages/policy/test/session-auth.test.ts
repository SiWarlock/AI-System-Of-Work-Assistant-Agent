// spec(§5) — renderer↔worker session-auth primitive (REQ-S-004/NF-004): per-launch high-entropy token mint, constant-time verify, per-launch staleness, strict Origin/Host allowlist. Token bytes never echoed.
import { describe, it, expect } from "vitest";
import {
  mintSessionToken,
  verifySessionToken,
  isOriginAllowed,
  type SessionToken,
} from "../src/session-auth";
import { isAllow, isDeny } from "../src/decision";
import { isRedactionSafe } from "../src/audit-signal";

// Deterministic injectable rng: fills n bytes with a fixed byte value.
const fixedRng = (byte: number) => (n: number): Buffer => Buffer.alloc(n, byte);

describe("mintSessionToken", () => {
  it("mints a 32-byte (64 hex char) high-entropy value + a per-launch launchId", () => {
    const t = mintSessionToken(fixedRng(0xab));
    expect(t.value).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof t.launchId).toBe("string");
    expect(t.launchId.length).toBeGreaterThan(0);
  });

  it("is deterministic given the injected rng (same rng ⇒ same token)", () => {
    const a = mintSessionToken(fixedRng(0x01));
    const b = mintSessionToken(fixedRng(0x01));
    expect(a.value).toBe(b.value);
    expect(a.launchId).toBe(b.launchId);
  });

  it("produces different tokens for different rng bytes (not derived from a guessable value)", () => {
    const a = mintSessionToken(fixedRng(0x01));
    const b = mintSessionToken(fixedRng(0x02));
    expect(a.value).not.toBe(b.value);
    expect(a.launchId).not.toBe(b.launchId);
  });

  it("defaults to node:crypto randomBytes when no rng injected (non-repeating)", () => {
    const a = mintSessionToken();
    const b = mintSessionToken();
    expect(a.value).toMatch(/^[0-9a-f]{64}$/);
    expect(a.value).not.toBe(b.value); // real entropy ⇒ distinct
  });
});

describe("verifySessionToken", () => {
  it("accepts a presented token that matches the current-launch expected token", () => {
    const t = mintSessionToken(fixedRng(0xab));
    const d = verifySessionToken(t.value, t);
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) expect(d.value.authenticated).toBe(true);
  });

  it("rejects an empty presented token (fail-closed, length guard)", () => {
    const t = mintSessionToken(fixedRng(0xab));
    const d = verifySessionToken("", t);
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("AUTH_TOKEN_INVALID");
  });

  it("rejects a same-length wrong token (constant-time content mismatch)", () => {
    const t = mintSessionToken(fixedRng(0xab)); // value = "ab" * 32
    const wrong = "cd".repeat(32); // same 64-char length, different content
    const d = verifySessionToken(wrong, t);
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("AUTH_TOKEN_INVALID");
  });

  it("rejects an unequal-length token WITHOUT throwing (timing-safe length guard)", () => {
    const t = mintSessionToken(fixedRng(0xab));
    let d!: ReturnType<typeof verifySessionToken>;
    expect(() => {
      d = verifySessionToken("deadbeef", t); // 8 chars vs 64
    }).not.toThrow();
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("AUTH_TOKEN_INVALID");
  });

  it("rejects a prior-launch token against a new-launch expected token (staleness)", () => {
    const prior = mintSessionToken(fixedRng(0xaa)); // launch 1
    const current = mintSessionToken(fixedRng(0xbb)); // launch 2 (relaunch)
    const d = verifySessionToken(prior.value, current);
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("AUTH_TOKEN_INVALID");
  });

  it("fail-closed on a malformed expected token", () => {
    const d = verifySessionToken("whatever", null as unknown as SessionToken);
    expect(isDeny(d)).toBe(true);
  });

  it("NEVER echoes the presented token bytes in the deny message or AuditSignal", () => {
    const t = mintSessionToken(fixedRng(0xab));
    const secret = "s3cr3t-presented-token-value-0123456789abcdef";
    const d = verifySessionToken(secret, t);
    const json = JSON.stringify(d);
    expect(json).not.toContain(secret); // presented never echoed
    expect(json).not.toContain(t.value); // expected token never echoed
    if (isDeny(d)) expect(isRedactionSafe(d.audit)).toBe(true);
  });

  it("NEVER echoes the token bytes even on a successful ALLOW", () => {
    const t = mintSessionToken(fixedRng(0xab));
    const d = verifySessionToken(t.value, t);
    const json = JSON.stringify(d);
    expect(json).not.toContain(t.value);
    if (isAllow(d)) expect(isRedactionSafe(d.audit)).toBe(true);
  });
});

describe("isOriginAllowed", () => {
  const allowlist = {
    origins: ["http://localhost:5173", "app://sow"],
    hosts: ["localhost:8787", "127.0.0.1:8787"],
  };

  it("allows an origin + host both on the strict allowlist", () => {
    const d = isOriginAllowed("http://localhost:5173", "localhost:8787", allowlist);
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) expect(d.value.ok).toBe(true);
  });

  it("rejects a cross-origin caller (Origin not on allowlist)", () => {
    const d = isOriginAllowed("http://evil.example.com", "localhost:8787", allowlist);
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("rejects a DNS-rebinding caller (Host not on allowlist)", () => {
    const d = isOriginAllowed("http://localhost:5173", "attacker.local", allowlist);
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("fail-closed on a malformed allowlist", () => {
    const d = isOriginAllowed("http://localhost:5173", "localhost:8787", null as unknown as {
      origins: string[];
      hosts: string[];
    });
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
  });

  it("fail-closed on empty origin or empty host", () => {
    expect(isDeny(isOriginAllowed("", "localhost:8787", allowlist))).toBe(true);
    expect(isDeny(isOriginAllowed("http://localhost:5173", "", allowlist))).toBe(true);
  });
});
