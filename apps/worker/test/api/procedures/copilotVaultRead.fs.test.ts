// Vault-B fs seams — the REAL `fs` reader + realpath, exercised against a tmpdir (self-contained, deterministic).
// Covers what the unit tests mock: the size cap enforced BEFORE buffering, non-regular-file denial, the
// redaction-safe fault mapping, and — load-bearing for the [critical] symlink fix — that `createFsRealpath`
// actually resolves a symlink to its target (so the handler's re-attribution sees the REAL location).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { isOk } from "@sow/contracts";
import { createFsVaultReadFileExec, createFsRealpath } from "../../../src/api/procedures/copilotVaultRead";

let dir: string;
beforeAll(async () => {
  // Canonicalize the tmpdir (macOS `/var` → `/private/var` is itself a symlink) so realpath output matches join().
  dir = await realpath(await mkdtemp(nodePath.join(tmpdir(), "sow-vault-")));
  await mkdir(nodePath.join(dir, "pb"), { recursive: true });
  await mkdir(nodePath.join(dir, "ew"), { recursive: true });
  await writeFile(nodePath.join(dir, "pb", "note.md"), "# hello");
  await writeFile(nodePath.join(dir, "ew", "secret.md"), "TOP SECRET");
  await writeFile(nodePath.join(dir, "pb", "big.md"), "x".repeat(50));
  // a symlink inside pb/ pointing at the ew/ workspace dir (the [critical] attack shape)
  await symlink(nodePath.join(dir, "ew"), nodePath.join(dir, "pb", "shared"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createFsVaultReadFileExec — the real fs reader (stat-cap + redaction)", () => {
  it("reads a regular file's UTF-8 content", async () => {
    const read = createFsVaultReadFileExec();
    const r = await read(nodePath.join(dir, "pb", "note.md"));
    expect(isOk(r) && r.value).toBe("# hello");
  });

  it("caps size BEFORE buffering: a note over maxBytes fails closed (VAULT_READ_TOO_LARGE)", async () => {
    const read = createFsVaultReadFileExec({ maxBytes: 10 }); // big.md is 50 bytes
    const r = await read(nodePath.join(dir, "pb", "big.md"));
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) expect(r.error.cause?.code).toBe("VAULT_READ_TOO_LARGE");
  });

  it("a directory (non-regular file) is denied (VAULT_READ_NOT_FILE)", async () => {
    const read = createFsVaultReadFileExec();
    const r = await read(nodePath.join(dir, "pb"));
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) expect(r.error.cause?.code).toBe("VAULT_READ_NOT_FILE");
  });

  it("a missing file fails closed with a stable code (no fs message leak)", async () => {
    const read = createFsVaultReadFileExec();
    const r = await read(nodePath.join(dir, "pb", "does-not-exist.md"));
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) {
      expect(r.error.cause?.code).toBe("VAULT_READ_FAULT");
      expect(r.error.message).toBe("vault read failed"); // stable message, not the raw ENOENT/path
    }
  });
});

describe("createFsRealpath — resolves symlinks (the symlink-safe layer's authority)", () => {
  it("resolves a symlinked path to its REAL target (so the handler re-attributes the real workspace)", async () => {
    const realpath = createFsRealpath();
    // pb/shared → ew ; so pb/shared/secret.md really lives at ew/secret.md
    const r = await realpath(nodePath.join(dir, "pb", "shared", "secret.md"));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(nodePath.join(dir, "ew", "secret.md")); // the REAL (foreign) location
  });

  it("a missing/broken path fails closed (VAULT_REALPATH_FAULT)", async () => {
    const realpath = createFsRealpath();
    const r = await realpath(nodePath.join(dir, "nope", "gone.md"));
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) expect(r.error.cause?.code).toBe("VAULT_REALPATH_FAULT");
  });
});
