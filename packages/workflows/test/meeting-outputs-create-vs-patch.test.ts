// spec(§9 / §6 / task 7-hardening) — meeting-outputs create-vs-patch parity (mirrors projectSync W1, `9288bcd`).
//
// The meeting-outputs projection now emits a discriminated create|patch mutation: a FIRST close (note absent) →
// a full NoteCreate; a RE-CLOSE / re-sync (note present) → a region NotePatch of the `meeting-outputs` region —
// NOT a clobbering second NoteCreate (a NoteCreate over an existing note blindly overwrites the whole file at the
// KnowledgeWriter's project step, destroying human content). The patch's newBody is BYTE-IDENTICAL to the create
// note's region inner, so create→re-close never drifts. The WS-8-scoped note-exists probe is fail-closed (a probe
// error fails the build, never a guessed create-vs-patch). §6: content OUTSIDE the region markers is preserved by
// `applyRegionPatch` (tested at the KW layer).
import { describe, it, expect } from "vitest";
import { isOk, isErr, workspaceId, sourceId } from "@sow/contracts";
import type { WorkspaceId, SourceRef, NoteCreate, NotePatch } from "@sow/contracts";
import type { ExtractionField } from "@sow/domain";
import {
  meetingOutputsProjection,
  composeMeetingRegionBody,
} from "../src/activities/projections/meetingOutputs";
import { MEETING_OUTPUTS_REGION } from "../src/activities/projections/noteSlug";
import { createBuildOutputsActivity } from "../src/activities/buildOutputs";
import type { ValidatedExtraction } from "../src/ports/meetingCloseout";
import { FakeNoteExistsReader } from "./support/project-sync-fakes";

const WS: WorkspaceId = workspaceId("ws-employer");
const meetingSourceRef: SourceRef = { sourceId: sourceId("src-meeting-1") };
const backed = <T>(value: T, evidenceRef = "transcript#L1"): ExtractionField<T> => ({ value, evidenceRef });
const fullValidated = (): ValidatedExtraction => ({
  validated: true,
  fields: {
    title: backed("Q3 Planning Sync"),
    attendees: backed(["Alice", "Bob"]),
    decisions: backed(["Ship v0.2 by Friday"]),
  },
});

const project = (noteExists: boolean, ws: WorkspaceId = WS) =>
  meetingOutputsProjection.project(fullValidated(), ws, noteExists);
const noteOf = (r: ReturnType<typeof project>): NoteCreate => {
  if (!isOk(r)) throw new Error("expected ok");
  if (r.value.mutation.kind !== "create") throw new Error("expected a create mutation");
  return r.value.mutation.note;
};
const patchOf = (r: ReturnType<typeof project>): NotePatch => {
  if (!isOk(r)) throw new Error("expected ok");
  if (r.value.mutation.kind !== "patch") throw new Error("expected a patch mutation");
  return r.value.mutation.patch;
};

/** Extract the INNER content between the meeting-outputs region markers of a created note body. */
const regionInner = (body: string): string => {
  const open = `<!-- kw:region:${MEETING_OUTPUTS_REGION} -->`;
  const close = `<!-- /kw:region:${MEETING_OUTPUTS_REGION} -->`;
  const s = body.indexOf(open);
  const e = body.indexOf(close);
  if (s === -1 || e === -1) throw new Error("the created note carries no meeting-outputs region markers");
  // framing is `${open}\n${inner}\n${close}` — strip the bracketing newlines.
  return body.slice(s + open.length + 1, e - 1);
};

describe("meetingOutputsProjection — create-vs-patch (W1 parity)", () => {
  it("first_close_emits_notecreate", () => {
    const r = project(false);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.mutation.kind).toBe("create");
    const note = noteOf(r);
    // the created note wraps the region; its INNER === today's composeBody output (byte-stable content pin)
    expect(regionInner(note.body)).toBe(composeMeetingRegionBody(fullValidated().fields));
    // the content itself is unchanged from the pre-slice projection (regression pin)
    expect(regionInner(note.body)).toContain("# Q3 Planning Sync");
    expect(regionInner(note.body)).toContain("## Attendees");
    expect(regionInner(note.body)).toContain("## Decisions");
    // the raw title is preserved for display; frontmatter unchanged
    expect(note.title).toBe("Q3 Planning Sync");
    expect(note.frontmatter?.title).toBe("Q3 Planning Sync");
  });

  it("reclose_emits_region_notepatch", () => {
    const r = project(true);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.mutation.kind).toBe("patch");
    const patch = patchOf(r);
    expect(patch.regionId).toBe(MEETING_OUTPUTS_REGION);
    expect(patch.newBody).toBe(composeMeetingRegionBody(fullValidated().fields));
    // the patch targets the SAME note path the create would write (single authority)
    expect(patch.path).toBe(noteOf(project(false)).path);
  });

  it("create_region_equals_patch_newbody", () => {
    // the W1 byte-idempotent invariant: create-region-inner === patch-newBody ⇒ create→re-close never drifts.
    expect(regionInner(noteOf(project(false)).body)).toBe(patchOf(project(true)).newBody);
  });
});

describe("createBuildOutputsActivity — create-vs-patch routing + WS-8 + fail-closed", () => {
  const mkPort = (reader: FakeNoteExistsReader) =>
    createBuildOutputsActivity({
      projection: meetingOutputsProjection,
      sourceRef: meetingSourceRef,
      planIdentity: { closeout: "wf-1" },
      noteExists: reader,
    });

  it("existence_check_is_ws8_scoped — first close probes the workspace-rooted path + routes into plan.creates[]", async () => {
    const reader = new FakeNoteExistsReader({ exists: false });
    const res = await mkPort(reader).build(fullValidated(), WS);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    // WS-8: exactly one probe, workspace-rooted, single filename segment, no traversal — never a foreign ws.
    expect(reader.paths).toHaveLength(1);
    const probed = reader.paths[0]!;
    expect(probed.startsWith(`meetings/${String(WS)}/`)).toBe(true);
    expect(probed).not.toContain("..");
    expect(probed.split("/")).toHaveLength(3);
    // the probe path === the create's note path (the single meetingNotePath authority — can't diverge)
    expect(probed).toBe(res.value.plan.creates[0]?.path);
    // first close ⇒ a create, no patch
    expect(res.value.plan.creates).toHaveLength(1);
    expect(res.value.plan.patches).toHaveLength(0);
  });

  it("re-close routes into plan.patches[] — NOT a second create (no clobber)", async () => {
    const res = await mkPort(new FakeNoteExistsReader({ exists: true })).build(fullValidated(), WS);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.plan.creates).toHaveLength(0);
    expect(res.value.plan.patches).toHaveLength(1);
    expect(res.value.plan.patches[0]?.regionId).toBe(MEETING_OUTPUTS_REGION);
  });

  it("fail_closed_direction — a note-exists probe ERROR fails the build CLOSED (build_failed, no commit)", async () => {
    const res = await mkPort(new FakeNoteExistsReader({ failWith: "read_failed" })).build(fullValidated(), WS);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("build_failed"); // never a guessed create-vs-patch under uncertainty
  });
});
