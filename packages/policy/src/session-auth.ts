// §5 renderer↔worker session-auth PRIMITIVE (REQ-S-004 / NF-004).
//
// The pure, host-independent core of the local session-auth check: mint a
// high-entropy per-launch bearer token, verify a presented token in CONSTANT
// TIME, and enforce a STRICT Origin/Host allowlist against cross-origin /
// DNS-rebinding callers.
//
// NOTE (§5): loopback binding is NOT authentication. Any local process (or a
// malicious page via DNS-rebinding) can reach a loopback port, so the worker
// authenticates the renderer with a per-launch shared secret AND an Origin/Host
// allowlist — never "it came from 127.0.0.1, therefore trusted".
//
// PURITY: this module is pure EXCEPT for node:crypto, the explicit entropy /
// timing-safe source the task sanctions (randomBytes for the secret,
// timingSafeEqual for the compare, createHash for a non-reversible audit ref).
// No clock, no network, no Math.random. Every cross-boundary fn returns a typed
// PolicyDecision (never throws across a boundary, §16). FAIL-CLOSED: missing /
// malformed / mismatched input ⇒ DENY. REDACTION-SAFE: neither the presented nor
// the expected token bytes ever enter a message or an AuditSignal.
//
// The app-shell wiring (apps/worker auth-guard.ts / session-token.ts,
// apps/desktop inject-token.ts) is an OWNER-APPROVED DEFERMENT to Phase 7/9 —
// those shells are not scaffolded yet. Only this primitive is built here.
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import {
  allowDecision,
  denyDecision,
  type PolicyDecision,
} from "./decision";
import { POLICY_DENIAL_HEALTH_CLASS, buildAuditSignal } from "./audit-signal";

// Nominal brand so a SessionToken value cannot be confused with an arbitrary
// string at a type boundary (opaque wrapper).
declare const SessionTokenValueBrand: unique symbol;
export type SessionTokenValue = string & {
  readonly [SessionTokenValueBrand]: "SessionTokenValue";
};

/**
 * An opaque per-launch session credential. `value` is the high-entropy secret
 * (32 random bytes as hex); `launchId` is a fresh per-launch identity so a token
 * minted by a previous launch is distinct from the current launch's token. The
 * caller mints exactly ONE of these per launch and holds it in the worker.
 */
export interface SessionToken {
  readonly value: SessionTokenValue;
  readonly launchId: string;
}

/** Default entropy source — node:crypto CSPRNG. Injectable for deterministic tests. */
type Rng = (n: number) => Buffer;
const defaultRng: Rng = (n) => randomBytes(n);

const TOKEN_BYTES = 32; // 256-bit secret
const LAUNCH_ID_BYTES = 16; // 128-bit per-launch identity

/**
 * Mint a fresh high-entropy session token. The secret is drawn from `rng`
 * (default node:crypto randomBytes) — NOT derived from any guessable value
 * (pid, port, timestamp, path). `rng` is injectable so tests are deterministic.
 * Call ONCE per launch.
 */
export function mintSessionToken(rng: Rng = defaultRng): SessionToken {
  const value = rng(TOKEN_BYTES).toString("hex") as SessionTokenValue;
  const launchId = rng(LAUNCH_ID_BYTES).toString("hex");
  return { value, launchId };
}

/**
 * A non-reversible audit ref bound to the launch identity. Lets an auditor
 * correlate the event to a launch WITHOUT revealing the token secret or even the
 * raw launchId. `sha256:` prefix keeps it redaction-safe (see audit-signal).
 */
function launchRef(launchId: string): string {
  return "sha256:" + createHash("sha256").update(launchId).digest("hex");
}

function denyAuth(
  message: string,
  refs: readonly string[],
): PolicyDecision<{ authenticated: true }> {
  return denyDecision(
    "AUTH_TOKEN_INVALID",
    message,
    buildAuditSignal({
      actor: "policy",
      event: "session-auth.denied",
      refs,
      // Hash of a fixed marker — carries no secret; present so the audit is complete.
      payloadHash: "sha256:" + createHash("sha256").update("session-auth").digest("hex"),
      beforeSummary: "session token not verified",
      afterSummary: "authenticated=false",
      denialCode: "AUTH_TOKEN_INVALID",
      healthSignalClass: POLICY_DENIAL_HEALTH_CLASS,
    }),
  );
}

/**
 * Verify a presented token against the CURRENT-launch expected token in constant
 * time. The comparison is over the token's hex bytes via `crypto.timingSafeEqual`
 * — unequal length is rejected by a length guard FIRST (timingSafeEqual throws on
 * unequal length, and an early length-based reject leaks no per-byte timing about
 * the CONTENT). A token from a prior launch has a different secret than the
 * current-launch expected token, so it fails the compare ⇒ deny (staleness).
 *
 * FAIL-CLOSED: missing / malformed / mismatched ⇒ deny AUTH_TOKEN_INVALID BEFORE
 * any handler runs. REDACTION-SAFE: the presented and expected token bytes never
 * appear in the message or AuditSignal.
 */
export function verifySessionToken(
  presented: string,
  expected: SessionToken,
): PolicyDecision<{ authenticated: true }> {
  // Fail-closed input guard — never trust the shape of either operand.
  if (
    typeof presented !== "string" ||
    expected === null ||
    typeof expected !== "object" ||
    typeof expected.value !== "string" ||
    typeof expected.launchId !== "string"
  ) {
    return denyAuth("session token verification failed", ["session-auth:malformed"]);
  }

  const ref = launchRef(expected.launchId);
  const presentedBuf = Buffer.from(presented, "utf8");
  const expectedBuf = Buffer.from(expected.value, "utf8");

  // Length guard BEFORE any content compare: timingSafeEqual requires equal
  // length, and a length mismatch is not content, so an early reject leaks
  // nothing about the secret bytes.
  if (presentedBuf.length !== expectedBuf.length) {
    return denyAuth("session token verification failed", [ref]);
  }

  // Constant-time content comparison over the full length.
  if (!timingSafeEqual(presentedBuf, expectedBuf)) {
    return denyAuth("session token verification failed", [ref]);
  }

  return allowDecision(
    { authenticated: true },
    buildAuditSignal({
      actor: "policy",
      event: "session-auth.verified",
      refs: [ref],
      payloadHash: ref,
      beforeSummary: "session token not verified",
      afterSummary: "authenticated=true",
    }),
  );
}

/** A strict Origin/Host allowlist for the local worker's admission check. */
export interface OriginAllowlist {
  readonly origins: readonly string[];
  readonly hosts: readonly string[];
}

/**
 * STRICT Origin/Host allowlist check. The presented `origin` AND `host` must both
 * appear on the allowlist by exact string match — this rejects cross-origin
 * callers and DNS-rebinding attacks (where a malicious page resolves a name to
 * loopback but presents a foreign Host header). Loopback binding is NOT
 * authentication (§5), so this predicate is required in addition to the token.
 *
 * FAIL-CLOSED: a malformed allowlist ⇒ MALFORMED_POLICY_INPUT; an empty or
 * off-list origin/host ⇒ ORIGIN_NOT_ALLOWED.
 */
export function isOriginAllowed(
  origin: string,
  host: string,
  allowlist: OriginAllowlist,
): PolicyDecision<{ ok: true }> {
  if (
    allowlist === null ||
    typeof allowlist !== "object" ||
    !Array.isArray(allowlist.origins) ||
    !Array.isArray(allowlist.hosts) ||
    typeof origin !== "string" ||
    typeof host !== "string"
  ) {
    return denyDecision(
      "MALFORMED_POLICY_INPUT",
      "origin allowlist check received malformed input",
      buildAuditSignal({
        actor: "policy",
        event: "session-auth.origin.denied",
        refs: ["session-auth:origin:malformed"],
        payloadHash: "sha256:" + createHash("sha256").update("origin").digest("hex"),
        beforeSummary: "origin not evaluated",
        afterSummary: "origin allowlist check: malformed",
        denialCode: "MALFORMED_POLICY_INPUT",
        healthSignalClass: POLICY_DENIAL_HEALTH_CLASS,
      }),
    );
  }

  const allowed =
    origin.length > 0 &&
    host.length > 0 &&
    allowlist.origins.includes(origin) &&
    allowlist.hosts.includes(host);

  if (!allowed) {
    return denyDecision(
      "ORIGIN_NOT_ALLOWED",
      "origin or host is not on the strict allowlist",
      buildAuditSignal({
        actor: "policy",
        event: "session-auth.origin.denied",
        refs: ["session-auth:origin"],
        payloadHash: "sha256:" + createHash("sha256").update("origin").digest("hex"),
        beforeSummary: "origin not evaluated",
        afterSummary: "origin allowlist check: denied",
        denialCode: "ORIGIN_NOT_ALLOWED",
        healthSignalClass: POLICY_DENIAL_HEALTH_CLASS,
      }),
    );
  }

  return allowDecision(
    { ok: true },
    buildAuditSignal({
      actor: "policy",
      event: "session-auth.origin.allowed",
      refs: ["session-auth:origin"],
      payloadHash: "sha256:" + createHash("sha256").update("origin").digest("hex"),
      beforeSummary: "origin not evaluated",
      afterSummary: "origin allowlist check: allowed",
    }),
  );
}
