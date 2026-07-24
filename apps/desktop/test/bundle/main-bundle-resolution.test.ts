import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 9.18 REGRESSION GUARD — Electron MAIN must BUNDLE the pure `@sow/*` packages it imports at runtime
// (today `@sow/contracts`, via main/open-in-vault.ts), NEVER externalize them. Main's Node runtime does
// NOT activate the `sow-built` export condition (only the worker-host child sets `--conditions=sow-built`),
// so an externalized `@sow/contracts` resolves via `default` → raw `src/index.ts` → `require()` of TS →
// `SyntaxError: Unexpected token 'export'` at load. That was the 9.18 crash (9.12 added the first runtime
// `@sow/*` import into main; the externalization config never bundled it — fixed in electron.vite.config.ts).
//
// This runs the REAL `electron-vite build` (the exact production build — deterministic, no Electron runtime
// needed, ~1-2s) and asserts the emitted main bundle carries no runtime `@sow/*` / raw-`.ts` require, and
// that the `@sow/contracts` barrel's heavy zod/ajv graph is NOT dragged in (the deep-import leanness leg).
// A full Electron GUI launch is not CI-feasible; this build-artifact assertion is the deterministic pin.

const DESKTOP_ROOT = process.cwd(); // vitest runs with cwd = apps/desktop (the package root)
const MAIN_ARTIFACT = join(DESKTOP_ROOT, "out", "main", "index.js");

let mainBundle: string;

beforeAll(() => {
  // Build the true production bundle. The main target now bundles `@sow/contracts` from source (the config
  // `exclude`), so this is self-contained — no `build:sow` (dist) prerequisite.
  execFileSync("npx", ["electron-vite", "build"], { cwd: DESKTOP_ROOT, stdio: "ignore" });
  mainBundle = readFileSync(MAIN_ARTIFACT, "utf8");
}, 120_000);

describe("electron main bundle — @sow/* resolution regression guard (9.18)", () => {
  it("bundles @sow/* — no runtime require/import of an externalized @sow package (would resolve to src .ts)", () => {
    expect(mainBundle).not.toMatch(/require\(\s*["'`]@sow\//);
    expect(mainBundle).not.toMatch(/\bfrom\s*["'`]@sow\//);
  });

  it("never leaves a runtime require of a raw .ts source", () => {
    expect(mainBundle).not.toMatch(/require\(\s*["'`][^"'`]*\.ts["'`]\s*\)/);
    expect(mainBundle).not.toMatch(/\/src\/[^"'`]*\.ts/);
  });

  it("inlines the pure Result helpers open-in-vault uses (positive anchor — actually bundled, not stubbed)", () => {
    // `ok`/`err` construct `{ ok: true/false, ... }`; their presence proves the contracts source is inlined.
    // Tolerate a future minified build (`true`/`false` → `!0`/`!1`; the `ok` property key survives). The
    // property key is what proves inlining — negative legs (string-literal requires) are minify-immune.
    expect(mainBundle).toMatch(/ok\s*:\s*(!0|true)/);
    expect(mainBundle).toMatch(/ok\s*:\s*(!1|false)/);
  });

  it("stays lean — the @sow/contracts barrel's zod/ajv graph is NOT dragged into main (deep-import invariant)", () => {
    expect(mainBundle).not.toMatch(/require\(\s*["'`]ajv/);
    expect(mainBundle).not.toMatch(/require\(\s*["'`]zod/);
  });
});
