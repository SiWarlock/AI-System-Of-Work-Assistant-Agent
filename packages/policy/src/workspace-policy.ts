// §5 Workspace policy resolution (REQ-F-001). Flattens the top-level Workspace
// aggregate into a `ResolvedWorkspacePolicy` — the typed, flat view the §5 egress
// veto (3.3), route resolution (3.4), and admission (3.6) read without re-walking
// the aggregate. PURE + deterministic: same input → same output, no clock, no
// randomness, no I/O.
//
// Resolution is TOTAL over a valid Workspace: the referential pin
// (id ≡ egressPolicy.workspaceId ≡ providerMatrix.workspaceId) is already enforced
// by WorkspaceSchema upstream, so no defensive deny is needed here — flattening a
// validated aggregate cannot fail.
import type {
  Workspace,
  EgressPolicy,
  ProviderMatrix,
  WorkspaceType,
  DataOwner,
  VisibilityLevel,
} from "@sow/contracts";

/**
 * Flat typed view of a Workspace's governance posture consumed by the §5/§7 gates.
 * Carries the embedded EgressPolicy + ProviderMatrix BY REFERENCE (Appendix A —
 * by-value in the aggregate) so downstream evaluators read one flat object.
 */
export interface ResolvedWorkspacePolicy {
  readonly workspaceId: string;
  readonly type: WorkspaceType;
  readonly dataOwner: DataOwner;
  readonly defaultVisibility: VisibilityLevel;
  readonly egressPolicy: EgressPolicy;
  readonly providerMatrix: ProviderMatrix;
}

/**
 * Resolve a valid Workspace into its flat policy view. Pure + total: no checks
 * beyond flattening (WorkspaceSchema already enforced the referential pin). The
 * embedded sub-models are carried by reference, unchanged.
 */
export function resolveWorkspacePolicy(w: Workspace): ResolvedWorkspacePolicy {
  return {
    workspaceId: w.id,
    type: w.type,
    dataOwner: w.dataOwner,
    defaultVisibility: w.defaultVisibility,
    egressPolicy: w.egressPolicy,
    providerMatrix: w.providerMatrix,
  };
}
