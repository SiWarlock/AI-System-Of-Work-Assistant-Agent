// Task 8.3 — System Health query surface (OBS-2 typed HealthItems as
// UiSafeHealthItem, audit-linked ref-only; REQ-S-002 Employer-Work egress status).
//
// READ-ONLY tRPC query procedures (no side effects — §13). The System Health query
// surfaces the OBS-2 typed HealthItems (open / acknowledged / resolved) as
// UiSafeHealthItem — audit-linked but REF-ONLY, never raw: the 8.2 projector
// DROPS `message` (may echo raw content / a secret), `auditRef`, `parityReportRef`,
// and `factIdentity` (internal refs). The Employer-Work egress-acknowledgment
// status (REQ-S-002) is surfaced via this System-Health / workspace-settings query
// so the UI can show whether raw Employer-Work egress is OFF (fail-closed default).
//
// Every procedure runs behind the 8.1 auth gate (8.2 `authedResolver`), returns a
// `Result<T, FailureVariant>` (never throws across the boundary — §16), and an
// unknown / out-of-scope workspace returns the port's typed not-found err — never
// a partial raw leak.
//
// The data is injected through {@link SystemHealthQueryPort}; the fake is the
// unit-test seam, the real @sow/db binding is the integrator step.
//
// Input validation uses tRPC's PLAIN-FUNCTION validator (no zod dependency in the
// worker): a malformed transport payload is a bad request handled redaction-safely
// by the 8.2 `errorFormatter` net; a well-formed-but-UNKNOWN workspace is the
// port's typed `err(FailureVariant)` returned as DATA (never a throw — §16).
import {
  ok,
  type Result,
  type FailureVariant,
  type HealthItem,
  type UiSafeHealthItem,
} from "@sow/contracts";
import { router, publicProcedure, authedResolver } from "../router";
import { toUiSafeHealthItem } from "../projections/uiSafe";

// ── UI-safe egress status (REQ-S-002) ─────────────────────────────────────────

/**
 * The UI-safe Employer-Work egress-status read-model (REQ-S-002). Purpose-built
 * UI shape — every field is UI-safe by construction (no raw content, no secret):
 *   - `workspaceId`                    : which workspace this status is for;
 *   - `employerRawEgressAcknowledged`  : is raw Employer-Work egress ACK'd ON?
 *                                        (OFF ⇒ raw content is local-only / veto);
 *   - `zeroEgressOnly`                 : is this workspace pinned to a local
 *                                        zero-egress provider (fail-closed)?
 * There is no frozen seam model for this projection (like `DashboardCardSource`,
 * it is a §10 read-model construct), so it is defined here as a standalone shape.
 */
export interface UiSafeEgressStatus {
  workspaceId: string;
  employerRawEgressAcknowledged: boolean;
  zeroEgressOnly: boolean;
}

// ── Port ──────────────────────────────────────────────────────────────────────

/**
 * The System-Health read-model source. READ-ONLY; each method returns a typed
 * `Result`. `healthItems` hands back FROZEN {@link HealthItem} records — the
 * procedure does the UI-safe projection, so the redaction boundary lives in ONE
 * place (the 8.2 projector). `egressStatus` returns the UI-safe egress shape; the
 * procedure RE-PROJECTS it to the allowlisted fields (defense-in-depth — an
 * over-broad port result cannot leak an extra field). An unknown workspace is the
 * port's typed not-found err (fail-closed, no partial raw leak), NOT a throw.
 *
 * The integrator binds this to the @sow/db read-models + the egress-policy read;
 * unit tests inject a fake.
 */
export interface SystemHealthQueryPort {
  /** OBS-2 typed HealthItems across the lifecycle (open / acknowledged / resolved). */
  readonly healthItems: () => MaybeAsyncResult<readonly HealthItem[]>;
  /** Employer-Work egress-acknowledgment status; unknown workspace → typed err. */
  readonly egressStatus: (
    workspaceId: string,
  ) => MaybeAsyncResult<UiSafeEgressStatus>;
}

/**
 * A port result delivered synchronously (the in-memory unit-test fake) or async (the
 * real @sow/db / health-surface binding at boot). Each resolver `await`s it before
 * projecting and `authedResolver` already awaits an async handler — so the same
 * router serves both. Mirrors the async-tolerant widening on `ReadModelQueryPort`.
 */
type MaybeAsyncResult<T> = Result<T, FailureVariant> | Promise<Result<T, FailureVariant>>;

/** Dependencies for {@link buildSystemHealthRouter}. */
export interface SystemHealthRouterDeps {
  readonly systemHealth: SystemHealthQueryPort;
}

// ── Input shape + plain-function validator (§3 universal boundary rule) ───────

/** A workspace-scoped query input. */
export interface WorkspaceInput {
  readonly workspaceId: string;
}

/** tRPC plain-function validator narrowing an unknown payload → WorkspaceInput. */
function parseWorkspaceInput(value: unknown): WorkspaceInput {
  if (typeof value !== "object" || value === null) throw new Error("invalid_input");
  const source = value as Record<string, unknown>;
  const workspaceId = source["workspaceId"];
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    // Transport-level malformed payload — mapped redaction-safely by the 8.2
    // errorFormatter net. "Unknown workspace" is NOT this path (that is the
    // port's typed Result err).
    throw new Error("invalid_input");
  }
  return { workspaceId };
}

// ── Internal helper (pure) ────────────────────────────────────────────────────

/** Map a port's HealthItem `Result` through the UI-safe health-item projector. */
function projectHealthItems(
  r: Result<readonly HealthItem[], FailureVariant>,
): Result<readonly UiSafeHealthItem[], FailureVariant> {
  return r.ok ? ok(r.value.map(toUiSafeHealthItem)) : r;
}

/**
 * Reconstruct a UI-safe egress status from ONLY the three allowlisted fields.
 * Defense-in-depth: like every other query surface, the egress status is
 * re-projected rather than passed through verbatim — so a port (or a future
 * @sow/db binding) that returned an OVER-BROAD object cannot leak an extra field
 * (raw content, a secret, an internal ref) onto the renderer. Pure; no throw.
 */
function toUiSafeEgressStatus(status: UiSafeEgressStatus): UiSafeEgressStatus {
  return {
    workspaceId: status.workspaceId,
    employerRawEgressAcknowledged: status.employerRawEgressAcknowledged,
    zeroEgressOnly: status.zeroEgressOnly,
  };
}

/** Map a port's egress-status `Result` through the UI-safe egress reconstruction. */
function projectEgressStatus(
  r: Result<UiSafeEgressStatus, FailureVariant>,
): Result<UiSafeEgressStatus, FailureVariant> {
  return r.ok ? ok(toUiSafeEgressStatus(r.value)) : r;
}

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * Build the read-only System-Health router the integrator mounts under the
 * appRouter (e.g. `appRouter.systemHealth`). Both procedures are tRPC `.query()`
 * (read-only, §13), wrapped in the 8.2 `authedResolver` (auth gate + §16 typed
 * boundary), and return UI-safe projections wrapped in `Result`.
 */
export function buildSystemHealthRouter(deps: SystemHealthRouterDeps) {
  const { systemHealth } = deps;
  return router({
    /** OBS-2 typed HealthItems projected to UI-safe (audit-linked ref-only). */
    items: publicProcedure.query(
      authedResolver<undefined, readonly UiSafeHealthItem[]>(
        async (): Promise<Result<readonly UiSafeHealthItem[], FailureVariant>> =>
          projectHealthItems(await systemHealth.healthItems()),
      ),
    ),

    /** Employer-Work egress-acknowledgment status (REQ-S-002); unknown ws → err.
     *  Re-projected to the allowlisted egress fields — no verbatim pass-through, so
     *  an over-broad port result cannot leak an extra field to the renderer. */
    egressStatus: publicProcedure.input(parseWorkspaceInput).query(
      authedResolver<WorkspaceInput, UiSafeEgressStatus>(
        async (_ctx, input): Promise<Result<UiSafeEgressStatus, FailureVariant>> =>
          projectEgressStatus(await systemHealth.egressStatus(input.workspaceId)),
      ),
    ),
  });
}

/** The mounted-router type (for the integrator's `AppRouter` composition). */
export type SystemHealthRouter = ReturnType<typeof buildSystemHealthRouter>;
