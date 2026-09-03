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

  // ⛔⛔ ONE NAMED EXCEPTION, ADDED 2026-09-03 BY EXPLICIT OWNER DECISION, WITH THE COST STATED
  // BEFORE THE DECISION WAS TAKEN. Recorded here in full because a bare allowlist entry would read
  // like an oversight to the next person, and this is the opposite of an oversight.
  //
  // `secret:provision` stores a VENDOR write-credential in the Keychain from the Connectors surface.
  // It is deliberately named to TRIP the regex below rather than dodge it: a name like
  // `credential:store` would slip the pattern untouched, and evading a security guard by wordplay is
  // strictly worse than amending it in the open, where it is reviewable.
  //
  // WHAT THE OWNER ACCEPTED: a vendor credential now transits the RENDERER process. This app renders
  // imported/untrusted content (the reason ING-7 exists), so a renderer compromise that previously
  // could not yield a vendor credential now can.
  // ⭐ WHAT MAKES IT SURVIVABLE, and the ONLY reason this exception is narrow enough to grant:
  // ***THE CHANNEL IS WRITE-ONLY.*** There is no read counterpart and none may be added. A
  // compromised renderer can OVERWRITE a credential; it cannot EXFILTRATE one. That asymmetry is the
  // whole mitigation — the moment a `secret:read`/`secret:list` channel appears, the residual the
  // owner accepted is no longer the residual that exists, and this exception must be revisited.
  const ALLOWED_SECRET_CHANNELS = ["secret:provision"] as const;

  it("exposes no database / filesystem / secrets / connector channels, except the one named write-only exception", () => {
    const forbidden = /db|sql|drizzle|fs|file|secret|keychain|connector|exec|shell/i;
    const offenders = inventory.channels
      .filter((c) => forbidden.test(c))
      .filter((c) => !(ALLOWED_SECRET_CHANNELS as readonly string[]).includes(c));
    expect(offenders).toEqual([]);
  });

  it("⛔ the secrets exception is EXACTLY the write-only provisioning channel — no read counterpart", () => {
    // The guard on the exception itself. `secret:provision` is tolerable ONLY because nothing can
    // read a credential back; this fails the moment a second secrets channel appears, whatever it is
    // called, so the exception cannot quietly widen from one write into a read surface.
    const forbidden = /secret|keychain|credential/i;
    expect(inventory.channels.filter((c) => forbidden.test(c))).toEqual(["secret:provision"]);
  });

  it("the only token-bearing channel NAMED as such is the audited per-launch session token", () => {
    // ⚠ AMENDED 2026-09-03 — the old title claimed this was "the ONLY token-bearing channel", and
    // that became FALSE when `secret:provision` started carrying a vendor API key. The regex does not
    // match it, so this assertion stayed green while its own sentence stopped being true.
    // ⭐ That is precisely the defect class this project keeps finding: a guard whose CLAIM rots while
    // its CHECK still passes. The check below is still worth keeping — it pins that no NEW
    // token-NAMED channel appears — but it no longer proves what its old title asserted, and the
    // title now says only what it actually measures. Direction of travel matters: a guard that
    // overstates its coverage is worse than one with a known, stated gap (`contracts L89`).
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
