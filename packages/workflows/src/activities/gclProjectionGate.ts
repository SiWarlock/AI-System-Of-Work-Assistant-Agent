// @sow/workflows — task 25.2/25.4 (PKG-W3) ACTIVITY: the REAL binding of the
// dormant {@link ProjectionGate} seam (activities/buildGclProjection.ts) to the
// actual @sow/knowledge GCL Visibility Gate.
//
// buildGclProjection.ts's own doc comment (pre-25.2) named this exact gap: "no
// production factory binds this to a real @sow/knowledge admitProjection/
// serveProjection implementation today... a future implementation of
// ProjectionGate for THIS activity should call through @sow/knowledge
// serveProjection directly, mirroring [crossWorkspaceRead.ts], not re-derive
// the gate logic here." This module is that binding.
//
// ⚠ WHY `serveProjection`, NOT `admitProjection` DIRECTLY: @sow/knowledge's own
// barrel (packages/knowledge/src/index.ts, task 24.78) DELIBERATELY does not
// re-export `./gcl/visibility-gate` (the module `admitProjection` lives in) —
// the package.json `exports` map explicitly denies that subpath too. The
// SANCTIONED cross-package entry point is `gcl/projection.ts`'s
// `serveProjection` (exported via `export * from "./gcl/projection"`), which
// re-runs the identical Visibility Gate composition (ajv structural + Zod
// raw-content refine + §5 visibility policy) that module's own comment names
// this exact seam ("Phase 25.2/25.4") as the wiring point for. Calling through
// the sanctioned re-export, never the internal module, respects the OTHER
// track's (packages/knowledge) layer boundary.
//
// This is an ACTIVITY, NOT workflow code — it MAY use the real @sow/knowledge
// gate. The only extra I/O it needs is a workspace lookup (workspace configs
// are boot-resolved, not fetched per-call in this codebase's established
// pattern — mirrors @sow/policy's `ResolvedWorkspacePolicy` resolution style).
//
// §16: never throws. An unresolvable source workspace or a gate rejection folds
// to a typed {@link GateRejection} — the driver parks in projection_stale; the
// candidate is NEVER returned (no downgrade-and-store).
import { serveProjection } from "@sow/knowledge";
import type { Workspace, WorkspaceId, GclProjection, Result } from "@sow/contracts";
import type {
  ProjectionGate,
  CandidateProjection,
  GateRejection,
} from "./buildGclProjection";

/**
 * Resolve the source Workspace a candidate projection claims to originate from.
 * SYNCHRONOUS by design (workspace configs are boot-resolved, not I/O per call).
 * Returns `undefined` for an unknown workspace — the gate then fails closed
 * rather than admitting against a guessed default.
 */
export interface WorkspaceLookup {
  (workspaceId: WorkspaceId): Workspace | undefined;
}

/**
 * Build the REAL {@link ProjectionGate} over @sow/knowledge's sanctioned
 * `serveProjection` entry point (the GCL Visibility Gate). Every candidate is
 * run through the FULL composed gate (ajv structural + Zod raw-content-shape
 * refine + §5 visibility policy) — a candidate carrying raw content, or
 * exceeding the source workspace's default visibility, is HARD-rejected (never
 * sanitized-and-stored). An unresolvable source workspace is ALSO a hard reject
 * (fail-closed under uncertainty — never admit against a guessed workspace
 * posture). Never throws.
 */
export function createGclProjectionGate(lookupWorkspace: WorkspaceLookup): ProjectionGate {
  return {
    async admit(candidate: CandidateProjection): Promise<Result<GclProjection, GateRejection>> {
      const sourceWorkspace = lookupWorkspace(candidate.workspaceId);
      if (sourceWorkspace === undefined) {
        return {
          ok: false,
          error: {
            reason: `no registered workspace for ${String(candidate.workspaceId)} — cannot admit (fail-closed)`,
          },
        };
      }
      // The candidate is UNTRUSTED shape until the gate re-validates it — pass it
      // through as-is; `serveProjection` (via `admitProjection`) runs the full
      // ajv+Zod re-gate regardless of what this activity's own type annotation
      // claims (the whole point of the boundary).
      const admitted = await serveProjection(candidate as unknown as GclProjection, sourceWorkspace);
      if (!admitted.ok) {
        return { ok: false, error: { reason: admitted.error.code } };
      }
      return { ok: true, value: admitted.value };
    },
  };
}
