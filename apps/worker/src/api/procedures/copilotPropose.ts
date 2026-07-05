// §8 / §9.6 / §9.8 — Phase-C C5.2: the Copilot propose-action DERIVATION (worker side).
//
// The security heart of "write-via-Approvals" (the owner's Option-B pick). When the agent calls the
// `copilot.propose_action` tool (wired in C5.3), the model supplies ONLY an INTENT — a target system, an
// operation label, the external object's identity fields, and the write payload. This module DERIVES the
// canonical `ProposedAction`:
//   - `canonicalObjectKey` + `idempotencyKey` are computed SERVER-SIDE (pure SHA-256 over the identity, via
//     @sow/domain's frozen key builders). The model NEVER supplies a key, so it cannot smuggle a key that
//     points at a DIFFERENT object than `payload` describes (no mis-targeted write). This is "DERIVED action,
//     never client-supplied."
//   - `approvalPolicy` is FORCED to require a human — a Copilot proposal is NEVER auto-applied; it routes to
//     §9.8 Approvals (C5.2b) for owner approval before the Tool Gateway performs any external write.
//   - `actionId` IS the derived idempotencyKey — so idempotency is "by the derived Approval id": the same
//     intent → the same key → the same Approval, and a re-drive records no duplicate card (RecordPendingPort
//     is idempotent).
// The derived action is re-validated through `ProposedActionSchema` (the candidate-data gate) before it is
// returned. PURE; never throws (typed Result). No side effects — this module only DERIVES; C5.2b routes.
import { ok, err, failure, ProposedActionSchema } from "@sow/contracts";
import type { FailureVariant, ProposedAction, Result, TargetSystem } from "@sow/contracts";
import { targetSystemSchema } from "@sow/contracts";
import { buildCanonicalObjectKey, buildIdempotencyKey } from "@sow/domain";

/** A Copilot proposal ALWAYS requires a human approval — the Copilot never auto-applies an external write. */
export const COPILOT_PROPOSE_APPROVAL_POLICY = "requires_approval";

/** A generous bound on the model-authored payload — an unbounded payload is a storage/render DoS surface. */
export const MAX_PROPOSE_PAYLOAD_CHARS = 16 * 1024;

/**
 * The model's propose INTENT — the ONLY thing the model supplies. UNTRUSTED (model output), so it is shape-
 * GUARDED before any use (fail-closed — the module never throws on a malformed intent). It carries NO keys:
 * the canonicalObjectKey + idempotencyKey are DERIVED server-side from `targetSystem`/`operation`/`identity`,
 * so the model cannot hand in a key that mismatches `payload`.
 *   - `targetSystem` — re-checked against the closed §8 connector enum (a Copilot can't invent a system).
 *   - `operation`    — the write operation label (e.g. "todoist.create_task") → part of the idempotency key.
 *   - `identity`     — the external object's identity fields (e.g. `{ title, due }`) → the canonical object key.
 *   - `payload`      — the write content (what the human approves). Does NOT affect the keys (identity does).
 */
export interface CopilotProposeIntent {
  readonly targetSystem: string;
  readonly operation: string;
  readonly identity: Record<string, string>;
  readonly payload: Record<string, unknown>;
}

/** The 4 fields a well-formed intent carries — extra keys are rejected (strict, no smuggled key field). */
const INTENT_FIELDS: ReadonlySet<string> = new Set(["targetSystem", "operation", "identity", "payload"]);

/** Is a value a plain (non-array, non-null) object? */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * PURE shape guard over the UNTRUSTED intent (hand-written — the worker has no zod dep; mirrors
 * `copilotClaudeSynthesis.ts`'s `parseRawOutput`). Returns the typed intent or `null` when anything is off:
 * not an object, a wrong-typed field (e.g. a NUMERIC identity value — which would otherwise throw downstream
 * in `normalizeIdentity((12345).trim())`), or an unexpected extra key. The caller folds `null` to a typed,
 * fail-closed `COPILOT_PROPOSE_MALFORMED` — never a thrown exception.
 */
function parseCopilotProposeIntent(raw: unknown): CopilotProposeIntent | null {
  if (!isPlainObject(raw)) return null;
  if (Object.keys(raw).some((k) => !INTENT_FIELDS.has(k))) return null; // strict — reject unexpected keys
  const { targetSystem, operation, identity, payload } = raw;
  if (typeof targetSystem !== "string" || typeof operation !== "string") return null;
  if (!isPlainObject(identity) || !Object.values(identity).every((v) => typeof v === "string")) return null;
  if (!isPlainObject(payload)) return null;
  return {
    targetSystem,
    operation,
    // Values just runtime-proven all-strings; the cast is load-bearing (`.every` narrows the callback param,
    // not the outer record).
    identity: identity as Record<string, string>,
    payload,
  };
}

/** True iff the identity has at least one non-blank field (an empty/blank identity is a degenerate key). */
function hasUsableIdentity(identity: Record<string, string>): boolean {
  const keys = Object.keys(identity);
  return keys.length > 0 && keys.some((k) => (identity[k] ?? "").trim().length > 0);
}

/**
 * DERIVE the canonical `ProposedAction` from the model's UNTRUSTED intent (server-computed keys; never
 * model-supplied). Fail-closed at every step (never throws — typed Result):
 *   - the intent is STRICT-PARSED first (`CopilotProposeIntentSchema`) → COPILOT_PROPOSE_MALFORMED on a
 *     non-object / wrong-typed field (e.g. a numeric identity value) — so no `.trim()`/hash step ever runs on
 *     untrusted, unvalidated input.
 *   - `targetSystem` must be a member of the closed §8 enum → else COPILOT_PROPOSE_BAD_TARGET.
 *   - `operation` must be non-blank → else COPILOT_PROPOSE_BAD_OPERATION.
 *   - `identity` must have ≥1 non-blank field → else COPILOT_PROPOSE_EMPTY_IDENTITY (an empty identity would
 *     collapse EVERY proposal on a target to one canonical key, matching the WRONG object on the pre-write
 *     existence check — a silent mis-write, strictly worse than a duplicate).
 *   - `payload` is bounded → else COPILOT_PROPOSE_PAYLOAD_TOO_LARGE (an unbounded model payload is a
 *     storage/render DoS surface). The payload is JSON-origin (SDK tool args) so it is acyclic — the size
 *     probe cannot throw.
 * The derived action is re-validated through `ProposedActionSchema`; a shape rejection is
 * COPILOT_PROPOSE_SCHEMA_REJECTED (belt-and-suspenders — the derivation should always produce a valid action).
 * Pure.
 *
 * ⚠ C5.2b/C5.3 CONTRACT (security-review MEDIUMs — the caller MUST honor these; not enforceable here):
 *   (1) HUMAN GATE IS STRUCTURAL, not the policy string. `approvalPolicy` is a decorative open string here
 *       (arch_gap); the "Copilot never auto-applies" guarantee holds ONLY if C5.2b routes EVERY Copilot
 *       proposal to §9.8 Approvals UNCONDITIONALLY — never branch auto/human on `approvalPolicy`.
 *   (2) UPDATE OVER-DEDUPE. The idempotencyKey excludes `payload` (identity+operation only) — the system's
 *       replay-dedupe model. So two DIFFERENT-content updates to the SAME object+operation derive the SAME
 *       key and the second SILENTLY dedupes (RecordPendingPort idempotent). For a genuine update, the intent
 *       MUST carry a content/revision-distinguishing token in `identity` (or the caller must supersede, not
 *       drop) — else a wanted second write is lost. Correct for CREATE; a footgun for UPDATE.
 */
export function deriveCopilotProposedAction(intent: unknown): Result<ProposedAction, FailureVariant> {
  const i = parseCopilotProposeIntent(intent);
  if (i === null) {
    return err(
      failure("validation_rejected", "copilot propose: malformed intent", {
        cause: { code: "COPILOT_PROPOSE_MALFORMED" },
      }),
    );
  }
  const ts = targetSystemSchema.safeParse(i.targetSystem);
  if (!ts.success) {
    return err(
      failure("validation_rejected", "copilot propose: unknown target system", {
        cause: { code: "COPILOT_PROPOSE_BAD_TARGET" },
      }),
    );
  }
  if (i.operation.trim().length === 0) {
    return err(
      failure("validation_rejected", "copilot propose: empty operation", {
        cause: { code: "COPILOT_PROPOSE_BAD_OPERATION" },
      }),
    );
  }
  if (!hasUsableIdentity(i.identity)) {
    return err(
      failure("validation_rejected", "copilot propose: empty object identity", {
        cause: { code: "COPILOT_PROPOSE_EMPTY_IDENTITY" },
      }),
    );
  }
  // JSON-origin payload (SDK tool args) is acyclic → JSON.stringify cannot throw. Bound its size.
  if (JSON.stringify(i.payload).length > MAX_PROPOSE_PAYLOAD_CHARS) {
    return err(
      failure("validation_rejected", "copilot propose: payload too large", {
        cause: { code: "COPILOT_PROPOSE_PAYLOAD_TOO_LARGE" },
      }),
    );
  }
  const targetSystem: TargetSystem = ts.data;
  const canonicalObjectKey = buildCanonicalObjectKey({ targetSystem, identity: i.identity });
  const idempotencyKey = buildIdempotencyKey({ operation: i.operation, identity: i.identity });
  // The candidate action: keys are the SERVER-DERIVED hashes; actionId IS the idempotencyKey (the derived
  // Approval id); approvalPolicy is forced to require a human. `ProposedActionSchema.parse` brands actionId.
  const parsed = ProposedActionSchema.safeParse({
    actionId: idempotencyKey,
    targetSystem,
    canonicalObjectKey,
    payload: i.payload,
    approvalPolicy: COPILOT_PROPOSE_APPROVAL_POLICY,
    idempotencyKey,
  });
  if (!parsed.success) {
    return err(
      failure("schema_rejected", "copilot propose: derived action failed the schema gate", {
        cause: { code: "COPILOT_PROPOSE_SCHEMA_REJECTED" },
      }),
    );
  }
  return ok(parsed.data);
}
