// spec(§23.3) spec(§16 fail-closed) spec(rule 7 redaction) — `createRefreshingSecretsAccessor`, the OAuth
// token refresh/expiry/rotation loop built as a WRAPPING `SecretsAccessor` (not an adapter edit; see
// PKG-INT-4 brief). Tested entirely over fakes — no real token endpoint, no real Keychain, no injected clock
// ever reads the wall clock (NOTHING ARMS).
import { describe, it, expect } from "vitest";
import { ok } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import {
  createRefreshingSecretsAccessor,
  type RefreshingSecretsAccessorDeps,
  type TokenRefreshResult,
} from "../src/connectors/adapters/oauth-token";
import type { SecretsAccessor, SecretUnavailable } from "../src/connectors/adapters/http-transport";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REF = "keychain:gmail-oauth";
const NOW = "2026-01-01T00:00:00.000Z";
const SKEW_MS = 5 * 60 * 1000; // 5 minutes

/** The `inner`/`rotate` storage shape this wrapper reads/writes — a JSON `{accessToken, expiresAt}` record
 *  (see oauth-token.ts header — the fixed `SecretsAccessor.getSecret` signature only returns a bare string,
 *  so expiry rides inside that string). */
function tokenRecord(accessToken: string, expiresAt: string): string {
  return JSON.stringify({ accessToken, expiresAt });
}

function fakeInner(
  behavior: { result?: Result<string, SecretUnavailable>; throw?: unknown } = {},
): SecretsAccessor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getSecret(ref) {
      calls.push(ref);
      if (behavior.throw !== undefined) throw behavior.throw;
      return behavior.result ?? ok(tokenRecord("DEFAULT-TOKEN", NOW));
    },
  };
}

type RotateFn = (ref: string, value: string, expiresAt: string) => Promise<Result<void, SecretUnavailable>>;

function fakeRotate(
  behavior: { result?: Result<void, SecretUnavailable>; throw?: unknown } = {},
): RotateFn & { calls: Array<{ ref: string; value: string; expiresAt: string }> } {
  const calls: Array<{ ref: string; value: string; expiresAt: string }> = [];
  const fn = async (ref: string, value: string, expiresAt: string): Promise<Result<void, SecretUnavailable>> => {
    calls.push({ ref, value, expiresAt });
    if (behavior.throw !== undefined) throw behavior.throw;
    return behavior.result ?? ok(undefined);
  };
  return Object.assign(fn, { calls });
}

type RefreshFn = (req: { refreshTokenRef: string }) => Promise<TokenRefreshResult>;

function fakeRefresh(
  behavior: { result?: TokenRefreshResult; throw?: unknown } = {},
): RefreshFn & { calls: Array<{ refreshTokenRef: string }> } {
  const calls: Array<{ refreshTokenRef: string }> = [];
  const fn = async (req: { refreshTokenRef: string }): Promise<TokenRefreshResult> => {
    calls.push(req);
    if (behavior.throw !== undefined) throw behavior.throw;
    return behavior.result ?? { ok: true, accessToken: "DEFAULT-NEW", expiresAt: "2099-01-01T00:00:00.000Z" };
  };
  return Object.assign(fn, { calls });
}

function depsWith(overrides: Partial<RefreshingSecretsAccessorDeps> = {}): RefreshingSecretsAccessorDeps {
  return {
    inner: fakeInner(),
    rotate: fakeRotate(),
    refresh: fakeRefresh(),
    now: () => NOW,
    skewMs: SKEW_MS,
    ...overrides,
  };
}

// ── 1/2. Near-expiry detection against the injected clock ──────────────────────
describe("createRefreshingSecretsAccessor — near-expiry detection against the injected clock", () => {
  it("NOT NEAR EXPIRY (positive control): an expiry beyond now+skewMs is returned as-is, refresh called ZERO times", async () => {
    const farExpiry = "2026-01-01T01:00:00.000Z"; // 1h beyond NOW — well beyond the 5-min skew
    const inner = fakeInner({ result: ok(tokenRecord("AT-CURRENT", farExpiry)) });
    const refresh = fakeRefresh();
    const rotate = fakeRotate();
    const accessor = createRefreshingSecretsAccessor(depsWith({ inner, refresh, rotate }));
    const res = await accessor.getSecret(REF);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe("AT-CURRENT");
    // POSITIVE CONTROL for every test below: an accessor that never refreshes when it shouldn't is the
    // baseline every near-expiry/refresh assertion in this file is measured against.
    expect(refresh.calls).toHaveLength(0);
    expect(rotate.calls).toHaveLength(0);
  });

  it("NEAR EXPIRY: refresh is called exactly once, rotate exactly once with the new value, and the NEW token is returned (never the stale one)", async () => {
    const nearExpiry = "2026-01-01T00:02:00.000Z"; // 2 min beyond NOW — inside the 5-min skew window
    const inner = fakeInner({ result: ok(tokenRecord("AT-STALE", nearExpiry)) });
    const refresh = fakeRefresh({
      result: { ok: true, accessToken: "AT-FRESH", expiresAt: "2026-01-01T02:00:00.000Z" },
    });
    const rotate = fakeRotate();
    const accessor = createRefreshingSecretsAccessor(depsWith({ inner, refresh, rotate }));
    const res = await accessor.getSecret(REF);
    expect(refresh.calls).toHaveLength(1);
    expect(refresh.calls[0]).toEqual({ refreshTokenRef: REF });
    expect(rotate.calls).toHaveLength(1);
    expect(rotate.calls[0]).toEqual({ ref: REF, value: "AT-FRESH", expiresAt: "2026-01-01T02:00:00.000Z" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe("AT-FRESH"); // the NEW token — never "AT-STALE"
  });
});

// ── 3. Thundering herd ──────────────────────────────────────────────────────────
describe("createRefreshingSecretsAccessor — thundering herd shares ONE in-flight refresh", () => {
  it("two concurrent getSecret calls while near expiry produce exactly ONE refresh call", async () => {
    const nearExpiry = "2026-01-01T00:02:00.000Z";
    const inner = fakeInner({ result: ok(tokenRecord("AT-STALE", nearExpiry)) });
    const rotate = fakeRotate();
    const refreshCalls: Array<{ refreshTokenRef: string }> = [];
    let resolveRefresh: (v: TokenRefreshResult) => void = () => {
      throw new Error("resolveRefresh called before assignment");
    };
    const refresh: RefreshFn = async (req) => {
      refreshCalls.push(req);
      return new Promise<TokenRefreshResult>((resolve) => {
        resolveRefresh = resolve;
      });
    };
    const accessor = createRefreshingSecretsAccessor(depsWith({ inner, refresh, rotate }));

    const p1 = accessor.getSecret(REF);
    const p2 = accessor.getSecret(REF);
    // let both calls' microtask chains progress past `inner.getSecret` and reach the refresh call.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshCalls).toHaveLength(1); // exactly ONE refresh call for two concurrent near-expiry reads

    resolveRefresh({ ok: true, accessToken: "AT-SHARED", expiresAt: "2026-01-01T03:00:00.000Z" });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok && r1.value).toBe("AT-SHARED");
    expect(r2.ok && r2.value).toBe("AT-SHARED");
    expect(rotate.calls).toHaveLength(1); // rotate shared too, never doubled
  });
});

// ── 4. Refresh fails closed ──────────────────────────────────────────────────────
describe("createRefreshingSecretsAccessor — a rejected refresh fails closed, rotate NEVER called", () => {
  it("refresh returns ok:false ⇒ err({reason:'locked'}), rotate NEVER called", async () => {
    const nearExpiry = "2026-01-01T00:02:00.000Z";
    const inner = fakeInner({ result: ok(tokenRecord("AT-STALE", nearExpiry)) });
    const refresh = fakeRefresh({ result: { ok: false, code: "invalid_grant" } });
    const rotate = fakeRotate();
    const accessor = createRefreshingSecretsAccessor(depsWith({ inner, refresh, rotate }));
    const res = await accessor.getSecret(REF);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toEqual({ reason: "locked" });
    expect(rotate.calls).toHaveLength(0);
  });
});

// ── 5. Rule 7 — no token value ever reaches a returned error ────────────────────
describe("createRefreshingSecretsAccessor — rule 7: no token value ever reaches a returned error", () => {
  it("the stale access token and the refresh failure's cause never appear in the returned err", async () => {
    const nearExpiry = "2026-01-01T00:02:00.000Z";
    const STALE_MARKER = "STALE-TOKEN-do-not-leak-9f3a";
    const inner = fakeInner({ result: ok(tokenRecord(STALE_MARKER, nearExpiry)) });
    const refresh = fakeRefresh({
      throw: new Error(`token endpoint rejected refresh SECRET_REFRESH_LEAK_${STALE_MARKER}`),
    });
    const rotate = fakeRotate();
    const accessor = createRefreshingSecretsAccessor(depsWith({ inner, refresh, rotate }));
    const res = await accessor.getSecret(REF);
    expect(res.ok).toBe(false);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(STALE_MARKER);
    expect(serialized).not.toContain("SECRET_REFRESH_LEAK");
    expect(rotate.calls).toHaveLength(0);
  });

  it("the fresh access token never appears in the returned err when rotate itself fails to persist it", async () => {
    const nearExpiry = "2026-01-01T00:02:00.000Z";
    const inner = fakeInner({ result: ok(tokenRecord("AT-STALE", nearExpiry)) });
    const FRESH_MARKER = "FRESH-TOKEN-do-not-leak-2b7c";
    const refresh = fakeRefresh({
      result: { ok: true, accessToken: FRESH_MARKER, expiresAt: "2026-01-01T02:00:00.000Z" },
    });
    const rotate = fakeRotate({ throw: new Error(`keychain write failed ROTATE_LEAK_${FRESH_MARKER}`) });
    const accessor = createRefreshingSecretsAccessor(depsWith({ inner, refresh, rotate }));
    const res = await accessor.getSecret(REF);
    expect(res.ok).toBe(false);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(FRESH_MARKER);
    expect(serialized).not.toContain("ROTATE_LEAK");
  });
});

// ── 6. TOTAL: a throwing inner/refresh/rotate each become a typed err, never a throw (L11) ─
describe("createRefreshingSecretsAccessor — a throwing inner/refresh/rotate never throws across the boundary (L11)", () => {
  it("a throwing inner ⇒ typed err, never a throw", async () => {
    const inner: SecretsAccessor = {
      async getSecret() {
        throw new Error("keychain TCC denied INNER_CAUSE_LEAK");
      },
    };
    const accessor = createRefreshingSecretsAccessor(depsWith({ inner }));
    const res = await accessor.getSecret(REF);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain("INNER_CAUSE_LEAK");
  });

  it("a throwing refresh ⇒ typed err, never a throw", async () => {
    const nearExpiry = "2026-01-01T00:02:00.000Z";
    const inner = fakeInner({ result: ok(tokenRecord("AT-STALE", nearExpiry)) });
    const refresh = fakeRefresh({ throw: new Error("token endpoint unreachable REFRESH_CAUSE_LEAK") });
    const accessor = createRefreshingSecretsAccessor(depsWith({ inner, refresh }));
    const res = await accessor.getSecret(REF);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain("REFRESH_CAUSE_LEAK");
  });

  it("a throwing rotate ⇒ typed err, never a throw", async () => {
    const nearExpiry = "2026-01-01T00:02:00.000Z";
    const inner = fakeInner({ result: ok(tokenRecord("AT-STALE", nearExpiry)) });
    const refresh = fakeRefresh({
      result: { ok: true, accessToken: "AT-FRESH", expiresAt: "2026-01-01T02:00:00.000Z" },
    });
    const rotate = fakeRotate({ throw: new Error("keychain write failed ROTATE_CAUSE_LEAK") });
    const accessor = createRefreshingSecretsAccessor(depsWith({ inner, refresh, rotate }));
    const res = await accessor.getSecret(REF);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain("ROTATE_CAUSE_LEAK");
  });
});

// ── 7. The clock is fully injected — no Date.now() anywhere, deterministic ──────
describe("createRefreshingSecretsAccessor — the clock is fully injected (no Date.now() in the module)", () => {
  it("the module source contains no Date.now() call anywhere (grep-pin)", () => {
    const file = fileURLToPath(new URL("../src/connectors/adapters/oauth-token.ts", import.meta.url));
    const src = readFileSync(file, "utf8");
    expect(src).not.toContain("Date.now(");
  });

  it("driving the SAME input twice through the same injected now() produces the identical near-expiry decision (determinism)", async () => {
    const expiresAt = "2026-01-01T00:02:00.000Z"; // near-expiry relative to NOW/SKEW_MS
    const runOnce = async (): Promise<{ ok: boolean; refreshCalls: number }> => {
      const inner = fakeInner({ result: ok(tokenRecord("AT-STALE", expiresAt)) });
      const refresh = fakeRefresh({
        result: { ok: true, accessToken: "AT-FRESH", expiresAt: "2026-01-01T02:00:00.000Z" },
      });
      const accessor = createRefreshingSecretsAccessor(depsWith({ inner, refresh, now: () => NOW }));
      const res = await accessor.getSecret(REF);
      return { ok: res.ok, refreshCalls: refresh.calls.length };
    };
    const a = await runOnce();
    const b = await runOnce();
    expect(a).toEqual(b); // same fixed `now` twice ⇒ identical decision
    expect(a.refreshCalls).toBe(1); // sanity: the near-expiry branch actually fired both runs
  });
});
