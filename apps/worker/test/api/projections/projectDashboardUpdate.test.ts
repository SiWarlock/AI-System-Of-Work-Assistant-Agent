// P3 — the concrete ProjectSyncUpdateDashboardPort: upsert one project's UiSafeProjectDashboard into
// read_models[project_dashboards], preserving siblings, fail-closed on a malformed envelope/dashboard.
import { describe, it, expect } from "vitest";
import { ok, err, isOk } from "@sow/contracts";
import type { UiSafeProjectDashboard } from "@sow/contracts";
import type { ReadModelRecord, ReadModelRepository, DbResult } from "@sow/db";
import { READ_MODEL_KEYS } from "../../../src/api/adapters/readModel";
import { createProjectDashboardUpdatePort } from "../../../src/api/projections/projectDashboardUpdate";

/** An in-memory ReadModelRepository keyed by (readModelKey, workspaceId). */
function fakeReadModels(): ReadModelRepository & { rows: Map<string, ReadModelRecord> } {
  const rows = new Map<string, ReadModelRecord>();
  const k = (key: string, ws: string | null) => `${key}::${ws ?? ""}`;
  return {
    rows,
    get(readModelKey, workspaceId): DbResult<ReadModelRecord> {
      const r = rows.get(k(readModelKey, workspaceId));
      return Promise.resolve(r ? ok(r) : err({ code: "not_found", message: "no row" }));
    },
    put(record): DbResult<ReadModelRecord> {
      rows.set(k(record.readModelKey, record.workspaceId ?? null), record);
      return Promise.resolve(ok(record));
    },
    clear(): DbResult<void> {
      return Promise.resolve(ok(undefined));
    },
  };
}

const NOW = "2026-07-06T12:00:00.000Z";
const dash = (projectId: string, title = "P"): UiSafeProjectDashboard => ({
  projectId,
  title,
  status: "active",
  progress: { completedCount: 1, totalCount: 2, percentComplete: 50 },
  blockers: [],
  waitingItems: [],
  nextActions: [],
  evidenceRefs: [],
  docPack: [],
  updatedAt: NOW,
});
const envelope = (workspaceId: string, dashboard: UiSafeProjectDashboard): Record<string, unknown> => ({
  workspaceId,
  dashboard,
});
const projectsOf = (repo: ReturnType<typeof fakeReadModels>, ws: string): UiSafeProjectDashboard[] => {
  const row = repo.rows.get(`${READ_MODEL_KEYS.projectDashboards}::${ws}`);
  return ((row?.data as { projects?: UiSafeProjectDashboard[] })?.projects) ?? [];
};

describe("createProjectDashboardUpdatePort", () => {
  it("writes a new project dashboard row for the workspace", async () => {
    const repo = fakeReadModels();
    const port = createProjectDashboardUpdatePort({ readModels: repo, now: () => NOW });
    const r = await port.update(envelope("personal-business", dash("proj-1")));
    expect(isOk(r)).toBe(true);
    const projects = projectsOf(repo, "personal-business");
    expect(projects.map((p) => p.projectId)).toEqual(["proj-1"]);
    // the row is stamped rebuiltAt = now and scoped to the envelope's workspace.
    expect(repo.rows.get(`${READ_MODEL_KEYS.projectDashboards}::personal-business`)?.rebuiltAt).toBe(NOW);
  });

  it("UPSERTS by projectId, PRESERVING sibling projects", async () => {
    const repo = fakeReadModels();
    const port = createProjectDashboardUpdatePort({ readModels: repo, now: () => NOW });
    await port.update(envelope("personal-business", dash("proj-1", "First")));
    await port.update(envelope("personal-business", dash("proj-2", "Second")));
    // re-update proj-1 with a new title — proj-2 must survive.
    await port.update(envelope("personal-business", dash("proj-1", "First v2")));
    const projects = projectsOf(repo, "personal-business");
    expect(projects.map((p) => p.projectId).sort()).toEqual(["proj-1", "proj-2"]);
    expect(projects.find((p) => p.projectId === "proj-1")?.title).toBe("First v2");
  });

  it("scopes writes per workspace (WS-8): a PB write never touches the EW row", async () => {
    const repo = fakeReadModels();
    const port = createProjectDashboardUpdatePort({ readModels: repo, now: () => NOW });
    await port.update(envelope("personal-business", dash("pb-1")));
    await port.update(envelope("employer-work", dash("ew-1")));
    expect(projectsOf(repo, "personal-business").map((p) => p.projectId)).toEqual(["pb-1"]);
    expect(projectsOf(repo, "employer-work").map((p) => p.projectId)).toEqual(["ew-1"]);
  });

  it("fail-closed: a malformed envelope (no workspaceId / empty / no dashboard) → dashboard_failed, no write", async () => {
    const repo = fakeReadModels();
    const port = createProjectDashboardUpdatePort({ readModels: repo, now: () => NOW });
    for (const bad of [{}, { workspaceId: "" }, { workspaceId: "pb" }, { dashboard: dash("x") }, null as unknown as Record<string, unknown>]) {
      const r = await port.update(bad as Record<string, unknown>);
      expect(isOk(r)).toBe(false);
      if (!isOk(r)) expect(r.error.code).toBe("dashboard_failed");
    }
    expect(repo.rows.size).toBe(0); // nothing written
  });

  it("fail-closed: a dashboard that fails UiSafeProjectDashboardSchema → dashboard_failed, no write", async () => {
    const repo = fakeReadModels();
    const port = createProjectDashboardUpdatePort({ readModels: repo, now: () => NOW });
    // a REQ-F-011-inconsistent dashboard (percent != computePercent) OR a multi-line title is rejected by the schema
    const badPercent = { ...dash("proj-1"), progress: { completedCount: 1, totalCount: 2, percentComplete: 200 } };
    const r = await port.update(envelope("personal-business", badPercent as UiSafeProjectDashboard));
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) expect(r.error.code).toBe("dashboard_failed");
    expect(repo.rows.size).toBe(0);
  });

  it("fail-closed: a store fault on get (not not_found) → dashboard_failed, never throws", async () => {
    const repo = fakeReadModels();
    repo.get = () => Promise.resolve(err({ code: "unavailable", message: "db down" }));
    const port = createProjectDashboardUpdatePort({ readModels: repo, now: () => NOW });
    const r = await port.update(envelope("personal-business", dash("proj-1")));
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) expect(r.error.code).toBe("dashboard_failed");
  });

  it("NEVER throws — a repo that throws is caught and folds to dashboard_failed", async () => {
    const repo = fakeReadModels();
    repo.get = () => {
      throw new Error("boom");
    };
    const port = createProjectDashboardUpdatePort({ readModels: repo, now: () => NOW });
    const r = await port.update(envelope("personal-business", dash("proj-1")));
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) expect(r.error.code).toBe("dashboard_failed");
  });
});
