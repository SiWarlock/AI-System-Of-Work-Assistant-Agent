// §13.10a G4a — `readVaultHeadRevision`: the current whole-vault revision id, read live from a VaultFs.
// The commit-on-approval path resolves the expected base revision to THIS at commit time (a Copilot
// semantic plan is approved long after propose, so a FIXED base spuriously write_conflicts on any unrelated
// vault change). Resolving head-at-commit makes the writer's whole-vault compare-revision a no-op and
// delegates TARGET integrity to the executor's gate-1 (readNoteProjectId / noteExists) — the precise check.
// This helper MUST agree byte-for-byte with the revision the writer's own applyPlan computes over the same
// vault (both are computeRevisionId ∘ readSnapshot), else the compare would spuriously clash.
import { describe, it, expect } from "vitest";
import { readVaultHeadRevision, computeRevisionId } from "../src";
import type { VaultFs } from "../src";

/** A minimal in-memory VaultFs (only list/read are exercised by the head-revision read). */
function memVault(files: Record<string, string>): VaultFs {
  return {
    list: async () => Object.keys(files),
    read: async (p: string) => (p in files ? files[p] : undefined),
    write: async () => undefined,
    rename: async () => undefined,
    remove: async () => undefined,
  };
}

describe("readVaultHeadRevision", () => {
  it("equals computeRevisionId over the vault's current snapshot (agrees with the writer's compare-revision)", async () => {
    const files = { "projects/personal-business/acme.md": "# Acme\n", "notes/x.md": "hi\n" };
    const head = await readVaultHeadRevision(memVault(files));
    const expected = computeRevisionId(new Map(Object.entries(files)));
    expect(head).toBe(expected);
  });

  it("is order-independent (list order must not change the revision)", async () => {
    const a = memVault({ "a.md": "1", "b.md": "2" });
    const bReordered: VaultFs = { ...memVault({ "a.md": "1", "b.md": "2" }), list: async () => ["b.md", "a.md"] };
    expect(await readVaultHeadRevision(a)).toBe(await readVaultHeadRevision(bReordered));
  });

  it("handles an empty vault (no files) deterministically", async () => {
    expect(await readVaultHeadRevision(memVault({}))).toBe(computeRevisionId(new Map()));
  });

  it("changes when a file's content changes (a real base-revision would clash)", async () => {
    const before = await readVaultHeadRevision(memVault({ "a.md": "one" }));
    const after = await readVaultHeadRevision(memVault({ "a.md": "two" }));
    expect(before).not.toBe(after);
  });
});
