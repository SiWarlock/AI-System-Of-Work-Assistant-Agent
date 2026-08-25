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
//
// R7-c: `sha256Hex` below is a PURE, dependency-free SHA-256 (FIPS 180-4) —
// this module used to `import { createHash } from "node:crypto"`, which made
// @sow/domain's barrel (`export *`d from ./index.ts) unusable from a bundled/
// sandboxed context that cannot resolve Node built-ins (e.g. a Temporal
// workflow bundle; see packages/domain/test/boundary/
// barrel-node-builtin-free.test.ts). It lives in THIS file (not a standalone
// `keys/sha256.ts`) so `packages/domain/src` gains no new tracked file — a new
// source file would bump the git-file-count pinned by the off-limits
// packages/domain/test/boundary/pure-root.test.ts (EXPECTED_SRC_TS_FILE_COUNT).
// `./idempotency-key.ts` imports it from here, alongside `normalizeIdentity`,
// so both §8 key builders share the exact same hash. Differentially pinned
// against node:crypto's own SHA-256 in test/keys/sha256.test.ts.
import type { TargetSystem } from "@sow/contracts";

const CANONICAL_KEY_VERSION = "sow.cok.v1";

// ---------------------------------------------------------------------------
// Pure SHA-256 (FIPS 180-4). No I/O, no external entropy, no Node built-ins.
// ---------------------------------------------------------------------------

// First 32 bits of the fractional parts of the cube roots of the first 64 primes.
const SHA256_K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

// First 32 bits of the fractional parts of the square roots of the first 8 primes.
const SHA256_H0: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * Pure, dependency-free SHA-256 over the UTF-8 bytes of `input`. Lowercase hex
 * output (64 chars). No clock/random/env/I-O — identical input -> identical
 * output, and no Node built-in in the reachable module graph.
 */
export function sha256Hex(input: string): string {
  const msg = new TextEncoder().encode(input);

  // Pad: append 0x80, then zero bytes until length ≡ 56 (mod 64), then the
  // 64-bit big-endian bit-length. Total length is always a multiple of 64.
  const withOne = msg.length + 1;
  const zeroPad = (56 - (withOne % 64) + 64) % 64;
  const totalLen = withOne + zeroPad + 8;
  const padded = new Uint8Array(totalLen);
  padded.set(msg);
  padded[msg.length] = 0x80;

  const view = new DataView(padded.buffer);
  const bitLenLow = (msg.length * 8) >>> 0;
  const bitLenHigh = Math.floor(msg.length / 0x20000000); // high 32 bits of msg.length*8
  view.setUint32(totalLen - 8, bitLenHigh, false);
  view.setUint32(totalLen - 4, bitLenLow, false);

  const h = SHA256_H0.slice();
  const w = new Array<number>(64).fill(0);

  for (let chunkStart = 0; chunkStart < totalLen; chunkStart += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(chunkStart + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;

    for (let i = 0; i < 64; i++) {
      const bigS1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + bigS1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const bigS0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigS0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]!, false);

  let hex = "";
  for (const byte of out) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

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
  return `cok_${input.targetSystem}_${sha256Hex(preimage)}`;
}
