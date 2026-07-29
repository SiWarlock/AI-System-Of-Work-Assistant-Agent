// spec(§6 KN-10, REQ-F-017) — 13.8c confined synthesis planner, the ⭐ ARC-4 keystone. A PURE,
// dormant SENSE→REASON→EFFECT orchestrator: composes the 13.8a EntityResolver + 13.8b LinkHealer +
// an INJECTED model reason port into 0–2 validated KnowledgeMutationPlans. KN-10 tiered autonomy
// (additive/derived → requiresApproval:false AUTO; human-relevant edit → requiresApproval:true
// PROPOSE — classified DETERMINISTICALLY by the planner, never model-declared); `@user`-region
// confinement (patches only ever target writer-owned regions; a human region is provably never
// emitted); no-inference (REQ-F-017: un-evidenced owner/date → TBD). TOTAL never-throws.
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ok, err, KnowledgeMutationPlanSchema } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { Result, WorkspaceId, ProvenanceOrigin, KnowledgeMutationPlan } from "@sow/contracts";
import type { EntityCandidate, EntityGbrainReadPort, EntityReadFault, EntityRef } from "../src/synthesis/entity-resolver";
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
