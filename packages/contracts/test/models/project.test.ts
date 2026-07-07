// Project contract test (§13.5, §3/§6/§9). RED-first schema-snapshot freeze + behavior + the bi-temporal /
// lifecycle invariants. Mirrors the AuditRecord / Approval template. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import { ProjectSchema, PROJECT_SCHEMA_ID } from "../../src/models/project";
import { ProjectLifecycleState } from "../../src/models/shared-enums";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// A fully-populated valid project reused as the base for negative fixtures. lifecycleState === the head of the
// append-only timeline (idea → planning → active).
const validProject = {
  id: "proj-1",
  workspaceId: "personal-business",
  slug: "personal-business/projects/launch",
  title: "Launch the thing",
  lifecycleState: "active",
  timeline: [
    { state: "idea", eventTime: "2026-06-01T00:00:00.000Z", transactionTime: "2026-06-01T00:00:00.000Z" },
    { state: "planning", eventTime: "2026-06-05T00:00:00.000Z", transactionTime: "2026-06-05T00:00:01.000Z" },
    { state: "active", eventTime: "2026-06-10T00:00:00.000Z", transactionTime: "2026-06-10T00:00:02.000Z" },
  ],
  provenanceOrigin: "project_capture",
};

describe("Project contract — spec(§13.5/§3/§6/§9)", () => {
  // ── Frozen field-name set (hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(ProjectSchema, PROJECT_SCHEMA_ID))).toEqual(loadFieldSnapshot("project"));
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/project.schema.json", import.meta.url),
      emitJsonSchema(ProjectSchema, PROJECT_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a fully-valid project", () => {
    expect(ProjectSchema.safeParse(validProject).success).toBe(true);
  });

  it("rejects unknown top-level keys (.strict)", () => {
    expect(ProjectSchema.safeParse({ ...validProject, extra: 1 }).success).toBe(false);
  });

  it("rejects an empty id / workspaceId / slug / title (branded + min-length gates)", () => {
    for (const patch of [{ id: "" }, { workspaceId: "" }, { slug: "" }, { title: "" }]) {
      expect(ProjectSchema.safeParse({ ...validProject, ...patch }).success).toBe(false);
    }
  });

  it("requires a NON-EMPTY timeline (a project always has its inception entry)", () => {
    expect(ProjectSchema.safeParse({ ...validProject, timeline: [] }).success).toBe(false);
  });

  it("REJECTS a record whose lifecycleState disagrees with the latest timeline entry (the refine)", () => {
    // head is "active" but lifecycleState claims "done" — contradictory.
    expect(ProjectSchema.safeParse({ ...validProject, lifecycleState: "done" }).success).toBe(false);
  });

  it("accepts every lifecycle state as a valid current state (when the timeline head matches)", () => {
    for (const state of ProjectLifecycleState) {
      const rec = {
        ...validProject,
        lifecycleState: state,
        timeline: [{ state, eventTime: "2026-06-01T00:00:00.000Z", transactionTime: "2026-06-01T00:00:00.000Z" }],
      };
      expect(ProjectSchema.safeParse(rec).success, `state ${state}`).toBe(true);
    }
  });

  it("rejects an unknown lifecycle state", () => {
    expect(ProjectSchema.safeParse({ ...validProject, lifecycleState: "shipped" }).success).toBe(false);
  });

  it("accepts both new project provenance origins (project_capture, project_sync)", () => {
    for (const origin of ["project_capture", "project_sync"]) {
      expect(ProjectSchema.safeParse({ ...validProject, provenanceOrigin: origin }).success, origin).toBe(true);
    }
  });

  it("rejects a timeline entry with a non-ISO datetime or unknown state (nested .strict)", () => {
    const bad = { ...validProject, timeline: [{ state: "active", eventTime: "nope", transactionTime: "2026-06-10T00:00:02.000Z" }] };
    expect(ProjectSchema.safeParse(bad).success).toBe(false);
    const badKey = { ...validProject, timeline: [{ ...validProject.timeline[2], surprise: 1 }] };
    expect(ProjectSchema.safeParse(badKey).success).toBe(false);
  });
});
