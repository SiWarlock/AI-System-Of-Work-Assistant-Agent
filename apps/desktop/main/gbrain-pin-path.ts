// 11.3a — resolve the `config/gbrain.pin` path for the shipped app.
//
// Pure + electron-free so it compiles under tsconfig.node.json and no window/electron import reaches a
// test (apps/desktop LESSONS §3). The caller passes app.isPackaged / app.getAppPath() /
// process.resourcesPath in — this module makes no `electron` import.
import { join, resolve } from "node:path";

export interface ResolveGbrainPinPathArgs {
  /** `app.isPackaged` — true in a built/installed app, false in dev. */
  readonly packaged: boolean;
  /** `app.getAppPath()`. Packaged: `<Contents/Resources>/app`. Dev: `<repo>/apps/desktop`. */
  readonly appPath: string;
  /** `process.resourcesPath`. Only used on the packaged branch. */
  readonly resourcesPath: string;
}

/**
 * Packaged: `<resourcesPath>/config/gbrain.pin` — the pin is shipped alongside the app's other packaged
 * `config/` assets (mirrors where `providers.defaults.json`/`osb.pin` land).
 * Dev: `resolve(appPath, "..", "..", "config", "gbrain.pin")` — Electron's `getAppPath()` in dev is
 * `<repo>/apps/desktop`, and the pin lives at the repo root (`config/gbrain.pin`), two levels up.
 */
export function resolveGbrainPinPath({ packaged, appPath, resourcesPath }: ResolveGbrainPinPathArgs): string {
  return packaged ? join(resourcesPath, "config", "gbrain.pin") : resolve(appPath, "..", "..", "config", "gbrain.pin");
}
