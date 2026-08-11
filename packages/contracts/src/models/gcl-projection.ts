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
// ⚠ task 24.19 (WS-1 finding F15): "scans EVERY value recursively" was FALSE for
// THREE shapes `Object.entries` cannot see — a Map/Set instance (entries are
// internal slots, not own enumerable string-keyed properties), a non-enumerable
// own property, and a Symbol-keyed own property (found in review, same class).
// Fixed: a non-plain-object value (anything whose prototype isn't
// Object.prototype/null) is rejected BY CONSTRUCTION rather than traversed; an
// object carrying any own Symbol-keyed property is rejected the same way (JSON
// has no Symbol-key concept, so its mere presence isn't a shape JSON.parse can
// produce either); and a plain object's remaining own STRING-keyed properties
// are scanned via `Object.getOwnPropertyNames` (enumerable + non-enumerable),
// not `Object.entries`. A directly-non-enumerable TOP-LEVEL `sanitizedPayload`
// property is separately dropped by Zod's `z.record` parsing before this
// function ever runs (verified empirically) — that ONE shape is inert through
// the real schema entry point today; a non-enumerable property nested inside a
// plain-object VALUE is NOT dropped by Zod (object identity is preserved) and
// IS caught here, by the same `getOwnPropertyNames` scan, at every depth.
// `additionalProperties: {}` in the generated JSON Schema remains an
// intentional non-backstop: JSON Schema validates the JSON DATA MODEL, which
// has no concept of a JS prototype, so no ajv-expressible constraint can
// distinguish a plain object from a Map/Set — the Zod refine above (running
// against the live pre-serialization value) is necessarily the only layer that
// can enforce this, not a missing defense-in-depth layer.
const MAX_SUMMARY_VALUE_LEN = 1024;

const RAW_CONTENT_SHAPED_KEYS: ReadonlySet<string> = new Set([
  "rawcontent", "raw", "body", "content", "text", "transcript",
  "markdown", "html", "note", "notes", "message", "email", "prompt", "payload",
]);

// True iff `value`'s prototype is exactly Object.prototype or null — i.e. it's
// a shape `{}`/JSON.parse can actually produce. A Map/Set/Date/class-instance/
// etc. has a DIFFERENT prototype and is NOT plain (task 24.19 / WS-1 finding
// F15's structural-restriction fix).
const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

// Exported (task 24.19 / WS-1 finding F15) so the traversal's own stated
// guarantee ("scans EVERY value recursively... regardless of key name") is
// directly unit-testable, not only observable through the schema entry point.
export const isRawContentShaped = (value: unknown, key?: string): boolean => {
  if (typeof key === "string" && RAW_CONTENT_SHAPED_KEYS.has(key.toLowerCase())) return true;
  if (typeof value === "string") {
    // A sanitized summary is short + single-line; verbatim raw content is not.
    return value.length > MAX_SUMMARY_VALUE_LEN || /[\r\n]/.test(value);
  }
  if (Array.isArray(value)) return value.some((v) => isRawContentShaped(v));
  if (value !== null && typeof value === "object") {
    // Structural restriction (task 24.19 / WS-1 finding F15): a value that is
    // not a plain object is not a shape Object.entries/JSON.parse can produce —
    // treat it as raw-content-shaped BY CONSTRUCTION rather than silently
    // passing through uninspected. Closes Map/Set/WeakMap/Date/class-instances
    // as one class, cheaper + more general than chasing individual container
    // shapes one at a time.
    if (!isPlainObject(value)) return true;
    // A Symbol-keyed own property is, like a Map/Set, not a shape
    // JSON.parse can ever produce — JSON has no Symbol-key concept. Same
    // structural-restriction reasoning as the non-plain-object check above:
    // its MERE PRESENCE is treated as raw-content-shaped by construction
    // (security-reviewer, 24.19 Step 8 — confirmed live: z.unknown() preserves
    // object identity, so a Symbol-keyed property survives Zod's own parsing
    // untouched and reaches this point).
    if (Object.getOwnPropertySymbols(value).length > 0) return true;
    // Own STRING-KEYED properties, enumerable AND non-enumerable
    // (getOwnPropertyNames, never Object.entries/Object.keys/for...in) — a
    // hidden {enumerable:false} property must not silently skip the scan.
    return Object.getOwnPropertyNames(value).some((k) =>
      isRawContentShaped((value as Record<string, unknown>)[k], k),
    );
  }
  return false;
};

// Delegates to isRawContentShaped rather than duplicating the traversal — the
// top-level payload is scanned by the SAME plain-object + getOwnPropertyNames
// rule as every nested value (uniform, and correctly rejects a non-plain-object
// payload too, not just one nested inside it).
export const carriesRawContent = (payload: Record<string, unknown>): boolean =>
  isRawContentShaped(payload);

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
  // arch_gap: the full projectionType taxonomy (which drives the allowed-field
  // set) is unspecified upstream — an OPEN non-empty string here. A NARROWER
  // projectionType ⇒ permitted-VisibilityLevel derivation now exists (task 24.18)
  // at `@sow/policy` `isVisibilityConsistentWithProjectionType` — see that
  // module's `arch_gap` note for what remains unspecified (the taxonomy content
  // itself; the derivation MECHANISM is real and wired through `admitProjection`).
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
