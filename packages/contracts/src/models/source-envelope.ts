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
  // body = the extracted candidate source text (15.2, §19.2) — threaded past
  // registration so the 15.3 note projection builds a real note vs the "source
  // ingestion (C1)" placeholder. ADDITIVE + OPTIONAL (Lesson 15: a required field
  // would drop every source registered before a producer threads it; 15.3
  // degrades when absent). CANDIDATE DATA: it may carry RAW within-workspace
  // content, so downstream it is subject to redaction before any log sink
  // (rule 7) — enforcement is the CONSUMER's (15.3+); this model only defines the
  // shape + its candidate-data gate (see the schema-side comment for the gate).
  body?: string;
}

interface SourceEnvelopeInput {
  sourceId: string;
  workspaceId: string;
  origin: string;
  contentHash: string;
  type: string;
  sensitivity: string;
  routingHints: Record<string, unknown>;
  body?: string;
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
    // 15.2 — the extracted candidate source text (§19.2). OPTIONAL + additive
    // (Lesson 15); OPAQUE format (no `.min(1)` — an empty extraction is a valid
    // state, the producer / 15.3 tightens later). CANDIDATE DATA: `.string()`
    // gates the type so a non-string body is rejected, never trusted-through.
    body: z.string().optional(),
  })
  .strict();
