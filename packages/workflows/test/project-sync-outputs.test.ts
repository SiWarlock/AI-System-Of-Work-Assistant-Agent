// P3e-2 — the concrete SyncOutputsProjection. Pins the 3 adversarial-verify MAJOR fixes:
//  (WS-8)     the committed note path is rooted at workspaceId (never the multi-segment slug); traversal-safe;
//             an empty-slugging projectId fails closed.
//  (REQ-F-011) the note-body percent is RE-DERIVED via computePercent — never the narrative / a verbatim field.
//  (no-inference) the note prose uses the SAME renderProseLines helper as the dashboard (TBD skipped, single-lined).
// Plus: the field-key convention (blockers.N/waitingItems.N/nextActions.N + explanation) and the {workspaceId,
// dashboard} envelope the real update port consumes.
import { describe, it, expect } from "vitest";
import { isOk, workspaceId, UiSafeProjectDashboardSchema } from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";
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

const run = (fields: Record<string, ExtractionField<unknown>>, id = identity, prog = progress, ws = WS) =>
  createProjectSyncOutputsProjection().project(narrative(fields), prog, ws, id, AT);

const bodyOf = (r: ReturnType<typeof run>): string => {
  if (!isOk(r)) throw new Error("expected ok");
  return r.value.note.body;
};

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
    const r = run({});
    if (!isOk(r)) throw new Error("ok");
    expect(r.value.note.path).toBe("projects/personal-business/acme-api.md");
    // the slug "employer-work/acme-api" must NOT govern the physical path.
    expect(r.value.note.path).not.toContain("employer-work");
  });

  it("WS-8: a projectId that sanitizes to empty (all punctuation) FAILS CLOSED (no unsafe path)", () => {
    const r = run({}, { ...identity, projectId: "../.." });
    expect(isOk(r)).toBe(false);
  });

  it("WS-8: the slug is preserved in FRONTMATTER only (display), path stays workspace-rooted", () => {
    const r = run({});
    if (!isOk(r)) throw new Error("ok");
    const fm = r.value.note.frontmatter as Record<string, unknown>;
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
    if (!isOk(r)) throw new Error("ok");
    const body = r.value.note.body;
    expect(body).toContain("real blocker");
    expect(body).not.toContain("TBD");
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
    expect(r.value.note.body).toContain("progressing well"); // the explanation lead
  });

  it("field-key convention: a mis-keyed field (no .N index, or unknown category) is IGNORED, never fabricated", () => {
    const r = run({ blocker: field("mis-keyed"), random: field("noise"), "blockers.0": field("kept") });
    if (!isOk(r)) throw new Error("ok");
    const env = r.value.dashboard as { dashboard: { blockers: string[] } };
    expect(env.dashboard.blockers).toEqual(["kept"]);
    expect(r.value.note.body).not.toContain("mis-keyed");
    expect(r.value.note.body).not.toContain("noise");
  });

  it("wraps the sync-mutable content in the kw:region:project-status assistant region (KN-7)", () => {
    const body = bodyOf(run({}));
    expect(body).toContain("<!-- kw:region:project-status -->");
    expect(body).toContain("<!-- /kw:region:project-status -->");
  });
});
