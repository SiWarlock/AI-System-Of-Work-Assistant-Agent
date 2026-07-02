// Cross-subsystem FAILURE taxonomy (task 10.2, contract portion; §16 error
// convention). Every subsystem operation returns its outcome as a
// `Result<T, FailureVariant>` (see `./result`) — never a thrown error across a
// subsystem boundary. `FailureVariant` is the *enumerated* failure surface:
// a closed `kind`, a short human `message`, a `retryable` flag, and an OPTIONAL
// stable `cause.code`.
//
// CRITICAL — redaction safety. A `FailureVariant` carries NO raw error object,
// NO stack trace, NO prompt, and NO raw content. The ONLY optional detail is
// `cause.code`: a stable, enumerable code string (e.g. "REVISION_STALE"), never
// a raw error, message-with-secrets, or content excerpt. `.strict()` on both the
// variant and its `cause` blocks smuggling any extra (raw-content-shaped) key.
// This keeps the taxonomy safe to log, serialize to the renderer, and cross the
// §16 boundary without a redaction pass (safety rule 7).
//
// Relationship to shared-enums `FailureClass`: these are DIFFERENT taxonomies.
// `FailureVariant` (here) is the OPERATION-result taxonomy — what a single call
// returns. `FailureClass` (`../models/shared-enums`) is the OBS-2 System-Health
// taxonomy — a persistent, deduped health item. A SUBSET of variants maps to a
// `FailureClass` health item, but that variant→health mapping is DOMAIN logic
// (task 10.2, built later in `packages/domain`), NOT here. This file is pure &
// typed-only; it declares no mapping.
import { z } from "zod";

// ── The frozen 7-member kind set (const tuple → z.enum → inferred type) ───────
// Order is stable; cross-subsystem consumers pin this exact set.
export const FailureVariantKind = [
  "validation_rejected",
  "provider_failed",
  "budget_exceeded",
  "connector_unreachable",
  "write_conflict",
  "schema_rejected",
  "degraded_unavailable",
] as const;
export const failureVariantKindSchema = z.enum(FailureVariantKind);
export type FailureVariantKind = z.infer<typeof failureVariantKindSchema>;

// ── The variant shape ─────────────────────────────────────────────────────────
// Explicit interface (the exported TS type) + a `.strict()` Zod schema that is
// the runtime enforcement. `cause` is itself `.strict({ code })` so a raw error
// (`{ code, stack, ... }`) is rejected — only the stable code survives.
export interface FailureVariant {
  kind: FailureVariantKind;
  message: string;
  retryable: boolean;
  // OPTIONAL stable cause code ONLY — never a raw Error / stack / raw content.
  cause?: { code: string };
}

export const failureVariantSchema: z.ZodType<FailureVariant> = z
  .object({
    kind: failureVariantKindSchema,
    message: z.string().trim().min(1),
    retryable: z.boolean(),
    cause: z.object({ code: z.string().trim().min(1) }).strict().optional(),
  })
  .strict();

// ── Constructor ───────────────────────────────────────────────────────────────
/** Options for {@link failure}; `retryable` defaults to `false`. */
export interface FailureOptions {
  retryable?: boolean;
  cause?: { code: string };
}

/**
 * Build a {@link FailureVariant}. `retryable` defaults to `false`; `cause` is
 * omitted entirely (no `undefined`-valued key) when not supplied — keeping the
 * emitted object minimal and free of raw-content-shaped fields.
 */
export const failure = (
  kind: FailureVariantKind,
  message: string,
  opts?: FailureOptions,
): FailureVariant => {
  const base: FailureVariant = { kind, message, retryable: opts?.retryable ?? false };
  return opts?.cause === undefined ? base : { ...base, cause: opts.cause };
};
