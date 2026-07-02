// Task 8.3 — Query procedures: read-model serving (§13 read-only, §10 UI-safe,
// §6 WS-8 cross-workspace, REQ-UX-002 global-surface sanitization).
//
// READ-ONLY tRPC query procedures (no side effects — §13) that serve UI-safe read
// models: the dashboard (Global Today), a workspace surface, a project surface,
// the ingestion + approval inboxes, and a Copilot read surface. Every procedure:
//   1. runs BEHIND the 8.1 auth gate via the 8.2 `authedResolver` seam (an
//      unauthenticated caller gets the interceptor's typed `err` as DATA);
//   2. returns a `Result<T, FailureVariant>` — never throws across the boundary
//      (§16); a thrown port is caught by `authedResolver` and mapped to a typed
//      `degraded_unavailable` err;
//   3. returns ONLY UI-safe projection shapes (via the 8.2 projectors) — a domain
//      record's secret / raw / ref fields never cross;
//   4. routes an unknown / out-of-scope workspace to the port's typed not-found /
//      forbidden `err` — NEVER a partial raw leak;
//   5. serves the GLOBAL cross-workspace surface as GCL sanitized grouped results
//      only (drill-down refs + short summaries, never raw cross-workspace content
//      inline — REQ-UX-002/§6). The global surface RE-VALIDATES each projection
//      through the frozen `GclProjectionSchema` (whose `.refine` is the §6 raw-
//      content gate), so a projection carrying a multi-line/over-length raw value
//      fails closed rather than inlining a workspace-isolation breach.
//
// The read-model data is injected through {@link ReadModelQueryPort}; the fake is
// the unit-test seam, the real @sow/db read-model binding is the integrator step.
// PURE-ish over the port: no I/O of its own beyond the injected port + the frozen
// schema/projector calls.
//
// Input validation uses tRPC's PLAIN-FUNCTION validator (no zod dependency in the
// worker) — it narrows the transport payload to the typed input; a truly
// malformed payload (missing/non-string workspaceId) is a transport-level bad
// request handled redaction-safely by the 8.2 `errorFormatter` net, while a
// well-formed-but-UNKNOWN workspace is the port's typed `err(FailureVariant)`
// returned as DATA (never a throw — §16).
import {
  GclProjectionSchema,
  failure,
  ok,
  err,
  type Result,
  type FailureVariant,
  type Approval,
  type WorkflowRunRef,
  type GclProjection,
  type UiSafeApproval,
  type UiSafeDashboardCard,
  type UiSafeWorkflowRunRef,
} from "@sow/contracts";
import { router, publicProcedure, authedResolver } from "../router";
import {
  toUiSafeApproval,
  toUiSafeWorkflowRunRef,
  toUiSafeDashboardCard,
  type DashboardCardSource,
} from "../projections/uiSafe";

// ── Port ──────────────────────────────────────────────────────────────────────

/**
 * The read-model source for the query procedures. Each method is READ-ONLY and
 * returns a typed `Result` — an unknown / out-of-scope workspace is the port's
 * typed `err(FailureVariant)` (fail-closed, no partial raw leak), NOT a throw.
 *
 * The integrator binds this to the @sow/db read-models (that is the wiring step;
 * unit tests inject a fake). The port hands back FROZEN domain records (Approval /
 * WorkflowRunRef / GclProjection) or the dashboard-card source superset — the
 * procedures do the UI-safe projection, so the redaction boundary lives in ONE
 * place (the 8.2 projectors), never in the port implementation.
 */
export interface ReadModelQueryPort {
  /** Global Today dashboard cards (cross-workspace-safe read-model summaries). */
  readonly dashboardCards: () => Result<readonly DashboardCardSource[], FailureVariant>;
  /** Workspace-scoped dashboard cards; unknown workspace → typed err. */
  readonly workspaceCards: (
    workspaceId: string,
  ) => Result<readonly DashboardCardSource[], FailureVariant>;
  /** Project-scoped dashboard cards; unknown workspace → typed err. */
  readonly projectCards: (
    workspaceId: string,
    projectId: string,
  ) => Result<readonly DashboardCardSource[], FailureVariant>;
  /** Ingestion inbox (pending imported-content approvals); unknown workspace → err. */
  readonly ingestionInbox: (
    workspaceId: string,
  ) => Result<readonly Approval[], FailureVariant>;
  /** Approval inbox (pending external-action approvals); unknown workspace → err. */
  readonly approvalInbox: (
    workspaceId: string,
  ) => Result<readonly Approval[], FailureVariant>;
  /** Copilot read surface (recent workflow runs for the workspace); unknown → err. */
  readonly copilotSurface: (
    workspaceId: string,
  ) => Result<readonly WorkflowRunRef[], FailureVariant>;
  /**
   * Global cross-workspace surface — GCL sanitized projections ONLY (the single
   * cross-workspace read path, WS-8). Never raw cross-workspace content inline.
   */
  readonly globalSurface: () => Result<readonly GclProjection[], FailureVariant>;
}

/** Dependencies for {@link buildQueryRouter}. */
export interface QueryRouterDeps {
  readonly readModel: ReadModelQueryPort;
}

// ── Input shapes + plain-function validators (§3 universal boundary rule) ─────

/** A workspace-scoped query input. */
interface WorkspaceInput {
  readonly workspaceId: string;
}
/** A project-scoped query input. */
interface ProjectInput {
  readonly workspaceId: string;
  readonly projectId: string;
}

/** Read a required non-empty string field off an unknown transport payload. */
function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    // A transport-level malformed payload — the 8.2 errorFormatter net maps this
    // TRPCError to a redaction-safe shape (no raw input echoed). Business-level
    // "unknown workspace" is NOT this path; it is the port's typed Result err.
    throw new Error("invalid_input");
  }
  return value;
}

/** tRPC plain-function validator narrowing an unknown payload → WorkspaceInput. */
function parseWorkspaceInput(value: unknown): WorkspaceInput {
  if (typeof value !== "object" || value === null) throw new Error("invalid_input");
  const source = value as Record<string, unknown>;
  return { workspaceId: requireString(source, "workspaceId") };
}

/** tRPC plain-function validator narrowing an unknown payload → ProjectInput. */
function parseProjectInput(value: unknown): ProjectInput {
  if (typeof value !== "object" || value === null) throw new Error("invalid_input");
  const source = value as Record<string, unknown>;
  return {
    workspaceId: requireString(source, "workspaceId"),
    projectId: requireString(source, "projectId"),
  };
}

// ── Internal helpers (pure; map a port Result → a UI-safe projection Result) ──

/** Map a port's card `Result` through the UI-safe dashboard-card projector. */
function projectCards(
  r: Result<readonly DashboardCardSource[], FailureVariant>,
): Result<readonly UiSafeDashboardCard[], FailureVariant> {
  return r.ok ? ok(r.value.map(toUiSafeDashboardCard)) : r;
}

/** Map a port's approval `Result` through the UI-safe approval projector. */
function projectApprovals(
  r: Result<readonly Approval[], FailureVariant>,
): Result<readonly UiSafeApproval[], FailureVariant> {
  return r.ok ? ok(r.value.map(toUiSafeApproval)) : r;
}

/** Map a port's workflow-run `Result` through the UI-safe workflow-run projector. */
function projectRuns(
  r: Result<readonly WorkflowRunRef[], FailureVariant>,
): Result<readonly UiSafeWorkflowRunRef[], FailureVariant> {
  return r.ok ? ok(r.value.map(toUiSafeWorkflowRunRef)) : r;
}

/**
 * Validate each GCL projection through the FROZEN `GclProjectionSchema` — whose
 * `.refine` is the §6 raw-content gate (key-name-independent: rejects any string
 * value that is multi-line OR over the summary length cap). A projection that
 * carries a raw-content-shaped value fails closed with a typed err rather than
 * inlining a cross-workspace workspace-isolation breach (REQ-UX-002 / WS-8).
 */
function sanitizeGlobal(
  r: Result<readonly GclProjection[], FailureVariant>,
): Result<readonly GclProjection[], FailureVariant> {
  if (!r.ok) return r;
  const out: GclProjection[] = [];
  for (const projection of r.value) {
    const parsed = GclProjectionSchema.safeParse(projection);
    if (!parsed.success) {
      // Redaction-safe: no raw payload / message crosses — only a stable code.
      return err(
        failure("validation_rejected", "global surface projection failed sanitization", {
          cause: { code: "GCL_SANITIZATION_REJECTED" },
        }),
      );
    }
    out.push(parsed.data);
  }
  return ok(out);
}

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * Build the read-only query router the integrator mounts at `appRouter.query`
 * (see `server.ts`'s `mountRouters` seam). Every procedure is a tRPC `.query()`
 * (read-only, §13), wrapped in the 8.2 `authedResolver` (auth gate + §16 typed
 * boundary), and returns a UI-safe projection wrapped in `Result<T,
 * FailureVariant>`.
 */
export function buildQueryRouter(deps: QueryRouterDeps) {
  const { readModel } = deps;
  return router({
    /** Global Today dashboard — UI-safe cards. */
    dashboard: publicProcedure.query(
      authedResolver<undefined, readonly UiSafeDashboardCard[]>(
        (): Result<readonly UiSafeDashboardCard[], FailureVariant> =>
          projectCards(readModel.dashboardCards()),
      ),
    ),

    /** Workspace surface — UI-safe cards; unknown workspace → typed err. */
    workspace: publicProcedure.input(parseWorkspaceInput).query(
      authedResolver<WorkspaceInput, readonly UiSafeDashboardCard[]>(
        (_ctx, input): Result<readonly UiSafeDashboardCard[], FailureVariant> =>
          projectCards(readModel.workspaceCards(input.workspaceId)),
      ),
    ),

    /** Project surface — UI-safe cards; unknown workspace → typed err. */
    project: publicProcedure.input(parseProjectInput).query(
      authedResolver<ProjectInput, readonly UiSafeDashboardCard[]>(
        (_ctx, input): Result<readonly UiSafeDashboardCard[], FailureVariant> =>
          projectCards(readModel.projectCards(input.workspaceId, input.projectId)),
      ),
    ),

    /** Ingestion inbox — UI-safe Approval cards; unknown workspace → typed err. */
    ingestionInbox: publicProcedure.input(parseWorkspaceInput).query(
      authedResolver<WorkspaceInput, readonly UiSafeApproval[]>(
        (_ctx, input): Result<readonly UiSafeApproval[], FailureVariant> =>
          projectApprovals(readModel.ingestionInbox(input.workspaceId)),
      ),
    ),

    /** Approval inbox — UI-safe Approval cards; unknown workspace → typed err. */
    approvalInbox: publicProcedure.input(parseWorkspaceInput).query(
      authedResolver<WorkspaceInput, readonly UiSafeApproval[]>(
        (_ctx, input): Result<readonly UiSafeApproval[], FailureVariant> =>
          projectApprovals(readModel.approvalInbox(input.workspaceId)),
      ),
    ),

    /** Copilot read surface — UI-safe WorkflowRunRef cards; unknown workspace → err. */
    copilot: publicProcedure.input(parseWorkspaceInput).query(
      authedResolver<WorkspaceInput, readonly UiSafeWorkflowRunRef[]>(
        (_ctx, input): Result<readonly UiSafeWorkflowRunRef[], FailureVariant> =>
          projectRuns(readModel.copilotSurface(input.workspaceId)),
      ),
    ),

    /** Global cross-workspace surface — GCL sanitized grouped projections ONLY. */
    global: publicProcedure.query(
      authedResolver<undefined, readonly GclProjection[]>(
        (): Result<readonly GclProjection[], FailureVariant> =>
          sanitizeGlobal(readModel.globalSurface()),
      ),
    ),
  });
}

/** The mounted-router type (for the integrator's `AppRouter` composition). */
export type QueryRouter = ReturnType<typeof buildQueryRouter>;
