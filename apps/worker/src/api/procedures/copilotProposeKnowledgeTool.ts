// §13.10a — Slice G1: the copilot.propose_knowledge tool + the full propose path (worker side).
//
// The SEMANTIC-write sibling of copilotPropose.ts's `copilot.propose_action` handler. When the
// agent calls the `copilot.propose_knowledge` tool, the model supplies ONLY an untrusted project
// INTENT (projectId/title/lifecycleState/optional summary). This module drives the full path:
//   derive  — `deriveCopilotProjectKnowledgePlan` (Slice B) turns the intent into a validated,
//             SERVER-scoped KnowledgeMutationPlan (server-derived note path/keys/workspace; the
//             model cannot supply a path or a workspace; provenanceOrigin=copilot_propose;
//             requiresApproval forced true; NO numeric percent — REQ-F-011).
//   route   — record the plan as a PENDING §9.8 semantic-mutation Approval + a pending-KMP row via
//             the Slice-E sink (`createApprovalsKnowledgeProposeSink`). NEVER a direct/auto write —
//             KnowledgeWriter commits it ONLY on owner approval (Slice F; safety rules 1+2).
// The handler returns a model-facing "pending approval" acknowledgement (an opaque ref), NEVER raw
// content. Fail-closed + never throws (typed Result throughout; the tool handler folds to a bounded
// cause CODE the model reads).
//
// ⚠ RUNNER PRECONDITIONS (the caller/runner MUST honor — not enforceable here; from the E/F reviews):
//   (a) `workspaceId` MUST be the agent job's SERVER-BOUND workspace, NEVER a model value. The sink's
//       WS-8 guarantee (and Slice B's path derivation) assume a server-bound workspaceId.
//   (b) `noteExists` MUST be resolved by a WS-8-scoped probe of the DERIVED note path at call time
//       (create-vs-patch). The runner computes it against `projectNotePath(workspaceId, projectId)` —
//       the SAME authority Slice B derives — so the probe and the write target the SAME file. (Slice B
//       stays pure by taking the resolved boolean.) The live probe + SDK-tool registration + the boot
//       flag are the DORMANT runner wiring (Slice G3/G4), gated on the §13.10a go-live gates.
//   (c) `sourceRef` is the proposal's grounding evidence (REQ-F-006: the plan cites ≥1 source).
import { isOk, err, failure } from "@sow/contracts";
import type {
  FailureVariant,
  KnowledgeMutationPlan,
  Result,
  SourceRef,
  WorkspaceId,
} from "@sow/contracts";
import { deriveCopilotProjectKnowledgePlan } from "./copilotProposeKnowledge";
import type {
  CopilotKnowledgeProposeReceipt,
  CopilotKnowledgeProposeSink,
} from "./copilotProposeKnowledgeSink";

/** The SDK tool name — exposed to the model as `mcp__copilot__propose_knowledge` (server "copilot"). */
export const COPILOT_PROPOSE_KNOWLEDGE_TOOL_NAME = "propose_knowledge";

/** The model-facing tool description (what the agent reads to decide when/how to call it). */
export const COPILOT_PROPOSE_KNOWLEDGE_TOOL_DESCRIPTION = [
  "Propose a project note (its status) for the owner's approval.",
  "This NEVER writes to the vault directly — it records a PENDING approval the owner must approve first.",
  "Supply: projectId (the project's stable id), title (its display title), lifecycleState (one of",
  "idea/planning/active/paused/done/archived), and an optional summary (candidate status prose).",
  "Do not supply a path, workspace, or percent — those are derived. Use this only when the owner asked",
  "you to capture or update a project's status from the answer.",
].join(" ");

/**
 * Route an already-DERIVED plan to §9.8 Approvals through the Slice-E sink — the only durable artifact
 * of a Copilot semantic proposal is a PENDING card (safety rules 1+2). Idempotent by the sink's derived
 * key (a re-drive returns `created:false`, never a second card). A sink that REJECTS folds straight
 * through; a sink that THROWS (a misbehaving concrete impl / DB fault) folds to a bounded, redaction-safe
 * failure rather than rejecting up to the agent-facing tool handler. `workspaceId` is the caller's
 * SERVER-BOUND workspace (precondition (a)). Never throws.
 */
export async function routeCopilotKnowledgeProposal(params: {
  readonly plan: KnowledgeMutationPlan;
  readonly workspaceId: WorkspaceId;
  readonly sink: CopilotKnowledgeProposeSink;
}): Promise<Result<CopilotKnowledgeProposeReceipt, FailureVariant>> {
  try {
    return await params.sink.record({ plan: params.plan, workspaceId: params.workspaceId });
  } catch {
    return err(
      failure("connector_unreachable", "copilot propose knowledge: approvals sink failed", {
        retryable: true,
        cause: { code: "COPILOT_PROPOSE_KNOWLEDGE_SINK_THREW" },
      }),
    );
  }
}

/**
 * The full propose path the `copilot.propose_knowledge` tool handler invokes: DERIVE the canonical KMP
 * from the model's untrusted intent (server path/keys/workspace, fail-closed) → ROUTE it to §9.8
 * Approvals. A derivation failure short-circuits BEFORE the sink is touched (no partial record). Never
 * throws.
 */
export async function proposeCopilotKnowledge(params: {
  readonly intent: unknown;
  readonly workspaceId: WorkspaceId;
  readonly sourceRef: SourceRef;
  readonly noteExists: boolean;
  readonly sink: CopilotKnowledgeProposeSink;
}): Promise<Result<CopilotKnowledgeProposeReceipt, FailureVariant>> {
  const derived = deriveCopilotProjectKnowledgePlan(params.intent, {
    workspaceId: params.workspaceId,
    sourceRef: params.sourceRef,
    noteExists: params.noteExists,
  });
  if (!isOk(derived)) return derived;
  return routeCopilotKnowledgeProposal({ plan: derived.value, workspaceId: params.workspaceId, sink: params.sink });
}

/** The CallToolResult-shaped result the handler returns (structurally compatible with the SDK's tool result). */
export interface CopilotProposeKnowledgeToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: boolean;
}

function toolText(text: string, isError?: boolean): CopilotProposeKnowledgeToolResult {
  return isError === true ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

/**
 * Handle a `copilot.propose_knowledge` tool call: drive the full derive→route path over the model's
 * UNTRUSTED raw args, and return a model-facing result. On success the model is told a PENDING approval
 * was recorded (its opaque ref) and that nothing is written until the owner approves; an idempotent
 * re-drive reports "already pending" (no duplicate). On failure the model sees ONLY a bounded cause CODE
 * (never raw content). Fail-safe — `proposeCopilotKnowledge` never throws, so this never does.
 * `workspaceId`/`sourceRef`/`noteExists` are supplied by the runner from the SERVER-BOUND agent job (see
 * the runner preconditions in the module header) — never the model.
 */
export async function handleCopilotProposeKnowledgeToolCall(
  rawArgs: unknown,
  deps: {
    readonly workspaceId: WorkspaceId;
    readonly sourceRef: SourceRef;
    readonly noteExists: boolean;
    readonly sink: CopilotKnowledgeProposeSink;
  },
): Promise<CopilotProposeKnowledgeToolResult> {
  // Belt-and-suspenders §16 boundary: `proposeCopilotKnowledge` is fail-closed (derive is pure; route
  // catches a throwing sink), so this catch is dead today — but THIS is the untrusted-model-facing tool
  // surface, and a future regression (a live SDK sink, a derive change) must never throw across it.
  try {
    const r = await proposeCopilotKnowledge({
      intent: rawArgs,
      workspaceId: deps.workspaceId,
      sourceRef: deps.sourceRef,
      noteExists: deps.noteExists,
      sink: deps.sink,
    });
    if (isOk(r)) {
      const { approvalRef, created } = r.value;
      return toolText(
        created
          ? `Recorded a PENDING approval (${approvalRef}). Nothing has been written — the owner must approve it in the Approvals inbox before KnowledgeWriter commits it.`
          : `That proposal is ALREADY pending approval (${approvalRef}) — no duplicate was created. The owner must approve it before it is written.`,
      );
    }
    const code = r.error.cause?.code ?? r.error.kind;
    return toolText(`Could not record the proposal (${code}). Nothing was written.`, true);
  } catch {
    return toolText("Could not record the proposal (COPILOT_PROPOSE_KNOWLEDGE_UNEXPECTED). Nothing was written.", true);
  }
}
