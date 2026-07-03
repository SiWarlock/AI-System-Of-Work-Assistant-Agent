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
    const forbidden = /db|sql|drizzle|fs|file|secret|keychain|connector|token|exec|shell/i;
    // (session-token arrives in 9.2 via its own audited channel; until then the
    // surface must carry nothing matching a privileged-data pattern.)
    const offenders = inventory.channels.filter((c) => forbidden.test(c));
    expect(offenders).toEqual([]);
  });
});
