// spec(§12 · §13 clean-install/doctor · REQ-NF-005) — task 11.7's fixture leg.
//
// `createIsolatedInstallRoot` is the harness's ISOLATION primitive: a fresh temp-dir tree the
// clean-install acceptance legs point real machinery at, so a run proves the documented install
// path without touching this developer's real `~/.sow`, vault, or `config/gbrain.pin`. Pinned
// here, deterministically, with no env gating (pure fs — no shell-out, no socket):
//   - each call mints a DISTINCT root (no collision across concurrent runs)
//   - the isolated `config/gbrain.pin` is a byte-identical COPY of the repo's real file (the
//     boot-to-serving leg reads THIS copy, never the real one)
//   - `cleanup()` removes the whole tree and is idempotent (safe to call twice)
//   - nothing under the isolated root exists before the call (no accidental reuse of stale state)
import { describe, it, expect } from "vitest";
import { readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createIsolatedInstallRoot,
  REPO_GBRAIN_PIN_PATH,
} from "../../src/install/fixtures/isolated-root";

describe("§13 clean-install fixture — createIsolatedInstallRoot", () => {
  it("mints a fresh root with all expected subpaths present and empty vault/data dirs", async () => {
    const iso = await createIsolatedInstallRoot();
    try {
      const rootStat = await stat(iso.root);
      expect(rootStat.isDirectory()).toBe(true);

      const vaultStat = await stat(iso.vaultDir);
      expect(vaultStat.isDirectory()).toBe(true);
      expect(await readdir(iso.vaultDir)).toEqual([]); // a genuinely empty, never-before-used vault

      const dataStat = await stat(iso.dataDir);
      expect(dataStat.isDirectory()).toBe(true);

      // The sqlite file itself does not exist YET — bootWorker's genesis migration creates it.
      // A pre-existing file here would mean this "clean install" was not actually clean.
      await expect(stat(iso.dbPath)).rejects.toThrow();
    } finally {
      await iso.cleanup();
    }
  });

  it("copies config/gbrain.pin byte-identically into the isolated root — never the real file", async () => {
    const iso = await createIsolatedInstallRoot();
    try {
      const real = await readFile(REPO_GBRAIN_PIN_PATH, "utf8");
      const copy = await readFile(iso.pinPath, "utf8");
      expect(copy).toBe(real);
      expect(iso.pinPath).not.toBe(REPO_GBRAIN_PIN_PATH); // distinct file, not a reference to the real one
      expect(iso.pinPath.startsWith(iso.root)).toBe(true); // lives inside the isolated tree only
    } finally {
      await iso.cleanup();
    }
  });

  it("two calls mint two DISTINCT roots (no collision)", async () => {
    const a = await createIsolatedInstallRoot();
    const b = await createIsolatedInstallRoot();
    try {
      expect(a.root).not.toBe(b.root);
      expect(a.vaultDir).not.toBe(b.vaultDir);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it("cleanup removes the whole tree, and is idempotent (a second call is a safe no-op)", async () => {
    const iso = await createIsolatedInstallRoot();
    await iso.cleanup();
    await expect(stat(iso.root)).rejects.toThrow();
    await expect(iso.cleanup()).resolves.toBeUndefined(); // second call — must not throw
  });

  it("the lock path resolves inside the root but does not pre-exist (a fresh install has no lock held)", async () => {
    const iso = await createIsolatedInstallRoot();
    try {
      expect(iso.lockPath.startsWith(iso.root)).toBe(true);
      await expect(stat(iso.lockPath)).rejects.toThrow();
    } finally {
      await iso.cleanup();
    }
  });

  it("the sqlite path sits under the created data dir (its parent directory pre-exists)", async () => {
    const iso = await createIsolatedInstallRoot();
    try {
      expect(iso.dbPath.startsWith(iso.dataDir + "/")).toBe(true);
      expect(iso.dbPath).toBe(join(iso.dataDir, "operational.sqlite"));
    } finally {
      await iso.cleanup();
    }
  });
});
