// @sow/integrations — build an ExternalWriteEnvelope from a validated
// ProposedAction (§8 Tool Gateway). The envelope is the ONLY external-write
// carrier (safety rule 3): it copies the action's linkage keys (actionId /
// targetSystem / canonicalObjectKey / idempotencyKey), computes the replay-stable
// `payloadHash` over the action payload (foundation `payloadHash`), and carries
// the caller's `preconditions` (+ optional `approvalId`). The built envelope is
// re-validated through the foundation candidate-gate WITH the originating action,
// so the `envelopeMatchesAction` linkage pin (safety invariant 3) is proven
// before it ever reaches a write. §16: returns a typed Result, never throws.
import type { ProposedAction, ExternalWriteEnvelope, Result } from "@sow/contracts";
import { ok, err } from "@sow/contracts";
import { payloadHash } from "../hash/payload-hash";
import { admitExternalWriteEnvelope, type CandidateGateCode } from "../candidate-gate";

/** Caller-supplied envelope build inputs beyond the action's own linkage keys. */
export interface EnvelopeBuildInput {
  readonly preconditions: string[];
  readonly approvalId?: string;
}

/** Closed failure set for envelope construction (§16). */
export interface EnvelopeBuildError {
  readonly code: CandidateGateCode;
  readonly message: string;
}

/**
 * Build + validate an `ExternalWriteEnvelope` from `action`. `payloadHash` is the
 * foundation `payloadHash(action.payload)` (replay-stable, key-order-independent).
 * The result is admitted through `admitExternalWriteEnvelope(candidate, action)`
 * so the candidate-gate (ajv → Zod → §3 keys) AND the `envelopeMatchesAction`
 * linkage pin both hold before the envelope is returned. Pure; never throws.
 */
export function buildEnvelopeFromAction(
  action: ProposedAction,
  input: EnvelopeBuildInput,
): Result<ExternalWriteEnvelope, EnvelopeBuildError> {
  // Assemble the candidate. approvalId is included only when supplied (the schema
  // is `.strict()`, so an explicit `undefined` under an optional key is fine, but
  // we keep it absent to mirror the "no approval yet" shape precisely).
  const candidate: Record<string, unknown> = {
    actionId: action.actionId,
    targetSystem: action.targetSystem,
    canonicalObjectKey: action.canonicalObjectKey,
    idempotencyKey: action.idempotencyKey,
    preconditions: input.preconditions,
    payloadHash: payloadHash(action.payload),
    ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
  };

  const admitted = admitExternalWriteEnvelope(candidate, action);
  if (!admitted.ok) {
    return err({ code: admitted.code, message: admitted.message });
  }
  return ok(admitted.value);
}
