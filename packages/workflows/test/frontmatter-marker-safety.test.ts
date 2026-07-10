// spec(§6 / safety rule 1) — frontmatter marker-safety (extends region-marker neutralization to
// model-derived FRONTMATTER values). checkOwnership runs parseSections over the WHOLE note (frontmatter
// included, ownership.ts:62 → sections.ts:86), and serializeScalar (YAML-quote / JSON.stringify) does NOT
// strip `<!--` — so a kw:region marker string in a model-derived frontmatter value (meeting
// title/decisions/attendees/owner/dueDate; project title) would inject a spurious region ⇒ a fail-closed
// `malformed_marker` write rejection. The fix reuses the shipped `neutralizeRegionMarkers` at the two
// projection composition sites (via the `neutralizeFrontmatterValue` dispatcher), making a marker-valued
// field a graceful no-op while preserving boundary integrity. The load-bearing pins: (1) both serialize
// branches — a SCALAR field (title → YAML-quote) and a string[] ELEMENT (decision/attendee → JSON.stringify)
// — leave no `<!--` in the serialized frontmatter; (2) parseSections sees exactly the real body region(s),
// zero spurious frontmatter region, and checkOwnership passes on create AND re-sync patch.
import { describe, it, expect } from "vitest";
import { workspaceId, isOk } from "@sow/contracts";
import type { WorkspaceId, NoteCreate, KnowledgeMutationPlan } from "@sow/contracts";
import type { ExtractionField } from "@sow/domain";
import { parseSections, checkOwnership, serializeScalar } from "@sow/knowledge";
import { meetingOutputsProjection } from "../src/activities/projections/meetingOutputs";
import { createProjectSyncOutputsProjection } from "../src/activities/projections/projectSyncOutputs";
import {
  neutralizeRegionMarkers,
  neutralizeFrontmatterValue,
  MEETING_OUTPUTS_REGION,
  PROJECT_STATUS_REGION,
} from "../src/activities/projections/noteSlug";
import type { ValidatedExtraction } from "../src/ports/meetingCloseout";

const WS: WorkspaceId = workspaceId("ws-employer");
const backed = <T>(value: T): ExtractionField<T> => ({ value, evidenceRef: "transcript#L1" });
const MEET_OPEN = `<!-- kw:region:${MEETING_OUTPUTS_REGION} -->`;
const MEET_CLOSE = `<!-- /kw:region:${MEETING_OUTPUTS_REGION} -->`;
const PROJ_OPEN = `<!-- kw:region:${PROJECT_STATUS_REGION} -->`;

// `MARKER_RE` mirror of sections.ts (the parseSections matcher) — a hit in the frontmatter is a stray region.
const MARKER_RE = /<!-- (\/?)kw:region:([^\s>]+) -->/gu;
const countMarkers = (s: string): number => (s.match(MARKER_RE) ?? []).length;

/**
 * Faithful mirror of writer.ts `renderCreate` (internal/unexported): serialize each frontmatter value via the
 * REAL `serializeScalar`, override `title` from `note.title` (as renderCreate does after the frontmatter loop),
 * then the `---`-framed note. The framing is boilerplate that cannot introduce a `kw:region` marker; the
 * serialized VALUES are exact (real serializeScalar), so the marker-safety property under test is faithful.
 */
const renderNote = (note: NoteCreate): string => {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(note.frontmatter ?? {})) lines.push(`${k}: ${serializeScalar(v)}`);
  if (note.title !== undefined) {
    const line = `title: ${serializeScalar(note.title)}`;
    const i = lines.findIndex((l) => l.startsWith("title:"));
    if (i >= 0) lines[i] = line;
    else lines.push(line);
  }
  return `---\n${lines.join("\n")}\n---\n${note.body}`;
};

/** The frontmatter block (between the two `---` fences) of a rendered note. */
const frontmatterBlock = (rendered: string): string => {
  const start = rendered.indexOf("---\n") + 4;
  const end = rendered.indexOf("\n---\n", start);
  return rendered.slice(start, end);
};

/** Assistant region ids parseSections finds over a FULL note (frontmatter + body). Throws on malformed. */
const regionIds = (content: string): readonly string[] => {
  const parsed = parseSections(content);
  if (!parsed.ok) throw new Error(`parseSections malformed_marker: ${parsed.error.reason}`);
  return parsed.value.filter((s) => s.kind === "assistant").map((s) => s.regionId);
};

/** Faithful mirror of writer.ts `applyRegionPatch` boundary search (indexOf open/close). */
const applyRegionPatchLike = (content: string, id: string, newBody: string): string => {
  const open = `<!-- kw:region:${id} -->`;
  const close = `<!-- /kw:region:${id} -->`;
  const region = `${open}\n${newBody}\n${close}`;
  const start = content.indexOf(open);
  const end = content.indexOf(close);
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(0, start) + region + content.slice(end + close.length);
  }
  return content.length === 0 ? region : `${content}\n\n${region}`;
};

const minimalPlan = (
  patches: readonly { path: string; regionId: string; newBody: string }[] = [],
): KnowledgeMutationPlan => ({ patches } as unknown as KnowledgeMutationPlan);

// ── meeting projection fixtures ───────────────────────────────────────────────
const meetingFields = (over: Partial<Record<string, ExtractionField<unknown>>> = {}) => ({
  validated: true as const,
  fields: {
    title: backed("Q3 Planning Sync"),
    attendees: backed(["Alice", "Bob"]),
    decisions: backed(["Ship v0.2 by Friday"]),
    owner: backed("Alice"),
    dueDate: backed("2026-07-15"),
    ...over,
  },
});
const meetingNote = (v: ValidatedExtraction): NoteCreate => {
  const r = meetingOutputsProjection.project(v, WS, false);
  if (!isOk(r) || r.value.mutation.kind !== "create") throw new Error("expected a meeting create mutation");
  return r.value.mutation.note;
};

const projectNote = (title: string, slug = "proj-1"): NoteCreate => {
  const r = createProjectSyncOutputsProjection().project(
    { validated: true, fields: {} },
    { completedCount: 1, totalCount: 2, percentComplete: 50, perProvider: [] },
    WS,
    { projectId: "proj-1", title, slug, lifecycleState: "active" },
    "2026-07-10T00:00:00.000Z",
    false,
  );
  if (!isOk(r) || r.value.mutation.kind !== "create") throw new Error("expected a project create mutation");
  return r.value.mutation.note;
};

// ── the dispatcher (reuse, no fork) ───────────────────────────────────────────
describe("neutralizeFrontmatterValue (frontmatter dispatcher over the ONE neutralizer)", () => {
  it("neutralizes a string, maps over string[] elements, passes non-string/non-array through", () => {
    expect(neutralizeFrontmatterValue(`x ${MEET_OPEN} y`)).not.toContain("<!-- kw:region:");
    const arr = neutralizeFrontmatterValue([`a ${MEET_OPEN}`, "clean"]) as string[];
    expect(arr[0]).not.toContain("<!-- kw:region:");
    expect(arr[1]).toBe("clean");
    // clean values byte-identical (no-op)
    expect(neutralizeFrontmatterValue("clean title")).toBe("clean title");
    expect(neutralizeFrontmatterValue(["a", "b"])).toEqual(["a", "b"]);
    // non-string / non-array untouched (TBD sentinel, numbers, undefined)
    expect(neutralizeFrontmatterValue(42)).toBe(42);
    expect(neutralizeFrontmatterValue(undefined)).toBe(undefined);
    const sym = Symbol("TBD");
    expect(neutralizeFrontmatterValue(sym)).toBe(sym);
  });

  it("RECURSES into nested arrays (a marker in a string[][] element is still neutralized)", () => {
    const nested = neutralizeFrontmatterValue([[`a ${MEET_OPEN}`], ["clean"]]) as string[][];
    expect(nested[0]?.[0]).not.toContain("<!-- kw:region:");
    expect(nested[1]?.[0]).toBe("clean");
  });

  it("DELEGATES to neutralizeRegionMarkers verbatim (same transform, not a weaker fork)", () => {
    const s = `t ${MEET_OPEN} u`;
    expect(neutralizeFrontmatterValue(s)).toBe(neutralizeRegionMarkers(s));
  });

  it("is idempotent on strings and arrays", () => {
    const once = neutralizeFrontmatterValue(`x ${MEET_OPEN} y`);
    expect(neutralizeFrontmatterValue(once)).toBe(once);
  });
});

// ── ADD: both serialize branches independently pinned ─────────────────────────
describe("meeting frontmatter — SCALAR branch (title → serializeScalar YAML-quote path)", () => {
  it("a marker ONLY in the title leaves no marker in the serialized frontmatter; parseSections+checkOwnership pass", () => {
    const note = meetingNote(meetingFields({ title: backed(`Q3 ${MEET_OPEN} Sync`) }));
    // value neutralized at the source
    expect(String(note.frontmatter?.title)).not.toContain("<!-- kw:region:");
    expect(note.title).not.toContain("<!-- kw:region:");
    const rendered = renderNote(note);
    // no marker survives serialization into the frontmatter
    expect(frontmatterBlock(rendered).includes("<!-- kw:region:")).toBe(false);
    // parseSections over the WHOLE note ⇒ exactly the real body region, ZERO spurious frontmatter region
    expect(regionIds(rendered)).toEqual([MEETING_OUTPUTS_REGION]);
    // checkOwnership (create) passes — no malformed_marker
    expect(isOk(checkOwnership({ path: note.path, priorContent: undefined, nextContent: rendered, plan: minimalPlan() }))).toBe(true);
  });
});

describe("meeting frontmatter — ARRAY branch (decisions/attendees → serializeScalar JSON.stringify path)", () => {
  it("a marker ONLY in a decision string[] element leaves no marker in the serialized frontmatter; parseSections+checkOwnership pass", () => {
    const note = meetingNote(meetingFields({ decisions: backed([`Ship it ${MEET_OPEN} now`, "clean decision"]) }));
    const decisions = note.frontmatter?.decisions as readonly string[];
    expect(decisions[0]).not.toContain("<!-- kw:region:"); // array-map applied
    expect(decisions[1]).toBe("clean decision"); // clean element untouched
    const rendered = renderNote(note);
    // the JSON.stringify'd array carries no marker (the branch that silently regresses if the array-map is dropped)
    expect(frontmatterBlock(rendered).includes("<!-- kw:region:")).toBe(false);
    expect(regionIds(rendered)).toEqual([MEETING_OUTPUTS_REGION]);
    expect(isOk(checkOwnership({ path: note.path, priorContent: undefined, nextContent: rendered, plan: minimalPlan() }))).toBe(true);
  });

  it("a CLOSE + a FOREIGN-id marker inside an attendee element are both neutralized", () => {
    const note = meetingNote(meetingFields({ attendees: backed([`Alice ${MEET_CLOSE}`, `Bob <!-- kw:region:foreign -->`]) }));
    const rendered = renderNote(note);
    expect(frontmatterBlock(rendered).includes("<!-- kw:region:")).toBe(false);
    expect(frontmatterBlock(rendered).includes("<!-- /kw:region:")).toBe(false);
    expect(regionIds(rendered)).toEqual([MEETING_OUTPUTS_REGION]);
  });
});

// ── SAFETY: checkOwnership passes on create AND re-sync patch with a marker-valued frontmatter ──
describe("checkOwnership passes on a note whose model-derived frontmatter embedded a marker", () => {
  it("re-sync PATCH does not trip malformed_marker + preserves human content outside the region", () => {
    // A first-close note whose title+decision embedded markers (now neutralized frontmatter).
    const note = meetingNote(meetingFields({ title: backed(`Q3 ${MEET_OPEN} Sync`), decisions: backed([`Ship it ${MEET_OPEN}`]) }));
    const rendered = renderNote(note);
    // The user later adds their own section OUTSIDE the assistant region.
    const priorWithHuman = `${rendered}\n\n## My own notes\n- a human-owned line\n`;
    expect(regionIds(priorWithHuman)).toEqual([MEETING_OUTPUTS_REGION]); // still exactly one real region

    // Re-close / re-sync: patch the region body only.
    const newBody = neutralizeRegionMarkers("New decision");
    const patched = applyRegionPatchLike(priorWithHuman, MEETING_OUTPUTS_REGION, newBody);
    const res = checkOwnership({
      path: note.path,
      priorContent: priorWithHuman,
      nextContent: patched,
      plan: minimalPlan([{ path: note.path, regionId: MEETING_OUTPUTS_REGION, newBody }]),
    });
    expect(isOk(res)).toBe(true); // no malformed_marker, no ownership_violation
    expect(patched).toContain("## My own notes"); // human content survives
    expect(patched).toContain("- a human-owned line");
  });
});

// ── clean values byte-identical (common path unchanged) ───────────────────────
describe("clean model-derived frontmatter values are byte-identical (regression pin)", () => {
  it("a marker-free meeting note composes exactly as before the fix", () => {
    const note = meetingNote(meetingFields());
    expect(note.frontmatter?.title).toBe("Q3 Planning Sync");
    expect(note.frontmatter?.attendees).toEqual(["Alice", "Bob"]);
    expect(note.frontmatter?.decisions).toEqual(["Ship v0.2 by Friday"]);
    expect(note.title).toBe("Q3 Planning Sync");
    expect(regionIds(renderNote(note))).toEqual([MEETING_OUTPUTS_REGION]);
  });
});

// ── projectSync: the project title (scalar) is neutralized too ────────────────
describe("projectSync frontmatter — project title neutralization", () => {
  it("a marker in the project title is neutralized in note.title + frontmatter.title; parseSections/checkOwnership pass", () => {
    const note = projectNote(`Proj ${PROJ_OPEN} X`);
    expect(note.title).not.toContain("<!-- kw:region:");
    expect(String(note.frontmatter?.title)).not.toContain("<!-- kw:region:");
    const rendered = renderNote(note);
    expect(frontmatterBlock(rendered).includes("<!-- kw:region:")).toBe(false);
    expect(regionIds(rendered)).toEqual([PROJECT_STATUS_REGION]); // exactly the real body region
    expect(isOk(checkOwnership({ path: note.path, priorContent: undefined, nextContent: rendered, plan: minimalPlan() }))).toBe(true);
    // server-derived fields untouched (marker-free by construction)
    expect(note.frontmatter?.projectId).toBe("proj-1");
  });

  it("a marker in the project SLUG (same registry source as title) is neutralized too — no duplicate_region_id", () => {
    // slug from the same ProjectRegistryEntry as title; a marker-bearing slug would else serialize to a
    // spurious frontmatter region with the SAME id as the body ⇒ duplicate_region_id fail-closed rejection.
    const note = projectNote("Clean Project", `proj ${PROJ_OPEN}`);
    expect(String(note.frontmatter?.slug)).not.toContain("<!-- kw:region:");
    const rendered = renderNote(note);
    expect(frontmatterBlock(rendered).includes("<!-- kw:region:")).toBe(false);
    expect(regionIds(rendered)).toEqual([PROJECT_STATUS_REGION]); // exactly one real region, no duplicate
    expect(isOk(checkOwnership({ path: note.path, priorContent: undefined, nextContent: rendered, plan: minimalPlan() }))).toBe(true);
  });

  it("a clean project title composes byte-identically (regression pin)", () => {
    const note = projectNote("Clean Project");
    expect(note.title).toBe("Clean Project");
    expect(note.frontmatter?.title).toBe("Clean Project");
    expect(note.frontmatter?.slug).toBe("proj-1"); // clean slug unchanged
    expect(countMarkers(renderNote(note))).toBe(2); // exactly the wrapping region pair
  });
});
