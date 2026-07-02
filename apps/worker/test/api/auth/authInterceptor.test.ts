// Task 8.1 — Worker-API auth gate (per-launch session-token verify +
// Origin/Host allowlist + loopback bind). TDD RED-first spec.
//
// This module WIRES the Phase-3 pure policy primitives (verifySessionToken /
// isOriginAllowed) into a single transport interceptor for the worker API. The
// worker VERIFIES the token; it never mints one (Electron main mints — Phase 9).
//
// Adversarial focus (root CLAUDE.md Lesson 4): the Origin/Host check must isolate
// the URL authority BEFORE extracting the host, so a userinfo-first spoof like
// `http://evil.com/@127.0.0.1` cannot masquerade as an allowlisted host.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import { mintSessionToken, type SessionToken } from "@sow/policy";
import {
  verifySessionToken as workerVerifySessionToken,
  type AuthedContext,
} from "../../../src/api/auth/sessionAuth";
import {
  checkOrigin,
  type WorkerOriginAllowlist,
} from "../../../src/api/auth/originAllowlist";
import { assertLoopbackBind } from "../../../src/api/auth/loopbackBind";
import {
  makeAuthInterceptor,
  type AuthInterceptorInput,
} from "../../../src/api/auth/interceptor";

// A deterministic, non-crypto RNG so the minted token/launchId are stable per
// test. mintSessionToken accepts an injectable Rng (n) => Buffer.
function fixedRng(byte: number): (n: number) => Buffer {
  return (n: number) => Buffer.alloc(n, byte);
}

const EXPECTED: SessionToken = mintSessionToken(fixedRng(0xab));
// A DIFFERENT secret — same length so a constant-time compare is exercised
// (equal-length wrong token), not short-circuited by the length guard.
const WRONG: SessionToken = mintSessionToken(fixedRng(0xcd));

// A strict allowlist: the renderer's dev origin + the loopback host:port it binds.
const ALLOWLIST: WorkerOriginAllowlist = {
  origins: ["http://localhost:5173", "app://sow"],
  hosts: ["localhost:5173", "127.0.0.1:5173"],
};

describe("sessionAuth.verifySessionToken (worker wrapper over the policy primitive)", () => {
  it("rejects a missing token as unauthenticated (validation_rejected)", () => {
    const r = workerVerifySessionToken(undefined, EXPECTED);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("validation_rejected");
      expect(r.error.message).toBe("unauthenticated");
    }
  });

  it("rejects an empty token as unauthenticated", () => {
    const r = workerVerifySessionToken("", EXPECTED);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("validation_rejected");
  });

  it("rejects an equal-length WRONG token (constant-time compare path)", () => {
    // Same byte length as EXPECTED.value, different content — forces the
    // timingSafeEqual content compare rather than the length short-circuit.
    expect(WRONG.value.length).toBe(EXPECTED.value.length);
    const r = workerVerifySessionToken(WRONG.value, EXPECTED);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("validation_rejected");
      expect(r.error.message).toBe("unauthenticated");
    }
  });

  it("accepts the VALID current-launch token and yields an AuthedContext", () => {
    const r = workerVerifySessionToken(EXPECTED.value, EXPECTED);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const ctx: AuthedContext = r.value;
      expect(ctx.authenticated).toBe(true);
    }
  });

  it("never leaks the presented or expected secret into the failure message", () => {
    const r = workerVerifySessionToken(WRONG.value, EXPECTED);
    if (isErr(r)) {
      expect(r.error.message).not.toContain(EXPECTED.value);
      expect(r.error.message).not.toContain(WRONG.value);
    }
  });
});

describe("originAllowlist.checkOrigin (Lesson-4-safe authority isolation)", () => {
  it("accepts an allowlisted Origin + Host", () => {
    const r = checkOrigin("http://localhost:5173", "localhost:5173", ALLOWLIST);
    expect(isOk(r)).toBe(true);
  });

  it("rejects a wrong (cross-)Origin with a valid Host", () => {
    const r = checkOrigin("http://evil.com", "localhost:5173", ALLOWLIST);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("validation_rejected");
  });

  it("rejects a wrong Host (DNS-rebind) with a valid Origin", () => {
    // Anti-rebind: a malicious page resolves an allowlisted name to loopback but
    // presents a foreign Host header. Host off-list ⇒ reject.
    const r = checkOrigin("http://localhost:5173", "evil.com", ALLOWLIST);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("validation_rejected");
  });

  it("rejects the userinfo-spoof Origin vector (Lesson 4)", () => {
    // The real host of `http://evil.com/@localhost:5173` is evil.com — the `@`
    // is in the PATH, not userinfo. A userinfo-first parser would wrongly read
    // the host as `localhost:5173` and ALLOW it. The authority must be isolated
    // (path/query/fragment stripped) BEFORE host extraction.
    const spoof = "http://evil.com/@localhost:5173";
    const r = checkOrigin(spoof, "localhost:5173", ALLOWLIST);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("validation_rejected");
  });

  it("rejects the userinfo-spoof via query/fragment/backslash variants", () => {
    for (const spoof of [
      "http://evil.com?@localhost:5173",
      "http://evil.com#@localhost:5173",
      "http://evil.com\\@localhost:5173",
    ]) {
      const r = checkOrigin(spoof, "localhost:5173", ALLOWLIST);
      expect(isErr(r)).toBe(true);
    }
  });

  it("does NOT be fooled by a genuine userinfo prefix on an allowlisted origin", () => {
    // `http://user@evil.com` — real host is evil.com (userinfo `user@`). Must reject.
    const r = checkOrigin("http://user@evil.com", "localhost:5173", ALLOWLIST);
    expect(isErr(r)).toBe(true);
  });

  it("rejects a missing/empty Origin or Host (fail-closed)", () => {
    expect(isErr(checkOrigin(undefined, "localhost:5173", ALLOWLIST))).toBe(true);
    expect(isErr(checkOrigin("http://localhost:5173", undefined, ALLOWLIST))).toBe(true);
    expect(isErr(checkOrigin("", "", ALLOWLIST))).toBe(true);
  });
});

describe("loopbackBind.assertLoopbackBind (REQ-NF-004)", () => {
  it("accepts a loopback bind address", () => {
    for (const addr of ["127.0.0.1", "::1", "localhost"]) {
      expect(isOk(assertLoopbackBind(addr))).toBe(true);
    }
  });

  it("refuses a non-loopback bind (all-interfaces 0.0.0.0)", () => {
    const r = assertLoopbackBind("0.0.0.0");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("validation_rejected");
  });

  it("refuses a remote/LAN bind address", () => {
    for (const addr of ["0.0.0.0", "192.168.1.10", "10.0.0.5", "::", "example.com"]) {
      expect(isErr(assertLoopbackBind(addr))).toBe(true);
    }
  });

  it("refuses the loopback-suffix spoof (127.0.0.1.attacker.com)", () => {
    expect(isErr(assertLoopbackBind("127.0.0.1.attacker.com"))).toBe(true);
    expect(isErr(assertLoopbackBind("localhost.evil.com"))).toBe(true);
  });

  it("refuses a missing/empty bind address (fail-closed)", () => {
    expect(isErr(assertLoopbackBind(undefined))).toBe(true);
    expect(isErr(assertLoopbackBind(""))).toBe(true);
  });
});

describe("interceptor.makeAuthInterceptor (single composed guard, pre-handler)", () => {
  const guard = makeAuthInterceptor({ expectedToken: EXPECTED, allowlist: ALLOWLIST });

  function req(overrides: Partial<AuthInterceptorInput>): AuthInterceptorInput {
    return {
      token: EXPECTED.value,
      origin: "http://localhost:5173",
      host: "localhost:5173",
      ...overrides,
    };
  }

  it("admits a valid token + allowlisted Origin/Host", () => {
    const r = guard(req({}));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.authenticated).toBe(true);
  });

  it("rejects a missing token pre-handler (UNAUTHORIZED-equivalent)", () => {
    const r = guard(req({ token: undefined }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("validation_rejected");
      expect(r.error.message).toBe("unauthenticated");
    }
  });

  it("rejects a wrong (equal-length) token pre-handler", () => {
    const r = guard(req({ token: WRONG.value }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.message).toBe("unauthenticated");
  });

  it("rejects a valid token with a wrong Origin (FORBIDDEN-equivalent)", () => {
    const r = guard(req({ origin: "http://evil.com" }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("validation_rejected");
  });

  it("rejects a valid token with a wrong Host (DNS-rebind)", () => {
    const r = guard(req({ host: "evil.com" }));
    expect(isErr(r)).toBe(true);
  });

  it("rejects the userinfo-spoof Origin vector even with a valid token", () => {
    const r = guard(req({ origin: "http://evil.com/@localhost:5173" }));
    expect(isErr(r)).toBe(true);
  });

  it("checks the token BEFORE the origin (auth precedes authorization)", () => {
    // A request with BOTH a wrong token AND a wrong origin fails as unauthenticated
    // (token first) — never leaking that the origin was also wrong.
    const r = guard(req({ token: WRONG.value, origin: "http://evil.com" }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.message).toBe("unauthenticated");
  });

  it("returns a typed Result, never throwing across the boundary (§16)", () => {
    // Even a fully-degenerate input must return an err, not throw.
    expect(() =>
      guard({ token: undefined, origin: undefined, host: undefined }),
    ).not.toThrow();
    const r = guard({ token: undefined, origin: undefined, host: undefined });
    expect(isErr(r)).toBe(true);
  });
});
