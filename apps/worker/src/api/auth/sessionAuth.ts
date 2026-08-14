// Task 8.1 (a) — per-launch session-token VERIFY, worker-side.
//
// The worker VERIFIES a presented session token against the current-launch
// expected token. It does NOT mint or persist it — Electron main mints the token
// and injects it into the renderer (that wiring is Phase 9). This module is a
// thin transport adapter over the Phase-3 PURE policy primitive
// `@sow/policy` `verifySessionToken` (which does the CONSTANT-TIME compare via
// `crypto.timingSafeEqual` behind a length guard); it maps the policy's
// `PolicyDecision` onto the §16 worker-boundary `Result<T, FailureVariant>`.
//
// §16: never throws across a subsystem boundary — every path returns a typed
// Result. REDACTION-SAFE: the policy primitive keeps the token bytes out of its
// audit/message, and this wrapper's failure message is the fixed literal
// "unauthenticated" — the presented/expected secret never enters a Result.
import { ok, err, type Result, type FailureVariant, failure } from "@sow/contracts";
import { verifySessionToken as policyVerifySessionToken, isAllow, type SessionToken } from "@sow/policy";

/**
 * The successful authentication context handed to a procedure/handler once the
 * per-launch token verifies. Deliberately minimal — the token itself never rides
 * along, only the fact of authentication.
 *
 * ⛔⛔ THERE IS NO PRINCIPAL HERE, AND THAT IS A DECISION — NOT A GAP. OWNER-RULED
 * 2026-08-14 (tasks `#51` / `### 24.62` boundary (b)). DO NOT "FIX" THIS BY ADDING A
 * SUBJECT: the owner declined both a principal and a tripwire, explicitly.
 *
 * WHY: SoW is single-owner and local-first — all workspaces belong to the same person.
 * ⇒ safety rule 4 protects CONTENT SCOPE (employer content must not surface in personal
 * outputs), NOT one principal from another. There is no "someone else's workspace"
 * because there is only one owner. Auth here answers *"is this request from the owner's
 * session?"* — it authenticates the REQUEST, not an ACTOR, and one shared per-launch
 * token is the correct shape for that question.
 *
 * ⭐ WHAT ACTUALLY CONSTRAINS A REQUEST'S `workspaceId`, stated because an absence-only
 * note tells the next reader nothing about what protects them: **the control is
 * "is this workspace SERVED by this deployment", NOT "is this workspace the caller's".**
 * It is enforced downstream, not here — `createMultiServedGbrainRetrieval`
 * (`api/procedures/copilotGbrainSubprocess.ts`) gates the brain read on REGISTRY
 * MEMBERSHIP (an unregistered workspace fails closed to a fixture and the brain is never
 * read for it) and then applies a MANDATORY per-request scope filter bound to the
 * registry-authoritative id — server-derived, never the raw input, with no passthrough
 * branch. ⚠ Resolvers take `_ctx` and discard it; that is consistent with the above and
 * is not an oversight, but it does mean this file is the ONLY place the reasoning lives.
 *
 * ⚠ SEPARATE AND STILL OPEN — do not read the ruling as closing it: whether a workspace
 * id is WELL-SHAPED is a different question from who may name it, and the ruling is about
 * the caller, not the string. `parseCreateWorkspace` admits any non-empty string as an id,
 * so "registry-validated" means "someone inserted it", not "an authority vouched for its
 * shape" (`contracts L147`; traced at `#52`).
 */
export interface AuthedContext {
  readonly authenticated: true;
}

/**
 * Verify a presented session token against the current-launch `expected` token.
 *
 * `presented` is `string | undefined` because a raw transport header may be
 * absent; a missing / non-string / mismatched token all fail-closed to the SAME
 * opaque failure so an attacker learns nothing from the shape of the rejection.
 *
 * Delegates the actual compare to the Phase-3 policy primitive (constant-time,
 * fail-closed). On DENY, returns `err(failure("validation_rejected",
 * "unauthenticated"))`; on ALLOW, returns `ok({ authenticated: true })`. Never
 * throws (§16).
 */
export function verifySessionToken(
  presented: string | undefined,
  expected: SessionToken,
): Result<AuthedContext, FailureVariant> {
  // Normalize an absent header to the empty string — the policy primitive treats
  // it as a fail-closed length mismatch, never an allow.
  const token = typeof presented === "string" ? presented : "";
  const decision = policyVerifySessionToken(token, expected);
  if (isAllow(decision)) {
    return ok({ authenticated: true });
  }
  // Opaque, redaction-safe rejection — no per-reason detail, no secret bytes.
  return err(failure("validation_rejected", "unauthenticated"));
}
