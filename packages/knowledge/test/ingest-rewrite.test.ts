// spec(§6 KN-10/KN-11/KN-12, REQ-F-021) — 13.8d living-vault ingest-rewrite: rewriteVaultForSource
// composes 13.8c planSynthesis (SINGLE call/run → ≤2 KMPs) + KN-12 structural-file parity merged into
// the AUTO plan + a per-run digest receipt (planIds = batch-undo unit). An ingest UPDATES ≥1 existing
// note. PURE over injected ports; TOTAL never-throws; DORMANT. @user confinement + no-inference inherited.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { classifyImporterSource, scanProductionImporters, ungatedImporters } from "./support/dormancy-pin";
import { ok } from "@sow/contracts";
import type { Result, WorkspaceId, ProvenanceOrigin } from "@sow/contracts";
import type { EntityCandidate, EntityGbrainReadPort, EntityReadFault } from "../src/synthesis/entity-resolver";
import type { SynthesisCandidate, SynthesisSectionPort, NoteRegionDescriptor } from "../src/synthesis/planner";
import {
  rewriteVaultForSource,
  type IngestRewriteInput,
  type IngestRewriteDeps,
  type StructuralFileWriterPort,
  type StructuralMutations,
} from "../src/synthesis/ingest-rewrite";

const WS_A = "ws-a" as WorkspaceId;
const cand = (o: Partial<EntityCandidate> & Pick<EntityCandidate, "path" | "slug">): EntityCandidate => ({ workspaceId: WS_A, ...o });

function fakeGbrain(byName: Record<string, () => Result<readonly EntityCandidate[], EntityReadFault>>): EntityGbrainReadPort {
  return { workspaceId: WS_A, findCandidates: async (ref) => (byName[ref.name] ?? (() => ok([])))() };
}
function fakeSections(map: Record<string, NoteRegionDescriptor>): SynthesisSectionPort {
  return { describe: (p) => map[p] ?? { generatedRegionIds: [] } };
}
function fakeReason(c: SynthesisCandidate | (() => Promise<SynthesisCandidate>)): IngestRewriteDeps["reason"] {
  return { reason: typeof c === "function" ? c : async () => c };
}
function fakeStructural(m: StructuralMutations | ((ctx: unknown) => StructuralMutations)): StructuralFileWriterPort {
  return { build: (typeof m === "function" ? m : () => m) as StructuralFileWriterPort["build"] };
}
function mkDeps(over: Partial<IngestRewriteDeps>): IngestRewriteDeps {
  let n = 0;
  let r = 0;
  return {
    gbrain: fakeGbrain({}),
    reason: fakeReason({}),
    sections: fakeSections({}),
    structural: fakeStructural({}),
    newPlanId: () => `plan-${++n}`,
    newRunId: () => `run-${++r}`,
    ...over,
  };
}
const baseInput = (over: Partial<IngestRewriteInput> = {}): IngestRewriteInput => ({
  workspaceId: WS_A,
  provenanceOrigin: "ingestion" as ProvenanceOrigin,
  sourceRefs: [{ sourceId: "src-1", span: "1-4" }],
  confidence: 0.9,
  ...over,
});

// ── 1. the vault rewrites itself — an ingest UPDATES an existing note ───────────────

describe("rewriteVaultForSource — the vault rewrites itself (§6 KN-10)", () => {
  it("ingest_updates_existing_related_note — a region refresh ⇒ a NotePatch to the EXISTING note (not just a create)", async () => {
    const candidate: SynthesisCandidate = {
      regions: [{ notePath: "people/jane-doe.md", regionId: "summary", body: "Updated from source X.", effect: "refresh" }],
    };
    const deps = mkDeps({ reason: fakeReason(candidate), sections: fakeSections({ "people/jane-doe.md": { generatedRegionIds: ["summary"] } }) });
    const receipt = await rewriteVaultForSource(baseInput(), deps);
    const patches = receipt.plans.flatMap((p) => p.patches);
    expect(patches.some((p) => p.path === "people/jane-doe.md" && p.regionId === "summary")).toBe(true);
  });

  it("multi_entity_merges_to_two_plans — additive + human-relevant ⇒ ≤2 KMPs, one digest", async () => {
    const candidate: SynthesisCandidate = {
      regions: [{ notePath: "synthesis/new.md", regionId: "body", body: "x", effect: "new_note" }],
      frontmatter: [{ notePath: "people/jane.md", key: "status", value: "active", evidenceRef: "src-1#s" }],
    };
    const receipt = await rewriteVaultForSource(baseInput(), mkDeps({ reason: fakeReason(candidate) }));
    expect(receipt.plans.length).toBe(2);
    expect(receipt.autoCount).toBe(1);
    expect(receipt.proposeCount).toBe(1);
  });
});

// ── 2. structural-file parity merged as KW mutations (KN-12) ────────────────────────

describe("rewriteVaultForSource — structural-file parity merged into the plan set (§6 KN-12)", () => {
  it("index + op-log mutations ride the AUTO plan (still ≤2), never a 2nd writer", async () => {
    const candidate: SynthesisCandidate = { regions: [{ notePath: "synthesis/n.md", regionId: "b", body: "x", effect: "new_note" }] };
    const structural: StructuralMutations = {
      patches: [
        { path: "index.md", regionId: "people", newBody: "- [[jane-doe]]" },
        { path: "Logs/2026-07-26.md", regionId: "log", newBody: "entry" },
      ],
    };
    const receipt = await rewriteVaultForSource(baseInput(), mkDeps({ reason: fakeReason(candidate), structural: fakeStructural(structural) }));
    expect(receipt.plans.length).toBe(1);
    const auto = receipt.plans.find((p) => p.requiresApproval === false)!;
    expect(auto.patches.some((p) => p.path === "index.md")).toBe(true);
    expect(auto.patches.some((p) => p.path === "Logs/2026-07-26.md")).toBe(true);
    expect(auto.creates.some((c) => c.path === "synthesis/n.md")).toBe(true); // the semantic create survives the merge
  });

  it("structural parity on a propose-ONLY run creates a fresh AUTO plan (≤2 total)", async () => {
    const candidate: SynthesisCandidate = { frontmatter: [{ notePath: "n.md", key: "status", value: "active", evidenceRef: "src-1#s" }] };
    const structural: StructuralMutations = { patches: [{ path: "index.md", regionId: "people", newBody: "- [[x]]" }] };
    const receipt = await rewriteVaultForSource(baseInput(), mkDeps({ reason: fakeReason(candidate), structural: fakeStructural(structural) }));
    expect(receipt.plans.length).toBe(2);
    expect(receipt.autoCount).toBe(1);
    expect(receipt.proposeCount).toBe(1);
  });
});

// ── 3. digest receipt + inherited safety + bounds + dormancy ────────────────────────

describe("rewriteVaultForSource — digest, inherited safety, flood-bound, dormant (§6 / L11 / L24)", () => {
  it("receipt_groups_planIds — enumerates runId + planIds (batch-undo unit) + auto/propose counts", async () => {
    const candidate: SynthesisCandidate = { regions: [{ notePath: "synthesis/n.md", regionId: "b", body: "x", effect: "new_note" }] };
    const receipt = await rewriteVaultForSource(baseInput(), mkDeps({ reason: fakeReason(candidate), newRunId: () => "run-XYZ" }));
    expect(receipt.runId).toBe("run-XYZ");
    expect(receipt.planIds).toEqual(receipt.plans.map((p) => p.planId));
    expect(receipt.planIds.length).toBeGreaterThan(0);
    expect(receipt.autoCount + receipt.proposeCount).toBe(receipt.plans.length);
  });

  it("user_region_never_patched — the confinement inherited from planSynthesis holds through the orchestrator", async () => {
    const candidate: SynthesisCandidate = {
      regions: [
        { notePath: "u.md", regionId: "@user", body: "hijack", effect: "refresh" },
        { notePath: "u.md", regionId: "summary", body: "ok", effect: "refresh" },
      ],
    };
    const receipt = await rewriteVaultForSource(baseInput(), mkDeps({ reason: fakeReason(candidate), sections: fakeSections({ "u.md": { generatedRegionIds: ["summary"] } }) }));
    expect(receipt.plans.flatMap((p) => p.patches).some((p) => p.regionId === "@user")).toBe(false);
  });

  it("candidate_arrays_bounded — a link candidate BEYOND the cap is not considered (L31 flood-bound)", async () => {
    const filler = Array.from({ length: 2001 }, (_, i) => cand({ path: `f${i}.md`, slug: `f${i}` }));
    const beyond = cand({ path: "target.md", slug: "acme-api", title: "Acme API" }); // index 2001, beyond MAX 2000
    const candidate: SynthesisCandidate = { links: { srcPath: "src.md", refs: [{ title: "Acme API" }] } };
    const receipt = await rewriteVaultForSource(baseInput({ linkCandidates: [...filler, beyond] }), mkDeps({ reason: fakeReason(candidate) }));
    const links = receipt.plans.flatMap((p) => p.linkMutations);
    expect(links.some((l) => l.dstSlug === "acme-api")).toBe(false); // the beyond-cap candidate was sliced off
  });

  it("pure_never_throws — a throwing reason / non-object input ⇒ fail-safe empty receipt, no throw", async () => {
    const throwing = mkDeps({ reason: { reason: async () => { throw new Error("boom"); } } });
    const r1 = await rewriteVaultForSource(baseInput(), throwing);
    expect(r1.plans).toEqual([]);
    expect(r1.planIds).toEqual([]);
    const r2 = await rewriteVaultForSource(null as unknown as IngestRewriteInput, mkDeps({}));
    expect(r2.plans).toEqual([]);
  });

  // spec(§6 KN-10, L24) — REFRAMED (13.8f-A commit 1): the pin asserted *zero* production importers,
  // which forces a RED window on the slice that binds it (13.8d worker-binding). The invariant it always
  // meant is "every production importer is an ARMING-GATED site" — green with zero importers (today) AND
  // with the flag-gated binding (tomorrow). The predicate lives once, in test/support/dormancy-pin.ts.
  it("no_production_caller — every apps/ or workflows/ importer of rewriteVaultForSource is arming-gated (dormant, L24)", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const importers = scanProductionImporters("rewriteVaultForSource", repoRoot);
    expect(ungatedImporters(importers, "rewriteVaultForSource")).toEqual([]);
  });

  it("dormancy_pin_allows_gated_importer — a flag-gated / type-only importer passes; an UNGATED one FAILS (non-vacuous)", () => {
    const sym = "rewriteVaultForSource";
    const ungated = `import { ${sym} } from "@sow/knowledge";\nconst plans = await ${sym}(input, deps);`;
    const gated = `import { ${sym} } from "@sow/knowledge";\nif (config.livingVaultRewrite === true) { await ${sym}(input, deps); }`;
    // THE REAL SHAPE of a composition-root binding: the strict `=== true` lives in boot.ts, one hop
    // away, so this importing file carries the marker INSTEAD — the load-bearing branch.
    const waived = `import { ${sym} } from "@sow/knowledge";\n// dormancy-waiver(13.8d): armed only via boot.ts gateLivingVaultRewrite (=== true)\nbuildActivities({ rewrite: ${sym} });`;
    const markerNoTaskId = `import { ${sym} } from "@sow/knowledge";\n// dormancy-waiver()\nawait ${sym}(input, deps);`;
    const typeOnly = `import type { ${sym} } from "@sow/knowledge";\nexport interface Deps { rewrite?: typeof ${sym} }`;

    expect(classifyImporterSource(ungated, sym)).toBe("ungated");
    expect(classifyImporterSource(gated, sym)).toBe("gated");
    expect(classifyImporterSource(waived, sym)).toBe("gated");
    expect(classifyImporterSource(typeOnly, sym)).toBe("type_only");
    // the marker is a CLAIM that must name its task — an empty marker is not a waiver
    expect(classifyImporterSource(markerNoTaskId, sym)).toBe("ungated");
    // the offender list is exactly the ungated file — the pin has not been weakened to a tautology
    expect(
      ungatedImporters(
        [
          { path: "packages/workflows/src/activities/ungated.ts", source: ungated },
          { path: "packages/workflows/src/workflows/sourceIngestion.ts", source: gated },
          { path: "packages/workflows/src/ports/sourceIngestion.ts", source: typeOnly },
        ],
        sym,
      ),
    ).toEqual(["packages/workflows/src/activities/ungated.ts"]);
  });

  it("dormancy_pin_still_passes_with_zero_importers — the pin never REQUIRES an importer (no RED window either side)", () => {
    // Today's state is zero production importers; the reframe must not have become "there must be
    // exactly one gated importer", which would be RED until the worker's binding lands.
    expect(ungatedImporters([], "rewriteVaultForSource")).toEqual([]);
  });
});
