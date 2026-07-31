// spec(§6 KN-10 / §19.5 arming) — 13.8f-B: the meeting-path living-vault rewrite ships DORMANT, mirroring
// 13.8d's `gateLivingVaultRewrite` shape exactly. The arming decision lives at the composition root,
// behind a pure gate helper: the worker's own dormancy discipline is that a built-but-unarmed capability
// must construct NOTHING at boot, so the OFF path is byte-equivalent to a build where the capability does
// not exist. The `build` thunk is therefore invoked ONLY on the armed path.
//
// STRICT `=== true` (worker L28 / knowledge L2): the flag arrives from config that is ultimately
// env/IPC-derived, where `"true"` (string), `1`, and `"false"` are all TRUTHY. A truthy-non-`true` value
// arming a capability that mutates the vault is precisely the false-green vector those lessons exist to
// close, so anything that is not the boolean `true` leaves the capability inert.
//
// No second precondition (unlike `gateLivingVaultRewrite`'s `vaultRoot`): the meeting adapter performs
// no realpath containment (see apps/worker/src/composition/meeting-vault.ts's own header for why that
// is not a gap this slice opens), so the flag alone governs arming.
import { describe, it, expect } from "vitest";
import { gateMeetingVaultRewrite } from "../src/boot";

describe("gateMeetingVaultRewrite — dormant by default (13.8f-B)", () => {
  it("boot_default_leaves_flag_off — flag ABSENT ⇒ undefined, and the thunk is never invoked", () => {
    let built = 0;
    const wiring = gateMeetingVaultRewrite({}, () => {
      built += 1;
      return { bound: true };
    });
    expect(wiring).toBeUndefined();
    expect(built).toBe(0);
  });

  it("strict_true_only — every truthy-non-true value leaves it inert", () => {
    const truthyImposters: unknown[] = [false, "true", "false", 1, 0, "", null, undefined, {}];
    for (const value of truthyImposters) {
      let built = 0;
      const wiring = gateMeetingVaultRewrite({ meetingVaultRewrite: value as boolean | undefined }, () => {
        built += 1;
        return { bound: true };
      });
      expect(wiring, `value ${JSON.stringify(value)} must not arm`).toBeUndefined();
      expect(built).toBe(0);
    }
  });

  it("armed_builds_once — flag strictly true ⇒ the thunk runs exactly once", () => {
    let built = 0;
    const wiring = gateMeetingVaultRewrite({ meetingVaultRewrite: true }, () => {
      built += 1;
      return { bound: true };
    });
    expect(wiring).toEqual({ bound: true });
    expect(built).toBe(1);
  });
});
