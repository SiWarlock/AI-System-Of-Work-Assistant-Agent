// P3 / §13.5 — createBuildSyncOutputsActivity: the derived KnowledgeMutationPlan carries the correct provenance
// (P1 added the `project_sync` ProvenanceOrigin member) AND routes the projection's create-vs-patch mutation into
// the plan's creates[]/patches[] via a WS-8-scoped note-exists probe (first sync → NoteCreate; re-sync → region
// NotePatch; a probe failure / no safe anchor fails CLOSED → build_failed, NO commit).
import { describe, it, expect } from "vitest";
import { ok } from "@sow/contracts";
import type { Result, WorkspaceId, SourceId } from "@sow/contracts";
import { createBuildSyncOutputsActivity } from "../src/activities/deterministicProgress";
import type { SyncOutputsProjection } from "../src/activities/deterministicProgress";
import type {
  ValidatedNarrative,
  DeterministicProgress,
  BuildSyncOutputsFailure,
  NoteExistsReader,
} from "../src/ports/projectSync";
import { FakeNoteExistsReader } from "./support/project-sync-fakes";

const validated: ValidatedNarrative = { validated: true, fields: {} };
const progress: DeterministicProgress = { completedCount: 1, totalCount: 2, percentComplete: 50, perProvider: [] };
const WS = "personal-business" as WorkspaceId;

/**
 * A minimal projection that HONORS the create-vs-patch flag: it emits a NoteCreate when the note does not exist
 * and a region NotePatch when it does. The activity wraps the mutation into the plan's creates[]/patches[].
 */
const projection: SyncOutputsProjection = {
  project(
    _validated,
    _progress,
    ws,
    identity,
    _updatedAt,
    noteExists,
  ): Result<
    {
      readonly mutation:
        | { readonly kind: "create"; readonly note: import("@sow/contracts").NoteCreate }
        | { readonly kind: "patch"; readonly patch: import("@sow/contracts").NotePatch };
      readonly dashboard: Record<string, unknown>;
      readonly actions: readonly never[];
    },
    BuildSyncOutputsFailure
  > {
    const path = `projects/${String(ws)}/${identity.projectId}.md`;
    if (noteExists) {
      return ok({
        mutation: { kind: "patch", patch: { path, regionId: "project-status", newBody: "## Status\n50%" } },
        dashboard: {},
        actions: [],
      });
    }
    return ok({
      mutation: { kind: "create", note: { path, body: "## Status\n50%" } },
      dashboard: {},
      actions: [],
    });
  },
};
const sourceRef = { sourceId: "src-1" as SourceId };
const deps = { projection, sourceRef, planIdentity: { project: "x" }, noteExists: new FakeNoteExistsReader() };
const identity = { projectId: "x", title: "X", slug: "personal-business/x", lifecycleState: "active" as const };
const AT = "2026-07-07T00:00:00.000Z";

describe("createBuildSyncOutputsActivity — derived-plan provenance (§13.5)", () => {
  it("defaults the derived plan's provenanceOrigin to project_sync (the arch_gap P1 closed)", async () => {
    const port = createBuildSyncOutputsActivity(deps);
    const r = await port.build(validated, progress, WS, identity, AT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.plan.provenanceOrigin).toBe("project_sync");
  });

  it("respects an explicit provenanceOrigin override", async () => {
    const port = createBuildSyncOutputsActivity({ ...deps, provenanceOrigin: "project_capture" });
    const r = await port.build(validated, progress, WS, identity, AT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.plan.provenanceOrigin).toBe("project_capture");
  });

  it("stamps the plan's workspaceId from the PASSED workspace (WS-2/WS-4) + cites the sourceRef (REQ-F-006)", async () => {
    const port = createBuildSyncOutputsActivity(deps);
    const r = await port.build(validated, progress, WS, identity, AT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(String(r.value.plan.workspaceId)).toBe("personal-business");
      expect(r.value.plan.sourceRefs.map((s) => String(s.sourceId))).toEqual(["src-1"]);
      expect(r.value.plan.confidence).toBe(1); // deterministic facts, not a model estimate (REQ-F-011)
    }
  });
});

describe("createBuildSyncOutputsActivity — create-vs-patch routing (§13.5)", () => {
  it("first sync (note absent) → a NoteCreate in plan.creates, patches empty", async () => {
    const port = createBuildSyncOutputsActivity({ ...deps, noteExists: new FakeNoteExistsReader({ exists: false }) });
    const r = await port.build(validated, progress, WS, identity, AT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.plan.creates).toHaveLength(1);
      expect(r.value.plan.patches).toHaveLength(0);
    }
  });

  it("re-sync (note exists) → a region NotePatch in plan.patches, creates empty (never a whole-file overwrite)", async () => {
    const port = createBuildSyncOutputsActivity({ ...deps, noteExists: new FakeNoteExistsReader({ exists: true }) });
    const r = await port.build(validated, progress, WS, identity, AT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.plan.creates).toHaveLength(0);
      expect(r.value.plan.patches).toHaveLength(1);
      expect(r.value.plan.patches[0]?.regionId).toBe("project-status");
    }
  });

  it("WS-8: the note-exists probe is asked about the WORKSPACE-ROOTED note path (projects/<ws>/<leaf>.md)", async () => {
    const reader = new FakeNoteExistsReader({ exists: false });
    const port = createBuildSyncOutputsActivity({ ...deps, noteExists: reader });
    await port.build(validated, progress, WS, identity, AT);
    expect(reader.paths).toEqual(["projects/personal-business/x.md"]);
  });

  it("fail-closed: a probe FAILURE → build_failed (NO guessed create-vs-patch, NO commit)", async () => {
    const port = createBuildSyncOutputsActivity({ ...deps, noteExists: new FakeNoteExistsReader({ failWith: "read_failed" }) });
    const r = await port.build(validated, progress, WS, identity, AT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("build_failed");
  });

  it("R3 (24.73 restore round): the probe's own `.message` now crosses (restored, not `.code`); `.cause` STAYS dropped (KEPT)", async () => {
    // `NoteExistsErrorCode` is a SINGLE-member union ("read_failed"), so the prior
    // `${existsRes.error.code}` interpolation rendered the SAME text on every
    // failure regardless of cause — no more informative than the bare
    // `build_failed` code already surfaced. `.message` is a fixed, SoW-authored
    // literal built by the bound reader's own composition wrapper (never raw fs
    // text) — safe to forward. `.cause` is a DIFFERENT field: it can be a raw Node
    // fs error object (absolute vault path + a stack trace) — this activity's own
    // comment says it stays dropped, and this pins that it actually does.
    const hostileReader: NoteExistsReader = {
      exists: () =>
        Promise.resolve({
          ok: false,
          error: {
            code: "read_failed",
            message: "project note-exists probe: vault read failed",
            cause: { path: "/Users/x/vault/projects/personal-business/x.md", stack: "Error: ENOENT\n at ..." },
          },
        }),
    };
    const port = createBuildSyncOutputsActivity({ ...deps, noteExists: hostileReader });
    const r = await port.build(validated, progress, WS, identity, AT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("build_failed");
      // RESTORED: the probe's own message now distinguishes this failure.
      expect(r.error.message).toBe("note-exists probe failed (fail-closed): project note-exists probe: vault read failed");
      // KEPT: cause never crosses — no vault path / stack trace in the result.
      expect(JSON.stringify(r)).not.toContain("/Users/x/vault");
      expect(JSON.stringify(r)).not.toContain("stack");
    }
  });

  it("fail-closed: a projectId with NO safe path anchor → build_failed (never an unsafe note path, WS-8)", async () => {
    const reader = new FakeNoteExistsReader();
    const port = createBuildSyncOutputsActivity({ ...deps, noteExists: reader });
    const r = await port.build(validated, progress, WS, { ...identity, projectId: "../.." }, AT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("build_failed");
    // the probe is never even reached when there is no safe anchor.
    expect(reader.paths).toHaveLength(0);
  });
});
