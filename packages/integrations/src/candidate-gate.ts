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

/**
 * A gate outcome: the branded value on admit, or an enumerable rejection.
 * `message` is REDACTION-SAFE BY CONSTRUCTION — built only from closed codes
 * (`structural.error.code`, a Zod issue's `.code` + schema field path) and the
 * fixed `canonicalObjectKey`/`idempotencyKey` field-name literals (never Zod's
 * `.message`, which echoes the received value on enum/literal mismatches, and
 * never candidate-authored text). `debugDetail`, when present, carries that
 * richer Zod issue text for IN-PROCESS debugging of a malformed envelope only —
 * it is NOT part of the safe surface and must never be forwarded into a log, an
 * audit record, or an `ExternalWriteResult`/workflow-return value (the Tool
 * Gateway does not read it — see `gateway.ts`'s `ExternalWriteResult` doc
 * comment).
 */
export type AdmitResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: CandidateGateCode;
      readonly message: string;
      readonly debugDetail?: string;
    };

function malformed<T>(message: string, debugDetail?: string): AdmitResult<T> {
  return debugDetail === undefined
    ? { ok: false, code: "MALFORMED", message }
    : { ok: false, code: "MALFORMED", message, debugDetail };
}

// Summarize a Zod issue WITHOUT touching `.message` — Zod echoes the received
// value into `.message` on enum/literal mismatches (e.g. "... received
// 'PZN9F3A1BSECRET-leak'"), which would put candidate-authored text into a
// value this gate's callers may carry forward (e.g. `envelope.ts`'s
// `EnvelopeBuildError.message`). `.code` is a closed `ZodIssueCode`; `.path` is
// the SCHEMA's own field-name segments (never candidate data) — both safe to
// name.
function safeZodIssueSummary(
  issue: { readonly code: string; readonly path: readonly (string | number)[] } | undefined,
): string {
  if (issue === undefined) return "invalid";
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${issue.code} at ${path}`;
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
    const issue = parsed.error.issues[0];
    return malformed(`proposed-action zod rejection: ${safeZodIssueSummary(issue)}`, issue?.message);
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
    const issue = parsed.error.issues[0];
    return malformed(
      `external-write-envelope zod rejection: ${safeZodIssueSummary(issue)}`,
      issue?.message,
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
