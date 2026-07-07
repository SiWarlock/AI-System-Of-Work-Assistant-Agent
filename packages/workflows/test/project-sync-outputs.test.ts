// P3e-2 / §13.5 — the concrete SyncOutputsProjection. Pins the 3 adversarial-verify MAJOR fixes:
//  (WS-8)     the committed note path is rooted at workspaceId (never the multi-segment slug); traversal-safe;
//             an empty-slugging projectId fails closed.
//  (REQ-F-011) the note-body percent is RE-DERIVED via computePercent — never the narrative / a verbatim field.
//  (no-inference) the note prose uses the SAME renderProseLines helper as the dashboard (TBD skipped, single-lined).
// Plus: the field-key convention (blockers.N/waitingItems.N/nextActions.N + explanation) and the {workspaceId,
// dashboard} envelope the real update port consumes; AND the create-vs-patch split — first sync emits a full
// NoteCreate, re-sync emits a region NotePatch whose newBody is BYTE-IDENTICAL to the create note's region inner.
import { describe, it, expect } from "vitest";
import { isOk, workspaceId, UiSafeProjectDashboardSchema } from "@sow/contracts";
import type { WorkspaceId, NoteCreate, NotePatch } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { ExtractionField } from "@sow/domain";
import { createProjectSyncOutputsProjection } from "../src/activities/projections/projectSyncOutputs";
import type { ProjectIdentity, DeterministicProgress, ValidatedNarrative } from "../src/ports/projectSync";

const WS: WorkspaceId = workspaceId("personal-business");
const AT = "2026-07-07T00:00:00.000Z";
const field = (value: string): ExtractionField<string> => ({ value, evidenceRef: "canonical:ref" });
const identity: ProjectIdentity = { projectId: "acme-api", title: "Acme API", slug: "employer-work/acme-api", lifecycleState: "active" };
const progress: DeterministicProgress = { completedCount: 2, totalCount: 4, percentComplete: 50, perProvider: [] };
const narrative = (fields: Record<string, ExtractionField<unknown>>): ValidatedNarrative => ({ validated: true, fields });

const run = (
  fields: Record<string, ExtractionField<unknown>>,
  id = identity,
  prog = progress,
  ws = WS,
  noteExists = false,
) => createProjectSyncOutputsProjection().project(narrative(fields), prog, ws, id, AT, noteExists);

/** Assert a first-sync (create) mutation and return the NoteCreate. */
const noteOf = (r: ReturnType<typeof run>): NoteCreate => {
  if (!isOk(r)) throw new Error("expected ok");
  if (r.value.mutation.kind !== "create") throw new Error("expected a create mutation");
  return r.value.mutation.note;
};
/** Assert a re-sync (patch) mutation and return the NotePatch. */
const patchOf = (r: ReturnType<typeof run>): NotePatch => {
  if (!isOk(r)) throw new Error("expected ok");
  if (r.value.mutation.kind !== "patch") throw new Error("expected a patch mutation");
  return r.value.mutation.patch;
};
const bodyOf = (r: ReturnType<typeof run>): string => noteOf(r).body;

describe("createProjectSyncOutputsProjection", () => {
  it("emits a {workspaceId, dashboard} envelope whose inner dashboard parses UiSafeProjectDashboardSchema", () => {
    const r = run({ "blockers.0": field("legal review") });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const env = r.value.dashboard as { workspaceId: string; dashboard: unknown };
    expect(env.workspaceId).toBe("personal-business");
    expect(() => UiSafeProjectDashboardSchema.parse(env.dashboard)).not.toThrow();
    expect(r.value.actions).toEqual([]);
  });

  it("WS-8: the note path is rooted at workspaceId, NEVER the multi-segment slug", () => {
    const note = noteOf(run({}));
    expect(note.path).toBe("projects/personal-business/acme-api.md");
    // the slug "employer-work/acme-api" must NOT govern the physical path.
    expect(note.path).not.toContain("employer-work");
  });

  it("WS-8: a projectId that sanitizes to empty (all punctuation) FAILS CLOSED (no unsafe path)", () => {
    const r = run({}, { ...identity, projectId: "../.." });
    expect(isOk(r)).toBe(false);
  });

  it("WS-8 (defense-in-depth): a workspaceId SEGMENT carrying a separator or `..` FAILS CLOSED (no escape from projects/)", () => {
    // the WorkspaceId brand rejects only empty/whitespace, so an adversarial `../../vault` value is constructable;
    // the shared projectNotePath authority must reject it rather than emit `projects/../../vault/...md`.
    expect(isOk(run({}, identity, progress, workspaceId("../../vault-root")))).toBe(false);
    expect(isOk(run({}, identity, progress, workspaceId("a/b")))).toBe(false);
  });

  it("WS-8: the slug is preserved in FRONTMATTER only (display), path stays workspace-rooted", () => {
    const fm = noteOf(run({})).frontmatter as Record<string, unknown>;
    expect(fm["slug"]).toBe("employer-work/acme-api");
    expect(fm["workspaceId"]).toBe("personal-business");
    expect(fm["projectId"]).toBe("acme-api");
    expect(fm["lifecycleState"]).toBe("active");
    expect(fm["provenanceOrigin"]).toBe("project_sync");
    expect(fm["title"]).toBe("Acme API");
  });

  it("REQ-F-011: the note-body percent is RE-DERIVED from counts, never a verbatim field", () => {
    // counts say 1/10 = 10%, but progress claims 90% — the committed note must show 10%.
    const r = run({}, identity, { completedCount: 1, totalCount: 10, percentComplete: 90, perProvider: [] });
    const body = bodyOf(r);
    expect(body).toContain("1 / 10");
    expect(body).toContain("10%");
    expect(body).not.toContain("90%");
  });

  it("no-inference: a TBD category field never appears in the committed note body OR the dashboard", () => {
    const r = run({ "blockers.0": { value: TBD }, "blockers.1": field("real blocker") });
    const body = noteOf(r).body;
    expect(body).toContain("real blocker");
    expect(body).not.toContain("TBD");
    if (!isOk(r)) return;
    const env = r.value.dashboard as { dashboard: { blockers: string[] } };
    expect(env.dashboard.blockers).toEqual(["real blocker"]);
  });

  it("no-inference: a multi-line field value is collapsed to a single line in the committed body", () => {
    const r = run({ "blockers.0": field("line one\nline two") });
    const body = bodyOf(r);
    expect(body).toContain("line one line two");
    // the raw newline between the two words must not survive into the body.
    expect(body).not.toContain("line one\nline two");
  });

  it("field-key convention: blockers.0/.1 map in index order; waitingItems.N + nextActions.N categorized", () => {
    const r = run({
      "blockers.1": field("second"),
      "blockers.0": field("first"),
      "waitingItems.0": field("waiting on PR"),
      "nextActions.0": field("draft migration"),
      explanation: field("progressing well"),
    });
    if (!isOk(r)) throw new Error("ok");
    const env = r.value.dashboard as { dashboard: { blockers: string[]; waitingItems: string[]; nextActions: string[] } };
    expect(env.dashboard.blockers).toEqual(["first", "second"]); // sorted by index
    expect(env.dashboard.waitingItems).toEqual(["waiting on PR"]);
    expect(env.dashboard.nextActions).toEqual(["draft migration"]);
    expect(noteOf(r).body).toContain("progressing well"); // the explanation lead
  });

  it("field-key convention: a mis-keyed field (no .N index, or unknown category) is IGNORED, never fabricated", () => {
    const r = run({ blocker: field("mis-keyed"), random: field("noise"), "blockers.0": field("kept") });
    if (!isOk(r)) throw new Error("ok");
    const env = r.value.dashboard as { dashboard: { blockers: string[] } };
    expect(env.dashboard.blockers).toEqual(["kept"]);
    expect(noteOf(r).body).not.toContain("mis-keyed");
    expect(noteOf(r).body).not.toContain("noise");
  });

  it("wraps the sync-mutable content in the kw:region:project-status assistant region (KN-7)", () => {
    const body = bodyOf(run({}));
    expect(body).toContain("<!-- kw:region:project-status -->");
    expect(body).toContain("<!-- /kw:region:project-status -->");
  });

  it("omits a category's whole ## section when it has no renderable items (no bare header)", () => {
    // no blockers/waiting fields at all, and an all-TBD nextActions category → all three headers absent.
    const body = bodyOf(run({ "nextActions.0": { value: TBD } }));
    expect(body).not.toContain("## Blockers");
    expect(body).not.toContain("## Waiting on");
    expect(body).not.toContain("## Next actions");
    expect(body).toContain("## Progress"); // Progress is always present
  });

  it("field-key convention: an index GAP (blockers.0 + blockers.2, no .1) keeps ascending order", () => {
    const r = run({ "blockers.2": field("third"), "blockers.0": field("first") });
    if (!isOk(r)) throw new Error("ok");
    const env = r.value.dashboard as { dashboard: { blockers: string[] } };
    expect(env.dashboard.blockers).toEqual(["first", "third"]);
  });

  it("hardening: a NON-STRING field value is DROPPED, never String()-coerced into canonical Markdown", () => {
    // a mis-typed field (object value) must not render as "[object Object]" in the note or dashboard.
    const r = run({ "blockers.0": { value: { evil: 1 } as unknown as string, evidenceRef: "x" }, "blockers.1": field("kept") });
    if (!isOk(r)) throw new Error("ok");
    const env = r.value.dashboard as { dashboard: { blockers: string[] } };
    expect(env.dashboard.blockers).toEqual(["kept"]);
    expect(noteOf(r).body).not.toContain("[object Object]");
  });
});

describe("createProjectSyncOutputsProjection — create-vs-patch (§13.5)", () => {
  it("first sync (noteExists=false) → a create mutation with the full note (H1 + region + frontmatter)", () => {
    const note = noteOf(run({ "blockers.0": field("legal") }, identity, progress, WS, false));
    expect(note.body).toContain("# Acme API — Status");
    expect(note.body).toContain("<!-- kw:region:project-status -->");
    expect(note.frontmatter).toBeDefined();
  });

  it("re-sync (noteExists=true) → a region NotePatch: same path, regionId project-status, NO H1 + NO markers in newBody", () => {
    const patch = patchOf(run({ "blockers.0": field("legal") }, identity, progress, WS, true));
    expect(patch.path).toBe("projects/personal-business/acme-api.md"); // WS-8 workspace-rooted, same as the create
    expect(patch.regionId).toBe("project-status");
    // the patch newBody is the region INNER only — the writer adds the markers; the H1 stays human scaffold.
    expect(patch.newBody).not.toContain("# Acme API — Status");
    expect(patch.newBody).not.toContain("<!-- kw:region:project-status -->");
    expect(patch.newBody).not.toContain("<!-- /kw:region:project-status -->");
    // but it DOES carry the sync-mutable content (re-derived percent + prose).
    expect(patch.newBody).toContain("## Progress");
    expect(patch.newBody).toContain("legal");
  });

  it("byte-idempotent: the re-sync patch newBody === the create note's region INNER content (same facts)", () => {
    const fields = { "blockers.0": field("legal review"), "nextActions.0": field("wire gateway"), explanation: field("on track") };
    const createBody = noteOf(run(fields, identity, progress, WS, false)).body;
    const patchNewBody = patchOf(run(fields, identity, progress, WS, true)).newBody;

    // Extract the create note's region inner: between "<open>\n" and "\n<close>".
    const open = "<!-- kw:region:project-status -->\n";
    const close = "\n<!-- /kw:region:project-status -->";
    const start = createBody.indexOf(open) + open.length;
    const end = createBody.indexOf(close);
    const createRegionInner = createBody.slice(start, end);

    // The patch that a re-sync emits must reconstruct the SAME region content (no drift across create→patch).
    expect(patchNewBody).toBe(createRegionInner);
  });

  it("REQ-F-011 holds on the re-sync patch too: the patch percent is RE-DERIVED, never a verbatim field", () => {
    // counts 1/10 = 10%, but the (ignored) claimed percent is 90.
    const patch = patchOf(run({}, identity, { completedCount: 1, totalCount: 10, percentComplete: 90, perProvider: [] }, WS, true));
    expect(patch.newBody).toContain("1 / 10");
    expect(patch.newBody).toContain("10%");
    expect(patch.newBody).not.toContain("90%");
  });

  it("WS-8 holds on the re-sync patch too: a projectId with no safe anchor FAILS CLOSED (no unsafe patch path)", () => {
    const r = run({}, { ...identity, projectId: "../.." }, progress, WS, true);
    expect(isOk(r)).toBe(false);
  });
});
