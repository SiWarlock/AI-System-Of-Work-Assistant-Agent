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
import { ok, err, isOk, failure, ProposedActionSchema } from "@sow/contracts";
import type {
  ExternalWriteEnvelope,
  FailureVariant,
  ProposedAction,
  Result,
  TargetSystem,
  WorkspaceId,
} from "@sow/contracts";
import { targetSystemSchema } from "@sow/contracts";
import { buildCanonicalObjectKey, buildIdempotencyKey } from "@sow/domain";
import { buildEnvelopeFromAction } from "@sow/integrations";

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

// ── C5.2b — route the derived proposal → §9.8 Approvals (UNCONDITIONALLY) ──────
//
// The read path never applies a write; the ONLY durable artifact of a Copilot proposal is a PENDING Approval
// card the owner must approve (§9.8, session 027). Routing here (a) builds the §8 ExternalWriteEnvelope from
// the derived action (reusing @sow/integrations `buildEnvelopeFromAction`, which computes the payloadHash and
// PROVES the `envelopeMatchesAction` linkage pin), and (b) records it pending through the injected sink —
// UNCONDITIONALLY. It NEVER inspects `approvalPolicy` to decide auto-vs-human (carry-forward #1: the human
// gate is STRUCTURAL — everything routes to the pending inbox; `approvalPolicy` is decorative). Idempotent by
// the DERIVED key (the sink dedupes on `envelope.idempotencyKey`): a re-drive returns `created:false`, never a
// second card. The concrete sink (RecordPending / ApprovalRepository) is wired in C5.3; here it is injected.

/** The Copilot-specific precondition every proposal card carries — the owner's explicit approval gates it. */
export const COPILOT_PROPOSE_PRECONDITION = "copilot.proposal.requires_owner_approval";

/** Proof a proposal was recorded as a pending Approval. `created:false` ⇒ an idempotent re-drive (no 2nd card). */
export interface CopilotProposeReceipt {
  readonly approvalRef: string;
  readonly created: boolean;
}

/**
 * The seam to §9.8 Approvals: record the (action, envelope) as a PENDING Approval, idempotent by the
 * envelope's idempotencyKey. A fake in tests; the concrete impl (C5.3) wraps the live RecordPending /
 * ApprovalRepository recording.
 *
 * ⚠ C5.3 CONCRETE-SINK CONTRACT (security-review — the routing layer cannot enforce these):
 *   (a) WORKSPACE PROVENANCE (safety rule 4): `workspaceId` MUST be the agent-job's SERVER-BOUND workspace
 *       (never derived from model output), and the sink SHOULD validate it against the workspace registry and
 *       scope the card by it — the envelope carries NO workspace field, so this is the SOLE attribution.
 *   (b) PAYLOAD-SWAP TOCTOU (safety rule 3): idempotency is keyed on identity+operation, NOT payload. So the
 *       sink MUST be first-write-wins / no-op-on-hit and, on a same-idempotencyKey hit whose `payloadHash`
 *       DIVERGES from the recorded card, REJECT (or record a distinct new card) — NEVER silently overwrite an
 *       already-recorded (esp. approved) card's payload, or an owner who approved payload A executes A′.
 *   (c) The sink MUST return a typed Result (never reject) with BOUNDED cause codes + pre-redacted messages;
 *       and neither it nor the execution path may auto-apply on the decorative `approvalPolicy` string.
 */
export interface CopilotProposeSink {
  record(input: {
    readonly action: ProposedAction;
    readonly envelope: ExternalWriteEnvelope;
    readonly workspaceId: WorkspaceId;
  }): Promise<Result<CopilotProposeReceipt, FailureVariant>>;
}

/**
 * Route an already-DERIVED proposal to §9.8 Approvals: build the envelope (linkage-pinned to the action), then
 * record it pending through the sink — UNCONDITIONALLY (never branch on `approvalPolicy`). An envelope-build
 * failure folds to a typed `validation_rejected`; a sink that REJECTS (a mis-behaving concrete impl) is folded
 * to a bounded `COPILOT_PROPOSE_SINK_THREW` (never lets a raw error/stack escape — §16 redaction + the module's
 * never-throws contract). `workspaceId` is a branded `WorkspaceId` — the caller (C5.3) owns its provenance +
 * registry validation. REQUIRES a DERIVED action (the payload-size bound lives in `deriveCopilotProposedAction`;
 * a non-derived caller bypasses it). No side effect beyond the pending card. Never throws.
 */
export async function routeCopilotProposal(params: {
  readonly action: ProposedAction;
  readonly workspaceId: WorkspaceId;
  readonly sink: CopilotProposeSink;
}): Promise<Result<CopilotProposeReceipt, FailureVariant>> {
  const envelope = buildEnvelopeFromAction(params.action, {
    preconditions: [COPILOT_PROPOSE_PRECONDITION],
  });
  if (!isOk(envelope)) {
    return err(
      failure("validation_rejected", "copilot propose: envelope build failed", {
        cause: { code: `COPILOT_PROPOSE_ENVELOPE_${envelope.error.code}` },
      }),
    );
  }
  // UNCONDITIONAL — every derived proposal becomes a pending card. The human gate is structural, not a policy
  // branch (carry-forward #1). Idempotency is the sink's job, keyed on envelope.idempotencyKey. The sink call
  // is wrapped so a throwing concrete impl (e.g. a DB fault) folds to a bounded, redaction-safe failure rather
  // than rejecting up to the agent-facing tool handler.
  try {
    return await params.sink.record({
      action: params.action,
      envelope: envelope.value,
      workspaceId: params.workspaceId,
    });
  } catch {
    return err(
      failure("connector_unreachable", "copilot propose: approvals sink failed", {
        retryable: true,
        cause: { code: "COPILOT_PROPOSE_SINK_THREW" },
      }),
    );
  }
}

/**
 * The full propose path the `copilot.propose_action` tool handler (C5.2c) invokes: DERIVE the canonical action
 * from the model's untrusted intent (server keys, fail-closed) → ROUTE it to §9.8 Approvals. A derivation
 * failure short-circuits BEFORE the sink is touched (no partial record). Never throws.
 */
export async function proposeCopilotAction(params: {
  readonly intent: unknown;
  readonly workspaceId: WorkspaceId;
  readonly sink: CopilotProposeSink;
}): Promise<Result<CopilotProposeReceipt, FailureVariant>> {
  const derived = deriveCopilotProposedAction(params.intent);
  if (!isOk(derived)) return derived;
  return routeCopilotProposal({ action: derived.value, workspaceId: params.workspaceId, sink: params.sink });
}

// ── C5.2c — the copilot.propose_action tool handler (model-facing) ─────────────
//
// The in-process MCP tool the agent calls to propose an external write. This handler is the MODEL-FACING
// surface: it drives the full derive→route path (`proposeCopilotAction`) over the model's UNTRUSTED raw args
// and returns a CallToolResult-shaped result the model reads — a plain "pending approval" acknowledgement,
// NEVER a direct write. FAIL-SAFE: `proposeCopilotAction` is fail-closed (never throws), so this never does,
// and an error surfaces ONLY a stable cause CODE to the model (never raw content / secrets / a stack). The SDK
// `createSdkMcpServer`/`tool` REGISTRATION (which needs a Zod input shape — the worker has no zod dep) is a
// thin eval-gated adapter built in C5.3; THIS handler is the deterministic, unit-tested core it wraps.

/** The SDK tool name — exposed to the model as `mcp__copilot__propose_action` (server "copilot"). */
export const COPILOT_PROPOSE_TOOL_NAME = "propose_action";

/** The model-facing tool description (what the agent reads to decide when/how to call it). */
export const COPILOT_PROPOSE_TOOL_DESCRIPTION = [
  "Propose an external write (e.g. create a task, calendar event, or doc) for the owner's approval.",
  "This NEVER performs the write directly — it records a PENDING approval the owner must approve first.",
  "Supply: targetSystem (one of the connected systems), operation (e.g. 'todoist.create_task'), identity",
  "(the object's identifying fields, e.g. { title }), and payload (the write content). Do not invent a",
  "targetSystem. Use this only when the owner explicitly asked you to act on the answer.",
].join(" ");

/** The CallToolResult-shaped result the handler returns (structurally compatible with the SDK's tool result). */
export interface CopilotProposeToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: boolean;
}

function toolText(text: string, isError?: boolean): CopilotProposeToolResult {
  return isError === true
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

/**
 * Handle a `copilot.propose_action` tool call: drive the full derive→route path over the model's UNTRUSTED raw
 * args, and return a model-facing result. On success the model is told a PENDING approval was recorded (its
 * opaque ref) and that nothing is applied until the owner approves; an idempotent re-drive reports "already
 * pending" (no duplicate). On failure the model sees ONLY a bounded cause CODE (never raw content). Fail-safe —
 * `proposeCopilotAction` never throws, so this never does. `workspaceId` + `sink` are supplied by the runner
 * (C5.3) from the SERVER-BOUND agent job — never the model.
 */
export async function handleCopilotProposeToolCall(
  rawArgs: unknown,
  deps: { readonly workspaceId: WorkspaceId; readonly sink: CopilotProposeSink },
): Promise<CopilotProposeToolResult> {
  const r = await proposeCopilotAction({ intent: rawArgs, workspaceId: deps.workspaceId, sink: deps.sink });
  if (isOk(r)) {
    const { approvalRef, created } = r.value;
    return toolText(
      created
        ? `Recorded a PENDING approval (${approvalRef}). Nothing has been changed — the owner must approve it in the Approvals inbox before it is applied.`
        : `That proposal is ALREADY pending approval (${approvalRef}) — no duplicate was created. The owner must approve it before it is applied.`,
    );
  }
  const code = r.error.cause?.code ?? r.error.kind;
  return toolText(`Could not record the proposal (${code}). No action was taken.`, true);
}
