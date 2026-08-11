// spec(§6 KN-10, REQ-F-017) — 13.8c confined synthesis planner, the ⭐ ARC-4 keystone. A PURE,
// dormant SENSE→REASON→EFFECT orchestrator: composes the 13.8a EntityResolver + 13.8b LinkHealer +
// an INJECTED model reason port into 0–2 validated KnowledgeMutationPlans. KN-10 tiered autonomy
// (additive/derived → requiresApproval:false AUTO; human-relevant edit → requiresApproval:true
// PROPOSE — classified DETERMINISTICALLY by the planner, never model-declared); `@user`-region
// confinement (patches only ever target writer-owned regions; a human region is provably never
// emitted); no-inference (REQ-F-017: un-evidenced owner/date → TBD). TOTAL never-throws.
import { describe, it, expect, vi } from "vitest";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ok, err, KnowledgeMutationPlanSchema, EntityRefSchema } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { Result, WorkspaceId, ProvenanceOrigin, KnowledgeMutationPlan } from "@sow/contracts";
import type { EntityCandidate, EntityGbrainReadPort, EntityReadFault, EntityRef, EntityKind } from "../src/synthesis/entity-resolver";
import { rewriteVaultForMeeting } from "../src/synthesis/meeting-rewrite";
// ⚠ Deliberate exception to this package's "import the module under test directly, not the barrel"
// convention (src/index.ts's own header comment) — this file's evals-barrel test (13.19, §DEC-CANDGATE
// leg 2, Trap 1) exists SPECIFICALLY to prove the @sow/knowledge barrel import
// packages/evals/src/synthesis/corpus.ts:20 depends on keeps resolving after the contracts re-point,
// so it imports the barrel path on purpose.
import type { EntityRef as BarrelEntityRef } from "../src/index";
import {
  planSynthesis,
  MAX_MODEL_ENTITY_REFS,
  type SynthesisCandidate,
  type SynthesisInput,
  type SynthesisDeps,
  type SynthesisSectionPort,
  type NoteRegionDescriptor,
  type SynthesisOutcome,
  type SynthesisError,
} from "../src/synthesis/planner";

const WS_A = "ws-a" as WorkspaceId;

// ── fakes ─────────────────────────────────────────────────────────────────────────
const cand = (o: Partial<EntityCandidate> & Pick<EntityCandidate, "path" | "slug">): EntityCandidate => ({ workspaceId: WS_A, ...o });

/** A gbrain read port dispatching resolveEntity candidates by entity name (err ⇒ withheld; [] ⇒ create_stub). */
function fakeGbrain(byName: Record<string, () => Result<readonly EntityCandidate[], EntityReadFault>>): EntityGbrainReadPort {
  return { workspaceId: WS_A, findCandidates: async (ref) => (byName[ref.name] ?? (() => ok([])))() };
}
const gbrainEmpty = fakeGbrain({});

/** A gbrain read port that RECORDS every query, for fan-out/flood-bound assertions (13.8h). */
function fakeGbrainCounting(): EntityGbrainReadPort & { readonly queries: EntityRef[] } {
  const queries: EntityRef[] = [];
  return {
    queries,
    workspaceId: WS_A,
    findCandidates: async (ref) => {
      queries.push(ref);
      return ok([]);
    },
  };
}

/** A section provider backed (at wire time) by parseSections; here a fixed per-note descriptor map. */
function fakeSections(map: Record<string, NoteRegionDescriptor>): SynthesisSectionPort {
  return { describe: (path) => map[path] ?? { generatedRegionIds: [] } };
}

function fakeReason(candidate: SynthesisCandidate | (() => Promise<SynthesisCandidate>)): SynthesisDeps["reason"] {
  return { reason: typeof candidate === "function" ? candidate : async () => candidate };
}

function mkDeps(over: Partial<SynthesisDeps>): SynthesisDeps {
  let n = 0;
  return {
    gbrain: gbrainEmpty,
    reason: fakeReason({}),
    sections: fakeSections({}),
    newPlanId: () => `plan-${++n}`,
    ...over,
  };
}

const baseInput = (over: Partial<SynthesisInput> = {}): SynthesisInput => ({
  workspaceId: WS_A,
  provenanceOrigin: "ingestion" as ProvenanceOrigin,
  sourceRefs: [{ sourceId: "src-1", span: "1-4" }],
  confidence: 0.9,
  linkCandidates: [],
  ...over,
});

const plansOf = (r: Result<SynthesisOutcome, SynthesisError>): readonly KnowledgeMutationPlan[] => (r.ok ? r.value.plans : []);
const auto = (ps: readonly KnowledgeMutationPlan[]): KnowledgeMutationPlan | undefined => ps.find((p) => p.requiresApproval === false);
const propose = (ps: readonly KnowledgeMutationPlan[]): KnowledgeMutationPlan | undefined => ps.find((p) => p.requiresApproval === true);
const allPatches = (ps: readonly KnowledgeMutationPlan[]) => ps.flatMap((p) => p.patches);
const allFm = (ps: readonly KnowledgeMutationPlan[]) => ps.flatMap((p) => p.frontmatterUpdates);
const allCreates = (ps: readonly KnowledgeMutationPlan[]) => ps.flatMap((p) => p.creates);

// ── 1. additive/derived effects → the AUTO plan (requiresApproval:false) — KN-10 ──

describe("planSynthesis — additive/derived effects land AUTO (§6 KN-10 tiered autonomy)", () => {
  it("additive_effects_land_in_auto_plan — new note + new @generated region + faithful heal ⇒ auto plan", async () => {
    const candidate: SynthesisCandidate = {
      regions: [
        { notePath: "synthesis/acme.md", regionId: "summary", body: "Acme synthesis.", effect: "new_note" },
        { notePath: "notes/existing.md", regionId: "fresh-sec", body: "New derived section.", effect: "new_region" },
      ],
      links: { srcPath: "notes/existing.md", refs: [{ title: "Acme API" }] },
    };
    const deps = mkDeps({
      reason: fakeReason(candidate),
      sections: fakeSections({ "notes/existing.md": { generatedRegionIds: ["other"] } }),
    });
    const r = await planSynthesis(baseInput({ linkCandidates: [cand({ path: "projects/acme-api.md", slug: "acme-api", title: "Acme API" })] }), deps);
    const ps = plansOf(r);
    expect(ps).toHaveLength(1);
    expect(auto(ps)?.requiresApproval).toBe(false);
    expect(propose(ps)).toBeUndefined();
    // the create (new note), the new-region patch, and the heal all rode the auto plan
    expect(auto(ps)!.creates).toHaveLength(1);
    expect(auto(ps)!.patches.map((p) => p.regionId)).toEqual(["fresh-sec"]);
    expect(auto(ps)!.linkMutations).toEqual([{ op: "add", srcPath: "notes/existing.md", dstSlug: "acme-api" }]);
  });

  it("generated_region_refresh_lands_in_auto_plan — a REFRESH of an EXISTING @generated region ⇒ auto plan (KN-10 lists refresh AUTO)", async () => {
    const candidate: SynthesisCandidate = {
      regions: [{ notePath: "notes/e.md", regionId: "summary", body: "Refreshed derived content.", effect: "refresh" }],
    };
    const deps = mkDeps({
      reason: fakeReason(candidate),
      sections: fakeSections({ "notes/e.md": { generatedRegionIds: ["summary"] } }),
    });
    const ps = plansOf(await planSynthesis(baseInput(), deps));
    expect(ps).toHaveLength(1);
    expect(auto(ps)?.requiresApproval).toBe(false);
    expect(auto(ps)!.patches).toEqual([{ path: "notes/e.md", regionId: "summary", newBody: "Refreshed derived content." }]);
  });
});

// ── 2. human-relevant edits → the PROPOSE plan (requiresApproval:true) — KN-10 ────

describe("planSynthesis — human-relevant edits land PROPOSE (§6 KN-10)", () => {
  it("human_relevant_edit_lands_in_propose_plan — a status frontmatter flip ⇒ propose plan (requiresApproval:true)", async () => {
    // the PROPOSE tier is carried by FrontmatterPatch (owner/status/date — human-relevant); NotePatches are AUTO
    const candidate: SynthesisCandidate = {
      frontmatter: [{ notePath: "notes/e.md", key: "status", value: "active", evidenceRef: "src-1#s" }],
    };
    const deps = mkDeps({ reason: fakeReason(candidate) });
    const ps = plansOf(await planSynthesis(baseInput(), deps));
    expect(ps).toHaveLength(1);
    expect(propose(ps)?.requiresApproval).toBe(true);
    expect(auto(ps)).toBeUndefined();
    expect(propose(ps)!.frontmatterUpdates).toEqual([{ path: "notes/e.md", key: "status", value: "active" }]);
  });
});

// ── 3. mixed run → TWO plans (additive still auto-applies) — the KN-10 payoff ──────

describe("planSynthesis — a mixed run splits into TWO plans, not one OR'd propose (KN-10 payoff)", () => {
  it("mixed_run_splits_into_two_plans — additive stays auto:false, human-relevant is a separate propose:true", async () => {
    const candidate: SynthesisCandidate = {
      regions: [{ notePath: "synthesis/new.md", regionId: "body", body: "Fresh.", effect: "new_note" }],
      frontmatter: [{ notePath: "notes/e.md", key: "owner", value: "Jane Doe", evidenceRef: "src-1#s" }],
    };
    const deps = mkDeps({ reason: fakeReason(candidate) });
    const ps = plansOf(await planSynthesis(baseInput(), deps));
    expect(ps).toHaveLength(2);
    expect(auto(ps)?.requiresApproval).toBe(false);
    expect(propose(ps)?.requiresApproval).toBe(true);
    // the additive create is NOT OR'd into the propose plan — it auto-applies
    expect(auto(ps)!.creates).toHaveLength(1);
    expect(auto(ps)!.frontmatterUpdates).toEqual([]);
    expect(propose(ps)!.frontmatterUpdates).toHaveLength(1);
  });
});

// ── 4. @user confinement (SAFETY) — a human region is provably never patched ──────

describe("planSynthesis — @user confinement: a human region is NEVER patched (§6 SAFETY)", () => {
  it("user_region_never_patched — ALLOWLIST confinement: only a known @generated region is patched; @user AND any unknown id DROP (fail-closed)", async () => {
    const candidate: SynthesisCandidate = {
      regions: [
        { notePath: "notes/u.md", regionId: "@user", body: "HIJACK the human note", effect: "refresh" }, // reserved sentinel → DROP
        { notePath: "notes/u.md", regionId: "ghost", body: "sneak into an unknown id", effect: "refresh" }, // NOT in generatedRegionIds → fail-closed DROP
        { notePath: "notes/u.md", regionId: "summary", body: "ok to rewrite", effect: "refresh" }, // ∈ generatedRegionIds → patchable
      ],
    };
    const deps = mkDeps({
      reason: fakeReason(candidate),
      sections: fakeSections({ "notes/u.md": { generatedRegionIds: ["summary"] } }),
    });
    const ps = plansOf(await planSynthesis(baseInput(), deps));
    const patches = allPatches(ps);
    // the @user region AND the unrecognized id are provably absent from every emitted patch (allowlist, not denylist)
    expect(patches.some((p) => p.regionId === "@user")).toBe(false);
    expect(patches.some((p) => p.regionId === "ghost")).toBe(false);
    // ONLY the allowlisted writer-owned region is patched
    expect(patches.map((p) => p.regionId)).toEqual(["summary"]);
  });

  it("new_region_colliding_with_existing_id_drops — a 'new_region' whose id ALREADY exists is fail-closed dropped (no relabel bypass)", async () => {
    // relabelling a refresh as new_region must NOT let it hit an existing id — new_region must be provably FRESH
    const candidate: SynthesisCandidate = {
      regions: [{ notePath: "notes/e.md", regionId: "summary", body: "collide via relabel", effect: "new_region" }],
    };
    const deps = mkDeps({ reason: fakeReason(candidate), sections: fakeSections({ "notes/e.md": { generatedRegionIds: ["summary"] } }) });
    expect(allPatches(plansOf(await planSynthesis(baseInput(), deps)))).toEqual([]);
  });

  it("marker_unsafe_region_ids_drop — whitespace / '>' / marker-syntax ids are dropped (no marker injection)", async () => {
    const candidate: SynthesisCandidate = {
      regions: [
        { notePath: "notes/n.md", regionId: "bad id", body: "x", effect: "new_note" }, // whitespace
        { notePath: "notes/n.md", regionId: "evil-->", body: "x", effect: "new_note" }, // '>' / marker syntax
        { notePath: "notes/n.md", regionId: "ok-id", body: "y", effect: "new_note" }, // clean → survives
      ],
    };
    const ps = plansOf(await planSynthesis(baseInput(), mkDeps({ reason: fakeReason(candidate) })));
    // only the marker-safe id produces a create; the injection-shaped ids are dropped
    expect(allCreates(ps)).toHaveLength(1);
  });
});

// ── 5. no-inference (REQ-F-017) — un-evidenced owner/date → TBD, never invented ────

describe("planSynthesis — no-inference: un-evidenced owner/date → TBD, other un-evidenced fields dropped (REQ-F-017)", () => {
  it("no_inference_owner_date_to_TBD — un-evidenced owner ⇒ TBD; evidenced value kept; other un-evidenced field dropped", async () => {
    const candidate: SynthesisCandidate = {
      frontmatter: [
        { notePath: "notes/n.md", key: "owner", value: "Alice" }, // no evidenceRef → owner → TBD
        { notePath: "notes/n.md", key: "dueDate", value: "2026-08-01", evidenceRef: "src-1#s" }, // evidenced → kept
        { notePath: "notes/n.md", key: "priority", value: "p0" }, // un-evidenced non-owner/date → dropped
      ],
    };
    const deps = mkDeps({ reason: fakeReason(candidate) });
    const fm = allFm(plansOf(await planSynthesis(baseInput(), deps)));
    expect(fm.find((p) => p.key === "owner")?.value).toBe(TBD); // coerced, never invented
    expect(fm.some((p) => p.value === "Alice")).toBe(false); // the invented value is NEVER emitted
    expect(fm.find((p) => p.key === "dueDate")?.value).toBe("2026-08-01"); // evidenced value survives
    expect(fm.some((p) => p.key === "priority")).toBe(false); // un-evidenced non-owner/date dropped
  });
});

// ── 6. SENSE grounding — a withheld entity never fabricates a path (L32/WS-8) ─────

describe("planSynthesis — ground-before-write: a withheld entity never fabricates (§6 KN-10, WS-8)", () => {
  it("withheld_entity_never_fabricates — resolveEntity withheld ⇒ no create/patch; create_stub MAY create a stub", async () => {
    const candidate: SynthesisCandidate = {
      entityRefs: [
        { name: "Ghost", kind: "person" }, // gbrain err ⇒ withheld ⇒ NO fabrication
        { name: "NewProj", kind: "project" }, // gbrain [] ⇒ create_stub ⇒ MAY create
      ],
    };
    const deps = mkDeps({
      reason: fakeReason(candidate),
      gbrain: fakeGbrain({
        Ghost: () => err({ code: "read_fault" }),
        NewProj: () => ok([]),
      }),
    });
    const r = await planSynthesis(baseInput(), deps);
    const creates = allCreates(plansOf(r));
    // withheld → nothing fabricated for Ghost; create_stub → a stub note for NewProj (proposedSlug 'newproj')
    expect(creates.some((c) => /ghost/i.test(c.path))).toBe(false);
    expect(creates.some((c) => c.path.includes("newproj"))).toBe(true);
    // 13.8h: an ordinary under-cap run reports NO truncation (positive zero-pin, not just "didn't throw")
    expect(r.ok && r.value.entityRefsTruncated).toBe(0);
  });
});

// ── 7. every emitted KMP passes the candidate-data gate (REQ-F-006, rule 2) ───────

describe("planSynthesis — every emitted KMP passes the candidate-data gate (REQ-F-006)", () => {
  it("every_plan_passes_candidate_gate — ≥1 sourceRef, .strict() parses, confidence∈[0,1], workspaceId set", async () => {
    const candidate: SynthesisCandidate = {
      regions: [{ notePath: "synthesis/n.md", regionId: "b", body: "x", effect: "new_note" }],
      frontmatter: [{ notePath: "notes/n.md", key: "status", value: "done", evidenceRef: "src-1#s" }],
    };
    const ps = plansOf(await planSynthesis(baseInput(), mkDeps({ reason: fakeReason(candidate) })));
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) {
      expect(p.sourceRefs.length).toBeGreaterThanOrEqual(1);
      expect(KnowledgeMutationPlanSchema.safeParse(p).success).toBe(true);
      expect(p.confidence).toBeGreaterThanOrEqual(0);
      expect(p.confidence).toBeLessThanOrEqual(1);
      expect(p.workspaceId).toBe(WS_A);
    }
  });

  it("unusable input (empty sourceRefs — REQ-F-006) ⇒ err(unusable_input), never an unsourced plan", async () => {
    const candidate: SynthesisCandidate = { regions: [{ notePath: "synthesis/n.md", regionId: "b", body: "x", effect: "new_note" }] };
    const r = await planSynthesis(baseInput({ sourceRefs: [] }), mkDeps({ reason: fakeReason(candidate) }));
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe("unusable_input");
  });

  it("an unsourced sourceId (REQ-F-006) ⇒ err(unusable_input), not a silently dropped plan", async () => {
    const candidate: SynthesisCandidate = { regions: [{ notePath: "synthesis/n.md", regionId: "b", body: "x", effect: "new_note" }] };
    const r = await planSynthesis(baseInput({ sourceRefs: [{ sourceId: "" }] }), mkDeps({ reason: fakeReason(candidate) }));
    expect(r.ok ? null : r.error.code).toBe("unusable_input");
  });

  it("a missing/non-finite confidence fails CLOSED to the floor (0), never OPEN to 1", async () => {
    const candidate: SynthesisCandidate = { regions: [{ notePath: "synthesis/n.md", regionId: "b", body: "x", effect: "new_note" }] };
    const r = await planSynthesis(baseInput({ confidence: undefined }), mkDeps({ reason: fakeReason(candidate) }));
    expect(auto(plansOf(r))?.confidence).toBe(0);
  });
});

// ── 8. PURE / TOTAL never-throws — a fault fails safe to empty/partial (Lesson 11) ─

describe("planSynthesis — PURE / TOTAL never-throws; a fault fails safe (Lesson 11)", () => {
  it("malformed_candidate_fails_safe_empty — a throwing reason port ⇒ ok, empty plans, no throw", async () => {
    const deps = mkDeps({
      reason: fakeReason(async () => {
        throw new Error("model boom");
      }),
    });
    // a throw would reject this await and fail the test — the total contract is that it resolves.
    const r = await planSynthesis(baseInput(), deps);
    expect(r.ok).toBe(true);
    expect(plansOf(r)).toEqual([]);
  });

  it("a mis-shaped candidate (garbage arrays / hostile rows) yields a partial-valid or empty set, never throws", async () => {
    const garbage = {
      regions: [null, { notePath: 42, regionId: "x", body: "y", effect: "new_note" }, { notePath: "synthesis/ok.md", regionId: "b", body: "z", effect: "new_note" }],
      frontmatter: "nope",
      entityRefs: [{ name: 42 }],
    } as unknown as SynthesisCandidate;
    const r = await planSynthesis(baseInput(), mkDeps({ reason: fakeReason(garbage) }));
    expect(r.ok).toBe(true);
    // the one well-formed additive create survives; the malformed rows are dropped
    expect(allCreates(plansOf(r)).some((c) => c.path === "synthesis/ok.md")).toBe(true);
  });
});

// ── 9. dormant — no production caller (L24 logic-in-package / wire-at-boot) ────────

describe("planSynthesis — dormant: no PRODUCTION caller (L24 wire-at-boot)", () => {
  it("no_production_caller — planSynthesis has NO apps/ or workflows/ (production) importer; dormant/eval consumers are allowed", () => {
    // planSynthesis is legitimately consumed by DORMANT/eval callers — the 13.8d knowledge ingest-rewrite
    // (synthesis/ingest-rewrite.ts, itself dormant) and the 13.8c-eval scorer (packages/evals). The
    // dormancy that matters is that it is NOT wired into a PRODUCTION entry — no apps/ or workflows/ caller.
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    let out = "";
    try {
      out = execSync("grep -rn 'planSynthesis' packages apps --include='*.ts' || true", { cwd: repoRoot, encoding: "utf8" });
    } catch {
      out = "";
    }
    const offenders = out
      .split("\n")
      .filter(Boolean)
      .filter((l) => !l.includes(".test.ts") && !l.includes("/test/"))
      // a PRODUCTION importer lives under apps/ or packages/workflows/ (the runtime/orchestration layers)
      .filter((l) => /^(apps|packages\/workflows)\//.test(l));
    expect(offenders).toEqual([]);
  });
});

// ── 13.8j — the SOURCE path carries the same stub-minting defect (§6 KN-12) ────────
//
// The finding was reported against meeting-rewrite.ts, but planner.ts minted stubs at the vault
// root independently — so the SOURCE-ingestion path (bound dormant by 13.8d 172f9aed) carried it
// too. Both consumers now inherit the namespace from the ONE shared derivation.

describe("planSynthesis — entity stubs are namespaced, never a root structural surface (13.8j)", () => {
  it("structural_surface_names_cannot_be_minted__source — Index/Log/README stub under their kind", async () => {
    const candidate: SynthesisCandidate = {
      entityRefs: [
        { name: "Index", kind: "person" },
        { name: "Log", kind: "project" },
        { name: "README", kind: "concept" },
      ],
    };
    const r = await planSynthesis(baseInput(), mkDeps({ gbrain: gbrainEmpty, reason: fakeReason(candidate) }));
    expect(r.ok).toBe(true);
    const created = (r.ok ? r.value.plans : []).flatMap((p) => p.creates).map((c) => c.path);
    expect(created.length).toBe(3); // non-vacuous: the stubs are really minted
    for (const forbidden of ["index.md", "log.md", "readme.md", "README.md"]) {
      expect(created, `source path minted a structural surface: ${forbidden}`).not.toContain(forbidden);
    }
    expect(created.sort()).toEqual(["concepts/readme.md", "people/index.md", "projects/log.md"]);
  });

  it("stub_paths_are_namespaced — the ordinary case carries the prefix (positive pin)", async () => {
    const candidate: SynthesisCandidate = { entityRefs: [{ name: "New Person", kind: "person" }] };
    const r = await planSynthesis(baseInput(), mkDeps({ gbrain: gbrainEmpty, reason: fakeReason(candidate) }));
    const created = (r.ok ? r.value.plans : []).flatMap((p) => p.creates).map((c) => c.path);
    expect(created).toEqual(["people/new-person.md"]);
  });
});

// ── 13.8h — the MODEL-supplied entityRefs fan-out is capped (unbounded-read vector) ────
//
// `collectEntities` awaits ONE GBrain read per `candidate.entityRefs` element — a degenerate REASON
// output otherwise drives an unbounded sequential read loop. `MAX_MODEL_ENTITY_REFS` is deliberately
// INDEPENDENT of meeting-rewrite.ts's `MAX_ENTITY_REFS`: that constant bounds a DETERMINISTIC input the
// meeting path owns; this one bounds ADVERSARIAL MODEL OUTPUT — coupling them would let a future tuning
// of one silently retune the other's threat model.

describe("planSynthesis — the MODEL-supplied entityRefs fan-out is capped (13.8h, unbounded-read vector)", () => {
  it("entity_refs_over_cap_are_never_resolved — the gbrain read is called AT MOST MAX_MODEL_ENTITY_REFS times", async () => {
    const many: EntityRef[] = Array.from({ length: 250 }, (_, i) => ({ name: `entity-${i}`, kind: "person" as const }));
    const port = fakeGbrainCounting();
    await planSynthesis(baseInput(), mkDeps({ gbrain: port, reason: fakeReason({ entityRefs: many }) }));
    // exact, not `toBeLessThan` — a loosened cap must fail this, not slip through
    expect(port.queries.length).toBe(MAX_MODEL_ENTITY_REFS);
  });

  it("entity_refs_truncated_reports_the_drop_count — 250 supplied, cap 200 ⇒ entityRefsTruncated === 50", async () => {
    const many: EntityRef[] = Array.from({ length: 250 }, (_, i) => ({ name: `entity-${i}`, kind: "person" as const }));
    const r = await planSynthesis(baseInput(), mkDeps({ gbrain: fakeGbrainCounting(), reason: fakeReason({ entityRefs: many }) }));
    expect(r.ok && r.value.entityRefsTruncated).toBe(250 - MAX_MODEL_ENTITY_REFS);
  });

  it("entity_refs_at_or_under_cap_report_zero_truncated — a boundary run and a small run both report 0 (positive zero-pin)", async () => {
    const atCap: EntityRef[] = Array.from({ length: MAX_MODEL_ENTITY_REFS }, (_, i) => ({ name: `entity-${i}`, kind: "person" as const }));
    const rAtCap = await planSynthesis(baseInput(), mkDeps({ gbrain: fakeGbrainCounting(), reason: fakeReason({ entityRefs: atCap }) }));
    expect(rAtCap.ok && rAtCap.value.entityRefsTruncated).toBe(0);

    const small: EntityRef[] = [{ name: "Solo", kind: "person" }];
    const rSmall = await planSynthesis(baseInput(), mkDeps({ gbrain: fakeGbrainCounting(), reason: fakeReason({ entityRefs: small }) }));
    expect(rSmall.ok && rSmall.value.entityRefsTruncated).toBe(0);
  });

  it("entity_refs_truncation_is_head_first_and_deterministic — the FIRST MAX_MODEL_ENTITY_REFS refs survive, never an arbitrary subset", async () => {
    // guard against a vacuous pass: an undefined/0 cap would make both loops below no-op to green.
    expect(MAX_MODEL_ENTITY_REFS).toBeGreaterThan(0);
    const many: EntityRef[] = Array.from({ length: 250 }, (_, i) => ({ name: `entity-${i}`, kind: "person" as const }));
    const port = fakeGbrainCounting();
    await planSynthesis(baseInput(), mkDeps({ gbrain: port, reason: fakeReason({ entityRefs: many }) }));
    const queriedNames = port.queries.map((q) => q.name);
    for (let i = 0; i < MAX_MODEL_ENTITY_REFS; i++) expect(queriedNames).toContain(`entity-${i}`);
    for (let i = MAX_MODEL_ENTITY_REFS; i < 250; i++) expect(queriedNames).not.toContain(`entity-${i}`);
  });

  it("entity_refs_truncated_count_survives_a_later_fault — a throwing newPlanId aborts assembly AFTER truncation is computed", async () => {
    const many: EntityRef[] = Array.from({ length: 250 }, (_, i) => ({ name: `entity-${i}`, kind: "person" as const }));
    const deps = mkDeps({
      gbrain: fakeGbrainCounting(),
      reason: fakeReason({ entityRefs: many }),
      newPlanId: () => {
        throw new Error("boom");
      },
    });
    const r = await planSynthesis(baseInput(), deps);
    expect(r.ok).toBe(true); // TOTAL — the fault fails safe
    expect(r.ok && r.value.entityRefsTruncated).toBe(250 - MAX_MODEL_ENTITY_REFS); // NOT reset to 0 by the later fault
    expect(r.ok && r.value.plans).toEqual([]); // the assembly fault does lose the plans — that part's expected
  });
});

// ── 13.19 — §DEC-CANDGATE leg 2: EntityRefSchema gates model-supplied entityRefs (REQ-S-006) ──
//
// Leg 1 (contracts, 93ebeabd) shipped EntityRefSchema with NO CALLER. This is the caller: a
// malformed model-supplied ref (bad `kind`, blank/non-string `name`, a smuggled extra key) must
// never reach `resolveEntity`/`stubNotePathFor` — and because a poisoned-row attack must never be
// byte-identical to a benign empty run (13.8m), a rejection is COUNTED and surfaced on
// `SynthesisOutcome`, deliberately independent of `entityRefsTruncated` (over-cap vs.
// malformed-shape are different failure classes — L88's discipline about independent caps, applied
// to independent counts).

describe("planSynthesis — EntityRefSchema gates model-supplied entityRefs at the boundary (§DEC-CANDGATE leg 2, REQ-S-006)", () => {
  it("malformed_entity_ref_is_rejected_at_the_boundary — bad kind / blank name / non-string name / a smuggled key never reach resolveEntity", async () => {
    const port = fakeGbrainCounting();
    const candidate = {
      entityRefs: [
        { name: "Acme", kind: "organization" }, // outside the EntityKind union
        { name: "", kind: "person" }, // blank name
        { name: 42, kind: "person" }, // non-string name
        { name: "Evil", kind: "person", path: "index.md" }, // smuggled extra key — `.strict()` rejects
      ],
    } as unknown as SynthesisCandidate;
    const r = await planSynthesis(baseInput(), mkDeps({ gbrain: port, reason: fakeReason(candidate) }));
    expect(r.ok).toBe(true);
    expect(port.queries.length).toBe(0); // NONE of the four malformed refs ever reached resolveEntity
    expect(r.ok && r.value.entityRefsRejected).toBe(4);
  });

  it("a_rejected_ref_is_surfaced_not_silently_dropped — one poisoned ref among valid ones is counted, distinguishable from a benign empty run", async () => {
    const candidate: SynthesisCandidate = {
      entityRefs: [
        { name: "Valid Person", kind: "person" },
        { name: "Evil", kind: "__proto__" as unknown as EntityKind }, // hostile kind — prototype-chain probe (L65)
      ],
    };
    const r = await planSynthesis(baseInput(), mkDeps({ gbrain: gbrainEmpty, reason: fakeReason(candidate) }));
    expect(r.ok && r.value.entityRefsRejected).toBe(1); // the poisoned ref is counted, not silently dropped

    // a benign run with NO entityRefs at all reports 0 — the two runs are NOT byte-identical (13.8m)
    const benign = await planSynthesis(baseInput(), mkDeps({ gbrain: gbrainEmpty, reason: fakeReason({}) }));
    expect(benign.ok && benign.value.entityRefsRejected).toBe(0);
  });

  it("valid_refs_still_resolve_unchanged — a person/project/concept ref each still resolves through the gate (non-vacuity)", async () => {
    const candidate: SynthesisCandidate = {
      entityRefs: [
        { name: "A Person", kind: "person" },
        { name: "A Project", kind: "project" },
        { name: "A Concept", kind: "concept" },
      ],
    };
    const r = await planSynthesis(baseInput(), mkDeps({ gbrain: gbrainEmpty, reason: fakeReason(candidate) }));
    expect(r.ok && r.value.entityRefsRejected).toBe(0); // nothing legitimate is rejected
    const created = (r.ok ? r.value.plans : []).flatMap((p) => p.creates).map((c) => c.path);
    expect(created.sort()).toEqual(["concepts/a-concept.md", "people/a-person.md", "projects/a-project.md"]);
  });

  it("the_fan_out_cap_still_applies_after_validation — the 13.8h cap and the new schema gate don't double-count or bypass each other", async () => {
    const many: EntityRef[] = Array.from({ length: 250 }, (_, i) => ({ name: `entity-${i}`, kind: "person" as const }));
    const port = fakeGbrainCounting();
    const r = await planSynthesis(baseInput(), mkDeps({ gbrain: port, reason: fakeReason({ entityRefs: many }) }));
    expect(port.queries.length).toBe(MAX_MODEL_ENTITY_REFS); // the cap is unchanged by validation
    expect(r.ok && r.value.entityRefsTruncated).toBe(250 - MAX_MODEL_ENTITY_REFS);
    expect(r.ok && r.value.entityRefsRejected).toBe(0); // all 250 are well-formed — the cap alone explains the drop
  });

  it("truncation_and_rejection_are_independently_reported_in_the_same_run — cap and gate operate on DISJOINT populations, never double-counted", async () => {
    // CAP-THEN-VALIDATE (final Step 2.5 ruling — bounds parse+read work to ONE constant and leaves
    // 13.8h's cap byte-identical): the raw array is sliced to MAX_MODEL_ENTITY_REFS BY POSITION first,
    // then only the capped subset is validated. So a ref beyond position 200 is truncated and NEVER
    // inspected by the schema at all — it cannot also be "rejected" — while a malformed ref AT a
    // position < 200 is rejected and never counts toward truncation. 3 malformed refs sit WITHIN the
    // cap (positions 5/60/199); 50 more refs sit BEYOND it (200-249) and are truncated regardless of
    // their own shape.
    const refs = Array.from({ length: 250 }, (_, i) =>
      i === 5 || i === 60 || i === 199 ? { name: `entity-${i}`, kind: "organization" } : { name: `entity-${i}`, kind: "person" },
    );
    const port = fakeGbrainCounting();
    const r = await planSynthesis(
      baseInput(),
      mkDeps({ gbrain: port, reason: fakeReason({ entityRefs: refs } as unknown as SynthesisCandidate) }),
    );
    expect(r.ok && r.value.entityRefsTruncated).toBe(250 - MAX_MODEL_ENTITY_REFS); // 50 — cap-only, positions ≥200
    expect(r.ok && r.value.entityRefsRejected).toBe(3); // the 3 malformed refs INSIDE the cap
    expect(port.queries.length).toBe(MAX_MODEL_ENTITY_REFS - 3); // 197 real resolveEntity calls — capped minus rejected
  });

  it("a_front_loaded_malformed_array_can_starve_valid_refs — an ACCEPTED cap-then-validate trade-off, pinned so it can't drift silently", async () => {
    // Cap-then-validate bounds parse+read work to ONE constant and leaves the 13.8h cap byte-identical
    // — but the cap is POSITIONAL, so it has a named, ACCEPTED cost: a degenerate model output
    // front-loaded with malformed refs can crowd out legitimate ones. 200 malformed refs (positions
    // 0-199) followed by 50 VALID refs (200-249): the 200 malformed refs consume the ENTIRE cap and are
    // all rejected; the 50 valid refs are truncated away and NEVER resolved (queries===0). Nothing
    // false is ever written (a suppressed ref writes nothing) — this degrades completeness, not
    // correctness — but the degradation is real and must be visible here, not rediscovered later.
    const malformedFirst = Array.from({ length: 200 }, (_, i) => ({ name: `bad-${i}`, kind: "organization" }));
    const validAfter = Array.from({ length: 50 }, (_, i) => ({ name: `entity-${i}`, kind: "person" as const }));
    const refs = [...malformedFirst, ...validAfter];
    const port = fakeGbrainCounting();
    const r = await planSynthesis(
      baseInput(),
      mkDeps({ gbrain: port, reason: fakeReason({ entityRefs: refs } as unknown as SynthesisCandidate) }),
    );
    expect(r.ok && r.value.entityRefsRejected).toBe(200); // the entire cap was spent on malformed refs
    expect(r.ok && r.value.entityRefsTruncated).toBe(50); // the 50 valid refs never even reach validation
    expect(port.queries.length).toBe(0); // starved — none of the 50 legitimate refs are ever resolved
  });

  it("a_malformed_ref_beyond_the_cap_is_absorbed_into_truncated_not_rejected — the disjoint partition holds AT the cap boundary", async () => {
    // The complementary case to the starvation test above: here the malformed refs sit BEYOND position
    // 200, not within it. Cap-then-validate means they are sliced away BY POSITION before validation
    // ever runs — so they are silently absorbed into `entityRefsTruncated` (never individually examined,
    // never separately flagged) rather than counted as `entityRefsRejected`. This is the correct,
    // ACCEPTED behavior under the ruling (not the poisoned-run-byte-identical-to-benign shape 13.8m
    // describes — the signal exists, it just says "unexamined" rather than "malformed", and a ref past
    // the cap can never reach resolveEntity, so it cannot poison anything).
    const valid = Array.from({ length: 200 }, (_, i) => ({ name: `entity-${i}`, kind: "person" as const }));
    const malformedBeyondCap = Array.from({ length: 10 }, (_, i) => ({ name: `bad-${i}`, kind: "organization" }));
    const refs = [...valid, ...malformedBeyondCap];
    const port = fakeGbrainCounting();
    const r = await planSynthesis(
      baseInput(),
      mkDeps({ gbrain: port, reason: fakeReason({ entityRefs: refs } as unknown as SynthesisCandidate) }),
    );
    expect(r.ok && r.value.entityRefsRejected).toBe(0); // never inspected — the schema never sees them
    expect(r.ok && r.value.entityRefsTruncated).toBe(10); // absorbed here instead
    expect(port.queries.length).toBe(200); // the 200 valid refs at the front are unaffected
  });

  it("validation_runs_once_at_the_boundary_not_per_consumer — the schema is invoked exactly once per considered ref, never multiplied", async () => {
    const spy = vi.spyOn(EntityRefSchema, "safeParse");
    const candidate: SynthesisCandidate = {
      entityRefs: [
        { name: "One", kind: "person" },
        { name: "Two", kind: "project" },
        { name: "Three", kind: "concept" },
      ],
    };
    await planSynthesis(baseInput(), mkDeps({ gbrain: gbrainEmpty, reason: fakeReason(candidate) }));
    // bounded by the ref count — a per-consumer gate (e.g. also inside resolveEntity) would double this
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it("evals_barrel_import_still_resolves — EntityRef imported via the @sow/knowledge barrel (as packages/evals/src/synthesis/corpus.ts:20 does) is the contracts type and still round-trips", async () => {
    const ref: BarrelEntityRef = { name: "Barrel Co", kind: "project" };
    const r = await planSynthesis(baseInput(), mkDeps({ gbrain: gbrainEmpty, reason: fakeReason({ entityRefs: [ref] }) }));
    const created = (r.ok ? r.value.plans : []).flatMap((p) => p.creates).map((c) => c.path);
    expect(created).toEqual(["projects/barrel-co.md"]);
    expect(r.ok && r.value.entityRefsRejected).toBe(0);
  });
});

// ── 13.23 leg A — resolveEntity's WithheldReason reaches SynthesisOutcome as a per-code count ──
//
// resolveEntity ALREADY produces a WithheldReason on every withhold (entity-resolver.ts:89-100) and
// every one was discarded. This mirrors the entityRefsTruncated/entityRefsRejected channel already
// established above: a SPARSE per-code count map (never a single merged count — ws_scope_mismatch,
// the WS-8 signal, must stay individually distinguishable), hoisted above the try exactly like its
// siblings, produced by the SAME generic accumulator so a GroundedPathRefusal member (composed, never
// re-declared here) flows through without this slice naming it. ISOLATION HOLDS in every case below —
// resolveEntity still withholds correctly; only the SIGNAL that it did is new. DORMANT: leg B (worker)
// is the consumer (System Health via deps.health.surface); nothing reads this map yet.

const WS_B = "ws-b" as WorkspaceId;

describe("planSynthesis — a withheld WithheldReason reaches SynthesisOutcome as a per-code count (13.23 leg A)", () => {
  it("withheld_ws_scope_mismatch_reaches_the_outcome_as_a_per_code_count — the WS-8 signal is individually distinguishable", async () => {
    const port: EntityGbrainReadPort = { workspaceId: WS_B, findCandidates: async () => ok([]) }; // bound to a DIFFERENT ws than input
    const candidate: SynthesisCandidate = { entityRefs: [{ name: "Jane Doe", kind: "person" }] };
    const r = await planSynthesis(baseInput(), mkDeps({ gbrain: port, reason: fakeReason(candidate) }));
    expect(r.ok && r.value.entityRefsWithheldByReason).toEqual({ ws_scope_mismatch: 1 });
  });

  it("a_benign_run_yields_zero_withheld_signals_across_every_code — non-vacuity partner of the test above", async () => {
    const candidate: SynthesisCandidate = { entityRefs: [{ name: "Jane Doe", kind: "person" }] }; // resolves via create_stub, never withheld
    const r = await planSynthesis(baseInput(), mkDeps({ gbrain: gbrainEmpty, reason: fakeReason(candidate) }));
    expect(r.ok && r.value.entityRefsWithheldByReason).toEqual({});
  });

  it("mixed_withheld_reasons_are_counted_per_code_not_merged — two distinct codes, one repeated ⇒ disjoint per-code counts", async () => {
    const port = fakeGbrain({
      "Ghost One": () => err({ code: "read_fault" }), // gbrain_unavailable
      "Ghost Two": () => err({ code: "read_fault" }), // gbrain_unavailable, again
      "Jane Doe": () =>
        ok([
          cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe" }),
          cand({ path: "people/jane-doe-2.md", slug: "jane-doe-2", title: "Jane Doe" }),
        ]), // ambiguous
    });
    const candidate: SynthesisCandidate = {
      entityRefs: [
        { name: "Ghost One", kind: "person" },
        { name: "Ghost Two", kind: "person" },
        { name: "Jane Doe", kind: "person" },
      ],
    };
    const r = await planSynthesis(baseInput(), mkDeps({ gbrain: port, reason: fakeReason(candidate) }));
    expect(r.ok && r.value.entityRefsWithheldByReason).toEqual({ gbrain_unavailable: 2, ambiguous: 1 }); // never merged into one number
  });

  it("withheld_counts_survive_a_later_fault — a throwing newPlanId aborts assembly AFTER withheld reasons are computed (mirrors 13.8h's pin)", async () => {
    const port = fakeGbrain({ Ghost: () => err({ code: "read_fault" }) }); // "Stub Me" defaults to ok([]) ⇒ create_stub, keeping autoM non-empty
    const candidate: SynthesisCandidate = {
      entityRefs: [
        { name: "Ghost", kind: "person" },
        { name: "Stub Me", kind: "person" },
      ],
    };
    const deps = mkDeps({
      gbrain: port,
      reason: fakeReason(candidate),
      newPlanId: () => {
        throw new Error("boom");
      },
    });
    const r = await planSynthesis(baseInput(), deps);
    expect(r.ok).toBe(true); // TOTAL — the fault fails safe
    expect(r.ok && r.value.entityRefsWithheldByReason).toEqual({ gbrain_unavailable: 1 }); // NOT reset by the later fault
    expect(r.ok && r.value.plans).toEqual([]); // the assembly fault does lose the plans — same as its sibling counters
  });

  it("a_groundedpathrefusal_member_flows_through_without_this_slice_naming_it — pins composition (criterion 3)", async () => {
    // A faithful title over a KnowledgeWriter-owned structural surface (13.8k) — resolveEntity's OWN
    // admitGroundedPath call withholds "structural_surface", a member of the COMPOSED GroundedPathRefusal
    // union. Nothing in planner.ts's accumulator names this code; it flows through the SAME generic
    // `withheld[res.reason]++` path as every other member, present or future.
    const port: EntityGbrainReadPort = {
      workspaceId: WS_A,
      findCandidates: async () => ok([cand({ path: "index.md", slug: "jane-doe", title: "Jane Doe" })]),
    };
    const candidate: SynthesisCandidate = { entityRefs: [{ name: "Jane Doe", kind: "person" }] };
    const r = await planSynthesis(baseInput(), mkDeps({ gbrain: port, reason: fakeReason(candidate) }));
    expect(r.ok && r.value.entityRefsWithheldByReason).toEqual({ structural_surface: 1 });
  });

  it("rule_7_the_channel_cannot_carry_a_free_string_by_construction — compile-level proof, not a runtime scan", () => {
    // WithheldReason is a closed literal union, so `entityRefsWithheldByReason`'s KEY TYPE rejects any
    // key outside it via excess-property checking — a caller cannot smuggle an entity name/path/slug
    // through this channel even at the type level. Verified by `pnpm typecheck` (an unused
    // `@ts-expect-error` is itself a type error, L87) — a runtime scan cannot prove a channel that only
    // ever holds compile-time-known literals.
    // @ts-expect-error — "some_entity_name_or_path" is not a member of WithheldReason.
    const illegal: SynthesisOutcome["entityRefsWithheldByReason"] = { some_entity_name_or_path: 1 };
    void illegal;
  });

  it("the_meeting_rewrite_direct_call_site_does_NOT_flow_through_this_channel — leg C (tracked separately) closes this", async () => {
    // `rewriteVaultForMeeting`'s own per-ref loop (input.entityRefs/identifierOnlyRefs, admitInto) is a
    // SEPARATE resolveEntity call site from `collectEntities` — the latter only ever sees the MODEL
    // REASON port's OWN candidate.entityRefs. ⚠ ws_scope_mismatch itself cannot demonstrate this here:
    // rewriteVaultForMeeting gates deps.gbrain.workspaceId===input.workspaceId ONCE, before the per-ref
    // loop even starts (meeting-rewrite.ts:190) — a mismatched port short-circuits to an empty receipt
    // instead of ever reaching resolveEntity, so ws_scope_mismatch is structurally UNREACHABLE on this
    // path specifically. "ambiguous" (reachable here, and — like ws_scope_mismatch — NOT a
    // GroundedPathRefusal member, so `refusals` never captures it either) demonstrates the identical
    // gap: any withhold reason on this direct loop is invisible to `entityRefsWithheldByReason`.
    const port: EntityGbrainReadPort = {
      workspaceId: WS_A,
      findCandidates: async () =>
        ok([
          cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe" }),
          cand({ path: "people/jane-doe-2.md", slug: "jane-doe-2", title: "Jane Doe" }),
        ]),
    };
    const receipt = await rewriteVaultForMeeting(
      {
        workspaceId: WS_A,
        provenanceOrigin: "ingestion" as ProvenanceOrigin,
        meetingNotePath: "meetings/standup.md",
        sourceRefs: [{ sourceId: "src-1" }],
        entityRefs: [{ name: "Jane Doe", kind: "person" }], // withholds "ambiguous" on the DIRECT loop
      },
      {
        gbrain: port,
        reason: fakeReason({}), // no candidate.entityRefs ⇒ collectEntities never runs — nothing to confound the result
        sections: fakeSections({}),
        newPlanId: () => "plan-1",
        newRunId: () => "run-1",
      },
    );
    expect(receipt.groundedPaths).toEqual([]); // the withhold produced no path (only the meeting note's own audit:false seed applies)
    expect(receipt.refusals).toEqual([]); // "ambiguous" is not a GroundedPathRefusal member — invisible here too
    // MeetingRewriteReceipt structurally carries no such channel — meeting-rewrite.ts discards planSynthesis's
    // own entityRefsWithheldByReason (computed for candidate.entityRefs, never input.entityRefs) down to `.plans`.
    expect(Object.prototype.hasOwnProperty.call(receipt, "entityRefsWithheldByReason")).toBe(false);
  });
});
