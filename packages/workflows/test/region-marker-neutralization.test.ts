// spec(§6 / safety rule 1) — region-marker neutralization hardening (Phase 6/9 shared composers).
//
// Both region-body builders — `composeMeetingRegionBody` (meetingOutputs) + `composeRegionBody`
// (projectSyncOutputs) — run their assistant content through ONE shared `neutralizeRegionMarkers`
// (in noteSlug.ts) so a `kw:region` marker string embedded in the content can NEVER forge or break
// a region boundary in the KnowledgeWriter's `applyRegionPatch` (`indexOf(open)`/`indexOf(close)`)
// or in `parseSections`/`MARKER_RE`. The neutralization runs to a FIXPOINT (escaping `<!--`→`<\!--`
// only removes `<!--`, monotone-decreasing ⇒ terminates), is content-preserving + idempotent, and
// never fails-closed on marker content (graceful degrade). The load-bearing pins: (1) the
// compose→applyRegionPatch round-trip replaces EXACTLY the intended span (no over/under-replacement,
// human content outside the real markers untouched) and (2) clean content is byte-identical.
import { describe, it, expect } from "vitest";
import type { ExtractionField } from "@sow/domain";
import type { DeterministicProgress } from "../src/ports/projectSync";
import {
  neutralizeRegionMarkers,
  composeMeetingNote,
  composeProjectStatusNote,
  MEETING_OUTPUTS_REGION,
  PROJECT_STATUS_REGION,
} from "../src/activities/projections/noteSlug";
import { composeMeetingRegionBody } from "../src/activities/projections/meetingOutputs";
import { composeRegionBody } from "../src/activities/projections/projectSyncOutputs";

const backed = <T>(value: T): ExtractionField<T> => ({ value, evidenceRef: "transcript#L1" });

const MEET_OPEN = `<!-- kw:region:${MEETING_OUTPUTS_REGION} -->`;
const MEET_CLOSE = `<!-- /kw:region:${MEETING_OUTPUTS_REGION} -->`;
const PROJ_OPEN = `<!-- kw:region:${PROJECT_STATUS_REGION} -->`;

// Mirror of sections.ts `MARKER_RE` (the ws-tolerant parser + `parseSections` matcher). A survivor
// here is a stray region boundary `parseSections` would see.
const MARKER_RE = /<!-- (\/?)kw:region:([^\s>]+) -->/gu;
const countMarkers = (s: string): number => (s.match(MARKER_RE) ?? []).length;

/** True if `s` carries either exact boundary marker for `id` (what applyRegionPatch's indexOf targets). */
const hasExactMarker = (s: string, id: string): boolean =>
  s.includes(`<!-- kw:region:${id} -->`) || s.includes(`<!-- /kw:region:${id} -->`);

/**
 * Faithful mirror of the KnowledgeWriter's `applyRegionPatch` boundary search (writer.ts:495) — the
 * production consumer whose `indexOf(open)`/`indexOf(close)` must only ever find the REAL wrapping
 * pair. (These test bodies carry no frontmatter, so operating on the whole string == parseNote's body.)
 */
const applyRegionPatchLike = (body: string, id: string, newBody: string): string => {
  const open = `<!-- kw:region:${id} -->`;
  const close = `<!-- /kw:region:${id} -->`;
  const region = `${open}\n${newBody}\n${close}`;
  const start = body.indexOf(open);
  const end = body.indexOf(close);
  if (start !== -1 && end !== -1 && end > start) {
    return body.slice(0, start) + region + body.slice(end + close.length);
  }
  return body.length === 0 ? region : `${body}\n\n${region}`;
};

const progress = (completedCount: number, totalCount: number): DeterministicProgress => ({
  completedCount,
  totalCount,
  percentComplete: totalCount === 0 ? 0 : Math.round((completedCount / totalCount) * 100),
  perProvider: [],
});

describe("neutralizeRegionMarkers (shared region-marker neutralization)", () => {
  // ── 4. clean_content_is_noop (the common path is byte-unchanged) ──────────────
  it("clean content with no marker string is byte-identical (no-op regression pin)", () => {
    const clean = "# Q3 Sync\n\n## Attendees\n- Alice\n\n## Decisions\n- Ship v0.2\n\n<not a marker>";
    expect(neutralizeRegionMarkers(clean)).toBe(clean);
    expect(neutralizeRegionMarkers("")).toBe("");
  });

  // ── 1. content_embedded_open_marker_neutralized ───────────────────────────────
  it("an embedded OPEN marker is neutralized — no marker survives, human text preserved", () => {
    const n = neutralizeRegionMarkers(`Decision: ${MEET_OPEN} ship it`);
    expect(countMarkers(n)).toBe(0);
    expect(hasExactMarker(n, MEETING_OUTPUTS_REGION)).toBe(false);
    expect(n).toContain("Decision:");
    expect(n).toContain("ship it");
    expect(n).toContain("kw:region"); // defused, NOT deleted (text preserved)
  });

  // ── 3. foreign_and_close_markers_neutralized ──────────────────────────────────
  it("embedded CLOSE + FOREIGN-region-id markers are both neutralized (no boundary forgeable)", () => {
    const n = neutralizeRegionMarkers(`x ${MEET_CLOSE} y <!-- kw:region:some-other-region --> z`);
    expect(countMarkers(n)).toBe(0);
    expect(hasExactMarker(n, MEETING_OUTPUTS_REGION)).toBe(false);
    expect(hasExactMarker(n, "some-other-region")).toBe(false);
  });

  it("case/whitespace marker variants (the superset regex) are all neutralized", () => {
    const variants = [
      "<!--kw:region:x-->", // no spaces
      "<!--   kw:region:x   -->", // extra spaces
      `<!-- /kw:region:x -->`, // close
      "<!-- KW:REGION:x -->", // uppercase (superset regex is case-insensitive)
    ];
    for (const v of variants) {
      const n = neutralizeRegionMarkers(`pre ${v} post`);
      expect(countMarkers(n)).toBe(0);
      expect(n).toContain("pre ");
      expect(n).toContain(" post");
    }
  });

  // ── a. nested no-space marker (fixpoint peels every layer) ────────────────────
  it("a NO-SPACE nested marker is fully defused by the fixpoint (no <!-- survives)", () => {
    const n = neutralizeRegionMarkers(`<!--kw:region:x<!--kw:region:y-->`);
    expect(n.includes("<!--")).toBe(false); // BOTH openers escaped
    expect(countMarkers(n)).toBe(0);
  });

  // ── b. spaced nested marker (greedy-id swallow — fixpoint still leaves zero stray) ──
  it("a SPACED nested marker leaves ZERO stray region (parseSections/MARKER_RE sees none) + no real-id forgeable", () => {
    const n = neutralizeRegionMarkers(`<!-- kw:region:x <!-- kw:region:y --> -->`);
    expect(countMarkers(n)).toBe(0); // no MARKER_RE-visible boundary
    expect(n.includes(`<!-- kw:region:x -->`)).toBe(false);
    expect(n.includes(`<!-- kw:region:y -->`)).toBe(false);
  });

  // ── c. a marker embedded in what would be a region id ─────────────────────────
  it("a marker embedded inside a region id is neutralized — no real-region-id boundary survives", () => {
    const crafted = `<!--kw:region:${MEETING_OUTPUTS_REGION}<!--kw:region:${MEETING_OUTPUTS_REGION}-->text${MEET_CLOSE}`;
    const n = neutralizeRegionMarkers(crafted);
    expect(countMarkers(n)).toBe(0);
    expect(hasExactMarker(n, MEETING_OUTPUTS_REGION)).toBe(false);
  });

  // ── 8. idempotence ────────────────────────────────────────────────────────────
  it("neutralization is idempotent (a second pass is a no-op)", () => {
    const inputs = [
      "clean text",
      `x ${MEET_OPEN} y`,
      `<!--kw:region:a<!--kw:region:b-->`,
      `<!-- kw:region:x <!-- kw:region:y --> -->`,
    ];
    for (const s of inputs) {
      const once = neutralizeRegionMarkers(s);
      expect(neutralizeRegionMarkers(once)).toBe(once);
    }
  });

  // ── 5. graceful_not_failclosed (never throws) ─────────────────────────────────
  it("marker content composes gracefully — never throws (no fail-closed)", () => {
    expect(() => neutralizeRegionMarkers(MEET_OPEN.repeat(200))).not.toThrow();
    expect(() => neutralizeRegionMarkers(`<!--kw:region:${"x".repeat(500)}-->`)).not.toThrow();
  });

  it("does NOT catastrophically backtrack on a long whitespace run after '<!--' (ReDoS regression)", () => {
    // With the pre-fix `\s*\/?\s*` this took ~90s (vitest would time out at the default 5s); the
    // single-class `[\s/]*` is linear (~1ms). A `<!--` followed by 500K whitespace + no marker.
    const pathological = `<!--${" \t\n".repeat(170000)}`;
    expect(() => neutralizeRegionMarkers(pathological)).not.toThrow();
  });
});

// ── 2 + 7. boundary-integrity round-trip through applyRegionPatch (THE SAFETY PIN) ──
describe("region boundary integrity — compose → applyRegionPatch round-trip", () => {
  it("SAFETY: an embedded CLOSE marker cannot hijack the boundary — exactly the wrapping span is replaced", () => {
    const human = "# My Meeting\n\nHuman-owned notes.\n\n";
    const rawInner = `Decision: ship it ${MEET_CLOSE} and keep going`;
    const inner = neutralizeRegionMarkers(rawInner); // what the builder emits (shared helper)
    const note = human + composeMeetingNote(inner); // create body, with human content OUTSIDE the region

    // exactly the wrapping pair — no content-embedded marker
    expect(countMarkers(note)).toBe(2);

    // re-close patch: replace the region body → EXACTLY the wrapping span is replaced
    const patched = applyRegionPatchLike(note, MEETING_OUTPUTS_REGION, "New decision");
    expect(patched).toBe(human + composeMeetingNote("New decision"));
    expect(patched.startsWith(human)).toBe(true); // human content untouched

    // NON-VACUOUS control: WITHOUT neutralization the embedded close hijacks indexOf ⇒ corruption
    const rawNote = human + composeMeetingNote(rawInner);
    const rawPatched = applyRegionPatchLike(rawNote, MEETING_OUTPUTS_REGION, "New decision");
    expect(rawPatched).not.toBe(human + composeMeetingNote("New decision"));
  });

  it("create-region-inner === re-close patch newBody EVEN when the source embeds a marker (byte-parity)", () => {
    const rawInner = `status ${PROJ_OPEN} update`;
    const inner = neutralizeRegionMarkers(rawInner);
    // create wraps the neutralized inner; the patch newBody IS the neutralized inner ⇒ byte-identical region.
    const createRegion = composeMeetingNote(inner);
    const patched = applyRegionPatchLike(createRegion, MEETING_OUTPUTS_REGION, inner);
    expect(patched).toBe(createRegion); // reconstructs byte-identically ⇒ create→re-close never drifts
  });
});

// ── 6. both region-body builders apply the SAME shared neutralization ─────────────
describe("both inner-body builders share the one neutralization", () => {
  it("composeMeetingRegionBody neutralizes an embedded marker in the meeting content", () => {
    const body = composeMeetingRegionBody({
      title: backed("Q3 Planning Sync"),
      attendees: backed(["Alice", "Bob"]),
      decisions: backed([`ship it ${MEET_OPEN} now`]),
    });
    expect(countMarkers(body)).toBe(0);
    expect(hasExactMarker(body, MEETING_OUTPUTS_REGION)).toBe(false);
    // already a fixpoint ⇒ the shared neutralization was applied
    expect(neutralizeRegionMarkers(body)).toBe(body);
    // content preserved (regression: the render still carries the sections)
    expect(body).toContain("## Decisions");
  });

  it("composeRegionBody (projectSync) neutralizes an embedded marker in the project content", () => {
    const body = composeRegionBody(
      progress(1, 2),
      {
        blockers: [backed(`blocked by ${PROJ_OPEN} thing`)],
        waitingItems: [],
        nextActions: [],
      },
      undefined,
      "2026-07-10T00:00:00.000Z",
    );
    expect(countMarkers(body)).toBe(0);
    expect(hasExactMarker(body, PROJECT_STATUS_REGION)).toBe(false);
    expect(neutralizeRegionMarkers(body)).toBe(body);
    expect(body).toContain("## Progress"); // content preserved
  });

  it("both builders treat the SAME embedded marker identically (one shared helper, no divergence)", () => {
    const marker = `<!-- kw:region:some-region -->`;
    const meeting = composeMeetingRegionBody({
      title: backed(`T ${marker}`),
      attendees: backed([]),
      decisions: backed([]),
    });
    const project = composeRegionBody(
      progress(0, 0),
      { blockers: [backed(`B ${marker}`)], waitingItems: [], nextActions: [] },
      undefined,
      "t",
    );
    // neither surfaces the marker; both are neutralization fixpoints (identical treatment)
    expect(countMarkers(meeting)).toBe(0);
    expect(countMarkers(project)).toBe(0);
  });
});

// ── the H1 title (outside the region) is an equal forgery vector — neutralize it too ──
describe("composeProjectStatusNote — H1 title neutralization (outside the region)", () => {
  it("a marker embedded in the title cannot forge a boundary before the real region open", () => {
    const note = composeProjectStatusNote(`Proj ${PROJ_OPEN} X`, "region body");
    // exactly the wrapping pair — the title marker (which would sit BEFORE the real open) is defused
    expect(countMarkers(note)).toBe(2);
    // the real open is still the FIRST region-open occurrence (indexOf finds the wrapping one)
    expect(note.indexOf(PROJ_OPEN)).toBe(note.lastIndexOf(PROJ_OPEN));
  });

  it("a clean title composes exactly as before (regression pin)", () => {
    const note = composeProjectStatusNote("Clean Project", "body");
    expect(note).toBe(`# Clean Project — Status\n\n${PROJ_OPEN}\nbody\n<!-- /kw:region:${PROJECT_STATUS_REGION} -->\n`);
  });
});
