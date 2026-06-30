// GclProjection seam model (task 1.8, §3/§5/§6/§11). The unit the GCL Visibility
// Gate (REQ-F-005 / WS-8) emits as the SINGLE cross-workspace read path — a
// sanitized, visibility-scoped view of one workspace's facts, never raw content.
// Zod is the single source of truth: the TS type is `z.infer`, the JSON Schema is
// generated via `emitJsonSchema`. PURE — imports only foundation primitives +
// shared shapes/enums.
import { z } from "zod";
import { WorkspaceIdSchema } from "../primitives/zod-brands";
import { VisibilityLevelSchema } from "./shared-enums";
import { SourceRefSchema } from "./shared-shapes";
import type { WorkspaceId } from "../primitives/ids";
import type { VisibilityLevel } from "../primitives/enums";
import type { SourceRef } from "./shared-shapes";

/** Stable JSON-Schema `$id` for the schema registry. */
export const GCL_PROJECTION_SCHEMA_ID = "sow:gcl-projection" as const;

// arch_gap: the raw-content-shaped denylist below is the PINNED shape-gate floor
// (1.8 bullet 3 — "the schema forbids raw-content-shaped fields by construction").
// The full per-projectionType allowed-field MAP (which keys each projectionType
// may carry) is unspecified upstream; full leakage enforcement lives in §5/§6.
// We forbid the three named raw-content-shaped keys (case-insensitively) rather
// than invent a closed allowed-field taxonomy.
const RAW_CONTENT_SHAPED_KEYS: ReadonlySet<string> = new Set(["rawcontent", "body", "content"]);

const carriesRawContentShapedKey = (payload: Record<string, unknown>): boolean =>
  Object.keys(payload).some((k) => RAW_CONTENT_SHAPED_KEYS.has(k.toLowerCase()));

// Explicit output interface + annotation: the inferred type would otherwise force
// the declaration emitter to name `ids.ts`'s module-private `__brand` symbol
// (TS4023) via the branded `WorkspaceId` / `SourceRef.sourceId`. A nameable
// `GclProjection` type sidesteps that (the same workaround `egress-policy.ts` and
// `shared-shapes.ts`'s `SourceRef` use); `.strict()` runtime rejection of unknown
// keys and the `.refine()` invariant are unaffected.
export interface GclProjection {
  workspaceId: WorkspaceId;
  // Closed enum: isolated | coordination | sanitized | full (§5 visibility levels).
  visibilityLevel: VisibilityLevel;
  // arch_gap: projectionType taxonomy unspecified upstream — an OPEN non-empty
  // string that drives the allowed-field set (full enforcement §5/§6).
  projectionType: string;
  // OPEN record (summary/metadata only); raw-content-shaped keys are forbidden by
  // the refine below so no raw workspace content can ride a projection.
  sanitizedPayload: Record<string, unknown>;
  sourceRefs: SourceRef[];
}

interface GclProjectionInput {
  workspaceId: string;
  visibilityLevel: VisibilityLevel;
  projectionType: string;
  sanitizedPayload: Record<string, unknown>;
  sourceRefs: { sourceId: string; span?: string }[];
}

export const GclProjectionSchema: z.ZodType<GclProjection, z.ZodTypeDef, GclProjectionInput> = z
  .object({
    // reject-on-missing (§3 universal rule / §6 Visibility Gate): a cross-workspace
    // projection MUST declare its source workspace AND its visibility level.
    workspaceId: WorkspaceIdSchema,
    visibilityLevel: VisibilityLevelSchema,
    projectionType: z.string().min(1),
    sanitizedPayload: z.record(z.string(), z.unknown()),
    sourceRefs: z.array(SourceRefSchema),
  })
  .strict()
  // Leakage shape gate: sanitizedPayload must not carry a raw-content-shaped key
  // (rawContent / body / content, case-insensitive) — a raw-content field on a
  // GCL projection is a workspace-isolation breach (safety rule 4 / §6 WS-8).
  .refine((p) => !carriesRawContentShapedKey(p.sanitizedPayload), {
    message:
      "sanitizedPayload must not carry a raw-content-shaped key (rawContent/body/content) — GCL projections are sanitized (§6 Visibility Gate)",
    path: ["sanitizedPayload"],
  });
