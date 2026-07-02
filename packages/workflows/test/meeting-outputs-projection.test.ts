// spec(§9 / task 7.6) — the MEETING-CLOSEOUT OutputsProjection unit tests.
//
// The projection (`meetingOutputsProjection`) is the PURE mapper the buildOutputs
// ACTIVITY is configured with: it turns a VALIDATED extraction + the correlation-
// bound workspaceId into a meeting NoteCreate + the external-action descriptors.
// These tests pin the SAFETY properties the projection must uphold — the same
// no-inference / workspace-isolation / evidence-only / fail-closed guarantees the
// governance seam (buildOutputs.ts) exists to enforce, but exercised DIRECTLY on
// the projection so the mapping logic itself is proven, not just the wrapper:
//
//   • no-inference    — a validated set MISSING an owner → the note frontmatter
//                       owner is the TBD sentinel (never invented) AND no action is
//                       created for the ownerless item (fail-closed, no guessed owner).
//   • workspace-stamp — the note targets the PASSED workspaceId; a validated field
//                       literally named "workspaceId" carrying a DIFFERENT value is
//                       IGNORED (a caller field can never redirect the durable write).
//   • evidence-only   — only keys present in `validated.fields` surface; an unknown
//                       extra field is ignored, never fabricated.
//   • fail-closed     — an empty / untitled validated set → err(unmappable_extraction),
//                       no partial note.
//   • determinism     — same (validated, workspaceId) ⇒ identical output.
//
// Plus one INTEGRATION test that createBuildOutputsActivity({ projection:
// meetingOutputsProjection, … }) yields a KnowledgeMutationPlan whose workspaceId
// === the passed workspaceId (the projection composes correctly with the activity).
import { describe, it, expect } from "vitest";
import { ok, isOk, isErr, workspaceId, sourceId } from "@sow/contracts";
import type { WorkspaceId, SourceRef } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { ExtractionField } from "@sow/domain";
import { meetingOutputsProjection } from "../src/activities/projections/meetingOutputs";
import { createBuildOutputsActivity } from "../src/activities/buildOutputs";
import type { ValidatedExtraction } from "../src/ports/meetingCloseout";

// ---------------------------------------------------------------------------
// Fixtures — validated field sets under the meeting.close field-name convention.
// ---------------------------------------------------------------------------

const WS: WorkspaceId = workspaceId("ws-employer");
const meetingSourceRef: SourceRef = { sourceId: sourceId("src-meeting-1") };

/** An evidence-backed scalar field (passes the no-inference gate). */
function backed<T>(value: T, evidenceRef = "transcript#L1"): ExtractionField<T> {
  return { value, evidenceRef };
}

/** The TBD-sentinel field (always no-inference-legal). */
function tbd(): ExtractionField<unknown> {
  return { value: TBD };
}

/**
 * A well-formed validated extraction: an evidence-backed title + attendees +
 * decisions, and one action item carrying an evidence-backed owner + title.
 */
function fullValidated(
  fields: Record<string, ExtractionField<unknown>> = {},
): ValidatedExtraction {
  return {
    validated: true,
    fields: {
      title: backed("Q3 Planning Sync"),
      attendees: backed(["Alice", "Bob"]),
      decisions: backed(["Ship v0.2 by Friday"]),
      // one action item: evidence-backed owner + title ⇒ derives an action.
      "actionItems.0.title": backed("Draft the migration plan"),
      "actionItems.0.owner": backed("Alice", "transcript#L42"),
      ...fields,
    },
  };
}

// ---------------------------------------------------------------------------
// workspace-stamp — the write targets the PASSED workspaceId, never a field.
// ---------------------------------------------------------------------------

describe("spec(§9 WS-2/WS-4) meetingOutputsProjection — the note targets the PASSED workspaceId", () => {
  it("places the note under the PASSED workspace meetings area (not any field)", () => {
    const res = meetingOutputsProjection.project(fullValidated(), WS);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    // The note path is derived from the passed workspaceId.
    expect(res.value.note.path).toContain(String(WS));
    expect(res.value.note.path.startsWith("meetings/")).toBe(true);
  });

  it("IGNORES a validated field literally named 'workspaceId' carrying a DIFFERENT value (cannot redirect the write)", () => {
    const hijack = fullValidated({
      workspaceId: backed("ws-attacker", "transcript#L99"),
    });
    const res = meetingOutputsProjection.project(hijack, WS);
    if (!isOk(res)) throw new Error("expected ok");
    // The path is bound to the PASSED workspace, never the injected field value.
    expect(res.value.note.path).toContain(String(WS));
    expect(res.value.note.path).not.toContain("ws-attacker");
    // The hijack value must never leak into frontmatter as a workspace redirect.
    expect(res.value.note.frontmatter?.workspaceId).not.toBe("ws-attacker");
  });

  it("SLUGS an adversarial `../` title so it cannot inject path traversal into note.path (WS-4 durable-write escape)", () => {
    // The title passed no-inference (it is evidence-backed) — only its CONTENT is
    // adversarial. Raw-interpolated it would make note.path escape the bound vault
    // after join(root, path). Slugging keeps it a single contained filename segment.
    const evil = fullValidated({
      title: backed("../../../ws-personal/secrets/exfil", "transcript#L1"),
    });
    const res = meetingOutputsProjection.project(evil, WS);
    if (!isOk(res)) throw new Error("expected ok");
    const p = res.value.note.path;
    expect(p.startsWith(`meetings/${String(WS)}/`)).toBe(true);
    expect(p).not.toContain("..");
    // Exactly meetings/<ws>/<one-filename>.md — the title cannot add a path segment.
    expect(p.split("/")).toHaveLength(3);
    expect(p.endsWith(".md")).toBe(true);
    // The RAW title is still preserved for display (never in the path).
    expect(res.value.note.title).toBe("../../../ws-personal/secrets/exfil");
  });

  it("a title with NO path-safe characters (all traversal punctuation) fails closed → unmappable_extraction (never a stray path)", () => {
    const res = meetingOutputsProjection.project(
      fullValidated({ title: backed("../..", "transcript#L1") }),
      WS,
    );
    expect(isOk(res)).toBe(false);
    if (isOk(res)) return;
    expect(res.error.code).toBe("unmappable_extraction");
  });
});

// ---------------------------------------------------------------------------
// no-inference — missing owner ⇒ TBD sentinel + NO action for the ownerless item.
// ---------------------------------------------------------------------------

describe("spec(§9 REQ-F-017) meetingOutputsProjection — no-inference: never invents an owner", () => {
  it("a validated set MISSING an owner → the note frontmatter owner is the TBD sentinel (not invented)", () => {
    // title present so the set is mappable; no top-level `owner` field at all.
    const noOwner: ValidatedExtraction = {
      validated: true,
      fields: {
        title: backed("Standup"),
        decisions: backed(["Continue as planned"]),
      },
    };
    const res = meetingOutputsProjection.project(noOwner, WS);
    if (!isOk(res)) throw new Error("expected ok");
    expect(res.value.note.frontmatter?.owner).toBe(TBD);
  });

  it("an action item MISSING an evidence-backed owner gets NO action (fail-closed, no guessed owner)", () => {
    const ownerlessItem: ValidatedExtraction = {
      validated: true,
      fields: {
        title: backed("Retro"),
        // action item with a title but NO owner field ⇒ must NOT derive an action.
        "actionItems.0.title": backed("Write the postmortem"),
      },
    };
    const res = meetingOutputsProjection.project(ownerlessItem, WS);
    if (!isOk(res)) throw new Error("expected ok");
    expect(res.value.actions).toHaveLength(0);
  });

  it("an action item whose owner is the TBD sentinel gets NO action (TBD is not an owner)", () => {
    const tbdOwner: ValidatedExtraction = {
      validated: true,
      fields: {
        title: backed("Sync"),
        "actionItems.0.title": backed("Follow up with legal"),
        "actionItems.0.owner": tbd(),
      },
    };
    const res = meetingOutputsProjection.project(tbdOwner, WS);
    if (!isOk(res)) throw new Error("expected ok");
    expect(res.value.actions).toHaveLength(0);
  });

  it("ONLY the action items with an evidence-backed owner + title derive an action", () => {
    const mixed: ValidatedExtraction = {
      validated: true,
      fields: {
        title: backed("Planning"),
        // item 0: owner + title ⇒ action.
        "actionItems.0.title": backed("Ship the RFC"),
        "actionItems.0.owner": backed("Alice", "transcript#L10"),
        // item 1: title only, no owner ⇒ NO action.
        "actionItems.1.title": backed("Investigate flake"),
        // item 2: owner only, no title ⇒ NO action (nothing to title the todo).
        "actionItems.2.owner": backed("Bob", "transcript#L20"),
      },
    };
    const res = meetingOutputsProjection.project(mixed, WS);
    if (!isOk(res)) throw new Error("expected ok");
    expect(res.value.actions).toHaveLength(1);
    const action = res.value.actions[0]!;
    expect(action.targetSystem).toBe("todoist");
    expect(action.payload.title).toBe("Ship the RFC");
    expect(action.payload.owner).toBe("Alice");
  });
});

// ---------------------------------------------------------------------------
// evidence-only — only known validated keys surface; extras are ignored.
// ---------------------------------------------------------------------------

describe("spec(§9 inv-3) meetingOutputsProjection — evidence-only: never fabricates a key", () => {
  it("an unknown extra validated field is IGNORED (not surfaced into frontmatter)", () => {
    const withExtra = fullValidated({
      totallyUnknownField: backed("some value", "transcript#L7"),
    });
    const res = meetingOutputsProjection.project(withExtra, WS);
    if (!isOk(res)) throw new Error("expected ok");
    expect(res.value.note.frontmatter?.totallyUnknownField).toBeUndefined();
  });

  it("frontmatter carries ONLY the convention field names (title/attendees/decisions/owner/dueDate)", () => {
    const res = meetingOutputsProjection.project(fullValidated(), WS);
    if (!isOk(res)) throw new Error("expected ok");
    const keys = Object.keys(res.value.note.frontmatter ?? {}).sort();
    // No fabricated key beyond the documented convention set.
    const allowed = new Set([
      "title",
      "attendees",
      "decisions",
      "owner",
      "dueDate",
    ]);
    for (const k of keys) {
      expect(allowed.has(k)).toBe(true);
    }
  });

  it("an evidence-backed title surfaces its concrete value into frontmatter", () => {
    const res = meetingOutputsProjection.project(fullValidated(), WS);
    if (!isOk(res)) throw new Error("expected ok");
    expect(res.value.note.frontmatter?.title).toBe("Q3 Planning Sync");
  });
});

// ---------------------------------------------------------------------------
// fail-closed — empty / untitled validated set ⇒ err(unmappable_extraction).
// ---------------------------------------------------------------------------

describe("spec(§9 inv-3) meetingOutputsProjection — fail-closed: no title/evidence ⇒ unmappable_extraction", () => {
  it("an EMPTY validated field set → err(unmappable_extraction), no partial note", () => {
    const empty: ValidatedExtraction = { validated: true, fields: {} };
    const res = meetingOutputsProjection.project(empty, WS);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("unmappable_extraction");
  });

  it("a validated set with NO title (the note anchor) → err(unmappable_extraction)", () => {
    const untitled: ValidatedExtraction = {
      validated: true,
      fields: { decisions: backed(["something"]) },
    };
    const res = meetingOutputsProjection.project(untitled, WS);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("unmappable_extraction");
  });

  it("a title present ONLY as the TBD sentinel (no concrete anchor) → err(unmappable_extraction)", () => {
    const tbdTitle: ValidatedExtraction = {
      validated: true,
      fields: { title: tbd(), decisions: backed(["x"]) },
    };
    const res = meetingOutputsProjection.project(tbdTitle, WS);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("unmappable_extraction");
  });
});

// ---------------------------------------------------------------------------
// determinism — same (validated, workspaceId) ⇒ identical output.
// ---------------------------------------------------------------------------

describe("spec(§9 inv-5) meetingOutputsProjection — deterministic", () => {
  it("same (validated, workspaceId) ⇒ identical note + actions (replay-stable)", () => {
    const a = meetingOutputsProjection.project(fullValidated(), WS);
    const b = meetingOutputsProjection.project(fullValidated(), WS);
    if (!isOk(a) || !isOk(b)) throw new Error("expected ok");
    expect(b.value).toStrictEqual(a.value);
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION — the projection composes with createBuildOutputsActivity, and the
// derived KnowledgeMutationPlan targets the PASSED workspaceId.
// ---------------------------------------------------------------------------

describe("spec(§9 WS-2) meetingOutputsProjection ∘ createBuildOutputsActivity — plan.workspaceId === passed workspaceId", () => {
  it("the derived plan's workspaceId is the PASSED workspaceId", async () => {
    const port = createBuildOutputsActivity({
      projection: meetingOutputsProjection,
      sourceRef: meetingSourceRef,
      planIdentity: { closeout: "wf-1" },
    });
    const res = await port.build(fullValidated(), workspaceId("ws-bound"));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.plan.workspaceId).toBe(workspaceId("ws-bound"));
    // The plan carries the derived meeting note as its sole create.
    expect(res.value.plan.creates).toHaveLength(1);
    expect(res.value.plan.creates[0]?.path).toContain("ws-bound");
    // One evidence-backed action item ⇒ one derived external action.
    expect(res.value.actions).toHaveLength(1);
  });

  it("an unmappable validated set folds to the activity's err (no plan built)", async () => {
    const port = createBuildOutputsActivity({
      projection: meetingOutputsProjection,
      sourceRef: meetingSourceRef,
      planIdentity: { closeout: "wf-1" },
    });
    const res = await port.build({ validated: true, fields: {} }, workspaceId("ws-bound"));
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("unmappable_extraction");
  });
});
