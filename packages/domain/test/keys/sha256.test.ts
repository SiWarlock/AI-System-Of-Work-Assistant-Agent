// R7-c — the pure, dependency-free SHA-256 that backs `buildCanonicalObjectKey` /
// `buildIdempotencyKey` once they stop importing `node:crypto` (that import made
// the @sow/domain barrel unusable from a bundled/sandboxed context, e.g. a
// Temporal workflow bundle — see packages/domain/test/boundary/
// barrel-node-builtin-free.test.ts). `sha256Hex` lives in `../../src/keys/
// canonical-key.ts` (not a standalone `keys/sha256.ts`) so packages/domain/src
// gains NO new tracked file — a new source file would bump the git-file-count
// pinned by the off-limits packages/domain/test/boundary/pure-root.test.ts
// (EXPECTED_SRC_TS_FILE_COUNT), which this slice's territory excludes.
//
// Two independent checks:
//  1. A DIFFERENTIAL pin against node:crypto (imported HERE ONLY — never in
//     production code) over a corpus chosen to hit the exact places a hand-
//     rolled SHA-256 breaks: the 55/56/57/63/64/65-byte block/padding
//     boundaries, multi-byte UTF-8, and a >1KB input (multi-chunk).
//  2. The existing packages/domain/test/keys/keys.test.ts, run UNEDITED as a
//     regression net over the real callers (buildCanonicalObjectKey /
//     buildIdempotencyKey) once they are switched onto sha256Hex.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { sha256Hex } from "../../src/keys/canonical-key";

function nodeSha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

describe("sha256Hex — pure, dependency-free SHA-256 (R7-c)", () => {
  it("matches node:crypto byte-for-byte over the boundary + encoding corpus", () => {
    const corpus: string[] = [
      "", // empty string
      "a", // 1 byte
      "x".repeat(55), // 55 bytes — 55+1=56, exactly fills the single-block padding boundary
      "x".repeat(56), // 56 bytes — 56+1=57, spills into a second block
      "x".repeat(57), // 57 bytes
      "x".repeat(63), // 63 bytes — one below a full 64-byte block
      "x".repeat(64), // 64 bytes — exactly one full block
      "x".repeat(65), // 65 bytes — one over a full block
      "y".repeat(1337), // >1KB, forces multiple 64-byte chunks
      "héllo wörld — emoji: 🎉🔥🚀 — combining marks: é à", // multi-byte UTF-8 + combining marks
      "\uD800", // a lone (unpaired) high surrogate
    ];

    for (const input of corpus) {
      expect(sha256Hex(input)).toBe(nodeSha256Hex(input));
    }
  });

  it("produces lowercase hex", () => {
    expect(sha256Hex("sow")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic across repeated calls", () => {
    expect(sha256Hex("repeat-me")).toBe(sha256Hex("repeat-me"));
  });

  it("differs for a single-character change (avalanche sanity, not a crypto proof)", () => {
    expect(sha256Hex("input-a")).not.toBe(sha256Hex("input-b"));
  });
});
