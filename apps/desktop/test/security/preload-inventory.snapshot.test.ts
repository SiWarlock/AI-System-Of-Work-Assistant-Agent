import { describe, it, expect } from "vitest";
import { buildSowBridge, PRELOAD_CHANNELS, type InvokeFn } from "../../preload/bridge";
import inventory from "../../preload/inventory.json";

// Walk the real bridge with a recording `invoke` and collect every channel it
// actually calls — so this pins the LIVE surface, not just a hand-kept list.
function liveBridgeChannels(): string[] {
  const seen: string[] = [];
  const invoke: InvokeFn = (channel) => {
    seen.push(channel);
    return Promise.resolve(undefined);
  };
  const bridge = buildSowBridge(invoke) as unknown as Record<
    string,
    Record<string, (...args: unknown[]) => unknown>
  >;
  for (const namespace of Object.values(bridge)) {
    for (const fn of Object.values(namespace)) {
      if (typeof fn === "function") fn();
    }
  }
  return seen.sort();
}

describe("preload API inventory (§5/§11 — privileged-surface drift guard)", () => {
  it("the live bridge invokes EXACTLY the checked-in inventory channels", () => {
    expect(liveBridgeChannels()).toEqual([...inventory.channels].sort());
  });

  it("the channel source list matches the checked-in inventory", () => {
    expect([...PRELOAD_CHANNELS].sort()).toEqual([...inventory.channels].sort());
  });

  it("exposes no database / filesystem / secrets / connector channels", () => {
    const forbidden = /db|sql|drizzle|fs|file|secret|keychain|connector|exec|shell/i;
    const offenders = inventory.channels.filter((c) => forbidden.test(c));
    expect(offenders).toEqual([]);
  });

  it("the ONLY token-bearing channel is the audited per-launch session token", () => {
    const tokenChannels = inventory.channels.filter((c) => /token/i.test(c));
    expect(tokenChannels).toEqual(["session:getToken"]);
  });

  it("registers exactly the two 9.17 lifecycle first-run channels (regex/token covered by the all-channels guards above)", () => {
    // 9.17 — the durable first-run marker's read/write channels. Their forbidden-regex + no-token
    // guarantees are already enforced over ALL channels by the two `it`s above (a UX marker, not a
    // filesystem/token surface); this pins the exact lifecycle membership so a stray/renamed/removed
    // lifecycle channel is caught. (No duplicated regex literal — that could silently drift from line 35.)
    const lifecycle = inventory.channels.filter((c) => c.startsWith("lifecycle:")).sort();
    expect(lifecycle).toEqual(["lifecycle:firstRunStatus", "lifecycle:markOnboarded"]);
  });
});
