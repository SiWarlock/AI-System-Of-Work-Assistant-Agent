// Regression: the composition-root FS vault MUST keep every write UNDER the vault
// root (safety rule 4 / WS-4 defense-in-depth). The adversarial verify caught that a
// model-controlled note.path (e.g. a `../` meeting title) would, after join(root,p),
// escape the bound workspace vault — a cross-workspace / arbitrary-filesystem durable
// write. The projection now slugs the title (primary fix); this pins the vault-layer
// backstop so ANY unsafe path source is refused, not just this one projection.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsVault } from "../src/composition/backends";

describe("createFsVault — workspace-vault containment (safety rule 4 / WS-4)", () => {
  const root = mkdtempSync(join(tmpdir(), "sow-vault-containment-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("REFUSES a `..` traversal write (cannot escape the vault root)", async () => {
    const vault = createFsVault(root);
    await expect(
      vault.write("meetings/ws/../../../../../../../escape.md", "x"),
    ).rejects.toThrow(/escapes the vault root/);
  });

  it("REFUSES an absolute-path write", async () => {
    const vault = createFsVault(root);
    await expect(vault.write("/etc/sow-escape.md", "x")).rejects.toThrow(
      /escapes the vault root/,
    );
  });

  it("REFUSES a traversal RENAME target", async () => {
    const vault = createFsVault(root);
    await vault.write("meetings/ws/note.md", "hello");
    await expect(
      vault.rename("meetings/ws/note.md", "../../../../../../escape.md"),
    ).rejects.toThrow(/escapes the vault root/);
  });

  it("ALLOWS a contained relative write + round-trips it", async () => {
    const vault = createFsVault(root);
    await vault.write("meetings/ws/note.md", "hello");
    expect(await vault.read("meetings/ws/note.md")).toBe("hello");
  });
});
