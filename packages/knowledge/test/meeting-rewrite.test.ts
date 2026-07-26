// spec(§9 workflow-1 L297, §6 KN-10/KN-11, §5 WS-8, REQ-F-017) — 13.8f-A meeting-path living-vault
// synthesis: `rewriteVaultForMeeting` turns a meeting closeout into entity-grounded person/project page
// mutations. It is the SOURCE path's sibling (`rewriteVaultForSource`) with ONE deliberate extra gate:
// GROUND-BEFORE-WRITE is enforced at THIS layer — only a target the 13.8a EntityResolver actually
// grounded (resolved path / create-stub) or the meeting note itself may be written. PURE over injected
// ports; TOTAL never-throws; DORMANT (the worker threads it in as 13.8f-B).
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ok, err } from "@sow/contracts";
import type { Result, WorkspaceId, ProvenanceOrigin } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { EntityCandidate, EntityGbrainReadPort, EntityReadFault, EntityRef } from "../src/synthesis/entity-resolver";
import type { SynthesisCandidate, SynthesisSectionPort, NoteRegionDescriptor } from "../src/synthesis/planner";
import {
  rewriteVaultForMeeting,
  MAX_ENTITY_REFS,
  type MeetingRewriteInput,
  type MeetingRewriteDeps,
} from "../src/synthesis/meeting-rewrite";
import { classifyImporterSource, scanProductionImporters, ungatedImporters } from "./support/dormancy-pin";

const WS_A = "ws-a" as WorkspaceId;
const WS_B = "ws-b" as WorkspaceId;
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
    expect(receipt.groundedPaths).toContain("new-person.md"); // and the good ref AFTER it still ran
    expect(allPatches(receipt).some((p) => p.path === "projects/acme-api.md")).toBe(true);
  });

  it("unresolved_candidate_stubs_never_fabricates — create_stub grounds a stub path; a withheld entity writes NOTHING", async () => {
    const ambiguous = [cand({ path: "a/dup.md", slug: "dup", title: "Dup Name" }), cand({ path: "b/dup.md", slug: "dup2", title: "Dup Name" })];
    const deps = mkDeps({
      gbrain: fakeGbrain({ "Dup Name": () => ok(ambiguous) }), // "New Person" ⇒ [] ⇒ create_stub
      reason: fakeReason({
        regions: [
          { notePath: "new-person.md", regionId: "meetings", body: "attended", effect: "new_region" },
          { notePath: "a/dup.md", regionId: "meetings", body: "guessed", effect: "new_region" },
        ],
      }),
    });
    const receipt = await rewriteVaultForMeeting(
      baseInput({ entityRefs: [{ name: "New Person", kind: "person" }, { name: "Dup Name", kind: "person" }] }),
      deps,
    );
    // the create-stub path is grounded — a stub note is created, and writes to it are allowed
    expect(receipt.plans.flatMap((p) => p.creates).some((c) => c.path === "new-person.md")).toBe(true);
    expect(allPatches(receipt).some((p) => p.path === "new-person.md")).toBe(true);
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
    expect(receipt.groundedPaths).toEqual(["new-person.md"]);
    expect(receipt.plans.flatMap((p) => p.creates).map((c) => c.path)).toEqual(["new-person.md"]);
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

  it("no_production_caller — every apps/ or workflows/ importer of rewriteVaultForMeeting is arming-gated (dormant, L24)", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const importers = scanProductionImporters("rewriteVaultForMeeting", repoRoot);
    expect(ungatedImporters(importers, "rewriteVaultForMeeting")).toEqual([]);
    // non-vacuity: the same predicate still rejects an ungated binding of THIS symbol
    expect(classifyImporterSource(`import { rewriteVaultForMeeting } from "@sow/knowledge";\nawait rewriteVaultForMeeting(i, d);`, "rewriteVaultForMeeting")).toBe("ungated");
  });
});
