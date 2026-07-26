// spec(§6 KN-12) — 13.8d structural-file parity: PURE builders that regenerate the vault's index.md +
// op-log as KnowledgeWriter mutation primitives (NoteCreate/NotePatch), never a 2nd writer. Per-section
// minimal-diff index regen (KN-7-safe); op-log day file + pointer; injected date (no clock).
import { describe, it, expect } from "vitest";
import { buildIndexSectionPatches, buildOpLogMutations, renderIndexEntries } from "../src/markdown-vault/structural-files";

describe("structural-files — index.md per-section regen (§6 KN-12)", () => {
  it("index_md_per_section_regen — ONLY the given (changed) sections are patched, as `- [[slug]] - desc` lines", () => {
    const patches = buildIndexSectionPatches("index.md", [
      { regionId: "people", entries: [{ slug: "jane-doe", desc: "Engineer" }, { slug: "acme" }] },
      { regionId: "projects", entries: [{ slug: "acme-api", desc: "The API" }] },
    ]);
    expect(patches).toHaveLength(2); // one NotePatch per CHANGED section (minimal diff)
    expect(patches[0]).toEqual({ path: "index.md", regionId: "people", newBody: "- [[jane-doe]] - Engineer\n- [[acme]]" });
    expect(patches[1]).toEqual({ path: "index.md", regionId: "projects", newBody: "- [[acme-api]] - The API" });
  });

  it("renderIndexEntries drops malformed entries; buildIndexSectionPatches drops marker-unsafe region ids (KN-7-safe)", () => {
    expect(renderIndexEntries([{ slug: "a" }, { slug: "" }, null as never])).toBe("- [[a]]");
    expect(buildIndexSectionPatches("index.md", [{ regionId: "@user", entries: [] }, { regionId: "bad id", entries: [] }])).toEqual([]);
    expect(buildIndexSectionPatches("", [{ regionId: "x", entries: [] }])).toEqual([]);
  });
});

describe("structural-files — op-log append (§6 KN-12)", () => {
  it("op_log_append — a Logs/<date>.md region patch + a log.md pointer patch, as KW mutations (injected date)", () => {
    const { patches } = buildOpLogMutations({ date: "2026-07-26", entry: "ingested source X → 2 notes updated" });
    expect(patches).toHaveLength(2);
    expect(patches[0]).toEqual({ path: "Logs/2026-07-26.md", regionId: "log", newBody: "ingested source X → 2 notes updated" });
    expect(patches[1]).toEqual({ path: "log.md", regionId: "pointer", newBody: "Latest: [[Logs/2026-07-26]]" });
  });

  it("a marker-unsafe / empty date yields NO mutations (fail-safe)", () => {
    expect(buildOpLogMutations({ date: "bad date", entry: "x" }).patches).toEqual([]);
    expect(buildOpLogMutations({ date: "", entry: "x" }).patches).toEqual([]);
  });
});
