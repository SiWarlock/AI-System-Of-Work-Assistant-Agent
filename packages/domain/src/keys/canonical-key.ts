// 1.10 — canonical-object-key builder (PURE, replay-stable).
//
// The canonicalObjectKey is the §8 envelope's stable identity for a logical
// EXTERNAL object: the SAME logical object yields the SAME key across runs and
// processes, enabling the Tool Gateway's pre-write existence check (vendor
// create-tools lack native idempotency keys, so match-by-canonical-key-then-
// reuse-on-hit is mandatory before every create — §8 / §20.1).
//
// PURE + TOTAL: no clock, no Math.random, no env, no I/O — identical input ⇒
// identical output. Determinism is achieved with a fixed SHA-256 over a
// canonicalized preimage; SHA-256 has no external entropy.
//
// NORMALIZATION (documented, pinned by keys.test.ts):
//  - identity entries are ORDER-INDEPENDENT (sorted by normalized key, then
//    value, using code-unit `<`/`>` — never locale-dependent `localeCompare`,
//    which would break cross-machine replay).
//  - each identity FIELD NAME (the label, caller-controlled) is trimmed +
//    lowercased — field-name case is not load-bearing identity.
//  - each identity VALUE is trimmed only; value CASE is PRESERVED.
//    arch_gap: the input shape carries no per-field case-sensitivity metadata,
//    so we cannot know which values are case-insensitive. We choose the
//    correctness-safe direction: NOT lowercasing values, because collapsing two
//    genuinely-distinct external objects into one key would make the existence
//    check match the WRONG object (silent mis-write) — strictly worse than a
//    duplicate create. A target system needing case-insensitive value matching
//    must pre-normalize the value before calling. (Reported in flags.)
//  - the preimage is an injective JSON encoding of [version, targetSystem,
//    sortedEntries]; JSON string-escaping removes any delimiter-collision
//    ambiguity between adjacent entries (e.g. {ab:"c"} ≠ {a:"bc"}).
//
// OUTPUT: `cok_<targetSystem>_<sha256hex>` — opaque, and url + filesystem safe
// (charset [a-z0-9_]; no `:`, `/`, or whitespace, which break filenames/URLs).
import { createHash } from "node:crypto";
import type { TargetSystem } from "@sow/contracts";

const CANONICAL_KEY_VERSION = "sow.cok.v1";

/**
 * Normalize an identity map into a deterministic, order-independent list of
 * `[fieldName, value]` pairs. Field names are trimmed + lowercased; values are
 * trimmed (case preserved). Sorted by code-unit order on (name, value) so input
 * ordering can never change the result. Shared by both §8 key builders so the
 * canonicalObjectKey and idempotencyKey normalize identity identically.
 */
export function normalizeIdentity(identity: Record<string, string>): ReadonlyArray<readonly [string, string]> {
  return Object.entries(identity)
    .map(([k, v]): readonly [string, string] => [k.trim().toLowerCase(), v.trim()])
    .sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
    );
}

function sha256hex(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

/**
 * Build the deterministic, replay-stable canonicalObjectKey for a logical
 * external object on `targetSystem`, identified by `identity`. See module header
 * for the full normalization + safety contract.
 */
export function buildCanonicalObjectKey(input: {
  targetSystem: TargetSystem;
  identity: Record<string, string>;
}): string {
  const entries = normalizeIdentity(input.identity);
  const preimage = JSON.stringify([CANONICAL_KEY_VERSION, input.targetSystem, entries]);
  return `cok_${input.targetSystem}_${sha256hex(preimage)}`;
}
