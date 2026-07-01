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

// Leakage shape-gate (1.8 bullet 3 — "the schema forbids raw-content-shaped fields
// by construction"). A sanitized cross-workspace projection carries only SHORT,
// SINGLE-LINE summary values (busy/free, deadlines, priority metadata, one-line
// sanitized summaries — §6). Verbatim raw workspace content (note bodies,
// transcripts, emails) is multi-line and/or long-form. So the gate is
// KEY-NAME-INDEPENDENT: it scans EVERY value recursively (nested objects + arrays)
// and rejects any string that is multi-line OR exceeds the summary length cap,
// regardless of key name — closing the prior hole where raw content could ride any
// key OTHER than the three named ones (a workspace-isolation breach, safety rule 4).
// A broadened explicit key denylist is kept as a fast, named signal for the
// obvious cases. arch_gap: the full per-projectionType allowed-field MAP is
// unspecified upstream; full leakage enforcement lives in §5/§6.
const MAX_SUMMARY_VALUE_LEN = 1024;

const RAW_CONTENT_SHAPED_KEYS: ReadonlySet<string> = new Set([
  "rawcontent", "raw", "body", "content", "text", "transcript",
  "markdown", "html", "note", "notes", "message", "email", "prompt", "payload",
]);

const isRawContentShaped = (value: unknown, key?: string): boolean => {
  if (typeof key === "string" && RAW_CONTENT_SHAPED_KEYS.has(key.toLowerCase())) return true;
  if (typeof value === "string") {
    // A sanitized summary is short + single-line; verbatim raw content is not.
    return value.length > MAX_SUMMARY_VALUE_LEN || /[\r\n]/.test(value);
  }
  if (Array.isArray(value)) return value.some((v) => isRawContentShaped(v));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => isRawContentShaped(v, k));
  }
  return false;
};

const carriesRawContent = (payload: Record<string, unknown>): boolean =>
  Object.entries(payload).some(([k, v]) => isRawContentShaped(v, k));

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
  // Leakage shape gate (KEY-NAME-INDEPENDENT): sanitizedPayload must carry only
  // short, single-line summary values — no raw-content-shaped key AND no multi-line
  // or over-length string value anywhere (recursively). Raw content on a GCL
  // projection is a workspace-isolation breach (safety rule 4 / §6 WS-8).
  .refine((p) => !carriesRawContent(p.sanitizedPayload), {
    message:
      "sanitizedPayload must carry only short single-line summary values — no raw-content-shaped key and no multi-line/over-length string (GCL projections are sanitized, §6 Visibility Gate)",
    path: ["sanitizedPayload"],
  });
