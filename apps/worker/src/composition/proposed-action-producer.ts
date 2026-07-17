// 18.7 — the deterministic ProposedAction producer (SAFE-BUILD, NO dispatch). When a meeting/source
// extraction carries an explicit action-intent field AND the workspace has a configured external-action
// binding, this emits ONE real ProposedAction (concrete targetSystem + the required §3/§8 external-write
// keys) + its ExternalWriteEnvelope, which the existing propose path lands as a PENDING §9 Approval. No
// implied action (or no configured target) ⇒ empty ⇒ byte-equivalent to the prior `actions:[]`.
//
// SAFETY (the reason this slice is invariant-gated):
//   • NO-DISPATCH (structural): this is a PURE function — it takes NO gateway/dispatch/Tool-Gateway dep,
//     so it CANNOT dispatch. The emitted action lands PENDING; the real external write is Phase 21/22.
//   • WS-8 / no-inference: `targetSystem` + the existence/dedupe keys come from the BINDING/config + a
//     deterministic identity, NEVER from extraction/source CONTENT. The §8 key builders hash the
//     NORMALIZED identity, so a hostile content string is opaque-hashed into the key (traversal-safe,
//     LESSON 5) — it can neither escape the key nor redirect the target.
//   • rule 2/3: the emitted action passes ProposedActionSchema + ruleExternalWriteKeys (both keys
//     present, non-empty).
//
// PURE + TOTAL — runs in the buildOutputs ACTIVITY (node:crypto lives here, NOT the sandbox); never throws.
import { createHash } from "node:crypto";
import { actionId } from "@sow/contracts";
import type {
  ProposedAction,
  ExternalWriteEnvelope,
  TargetSystem,
  WorkspaceId,
} from "@sow/contracts";
import { buildCanonicalObjectKey, buildIdempotencyKey, TBD } from "@sow/domain";
import type { ValidatedExtraction, MeetingExternalActionInput } from "@sow/workflows";

/**
 * The workspace's configured external-action binding — sourced from CONFIG/binding, NEVER content.
 * Absent ⇒ the producer emits nothing (it never guesses a `targetSystem` from content).
 */
export interface ExternalActionBinding {
  /** WHERE the action targets — a config-bound connector, never a content field (WS-8/no-inference). */
  readonly targetSystem: TargetSystem;
  /** The action operation (e.g. `todoist.create`) — drives the idempotency (replay-dedupe) key. */
  readonly operation: string;
  /** WHICH validated field signals a concrete action (an EXPLICIT field, never prose-inferred). */
  readonly actionIntentField: string;
}

/** The deterministic, traversal-safe action identity seed (workspace + source/note identity). */
export interface ActionIdentity {
  readonly workspaceId: WorkspaceId;
  /** The source/note identity — opaque; hashed into the keys (a hostile string can never escape). */
  readonly sourceId: string;
}

/**
 * The requires-approval `approvalPolicy` label. There is NO canonical requires-approval token upstream
 * (arch_gap — the SOLE recognized token is `auto_private`, for auto-eligibility; approval-policy.ts).
 * Any non-`auto_private` value fail-closes to requires-approval at the §9 policy classifier, so an action
 * this producer emits can NEVER auto-dispatch — it always lands PENDING.
 */
const REQUIRES_APPROVAL_POLICY = "requires_approval";

function sha256hex(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

/**
 * Deterministic PENDING external-action producer. Emits ONE proposal (+ envelope) IFF a binding is
 * configured AND the validated extraction carries the binding's explicit action-intent field. See the
 * module header for the safety contract (structural no-dispatch, WS-8/no-inference keys, candidate-gate).
 */
export function produceProposedActions(input: {
  readonly validated: ValidatedExtraction;
  readonly identity: ActionIdentity;
  readonly binding?: ExternalActionBinding;
}): readonly MeetingExternalActionInput[] {
  const { validated, identity, binding } = input;
  // (1) No configured target ⇒ no action (never guess a `targetSystem` from content).
  if (binding === undefined) return [];
  // (2) No explicit action-intent field with a CONCRETE value ⇒ no action. Fail-closed like the meeting
  //     leg's concrete-owner/title gate: a missing field, or a non-string / empty / whitespace / TBD
  //     value, derives NO action — never a concrete external-action proposal off an empty/unknown signal
  //     (REQ-F-017; the action-intent is an explicit text signal, never prose-inferred).
  const intent = validated.fields[binding.actionIntentField];
  const intentValue = intent === undefined ? undefined : intent.value;
  if (typeof intentValue !== "string") return [];
  const concreteIntent = intentValue.trim();
  if (concreteIntent.length === 0 || concreteIntent === TBD) return [];

  // The action identity for the keys — workspace + source identity + operation, ALL non-content.
  // Deterministic + traversal-safe: the §8 builders hash the NORMALIZED identity, so a hostile source
  // string can never escape into the key (LESSON 5).
  const keyIdentity: Record<string, string> = {
    workspace: String(identity.workspaceId),
    source: identity.sourceId,
    operation: binding.operation,
  };
  const canonicalObjectKey = buildCanonicalObjectKey({
    targetSystem: binding.targetSystem,
    identity: keyIdentity,
  });
  const idempotencyKey = buildIdempotencyKey({ operation: binding.operation, identity: keyIdentity });

  // Payload from the VALIDATED (evidence-backed, concrete) action-intent field — NOT raw content;
  // `operation` + `targetSystem` come from the binding (config).
  const payload: Record<string, unknown> = { operation: binding.operation, intent: concreteIntent };
  // payloadHash MUST digest the PAYLOAD (safety rule 3): the §8 payload-swap TOCTOU guard re-hashes the
  // plan + compares against the frozen `Approval.payloadHash` to reject a swapped payload, so the hash
  // MUST change when the payload changes. The `canonicalObjectKey` is identity-only (it never sees the
  // intent value), so hashing IT would leave a payload swap undetectable — hash the payload itself.
  const payloadHash = `payload:${binding.targetSystem}:${sha256hex(JSON.stringify(payload))}`;

  const action: ProposedAction = {
    // actionId = the idempotencyKey (matches the meeting analog's `actionId(idempotencyKey)`).
    actionId: actionId(idempotencyKey),
    // WS-8 / no-inference: the target is the BINDING's, NEVER a content field.
    targetSystem: binding.targetSystem,
    canonicalObjectKey,
    payload,
    // Lands PENDING — never `auto_private`, so it can never auto-dispatch (defence-in-depth).
    approvalPolicy: REQUIRES_APPROVAL_POLICY,
    idempotencyKey,
  };
  const envelope: ExternalWriteEnvelope = {
    actionId: action.actionId,
    targetSystem: binding.targetSystem,
    canonicalObjectKey,
    idempotencyKey,
    preconditions: ["not_exists"],
    payloadHash,
  };
  return [{ action, envelope }];
}
