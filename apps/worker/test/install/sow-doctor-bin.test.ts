// @sow/worker — the `sow-doctor` BIN can actually START (task 24.143).
//
// ⛔ THE DEFECT THIS PINS. `package.json`'s `bin` pointed straight at
// `./dist/install/bin/doctor.js`. That emitted entry carries EXTENSIONLESS relative specifiers
// (`from "../probe-adapters"`) in a `"type": "module"` package, so Node's ESM resolver rejected
// it and the shipped binary died at MODULE LOAD:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/dist/install/probe-adapters'   exit 1
//
// Fixing that exposed a second: without `--conditions=sow-built`, `@sow/*` resolve through the
// `default` export condition to `src/*.ts` ⇒ `ERR_UNKNOWN_FILE_EXTENSION: ".ts"`.
// ⇒ ***`sow-doctor` had NEVER been runnable.*** The forked worker child gets BOTH pieces
// (`worker-supervisor.ts`: `execArgv: ["--conditions=sow-built", "--import", loaderPath]`); the
// bin got neither, and nothing ran it.
//
// ⭐⭐ AND THAT IS WHY `### 24.139` WENT UNNOTICED — a false `single_owner_lock` finding that
// also exited 1. Two independent defects on one entry point, BOTH exit 1, each hiding the other:
// the binary you would run to notice one could not start, and the failures looked identical from
// outside.
//
// ⚠ WHY THIS IS A STATIC TEST AND NOT A LIVE SPAWN. Running the real bin takes tens of seconds —
// it probes Temporal, gbrain, FileVault, the Keychain and binds loopback ports — which does not
// belong in the default suite. What actually regressed is CONFIGURATION: the two pieces the bin
// must carry. Those are checkable without spawning, and this asserts exactly them. The live
// end-to-end run is recorded in `### 24.143` (six `[ok]`, three real findings, and
// `[degraded] single_owner_lock_not_observable`).
import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const PKG_DIR = resolve(__dirname, "..", "..");
const pkg = JSON.parse(readFileSync(resolve(PKG_DIR, "package.json"), "utf8")) as {
  readonly bin?: Record<string, string>;
  readonly type?: string;
};

describe("sow-doctor bin — the two pieces without which it cannot start (24.143)", () => {
  it("the package is ESM, which is WHY both pieces are required", () => {
    // Non-vacuity for everything below: if this package ever stopped being `"type": "module"`,
    // extensionless specifiers would resolve on their own and these assertions would be pinning
    // a requirement that no longer exists.
    expect(pkg.type).toBe("module");
  });

  it("`bin` points at the SHIM, never straight at the emitted dist entry", () => {
    const target = pkg.bin?.["sow-doctor"];
    expect(target).toBeDefined();
    // ⛔ THE REGRESSION THIS CATCHES, stated as the thing it forbids: repointing `bin` back at
    // `dist/install/bin/doctor.js` reinstates ERR_MODULE_NOT_FOUND on the shipped binary.
    expect(target).not.toMatch(/dist\/.*doctor\.js$/);
    expect(target).toBe("./bin/sow-doctor.mjs");
    expect(statSync(resolve(PKG_DIR, target!)).isFile()).toBe(true);
  });

  it("the shim carries `--conditions=sow-built` in its SHEBANG — a runtime call cannot set it", () => {
    const shim = readFileSync(resolve(PKG_DIR, "bin/sow-doctor.mjs"), "utf8");
    const shebang = shim.split("\n")[0] ?? "";
    expect(shebang.startsWith("#!")).toBe(true);
    // `--conditions` is a PROCESS flag. Without it `@sow/*` resolve to `src/*.ts` and Node dies
    // with ERR_UNKNOWN_FILE_EXTENSION — the SECOND failure, reached only after the first is fixed.
    expect(shebang).toContain("--conditions=sow-built");
    // `env -S` is what allows a flag through a shebang at all (BSD env / GNU coreutils ≥ 8.30).
    expect(shebang).toContain("env -S");
  });

  it("the shim registers the extensionless-ESM resolve hook BEFORE importing the entry", () => {
    const shim = readFileSync(resolve(PKG_DIR, "bin/sow-doctor.mjs"), "utf8");
    const registerAt = shim.indexOf("register(");
    const importAt = shim.indexOf('import("../dist/');
    expect(registerAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(-1);
    // ORDER IS LOAD-BEARING: the hook must be installed before the graph is pulled in, or the
    // first extensionless specifier throws exactly as before.
    expect(registerAt).toBeLessThan(importAt);
  });

  it("the resolve hook appends `.js` / `/index.js` and leaves BARE specifiers alone", () => {
    // Pins the hook's actual shape, so a "simplification" that drops the `/index.js` fallback or
    // starts rewriting bare specifiers (node builtins, `@sow/*` package roots) is caught here.
    const loader = readFileSync(resolve(PKG_DIR, "bin/resolve-loader.mjs"), "utf8");
    expect(loader).toContain('specifier.startsWith("./")');
    expect(loader).toContain('specifier.startsWith("../")');
    expect(loader).toContain('".js"');
    expect(loader).toContain('"/index.js"');
  });

  it("DRIFT: the bin's resolve hook stays behaviourally identical to the worker-host's (24.144)", () => {
    // ⚠ Two byte-identical copies exist, deliberately (a cross-package RUNTIME import is the
    // fragility the hook exists to work around). `contracts L39` says a rule gets ONE definition,
    // so until `### 24.144` single-sources them this is the drift guard that makes the duplicate
    // honest — a deliberate duplicate WITH a guard is fine; without one it is the same defect as
    // an accidental one.
    const mine = readFileSync(resolve(PKG_DIR, "bin/resolve-loader.mjs"), "utf8");
    const theirs = readFileSync(
      resolve(PKG_DIR, "..", "desktop", "worker-host", "resolve-loader.mjs"),
      "utf8",
    );
    // Compare CODE, not prose: the two headers legitimately differ (each explains its own
    // caller). Strip comments and blank lines, then require the bodies to match exactly.
    const code = (s: string): string =>
      s
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && l.trim().length > 0)
        .join("\n");
    expect(code(mine)).toBe(code(theirs));
  });
});
