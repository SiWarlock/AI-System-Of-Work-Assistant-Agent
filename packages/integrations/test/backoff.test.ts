// Slice 6.1 — pure bounded-exponential-backoff (RED first).
//
// nextDelayMs(attempt, cfg) → number | 'exhausted'. Deterministic (no jitter, OR
// an injected jitter fn). Capped attempt count + max delay. No Date.now/Math.random.
import { describe, it, expect } from "vitest";
import { nextDelayMs, type BackoffConfig } from "../src/connectors/backoff";

const CFG: BackoffConfig = { baseMs: 100, maxMs: 2_000, maxAttempts: 5 };

describe("nextDelayMs — bounded exponential backoff", () => {
  it("grows exponentially from base on the first attempts", () => {
    // attempt is 1-indexed: attempt 1 = base, then doubling.
    expect(nextDelayMs(1, CFG)).toBe(100);
    expect(nextDelayMs(2, CFG)).toBe(200);
    expect(nextDelayMs(3, CFG)).toBe(400);
    expect(nextDelayMs(4, CFG)).toBe(800);
  });

  it("is monotonically non-decreasing across attempts", () => {
    let prev = -1;
    for (let a = 1; a <= CFG.maxAttempts; a += 1) {
      const d = nextDelayMs(a, CFG);
      expect(d).not.toBe("exhausted");
      const n = d as number;
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it("caps the delay at maxMs (never exceeds the ceiling)", () => {
    // attempt 5 would be 1600 (<2000); a huge base must still clamp to maxMs.
    expect(nextDelayMs(5, CFG)).toBe(1_600);
    expect(nextDelayMs(5, { baseMs: 1_000, maxMs: 2_000, maxAttempts: 8 })).toBe(2_000);
    expect(nextDelayMs(3, { baseMs: 1_000, maxMs: 2_000, maxAttempts: 8 })).toBe(2_000);
  });

  it("returns 'exhausted' once attempt exceeds maxAttempts", () => {
    expect(nextDelayMs(5, CFG)).not.toBe("exhausted"); // last allowed attempt
    expect(nextDelayMs(6, CFG)).toBe("exhausted");
    expect(nextDelayMs(99, CFG)).toBe("exhausted");
  });

  it("treats a non-positive attempt as exhausted (fail-closed, no negative delay)", () => {
    expect(nextDelayMs(0, CFG)).toBe("exhausted");
    expect(nextDelayMs(-3, CFG)).toBe("exhausted");
  });

  it("applies an injected deterministic jitter fn without breaking the cap", () => {
    // jitter is injected (no Math.random in src). A jitter that adds a fixed
    // amount still clamps to maxMs.
    const jitter = (base: number): number => base + 50;
    expect(nextDelayMs(1, CFG, jitter)).toBe(150);
    // clamp: base 1000 * 2^(5-1) = 16000 → clamps to maxMs BEFORE jitter is not
    // exceeded — final result never above maxMs.
    const big: BackoffConfig = { baseMs: 1_000, maxMs: 2_000, maxAttempts: 8 };
    expect(nextDelayMs(5, big, jitter)).toBeLessThanOrEqual(big.maxMs);
  });
});
