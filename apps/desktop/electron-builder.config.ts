// electron-builder config — UNSIGNED, LOCAL, `--dir` packaging only (task 11.6).
//
// This deliberately does NOT sign or notarize. Both require an Apple Developer
// certificate the project does not hold; provisioning one is a real external
// credential, not a build-tooling concern, and is out of scope here (see the
// dropped list in the task 11.6 brief). What this DOES cover — turning the
// electron-vite build output into a launchable `.app` on the local machine —
// crosses no hard line: nothing here talks to a signing service, notarization
// API, or publish target. `scripts/package-local.sh` invokes this with
// `--dir` only, never `--publish`.
//
// TYPING: electron-builder is intentionally NOT a devDependency of this
// package (this work package may not touch apps/desktop/package.json — that
// file belongs to another wave). `scripts/package-local.sh` runs the CLI via
// a pinned `pnpm dlx electron-builder@<version>` instead. So this file is
// typed against a small LOCAL interface covering only the fields it sets,
// never `import type { Configuration } from "electron-builder"` — importing
// that type would require the package to be resolvable, which would break
// `tsc --noEmit -p tsconfig.node.json` (this file is in that project's
// `include` transitively, via the test that imports it).
interface LocalElectronBuilderConfig {
  appId: string;
  productName: string;
  directories: {
    output: string;
    buildResources: string;
  };
  asar: boolean;
  npmRebuild: boolean;
  files: string[];
  extraResources: Array<{ from: string; to: string }>;
  mac: {
    target: Array<{ target: string; arch: string[] }>;
    category: string;
    identity: null;
    hardenedRuntime: boolean;
    entitlements: string;
    entitlementsInherit: string;
    // Deliberately never set by this config (see header comment) — declared
    // here only so the packaging-config test can assert their absence.
    afterSign?: undefined;
    notarize?: false | undefined;
  };
}

const config: LocalElectronBuilderConfig = {
  appId: "com.sow.desktop",
  productName: "System of Work",
  directories: {
    output: "release",
    buildResources: "build",
  },
  // NEVER asar: main forks the worker-host child under SYSTEM node
  // (main/index.ts nodeBin = process.env["SOW_WORKER_NODE"] ?? "node"), and
  // system node cannot read a path inside an asar archive.
  asar: false,
  // The packaged app still forks a system-node child, not an Electron-ABI
  // one (apps/desktop LESSONS.md #2) — native deps must keep the
  // system-node ABI they were installed with, so electron-builder must not
  // rebuild them against Electron's ABI.
  npmRebuild: false,
  files: [
    "out/main/**",
    "out/preload/**",
    "out/renderer/**",
    "out/worker/**",
    // Outside out/ entirely: main resolves these at runtime via
    // join(__dirname, "../../worker-host/register-loader.mjs")
    // (apps/desktop/main/index.ts). Omitting them ships a build that
    // cannot start its worker.
    "worker-host/*.mjs",
  ],
  // config/gbrain.pin (repo root) lands under process.resourcesPath/config
  // in the packaged app — the branch resolveGbrainPinPath targets.
  extraResources: [{ from: "../../config", to: "config" }],
  mac: {
    target: [{ target: "dir", arch: ["arm64"] }],
    category: "public.app-category.productivity",
    // Explicit unsigned: no afterSign hook, no notarize block. Right-click →
    // Open is required on first launch of the resulting .app.
    identity: null,
    hardenedRuntime: true,
    // Both entitlements files point at the same plist. Its
    // disable-library-validation entry is a no-op on this unsigned build
    // (the hardened runtime only activates under a real code signature) —
    // it is here so the eventual signed build needs no new file.
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
  },
};

export default config;
