// Task 8.3 (integrator step) — the REAL @sow/db binding of the query-procedure
// read-model source. `queries.ts` declares the `ReadModelQueryPort` seam + does the
// UI-safe projection; the FAKE is the unit-test seam. THIS module is the seam's
// real port adapter: it binds each read-only method to the @sow/db operational
// store — the `ReadModelRepository` (rebuildable dashboard/UI read-models) for the
// card + copilot + global surfaces, and the `ApprovalRepository` (operational
// truth) for the ingestion + approval inboxes.
//
// SAFETY / BOUNDARY POSTURE (root CLAUDE.md safety 4, §5/§6/§10, §16):
//   • READ-ONLY. Every method is a repository READ; the adapter issues NO write.
//   • FAIL-CLOSED on an unknown / out-of-scope workspace. A workspace-scoped read
//     for a workspace NOT in the workspace registry returns a typed
//     `err(FailureVariant)` (`validation_rejected` / `WORKSPACE_NOT_FOUND`) — never
//     a partial raw leak (no cards, no approvals, no refs cross for an unknown ws).
//   • ABSENT read-model ≠ error. A KNOWN workspace (or the global dashboard) whose
//     read-model row does not yet exist is an EMPTY ok list — the workflows
//     populate the rows later; a missing rebuildable read-model is not a fault.
//   • §16 typed boundary. A genuine store fault (a `DbError` that is NOT the
//     benign `not_found` miss) folds to a redaction-safe typed
//     `degraded_unavailable` err — the driver cause never crosses.
//   • UI-SAFE projection stays in `queries.ts`. This adapter hands back the FROZEN
//     domain records (Approval / WorkflowRunRef / GclProjection) and the
//     DashboardCardSource superset; the 8.2 projectors do the redaction so the
//     boundary lives in ONE place (never re-implemented in a port binding).
//
// IMPORT DIRECTION (root CLAUDE.md §2.5): apps/worker may import @sow/db + @sow/contracts.
// It NEVER makes @sow/db depend on the worker — this is the worker-layer adapter the
// @sow/db repository docs call for.
import {
  ok,
  err,
  isErr,
  failure,
  type Result,
  type FailureVariant,
  type Approval,
  type WorkflowRunRef,
  type GclProjection,
  type UiSafeRecentChange,
  type UiSafeProjectDashboard,
} from "@sow/contracts";
import type {
  ReadModelRepository,
  ApprovalRepository,
  ReadModelRecord,
  DbError,
} from "@sow/db";
import type { ReadModelQueryPort } from "../procedures/queries";
import type { DashboardCardSource } from "../projections/uiSafe";

// ── read-model key scheme (documented convention) ─────────────────────────────
// The @sow/db `read_models` table is keyed by (readModelKey, workspaceId?) with a
// JSON `data` payload. Until the workflows that populate these rows pin their own
// keys, the query surface reads under these reserved keys. `null` workspaceId is a
// GLOBAL (cross-workspace-safe) read-model; a string workspaceId scopes the row.
export const READ_MODEL_KEYS = {
  /** Global Today dashboard cards (workspaceId = null). */
  dashboard: "dashboard_cards",
  /** Workspace-surface cards (workspaceId-scoped). */
  workspace: "workspace_cards",
  /** Project-surface cards (workspaceId-scoped; project selected within `data`). */
  project: "project_cards",
  /** Copilot recent-runs read surface (workspaceId-scoped). */
  copilot: "copilot_runs",
  /** Recent Changes — workspace-scoped audit-linked activity rows (§9.5). */
  recentChanges: "recent_changes",
  /** Project dashboards — workspace-scoped deterministic-progress project cards (§9.5). */
  projectDashboards: "project_dashboards",
  /** GCL sanitized cross-workspace surface (workspaceId = null). */
  global: "global_surface",
  /**
   * The workspace REGISTRY (workspaceId = null): a global read-model whose `data`
   * is `{ workspaceIds: string[] }` — the fail-closed known-workspace membership
   * set. A workspace absent from the registry is UNKNOWN / out-of-scope; a
   * workspace-scoped query for it fails closed with a typed err (no raw leak).
   */
  registry: "workspace_registry",
} as const;

// ── typed failures (redaction-safe — only a stable code crosses) ──────────────

/** An unknown / out-of-scope workspace — fail-closed, never a partial raw leak. */
function unknownWorkspace(): FailureVariant {
  return failure("validation_rejected", "unknown or out-of-scope workspace", {
    cause: { code: "WORKSPACE_NOT_FOUND" },
  });
}

/**
 * A genuine store fault (a `DbError` that is NOT the benign `not_found` miss)
 * mapped to the §16 boundary taxonomy. REDACTION-SAFE: only a stable code crosses,
 * never the driver cause / message.
 */
function storeFault(): FailureVariant {
  return failure("degraded_unavailable", "read-model store unavailable", {
    retryable: true,
    cause: { code: "READ_MODEL_STORE_UNAVAILABLE" },
  });
}

// ── read-model row → typed projection-source shapes (candidate-data gate) ─────
// The `read_models.data` column is an OPEN JSON blob (the workflows own its shape),
// so every read runs a small STRUCTURAL guard: a row whose payload does not carry a
// well-formed array of the expected shape is treated as EMPTY (an absent/partial
// read-model is an empty ok list, never a crash and never a raw leak). Each guard
// copies ONLY the named fields — an adversarial extra key on a row is never read,
// mirroring the projector discipline (the redaction boundary is still `queries.ts`,
// but a defense-in-depth field-copy here keeps a malformed row from smuggling one).

/** Read the `cards` array off a read-model payload; a malformed payload → `[]`. */
function readCardSources(data: unknown): readonly DashboardCardSource[] {
  const rows = pluckArray(data, "cards");
  const out: DashboardCardSource[] = [];
  for (const row of rows) {
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

/**
 * Read the `runs` array off the copilot read-model payload → WorkflowRunRef[]. A
 * malformed payload → `[]`. Copies ONLY the frozen WorkflowRunRef field names.
 */
function readRunRefs(data: unknown): readonly WorkflowRunRef[] {
  const rows = pluckArray(data, "runs");
  const out: WorkflowRunRef[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (
      typeof r["workflowId"] === "string" &&
      typeof r["trigger"] === "string" &&
      typeof r["state"] === "string" &&
      typeof r["idempotencyKey"] === "string"
    ) {
      out.push({
        workflowId: r["workflowId"] as WorkflowRunRef["workflowId"],
        trigger: r["trigger"] as WorkflowRunRef["trigger"],
        state: r["state"] as WorkflowRunRef["state"],
        idempotencyKey: r["idempotencyKey"],
        // `auditRefs` is DROPPED by the 8.2 projector anyway; carry an array so the
        // frozen shape is complete (the projector never reads a raw ref out).
        auditRefs: Array.isArray(r["auditRefs"])
          ? (r["auditRefs"].filter((x): x is string => typeof x === "string") as WorkflowRunRef["auditRefs"])
          : [],
      });
    }
  }
  return out;
}

/**
 * Read the `projections` array off the global-surface read-model payload →
 * GclProjection[]. A malformed payload → `[]`. The §6 raw-content re-validation
 * still happens in `queries.ts`'s `sanitizeGlobal` (the frozen GclProjectionSchema
 * `.refine` gate) — this guard only narrows the transport shape; it never relaxes
 * the sanitization gate.
 */
function readProjections(data: unknown): readonly GclProjection[] {
  const rows = pluckArray(data, "projections");
  const out: GclProjection[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (
      typeof r["workspaceId"] === "string" &&
      typeof r["visibilityLevel"] === "string" &&
      typeof r["projectionType"] === "string" &&
      typeof r["sanitizedPayload"] === "object" &&
      r["sanitizedPayload"] !== null &&
      Array.isArray(r["sourceRefs"])
    ) {
      out.push({
        workspaceId: r["workspaceId"] as GclProjection["workspaceId"],
        visibilityLevel: r["visibilityLevel"] as GclProjection["visibilityLevel"],
        projectionType: r["projectionType"],
        sanitizedPayload: r["sanitizedPayload"] as GclProjection["sanitizedPayload"],
        sourceRefs: r["sourceRefs"] as GclProjection["sourceRefs"],
      });
    }
  }
  return out;
}

/**
 * Read the `changes` array off the recent-changes read-model payload → candidate
 * UiSafeRecentChange[]. A malformed payload → `[]`. Copies ONLY the four allowlisted
 * field names — a stray raw field on a row never rides through. The single-line `summary`
 * re-validation (the leak gate) still happens in `queries.ts`'s `sanitizeRecentChanges`
 * (the frozen UiSafeRecentChangeSchema) — this guard only narrows the transport shape.
 */
function readRecentChanges(data: unknown): readonly UiSafeRecentChange[] {
  const rows = pluckArray(data, "changes");
  const out: UiSafeRecentChange[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (
      typeof r["changeId"] === "string" &&
      typeof r["kind"] === "string" &&
      typeof r["summary"] === "string" &&
      typeof r["occurredAt"] === "string"
    ) {
      out.push({
        changeId: r["changeId"],
        kind: r["kind"],
        summary: r["summary"],
        occurredAt: r["occurredAt"],
      });
    }
  }
  return out;
}

/**
 * Read the `projects` array off the project-dashboards read-model payload → candidate
 * UiSafeProjectDashboard[]. A malformed payload → `[]`; a non-object row is dropped. This is
 * a THIN transport narrowing only — every field (and the REQ-F-011 cross-field progress
 * checks) is re-validated by `queries.ts`'s `sanitizeProjectDashboards` against the frozen
 * UiSafeProjectDashboardSchema before it reaches the renderer.
 *
 * INTENTIONAL divergence from `readRecentChanges`: that guard field-copies and silently DROPS
 * a malformed row; this one passes any object row through so the re-validation fails the WHOLE
 * list CLOSED on a bad row — the safer choice for this richer nested shape (a malformed nested
 * progress/prose row is better treated as tampering than silently dropped).
 */
function readProjectDashboards(data: unknown): readonly UiSafeProjectDashboard[] {
  const out: UiSafeProjectDashboard[] = [];
  for (const row of pluckArray(data, "projects")) {
    if (typeof row === "object" && row !== null) {
      out.push(row as UiSafeProjectDashboard); // candidate — re-validated downstream
    }
  }
  return out;
}

/** Pull `data[key]` as an array; anything else (absent / non-array) → `[]`. */
function pluckArray(data: unknown, key: string): readonly unknown[] {
  if (typeof data !== "object" || data === null) return [];
  const v = (data as Record<string, unknown>)[key];
  return Array.isArray(v) ? v : [];
}

// ── a read-model GET that folds a benign miss to an empty payload ─────────────

/**
 * Read one read-model row and fold the outcome: a genuine store fault → a typed
 * `err`; the benign `not_found` MISS → `ok(undefined)` (an absent read-model is an
 * EMPTY result, NOT an error — the workflows populate the row later); a hit →
 * `ok(record)`. Keeps the "absent read-model = empty ok" rule in ONE place.
 */
async function getReadModel(
  repo: ReadModelRepository,
  readModelKey: string,
  workspaceId: string | null,
): Promise<Result<ReadModelRecord | undefined, FailureVariant>> {
  const r = await repo.get(readModelKey, workspaceId);
  if (isErr(r)) {
    return r.error.code === "not_found" ? ok(undefined) : err(storeFault());
  }
  return ok(r.value);
}

// ── workspace registry (fail-closed known-workspace membership) ───────────────

/**
 * Resolve whether `workspaceId` is a KNOWN / in-scope workspace by reading the
 * global workspace-registry read-model (`{ workspaceIds: string[] }`). FAIL-CLOSED:
 * an ABSENT registry (or a store fault, or a workspace not in the set) → NOT known,
 * so a workspace-scoped read for it returns a typed err rather than any data. A
 * genuine store fault is surfaced as a typed err (distinct from "not known") so the
 * caller degrades rather than silently 404s a real workspace on a transient fault.
 */
async function resolveKnownWorkspace(
  repo: ReadModelRepository,
  workspaceId: string,
): Promise<Result<boolean, FailureVariant>> {
  const r = await repo.get(READ_MODEL_KEYS.registry, null);
  if (isErr(r)) {
    // An absent registry is a benign miss → no workspace is known yet (fail-closed).
    // A genuine fault degrades.
    return r.error.code === "not_found" ? ok(false) : err(storeFault());
  }
  const ids = pluckArray(r.value.data, "workspaceIds");
  return ok(ids.some((id) => id === workspaceId));
}

// ── the port adapter factory ──────────────────────────────────────────────────

/** Dependencies for {@link createDbReadModelQueryPort} — the two backing @sow/db repos. */
export interface DbReadModelQueryDeps {
  readonly readModels: ReadModelRepository;
  readonly approvals: ApprovalRepository;
}

/**
 * The @sow/db-backed read-model query port. SEAM-VS-STORE NOTE: the
 * `ReadModelQueryPort` declared in `queries.ts` types its methods SYNCHRONOUS
 * (`() => Result<...>`), because the fake unit-test seam is in-memory. @sow/db I/O
 * is fundamentally ASYNC (`Promise<Result<..., DbError>>`), so a faithful real
 * binding cannot be synchronous without blocking. This adapter therefore exposes an
 * ASYNC-shaped port (methods return `Promise<Result<...>>`). Wiring it behind the
 * query router (which currently reads the sync port) is the integrator's follow-up
 * (make the query resolvers `await` the port — `authedResolver` already awaits an
 * async handler); that touches `queries.ts`, OUT OF SCOPE for this port-adapter
 * slice. Each method's redaction/fail-closed contract is identical to the sync seam.
 */
export interface DbReadModelQueryPortAsync {
  readonly dashboardCards: () => Promise<Result<readonly DashboardCardSource[], FailureVariant>>;
  readonly workspaceCards: (
    workspaceId: string,
  ) => Promise<Result<readonly DashboardCardSource[], FailureVariant>>;
  readonly projectCards: (
    workspaceId: string,
    projectId: string,
  ) => Promise<Result<readonly DashboardCardSource[], FailureVariant>>;
  readonly ingestionInbox: (
    workspaceId: string,
  ) => Promise<Result<readonly Approval[], FailureVariant>>;
  readonly approvalInbox: (
    workspaceId: string,
  ) => Promise<Result<readonly Approval[], FailureVariant>>;
  readonly copilotSurface: (
    workspaceId: string,
  ) => Promise<Result<readonly WorkflowRunRef[], FailureVariant>>;
  readonly globalSurface: () => Promise<Result<readonly GclProjection[], FailureVariant>>;
  readonly recentChanges: (
    workspaceId: string,
  ) => Promise<Result<readonly UiSafeRecentChange[], FailureVariant>>;
  readonly projectDashboards: (
    workspaceId: string,
  ) => Promise<Result<readonly UiSafeProjectDashboard[], FailureVariant>>;
}

/**
 * Build the async @sow/db-backed read-model query port. The `ReadModelQueryPort`
 * declared in `queries.ts` is SYNCHRONOUS; @sow/db I/O is async. The integrator
 * wires this async port behind the query router's `authedResolver` (already async-
 * tolerant). Each method:
 *   • card surfaces  → read the read-model row, fold a miss to empty, project `data`;
 *   • inbox surfaces → list PENDING approvals (workspace scope is a read-model
 *                      concern the workflows own; the Approval model carries no
 *                      workspaceId — see @sow/db approvals schema), fail closed on
 *                      an unknown workspace so no approval crosses for one;
 *   • global surface → read the global GCL projections (the §6 re-validation stays
 *                      in `queries.ts`).
 */
export function createDbReadModelQueryPort(
  deps: DbReadModelQueryDeps,
): DbReadModelQueryPortAsync {
  const { readModels, approvals } = deps;

  /** Read a workspace-scoped card read-model, fail-closed on an unknown workspace. */
  const workspaceScopedCards = async (
    readModelKey: string,
    workspaceId: string,
  ): Promise<Result<readonly DashboardCardSource[], FailureVariant>> => {
    const known = await resolveKnownWorkspace(readModels, workspaceId);
    if (isErr(known)) return known;
    if (!known.value) return err(unknownWorkspace());
    const rm = await getReadModel(readModels, readModelKey, workspaceId);
    if (isErr(rm)) return rm;
    return ok(rm.value === undefined ? [] : readCardSources(rm.value.data));
  };

  /** List PENDING approvals for a KNOWN workspace (fail-closed on unknown). */
  const pendingApprovals = async (
    workspaceId: string,
  ): Promise<Result<readonly Approval[], FailureVariant>> => {
    const known = await resolveKnownWorkspace(readModels, workspaceId);
    if (isErr(known)) return known;
    if (!known.value) return err(unknownWorkspace());
    const r = await approvals.listByStatus("pending");
    if (isErr(r)) {
      // A benign empty inbox surfaces as ok([]) from the repo, not not_found; any
      // DbError here is a genuine store fault (§16 degrade, redaction-safe).
      return err(storeFault());
    }
    return ok(r.value);
  };

  return {
    async dashboardCards(): Promise<Result<readonly DashboardCardSource[], FailureVariant>> {
      // The Global Today dashboard is a GLOBAL (workspaceId = null) read-model; an
      // absent row is an EMPTY ok list (no workspace gate — this surface is
      // cross-workspace-safe by construction, populated by the workflows).
      const rm = await getReadModel(readModels, READ_MODEL_KEYS.dashboard, null);
      if (isErr(rm)) return rm;
      return ok(rm.value === undefined ? [] : readCardSources(rm.value.data));
    },

    workspaceCards(
      workspaceId: string,
    ): Promise<Result<readonly DashboardCardSource[], FailureVariant>> {
      return workspaceScopedCards(READ_MODEL_KEYS.workspace, workspaceId);
    },

    projectCards(
      workspaceId: string,
      _projectId: string,
    ): Promise<Result<readonly DashboardCardSource[], FailureVariant>> {
      // The project id selects WITHIN the workspace's project read-model `data`; the
      // workspace gate is the fail-closed boundary (an unknown workspace never
      // reaches the project rows). The concrete per-project row selection is a
      // read-model shape the workflows own — until then the workspace-scoped project
      // read-model is served whole (empty when absent).
      return workspaceScopedCards(READ_MODEL_KEYS.project, workspaceId);
    },

    ingestionInbox(workspaceId: string): Promise<Result<readonly Approval[], FailureVariant>> {
      return pendingApprovals(workspaceId);
    },

    approvalInbox(workspaceId: string): Promise<Result<readonly Approval[], FailureVariant>> {
      return pendingApprovals(workspaceId);
    },

    async copilotSurface(
      workspaceId: string,
    ): Promise<Result<readonly WorkflowRunRef[], FailureVariant>> {
      const known = await resolveKnownWorkspace(readModels, workspaceId);
      if (isErr(known)) return known;
      if (!known.value) return err(unknownWorkspace());
      const rm = await getReadModel(readModels, READ_MODEL_KEYS.copilot, workspaceId);
      if (isErr(rm)) return rm;
      return ok(rm.value === undefined ? [] : readRunRefs(rm.value.data));
    },

    async recentChanges(
      workspaceId: string,
    ): Promise<Result<readonly UiSafeRecentChange[], FailureVariant>> {
      // Workspace-scoped, fail-closed (unknown workspace never reaches the rows). An
      // absent row is an EMPTY ok list. The candidate rows are RE-VALIDATED (single-line
      // summary leak gate) by `queries.ts`'s sanitizeRecentChanges against the frozen
      // UiSafeRecentChangeSchema — this binding only narrows the transport shape.
      const known = await resolveKnownWorkspace(readModels, workspaceId);
      if (isErr(known)) return known;
      if (!known.value) return err(unknownWorkspace());
      const rm = await getReadModel(readModels, READ_MODEL_KEYS.recentChanges, workspaceId);
      if (isErr(rm)) return rm;
      return ok(rm.value === undefined ? [] : readRecentChanges(rm.value.data));
    },

    async projectDashboards(
      workspaceId: string,
    ): Promise<Result<readonly UiSafeProjectDashboard[], FailureVariant>> {
      // Workspace-scoped, fail-closed. Candidate rows are re-validated (incl. the REQ-F-011
      // cross-field progress checks) by queries.ts's sanitizeProjectDashboards.
      const known = await resolveKnownWorkspace(readModels, workspaceId);
      if (isErr(known)) return known;
      if (!known.value) return err(unknownWorkspace());
      const rm = await getReadModel(readModels, READ_MODEL_KEYS.projectDashboards, workspaceId);
      if (isErr(rm)) return rm;
      return ok(rm.value === undefined ? [] : readProjectDashboards(rm.value.data));
    },

    async globalSurface(): Promise<Result<readonly GclProjection[], FailureVariant>> {
      // The GCL cross-workspace surface is a GLOBAL read-model (workspaceId = null);
      // an absent row is an EMPTY ok list. The §6 raw-content re-validation is done
      // by `queries.ts`'s sanitizeGlobal against the frozen GclProjectionSchema.
      const rm = await getReadModel(readModels, READ_MODEL_KEYS.global, null);
      if (isErr(rm)) return rm;
      return ok(rm.value === undefined ? [] : readProjections(rm.value.data));
    },
  };
}

// Re-export the seam type so the integrator imports the port + its adapter from one
// place, mirroring how `commands.ts` re-exports its port surface.
export type { ReadModelQueryPort };
export type { ReadModelRepository, ApprovalRepository, ReadModelRecord, DbError };
