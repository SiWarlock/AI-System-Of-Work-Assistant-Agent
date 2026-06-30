// SourceEnvelope seam model (task 1.8, §3/§8/§9). The ingestion source-register
// record: every imported source (Flow 4 "Source ingestion" / Flow 5 inbox
// triage) is registered as a SourceEnvelope before any durable effect. Two
// load-bearing pins: it is scoped-before-durable (workspaceId required,
// REQ-F-002) and dedupe-keyed (a deterministic non-empty contentHash drives the
// Flow-4 dedupe-hit). Zod is the single source of truth — the TS type is
// `z.infer`-shaped, the JSON Schema is generated via `emitJsonSchema`. PURE —
// imports only foundation primitives.
import { z } from "zod";
import { SourceIdSchema, WorkspaceIdSchema } from "../primitives/zod-brands";
import type { SourceId, WorkspaceId } from "../primitives/ids";

/** Stable JSON-Schema `$id` for the schema registry. */
export const SOURCE_ENVELOPE_SCHEMA_ID = "sow:source-envelope" as const;

// Explicit output interface + annotation: the inferred type would otherwise
// force the declaration emitter to name `ids.ts`'s module-private `__brand`
// symbol (TS4023) — the same workaround the EgressPolicy/`SourceRef` models use.
// A nameable `SourceEnvelope` type sidesteps that; `.strict()` runtime rejection
// of unknown keys is unaffected.
export interface SourceEnvelope {
  sourceId: SourceId;
  workspaceId: WorkspaceId;
  // origin = the source URI / locator string (e.g. a YouTube watch URL).
  origin: string;
  // contentHash = the deterministic dedupe key over the source's content
  // (Flow 4 dedupe-hit). arch_gap: the hash algorithm/encoding is unspecified
  // upstream — modeled as an open non-empty string, not a fixed sha-hex shape.
  contentHash: string;
  // arch_gap: the `type` taxonomy (source kinds — youtube_video, podcast, …) is
  // unspecified upstream (first adapter is YouTube, OQ-011); open non-empty
  // string, NOT a closed enum, until §8 names the catalog.
  type: string;
  // arch_gap: the `sensitivity` taxonomy is unspecified upstream (set/overridden
  // during Flow-5 inbox triage); open non-empty string, NOT a closed enum.
  sensitivity: string;
  // arch_gap: the `routingHints` shape (workspace/project correlation hints
  // consumed by the ingestion router) is unspecified upstream; open record of
  // unknown values until §8/§9 names the fields.
  routingHints: Record<string, unknown>;
}

interface SourceEnvelopeInput {
  sourceId: string;
  workspaceId: string;
  origin: string;
  contentHash: string;
  type: string;
  sensitivity: string;
  routingHints: Record<string, unknown>;
}

export const SourceEnvelopeSchema: z.ZodType<SourceEnvelope, z.ZodTypeDef, SourceEnvelopeInput> = z
  .object({
    sourceId: SourceIdSchema,
    // REQ-F-002 scoped-before-durable: a source is bound to a workspace at
    // register time; the branded schema rejects empty/whitespace.
    workspaceId: WorkspaceIdSchema,
    origin: z.string().min(1),
    // Deterministic dedupe key (Flow 4): non-empty so a registered source always
    // carries a comparable key. See arch_gap on the interface field.
    contentHash: z.string().min(1),
    type: z.string().min(1),
    sensitivity: z.string().min(1),
    routingHints: z.record(z.string(), z.unknown()),
  })
  .strict();
