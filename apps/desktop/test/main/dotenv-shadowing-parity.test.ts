import { describe, it, expect } from "vitest";
import { SUBSCRIPTION_SHADOWING_ENV_KEYS } from "@sow/worker/composition/subscription-auth-guard";
import { DESKTOP_SUBSCRIPTION_SHADOWING_ENV_KEYS } from "../../main/dotenv-allowlist";

// R18-f — the desktop-inlined shadowing-set mirror-parity guard.
//
// `dotenv-allowlist.ts` cannot RUNTIME-import `@sow/worker` (a node-heavy worker edge would drag the
// `@sow/contracts` barrel's zod/ajv graph into the Electron main bundle — the 9.18 `test/bundle/
// main-bundle-resolution.test.ts` regression guard). So the desktop copy is a MIRROR, not an import, and
// drift is caught here instead: this TEST file (never bundled into main) imports the canonical worker
// export directly and asserts set-equality against the desktop mirror. A drift here means the ESCALATED
// "shadowing" warning silently degrades to "not_recognized" for the missing keys — the SOW_* allowlist gate
// itself is unaffected either way (apps/desktop LESSONS §15).
describe("DESKTOP_SUBSCRIPTION_SHADOWING_ENV_KEYS — mirror parity vs the canonical worker set", () => {
  it("is the exact same SET as the canonical @sow/worker SUBSCRIPTION_SHADOWING_ENV_KEYS (both directions)", () => {
    // Widened to Set<string> — the canonical worker export is `as const` (a literal-union tuple), but this
    // test compares plain string SETS, not literal types.
    const canonical = new Set<string>(SUBSCRIPTION_SHADOWING_ENV_KEYS);
    const desktop = new Set<string>(DESKTOP_SUBSCRIPTION_SHADOWING_ENV_KEYS);
    const missingFromDesktop = [...canonical].filter((k) => !desktop.has(k));
    const extraInDesktop = [...desktop].filter((k) => !canonical.has(k));
    expect(missingFromDesktop).toStrictEqual([]);
    expect(extraInDesktop).toStrictEqual([]);
  });

  it("has the same length as the canonical set (no accidental duplicate collapsing the count)", () => {
    expect(DESKTOP_SUBSCRIPTION_SHADOWING_ENV_KEYS.length).toBe(SUBSCRIPTION_SHADOWING_ENV_KEYS.length);
  });
});
