// P3 (§9.5 / §13.5) — the concrete ProjectSyncUpdateDashboardPort. Upserts one project's UiSafeProjectDashboard
// into the workspace's rebuildable read_models[project_dashboards] row (preserving sibling projects), so the
// desktop Projects surface renders REAL project state instead of the dev-seed. Worker-side: it holds the
// ReadModelRepository (the @sow/workflows port surface stays workflow-safe; the ACTIVITY that implements the
// port lives here and may touch the adapter). Mirrors provisionDev.ts `upsertProjectRow` — the interim this
// replaces on the real path.
//
// The port receives an OPAQUE Record<string,unknown> payload (the SUMMARY-only dashboard read-model payload the
// projectSync BuildSyncOutputsPort produces). This concrete impl interprets it as a `{ workspaceId, dashboard }`
// envelope:
//  • `workspaceId` — the SERVER-BOUND scope BuildSyncOutputsPort stamped from the registry-resolved entry (a
//    caller cannot redirect the write to another workspace — WS-2/WS-4; the envelope's workspaceId is the write
//    key). Required, non-empty.
//  • `dashboard`   — a UiSafeProjectDashboard-shaped object. It is re-validated through
//    UiSafeProjectDashboardSchema here (fail-closed, defense-in-depth): the payload is opaque, so a malformed /
//    REQ-F-011-inconsistent dashboard is REJECTED, never written. This is REBUILDABLE (§4/§16) — a bad row is a
//    dropped projection, never a corrupted truth.
// Never throws (§16): every fault folds to `dashboard_failed`.
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { UiSafeProjectDashboardSchema } from "@sow/contracts";
import type { UiSafeProjectDashboard } from "@sow/contracts";
import type { ReadModelRepository } from "@sow/db";
import type {
  ProjectSyncUpdateDashboardPort,
  ProjectSyncUpdateDashboardError,
} from "@sow/workflows";
import { READ_MODEL_KEYS } from "../adapters/readModel";

/** Deps for the concrete update port: the read-model repo + a clock (the rebuiltAt stamp). */
export interface ProjectDashboardUpdateDeps {
  readonly readModels: ReadModelRepository;
  /** ISO-8601 now — injected so the activity stays deterministic/testable. */
  readonly now: () => string;
}

type UpdateErr = ProjectSyncUpdateDashboardError;
const fail = (message: string, cause?: unknown): UpdateErr => ({ code: "dashboard_failed", message, cause });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read the `projects` array off an existing project-dashboards row payload; malformed/absent → `[]`. */
function readProjects(data: unknown): readonly UiSafeProjectDashboard[] {
  if (!isRecord(data)) return [];
  const arr = data["projects"];
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (row): row is UiSafeProjectDashboard => isRecord(row) && typeof row["projectId"] === "string",
  );
}

/**
 * Build the concrete ProjectSyncUpdateDashboardPort over the injected read-model repo + clock. `update`
 * validates the `{workspaceId, dashboard}` envelope + the dashboard (fail-closed), then UPSERTs by projectId
 * into the workspace's `project_dashboards` row, preserving siblings. Never throws.
 */
export function createProjectDashboardUpdatePort(
  deps: ProjectDashboardUpdateDeps,
): ProjectSyncUpdateDashboardPort {
  return {
    async update(payload: Record<string, unknown>): Promise<Result<void, UpdateErr>> {
      try {
        if (!isRecord(payload)) return err(fail("payload is not an object"));
        const workspaceId = payload["workspaceId"];
        if (typeof workspaceId !== "string" || workspaceId.length === 0) {
          return err(fail("envelope missing a non-empty workspaceId"));
        }
        // Re-validate the dashboard through the UI-safe schema — the payload is untrusted/opaque, so a
        // malformed or REQ-F-011-inconsistent dashboard must be dropped, never written.
        const parsed = UiSafeProjectDashboardSchema.safeParse(payload["dashboard"]);
        if (!parsed.success) return err(fail("dashboard fails UiSafeProjectDashboardSchema"));
        const project = parsed.data;

        // UPSERT preserving siblings (mirror provisionDev.upsertProjectRow).
        const existing = await deps.readModels.get(READ_MODEL_KEYS.projectDashboards, workspaceId);
        if (isErr(existing) && existing.error.code !== "not_found") {
          return err(fail("project-dashboards get failed", existing.error));
        }
        const prior = isOk(existing) ? readProjects(existing.value.data) : [];
        const projects = [...prior.filter((p) => p.projectId !== project.projectId), project];
        const put = await deps.readModels.put({
          readModelKey: READ_MODEL_KEYS.projectDashboards,
          workspaceId,
          data: { projects },
          rebuiltAt: deps.now(),
        });
        return isOk(put) ? ok(undefined) : err(fail("project-dashboards put failed", put.error));
      } catch (cause) {
        return err(fail("unexpected update fault", cause));
      }
    },
  };
}
