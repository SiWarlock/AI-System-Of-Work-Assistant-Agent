// @sow/workflows — task 7.10 ACTIVITY: build + GATE the sanitized cross-workspace
// GCL projections the DAILY BRIEF's global scope reads (inv-3 leakage seam).
//
// This is an ACTIVITY, NOT workflow code — it runs worker-side and MAY use
// node:crypto (via the @sow/domain key builders, should a derived projection need a
// canonical/idempotency key) + the real @sow/knowledge GCL Visibility Gate
// (authorizeCrossWorkspaceRawRead / admitProjection). It implements
// {@link UpdateProjectionsPort}.
//
// ★★ WHY THIS IS THE LEAKAGE SEAM (REQ-F-005/008, safety rule 4): the daily brief's
// GLOBAL/Coordination view must NEVER read raw cross-workspace content. The ONLY
// cross-workspace read path is the GCL Visibility Gate, which emits SANITIZED,
// visibility-validated {@link GclProjection}s. This activity:
//   1. asks an injected PURE {@link ProjectionSource} for one candidate projection
//      per in-scope workspace (summary/metadata only — busy/free, deadline counts);
//   2. runs EACH candidate through the injected {@link ProjectionGate} (backed by
//      @sow/knowledge `admitProjection`, which recovers the raw-content-shaped-key
//      refine ajv drops + the §5 visibility ceiling);
//   3. returns ONLY admitted, sanitized projections — a candidate carrying raw
//      content is HARD-rejected as `gate_rejected` and NEVER returned (no
//      downgrade-and-store; the driver parks in projection_stale and surfaces 7.5).
// So a raw cross-workspace body can never ride a projection into the global brief.
//
// §16: returns a typed Result — never throws. A stale source or a gate rejection is
// a typed {@link UpdateProjectionsError} the driver maps to projection_stale.
import { ok, err } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  GclProjection,
  SourceRef,
  VisibilityLevel,
} from "@sow/contracts";
import type {
  DailyBriefContext,
  UpdateProjectionsPort,
  UpdateProjectionsError,
} from "../ports/dailyBrief";

/**
 * A candidate cross-workspace projection the {@link ProjectionSource} proposes for
 * ONE in-scope workspace. It is SUMMARY-only by contract intent, but it is still
 * CANDIDATE data until the gate admits it — the source is not trusted to have
 * sanitized correctly, so the gate is the enforcement point (defense in depth).
 */
export interface CandidateProjection {
  readonly workspaceId: WorkspaceId;
  readonly visibilityLevel: VisibilityLevel;
  readonly projectionType: string;
  readonly sanitizedPayload: Record<string, unknown>;
  readonly sourceRefs: readonly SourceRef[];
}

/**
 * The injected PURE source of candidate projections. It projects each in-scope
 * workspace's brain into a SUMMARY candidate (no clock / no I/O beyond the read it
 * was constructed over). It MUST return a typed error rather than a stale/guessed
 * projection when it cannot freshly project a workspace (fail-closed) — the driver
 * folds that to projection_stale.
 */
export interface ProjectionSource {
  project(
    ctx: DailyBriefContext,
  ): Promise<Result<readonly CandidateProjection[], UpdateProjectionsError>>;
}

/**
 * The injected GCL Visibility Gate seam. In production this wraps @sow/knowledge
 * `admitProjection` (the composed ajv ∘ Zod ∘ §5-visibility gate): a candidate
 * carrying raw content OR exceeding the source's default visibility is HARD-rejected
 * — never downgraded. A `false` admission is the leakage HARD-reject (safety rule 4).
 */
export interface ProjectionGate {
  admit(candidate: CandidateProjection): Result<GclProjection, GateRejection>;
}

/** A gate rejection — the projection carried raw content or over-visibility. */
export interface GateRejection {
  readonly reason: string;
}

/** Injected deps for the buildGclProjection activity. */
export interface BuildGclProjectionDeps {
  readonly source: ProjectionSource;
  readonly gate: ProjectionGate;
}

/**
 * Build an {@link UpdateProjectionsPort} that derives one SANITIZED projection per
 * in-scope workspace and runs EACH through the Visibility Gate before returning it.
 * A stale source folds to `projection_stale`; a gate rejection (raw content /
 * over-visibility) folds to `gate_rejected` and the whole update fails closed — the
 * driver parks in projection_stale, so a leaking candidate can NEVER reach the
 * global brief (inv-3). Never throws.
 */
export function createBuildGclProjectionActivity(
  deps: BuildGclProjectionDeps,
): UpdateProjectionsPort {
  return {
    async update(
      ctx: DailyBriefContext,
    ): Promise<Result<readonly GclProjection[], UpdateProjectionsError>> {
      const candidates = await deps.source.project(ctx);
      if (!candidates.ok) {
        // Stale / unfreshable source — fail-closed (no partial projection set).
        return err(candidates.error);
      }

      const admitted: GclProjection[] = [];
      for (const candidate of candidates.value) {
        const decision = deps.gate.admit(candidate);
        if (!decision.ok) {
          // A candidate carrying raw content / over-visibility is a leakage HARD
          // reject (safety rule 4). Fail the WHOLE update closed — never return a
          // partial set that silently drops a workspace, and never downgrade-store.
          const error: UpdateProjectionsError = {
            code: "gate_rejected",
            message: `GCL Visibility Gate rejected a projection for ${String(
              candidate.workspaceId,
            )}: ${decision.error.reason}`,
          };
          return err(error);
        }
        admitted.push(decision.value);
      }

      return ok(admitted);
    },
  };
}
