import { describe, it, expect, beforeAll } from "vitest";
import { statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import config from "../../electron-builder.config";

// 11.6 — unsigned, local, build-from-source `--dir` packaging. This pins the config that is
// deliberately ABSENT signing/notarization/publish machinery, and the script that drives it.
// The project holds no Apple Developer certificate; that is a hard line this package does not
// cross. See apps/desktop/electron-builder.config.ts's header comment for the full rationale.

const DESKTOP_ROOT = process.cwd(); // vitest runs with cwd = apps/desktop (the package root)
const ENTITLEMENTS_PATH = join(DESKTOP_ROOT, "build", "entitlements.mac.plist");
const PACKAGE_SCRIPT_PATH = join(DESKTOP_ROOT, "..", "..", "scripts", "package-local.sh");

describe("electron-builder.config — unsigned local --dir packaging pin (11.6)", () => {
  it("never asars the app — main forks a worker-host child under SYSTEM node, which cannot read inside an asar archive", () => {
    expect(config.asar).toBe(false);
  });

  it("is explicitly unsigned — mac.identity is null, no afterSign hook, no truthy mac.notarize", () => {
    expect(config.mac.identity).toBeNull();
    expect(config.mac.afterSign).toBeUndefined();
    expect(config.mac.notarize).toBeFalsy();
  });

  it("ships every runtime dir main resolves at launch: the four out/ subtrees AND the worker-host loaders that live OUTSIDE out/", () => {
    // main/index.ts resolves worker-host/register-loader.mjs via join(__dirname, "../../worker-host/...") —
    // outside out/ entirely. Omitting it ships a build that cannot start its worker child.
    expect(config.files).toEqual(
      expect.arrayContaining([
        "out/main/**",
        "out/preload/**",
        "out/renderer/**",
        "out/worker/**",
        "worker-host/*.mjs",
      ]),
    );
  });

  it("maps the repo-root config/ dir to process.resourcesPath/config — the branch resolveGbrainPinPath targets in a packaged app", () => {
    expect(config.extraResources).toEqual(
      expect.arrayContaining([{ from: "../../config", to: "config" }]),
    );
  });

  it("points buildResources at build/, and both entitlements fields at the same real plist granting library-validation escape", () => {
    expect(config.directories.buildResources).toBe("build");
    expect(config.mac.entitlements).toBe("build/entitlements.mac.plist");
    expect(config.mac.entitlementsInherit).toBe("build/entitlements.mac.plist");

    expect(existsSync(ENTITLEMENTS_PATH)).toBe(true);
    const plist = readFileSync(ENTITLEMENTS_PATH, "utf8");
    // Required because main forks a SYSTEM node binary (not an embedded/signed one) as the
    // worker-host child — the hardened runtime would otherwise refuse to load its native deps.
    expect(plist).toContain("com.apple.security.cs.disable-library-validation");
  });

  it("never runs npm rebuild — the packaged app still forks a system-node child (L2), so native deps must keep the system-node ABI, not Electron's", () => {
    expect(config.npmRebuild).toBe(false);
  });
});

describe("scripts/package-local.sh — the executable pin on 'this crosses no hard line'", () => {
  let script: string;

  beforeAll(() => {
    expect(existsSync(PACKAGE_SCRIPT_PATH)).toBe(true);
    script = readFileSync(PACKAGE_SCRIPT_PATH, "utf8");
  });

  it("exists and is executable", () => {
    const mode = statSync(PACKAGE_SCRIPT_PATH).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it("invokes electron-builder with --dir", () => {
    expect(script).toContain("--dir");
  });

  it("contains NONE of the signing/notarization/publish credential or flag tokens", () => {
    for (const forbidden of [
      "CSC_LINK",
      "CSC_NAME",
      "APPLE_ID",
      "APPLE_APP_SPECIFIC_PASSWORD",
      "--publish",
      "notarize",
    ]) {
      expect(script).not.toContain(forbidden);
    }
  });
});
