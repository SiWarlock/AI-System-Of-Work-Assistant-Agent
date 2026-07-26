// spec(§6 KN-10 / §19.5 arming) — 13.8d: the living-vault rewrite ships DORMANT.
//
// The arming decision lives at the composition root, behind a pure gate helper (the shape established by
// `gateCopilotVaultReadDeps` / `gateAutoIngest`): the worker's own dormancy discipline is that a built-but-
// unarmed capability must construct NOTHING at boot, so the OFF path is byte-equivalent to a build where
// the capability does not exist. The `build` thunk is therefore invoked ONLY on the armed path.
//
// STRICT `=== true` (worker L28 / knowledge L2): the flag arrives from config that is ultimately
// env/IPC-derived, where `"true"` (string), `1`, and `"false"` are all TRUTHY. A truthy-non-`true` value
// arming a capability that mutates the vault is precisely the false-green vector those lessons exist to
// close, so anything that is not the boolean `true` leaves the capability inert.
import { describe, it, expect } from "vitest";
import { gateLivingVaultRewrite } from "../src/boot";

const VAULT = "/tmp/sow-test-vault";

describe("gateLivingVaultRewrite — dormant by default (13.8d)", () => {
  it("boot_default_leaves_flag_off — flag ABSENT ⇒ undefined, and the thunk is never invoked", () => {
    let built = 0;
    const wiring = gateLivingVaultRewrite({ vaultRoot: VAULT }, () => {
      built += 1;
      return { bound: true };
    });
    expect(wiring).toBeUndefined();
    // Not merely "returns undefined" — the capability's deps are never CONSTRUCTED on the shipped path.
    expect(built).toBe(0);
  });

  it("strict_true_only — every truthy-non-true value leaves it inert", () => {
    const truthyImposters: unknown[] = [false, "true", "false", 1, 0, "", null, undefined, {}];
    for (const value of truthyImposters) {
      let built = 0;
      const wiring = gateLivingVaultRewrite(
        { livingVaultRewrite: value as boolean | undefined, vaultRoot: VAULT },
        () => {
          built += 1;
          return { bound: true };
        },
      );
      expect(wiring, `value ${JSON.stringify(value)} must not arm`).toBeUndefined();
      expect(built).toBe(0);
    }
  });

  it("armed_requires_a_vault_root — flag true but no vaultRoot ⇒ inert (fail-safe)", () => {
    let built = 0;
    const wiring = gateLivingVaultRewrite({ livingVaultRewrite: true }, () => {
      built += 1;
      return { bound: true };
    });
    expect(wiring).toBeUndefined();
    expect(built).toBe(0);
  });

  it("armed_builds_once — flag strictly true + a vaultRoot ⇒ the thunk runs with the narrowed root", () => {
    const roots: string[] = [];
    const wiring = gateLivingVaultRewrite(
      { livingVaultRewrite: true, vaultRoot: VAULT },
      (vaultRoot) => {
        roots.push(vaultRoot);
        return { bound: true };
      },
    );
    expect(wiring).toEqual({ bound: true });
    expect(roots).toEqual([VAULT]);
  });
});
