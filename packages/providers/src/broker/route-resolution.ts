// @sow/providers — broker route resolution (§7 task 5.2).
//
// Resolves the routing target SOLELY from `ProviderMatrix.capabilityDefaults[
// capability]` for the JOB'S OWN workspace. It REUSES @sow/policy `resolveRoute`
// for the capability lookup + allowlist + local-endpoint checks (never
// re-implements §5); it adds only the workspace-BINDING guard so a matrix for a
// different workspace can never silently route a job (fail-closed). There is NO
// hard-wired reference runtime — whatever route policy permits (a runtime OR a
// provider branch) is returned, so any conformance-passing target is routable
// (§7 matrix-may-route-critical-path). PURE; every outcome is a typed
// PolicyDecision, never a throw (§16). REDACTION-SAFE audit refs (ids only).
import type { AgentJob, ProviderMatrix, ProviderRoute } from "@sow/contracts";
import {
  resolveRoute,
  buildAuditSignal,
  denyDecision,
  type LocalProviderConfig,
  type PolicyDecision,
  type AuditSignal,
} from "@sow/policy";

const ROUTE_ACTOR = "broker:route-resolution" as const;
const ROUTE_MARKER = "broker:route-binding-decision" as const;

/**
 * Resolve the permitted `ProviderRoute` for `job` from `matrix`.
 *
 * Fail-closed guards, in order:
 *  1. A null matrix, or a matrix whose `workspaceId` is not the job's workspace,
 *     is malformed input ⇒ MALFORMED_POLICY_INPUT (never a cross-workspace route).
 *  2. Otherwise delegate to @sow/policy `resolveRoute(matrix, job.capability,
 *     localConfig)` — the sole capabilityDefaults resolution, with no implicit
 *     fallback (absence ⇒ deny) and the §5 allowlist / local-endpoint checks.
 *
 * Pure; never throws.
 */
export function resolveJobRoute(
  job: AgentJob,
  matrix: ProviderMatrix,
  localConfig?: LocalProviderConfig,
): PolicyDecision<ProviderRoute> {
  if (matrix == null || typeof matrix !== "object" || matrix.workspaceId !== job.workspaceId) {
    const audit: AuditSignal = buildAuditSignal({
      actor: ROUTE_ACTOR,
      event: "provider.route.workspace_mismatch",
      refs: [
        `ref:job:${job.id}`,
        `ref:workspace:${job.workspaceId}`,
        `ref:matrix-workspace:${matrix == null ? "MISSING" : String(matrix.workspaceId)}`,
      ],
      payloadHash: ROUTE_MARKER,
      beforeSummary: "provider route unresolved",
      afterSummary: "provider matrix is missing or belongs to a different workspace than the job",
      denialCode: "MALFORMED_POLICY_INPUT",
    });
    return denyDecision(
      "MALFORMED_POLICY_INPUT",
      "provider matrix is missing or does not belong to the job's workspace",
      audit,
    );
  }
  return resolveRoute(matrix, job.capability, localConfig);
}
