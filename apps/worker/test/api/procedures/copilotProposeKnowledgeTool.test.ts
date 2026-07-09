// §13.10a — Slice G1: the copilot.propose_knowledge tool + the full propose path (worker side).
// The model-facing surface that turns an untrusted project intent into a PENDING §9.8 semantic
// card: derive (Slice B) → route to the Slice-E sink. Never writes Markdown directly; the sole
// durable artifact is a pending Approval the owner must approve (Slice F commits it).
import { describe, it, expect } from "vitest";
import { ok, err, isOk, failure } from "@sow/contracts";
import type {
  FailureVariant,
  KnowledgeMutationPlan,
  Result,
  SourceRef,
  WorkspaceId,
} from "@sow/contracts";
import type {
  CopilotKnowledgeProposeReceipt,
  CopilotKnowledgeProposeSink,
} from "../../../src/api/procedures/copilotProposeKnowledgeSink";
import {
  COPILOT_PROPOSE_KNOWLEDGE_TOOL_NAME,
  routeCopilotKnowledgeProposal,
  proposeCopilotKnowledge,
  handleCopilotProposeKnowledgeToolCall,
} from "../../../src/api/procedures/copilotProposeKnowledgeTool";

const WS = "personal-business" as unknown as WorkspaceId;
const SRC = { sourceId: "src-1" } as unknown as SourceRef;
const INTENT = { projectId: "acme", title: "Acme", lifecycleState: "active" };

/** A fake sink: records every (plan, workspaceId) it is handed; returns a configured receipt or throws. */
function fakeSink(
  opts: { receipt?: CopilotKnowledgeProposeReceipt; error?: FailureVariant; throws?: boolean } = {},
): { sink: CopilotKnowledgeProposeSink; calls: { plan: KnowledgeMutationPlan; workspaceId: WorkspaceId }[] } {
  const calls: { plan: KnowledgeMutationPlan; workspaceId: WorkspaceId }[] = [];
  const sink: CopilotKnowledgeProposeSink = {
    record: (input): Promise<Result<CopilotKnowledgeProposeReceipt, FailureVariant>> => {
      if (opts.throws === true) throw new Error("db exploded");
      calls.push({ plan: input.plan, workspaceId: input.workspaceId });
      if (opts.error !== undefined) return Promise.resolve(err(opts.error));
      return Promise.resolve(
        ok(opts.receipt ?? { approvalRef: "appr-k-1", planRef: "plan-k-1", created: true }),
      );
    },
  };
  return { sink, calls };
}

const assertErr = <T,>(r: Result<T, FailureVariant>): FailureVariant => {
  if (r.ok) throw new Error("expected err, got ok");
  return r.error;
};

describe("proposeCopilotKnowledge — derive → route", () => {
  it("derives a KMP from a valid intent and records it through the sink (server-bound workspace)", async () => {
    const { sink, calls } = fakeSink();
    const r = await proposeCopilotKnowledge({ intent: INTENT, workspaceId: WS, sourceRef: SRC, noteExists: false, sink });
    expect(isOk(r)).toBe(true);
    expect(calls).toHaveLength(1);
    const plan = calls[0]!.plan;
    // workspace + provenance + evidence are SERVER-derived, never from the model intent.
    expect(String(calls[0]!.workspaceId)).toBe("personal-business");
    expect(String(plan.workspaceId)).toBe("personal-business");
    expect(plan.provenanceOrigin).toBe("copilot_propose");
    expect(plan.requiresApproval).toBe(true);
    expect(plan.sourceRefs.map((s) => String(s.sourceId))).toContain("src-1");
    // first proposal → a NoteCreate (never a whole-file patch).
    expect(plan.creates).toHaveLength(1);
    expect(plan.patches).toHaveLength(0);
  });

  it("threads noteExists=true into a region PATCH (re-proposal never overwrites the whole note)", async () => {
    const { sink, calls } = fakeSink();
    await proposeCopilotKnowledge({ intent: INTENT, workspaceId: WS, sourceRef: SRC, noteExists: true, sink });
    const plan = calls[0]!.plan;
    expect(plan.creates).toHaveLength(0);
    expect(plan.patches).toHaveLength(1);
  });

  it("a malformed intent short-circuits BEFORE the sink (no partial record)", async () => {
    const { sink, calls } = fakeSink();
    const r = await proposeCopilotKnowledge({ intent: { projectId: 42 }, workspaceId: WS, sourceRef: SRC, noteExists: false, sink });
    expect(assertErr(r).cause?.code).toBe("COPILOT_PROPOSE_KNOWLEDGE_MALFORMED");
    expect(calls).toHaveLength(0);
  });

  it("a smuggled workspaceId key in the intent is rejected (strict shape guard)", async () => {
    const { sink, calls } = fakeSink();
    const r = await proposeCopilotKnowledge({
      intent: { ...INTENT, workspaceId: "employer-work" },
      workspaceId: WS,
      sourceRef: SRC,
      noteExists: false,
      sink,
    });
    expect(assertErr(r).cause?.code).toBe("COPILOT_PROPOSE_KNOWLEDGE_MALFORMED");
    expect(calls).toHaveLength(0);
  });
});

describe("routeCopilotKnowledgeProposal — never-throws wrapper", () => {
  it("folds a throwing sink to a bounded, redaction-safe failure (never throws)", async () => {
    const { sink } = fakeSink({ throws: true });
    const plan = { workspaceId: WS } as unknown as KnowledgeMutationPlan;
    const r = await routeCopilotKnowledgeProposal({ plan, workspaceId: WS, sink });
    expect(assertErr(r).cause?.code).toBe("COPILOT_PROPOSE_KNOWLEDGE_SINK_THREW");
  });

  it("passes a sink err straight through", async () => {
    const sinkErr = failure("write_conflict", "x", { cause: { code: "COPILOT_PROPOSE_KNOWLEDGE_PLAN_CONFLICT" } });
    const { sink } = fakeSink({ error: sinkErr });
    const plan = { workspaceId: WS } as unknown as KnowledgeMutationPlan;
    const r = await routeCopilotKnowledgeProposal({ plan, workspaceId: WS, sink });
    expect(assertErr(r).cause?.code).toBe("COPILOT_PROPOSE_KNOWLEDGE_PLAN_CONFLICT");
  });
});

describe("handleCopilotProposeKnowledgeToolCall — model-facing", () => {
  it("exposes the tool name", () => {
    expect(COPILOT_PROPOSE_KNOWLEDGE_TOOL_NAME).toBe("propose_knowledge");
  });

  it("success tells the model a PENDING approval was recorded (never a direct write)", async () => {
    const { sink } = fakeSink({ receipt: { approvalRef: "appr-k-9", planRef: "plan-k-9", created: true } });
    const res = await handleCopilotProposeKnowledgeToolCall(INTENT, { workspaceId: WS, sourceRef: SRC, noteExists: false, sink });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toMatch(/PENDING/);
    expect(res.content[0]?.text).toContain("appr-k-9");
  });

  it("an idempotent re-drive reports already-pending (no duplicate)", async () => {
    const { sink } = fakeSink({ receipt: { approvalRef: "appr-k-9", planRef: "plan-k-9", created: false } });
    const res = await handleCopilotProposeKnowledgeToolCall(INTENT, { workspaceId: WS, sourceRef: SRC, noteExists: false, sink });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toMatch(/ALREADY|already/);
  });

  it("stays non-throwing at the tool surface even when the sink throws", async () => {
    const { sink } = fakeSink({ throws: true });
    const res = await handleCopilotProposeKnowledgeToolCall(INTENT, { workspaceId: WS, sourceRef: SRC, noteExists: false, sink });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/SINK_THREW|UNEXPECTED/);
  });

  it("failure surfaces ONLY a bounded cause code to the model (never raw content), and does not touch the sink", async () => {
    const { sink, calls } = fakeSink();
    const res = await handleCopilotProposeKnowledgeToolCall({ projectId: 42 }, { workspaceId: WS, sourceRef: SRC, noteExists: false, sink });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("COPILOT_PROPOSE_KNOWLEDGE_MALFORMED");
    expect(calls).toHaveLength(0);
  });
});
