// 1.10 — idempotency-key builder (PURE, replay-stable).
//
// The idempotencyKey is the §20.1 replay gate's dedupe identity (REQ-NF-006): a
// replayed workflow step (restart/sleep resume, retry, Hermes re-fire) computes
// the SAME key for the SAME logical operation, so the Tool Gateway reuses the
// existing write receipt instead of producing a duplicate external side effect.
// Collisions therefore occur ONLY for a genuinely-identical operation.
//
// PURE + TOTAL: no clock, no Math.random, no env, no I/O — identical input ⇒
// identical output (fixed SHA-256, no external entropy). Nondeterministic input
// would break replay, so the builder takes none.
//
// NORMALIZATION (documented, pinned by keys.test.ts):
//  - `operation` (a caller-controlled step label, e.g. "calendar.create") is
//    trimmed + lowercased — operation labels are case-insensitive by convention.
//    arch_gap: two operations distinguished ONLY by case would collapse; the
//    project's operation names are lowercase dotted identifiers, so this is
//    safe, but it is a documented normalization boundary. (Reported in flags.)
//  - `identity` is normalized by the shared `normalizeIdentity` (order-
//    independent; field names trimmed+lowercased; values trimmed, case
//    preserved) so it matches the canonicalObjectKey's identity treatment.
//  - the preimage is an injective JSON encoding of
//    [version, normalizedOperation, sortedEntries].
//
// OUTPUT: `idem_<sha256hex>` — opaque, and url + filesystem safe (charset
// [a-z0-9_]; the raw `operation` is hashed, never emitted, so arbitrary
// operation strings cannot inject unsafe characters into the key). The distinct
// version tag + `idem_` prefix keep idempotency keys from ever colliding with a
// canonicalObjectKey (`cok_`) built from structurally-similar inputs.
//
// R7-c: shares the PURE `sha256Hex` from `./canonical-key.ts` (no
// `node:crypto`) so this module stays reachable from the @sow/domain barrel
// without dragging a Node built-in into it — see that module's header for why
// the hash lives there instead of a standalone file.
import { normalizeIdentity, sha256Hex } from "./canonical-key";

const IDEMPOTENCY_KEY_VERSION = "sow.idem.v1";

/**
 * Build the deterministic, replay-stable idempotencyKey for `operation` over its
 * `identity`. See module header for the full normalization + safety contract.
 */
export function buildIdempotencyKey(input: {
  operation: string;
  identity: Record<string, string>;
}): string {
  const operation = input.operation.trim().toLowerCase();
  const entries = normalizeIdentity(input.identity);
  const preimage = JSON.stringify([IDEMPOTENCY_KEY_VERSION, operation, entries]);
  return `idem_${sha256Hex(preimage)}`;
}
