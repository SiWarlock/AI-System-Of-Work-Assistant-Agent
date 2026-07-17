// 18.7 — the deterministic ProposedAction producer (SAFE-BUILD, NO dispatch). When a meeting/source
// extraction carries an explicit action-intent field AND the workspace has a configured external-action
// binding, the producer emits ONE real ProposedAction (concrete targetSystem + the required external-write
// keys) + its ExternalWriteEnvelope, which the existing propose path lands as a PENDING §9 Approval. NO
// implied action (or no configured target) ⇒ empty. targetSystem + the existence/dedupe keys come from the
// BINDING/config + a traversal-safe identity (LESSON 5), NEVER from content (WS-8/no-inference). The
// producer is PURE — it takes no gateway/dispatch dep, so it can NEVER dispatch (Phase 21/22 arms the
// Tool Gateway).
import { describe, it, expect } from "vitest";
import {
  isOk,
  ProposedActionSchema,
  ExternalWriteEnvelopeSchema,
  envelopeMatchesAction,
} from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";
import { ruleExternalWriteKeys, TBD } from "@sow/domain";
import type { ExtractionField } from "@sow/domain";
import type { ValidatedExtraction, MeetingExternalActionInput } from "@sow/workflows";
import {
  produceProposedActions,
  type ExternalActionBinding,
  type ActionIdentity,
} from "../../src/composition/proposed-action-producer";

// ── fixtures ────────────────────────────────────────────────────────────────
const WS = "ws-actions" as WorkspaceId;
const field = (value: unknown): ExtractionField<unknown> => ({ value }) as ExtractionField<unknown>;

const validatedWith = (fields: Record<string, ExtractionField<unknown>>): ValidatedExtraction =>
  ({ validated: true, fields }) as ValidatedExtraction;

// The extraction carries the explicit action-intent field the binding names ("followUp").
const withIntent = validatedWith({
  title: field("Design Doc"),
  followUp: field("schedule the design review"),
});
// No action-intent field ⇒ no implied action.
const noIntent = validatedWith({ title: field("Design Doc") });

// The workspace's configured external-action binding — targetSystem + operation + which validated field
// signals the action all come from CONFIG, never content.
const binding: ExternalActionBinding = {
  targetSystem: "todoist",
  operation: "create_task",
  actionIntentField: "followUp",
};
const identity: ActionIdentity = { workspaceId: WS, sourceId: "src-note-1" };

// Assert the producer emitted EXACTLY one action and return it (also a non-vacuous length pin).
function only(result: readonly MeetingExternalActionInput[]): MeetingExternalActionInput {
  expect(result).toHaveLength(1);
  return result[0] as MeetingExternalActionInput;
}

// ── the deterministic producer ──────────────────────────────────────────────
describe("produceProposedActions — deterministic PENDING external-action producer (18.7)", () => {
  it("producer_emits_proposedaction_on_implied_action — an implied action ⇒ ONE ProposedAction with a concrete targetSystem (not empty) (spec G17)", () => {
    const { action } = only(produceProposedActions({ validated: withIntent, identity, binding }));
    expect(action.targetSystem).toBe("todoist"); // concrete target, not actions:[]
  });

  it("producer_no_implied_action_emits_empty — no action-intent field OR no configured target ⇒ empty (spec no-spurious-actions)", () => {
    // no explicit action-intent field in the extraction
    expect(produceProposedActions({ validated: noIntent, identity, binding })).toHaveLength(0);
    // a configured action-intent field is present, but NO binding (no configured target) ⇒ never guess
    expect(produceProposedActions({ validated: withIntent, identity, binding: undefined })).toHaveLength(0);
  });

  it("proposedaction_carries_required_external_write_keys — canonicalObjectKey + idempotencyKey + actionId + targetSystem + approvalPolicy present (spec rule 3)", () => {
    const { action } = only(produceProposedActions({ validated: withIntent, identity, binding }));
    expect(action.canonicalObjectKey.length).toBeGreaterThan(0);
    expect(action.idempotencyKey.length).toBeGreaterThan(0);
    expect(String(action.actionId).length).toBeGreaterThan(0);
    expect(action.targetSystem).toBe("todoist");
    expect(action.approvalPolicy.length).toBeGreaterThan(0);
  });

  it("proposedaction_lands_pending_no_dispatch — approvalPolicy requires-approval; envelope carries no approval/receipt (spec no-dispatch boundary)", () => {
    const { action, envelope } = only(produceProposedActions({ validated: withIntent, identity, binding }));
    expect(action.approvalPolicy).toBe("requires_approval"); // lands PENDING — no auto-write
    expect(envelope.approvalId).toBeUndefined(); // not yet approved
    expect(envelope.writeReceipt).toBeUndefined(); // not yet written / dispatched (Phase 21/22)
  });

  it("keys_traversal_safe_from_identity — a hostile identity string derives a SAFE, deterministic key; no raw content escapes (spec LESSON 5)", () => {
    const hostile: ActionIdentity = { workspaceId: WS, sourceId: "../../../etc/passwd\n$(rm -rf /)" };
    const { action } = only(produceProposedActions({ validated: withIntent, identity: hostile, binding }));
    expect(action.canonicalObjectKey).toMatch(/^cok_todoist_[0-9a-f]{64}$/); // hashed identity, opaque
    expect(action.canonicalObjectKey).not.toContain("../");
    expect(action.canonicalObjectKey).not.toContain("passwd");
    // deterministic: the same identity ⇒ the same key (replay-stable).
    const { action: again } = only(produceProposedActions({ validated: withIntent, identity: hostile, binding }));
    expect(again.canonicalObjectKey).toBe(action.canonicalObjectKey);
    expect(again.idempotencyKey).toBe(action.idempotencyKey);
  });

  it("targetsystem_and_keys_from_binding_not_content — a SMUGGLED targetSystem/key in extraction content NEVER overrides the binding/identity (spec WS-8 / no-inference)", () => {
    const smuggled = validatedWith({
      followUp: field("x"),
      targetSystem: field("github"), // hostile content claiming a different target
      canonicalObjectKey: field("cok_evil_smuggled"),
    });
    const { action } = only(produceProposedActions({ validated: smuggled, identity, binding })); // binding = todoist
    expect(action.targetSystem).toBe("todoist"); // from the BINDING, never the content field
    expect(action.canonicalObjectKey).toContain("todoist"); // from binding + identity
    expect(action.canonicalObjectKey).not.toContain("evil"); // never the smuggled content key
  });

  it("proposedaction_passes_candidate_gate — the produced action passes ProposedActionSchema + ruleExternalWriteKeys (spec rule 2/3)", () => {
    const { action } = only(produceProposedActions({ validated: withIntent, identity, binding }));
    expect(ProposedActionSchema.safeParse(action).success).toBe(true); // structural candidate-data gate
    expect(isOk(ruleExternalWriteKeys(action))).toBe(true); // rule 3 — both keys present
  });

  it("envelope_passes_schema_and_matches_action — the ExternalWriteEnvelope passes its schema + envelopeMatchesAction (spec rule 3 linkage)", () => {
    const { action, envelope } = only(produceProposedActions({ validated: withIntent, identity, binding }));
    expect(ExternalWriteEnvelopeSchema.safeParse(envelope).success).toBe(true); // the external-write carrier
    expect(envelopeMatchesAction(envelope, action)).toBe(true); // the 4-key linkage pin
  });

  it("payloadhash_digests_the_payload — a CHANGED action-intent value ⇒ a CHANGED payloadHash while the identity keys stay stable (spec rule 3 payload-integrity)", () => {
    const a = only(produceProposedActions({ validated: withIntent, identity, binding }));
    const b = only(
      produceProposedActions({ validated: validatedWith({ followUp: field("a DIFFERENT follow-up") }), identity, binding }),
    );
    // identity keys are stable (same source + operation) — replay-dedupe holds ...
    expect(b.action.canonicalObjectKey).toBe(a.action.canonicalObjectKey);
    expect(b.action.idempotencyKey).toBe(a.action.idempotencyKey);
    // ... but the payloadHash MUST change with the payload, else a payload swap is undetectable (rule 3).
    expect(b.envelope.payloadHash).not.toBe(a.envelope.payloadHash);
    // deterministic: the same payload ⇒ the same payloadHash.
    const aAgain = only(produceProposedActions({ validated: withIntent, identity, binding }));
    expect(aAgain.envelope.payloadHash).toBe(a.envelope.payloadHash);
  });

  it("empty_or_tbd_intent_emits_empty — an empty / whitespace / TBD / non-string action-intent value ⇒ [] (fail-closed, no action off an empty signal) (spec REQ-F-017)", () => {
    expect(produceProposedActions({ validated: validatedWith({ followUp: field("") }), identity, binding })).toHaveLength(0);
    expect(produceProposedActions({ validated: validatedWith({ followUp: field("   ") }), identity, binding })).toHaveLength(0);
    expect(produceProposedActions({ validated: validatedWith({ followUp: field(TBD) }), identity, binding })).toHaveLength(0);
    expect(produceProposedActions({ validated: validatedWith({ followUp: field(42) }), identity, binding })).toHaveLength(0);
  });

  it("safe_build_no_external_write — the producer returns data ONLY (no dispatch / Tool Gateway / external write); no receipt (spec SAFE-BUILD)", () => {
    const result = produceProposedActions({ validated: withIntent, identity, binding });
    expect(Array.isArray(result)).toBe(true);
    // nothing was written — the envelope carries no WriteReceipt (dispatch is Phase 21/22).
    expect(result.every((r) => r.envelope.writeReceipt === undefined)).toBe(true);
  });
});
