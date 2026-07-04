// Data-unlock (D1) — a DEV-ONLY provisioner that turns local Obsidian-style Markdown
// into REAL read-model rows, so the wired-but-empty Today / workspace / project surfaces
// show genuine content without vendor I/O, Temporal, connectors, or onboarding §9.12.
//
// This is NOT a seed. The numbers are DERIVED from real files by the SAME deterministic
// checkbox parser the project-sync activity uses (REQ-F-011 — no model, no guessed %),
// and a workspace becomes visible ONLY by being written into the production fail-closed
// workspace registry (WS-8). It writes the exact `read_models` rows the live query router
// reads through `createDbReadModelQueryPort`, so the surfaces light up with real data —
// honoring the §9.4 "empty-until-data, no seed" decision.
//
// SCOPE: worker composition only. It writes rebuildable read-model rows (safe to clobber,
// §4); it never writes Markdown, never routes a semantic mutation (that is KnowledgeWriter's
// sole job — KN-4/KN-9), and never touches secrets. Gated behind a boot flag; absent the
// flag, boot is unchanged and every surface stays empty.
import { ok, err, isErr, type Result } from "@sow/contracts";
import { countCheckboxes, computePercent } from "@sow/workflows";
import type { ReadModelRepository } from "@sow/db";
import type { UiSafeProjectDashboard } from "@sow/contracts";
import { READ_MODEL_KEYS } from "../api/adapters/readModel";
import type { DashboardCardSource } from "../api/projections/uiSafe";

/** One dev workspace to provision from a single Markdown note carrying GFM checkboxes. */
export interface DevProvisionSpec {
  /** The workspace scope id (e.g. "employer-work") — added to the fail-closed registry. */
  readonly workspaceId: string;
  /** A vault-relative Markdown note whose `- [x]`/`- [ ]` checkboxes drive the percent. */
  readonly notePath: string;
  /** The card title; defaults to `notePath`. */
  readonly projectTitle?: string;
}

/** The narrow deps the provisioner needs — the read-model repo + a vault reader + a clock. */
export interface DevProvisionDeps {
  readonly readModels: ReadModelRepository;
  readonly vault: { read(path: string): Promise<string | undefined> };
  readonly now: () => string;
}

/** Typed, redaction-safe provisioning failures (never a raw driver cause). */
export type DevProvisionError =
  | { readonly code: "note_unreadable"; readonly message: string }
  | { readonly code: "ambiguous_status"; readonly message: string }
  | { readonly code: "store_fault"; readonly message: string };

/** Read the `cards` array off a read-model payload; a malformed/absent payload → `[]`. */
function readCards(data: unknown): readonly DashboardCardSource[] {
  if (typeof data !== "object" || data === null) return [];
  const arr = (data as Record<string, unknown>)["cards"];
  if (!Array.isArray(arr)) return [];
  const out: DashboardCardSource[] = [];
  for (const row of arr) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (
      typeof r["cardId"] === "string" &&
      typeof r["kind"] === "string" &&
      typeof r["title"] === "string" &&
      typeof r["status"] === "string" &&
      typeof r["count"] === "number" &&
      typeof r["updatedAt"] === "string"
    ) {
      out.push({
        cardId: r["cardId"],
        kind: r["kind"],
        title: r["title"],
        status: r["status"],
        count: r["count"],
        updatedAt: r["updatedAt"],
      });
    }
  }
  return out;
}

/** Read the registry's `workspaceIds` string set off a payload; malformed/absent → `[]`. */
function readWorkspaceIds(data: unknown): readonly string[] {
  if (typeof data !== "object" || data === null) return [];
  const arr = (data as Record<string, unknown>)["workspaceIds"];
  if (!Array.isArray(arr)) return [];
  return arr.filter((x): x is string => typeof x === "string");
}

/**
 * UPSERT one card (by `cardId`) into a workspace-scoped read-model row's `cards` array and
 * write it back, PRESERVING any other cards already in the row (multiple notes per workspace
 * accumulate). A benign `not_found` miss starts from empty; a GENUINE store fault returns a
 * typed `store_fault` rather than folding to empty — folding would silently DROP other cards
 * already in the row (the same not-found-vs-fault distinction `getReadModel` makes in
 * `readModel.ts`). The row is rebuildable (§4), so a re-provision repairs it.
 */
async function upsertCardRow(
  readModels: ReadModelRepository,
  readModelKey: string,
  workspaceId: string,
  card: DashboardCardSource,
  at: string,
): Promise<Result<void, DevProvisionError>> {
  const existing = await readModels.get(readModelKey, workspaceId);
  if (isErr(existing) && existing.error.code !== "not_found") {
    return err({ code: "store_fault", message: `read-model get failed: ${readModelKey}` });
  }
  const prior = existing.ok ? readCards(existing.value.data) : [];
  const cards = [...prior.filter((c) => c.cardId !== card.cardId), card];
  const put = await readModels.put({ readModelKey, workspaceId, data: { cards }, rebuiltAt: at });
  return put.ok ? ok(undefined) : err({ code: "store_fault", message: `read-model put failed: ${readModelKey}` });
}

/**
 * UNION `workspaceId` into the global fail-closed workspace registry (`{ workspaceIds }`).
 * Idempotent: re-registering an already-known workspace is a no-op set. This is what makes
 * a workspace-scoped query resolve (WS-8: absent from the registry → the query fails closed).
 */
async function registerWorkspace(
  readModels: ReadModelRepository,
  workspaceId: string,
  at: string,
): Promise<Result<void, DevProvisionError>> {
  const existing = await readModels.get(READ_MODEL_KEYS.registry, null);
  if (isErr(existing) && existing.error.code !== "not_found") {
    // A genuine fault must NOT fold to empty — that would DROP previously-registered
    // workspaces (making their scoped reads fail closed). Fail loudly; a re-provision repairs.
    return err({ code: "store_fault", message: "workspace registry get failed" });
  }
  const prior = existing.ok ? readWorkspaceIds(existing.value.data) : [];
  const workspaceIds = prior.includes(workspaceId) ? prior : [...prior, workspaceId];
  const put = await readModels.put({
    readModelKey: READ_MODEL_KEYS.registry,
    data: { workspaceIds },
    rebuiltAt: at,
  });
  return put.ok ? ok(undefined) : err({ code: "store_fault", message: "workspace registry put failed" });
}

/** Read the `projects` array off the project-dashboards payload; malformed/absent → `[]`. */
function readProjects(data: unknown): readonly UiSafeProjectDashboard[] {
  if (typeof data !== "object" || data === null) return [];
  const arr = (data as Record<string, unknown>)["projects"];
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (row): row is UiSafeProjectDashboard =>
      typeof row === "object" && row !== null && typeof (row as Record<string, unknown>)["projectId"] === "string",
  );
}

/**
 * UPSERT one project dashboard (by `projectId`) into the workspace's `project_dashboards`
 * row, preserving any sibling projects. Same not-found-vs-fault discipline as `upsertCardRow`.
 * The written row is a candidate that `query.projectList`'s `sanitizeProjectDashboards`
 * re-validates (incl. the REQ-F-011 progress checks) before it ever reaches the renderer.
 */
async function upsertProjectRow(
  readModels: ReadModelRepository,
  workspaceId: string,
  project: UiSafeProjectDashboard,
  at: string,
): Promise<Result<void, DevProvisionError>> {
  const existing = await readModels.get(READ_MODEL_KEYS.projectDashboards, workspaceId);
  if (isErr(existing) && existing.error.code !== "not_found") {
    return err({ code: "store_fault", message: "project-dashboards get failed" });
  }
  const prior = existing.ok ? readProjects(existing.value.data) : [];
  const projects = [...prior.filter((p) => p.projectId !== project.projectId), project];
  const put = await readModels.put({
    readModelKey: READ_MODEL_KEYS.projectDashboards,
    workspaceId,
    data: { projects },
    rebuiltAt: at,
  });
  return put.ok ? ok(undefined) : err({ code: "store_fault", message: "project-dashboards put failed" });
}

/**
 * Provision ONE dev workspace from a local Markdown note: parse its checkboxes
 * deterministically, upsert a project card into the workspace + project + global-dashboard
 * read-models, and register the workspace as known. Fails closed on a missing note or an
 * ambiguous status marker (PRJ-4 — never guesses). Returns the card it surfaced.
 */
export async function provisionDevWorkspace(
  deps: DevProvisionDeps,
  spec: DevProvisionSpec,
): Promise<Result<DashboardCardSource, DevProvisionError>> {
  const { readModels, vault, now } = deps;

  const text = await vault.read(spec.notePath);
  if (text === undefined) {
    return err({ code: "note_unreadable", message: `note not found in vault: ${spec.notePath}` });
  }

  const tally = countCheckboxes(text);
  if (tally.ambiguous) {
    // PRJ-4: an ambiguous marker (`[?]`, `[-]`, `[/]`) — refuse to guess a percent.
    return err({ code: "ambiguous_status", message: `ambiguous status marker in note: ${spec.notePath}` });
  }
  const percent = computePercent(tally.completed, tally.total);
  const at = now();

  const card: DashboardCardSource = {
    // Stable per (workspace, note) so a re-provision upserts rather than duplicates.
    cardId: `${spec.workspaceId}:project:${spec.notePath}`,
    kind: "project",
    title: spec.projectTitle ?? spec.notePath,
    status: "ok",
    // count carries the DETERMINISTIC percent (REQ-F-011). The generic DashboardCardSource
    // has no dedicated progress field — the richer UiSafeProjectDashboard contract (§9.5
    // Projects surface) replaces this proof-of-pipeline card with real progress fields.
    count: percent,
    updatedAt: at,
  };

  // WORKSPACE-scoped surfaces only, then register the workspace as known. The GLOBAL Today
  // dashboard is deliberately NOT written here: the ungated `dashboard_cards` row is served
  // cross-workspace with no visibility gate, so a per-workspace project card belongs to the
  // workspace scope, not the global aggregate. The cross-workspace surface goes through the
  // GCL Visibility Gate (`global_surface`) — a separate, gated step (data-unlock D2). Any
  // store fault short-circuits with a typed err.
  const wsPut = await upsertCardRow(readModels, READ_MODEL_KEYS.workspace, spec.workspaceId, card, at);
  if (!wsPut.ok) return wsPut;
  const projPut = await upsertCardRow(readModels, READ_MODEL_KEYS.project, spec.workspaceId, card, at);
  if (!projPut.ok) return projPut;

  // The rich Projects-surface row (§9.5): the SAME deterministic percent, now as a real
  // UiSafeProjectDashboard. Prose fields are empty — the dev provisioner runs NO model
  // synthesis (blockers/waiting/next come only from a no-inference-gated ValidatedNarrative,
  // which a real project-sync workflow produces — deferred). `progress` is consistent by
  // construction (percent === computePercent(counts), completed <= total), so it passes the
  // REQ-F-011 re-validation in query.projectList. Status is a deterministic display token.
  const projectDashboard: UiSafeProjectDashboard = {
    projectId: `${spec.workspaceId}:${spec.notePath}`,
    title: spec.projectTitle ?? spec.notePath,
    status: percent === 100 ? "done" : percent === 0 ? "not-started" : "in-progress",
    progress: { completedCount: tally.completed, totalCount: tally.total, percentComplete: percent },
    blockers: [],
    waitingItems: [],
    nextActions: [],
    evidenceRefs: [],
    docPack: [], // real 5-slot unlinked pack lands in the doc-pack writer slice (DP-2)
    updatedAt: at,
  };
  const projDashPut = await upsertProjectRow(readModels, spec.workspaceId, projectDashboard, at);
  if (!projDashPut.ok) return projDashPut;

  const reg = await registerWorkspace(readModels, spec.workspaceId, at);
  if (!reg.ok) return reg;

  return ok(card);
}
