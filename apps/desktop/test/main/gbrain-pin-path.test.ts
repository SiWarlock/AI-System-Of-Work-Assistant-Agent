import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { resolveGbrainPinPath } from "../../main/gbrain-pin-path";

// 11.3a — resolve the `config/gbrain.pin` path for the shipped app, packaged vs dev. Pure + electron-free
// (apps/desktop LESSONS §3): the caller passes app.isPackaged / app.getAppPath() / process.resourcesPath in,
// this module makes no `electron` import so it typechecks + tests under the DOM-less node tsconfig.
describe("resolveGbrainPinPath — packaged vs dev gbrain.pin location", () => {
  it("packaged: resourcesPath/config/gbrain.pin", () => {
    expect(
      resolveGbrainPinPath({ packaged: true, appPath: "/Applications/SoW.app/Contents/Resources/app", resourcesPath: "/Applications/SoW.app/Contents/Resources" }),
    ).toBe(join("/Applications/SoW.app/Contents/Resources", "config", "gbrain.pin"));
  });

  it("dev: resolve(appPath, '..', '..', 'config', 'gbrain.pin') — Electron dev getAppPath() is <repo>/apps/desktop, pin lives at the repo root", () => {
    const appPath = "/Users/dreddy/Documents/Dev/AI-tools/SoW/SoW-build/apps/desktop";
    expect(
      resolveGbrainPinPath({ packaged: false, appPath, resourcesPath: "/unused/in/dev" }),
    ).toBe(resolve(appPath, "..", "..", "config", "gbrain.pin"));
  });

  it("dev path resolves to the ACTUAL repo-root config/gbrain.pin (not just a string match)", () => {
    const appPath = join(process.cwd()); // vitest runs with cwd = apps/desktop
    const resolved = resolveGbrainPinPath({ packaged: false, appPath, resourcesPath: "/unused" });
    expect(resolved).toBe(resolve(process.cwd(), "..", "..", "config", "gbrain.pin"));
  });

  it("packaged and dev diverge — packaged never falls back to the appPath-relative form", () => {
    const shared = { appPath: "/some/app/path", resourcesPath: "/some/resources" };
    const packagedResult = resolveGbrainPinPath({ packaged: true, ...shared });
    const devResult = resolveGbrainPinPath({ packaged: false, ...shared });
    expect(packagedResult).not.toBe(devResult);
    expect(packagedResult).toBe(join("/some/resources", "config", "gbrain.pin"));
  });
});
