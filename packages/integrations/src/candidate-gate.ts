// @sow/integrations — the §8 candidate-data gate for external-write carriers.
//
// Discharges LESSONS §3 (ajv `validate()` is STRUCTURAL-ONLY — `zod-to-json-
// schema` drops `.refine`): the gate is a COMPOSITION, never ajv alone. In order:
//   (1) `validate(candidate, SCHEMA_ID)` — ajv structural gate (shape/enum/type).
//   (2) `Schema.safeParse`               — the Zod layer (.strict + .refine +
//                                          branding; produces the typed value).
//   (3) §3 universal external-write rule — `ruleExternalWriteKeys` (canonical &
//                                          idempotency keys present + non-empty,
//                                          trimmed — stricter than ajv .min(1)).
//   (4) envelope↔action linkage          — for the envelope, when an `action` is
//                                          supplied, `envelopeMatchesAction` must
//                                          hold (safety invariant 3 linkage pin).
// Any failure ⇒ `ok:false` with an ENUMERABLE code (§16 — never throws).
import {
  ProposedActionSchema,
  PROPOSED_ACTION_SCHEMA_ID,
  ExternalWriteEnvelopeSchema,
  EXTERNAL_WRITE_ENVELOPE_SCHEMA_ID,
  envelopeMatchesAction,
} from "@sow/contracts";
import type { ProposedAction, ExternalWriteEnvelope } from "@sow/contracts";
import { validate, ruleExternalWriteKeys } from "@sow/domain";

/** Closed, enumerable rejection reasons for the §8 candidate gate. */
export type CandidateGateCode = "MALFORMED" | "LINKAGE_MISMATCH";

/** A gate outcome: the branded value on admit, or an enumerable rejection. */
export type AdmitResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: CandidateGateCode; readonly message: string };

function malformed<T>(message: string): AdmitResult<T> {
  return { ok: false, code: "MALFORMED", message };
}

/**
 * Admit a candidate `ProposedAction` (safety invariant 1: no external write
 * without a passing gate). Composition: ajv structural → Zod (.strict/.refine +
 * branding) → §3 external-write-keys rule. Returns the branded `ProposedAction`
 * on success; `{ok:false, code:'MALFORMED'}` on any failure. Pure; never throws.
 */
export function admitProposedAction(candidate: unknown): AdmitResult<ProposedAction> {
  // (1) ajv structural.
  const structural = validate(candidate, PROPOSED_ACTION_SCHEMA_ID);
  if (!structural.ok) {
    return malformed(`proposed-action schema violation (${structural.error.code})`);
  }
  // (2) Zod refine/branding layer (catches what ajv drops).
  const parsed = ProposedActionSchema.safeParse(candidate);
  if (!parsed.success) {
    return malformed(`proposed-action zod rejection: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  const action = parsed.data;
  // (3) §3 universal external-write rule (trimmed-non-empty keys).
  const keyed = ruleExternalWriteKeys(action);
  if (!keyed.ok) {
    return malformed(`proposed-action missing external-write key(s): ${(keyed.error.fields ?? []).join(", ")}`);
  }
  return { ok: true, value: action };
}

/**
 * Admit a candidate `ExternalWriteEnvelope` (safety invariant 1). Composition:
 * ajv structural → Zod (.strict/.refine + branding) → §3 external-write-keys rule
 * → (when `action` supplied) `envelopeMatchesAction` linkage pin (safety
 * invariant 3). Returns the branded `ExternalWriteEnvelope` on success; a
 * `MALFORMED` or `LINKAGE_MISMATCH` rejection otherwise. Pure; never throws.
 */
export function admitExternalWriteEnvelope(
  candidate: unknown,
  action?: ProposedAction,
): AdmitResult<ExternalWriteEnvelope> {
  // (1) ajv structural.
  const structural = validate(candidate, EXTERNAL_WRITE_ENVELOPE_SCHEMA_ID);
  if (!structural.ok) {
    return malformed(`external-write-envelope schema violation (${structural.error.code})`);
  }
  // (2) Zod refine/branding layer.
  const parsed = ExternalWriteEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) {
    return malformed(
      `external-write-envelope zod rejection: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  const envelope = parsed.data;
  // (3) §3 universal external-write rule.
  const keyed = ruleExternalWriteKeys(envelope);
  if (!keyed.ok) {
    return malformed(
      `external-write-envelope missing external-write key(s): ${(keyed.error.fields ?? []).join(", ")}`,
    );
  }
  // (4) linkage pin (safety invariant 3) — only when an originating action is given.
  if (action !== undefined && !envelopeMatchesAction(envelope, action)) {
    return {
      ok: false,
      code: "LINKAGE_MISMATCH",
      message: "envelope does not match the originating ProposedAction (actionId/targetSystem/canonicalObjectKey/idempotencyKey)",
    };
  }
  return { ok: true, value: envelope };
}
