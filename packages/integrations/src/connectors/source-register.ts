// @sow/integrations — SourceEnvelope registration (slice 6.3, §8/§9, Flow 4).
//
// `registerSource(input, deps)` is the pre-extraction gate every imported source
// passes BEFORE any durable effect. It builds a candidate `SourceEnvelope`,
// validates it (candidate-gate style: ajv structural `SOURCE_ENVELOPE_SCHEMA_ID`
// + Zod `SourceEnvelopeSchema` — LESSONS §3: NEVER ajv alone), then applies the
// Flow-4 contentHash dedupe. Load-bearing pins:
//
//   • SCOPED-BEFORE-DURABLE (REQ-F-002): `workspaceId` is REQUIRED; a blank one is
//     a gate rejection, not a defaulted value.
//   • DEDUPE (REQ-F-010 / Flow 4): a source whose `contentHash` is already known
//     (injected `seenContentHash`) is a NO-OP `dedupe_hit` — never a duplicate
//     source. The gate runs FIRST, so a malformed input never even reaches the
//     dedupe probe (and never mints a source).
//   • NO INFERENCE (REQ-F-017): the register step NEVER invents owner/date/
//     workspace or defaults a missing required field — a missing field is a
//     rejection, left for downstream triage.
//
// PURE (§16): no clock, no randomness, no real I/O — `seenContentHash` is injected.
// Every outcome is a typed discriminated union; nothing throws across the boundary.
import { SOURCE_ENVELOPE_SCHEMA_ID, SourceEnvelopeSchema } from "@sow/contracts";
import type { SourceEnvelope } from "@sow/contracts";
import { validate } from "@sow/domain";

/**
 * The register input — the raw candidate fields for one source. Structurally the
 * SourceEnvelope shape, but UNTRUSTED (candidate data): every field is validated
 * by the gate. Typed loosely enough that a caller can pass a malformed value and
 * get a typed rejection rather than a compile error masking a runtime gap.
 */
export interface RegisterSourceInput {
  readonly sourceId: string;
  readonly workspaceId: string;
  readonly origin: string;
  readonly contentHash: string;
  readonly type: string;
  readonly sensitivity: string;
  readonly routingHints: Record<string, unknown>;
}

/**
 * Injected dependencies. `seenContentHash(hash)` is the Flow-4 dedupe probe — true
 * iff a source with this exact `contentHash` is already registered. Async so a
 * real store can back it; a fake resolves synchronously in tests. No other effect.
 */
export interface RegisterSourceDeps {
  readonly seenContentHash: (contentHash: string) => Promise<boolean>;
}

/** Closed rejection code set for the register gate (§16 — enumerable). */
export type RegisterRejectionCode = "MALFORMED";

/**
 * The typed outcome of a registration attempt (discriminated on `outcome`):
 *   • 'registered' — the source passed the gate + is fresh; carries the built,
 *     validated `SourceEnvelope` (the surface downstream extraction consumes).
 *   • 'dedupe_hit' — the source is well-formed but its `contentHash` is already
 *     known; a NO-OP (no new source minted). Carries the offending `contentHash`.
 *   • 'rejected'   — the candidate failed the schema/Zod gate; carries an
 *     enumerable code + a diagnostic. No source minted; nothing durable happened.
 */
export type RegisterSourceResult =
  | { readonly outcome: "registered"; readonly envelope: SourceEnvelope }
  | { readonly outcome: "dedupe_hit"; readonly contentHash: string }
  | { readonly outcome: "rejected"; readonly code: RegisterRejectionCode; readonly message: string };

function rejected(message: string): RegisterSourceResult {
  return { outcome: "rejected", code: "MALFORMED", message };
}

/**
 * Register a source: gate-then-dedupe. Builds the candidate envelope from `input`,
 * runs ajv structural + Zod `.strict()`/`.refine` validation (NO inference — a
 * missing/blank required field rejects), and only on a clean pass consults the
 * injected dedupe probe. A `seenContentHash` hit is a NO-OP `dedupe_hit`. Pure;
 * never throws (§16).
 */
export async function registerSource(
  input: RegisterSourceInput,
  deps: RegisterSourceDeps,
): Promise<RegisterSourceResult> {
  // Build the candidate envelope from the input VERBATIM — no inference, no
  // defaulting of a missing field (REQ-F-017). A structurally-incomplete input
  // (e.g. missing routingHints) reaches the gate as-is and is rejected there.
  const candidate = input as unknown;

  // (1) ajv STRUCTURAL gate (shape / type / required). LESSONS §3: never alone.
  const structural = validate(candidate, SOURCE_ENVELOPE_SCHEMA_ID);
  if (!structural.ok) {
    return rejected(`source-envelope schema violation (${structural.error.code})`);
  }
  // (2) Zod layer (.strict() rejects unknown keys; branded ids reject blank/
  //     whitespace workspaceId/sourceId; .min(1) rejects a blank contentHash).
  const parsed = SourceEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) {
    return rejected(`source-envelope zod rejection: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  const envelope = parsed.data;

  // (3) Flow-4 dedupe — ONLY after a clean gate, so a malformed input never
  //     probes the store and never mints a source.
  const seen = await deps.seenContentHash(envelope.contentHash);
  if (seen) {
    return { outcome: "dedupe_hit", contentHash: envelope.contentHash };
  }

  return { outcome: "registered", envelope };
}
