// 18.34 (corrected 2026-09-03) — resolve the repo-root `.env` for the DEV launch path.
//
// Pure + electron-free so it compiles under tsconfig.node.json and no `electron` import reaches a test
// (apps/desktop LESSONS §3). The caller passes `app.isPackaged` / `app.getAppPath()` in — exactly the
// contract `resolveGbrainPinPath` already established for `config/gbrain.pin`.
//
// ⛔ WHY THIS MODULE EXISTS AT ALL — it replaces `join(process.cwd(), ".env")`, which NEVER RESOLVED.
// Measured, not reasoned: `pnpm --filter @sow/desktop exec pwd` is `<repo>/apps/desktop`, and
// electron-vite spawns Electron with `{ stdio: 'inherit' }` and NO cwd override, so the Electron
// process inherits `<repo>/apps/desktop` — where no `.env` exists. The repo-root `.env` was never
// opened on any launch path, and every allowlisted key in it was silently inert.
//
// ⭐ AND THE SILENCE IS THE LESSON: the skipped-key warnings only fire for keys the parser SAW, so a
// file that is never opened produces the identical empty console to a clean load. Anchoring on
// `appPath` removes the failure mode rather than warning about it.
import { resolve } from "node:path";

export interface ResolveDotenvPathArgs {
  /** `app.isPackaged` — true in a built/installed app, false in dev. */
  readonly packaged: boolean;
  /** `app.getAppPath()`. Dev: `<repo>/apps/desktop`. Packaged: `<Contents/Resources>/app`. */
  readonly appPath: string;
}

/**
 * Dev: `<repo>/.env`, two levels up from `appPath` — the same anchor as `resolveGbrainPinPath`.
 * Packaged: `undefined`. ⛔ A shipped app must NEVER read a cwd-relative `.env`: its cwd is wherever
 * the user launched it from, so that would hydrate an UNRELATED project's file. `undefined` makes
 * "no dotenv in prod" structural rather than incidental.
 */
export function resolveDotenvPath({ packaged, appPath }: ResolveDotenvPathArgs): string | undefined {
  return packaged ? undefined : resolve(appPath, "..", "..", ".env");
}
