// spec(§9 workflow-1 L297, §6 KN-10/KN-11, §5 WS-8, REQ-F-017) — 13.8f-A meeting-path living-vault
// synthesis: `rewriteVaultForMeeting` turns a meeting closeout into entity-grounded person/project page
// mutations. It is the SOURCE path's sibling (`rewriteVaultForSource`) with ONE deliberate extra gate:
// GROUND-BEFORE-WRITE is enforced at THIS layer — only a target the 13.8a EntityResolver actually
// grounded (resolved path / create-stub) or the meeting note itself may be written. PURE over injected
// ports; TOTAL never-throws; DORMANT (the worker threads it in as 13.8f-B).
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ok, err, workspaceId } from "@sow/contracts";
import type { Result, WorkspaceId, ProvenanceOrigin } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { EntityCandidate, EntityGbrainReadPort, EntityReadFault, EntityRef } from "../src/synthesis/entity-resolver";
import type { SynthesisCandidate, SynthesisSectionPort, NoteRegionDescriptor } from "../src/synthesis/planner";
import type { GroundedPathRefusal } from "../src/synthesis/grounded-path";
import {
  rewriteVaultForMeeting,
  MAX_ENTITY_REFS,
  type MeetingRewriteInput,
  type MeetingRewriteDeps,
  type MeetingRewriteReceipt,
} from "../src/synthesis/meeting-rewrite";
import { classifyImporterSource, scanProductionImporters, ungatedImporters } from "./support/dormancy-pin";

// 24.92: real branded constructors, not anonymous casts.
const WS_A = workspaceId("ws-a");
const WS_B = workspaceId("ws-b");
const MEETING = "meetings/2026-07-26-standup.md";

const cand = (o: Partial<EntityCandidate> & Pick<EntityCandidate, "path" | "slug">): EntityCandidate => ({ workspaceId: WS_A, ...o });

/** A workspace-scoped fake GBrain read port that RECORDS every query (WS-8 + flood-bound assertions). */
function fakeGbrain(
  byName: Record<string, () => Result<readonly EntityCandidate[], EntityReadFault>>,
  opts: { readonly workspaceId?: WorkspaceId; readonly onQuery?: (ref: EntityRef) => void } = {},
): EntityGbrainReadPort & { readonly queries: EntityRef[] } {
  const queries: EntityRef[] = [];
  return {
    queries,
    workspaceId: opts.workspaceId ?? WS_A,
    findCandidates: async (ref) => {
      queries.push(ref);
      opts.onQuery?.(ref);
      return (byName[ref.name] ?? (() => ok([])))();
    },
  };
}
function fakeSections(map: Record<string, NoteRegionDescriptor>): SynthesisSectionPort {
  return { describe: (p) => map[p] ?? { generatedRegionIds: [] } };
}
function fakeReason(c: SynthesisCandidate | (() => Promise<SynthesisCandidate>)): MeetingRewriteDeps["reason"] {
  return { reason: typeof c === "function" ? c : async () => c };
}
function mkDeps(over: Partial<MeetingRewriteDeps> = {}): MeetingRewriteDeps {
  let n = 0;
  let r = 0;
  return {
    gbrain: fakeGbrain({}),
    reason: fakeReason({}),
    sections: fakeSections({}),
    newPlanId: () => `plan-${++n}`,
    newRunId: () => `run-${++r}`,
    ...over,
  };
}
const baseInput = (over: Partial<MeetingRewriteInput> = {}): MeetingRewriteInput => ({
  workspaceId: WS_A,
  provenanceOrigin: "meeting_close" as ProvenanceOrigin,
  meetingNotePath: MEETING,
  sourceRefs: [{ sourceId: "meeting-1", span: "1-4" }],
  confidence: 0.9,
  ...over,
});

// The canonical "Acme API project page exists" grounding fixture.
const ACME = cand({ path: "projects/acme-api.md", slug: "acme-api", title: "Acme API" });
const groundAcme = { "Acme API": () => ok([ACME]) };
const acmeRef: EntityRef = { name: "Acme API", kind: "project" };

const allPatches = (r: { plans: readonly { patches: readonly { path: string; regionId: string }[] }[] }) =>
  r.plans.flatMap((p) => p.patches);

// ── 1. ground-before-write — the meeting path's extra gate (§6 KN-10 / 13.8a) ────────

describe("rewriteVaultForMeeting — every target is entity-grounded (§6 KN-10, 13.8a)", () => {
  it("grounds_every_target_via_resolver — a target the resolver never returned is DROPPED", async () => {
    const candidate: SynthesisCandidate = {
      regions: [
        { notePath: "projects/acme-api.md", regionId: "meetings", body: "Discussed rollout.", effect: "new_region" },
        { notePath: "people/ghost.md", regionId: "meetings", body: "invented target", effect: "new_region" },
      ],
    };
    const receipt = await rewriteVaultForMeeting(
      baseInput({ entityRefs: [acmeRef] }),
      mkDeps({ gbrain: fakeGbrain(groundAcme), reason: fakeReason(candidate) }),
    );
    const paths = allPatches(receipt).map((p) => p.path);
    expect(paths).toContain("projects/acme-api.md"); // grounded ⇒ survives
    expect(paths).not.toContain("people/ghost.md"); // never grounded ⇒ no fabricated file reference
    expect(receipt.groundedPaths).toEqual(["projects/acme-api.md"]); // the grounding decision is auditable
  });

  it("grounds_creates_and_frontmatter_too — the gate covers ALL THREE effect kinds, not just patches", async () => {
    // `new_note` is the sharpest fabrication vector: it would CREATE the invented file outright.
    const candidate: SynthesisCandidate = {
      regions: [{ notePath: "people/ghost.md", regionId: "body", body: "invented", effect: "new_note" }],
      frontmatter: [{ notePath: "people/ghost.md", key: "status", value: "active", evidenceRef: "meeting-1#s" }],
    };
    const receipt = await rewriteVaultForMeeting(
      baseInput({ entityRefs: [acmeRef] }),
      mkDeps({ gbrain: fakeGbrain(groundAcme), reason: fakeReason(candidate) }),
    );
    expect(receipt.plans.flatMap((p) => p.creates).some((c) => c.path === "people/ghost.md")).toBe(false);
    expect(receipt.plans.flatMap((p) => p.frontmatterUpdates).some((f) => f.path === "people/ghost.md")).toBe(false);
  });

  it("malformed_entityRef_does_not_abort_the_run — one bad ref costs only itself (per-element fail-safe)", async () => {
    const candidate: SynthesisCandidate = {
      regions: [{ notePath: "projects/acme-api.md", regionId: "meetings", body: "x", effect: "new_region" }],
    };
    const receipt = await rewriteVaultForMeeting(
      // a null ref sits BETWEEN two good ones — resolveEntity reads `.name` before its own try opens
      baseInput({ entityRefs: [acmeRef, null as unknown as EntityRef, { name: "New Person", kind: "person" }] }),
      mkDeps({ gbrain: fakeGbrain(groundAcme), reason: fakeReason(candidate) }),
    );
    expect(receipt.groundedPaths).toContain("projects/acme-api.md"); // the good ref before it survived
    expect(receipt.groundedPaths).toContain("people/new-person.md"); // and the good ref AFTER it still ran
    expect(allPatches(receipt).some((p) => p.path === "projects/acme-api.md")).toBe(true);
  });

  it("unresolved_candidate_stubs_never_fabricates — create_stub grounds a stub path; a withheld entity writes NOTHING", async () => {
    const ambiguous = [cand({ path: "a/dup.md", slug: "dup", title: "Dup Name" }), cand({ path: "b/dup.md", slug: "dup2", title: "Dup Name" })];
    const deps = mkDeps({
      gbrain: fakeGbrain({ "Dup Name": () => ok(ambiguous) }), // "New Person" ⇒ [] ⇒ create_stub
      reason: fakeReason({
        regions: [
          // the model writes to the page grounding created for this entity (13.8j: namespaced)
          { notePath: "people/new-person.md", regionId: "meetings", body: "attended", effect: "new_region" },
          { notePath: "a/dup.md", regionId: "meetings", body: "guessed", effect: "new_region" },
        ],
      }),
    });
    const receipt = await rewriteVaultForMeeting(
      baseInput({ entityRefs: [{ name: "New Person", kind: "person" }, { name: "Dup Name", kind: "person" }] }),
      deps,
    );
    // the create-stub path is grounded — a stub note is created, and writes to it are allowed
    expect(receipt.plans.flatMap((p) => p.creates).some((c) => c.path === "people/new-person.md")).toBe(true);
    expect(allPatches(receipt).some((p) => p.path === "people/new-person.md")).toBe(true);
    // the AMBIGUOUS entity was withheld — nothing may target the note the resolver refused to pick
    expect(allPatches(receipt).some((p) => p.path === "a/dup.md")).toBe(false);
    expect(receipt.plans.flatMap((p) => p.creates).some((c) => c.path === "a/dup.md")).toBe(false);
  });
});

// ── 2. KN-10 tiered autonomy + confinement + no-inference ────────────────────────────

describe("rewriteVaultForMeeting — KN-10 tier, @user confinement, no-inference", () => {
  it("additive_auto_human_relevant_proposes — a region refresh AUTO-applies; a claim edit PROPOSES", async () => {
    const candidate: SynthesisCandidate = {
      regions: [{ notePath: "projects/acme-api.md", regionId: "meetings", body: "x", effect: "new_region" }],
      frontmatter: [{ notePath: "projects/acme-api.md", key: "status", value: "active", evidenceRef: "meeting-1#s" }],
    };
    const receipt = await rewriteVaultForMeeting(
      baseInput({ entityRefs: [acmeRef] }),
      mkDeps({ gbrain: fakeGbrain(groundAcme), reason: fakeReason(candidate) }),
    );
    expect(receipt.autoCount).toBe(1);
    expect(receipt.proposeCount).toBe(1);
    const auto = receipt.plans.find((p) => p.requiresApproval === false)!;
    const propose = receipt.plans.find((p) => p.requiresApproval === true)!;
    expect(auto.patches.some((p) => p.regionId === "meetings")).toBe(true);
    expect(propose.frontmatterUpdates.some((f) => f.key === "status")).toBe(true);
  });

  it("user_region_never_overwritten — a @user-targeted region is never patched (13.7b confinement)", async () => {
    const candidate: SynthesisCandidate = {
      regions: [
        { notePath: "projects/acme-api.md", regionId: "@user", body: "hijack", effect: "refresh" },
        { notePath: "projects/acme-api.md", regionId: "meetings", body: "ok", effect: "refresh" },
      ],
    };
    const receipt = await rewriteVaultForMeeting(
      baseInput({ entityRefs: [acmeRef] }),
      mkDeps({
        gbrain: fakeGbrain(groundAcme),
        reason: fakeReason(candidate),
        sections: fakeSections({ "projects/acme-api.md": { generatedRegionIds: ["meetings"] } }),
      }),
    );
    expect(allPatches(receipt).some((p) => p.regionId === "@user")).toBe(false);
    expect(allPatches(receipt).some((p) => p.regionId === "meetings")).toBe(true);
  });

  it("no_inference_tbd — an un-evidenced owner/date is coerced to TBD, never invented (REQ-F-017)", async () => {
    const candidate: SynthesisCandidate = {
      frontmatter: [{ notePath: "projects/acme-api.md", key: "owner", value: "Probably Jane" }], // no evidenceRef
    };
    const receipt = await rewriteVaultForMeeting(
      baseInput({ entityRefs: [acmeRef] }),
      mkDeps({ gbrain: fakeGbrain(groundAcme), reason: fakeReason(candidate) }),
    );
    const owner = receipt.plans.flatMap((p) => p.frontmatterUpdates).find((f) => f.key === "owner");
    expect(owner?.value).toBe(TBD);
    expect(owner?.value).not.toBe("Probably Jane");
  });
});

// ── 3. WS-8 isolation (safety rule 4) ────────────────────────────────────────────────

describe("rewriteVaultForMeeting — WS-8 workspace isolation (§5, safety rule 4)", () => {
  it("ws8_foreign_candidate_dropped — a foreign-workspace candidate never heals a link", async () => {
    const foreign: EntityCandidate = { path: "projects/acme-api.md", slug: "acme-api", title: "Acme API", workspaceId: WS_B };
    const candidate: SynthesisCandidate = { links: { srcPath: MEETING, refs: [{ title: "Acme API" }] } };
    const receipt = await rewriteVaultForMeeting(
      baseInput({ linkCandidates: [foreign] }),
      mkDeps({ reason: fakeReason(candidate) }),
    );
    const links = [...receipt.meetingNoteLinkMutations, ...receipt.plans.flatMap((p) => p.linkMutations)];
    expect(links.some((l) => l.dstSlug === "acme-api")).toBe(false);
  });

  it("ws8_never_reads_across_workspaces — a port bound to another workspace ⇒ empty receipt, ZERO queries issued", async () => {
    const foreignPort = fakeGbrain(groundAcme, { workspaceId: WS_B });
    const receipt = await rewriteVaultForMeeting(
      baseInput({ entityRefs: [acmeRef] }),
      mkDeps({ gbrain: foreignPort, reason: fakeReason({ regions: [{ notePath: "projects/acme-api.md", regionId: "m", body: "x", effect: "new_region" }] }) }),
    );
    expect(foreignPort.queries).toEqual([]); // no cross-brain read was even attempted
    expect(receipt.plans).toEqual([]);
    expect(receipt.meetingNoteLinkMutations).toEqual([]);
  });
});

// ── 4. link discipline (13.8b) + the 13.8f-B merge contract ──────────────────────────

describe("rewriteVaultForMeeting — links are faithful-only, no backlinks (§6 KN-11 / 13.8b)", () => {
  it("link_faithful_only_no_backlinks — a faithful match heals; an ambiguous one is withheld; no backlink section authored", async () => {
    const dupA = cand({ path: "x/dup.md", slug: "dup-a", title: "Dup Title" });
    const dupB = cand({ path: "y/dup.md", slug: "dup-b", title: "Dup Title" });
    const candidate: SynthesisCandidate = { links: { srcPath: MEETING, refs: [{ title: "Acme API" }, { title: "Dup Title" }] } };
    const receipt = await rewriteVaultForMeeting(
      baseInput({ linkCandidates: [ACME, dupA, dupB] }),
      mkDeps({ reason: fakeReason(candidate) }),
    );
    const links = [...receipt.meetingNoteLinkMutations, ...receipt.plans.flatMap((p) => p.linkMutations)];
    expect(links.some((l) => l.dstSlug === "acme-api")).toBe(true); // faithful ⇒ healed
    expect(links.some((l) => l.dstSlug === "dup-a" || l.dstSlug === "dup-b")).toBe(false); // ambiguous ⇒ withheld
    // no emitted mutation ever authors a Backlinks section (KN-11: backlinks are derived, never written)
    const bodies = receipt.plans.flatMap((p) => [...p.creates.map((c) => c.body), ...p.patches.map((x) => x.newBody)]);
    expect(bodies.some((b) => /backlinks/i.test(b))).toBe(false);
  });

  it("meeting_note_mutations_partitioned — meeting-note links ride the separate merge surface, NOT duplicated in plans", async () => {
    const candidate: SynthesisCandidate = { links: { srcPath: MEETING, refs: [{ title: "Acme API" }] } };
    const receipt = await rewriteVaultForMeeting(
      baseInput({ linkCandidates: [ACME] }),
      mkDeps({ reason: fakeReason(candidate) }),
    );
    // the 13.8f-B merge surface carries it …
    expect(receipt.meetingNoteLinkMutations.some((l) => l.srcPath === MEETING && l.dstSlug === "acme-api")).toBe(true);
    // … and the plan set does NOT (else the worker's fold would write it twice)
    expect(receipt.plans.flatMap((p) => p.linkMutations).some((l) => l.srcPath === MEETING)).toBe(false);
  });
});

// ── 5. totality, bounds, dormancy ────────────────────────────────────────────────────

describe("rewriteVaultForMeeting — never-throws, flood-bound, dormant (L11 / L31 / L24)", () => {
  it("pure_never_throws — a throwing reason / throwing gbrain / non-object input ⇒ fail-safe empty receipt", async () => {
    const r1 = await rewriteVaultForMeeting(baseInput(), mkDeps({ reason: { reason: async () => { throw new Error("boom"); } } }));
    expect(r1.plans).toEqual([]);
    expect(r1.planIds).toEqual([]);
    expect(r1.meetingNoteLinkMutations).toEqual([]);

    const throwingGbrain: EntityGbrainReadPort = {
      workspaceId: WS_A,
      findCandidates: async () => { throw new Error("gbrain down"); },
    };
    const r2 = await rewriteVaultForMeeting(baseInput({ entityRefs: [acmeRef] }), mkDeps({ gbrain: throwingGbrain }));
    expect(r2.plans).toEqual([]); // the entity never grounded ⇒ nothing may be written

    const r3 = await rewriteVaultForMeeting(null as unknown as MeetingRewriteInput, mkDeps());
    expect(r3.plans).toEqual([]);

    // a null DEPS is equally total — the sibling rewriteVaultForSource is, and the header claims it
    const r3b = await rewriteVaultForMeeting(baseInput(), null as unknown as MeetingRewriteDeps);
    expect(r3b.plans).toEqual([]);

    // a faulted (typed-err) read is equally fail-safe — no grounding, no write
    const faulted = fakeGbrain({ "Acme API": () => err({ code: "unavailable" }) });
    const r4 = await rewriteVaultForMeeting(baseInput({ entityRefs: [acmeRef] }), mkDeps({ gbrain: faulted }));
    expect(r4.plans).toEqual([]);
  });

  it("flood_bound — entityRefs and linkCandidates beyond the cap are sliced off (L31 bounded blast radius)", async () => {
    const many: EntityRef[] = Array.from({ length: 500 }, (_, i) => ({ name: `Person ${i}`, kind: "person" as const }));
    const port = fakeGbrain({});
    await rewriteVaultForMeeting(baseInput({ entityRefs: many }), mkDeps({ gbrain: port }));
    // exact, not `toBeLessThan(500)` — a loosened cap (say 450) must fail this, not slip through
    expect(port.queries.length).toBe(MAX_ENTITY_REFS);

    const filler = Array.from({ length: 2001 }, (_, i) => cand({ path: `f${i}.md`, slug: `f${i}` }));
    const beyond = cand({ path: "target.md", slug: "acme-api", title: "Acme API" }); // index 2001, beyond the cap
    const candidate: SynthesisCandidate = { links: { srcPath: MEETING, refs: [{ title: "Acme API" }] } };
    const receipt = await rewriteVaultForMeeting(
      baseInput({ linkCandidates: [...filler, beyond] }),
      mkDeps({ reason: fakeReason(candidate) }),
    );
    expect(receipt.meetingNoteLinkMutations.some((l) => l.dstSlug === "acme-api")).toBe(false);
  });

  it("stub_only_run_still_creates_the_attendee_page — grounding fires even with NO usable model output", async () => {
    // The load-bearing claim: a meeting with an unresolved attendee still creates that person's page.
    // Exercises the step-5 fallback — grounding produced a stub but planSynthesis produced no AUTO plan.
    const receipt = await rewriteVaultForMeeting(
      baseInput({ entityRefs: [{ name: "New Person", kind: "person" }] }),
      mkDeps({ reason: fakeReason({}) }), // model returns nothing usable
    );
    expect(receipt.groundedPaths).toEqual(["people/new-person.md"]);
    expect(receipt.plans.flatMap((p) => p.creates).map((c) => c.path)).toEqual(["people/new-person.md"]);
    expect(receipt.autoCount).toBe(1);
    expect(receipt.proposeCount).toBe(0);
  });

  it("gating_preserves_plan_optionals — the gate REMOVES mutations only, never a provenance/verification field", async () => {
    // The gate re-parses each plan through the schema; an optional dropped there would silently strip
    // a signed provenance stamp or a §13.10a expectedProjectId from a plan that carried one.
    const candidate: SynthesisCandidate = {
      regions: [
        { notePath: "projects/acme-api.md", regionId: "meetings", body: "keep", effect: "new_region" },
        { notePath: "people/ghost.md", regionId: "meetings", body: "drop", effect: "new_region" },
      ],
    };
    const receipt = await rewriteVaultForMeeting(
      baseInput({ entityRefs: [acmeRef] }),
      mkDeps({ gbrain: fakeGbrain(groundAcme), reason: fakeReason(candidate) }),
    );
    const auto = receipt.plans.find((p) => p.requiresApproval === false)!;
    // the ungrounded mutation is gone, and the surviving plan kept its identity fields verbatim
    expect(auto.patches.map((p) => p.path)).toEqual(["projects/acme-api.md"]);
    expect(auto.provenanceOrigin).toBe("meeting_close");
    expect(auto.confidence).toBe(0.9);
    expect(auto.sourceRefs.map((s) => s.sourceId)).toEqual(["meeting-1"]);
  });

  it("receipt_groups_planIds — the receipt is the per-run digest (batch-undo unit), like the source path", async () => {
    const candidate: SynthesisCandidate = {
      regions: [{ notePath: "projects/acme-api.md", regionId: "meetings", body: "x", effect: "new_region" }],
    };
    const receipt = await rewriteVaultForMeeting(
      baseInput({ entityRefs: [acmeRef] }),
      mkDeps({ gbrain: fakeGbrain(groundAcme), reason: fakeReason(candidate), newRunId: () => "run-MEET" }),
    );
    expect(receipt.runId).toBe("run-MEET");
    expect(receipt.planIds).toEqual(receipt.plans.map((p) => p.planId));
    expect(receipt.autoCount + receipt.proposeCount).toBe(receipt.plans.length);
  });

  it("structural_surface_names_cannot_be_minted__meeting — an attendee named Index/Log never reaches a root file (13.8j)", async () => {
    // The MEETING call site. Entity names arrive from untrusted attendee strings (13.8g-A), so a
    // name like `Index` must not mint the KN-12 navigation catalog. Namespaced by construction.
    const receipt = await rewriteVaultForMeeting(
      baseInput({
        entityRefs: [
          { name: "Index", kind: "person" },
          { name: "Log", kind: "project" },
          { name: "README", kind: "concept" },
        ],
      }),
      mkDeps({ gbrain: fakeGbrain({}) }), // no candidates ⇒ every ref takes the create_stub branch
    );
    const created = receipt.plans.flatMap((p) => p.creates).map((c) => c.path);
    expect(created.length).toBe(3); // the stubs ARE minted (non-vacuous) …
    for (const forbidden of ["index.md", "log.md", "readme.md", "README.md", "Log.md", "Index.md"]) {
      expect(created, `minted a structural surface: ${forbidden}`).not.toContain(forbidden);
    }
    // … under their kind namespaces
    expect(created.sort()).toEqual(["concepts/readme.md", "people/index.md", "projects/log.md"]);
    expect(receipt.groundedPaths.every((p) => p.includes("/"))).toBe(true);
  });

  it("resolved_paths_unchanged — 13.8j re-paths STUBS only; a resolver HIT keeps its real path verbatim", async () => {
    const receipt = await rewriteVaultForMeeting(
      baseInput({ entityRefs: [acmeRef] }),
      mkDeps({
        gbrain: fakeGbrain(groundAcme), // resolves to projects/acme-api.md
        reason: fakeReason({ regions: [{ notePath: "projects/acme-api.md", regionId: "m", body: "x", effect: "new_region" }] }),
      }),
    );
    // NOT re-prefixed to projects/projects/acme-api.md — a resolved note keeps the path it has
    expect(receipt.groundedPaths).toEqual(["projects/acme-api.md"]);
    expect(receipt.plans.flatMap((p) => p.creates)).toEqual([]); // a resolved entity mints nothing
  });

  it("meeting_note_path_is_admitted_too — the run's OWN subject path is not exempt from the invariant (13.8k)", async () => {
    // `meetingNotePath` is caller-supplied and SEEDS the grounded set, so it gates writes exactly
    // like a resolved entity path does. A meeting note "at" index.md would let the model patch the
    // navigation catalog — the same violation by the one route that isn't a GBrain row.
    const candidate: SynthesisCandidate = {
      regions: [{ notePath: "projects/acme-api.md", regionId: "meetings", body: "x", effect: "new_region" }],
    };
    const deps = () => mkDeps({ gbrain: fakeGbrain(groundAcme), reason: fakeReason(candidate) });

    // POSITIVE CONTROL first — with a legitimate subject the SAME fixture produces real output, so a
    // later empty receipt is attributable to the guard rather than to a fixture that grounds nothing.
    const good = await rewriteVaultForMeeting(baseInput({ entityRefs: [acmeRef] }), deps());
    expect(good.groundedPaths).toEqual(["projects/acme-api.md"]);
    expect(good.plans.length).toBeGreaterThan(0);

    for (const poisoned of ["index.md", "log.md", "Logs/2026-07-26.md", "/etc/passwd.md", "../escape.md"]) {
      const receipt = await rewriteVaultForMeeting(
        baseInput({ meetingNotePath: poisoned, entityRefs: [acmeRef] }),
        deps(),
      );
      expect(receipt.plans, `${poisoned} produced a plan`).toEqual([]);
      expect(receipt.meetingNoteLinkMutations).toEqual([]);
      expect(receipt.groundedPaths, `${poisoned} grounded something`).toEqual([]);
    }
  });

  it("no_production_caller — every apps/ or workflows/ importer of rewriteVaultForMeeting is arming-gated (dormant, L24)", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const importers = scanProductionImporters("rewriteVaultForMeeting", repoRoot);
    expect(ungatedImporters(importers, "rewriteVaultForMeeting")).toEqual([]);
    // non-vacuity: the same predicate still rejects an ungated binding of THIS symbol
    expect(classifyImporterSource(`import { rewriteVaultForMeeting } from "@sow/knowledge";\nawait rewriteVaultForMeeting(i, d);`, "rewriteVaultForMeeting")).toBe("ungated");
  });
});

// ── 13.8m-C — the MEETING-path code-only refusal channel (§6 KN-7 "rejected AND audited") ─────────
//
// Mirrors 13.8m-A (ingest-rewrite.ts) exactly: a REQUIRED `refusals: readonly GroundedPathRefusal[]`
// on the receipt, an accumulator HOISTED above the try, present on the fail-safe empty()-equivalent.
// Producer-only — the meeting-path worker consumer does not exist yet (a follow-on, like 13.8m-B).
//
// Two REAL sources of refusal signal on this path (verified in source, not assumed from the brief):
//  1. The SEED check (`admitGroundedPath(input.meetingNotePath)`) — a poisoned meeting note path
//     aborts the WHOLE run today with zero signal.
//  2. `resolveEntity`'s OWN internal admission check (entity-resolver.ts, 13.8k) — a poisoned
//     RESOLVED candidate path is already caught THERE and returned as `withheld(reason)`, where
//     `reason` for that route is exactly a `GroundedPathRefusal` member embedded in the broader
//     `WithheldReason` union. This receipt never read `resolution.reason` before this slice.
// The `admitInto` call sites (resolved-path re-admission, stub-path admission) are NOT threaded
// with a refusals accumulator: both are provably unreachable-to-fail — the resolved-path call
// re-validates a path `resolveEntity` already admitted (pure function, same input ⇒ same result),
// and the stub path is namespaced-safe by construction (13.8j). Adding untested speculative
// threading there would be exactly the "guard never observed to fail" shape L75 warns against.

describe("rewriteVaultForMeeting — a refusal is observable and carries no content (13.8m-C)", () => {
  it("benign_empty_run_and_refused_run_are_distinguishable — today they are byte-identical", async () => {
    const benign = await rewriteVaultForMeeting(baseInput(), mkDeps());
    const refused = await rewriteVaultForMeeting(baseInput({ meetingNotePath: "index.md" }), mkDeps());
    expect(benign.plans).toEqual([]);
    expect(refused.plans).toEqual([]); // both produce nothing …
    expect(benign.refusals).toEqual([]); // … but only one REFUSED
    expect(refused.refusals.length).toBeGreaterThan(0);
    expect(refused.refusals).not.toEqual(benign.refusals);
  });

  it("refusal_carries_no_path_or_title_text — reason codes ONLY (safety rule 7)", async () => {
    // The refusal channel must not become the leak: a resolved candidate's path/title is
    // GBrain-derived, untrusted content that may carry PII or employer-work strings.
    const hostile = "employer-internal/secret-person-q3-layoffs.md";
    const deps = mkDeps({
      gbrain: fakeGbrain({
        Ghost1: () => ok([cand({ path: `/${hostile}`, slug: "ghost1", title: "Ghost1" })]), // absolute ⇒ unsafe_shape
        Ghost2: () => ok([cand({ path: "index.md", slug: "ghost2", title: "Ghost2" })]), // structural_surface
      }),
    });
    const receipt = await rewriteVaultForMeeting(
      baseInput({
        entityRefs: [
          { name: "Ghost1", kind: "person" },
          { name: "Ghost2", kind: "project" },
        ],
      }),
      deps,
    );
    // NON-VACUITY FIRST — an empty array satisfies every `not.toContain` below and would let this
    // test stay green if `refusals` silently stopped populating.
    expect(receipt.refusals).toEqual(["unsafe_shape", "structural_surface"]);
    const serialized = JSON.stringify(receipt.refusals);
    expect(serialized).not.toContain("employer-internal");
    expect(serialized).not.toContain("secret-person");
    expect(serialized).not.toContain("layoffs");
    expect(serialized).not.toContain("index.md");
    expect(serialized).not.toContain("Ghost1");
    expect(serialized).not.toContain("Ghost2");
    // every entry is one of the two known code-only reasons
    for (const r of receipt.refusals) expect(["structural_surface", "unsafe_shape"]).toContain(r);
  });

  it("fault_after_admission_still_reports_refusals — a run that refuses, then trips a throwing port, still reports", async () => {
    // Caught by mutation-testing the fix (reported at Step 2.5/9): without the hoist, `catch` returns
    // a fresh empty receipt and the accumulated refusal vanishes — a run that hijacked a resolution
    // AND tripped a fault becomes byte-identical to a benign empty one.
    //
    // The fault must genuinely reach the OUTER catch. `newPlanId` throwing never reaches `planSynthesis`
    // (which is itself TOTAL and would swallow it internally) — so the candidate here is EMPTY
    // (`semantic = []`), meaning `assemble` inside planSynthesis never calls `newPlanId` at all. The
    // only call this scenario drives is step 5's `assembleFresh` (stub-only run), which is UNGUARDED
    // in `rewriteVaultForMeeting`'s own try — a throw there reaches the outer catch directly.
    const deps = mkDeps({
      gbrain: fakeGbrain({
        Ghost: () => ok([cand({ path: "index.md", slug: "ghost", title: "Ghost" })]), // withheld(structural_surface)
        // "New Person" ⇒ [] ⇒ create_stub, mints a stub ⇒ step 5's assembleFresh runs
      }),
      newPlanId: () => {
        throw new Error("boom");
      },
    });
    const receipt = await rewriteVaultForMeeting(
      baseInput({ entityRefs: [{ name: "Ghost", kind: "person" }, { name: "New Person", kind: "person" }] }),
      deps,
    );
    expect(receipt.plans).toEqual([]); // the fault really fired — nothing assembled
    expect(receipt.refusals).toContain("structural_surface"); // the refusal SURVIVED the fault
  });

  it("fail_safe_receipt_carries_refusals — the empty()-equivalent path returned on a seed refusal is EXACTLY empty plus refusals", async () => {
    const receipt = await rewriteVaultForMeeting(baseInput({ meetingNotePath: "log.md" }), mkDeps());
    // every OTHER field is the canonical "nothing happened" shape …
    expect(receipt.plans).toEqual([]);
    expect(receipt.planIds).toEqual([]);
    expect(receipt.autoCount).toBe(0);
    expect(receipt.proposeCount).toBe(0);
    expect(receipt.meetingNoteLinkMutations).toEqual([]);
    expect(receipt.groundedPaths).toEqual([]);
    // … except refusals, the one field that carries signal
    expect(receipt.refusals).toEqual(["structural_surface"]);
  });

  it("refusals_is_required_on_the_receipt — the field cannot be omitted (contracts L103)", () => {
    // @ts-expect-error — omitting `refusals` must fail to type-check; an UNUSED directive here (TS2578)
    // is the pin failing, not passing (worker L80's proven pin, applied here). Every OTHER required
    // field — including the 13.23-C tally added after this pin was written — is present, so the
    // directive isolates exactly `refusals`'s omission rather than a compound one.
    const literal: MeetingRewriteReceipt = {
      runId: "run-1",
      plans: [],
      planIds: [],
      autoCount: 0,
      proposeCount: 0,
      meetingNoteLinkMutations: [],
      groundedPaths: [],
      directEntityRefsWithheldByReason: {},
    };
    // Reference `literal` so it's not reported as an unused local by a stricter lint config someday.
    expect(literal.runId).toBe("run-1");
  });
});

// ── 13.23-C — every WithheldReason reaches the meeting receipt as a per-code tally ────────────────
//
// `resolveEntity`'s direct call site in the per-ref loop above only ever surfaced TWO of the seven
// `WithheldReason` codes into an observable channel (`refusals`, and only its two `GroundedPathRefusal`
// members). The other five — ambiguous/lossy_match/gbrain_unavailable/malformed_entity/
// ws_scope_mismatch — were discarded silently. `directEntityRefsWithheldByReason` closes that gap,
// mirroring `planner.ts`'s `entityRefsWithheldByReason` (Map-accumulated, `Object.fromEntries`-converted
// once, so a future `WithheldReason` member named `"__proto__"`/`"constructor"`/`"toString"` still lands
// as a harmless own key).

describe("rewriteVaultForMeeting — every WithheldReason reaches the receipt as a per-code tally (13.23-C)", () => {
  it("every_withheld_reason_reaches_the_meeting_receipt_as_a_per_code_count", async () => {
    // Six of the seven codes are reachable through an ordinary (non-hostile) port on THIS direct call
    // site, one entity ref per code:
    const dup = [cand({ path: "a/dup.md", slug: "dup", title: "Ambiguous" }), cand({ path: "b/dup.md", slug: "dup2", title: "Ambiguous" })];
    const deps = mkDeps({
      gbrain: fakeGbrain({
        Ambiguous: () => ok(dup), // 2 distinct faithful matches ⇒ ambiguous
        "C++": () => ok([cand({ path: "concepts/c.md", slug: "c", title: "C" })]), // lossy collision ⇒ lossy_match
        GbrainDown: () => err({ code: "read_fault" }), // ⇒ gbrain_unavailable
        Ghost1: () => ok([cand({ path: "/etc/passwd.md", slug: "ghost1", title: "Ghost1" })]), // absolute ⇒ unsafe_shape
        Ghost2: () => ok([cand({ path: "index.md", slug: "ghost2", title: "Ghost2" })]), // ⇒ structural_surface
      }),
    });
    const receipt = await rewriteVaultForMeeting(
      baseInput({
        entityRefs: [
          { name: "   ", kind: "person" }, // no usable slug anchor ⇒ malformed_entity, no read issued
          { name: "Ambiguous", kind: "person" },
          { name: "C++", kind: "concept" },
          { name: "GbrainDown", kind: "person" },
          { name: "Ghost1", kind: "person" },
          { name: "Ghost2", kind: "project" },
        ],
      }),
      deps,
    );
    expect(receipt.directEntityRefsWithheldByReason).toEqual({
      malformed_entity: 1,
      ambiguous: 1,
      lossy_match: 1,
      gbrain_unavailable: 1,
      unsafe_shape: 1,
      structural_surface: 1,
    });

    // The seventh code, `ws_scope_mismatch`, is STRUCTURALLY UNREACHABLE on this call site through any
    // well-behaved port: `rewriteVaultForMeeting` already gates `deps.gbrain.workspaceId ===
    // input.workspaceId` ONCE, before the per-ref loop is even entered (mirrors
    // `ws8_never_reads_across_workspaces` above) — so a genuinely foreign-workspace port short-circuits
    // to an empty receipt with ZERO queries, never reaching this loop at all (the same fact
    // `synthesis-planner.test.ts`'s `the_meeting_rewrite_direct_call_site_does_NOT_flow_through_this_channel`
    // already established for this exact call site, using "ambiguous" as ITS stand-in for precisely
    // this reason). The only way to observe the tally handle `ws_scope_mismatch` here is a HOSTILE
    // double-read `workspaceId` getter — matching values on the outer gate's read, then a DIFFERENT
    // value on `resolveEntity`'s own internal re-gate a moment later (the same TOCTOU shape
    // `entity-resolver.ts`'s `meetingNotePath` guard defends against). Driven for real, not merely
    // asserted unreachable:
    let reads = 0;
    const hostilePort: EntityGbrainReadPort = {
      get workspaceId() {
        reads++;
        return reads === 1 ? WS_A : WS_B;
      },
      findCandidates: async () => ok([]),
    };
    const mismatchReceipt = await rewriteVaultForMeeting(
      baseInput({ entityRefs: [{ name: "Whoever", kind: "person" }] }),
      mkDeps({ gbrain: hostilePort }),
    );
    expect(mismatchReceipt.directEntityRefsWithheldByReason).toEqual({ ws_scope_mismatch: 1 });
  });

  it("absent_reasons_are_absent_keys_not_zeroes — a sparse tally, never a zero-padded exhaustive one", async () => {
    const deps = mkDeps({
      gbrain: fakeGbrain({
        Ambiguous: () => ok([cand({ path: "a/dup.md", slug: "dup", title: "Ambiguous" }), cand({ path: "b/dup.md", slug: "dup2", title: "Ambiguous" })]),
      }),
    });
    const receipt = await rewriteVaultForMeeting(baseInput({ entityRefs: [{ name: "Ambiguous", kind: "person" }] }), deps);
    expect(receipt.directEntityRefsWithheldByReason).toEqual({ ambiguous: 1 });
    // the other six codes are ABSENT keys, not present with value 0 — `Object.keys` length pins it,
    // because `toEqual({ambiguous: 1})` alone would already fail on an extra `foo: 0` key too, but this
    // makes the sparse intent explicit and named rather than an implicit side effect of `toEqual`.
    expect(Object.keys(receipt.directEntityRefsWithheldByReason)).toEqual(["ambiguous"]);
  });

  it("the_tally_carries_no_name_path_or_slug — code-only, rule 7", async () => {
    const sentinelName = "TOTALLY-SECRET-EMPLOYER-CODENAME-Q3";
    const deps = mkDeps({
      gbrain: fakeGbrain({
        [sentinelName]: () =>
          ok([
            cand({ path: "a/dup.md", slug: "dup", title: sentinelName }),
            cand({ path: "b/dup.md", slug: "dup2", title: sentinelName }),
          ]),
      }),
    });
    const receipt = await rewriteVaultForMeeting(
      baseInput({ entityRefs: [{ name: sentinelName, kind: "person" }] }),
      deps,
    );
    // non-vacuity first — the withhold really fired, so an empty tally isn't satisfying the exclusion
    // check for free.
    expect(receipt.directEntityRefsWithheldByReason).toEqual({ ambiguous: 1 });
    expect(JSON.stringify(receipt.directEntityRefsWithheldByReason)).not.toContain(sentinelName);
    expect(JSON.stringify(receipt.directEntityRefsWithheldByReason)).not.toContain("SECRET");
  });

  it("existing_refusals_channel_is_unchanged — the tally is ADDITIVE, never a replacement for `refusals`", async () => {
    // The exact fixture `refusal_carries_no_path_or_title_text` above already pins `refusals` against
    // — reused so a divergence between the two channels on the SAME run is directly comparable.
    const deps = mkDeps({
      gbrain: fakeGbrain({
        Ghost1: () => ok([cand({ path: "/employer-internal/secret.md", slug: "ghost1", title: "Ghost1" })]),
        Ghost2: () => ok([cand({ path: "index.md", slug: "ghost2", title: "Ghost2" })]),
      }),
    });
    const receipt = await rewriteVaultForMeeting(
      baseInput({
        entityRefs: [
          { name: "Ghost1", kind: "person" },
          { name: "Ghost2", kind: "project" },
        ],
      }),
      deps,
    );
    // unchanged: still exactly the two GroundedPathRefusal codes, same order, same values as before
    // this slice — the OLD channel's own test (line ~460 above) pins the identical fixture's shape.
    expect(receipt.refusals).toEqual(["unsafe_shape", "structural_surface"]);
    // NEW: the tally observes the SAME two withholds too — additive, not a fork of the decision.
    expect(receipt.directEntityRefsWithheldByReason).toEqual({ unsafe_shape: 1, structural_surface: 1 });
  });
});
