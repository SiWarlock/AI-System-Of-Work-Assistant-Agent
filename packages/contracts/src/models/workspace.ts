// Workspace seam model (task 1.5, §3/§6). The top-level per-workspace aggregate:
// identity + governance posture (data ownership, default cross-workspace
// visibility) + the embedded EgressPolicy and ProviderMatrix that the §5 egress
// veto and §7 route resolution read. Implements REQ-F-001. Zod is the single
// source of truth: the TS type is `z.infer` (surfaced as an explicit nameable
// interface), the JSON Schema is generated via `emitJsonSchema`. PURE — imports
// only foundation primitives/enums + the EgressPolicy/ProviderMatrix seam models
// (no app/adapter code).
import { z } from "zod";
import { WorkspaceIdSchema, BrainIdSchema } from "../primitives/zod-brands";
import { WorkspaceTypeSchema, DataOwnerSchema, VisibilityLevelSchema } from "./shared-enums";
import { EgressPolicySchema } from "./egress-policy";
import { ProviderMatrixSchema } from "./provider-matrix";
import type { EgressPolicy } from "./egress-policy";
import type { ProviderMatrix } from "./provider-matrix";
import type { WorkspaceId } from "../primitives/ids";
import type { BrainId } from "../primitives/zod-brands";
import type { WorkspaceType, DataOwner, VisibilityLevel } from "../primitives/enums";

/** Stable JSON-Schema `$id` for the schema registry. */
export const WORKSPACE_SCHEMA_ID = "sow:workspace" as const;

// Explicit output interface + annotation: the inferred type would otherwise force
// the declaration emitter to name `ids.ts`'s module-private `__brand` symbol
// (TS4023) via the branded `WorkspaceId`/`BrainId` fields. A nameable `Workspace`
// type sidesteps that (the same workaround `egress-policy.ts` and
// `provider-matrix.ts` use); `.strict()` runtime rejection of unknown keys and the
// `.refine()` referential pin are unaffected. The embedded `EgressPolicy` and
// `ProviderMatrix` are carried BY VALUE (Appendix A) so the §5/§7 gates evaluate a
// workspace without extra lookups.
//
// arch_gap: §3/§6/Appendix A leave `markdownRepoPath` an unconstrained path string
// (no repo-layout/scheme taxonomy is pinned) and `gbrainBrainId` an OPEN branded
// non-empty string (the brain-id namespace/format is not specified upstream) —
// both modeled OPEN rather than inventing a closed format the spec doesn't name.
export interface Workspace {
  id: WorkspaceId;
  name: string;
  type: WorkspaceType;
  dataOwner: DataOwner;
  markdownRepoPath: string;
  gbrainBrainId: BrainId;
  defaultVisibility: VisibilityLevel;
  egressPolicy: EgressPolicy;
  providerMatrix: ProviderMatrix;
}

interface WorkspaceInput {
  id: string;
  name: string;
  type: WorkspaceType;
  dataOwner: DataOwner;
  markdownRepoPath: string;
  gbrainBrainId: string;
  defaultVisibility: VisibilityLevel;
  egressPolicy: z.input<typeof EgressPolicySchema>;
  providerMatrix: z.input<typeof ProviderMatrixSchema>;
}

// Referential pin (1.5 bullet / Appendix A): the workspace id MUST equal the
// workspaceId carried by both embedded sub-models. A mismatch is a contradictory
// aggregate (an EgressPolicy/ProviderMatrix governing a different workspace).
const referentiallyConsistent = (w: Workspace): boolean =>
  w.id === w.egressPolicy.workspaceId && w.id === w.providerMatrix.workspaceId;

export const WorkspaceSchema: z.ZodType<Workspace, z.ZodTypeDef, WorkspaceInput> = z
  .object({
    id: WorkspaceIdSchema,
    name: z.string().min(1),
    type: WorkspaceTypeSchema,
    dataOwner: DataOwnerSchema,
    markdownRepoPath: z.string().min(1),
    gbrainBrainId: BrainIdSchema,
    defaultVisibility: VisibilityLevelSchema,
    egressPolicy: EgressPolicySchema,
    providerMatrix: ProviderMatrixSchema,
  })
  .strict()
  .refine(referentiallyConsistent, {
    message: "id must equal egressPolicy.workspaceId and providerMatrix.workspaceId",
    path: ["id"],
  });

/** Partial accepted by {@link defaultWorkspace} — identity + the unconstrained
 * fields the caller must name; governance fields default to the safe posture. */
export interface DefaultWorkspacePartial {
  id: string;
  name: string;
  type: WorkspaceType;
  markdownRepoPath: string;
  gbrainBrainId: string;
  /** Override the type-derived data-owner default. */
  dataOwner?: DataOwner;
  /** Override the most-restrictive visibility default (`isolated`). */
  defaultVisibility?: VisibilityLevel;
}

/**
 * Safe-default Workspace factory (1.5 bullet / REQ-F-001). Applies the pinned safe
 * posture: an `employer_work` workspace defaults `dataOwner` to `"employer"` AND
 * defaults egress CLOSED (`employerRawEgressAcknowledged===false`,
 * `rawContentAllowedProcessors` empty) — fail-closed for safety rule 5. Non-employer
 * workspaces default `dataOwner` to `"user"`. The embedded sub-models' `workspaceId`
 * is wired from `id` so the referential pin always holds; the result is parsed,
 * returning a fully-valid `Workspace`.
 */
export function defaultWorkspace(partial: DefaultWorkspacePartial): Workspace {
  const dataOwner: DataOwner =
    partial.dataOwner ?? (partial.type === "employer_work" ? "employer" : "user");
  const defaultVisibility: VisibilityLevel = partial.defaultVisibility ?? "isolated";

  return WorkspaceSchema.parse({
    id: partial.id,
    name: partial.name,
    type: partial.type,
    dataOwner,
    markdownRepoPath: partial.markdownRepoPath,
    gbrainBrainId: partial.gbrainBrainId,
    defaultVisibility,
    // Egress defaults CLOSED — no acknowledgment, no raw-content processors.
    egressPolicy: {
      workspaceId: partial.id,
      allowedProcessors: [],
      rawContentAllowedProcessors: [],
      employerRawEgressAcknowledged: false,
    },
    // Provider matrix defaults empty: no allowed providers, no capability routes,
    // raw cloud egress disabled.
    providerMatrix: {
      workspaceId: partial.id,
      allowedProviders: [],
      capabilityDefaults: {},
      rawCloudEgressEnabled: false,
    },
  });
}
