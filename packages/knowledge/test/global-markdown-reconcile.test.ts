// spec(§6) — bidirectional Global/Coordination-Markdown ↔ GCL-DB reconcile
// (task 4.11). The GCL DB is the queryable MASTER; the Global/Coordination
// Markdown is an Obsidian-editable surface PROJECTED from the DB. A watcher
// reconciles owner Markdown edits BACK into the DB with visibility-level
// validation (reuse @sow/policy via the 4.10 gate). An edit raising content
// above its allowed visibility is REJECTED/flagged, never silently admitted;
// concurrent DB-vs-Markdown changes produce a review item rather than a silent
// overwrite (4.6 conflict-review semantics), with the DB staying authoritative.
// Pure + total: never throws across the boundary (§16).
import { describe, it, expect } from "vitest";
import { defaultWorkspace } from "@sow/contracts";
import type { GclProjection, Workspace } from "@sow/contracts";
import {
  projectProjectionsToMarkdown,
  parseGlobalMarkdown,
  projectionKey,
  reconcileGlobalMarkdown,
  type ReconcileGlobalMarkdownDeps,
} from "../src/gcl/global-markdown-reconcile";

// ── fixtures ─────────────────────────────────────────────────────────────────

const NOW = "2026-07-01T00:00:00.000Z";

function idMinter(): () => string {
  let n = 0;
  return () => `health-${++n}`;
}

function ws(level: Workspace["defaultVisibility"]): Workspace {
  return defaultWorkspace({
    id: "ws-001",
    name: "Acme",
    type: "personal_business",
    markdownRepoPath: "/vault/acme",
    gbrainBrainId: "brain-acme",
    defaultVisibility: level,
  });
}

function deps(
  workspace: Workspace,
  overrides: Partial<ReconcileGlobalMarkdownDeps> = {},
): ReconcileGlobalMarkdownDeps {
  return {
    resolveWorkspace: (id) => (id === workspace.id ? workspace : undefined),
    now: () => NOW,
    newHealthItemId: idMinter(),
    auditRef: "audit-gcl-reconcile-1",
    ...overrides,
  };
}

function proj(overrides: Partial<GclProjection> = {}): GclProjection {
  return {
    workspaceId: "ws-001" as GclProjection["workspaceId"],
    visibilityLevel: "coordination",
    projectionType: "calendar_busy",
    sanitizedPayload: { busySlots: 3 },
    sourceRefs: [{ sourceId: "src-001" as GclProjection["sourceRefs"][number]["sourceId"] }],
    ...overrides,
  };
}

const KEY = "ws-001::calendar_busy";

// ── projection + parse (DB→Markdown surface) ─────────────────────────────────

describe("projectProjectionsToMarkdown + parseGlobalMarkdown", () => {
  it("round-trips a projection deterministically", () => {
    const md = projectProjectionsToMarkdown([proj()]);
    const parsed = parseGlobalMarkdown(md);
    expect(parsed.blocks.has(KEY)).toBe(true);
    const block = parsed.blocks.get(KEY)!;
    expect(block.parseOk).toBe(true);
    expect(block.candidate).toEqual(proj());
    // Deterministic: re-projecting yields byte-identical Markdown.
    expect(projectProjectionsToMarkdown([proj()])).toBe(md);
  });

  it("derives a stable key from workspaceId + projectionType", () => {
    expect(projectionKey({ workspaceId: "ws-001", projectionType: "calendar_busy" })).toBe(KEY);
  });

  it("flags a block whose body is not valid JSON as parse-failed (never throws)", () => {
    const md = `<!-- gcl:projection ${KEY} -->\n{ not json\n<!-- /gcl:projection -->\n`;
    const parsed = parseGlobalMarkdown(md);
    expect(parsed.blocks.get(KEY)!.parseOk).toBe(false);
  });
});

// ── reconcile: clean / reproject / admit ─────────────────────────────────────

describe("reconcileGlobalMarkdown — clean directions", () => {
  it("unchanged (owner untouched, DB matches base) → no entries, clean, Markdown unchanged", () => {
    const base = projectProjectionsToMarkdown([proj()]);
    const out = reconcileGlobalMarkdown(
      { dbRows: [proj()], baseMarkdown: base, currentMarkdown: base },
      deps(ws("sanitized")),
    );
    expect(out.entries).toEqual([]);
    expect(out.clean).toBe(true);
    expect(out.toAdmit).toEqual([]);
    expect(out.healthItems).toEqual([]);
    expect(out.projectedMarkdown).toBe(base);
  });

  it("DB changed while owner untouched → reproject refreshes Markdown from the DB (no conflict)", () => {
    const base = projectProjectionsToMarkdown([proj()]);
    const dbNow = proj({ sanitizedPayload: { busySlots: 9 } });
    const out = reconcileGlobalMarkdown(
      { dbRows: [dbNow], baseMarkdown: base, currentMarkdown: base },
      deps(ws("sanitized")),
    );
    expect(out.clean).toBe(true);
    expect(out.entries).toEqual([{ key: KEY, class: "reproject" }]);
    expect(out.toAdmit).toEqual([]);
    expect(out.projectedMarkdown).toBe(projectProjectionsToMarkdown([dbNow]));
  });

  it("owner edit within visibility, DB unchanged → validated projection admitted back into the DB", () => {
    const base = projectProjectionsToMarkdown([proj()]);
    const edited = proj({ sanitizedPayload: { busySlots: 5 } });
    const current = projectProjectionsToMarkdown([edited]);
    const out = reconcileGlobalMarkdown(
      { dbRows: [proj()], baseMarkdown: base, currentMarkdown: current },
      deps(ws("sanitized")),
    );
    expect(out.clean).toBe(true);
    expect(out.toAdmit).toEqual([edited]);
    expect(out.entries).toEqual([{ key: KEY, class: "clean_admit", admit: edited }]);
    expect(out.healthItems).toEqual([]);
    // DB→Markdown re-projection reflects the just-admitted owner edit.
    expect(out.projectedMarkdown).toBe(projectProjectionsToMarkdown([edited]));
  });
});

// ── reconcile: visibility rejection (bullet 2) ───────────────────────────────

describe("reconcileGlobalMarkdown — visibility validation on owner edits", () => {
  it("REJECTS an owner edit raising visibility above the workspace default — never silently admitted", () => {
    const base = projectProjectionsToMarkdown([proj()]);
    // workspace default is 'coordination'; owner raises the projection to 'full'.
    const raised = proj({ visibilityLevel: "full" });
    const current = projectProjectionsToMarkdown([raised]);
    const out = reconcileGlobalMarkdown(
      { dbRows: [proj()], baseMarkdown: base, currentMarkdown: current },
      deps(ws("coordination")),
    );
    expect(out.clean).toBe(false);
    expect(out.toAdmit).toEqual([]); // NOT admitted
    expect(out.entries).toEqual([
      { key: KEY, class: "rejected", reason: "visibility_exceeds_source" },
    ]);
    expect(out.healthItems).toHaveLength(1);
    expect(out.healthItems[0]!.failureClass).toBe("schema_rejection");
    // The owner's edited block is NOT clobbered (held pending review).
    expect(out.projectedMarkdown).toBe(current);
  });

  it("REJECTS an owner edit injecting raw-content-shaped keys into a projection", () => {
    const base = projectProjectionsToMarkdown([proj()]);
    const leaky = proj({ sanitizedPayload: { body: "raw meeting notes" } });
    const current = projectProjectionsToMarkdown([leaky]);
    const out = reconcileGlobalMarkdown(
      { dbRows: [proj()], baseMarkdown: base, currentMarkdown: current },
      deps(ws("sanitized")),
    );
    expect(out.clean).toBe(false);
    expect(out.toAdmit).toEqual([]);
    expect(out.entries[0]!.class).toBe("rejected");
    expect(out.entries[0]!.reason).toBe("raw_content_present");
  });

  it("REJECTS a malformed-JSON owner edit (flagged, not admitted, never thrown)", () => {
    const base = projectProjectionsToMarkdown([proj()]);
    const current = `<!-- gcl:projection ${KEY} -->\n{ busySlots: broken\n<!-- /gcl:projection -->\n`;
    const out = reconcileGlobalMarkdown(
      { dbRows: [proj()], baseMarkdown: base, currentMarkdown: current },
      deps(ws("sanitized")),
    );
    expect(out.clean).toBe(false);
    expect(out.toAdmit).toEqual([]);
    expect(out.entries[0]!.class).toBe("rejected");
    expect(out.entries[0]!.reason).toBe("malformed_json");
  });

  it("REJECTS an owner edit whose JSON identity no longer matches its block key", () => {
    const base = projectProjectionsToMarkdown([proj()]);
    // block key stays ws-001::calendar_busy but the body claims a different workspace.
    const smuggled = proj({ workspaceId: "ws-999" as GclProjection["workspaceId"] });
    const bodyOfSmuggled = JSON.stringify(smuggled);
    const current = `<!-- gcl:projection ${KEY} -->\n${bodyOfSmuggled}\n<!-- /gcl:projection -->\n`;
    const out = reconcileGlobalMarkdown(
      { dbRows: [proj()], baseMarkdown: base, currentMarkdown: current },
      deps(ws("sanitized")),
    );
    expect(out.toAdmit).toEqual([]);
    expect(out.entries[0]!.class).toBe("rejected");
    expect(out.entries[0]!.reason).toBe("identity_mismatch");
  });
});

// ── reconcile: conflict (bullet 3) ───────────────────────────────────────────

describe("reconcileGlobalMarkdown — concurrent DB-vs-Markdown conflict", () => {
  it("owner edit + concurrent DB change → conflict-review item, not silently overwritten, DB authoritative", () => {
    const base = projectProjectionsToMarkdown([proj()]);
    const ownerEdit = projectProjectionsToMarkdown([proj({ sanitizedPayload: { busySlots: 5 } })]);
    const dbNow = proj({ sanitizedPayload: { busySlots: 9 } }); // DB moved out of band
    const out = reconcileGlobalMarkdown(
      { dbRows: [dbNow], baseMarkdown: base, currentMarkdown: ownerEdit },
      deps(ws("sanitized")),
    );
    expect(out.clean).toBe(false);
    expect(out.toAdmit).toEqual([]); // owner edit withheld — DB stays authoritative
    expect(out.entries).toEqual([{ key: KEY, class: "conflict", reason: "concurrent_db_change" }]);
    expect(out.healthItems).toHaveLength(1);
    expect(out.healthItems[0]!.failureClass).toBe("conflict_review");
  });

  it("owner deletes a DB-backed block → conflict (never a silent master-row deletion)", () => {
    const base = projectProjectionsToMarkdown([proj()]);
    const out = reconcileGlobalMarkdown(
      { dbRows: [proj()], baseMarkdown: base, currentMarkdown: "" },
      deps(ws("sanitized")),
    );
    expect(out.clean).toBe(false);
    expect(out.toAdmit).toEqual([]);
    expect(out.entries[0]!.class).toBe("conflict");
    expect(out.entries[0]!.reason).toBe("owner_deleted_master_row");
    // The master row is re-projected back (not dropped).
    expect(out.projectedMarkdown).toBe(projectProjectionsToMarkdown([proj()]));
  });
});

// ── reconcile: multi-workspace + ordering ────────────────────────────────────

describe("reconcileGlobalMarkdown — multi-entry ordering + isolation", () => {
  it("processes many entries deterministically; a clean admit and a rejection coexist", () => {
    const a = proj({ projectionType: "calendar_busy", sanitizedPayload: { busySlots: 1 } });
    const b = proj({ projectionType: "deadlines", sanitizedPayload: { count: 2 } });
    const base = projectProjectionsToMarkdown([a, b]);
    const aEdit = proj({ projectionType: "calendar_busy", sanitizedPayload: { busySlots: 7 } });
    const bBad = proj({ projectionType: "deadlines", visibilityLevel: "full" });
    const current = projectProjectionsToMarkdown([aEdit, bBad]);
    const out = reconcileGlobalMarkdown(
      { dbRows: [a, b], baseMarkdown: base, currentMarkdown: current },
      deps(ws("coordination")),
    );
    // deterministic key order: ws-001::calendar_busy before ws-001::deadlines
    expect(out.entries.map((e) => e.key)).toEqual([
      "ws-001::calendar_busy",
      "ws-001::deadlines",
    ]);
    expect(out.toAdmit).toEqual([aEdit]); // only the clean one
    expect(out.clean).toBe(false);
  });

  it("resolves each projection's OWN source workspace for visibility validation", () => {
    const base = projectProjectionsToMarkdown([proj()]);
    const current = projectProjectionsToMarkdown([proj({ sanitizedPayload: { busySlots: 5 } })]);
    // resolver returns undefined → unknown workspace → fail-closed reject.
    const out = reconcileGlobalMarkdown(
      { dbRows: [proj()], baseMarkdown: base, currentMarkdown: current },
      { ...deps(ws("sanitized")), resolveWorkspace: () => undefined },
    );
    expect(out.toAdmit).toEqual([]);
    expect(out.entries[0]!.class).toBe("rejected");
    expect(out.entries[0]!.reason).toBe("unknown_workspace");
  });
});
