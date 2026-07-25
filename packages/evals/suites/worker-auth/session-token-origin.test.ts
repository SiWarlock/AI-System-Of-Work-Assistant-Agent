// spec(§12 · §5) — task 12.18 (worker-API session-token/Origin auth leg).
//
// §12 DoD acceptance suite for the worker-API auth boundary (§5): every tRPC call
// AND the WS/SSE stream handshake require a valid per-launch session token, and
// the strict Origin/Host allowlist rejects a disallowed origin (anti DNS-rebind) —
// even from loopback ("loopback binding is NOT authentication"). Drives the REAL
// EXPORTED worker auth surface (imports only; edits no worker file).
//
// Relationship to the Task-8.7 gate (`src/worker-api-auth/auth-suite.ts`): that
// runner already drives the real boundary for the CORE vectors (no-token /
// wrong-token / wrong-origin=`evil.com` / wrong-host=`evil.com`) across the tRPC
// query+command boundary AND the WS handshake, pre-handler, + loopback-bind. This
// §12 acceptance suite (a) RE-CERTIFIES that gate from the canonical `suites/`
// location by invoking the same real-boundary runner (harness reuse, brief Q3),
// and (b) ADDS the coverage that gate lacks: the anti-DNS-rebind SPOOF vectors on
// BOTH of checkOrigin's gate-paths — the Origin (matched by RAW exact string, so
// an off-port / scheme-variant / path-`@` Origin cannot collapse onto the on-list
// entry) AND the Host (matched by its Lesson-4-ISOLATED authority, so a userinfo /
// path-`@` Host — which a userinfo-FIRST parser would misread as an on-list
// authority — is read at its real host and rejected), plus fail-closed
// empty/undefined, plus the handshake token-SOURCE discipline (a token smuggled in
// a `url` field is treated as absent). There is one transport-agnostic handshake
// gate (`runStreamHandshake`) — no distinct SSE server path exists — so "WS/SSE
// handshake" is that single gate.
//
// Deterministic + provider-free: fixed-rng session tokens (mirror `auth-suite.ts`);
// no live infra. §16: the imported surface never throws — every path is a Result.
import { describe, it, expect, beforeAll } from "vitest";
import { isErr, isOk } from "@sow/contracts";
import { mintSessionToken, type SessionToken } from "@sow/policy";
import { makeAuthInterceptor, type AuthInterceptor } from "@sow/worker/api/auth/interceptor";
import { checkOrigin, type WorkerOriginAllowlist } from "@sow/worker/api/auth/originAllowlist";
import { assertLoopbackBind } from "@sow/worker/api/auth/loopbackBind";
import { runStreamHandshake } from "@sow/worker/api/stream/handshake";
import { runAuthSuite } from "../../src/worker-api-auth/auth-suite";

// ── Fixed-rng session tokens (deterministic; equal-length wrong-token) ────────
function fixedRng(byte: number): (n: number) => Buffer {
  return (n: number) => Buffer.alloc(n, byte);
}
const EXPECTED: SessionToken = mintSessionToken(fixedRng(0xab));
const WRONG: SessionToken = mintSessionToken(fixedRng(0xcd)); // different, equal-length

const ALLOWLIST: WorkerOriginAllowlist = {
  origins: ["http://localhost:5173"],
  hosts: ["localhost:5173"],
};
const GOOD_ORIGIN = "http://localhost:5173";
const GOOD_HOST = "localhost:5173";

const INTERCEPTOR: AuthInterceptor = makeAuthInterceptor({
  expectedToken: EXPECTED,
  allowlist: ALLOWLIST,
});

// ===========================================================================
// (0) core boundary gate — RE-CERTIFY the real tRPC + handshake + bind gate
//     from the canonical suites/ location by invoking the 8.7 real-boundary
//     runner (harness reuse; not a re-implemented check).
// ===========================================================================
describe("§12/§5 — the real worker-API auth boundary gate holds (harness reuse)", () => {
  // The runner boots multiple real createApiServer instances + push streams per
  // call; run it ONCE and share the folded result across the section's assertions.
  let gate: Awaited<ReturnType<typeof runAuthSuite>>;
  beforeAll(async () => {
    gate = await runAuthSuite();
  });

  it("every core reject vector is refused at BOTH the tRPC boundary AND the WS handshake, pre-handler", () => {
    const failed = gate.cases.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail ?? ""}`);
    expect(failed, `failing cases:\n${failed.join("\n")}`).toEqual([]);
    expect(gate.allPassed).toBe(true);
  });

  it("certifies the required boundary case ids exist (tRPC query+command, WS handshake+subscribe, loopback bind)", () => {
    const ids = new Set(gate.cases.map((c) => c.id));
    for (const v of ["no-token", "wrong-token", "wrong-origin", "wrong-host"]) {
      expect(ids.has(`auth.query.${v}`), `missing auth.query.${v}`).toBe(true);
      expect(ids.has(`auth.command.${v}`), `missing auth.command.${v}`).toBe(true);
      expect(ids.has(`auth.stream.handshake.${v}`), `missing auth.stream.handshake.${v}`).toBe(true);
      expect(ids.has(`auth.stream.subscribe.${v}`), `missing auth.stream.subscribe.${v}`).toBe(true);
    }
    expect(ids.has("auth.bind.refuse.0.0.0.0")).toBe(true);
  });
});

// ===========================================================================
// (1) tRPC path — the session token is required (loopback is NOT auth)
// ===========================================================================
describe("§5 — the session token is required on the request path, even from loopback", () => {
  it("a missing token from an allowlisted loopback origin is REJECTED (loopback binding ≠ authentication)", () => {
    const r = INTERCEPTOR({ token: undefined, origin: GOOD_ORIGIN, host: GOOD_HOST });
    expect(isErr(r)).toBe(true);
  });

  it("a wrong (equal-length) token is REJECTED via the constant-time compare", () => {
    const r = INTERCEPTOR({ token: WRONG.value, origin: GOOD_ORIGIN, host: GOOD_HOST });
    expect(isErr(r)).toBe(true);
  });

  it("the valid token + an allowlisted origin/host is ADMITTED (no false-reject)", () => {
    const r = INTERCEPTOR({ token: EXPECTED.value, origin: GOOD_ORIGIN, host: GOOD_HOST });
    expect(isOk(r)).toBe(true);
  });
});

// ===========================================================================
// (2) anti-DNS-rebind Origin/Host allowlist — the SPOOF vectors 8.7 lacks.
//     checkOrigin gates on TWO distinct paths, exercised separately below:
//       · Origin  — matched by RAW exact string (never authority-normalized), so
//         an off-port / scheme-variant / path-`@` Origin can't collapse on-list.
//       · Host    — matched by its Lesson-4-ISOLATED authority (path/query/frag/
//         backslash stripped BEFORE userinfo), so a userinfo/path-`@` Host is read
//         at its REAL host (evil.com) — a userinfo-FIRST parser would misread the
//         trailing `localhost:5173` and wrongly admit.
//     Each is driven with a VALID token so the ORIGIN/HOST gate is what bites.
// ===========================================================================
interface OriginVector {
  readonly id: string;
  readonly origin: string | undefined;
  readonly host: string | undefined;
}

// Origin-position: rejected by the RAW-origin exact-match failing (host is on-list).
const ORIGIN_RAW_MATCH_VECTORS: readonly OriginVector[] = [
  // path-`@`: the raw Origin string differs from the on-list entry (real authority evil.com).
  { id: "origin-path-at", origin: "http://evil.com/@localhost:5173", host: GOOD_HOST },
  // off-port: on-host, OFF-port — the raw Origin differs, no port-collapse.
  { id: "origin-off-port", origin: "http://localhost:5174", host: GOOD_HOST },
  // scheme mismatch: https is not the on-list http Origin.
  { id: "origin-scheme-mismatch", origin: "https://localhost:5173", host: GOOD_HOST },
  // backslash authority-confusion in the raw Origin string.
  { id: "origin-backslash", origin: "http://localhost:5173\\@evil.com", host: GOOD_HOST },
  // fail-closed: empty / missing Origin.
  { id: "origin-empty", origin: "", host: GOOD_HOST },
  { id: "origin-undefined", origin: undefined, host: GOOD_HOST },
];

// Host-position: rejected by the Lesson-4-ISOLATED host authority (Origin is on-list).
const HOST_ISOLATION_VECTORS: readonly OriginVector[] = [
  // path-`@` on the Host: real authority is evil.com (the `/@localhost:5173` is PATH);
  // a userinfo-FIRST isolator would misread `localhost:5173` and wrongly admit.
  { id: "host-path-at-spoof", origin: GOOD_ORIGIN, host: "evil.com/@localhost:5173" },
  // userinfo `@` on the Host: `user@host` → the real host is evil.com.
  { id: "host-userinfo-spoof", origin: GOOD_ORIGIN, host: "localhost:5173@evil.com" },
  // suffix rebind: Origin on-list, Host is a rebind suffix (exact-match fails).
  { id: "host-suffix-rebind", origin: GOOD_ORIGIN, host: "localhost:5173.evil.com" },
  // fail-closed: missing Host.
  { id: "host-undefined", origin: GOOD_ORIGIN, host: undefined },
];

const SPOOF_VECTORS: readonly OriginVector[] = [...ORIGIN_RAW_MATCH_VECTORS, ...HOST_ISOLATION_VECTORS];

describe("§5 — the strict Origin/Host allowlist rejects the anti-DNS-rebind spoof vectors", () => {
  for (const v of SPOOF_VECTORS) {
    it(`${v.id}: checkOrigin rejects (fail-closed)`, () => {
      expect(isErr(checkOrigin(v.origin, v.host, ALLOWLIST))).toBe(true);
    });

    it(`${v.id}: the composed interceptor rejects even an AUTHENTICATED caller`, () => {
      const r = INTERCEPTOR({ token: EXPECTED.value, origin: v.origin, host: v.host });
      expect(isErr(r)).toBe(true);
    });
  }

  it("the allowlisted origin/host still passes checkOrigin (the spoof set narrows, never widens)", () => {
    expect(isOk(checkOrigin(GOOD_ORIGIN, GOOD_HOST, ALLOWLIST))).toBe(true);
  });
});

// ===========================================================================
// (3) WS/SSE handshake — the token is required AND rides connectionParams.token,
//     never a URL (safety rule 7). Origin/Host allowlist applies here too.
// ===========================================================================
describe("§5 — the stream handshake requires the token (from connectionParams, never a URL)", () => {
  it("a null connectionParams (no token) is REJECTED pre-subscription", () => {
    const hs = runStreamHandshake(INTERCEPTOR, { connectionParams: null, origin: GOOD_ORIGIN, host: GOOD_HOST });
    expect(isErr(hs)).toBe(true);
  });

  it("a token smuggled in a `url` field (not `token`) is treated as ABSENT ⇒ REJECTED", () => {
    const hs = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { url: EXPECTED.value },
      origin: GOOD_ORIGIN,
      host: GOOD_HOST,
    });
    expect(isErr(hs)).toBe(true);
  });

  it("a valid token in connectionParams but a SPOOFED origin is REJECTED (allowlist applies at the handshake)", () => {
    const hs = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { token: EXPECTED.value },
      origin: "http://evil.com/@localhost:5173",
      host: GOOD_HOST,
    });
    expect(isErr(hs)).toBe(true);
  });

  it("a valid token in connectionParams + an allowlisted origin/host is ADMITTED (positive control)", () => {
    const hs = runStreamHandshake(INTERCEPTOR, {
      connectionParams: { token: EXPECTED.value },
      origin: GOOD_ORIGIN,
      host: GOOD_HOST,
    });
    expect(isOk(hs)).toBe(true);
  });
});

// ===========================================================================
// (4) loopback-only bind (REQ-NF-004) — the bind-time invariant behind the posture
// ===========================================================================
describe("§5 — loopback-only bind (loopback binding is not, by itself, authentication)", () => {
  it("a remotely-reachable bind address is REFUSED", () => {
    expect(isErr(assertLoopbackBind("0.0.0.0"))).toBe(true);
    expect(isErr(assertLoopbackBind("192.168.1.10"))).toBe(true);
    expect(isErr(assertLoopbackBind("127.0.0.1.evil.com"))).toBe(true); // loopback-suffix spoof
  });

  it("a loopback bind address is admitted", () => {
    expect(isOk(assertLoopbackBind("127.0.0.1"))).toBe(true);
    expect(isOk(assertLoopbackBind("::1"))).toBe(true);
  });
});
