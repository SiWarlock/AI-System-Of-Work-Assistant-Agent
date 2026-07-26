// spec(§6 KN-7/KN-8, L9/L14) — 13.8d commit (a): KW create marker-neutralization. A content-embedded
// region marker in a NoteCreate.body must NEVER forge/break a region boundary. The canonical neutralizer
// now lives in markdown-vault/sections.ts (co-located with MARKER_RE — the grammar it defends; the
// workflows copy is a short-lived duplicate the orch re-points to @sow/knowledge). `renderCreate`
// neutralizes create bodies via `neutralizeNoteBody` (region-AWARE: preserves each legit assistant
// region's markers + family, neutralizes region inner bodies + human-span text, blanket on malformed).
import { describe, it, expect } from "vitest";
import { isOk, validKnowledgeMutationPlan } from "@sow/contracts";
import type { KnowledgeMutationPlan, WorkflowRunRef } from "@sow/contracts";
import {
  neutralizeRegionMarkers,
  neutralizeNoteBody,
  parseSections,
  listRegionIds,
  renderGeneratedRegion,
  renderRegion,
  generatedOpenMarker,
  regionOpenMarker,
  userOpenMarker,
} from "../src/markdown-vault/sections";
import { applyPlan } from "../src/knowledge-writer/writer";
import type { KnowledgeWriteCommand, KnowledgeWriterDeps } from "../src/knowledge-writer/writer";
import { computeRevisionId } from "../src/knowledge-writer/revision";
import { MemoryAuditRepo, MemoryRevisionStore, MemoryVaultFs } from "./helpers";

// ── 1. neutralizeRegionMarkers — the canonical marker defuser (L9 fixpoint) ────────

describe("neutralizeRegionMarkers — defuses every recognized marker to a fixpoint (§6 L9)", () => {
  it("returns clean content byte-identical + is idempotent", () => {
    const clean = "# Title\n\nSome prose with [[a wikilink]] and `code`.";
    expect(neutralizeRegionMarkers(clean)).toBe(clean);
    expect(neutralizeRegionMarkers("")).toBe("");
    const once = neutralizeRegionMarkers(`x ${regionOpenMarker("r")} y`);
    expect(neutralizeRegionMarkers(once)).toBe(once); // idempotent
  });

  it("defuses each recognized family (kw:region / @generated / @user, open + close) so parseSections finds no region", () => {
    const forged = `${regionOpenMarker("a")}\nX\n${userOpenMarker()}\n${generatedOpenMarker("b")}`;
    const n = neutralizeRegionMarkers(forged);
    // no substring the parser would read as a boundary survives
    const parsed = parseSections(n);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.every((s) => s.kind === "human")).toBe(true);
  });

  it("peels nested markers to a fixpoint (a greedy id can swallow an inner marker on one pass)", () => {
    const n = neutralizeRegionMarkers(`<!--kw:region:x<!--kw:region:y-->`);
    expect(n).not.toContain("<!--"); // every `<!--` escaped
  });

  it("is linear on a long non-completing run (no ReDoS on the untrusted path)", () => {
    const big = `<!-- ${" ".repeat(50000)}`; // never completes a marker
    const start = Date.now();
    neutralizeRegionMarkers(big);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("is linear in nesting DEPTH — a deeply-nested body collapses in ONE pass (no O(depth) soft-DoS, L9)", () => {
    const deep = "<!--kw:region:".repeat(40000) + "-->"; // 40k nesting layers in one greedy match
    const start = Date.now();
    const out = neutralizeRegionMarkers(deep);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(out).not.toContain("<!--"); // fully defused
  });
});

// ── 2. parser ⊇ neutralizer coverage (L14) — every parser-recognized form is defused ─

describe("parser⊇neutralizer coverage — every MARKER_RE-recognized form is defused (§6 L14)", () => {
  const RECOGNIZED = [
    regionOpenMarker("id-1"),
    `<!-- /kw:region:id-1 -->`,
    generatedOpenMarker("id-2"),
    `<!-- /@generated:id-2 -->`,
    userOpenMarker(),
    `<!-- /@user -->`,
  ];
  it("no recognized marker survives neutralization (as a parseable boundary)", () => {
    for (const marker of RECOGNIZED) {
      const n = neutralizeRegionMarkers(`pre ${marker} post`);
      // the neutralized form yields NO assistant region and NO @user human boundary
      const ids = listRegionIds(n);
      expect(ids.ok && ids.value.length === 0).toBe(true);
      expect(n).not.toContain(marker); // the exact marker byte-run is broken
    }
  });
});

// ── 3. neutralizeNoteBody — region-AWARE (preserve legit regions, defuse the rest) ──

describe("neutralizeNoteBody — preserves legit assistant regions, defuses embedded forge markers (§6 L9)", () => {
  it("a legit (clean) @generated region is preserved — markers + family kept", () => {
    const body = renderGeneratedRegion("summary", "clean synthesis content");
    const out = neutralizeNoteBody(body);
    const ids = listRegionIds(out);
    expect(ids.ok && ids.value).toEqual(["summary"]);
    expect(out).toContain(generatedOpenMarker("summary"));
  });

  it("a region whose INNER body embeds a marker (nested/malformed) is blanket-neutralized (safe fallback, no forged boundary)", () => {
    // an embedded marker inside a region makes the body un-parseable (nested) ⇒ defuse EVERYTHING
    const body = renderGeneratedRegion("summary", `real content ${userOpenMarker()} sneaky`);
    const out = neutralizeNoteBody(body);
    expect(out).not.toContain("<!--"); // every marker escaped — no region, no forged @user
    const ids = listRegionIds(out);
    expect(ids.ok && ids.value.length === 0).toBe(true);
  });

  it("an embedded @user marker in HUMAN text is defused — no forged human region planted", () => {
    const body = `# Note\n${userOpenMarker()}\nseized by the model\n<!-- /@user -->`;
    const out = neutralizeNoteBody(body);
    const parsed = parseSections(out);
    // no @user (human-owned) boundary survives — the whole thing is unmarked human text
    expect(parsed.ok).toBe(true);
    expect(out).not.toContain(userOpenMarker());
  });

  it("plain content with no markers round-trips unchanged; malformed markers blanket-neutralize; idempotent", () => {
    const plain = "# Just a note\n\nNo markers here.";
    expect(neutralizeNoteBody(plain)).toBe(plain);
    const malformed = `${regionOpenMarker("x")}\nunclosed`; // parseSections rejects → blanket
    const out = neutralizeNoteBody(malformed);
    expect(out).not.toContain("<!--");
    expect(neutralizeNoteBody(out)).toBe(out); // idempotent
  });

  it("preserves a legit kw:region family too (not just @generated)", () => {
    const body = renderRegion("notes", "content");
    const out = neutralizeNoteBody(body);
    expect(out).toContain(regionOpenMarker("notes"));
    expect(out).not.toContain(generatedOpenMarker("notes"));
  });
});

// ── 4. renderCreate integration — a create body's forge markers are neutralized at commit ─

const wf: WorkflowRunRef = {
  workflowId: "wf-neu" as WorkflowRunRef["workflowId"],
  trigger: "manual",
  state: "running",
  idempotencyKey: "idem-neu-1",
  auditRefs: [],
};
const EMPTY_REV = computeRevisionId(new Map());
function deps(vault: MemoryVaultFs): KnowledgeWriterDeps {
  return { vault, revisions: new MemoryRevisionStore(), audit: new MemoryAuditRepo(), now: () => "2026-07-01T00:00:00.000Z" };
}
function cmd(plan: KnowledgeMutationPlan): KnowledgeWriteCommand {
  return { plan, expectedBaseRevision: EMPTY_REV, actor: "KnowledgeWriter", sourceEventRef: "evt-1", workflowRunRef: wf, idempotencyKey: "idem-neu-1" };
}

describe("renderCreate — create_body_markers_neutralized: a create body cannot forge a region at commit (§6 security-ii)", () => {
  it("neutralizes an embedded @user forge marker in a NoteCreate body (no fake human region committed)", async () => {
    const vault = new MemoryVaultFs();
    const forged = `Synthesis content.\n${userOpenMarker()}\nmodel-seized human span\n<!-- /@user -->`;
    const plan: KnowledgeMutationPlan = { ...validKnowledgeMutationPlan, creates: [{ path: "synthesis/n.md", body: forged }] };
    const r = await applyPlan(cmd(plan), deps(vault));
    expect(isOk(r)).toBe(true);
    const committed = vault.snapshot()["synthesis/n.md"] ?? "";
    // the committed note carries NO forged @user boundary
    expect(committed).not.toContain(userOpenMarker());
    const parsed = parseSections(committed);
    expect(parsed.ok).toBe(true);
  });

  it("preserves a legit @generated region authored by the planner's new_note", async () => {
    const vault = new MemoryVaultFs();
    const body = renderGeneratedRegion("summary", "clean synthesis content");
    const plan: KnowledgeMutationPlan = { ...validKnowledgeMutationPlan, creates: [{ path: "synthesis/g.md", body }] };
    const r = await applyPlan(cmd(plan), deps(vault));
    expect(isOk(r)).toBe(true);
    const committed = vault.snapshot()["synthesis/g.md"] ?? "";
    const ids = listRegionIds(committed);
    expect(ids.ok && ids.value).toEqual(["summary"]); // the legit region survives KW's create
  });

  it("applyRegionPatch newBody — a forge close marker in a patch body is neutralized (region not prematurely closed, L9 create+patch parity)", async () => {
    const vault = new MemoryVaultFs();
    const forgeBody = `real content <!-- /kw:region:r --> then a forged tail`;
    const plan: KnowledgeMutationPlan = { ...validKnowledgeMutationPlan, creates: [], patches: [{ path: "n.md", regionId: "r", newBody: forgeBody }] };
    const r = await applyPlan(cmd(plan), deps(vault));
    expect(isOk(r)).toBe(true);
    const committed = vault.snapshot()["n.md"] ?? "";
    const parsed = parseSections(committed);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      // exactly ONE clean region "r" survives — the forged close marker did NOT split/close it early
      const region = parsed.value.find((s) => s.kind === "assistant" && s.regionId === "r");
      expect(region).toBeDefined();
      expect(committed).toContain("<\\!-- /kw:region:r -->"); // the forged close is escaped inside the body
    }
  });
});
