// TDD (red-first) for src/hash/payload-hash.ts — the canonical, key-order-
// independent payload digest that fills ExternalWriteEnvelope.payloadHash (§8).
import { describe, it, expect } from "vitest";
import { payloadHash } from "../src/hash/payload-hash";

describe("payloadHash", () => {
  it("returns a 'sha256:<hex>' shaped string", () => {
    const h = payloadHash({ a: 1 });
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic across repeated calls on the same payload", () => {
    const p = { title: "x", n: 42, nested: { z: true } };
    expect(payloadHash(p)).toBe(payloadHash(p));
  });

  it("is key-order-independent (top level)", () => {
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });

  it("is key-order-independent recursively (nested objects)", () => {
    const left = { outer: { a: 1, b: { c: 3, d: 4 } }, top: "t" };
    const right = { top: "t", outer: { b: { d: 4, c: 3 }, a: 1 } };
    expect(payloadHash(left)).toBe(payloadHash(right));
  });

  it("distinct payloads produce distinct hashes", () => {
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ b: 1 }));
  });

  it("does not collapse distinct nesting shapes ({ab:'c'} vs {a:'bc'})", () => {
    expect(payloadHash({ ab: "c" })).not.toBe(payloadHash({ a: "bc" }));
  });

  it("preserves array element ORDER (order is semantic for arrays)", () => {
    expect(payloadHash({ xs: [1, 2, 3] })).not.toBe(payloadHash({ xs: [3, 2, 1] }));
  });

  it("distinguishes null / absent / different primitive types", () => {
    expect(payloadHash({ a: null })).not.toBe(payloadHash({}));
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: "1" }));
    expect(payloadHash({ a: null })).not.toBe(payloadHash({ a: undefined }));
  });
});
