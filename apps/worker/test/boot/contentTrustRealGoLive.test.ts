// Propose precondition (1), "content trust is REAL" — Linear slice 5b.1 (owner decision 2026-09-25: fix the check).
//
// ⛔ WHAT WAS WRONG: boot mapped (1) to `servingOracleFactory !== undefined`. `selectServingOracleFactory` returns the
// INTERIM always-degraded oracle whenever provenance stamping is on, go-live armed or not — so (1) read "real" with
// go-live OFF, although its name and boot's header said it needed the go-live selection. Other locks kept propose
// OFF, so it could not fail open today; but the gate's first check measured the wrong thing, and no test pinned it.
// (1) is now "the SELECTED factory IS the loader-backed one", which happens only when go-live is armed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectServingOracleFactory, isGoLiveOracleSelected } from "../../src/api/procedures/servingContextLoader";

const loaderBacked = (() => ({})) as unknown as Parameters<typeof selectServingOracleFactory>[0]["loaderBacked"] & (() => never);

describe("isGoLiveOracleSelected — propose precondition (1)", () => {
  it("⛔ stamping ON but go-live NOT armed selects the INTERIM oracle — that is NOT real content trust", () => {
    const selected = selectServingOracleFactory({ provenanceStampingEnabled: true, loaderBacked, goLiveArmed: false });
    expect(selected).toBeDefined(); // what the old check read as "real"
    expect(isGoLiveOracleSelected(selected, loaderBacked)).toBe(false);
  });

  it("go-live armed WITH a built loader-backed oracle is real", () => {
    const selected = selectServingOracleFactory({ provenanceStampingEnabled: true, loaderBacked, goLiveArmed: true });
    expect(isGoLiveOracleSelected(selected, loaderBacked)).toBe(true);
  });

  it("go-live armed but NO loader-backed oracle built ⇒ interim ⇒ not real; stamping off ⇒ nothing ⇒ not real", () => {
    const interim = selectServingOracleFactory({ provenanceStampingEnabled: true, loaderBacked: undefined, goLiveArmed: true });
    expect(isGoLiveOracleSelected(interim, undefined)).toBe(false);
    const none = selectServingOracleFactory({ provenanceStampingEnabled: false, loaderBacked, goLiveArmed: true });
    expect(none).toBeUndefined();
    expect(isGoLiveOracleSelected(none, loaderBacked)).toBe(false);
  });
});

describe("boot maps precondition (1) through isGoLiveOracleSelected — source pin", () => {
  const boot = readFileSync(join(__dirname, "..", "..", "src", "boot.ts"), "utf8");
  it("contentTrustReal is the go-live selection, not mere presence of a factory", () => {
    expect(boot).toMatch(/contentTrustReal:\s*isGoLiveOracleSelected\(servingOracleFactory,\s*loaderBackedServingOracle\)/);
    expect(boot).not.toMatch(/contentTrustReal:\s*servingOracleFactory\s*!==\s*undefined/);
  });
});
