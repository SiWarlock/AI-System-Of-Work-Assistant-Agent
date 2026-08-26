// spec(§6 KN-10; 13.14 phase 5) — research propagation: propagateResearchUpdates grounds each
// /research-deep "Recommended Vault Update" via resolveEntity (13.8a) and plans it via planSynthesis
// (13.8c) into a validated KnowledgeMutationPlan. NEVER fabricates a path for a withheld entity;
// NEVER writes Markdown itself (emits plan DATA only); TOTAL never-throws; one outcome per update, in
// order, never dropped.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { workspaceId } from "@sow/contracts";
import type { ProvenanceOrigin } from "@sow/contracts";
import { classifyImporterSource, scanProductionImporters, ungatedImporters } from "./support/dormancy-pin";
import type { EntityCandidate, EntityGbrainReadPort, EntityReadFault } from "../src/synthesis/entity-resolver";
import type { NoteRegionDescriptor, SynthesisSectionPort } from "../src/synthesis/planner";
import { renderGeneratedRegion } from "../src/markdown-vault/sections";
import {
  propagateResearchUpdates,
  RESEARCH_REGION_ID,
  DEFAULT_ENTITY_KIND,
  type ResearchPropagationDeps,
  type ResearchPropagationInput,
  type RecommendedVaultUpdate,
} from "../src/synthesis/research-propagation";
import type { Result } from "@sow/contracts";

const WS_A = workspaceId("ws-a");
const cand = (o: Partial<EntityCandidate> & Pick<EntityCandidate, "path" | "slug">): EntityCandidate => ({ workspaceId: WS_A, ...o });

function fakeGbrain(byName: Record<string, () => Result<readonly EntityCandidate[], EntityReadFault>>): EntityGbrainReadPort {
  return { workspaceId: WS_A, findCandidates: async (ref) => (byName[ref.name] ?? (() => ({ ok: true as const, value: [] })))() };
}
function fakeSections(map: Record<string, NoteRegionDescriptor>): SynthesisSectionPort {
  return { describe: (p) => map[p] ?? { generatedRegionIds: [] } };
}
function mkDeps(over: Partial<ResearchPropagationDeps> = {}): ResearchPropagationDeps {
  let n = 0;
  return {
    gbrain: fakeGbrain({}),
    sections: fakeSections({}),
    newPlanId: () => `plan-${++n}`,
    ...over,
  };
}
const update = (over: Partial<RecommendedVaultUpdate> = {}): RecommendedVaultUpdate => ({
  entityName: "Acme API",
  change: "New rate-limit docs published.",
  citations: [{ url: "https://example.com/acme-rate-limits" }],
  ...over,
});
const baseInput = (over: Partial<ResearchPropagationInput> = {}): ResearchPropagationInput => ({
  workspaceId: WS_A,
  provenanceOrigin: "gbrain_proposal" as ProvenanceOrigin,
  recommendedUpdates: [],
  ...over,
});

// ── grounding: resolved / create_stub / withheld ────────────────────────────────────

describe("propagateResearchUpdates — grounding (13.8a) drives the outcome", () => {
  it("resolved_entity_no_existing_region — grounds to a NotePatch on the EXISTING note (new_region)", async () => {
    const gbrain = fakeGbrain({ "Acme API": () => ({ ok: true, value: [cand({ path: "projects/acme-api.md", slug: "acme-api-inc", title: "Acme API" })] }) });
    const res = await propagateResearchUpdates(baseInput({ recommendedUpdates: [update()] }), mkDeps({ gbrain }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1);
    const outcome = res.value[0]!;
    expect(outcome.kind).toBe("grounded");
    if (outcome.kind !== "grounded") return;
    expect(outcome.entityName).toBe("Acme API");
    expect(outcome.plan.requiresApproval).toBe(false);
    expect(outcome.plan.patches).toEqual([{ path: "projects/acme-api.md", regionId: RESEARCH_REGION_ID, newBody: "New rate-limit docs published." }]);
    expect(outcome.plan.creates).toEqual([]);
    expect(outcome.plan.sourceRefs).toEqual([{ sourceId: "https://example.com/acme-rate-limits" }]);
    expect(outcome.plan.provenanceOrigin).toBe("gbrain_proposal");
  });

  it("resolved_entity_region_already_exists — MUST refresh, not new_region (a wrong effect here would DROP the write)", async () => {
    const gbrain = fakeGbrain({ "Acme API": () => ({ ok: true, value: [cand({ path: "projects/acme-api.md", slug: "acme-api-inc", title: "Acme API" })] }) });
    const sections = fakeSections({ "projects/acme-api.md": { generatedRegionIds: [RESEARCH_REGION_ID] } });
    const res = await propagateResearchUpdates(baseInput({ recommendedUpdates: [update()] }), mkDeps({ gbrain, sections }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const outcome = res.value[0]!;
    // proves the effect selection reads describe() correctly: collectRegions DROPS a mismatched
    // effect (new_region against an EXISTING id fails the allowlist), so a wrong choice here would
    // silently flip this to "withheld" — grounded is only reachable via "refresh".
    expect(outcome.kind).toBe("grounded");
    if (outcome.kind !== "grounded") return;
    expect(outcome.plan.patches).toEqual([{ path: "projects/acme-api.md", regionId: RESEARCH_REGION_ID, newBody: "New rate-limit docs published." }]);
  });

  it("create_stub — mints a NEW note WITH the researched content (default kind: concept)", async () => {
    const res = await propagateResearchUpdates(baseInput({ recommendedUpdates: [update({ entityName: "Novel Widget" })] }), mkDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const outcome = res.value[0]!;
    expect(outcome.kind).toBe("grounded");
    if (outcome.kind !== "grounded") return;
    expect(DEFAULT_ENTITY_KIND).toBe("concept");
    expect(outcome.plan.creates).toEqual([
      { path: "concepts/novel-widget.md", body: renderGeneratedRegion(RESEARCH_REGION_ID, "New rate-limit docs published.") },
    ]);
    expect(outcome.plan.patches).toEqual([]);
  });

  it("create_stub honors an explicitly-supplied entityKind (namespaces under people/, not concepts/)", async () => {
    const res = await propagateResearchUpdates(
      baseInput({ recommendedUpdates: [update({ entityName: "Ada Lovelace", entityKind: "person" })] }),
      mkDeps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const outcome = res.value[0]!;
    expect(outcome.kind).toBe("grounded");
    if (outcome.kind !== "grounded") return;
    expect(outcome.plan.creates[0]!.path).toBe("people/ada-lovelace.md");
  });

  it("ambiguous_match — withheld with resolveEntity's OWN reason, never a fabricated plan", async () => {
    const gbrain = fakeGbrain({
      "Ambiguous Corp": () => ({
        ok: true,
        value: [
          cand({ path: "a.md", slug: "ambiguous-corp-a", title: "Ambiguous Corp" }),
          cand({ path: "b.md", slug: "ambiguous-corp-b", title: "Ambiguous Corp" }),
        ],
      }),
    });
    const res = await propagateResearchUpdates(baseInput({ recommendedUpdates: [update({ entityName: "Ambiguous Corp" })] }), mkDeps({ gbrain }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const outcome = res.value[0]!;
    expect(outcome).toEqual({ kind: "withheld", entityName: "Ambiguous Corp", reason: "ambiguous" });
  });
});

// ── admissibility: malformed update / no citations ──────────────────────────────────

describe("propagateResearchUpdates — admissibility (REQ-F-006, no-inference)", () => {
  it("empty_entity_name — withheld malformed_update, never reaches gbrain", async () => {
    let called = false;
    const gbrain = fakeGbrain({});
    gbrain.findCandidates = async (ref) => {
      called = true;
      return { ok: true, value: [] };
    };
    const res = await propagateResearchUpdates(baseInput({ recommendedUpdates: [update({ entityName: "" })] }), mkDeps({ gbrain }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value[0]).toEqual({ kind: "withheld", entityName: "", reason: "malformed_update" });
    expect(called).toBe(false);
  });

  it("no_admissible_citation — an update with zero citations is withheld no_source_refs (REQ-F-006)", async () => {
    const res = await propagateResearchUpdates(baseInput({ recommendedUpdates: [update({ citations: [] })] }), mkDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value[0]).toEqual({ kind: "withheld", entityName: "Acme API", reason: "no_source_refs" });
  });

  it("citations_with_a_blank_url_are_filtered — a mixed set still sources the plan from the valid ones", async () => {
    const res = await propagateResearchUpdates(
      baseInput({ recommendedUpdates: [update({ citations: [{ url: "" }, { url: "https://good.example/x" }] })] }),
      mkDeps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const outcome = res.value[0]!;
    expect(outcome.kind).toBe("grounded");
    if (outcome.kind !== "grounded") return;
    expect(outcome.plan.sourceRefs).toEqual([{ sourceId: "https://good.example/x" }]);
  });
});

// ── documented limitation: same-batch, same-target updates plan independently ───────

describe("propagateResearchUpdates — same-target updates in one batch plan independently (documented limitation)", () => {
  it("two updates resolving to the SAME NEW target each mint their OWN new_note plan — reconciliation defers to KnowledgeWriter at commit time", async () => {
    const res = await propagateResearchUpdates(
      baseInput({
        recommendedUpdates: [
          update({ entityName: "Novel Widget", change: "first finding" }),
          update({ entityName: "Novel Widget", change: "second finding" }),
        ],
      }),
      mkDeps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(2);
    const [first, second] = res.value;
    expect(first!.kind).toBe("grounded");
    expect(second!.kind).toBe("grounded");
    if (first!.kind !== "grounded" || second!.kind !== "grounded") return;
    // Both updates independently see "no note exists yet" (this module never writes, so it cannot
    // observe a sibling update's not-yet-committed plan) — each mints its OWN new_note at the same
    // path. Never silently dropped nor silently merged; a resulting commit-time collision is
    // KnowledgeWriter's own guard to enforce (degrade-not-fail, researchDeep.ts inv-4).
    expect(first!.plan.creates).toEqual([
      { path: "concepts/novel-widget.md", body: renderGeneratedRegion(RESEARCH_REGION_ID, "first finding") },
    ]);
    expect(second!.plan.creates).toEqual([
      { path: "concepts/novel-widget.md", body: renderGeneratedRegion(RESEARCH_REGION_ID, "second finding") },
    ]);
  });
});

// ── ordering + total never-throws ────────────────────────────────────────────────────

describe("propagateResearchUpdates — one outcome per update, in order, never dropped; TOTAL never-throws", () => {
  it("a mix of grounded/withheld outcomes preserves count + input order", async () => {
    const gbrain = fakeGbrain({
      Known: () => ({ ok: true, value: [cand({ path: "known.md", slug: "known" })] }),
      Ambiguous: () => ({ ok: true, value: [cand({ path: "a.md", slug: "ambiguous" }), cand({ path: "b.md", slug: "ambiguous", title: "Ambiguous" })] }),
    });
    const res = await propagateResearchUpdates(
      baseInput({
        recommendedUpdates: [update({ entityName: "Known" }), update({ entityName: "Ambiguous" }), update({ entityName: "Fresh Stub" })],
      }),
      mkDeps({ gbrain }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.map((o) => o.entityName)).toEqual(["Known", "Ambiguous", "Fresh Stub"]);
    expect(res.value.map((o) => o.kind)).toEqual(["grounded", "withheld", "grounded"]);
  });

  it("a throwing gbrain port for ONE update withholds only that one; a neighbor still grounds (per-update isolation)", async () => {
    const gbrain = fakeGbrain({});
    gbrain.findCandidates = async (ref) => {
      if (ref.name === "Boom") throw new Error("injected fault");
      return { ok: true, value: [] };
    };
    const res = await propagateResearchUpdates(
      baseInput({ recommendedUpdates: [update({ entityName: "Boom" }), update({ entityName: "Fresh Stub" })] }),
      mkDeps({ gbrain }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(2);
    expect(res.value[0]).toEqual({ kind: "withheld", entityName: "Boom", reason: "gbrain_unavailable" });
    expect(res.value[1]!.kind).toBe("grounded");
  });

  it("malformed top-level input ⇒ typed err, never a throw", async () => {
    const r1 = await propagateResearchUpdates({ recommendedUpdates: null as unknown as [] } as unknown as ResearchPropagationInput, mkDeps());
    expect(r1.ok).toBe(false);
    const r2 = await propagateResearchUpdates(null as unknown as ResearchPropagationInput, mkDeps());
    expect(r2.ok).toBe(false);
  });

  it("empty recommendedUpdates ⇒ an empty (not absent) outcome array", async () => {
    const res = await propagateResearchUpdates(baseInput({ recommendedUpdates: [] }), mkDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([]);
  });
});

// ── dormancy pin (L24 discipline) ────────────────────────────────────────────────────

describe("propagateResearchUpdates — dormant (no ungated production importer)", () => {
  it("no_production_caller — every apps/ or workflows/ importer is arming-gated (or none exist yet)", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const importers = scanProductionImporters("propagateResearchUpdates", repoRoot);
    expect(ungatedImporters(importers, "propagateResearchUpdates")).toEqual([]);
  });

  it("dormancy_pin_is_non_vacuous — an ungated importer of THIS symbol would fail the pin", () => {
    const sym = "propagateResearchUpdates";
    const ungated = `import { ${sym} } from "@sow/knowledge";\nawait ${sym}(input, deps);`;
    expect(classifyImporterSource(ungated, sym)).toBe("ungated");
  });
});
