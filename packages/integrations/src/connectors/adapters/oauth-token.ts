// @sow/integrations — §23.3 OAuth token refresh, expiry and rotation loop, built as a WRAPPING
// `SecretsAccessor`, NOT an adapter edit. `createRefreshingSecretsAccessor` decorates an injected `inner`
// `SecretsAccessor` (the http-transport.ts seam at `ConnectorHttpTransportDeps.secrets`) with near-expiry
// detection + a token-endpoint refresh + rotation-through-the-injected-sink loop. Because the return value
// IS a `SecretsAccessor`, every EXISTING Bearer connector (drive/calendar/gmail/granola/asana — none edited
// by this slice) inherits refresh for free by having this wrapper bound in front of its real accessor at the
// owner's arming boundary — zero adapter change (see PKG-INT-4 brief; PKG-INT-5 separately owns those files).
//
// STORAGE SHAPE (a documented candidate, arch_gap): `SecretsAccessor.getSecret(ref)` can only resolve to a
// bare `string` (the interface is fixed at http-transport.ts and NOT edited here), so the token record this
// wrapper reads/writes through `inner`/`rotate` is a JSON-encoded `{ accessToken, expiresAt }` string — the
// same shape a real Keychain-backed OAuth adapter would store (Keychain items are opaque blobs; storing the
// whole token envelope, not just the bearer value, is how a real implementation tracks expiry without a
// second store). `rotate(ref, value, expiresAt)` persists a FRESH record through the injected sink (a real
// Keychain write in production); `refresh({ refreshTokenRef })` exchanges the (out-of-band, same `ref` —
// there is no second ref threaded through this seam) stored refresh token for a new access token via an
// injected token-endpoint call. Both are UNBOUND in the shipped default (NOTHING ARMS): no real token
// endpoint, no real Keychain, no provisioned credential — only fakes reach this module in every test.
//
// Fail-closed + redaction (safety rule 7) at every step: a throwing `inner`/`refresh`/`rotate`, or a `refresh`
// that reports `ok:false`, ALL become a typed `err<SecretUnavailable>` — never a thrown value, and the access
// token / refresh token / any rotated value NEVER appears in that `err` (only inside the injected `rotate`
// sink, which is Keychain in production). A single in-flight `refresh`+`rotate` cycle is SHARED per `ref`
// across concurrent `getSecret` calls (thundering-herd guard) so N callers near expiry trigger exactly ONE
// refresh. The clock is FULLY injected (`deps.now`) — this module never reads the wall clock directly
// (pinned by a source-scan test), so a fixed `now` makes the near-expiry decision fully deterministic.
import { ok, err, isErr } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type { SecretsAccessor, SecretUnavailable } from "./http-transport";

/** The refresh request: `refreshTokenRef` is the SAME `ref` `getSecret` was called with — this seam does not
 *  thread a second, distinct ref. A real token-endpoint adapter resolves the actual refresh-token VALUE for
 *  that ref itself (out of band of this wrapper), mirroring how `inner`/`rotate` already key off `ref`. */
export interface TokenRefreshRequest {
  readonly refreshTokenRef: string;
}

/** A successful token-endpoint exchange: a fresh access token + its expiry, and OPTIONALLY a rotated refresh
 *  token (refresh-token rotation, e.g. Google's rotating refresh tokens) — this wrapper does not need to read
 *  `refreshToken` itself (persisting it, if present, is the real `rotate` sink's concern in production; this
 *  module never inspects or forwards it beyond the closed `TokenRefreshResult` type). */
export interface TokenRefreshSuccess {
  readonly ok: true;
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly refreshToken?: string;
}

/** A failed token-endpoint exchange. CLOSED code set — `"unreachable"` (network/endpoint fault), `"invalid_grant"`
 *  (the refresh token itself was rejected/revoked by the vendor), `"unknown"` (anything else). Every code maps
 *  to the SAME fail-closed `SecretUnavailable({reason:"locked"})` below — the code is diagnostic-only here,
 *  mirroring how `http-transport.ts`'s `TransportFailure.code` is diagnostic while the base gateway collapses
 *  every failure to one branch. */
export interface TokenRefreshFailure {
  readonly ok: false;
  readonly code: "unreachable" | "invalid_grant" | "unknown";
}

/** The token-endpoint exchange result — closed union, never a throw across this boundary (mirrors `refresh`'s
 *  doc contract below; a THROWING `refresh` is caught by the wrapper and converted the same as `ok:false`). */
export type TokenRefreshResult = TokenRefreshSuccess | TokenRefreshFailure;

/** All deps INJECTED — nothing here reaches a real token endpoint, a real Keychain, or the wall clock. */
export interface RefreshingSecretsAccessorDeps {
  /** The wrapped accessor. Its `getSecret(ref)` value MUST be the JSON `{accessToken, expiresAt}` record
   *  described above (a plain bearer string with no expiry would give this wrapper nothing to compare
   *  against `now()+skewMs`, so a value that fails to parse into that shape is treated as `{reason:"missing"}`
   *  — fail-closed, never treated as a valid never-expiring token). */
  readonly inner: SecretsAccessor;
  /** Persists a freshly refreshed token through the injected sink (Keychain in production). Returning a typed
   *  `Err` propagates that SAME reason back out of `getSecret` (rotate already speaks `SecretUnavailable`); a
   *  THROWING `rotate` is caught and converted to `{reason:"locked"}` (never a thrown value, rule 7). */
  readonly rotate: (ref: string, value: string, expiresAt: string) => Promise<Result<void, SecretUnavailable>>;
  /** Exchanges the stored refresh token for a new access token via an injected token-endpoint call. */
  readonly refresh: (req: TokenRefreshRequest) => Promise<TokenRefreshResult>;
  /** The injected clock — an ISO-8601 instant. The module never reads the wall clock directly (no bare
   *  `Date` construction); this is the ONLY time source it reads, so a fixed `now` makes near-expiry
   *  detection fully deterministic. */
  readonly now: () => string;
  /** The near-expiry skew window in milliseconds: a token whose `expiresAt` falls at or before `now()+skewMs`
   *  is treated as near-expiry (refresh-eligible) even though it has not technically expired yet. */
  readonly skewMs: number;
}

interface StoredTokenRecord {
  readonly accessToken: string;
  readonly expiresAt: string;
}

/** Parse `inner`'s raw value as a `StoredTokenRecord`. A non-JSON value, or JSON missing either field as a
 *  string, is NOT a usable token — fails closed to `undefined` (the caller treats that as `{reason:"missing"}`)
 *  rather than silently treating a malformed value as a live, non-expiring token. */
function parseTokenRecord(raw: string): StoredTokenRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.accessToken !== "string" || typeof record.expiresAt !== "string") return undefined;
  return { accessToken: record.accessToken, expiresAt: record.expiresAt };
}

/** `true` when `expiresAt` is NOT safely beyond `now()+skewMs` — i.e. refresh-eligible. An unparseable
 *  `expiresAt`/`now` (NaN) fails toward TRUE (refresh-eligible): a clock/date value this module cannot
 *  attest as "safely in the future" is never treated as fresh (fail-closed, mirrors the codebase's
 *  presence/finiteness discipline elsewhere — e.g. providers L8/L9 "thread by presence, never truthiness"). */
function isNearExpiry(expiresAt: string, nowIso: string, skewMs: number): boolean {
  const expiryMs = Date.parse(expiresAt);
  const nowMs = Date.parse(nowIso);
  return !(Number.isFinite(expiryMs) && Number.isFinite(nowMs) && expiryMs > nowMs + skewMs);
}

/**
 * Build a `SecretsAccessor` that transparently refreshes a near-expiry OAuth token in front of `deps.inner`.
 * DORMANT/unbound by construction — `deps.refresh`/`deps.rotate` are the owner's real token-endpoint/Keychain
 * bindings and stay UNINJECTED at boot; every test here supplies fakes (NOTHING ARMS).
 */
export function createRefreshingSecretsAccessor(deps: RefreshingSecretsAccessorDeps): SecretsAccessor {
  const { inner, rotate, refresh, now, skewMs } = deps;
  // Thundering-herd guard: concurrent `getSecret(ref)` calls while `ref` is near expiry share ONE in-flight
  // refresh+rotate cycle (keyed by `ref` so distinct refs never block each other). Cleared once settled so a
  // LATER, separate near-expiry window triggers its own fresh cycle.
  const inFlight = new Map<string, Promise<Result<string, SecretUnavailable>>>();

  function refreshAndRotate(ref: string): Promise<Result<string, SecretUnavailable>> {
    const existing = inFlight.get(ref);
    if (existing !== undefined) return existing;
    const cycle = (async (): Promise<Result<string, SecretUnavailable>> => {
      let refreshed: TokenRefreshResult;
      try {
        refreshed = await refresh({ refreshTokenRef: ref });
      } catch {
        return err({ reason: "locked" }); // a throwing refresh fails closed the same as ok:false (rule 7, L11)
      }
      if (!refreshed.ok) {
        return err({ reason: "locked" }); // refresh REJECTED (unreachable/invalid_grant/unknown) — rotate NEVER called
      }
      try {
        const rotated = await rotate(ref, refreshed.accessToken, refreshed.expiresAt);
        if (isErr(rotated)) return rotated; // propagate rotate's OWN typed reason unchanged
      } catch {
        return err({ reason: "locked" }); // a throwing rotate fails closed too — never a thrown value (L11)
      }
      return ok(refreshed.accessToken);
    })();
    inFlight.set(ref, cycle);
    void cycle.finally(() => {
      inFlight.delete(ref);
    });
    return cycle;
  }

  return {
    async getSecret(ref: string): Promise<Result<string, SecretUnavailable>> {
      let raw: Result<string, SecretUnavailable>;
      try {
        raw = await inner.getSecret(ref);
      } catch {
        return err({ reason: "denied" }); // a throwing inner fails closed — never a thrown value (rule 7, L11)
      }
      if (isErr(raw)) return raw; // inner's own typed unavailability propagates unchanged, no refresh attempted

      const record = parseTokenRecord(raw.value);
      if (record === undefined) return err({ reason: "missing" }); // malformed stored value ⇒ no usable token

      if (!isNearExpiry(record.expiresAt, now(), skewMs)) {
        return ok(record.accessToken); // safely beyond now()+skewMs — return as-is, ZERO refresh calls
      }
      return refreshAndRotate(ref);
    },
  };
}
