// spec(§6) — atomic all-or-nothing vault commit (temp-write + rename), task 4.1
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import { atomicCommit } from "../src/markdown-vault/atomic-write";
import { MemoryVaultFs } from "./helpers";

describe("atomicCommit", () => {
  it("commits every change and leaves no staging temp behind", async () => {
    const fs = new MemoryVaultFs();
    const r = await atomicCommit(
      fs,
      [
        { path: "a.md", content: "AAA" },
        { path: "sub/b.md", content: "BBB" },
      ],
      "tok1",
    );
    expect(isOk(r)).toBe(true);
    expect(fs.snapshot()).toEqual({ "a.md": "AAA", "sub/b.md": "BBB" });
    // no residual temp files
    expect([...fs.files.keys()].some((k) => k.endsWith(".kwtmp"))).toBe(false);
  });

  it("is a no-op ok on an empty change set", async () => {
    const fs = new MemoryVaultFs({ "keep.md": "K" });
    const r = await atomicCommit(fs, [], "tok");
    expect(isOk(r)).toBe(true);
    expect(fs.snapshot()).toEqual({ "keep.md": "K" });
  });

  it("stage failure leaves the vault byte-identical and sweeps temps", async () => {
    const fs = new MemoryVaultFs({ "existing.md": "orig" });
    fs.failWriteOn = (p) => p.startsWith("b.md");
    const r = await atomicCommit(
      fs,
      [
        { path: "a.md", content: "A" },
        { path: "b.md", content: "B" },
      ],
      "tok",
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("stage_failed");
    // nothing committed, no temp leaked
    expect(fs.snapshot()).toEqual({ "existing.md": "orig" });
    expect([...fs.files.keys()].some((k) => k.endsWith(".kwtmp"))).toBe(false);
  });

  it("rename failure mid-commit rolls back already-renamed files (all-or-nothing)", async () => {
    const fs = new MemoryVaultFs({ "a.md": "old-A" });
    fs.failRenameOn = (to) => to === "b.md";
    const r = await atomicCommit(
      fs,
      [
        { path: "a.md", content: "new-A" }, // overwrite (renames first, then rolls back)
        { path: "b.md", content: "new-B" }, // rename fails here
      ],
      "tok",
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("commit_failed");
    // a.md restored to its prior bytes; b.md never created
    expect(fs.snapshot()).toEqual({ "a.md": "old-A" });
    expect([...fs.files.keys()].some((k) => k.endsWith(".kwtmp"))).toBe(false);
  });
});
