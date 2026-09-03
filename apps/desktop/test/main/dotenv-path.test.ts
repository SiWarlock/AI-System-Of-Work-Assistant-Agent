import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { resolveDotenvPath } from "../../main/dotenv-path";

// ⛔ THE DEFECT THIS PINS, MEASURED 2026-09-03 AND NOT IMAGINED. `hydrateAllowlistedDotenv` read
// `join(process.cwd(), ".env")` under a comment asserting cwd is "the repo root under `pnpm dev`".
// ⭐⭐ THAT COMMENT WAS FALSE, AND IT HAD BEEN FALSE SINCE THE BLANKET `source .env` WAS REMOVED:
//
//   pnpm --filter @sow/desktop exec pwd   ⇒  <repo>/apps/desktop      (measured, not assumed)
//   electron-vite spawns Electron as `spawn(electronPath, [entry], { stdio: 'inherit' })`
//                                         ⇒ NO cwd override ⇒ the child INHERITS <repo>/apps/desktop
//   ls apps/desktop/.env                  ⇒ ENOENT
//
// ⇒ the repo-root `.env` was NEVER OPENED on any launch path. Every allowlisted key in it —
// `SOW_MANAGE_TEMPORAL`, `SOW_VAULT_ROOT`, `SOW_INGEST_WATCH` — was silently inert.
//
// ⛔⛔ AND IT FAILED WITHOUT A SINGLE WARNING, which is what made it survive: the skipped-key warnings
// only print for keys the parser SAW. A file that is never opened yields an empty parse, so the owner
// got the exact same silent console as a correct load. **The failure mode was indistinguishable from
// success at the point of reading** — the shape this project keeps finding (`contracts L89`).
//
// ⭐ WHY THE EXISTING SUITES MISSED IT — the transferable part. `dotenv-allowlist.test.ts` and
// `dotenv-shadowing-parity.test.ts` both cover `loadAllowlistedDotenv`, the PURE PARSER, and both are
// green. The bug was never in the parser; it was in the ONE LINE that decides which file to hand it.
// **The tested half worked perfectly and the untested glue was wrong.**
describe("resolveDotenvPath — the repo-root .env, resolved from appPath NOT cwd", () => {
  it("dev: <repo>/.env, derived two levels up from Electron's dev getAppPath()", () => {
    // Electron's dev `getAppPath()` is `<repo>/apps/desktop` — the SAME anchor `resolveGbrainPinPath`
    // already uses for `config/gbrain.pin`. One anchor for every repo-root asset (`contracts L39`).
    const appPath = "/Users/dreddy/Documents/Dev/AI-tools/SoW/SoW-build/apps/desktop";
    expect(resolveDotenvPath({ packaged: false, appPath })).toBe(resolve(appPath, "..", "..", ".env"));
  });

  it("⛔ is INDEPENDENT of process.cwd() — the whole point of the fix", () => {
    // The regression guard proper. If a future edit reintroduces a cwd-relative read, this goes red
    // whatever directory the runner happens to sit in.
    const appPath = "/somewhere/else/entirely/apps/desktop";
    expect(resolveDotenvPath({ packaged: false, appPath })).toBe("/somewhere/else/entirely/.env");
    expect(resolveDotenvPath({ packaged: false, appPath })).not.toContain(process.cwd());
  });

  it("packaged: undefined — a shipped app has no repo .env, and must never read a stray cwd one", () => {
    // ⚠ NOT cosmetic. A packaged app's cwd is wherever the user launched it from (`/` from Finder, or
    // any directory from a terminal). A cwd-relative read there would hydrate a `.env` belonging to an
    // UNRELATED project. Returning `undefined` makes "no dotenv in prod" structural, not incidental.
    expect(resolveDotenvPath({ packaged: true, appPath: "/Applications/SoW.app/Contents/Resources/app" })).toBeUndefined();
  });
});
