import { describe, it, expect } from "vitest";
import { makeSessionTokenHolder } from "../../main/session-token";

describe("session token (§5 / 9.2 — per-launch, memory-only)", () => {
  it("mints a high-entropy base64url token", () => {
    const t = makeSessionTokenHolder().mint();
    // 32 random bytes → 43 base64url chars, URL-safe alphabet, no padding.
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("mints a distinct token per launch (fresh each mint)", () => {
    const a = makeSessionTokenHolder().mint();
    const b = makeSessionTokenHolder().mint();
    expect(a).not.toEqual(b);
  });

  it("re-minting on the same holder replaces the prior token", () => {
    const h = makeSessionTokenHolder();
    const first = h.mint();
    const second = h.mint();
    expect(second).not.toEqual(first);
    expect(h.get()).toEqual(second);
  });

  it("throws if the token is requested before the launch mint (fail-closed)", () => {
    expect(() => makeSessionTokenHolder().get()).toThrow(/before mint/);
  });

  it("returns the minted token after mint", () => {
    const h = makeSessionTokenHolder();
    const t = h.mint();
    expect(h.get()).toEqual(t);
  });
});
