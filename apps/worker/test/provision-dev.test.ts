// Data-unlock D1 — the dev-provisioner turns local Obsidian-style Markdown into REAL
// read-model rows so the wired-but-empty Today/workspace surfaces show genuine content:
// a deterministic checkbox parse (REQ-F-011, no model), the production fail-closed
// workspace registry (WS-8), and the same DB read path the live query router uses. This
// is NOT a seed — the data is derived from real files through the real deterministic
// parser, honoring the §9.4 "empty-until-data, no seed" decision.
import { describe, it, expect, afterEach } from "vitest";
import { isErr } from "@sow/contracts";
import { assembleBackends, type ProofSpineBackends } from "../src/composition/backends";
import { createDbReadModelQueryPort, READ_MODEL_KEYS } from "../src/api/adapters/readModel";
import { provisionDevWorkspace, buildSyncRecentChange } from "../src/composition/provisionDev";

const NOW = "2026-07-04T00:00:00.000Z";
// 2 completed / 5 total → computePercent(2,5) === 40.
const NOTE_40 = "# Alpha\n\n- [x] done one\n- [x] done two\n- [ ] open three\n- [ ] open four\n- [ ] open five\n";

const open: ProofSpineBackends[] = [];
afterEach(() => {
  for (const b of open.splice(0)) b.close();
});

async function fresh(): Promise<ProofSpineBackends> {
  const b = await assembleBackends({ now: () => NOW });
  open.push(b);
  return b;
}

function port(b: ProofSpineBackends): ReturnType<typeof createDbReadModelQueryPort> {
  return createDbReadModelQueryPort({ readModels: b.repos.readModels, approvals: b.repos.approvals });
}

function deps(b: ProofSpineBackends): { readModels: typeof b.repos.readModels; vault: { read(p: string): Promise<string | undefined> }; now: () => string } {
  return { readModels: b.repos.readModels, vault: b.vault, now: b.now };
}

describe("provisionDevWorkspace (data-unlock D1 — real read-model data from local Markdown)", () => {
  it("parses checkboxes deterministically and surfaces one workspace card (count === percent)", async () => {
    const b = await fresh();
    await b.vault.write("alpha.md", NOTE_40);
    const r = await provisionDevWorkspace(deps(b), {
      workspaceId: "employer-work",
      notePath: "alpha.md",
      projectTitle: "Alpha",
    });
    expect(r.ok).toBe(true);
    const cards = await port(b).workspaceCards("employer-work");
    expect(cards.ok).toBe(true);
    if (cards.ok) {
      expect(cards.value.length).toBe(1);
      expect(cards.value[0]!.count).toBe(40); // 2/5, REQ-F-011 deterministic percent
      expect(cards.value[0]!.kind).toBe("project");
      expect(cards.value[0]!.title).toBe("Alpha");
    }
  });

  it("writes a real project dashboard with DETERMINISTIC progress (the query.projectList path)", async () => {
    const b = await fresh();
    await b.vault.write("alpha.md", NOTE_40); // 2/5 → 40%
    await provisionDevWorkspace(deps(b), { workspaceId: "employer-work", notePath: "alpha.md", projectTitle: "Alpha" });
    const projects = await port(b).projectDashboards("employer-work");
    expect(projects.ok).toBe(true);
    if (projects.ok) {
      expect(projects.value.length).toBe(1);
      const p = projects.value[0]!;
      expect(p.title).toBe("Alpha");
      expect(p.progress).toEqual({ completedCount: 2, totalCount: 5, percentComplete: 40 });
      expect(p.status).toBe("in-progress"); // 0 < 40 < 100
      expect(p.blockers).toEqual([]); // no dev model synthesis
      // §4.5: the full 5-slot managed doc pack, all UNLINKED/UNKNOWN — honest pre-connector
      // state (no Drive connector exists), never a synthetic "synced".
      expect(p.docPack.map((d) => d.slot)).toEqual([
        "00_brief",
        "01_decisions",
        "02_meetings",
        "03_research",
        "04_open_questions",
      ]);
      expect(p.docPack.every((d) => d.linkState === "unlinked" && d.syncState === "unknown")).toBe(true);
      // Pin the §4.5 display titles so a MANAGED_DOC_SLOTS title drift is caught here.
      expect(p.docPack.map((d) => d.title)).toEqual([
        "00 Brief",
        "01 Decisions",
        "02 Meeting Digest",
        "03 Research",
        "04 Open Questions",
      ]);
    }
  });

  it("buildSyncRecentChange: stable id + a SINGLE-LINE servable summary (collapses newlines in the title)", () => {
    const c = buildSyncRecentChange(
      { workspaceId: "employer-work", notePath: "roadmap.md", projectTitle: "Road\nmap" },
      { completed: 3, total: 5 },
      60,
      "2026-07-04T00:00:00.000Z",
    );
    expect(c.changeId).toBe("employer-work:sync:roadmap.md"); // stable per (workspace, note) → re-provision upserts
    expect(c.kind).toBe("project-synced");
    expect(c.occurredAt).toBe("2026-07-04T00:00:00.000Z");
    expect(c.summary).not.toMatch(/[\r\n]/); // single-line — the read-side schema rejects multi-line
    expect(c.summary).toContain("3/5");
    expect(c.summary).toContain("60%");
    // An over-long title is CLAMPED via the shared normalizer so the row stays servable
    // (one unservable row would fail the whole recent-changes list).
    const long = buildSyncRecentChange(
      { workspaceId: "w", notePath: "n.md", projectTitle: "x".repeat(5000) },
      { completed: 1, total: 1 },
      100,
      "2026-07-04T00:00:00.000Z",
    );
    expect(long.summary.length).toBeLessThanOrEqual(1024);
  });

  it("provisioning writes a REAL workspace-scoped recent-change row (Today Recent activity lights up)", async () => {
    const b = await fresh();
    await b.vault.write("roadmap.md", NOTE_40); // 2/5 → 40%
    const res = await provisionDevWorkspace(deps(b), {
      workspaceId: "employer-work",
      notePath: "roadmap.md",
      projectTitle: "Roadmap",
    });
    expect(res.ok).toBe(true);
    const changes = await port(b).recentChanges("employer-work");
    expect(changes.ok).toBe(true);
    if (changes.ok) {
      expect(changes.value).toHaveLength(1);
      const c = changes.value[0]!;
      expect(c.changeId).toBe("employer-work:sync:roadmap.md");
      expect(c.kind).toBe("project-synced");
      expect(c.summary).toContain("Roadmap");
      expect(c.occurredAt).toBeTruthy();
    }
    // Recent changes are WORKSPACE-scoped (WS-8): an unknown workspace is empty/fail-closed.
    const other = await port(b).recentChanges("personal-life");
    expect(other.ok ? other.value : []).toEqual([]);
  });

  it("registers ONLY the provisioned workspace — an unprovisioned scope still fails closed (WS-8)", async () => {
    const b = await fresh();
    await b.vault.write("alpha.md", NOTE_40);
    await provisionDevWorkspace(deps(b), { workspaceId: "employer-work", notePath: "alpha.md" });
    const known = await port(b).workspaceCards("employer-work");
    const unknown = await port(b).workspaceCards("personal-business");
    expect(known.ok).toBe(true);
    expect(isErr(unknown)).toBe(true); // fail-closed on an unprovisioned workspace
    // Explicit registry-MEMBERSHIP identity (the shared `registerWorkspace` union helper — 14.1
    // extracted it to composition/workspaceRegistry.ts; this pins provisionDev's union behavior
    // byte-identical): the provisioned id is in the registry set, the unprovisioned one is NOT.
    const reg = await b.repos.readModels.get(READ_MODEL_KEYS.registry, null);
    expect(reg.ok).toBe(true);
    if (reg.ok) {
      const ids = (reg.value.data as { workspaceIds?: unknown }).workspaceIds;
      expect(Array.isArray(ids) ? ids : []).toContain("employer-work");
      expect(Array.isArray(ids) ? ids : []).not.toContain("personal-business");
    }
  });

  it("does NOT write the ungated GLOBAL dashboard — the card is workspace-scoped (global is the gated GCL path, D2)", async () => {
    const b = await fresh();
    await b.vault.write("alpha.md", NOTE_40);
    await provisionDevWorkspace(deps(b), { workspaceId: "employer-work", notePath: "alpha.md" });
    const dash = await port(b).dashboardCards();
    expect(dash.ok).toBe(true);
    if (dash.ok) expect(dash.value).toHaveLength(0); // global stays empty — no ungated cross-workspace write
  });

  it("accumulates MULTIPLE notes for one workspace in the scoped row (upsert by cardId, never clobbers a sibling)", async () => {
    const b = await fresh();
    await b.vault.write("a.md", NOTE_40); // 40%
    await b.vault.write("c.md", "# C\n- [x] x\n- [x] y\n"); // 2/2 = 100%
    await provisionDevWorkspace(deps(b), { workspaceId: "employer-work", notePath: "a.md" });
    await provisionDevWorkspace(deps(b), { workspaceId: "employer-work", notePath: "c.md" });
    const ew = await port(b).workspaceCards("employer-work");
    expect(ew.ok).toBe(true);
    if (ew.ok) {
      expect(ew.value.length).toBe(2); // both notes' cards coexist (distinct cardIds)
      expect(ew.value.map((c) => c.count).sort((x, y) => x - y)).toEqual([40, 100]);
    }
  });

  it("is idempotent + multi-workspace: re-provision keeps one card; a 2nd workspace keeps the 1st known", async () => {
    const b = await fresh();
    await b.vault.write("a.md", NOTE_40);
    await b.vault.write("b.md", "# B\n- [x] x\n- [x] y\n"); // 2/2 = 100%
    await provisionDevWorkspace(deps(b), { workspaceId: "employer-work", notePath: "a.md" });
    await provisionDevWorkspace(deps(b), { workspaceId: "employer-work", notePath: "a.md" }); // re-run (idempotent)
    await provisionDevWorkspace(deps(b), { workspaceId: "personal-business", notePath: "b.md" });
    const ew = await port(b).workspaceCards("employer-work");
    const pb = await port(b).workspaceCards("personal-business");
    expect(ew.ok).toBe(true);
    if (ew.ok) expect(ew.value.length).toBe(1); // same note re-provisioned → upsert by cardId, no duplicate
    expect(pb.ok).toBe(true); // 1st workspace still known after the 2nd (registry union)
    if (pb.ok) expect(pb.value[0]!.count).toBe(100);
  });

  it("fails closed on an ambiguous status marker (PRJ-4 — never guesses a percent)", async () => {
    const b = await fresh();
    await b.vault.write("amb.md", "# A\n- [x] ok\n- [?] huh\n"); // ambiguous marker
    const r = await provisionDevWorkspace(deps(b), { workspaceId: "employer-work", notePath: "amb.md" });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("ambiguous_status");
  });

  it("fails closed on a missing note", async () => {
    const b = await fresh();
    const r = await provisionDevWorkspace(deps(b), { workspaceId: "employer-work", notePath: "nope.md" });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("note_unreadable");
  });
});
