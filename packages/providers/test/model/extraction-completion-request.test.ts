// spec(§19.5)/spec(§7) — 18.19: the PURE subscription-extraction CompletionRequest assembler.
// Maps an already-built AgentExtractionRequest (CP-2/CP-3) + resolved inline content + opts →
// a CompletionRequest for the Claude SUBSCRIPTION client (createClaudeSubscriptionCompletion):
//   req.prompt → systemPrompt, content → userPrompt, inline sow:agent-extraction schema → outputSchema,
//   enforced dollar cap → maxCostUsd (the field complete() forwards to the SDK `maxBudgetUsd` —
//   the COST-1 re-point for the subscription/runtime route, §19.5 Finding-F).
// PURE + TOTAL: no I/O, never throws, does NOT resolve schemas (done upstream in the builder) and does
// NOT read ANTHROPIC_API_KEY (ambient subscription auth is the client's concern; the worker runs it UNSET).
import { describe, it, expect } from "vitest";
import type { AgentJob } from "@sow/contracts";
import { isOk, AGENT_EXTRACTION_SCHEMA_ID, validAgentJob } from "@sow/contracts";
import {
  buildMeetingExtractionRequest,
  buildSourceExtractionRequest,
  type AgentExtractionRequest,
  type SchemaResolver,
} from "../../src/model/extraction-request";
import {
  buildExtractionCompletionRequest,
  DEFAULT_EXTRACTION_BETAS,
} from "../../src/model/extraction-completion-request";

const extractionJob: AgentJob = { ...validAgentJob, outputSchemaId: AGENT_EXTRACTION_SCHEMA_ID };

// A deterministic fake resolver returning a minimal CLOSED inline schema (never a bare $id ref) —
// the same fixture shape the CP-2/CP-3 extraction-request tests use.
const fakeClosedSchema: Record<string, unknown> = {
  type: "object",
  properties: { fields: { type: "object" } },
  required: ["fields"],
  additionalProperties: false,
};
const fakeResolver: SchemaResolver = (id) =>
  id === AGENT_EXTRACTION_SCHEMA_ID ? fakeClosedSchema : undefined;

function meetingReq(): AgentExtractionRequest {
  const out = buildMeetingExtractionRequest(extractionJob, fakeResolver);
  if (!isOk(out)) throw new Error("fixture: meeting request must build");
  return out.value;
}
function sourceReq(): AgentExtractionRequest {
  const out = buildSourceExtractionRequest(extractionJob, fakeResolver);
  if (!isOk(out)) throw new Error("fixture: source request must build");
  return out.value;
}

describe("buildExtractionCompletionRequest — subscription extraction CompletionRequest assembler (18.19)", () => {
  it("maps_prompt_content_and_schema", () => {
    // spec(§19.5) — the subscription extraction request shape: prompt→systemPrompt, content→userPrompt,
    // inline sow:agent-extraction schema→outputSchema (GATE-1 evidence-preserving), model from opts.
    const req = meetingReq();
    const content = "meeting transcript body ...";
    const result = buildExtractionCompletionRequest(req, content, { model: "claude-sonnet-4-6" });
    expect(result.systemPrompt).toBe(req.prompt);
    expect(result.userPrompt).toBe(content);
    expect(result.outputSchema).toBe(req.outputConfig.format.schema); // the resolved inline schema, by reference
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("threads_maxcostusd_to_the_budget_field", () => {
    // spec(§7) — the enforced COST-1 dollar cap reaches CompletionRequest.maxCostUsd, the field
    // complete() forwards to the SDK `maxBudgetUsd` lever (Context7-verified option name; §19.5 Finding-F).
    const result = buildExtractionCompletionRequest(meetingReq(), "c", { model: "m", maxCostUsd: 1.5 });
    expect(result.maxCostUsd).toBe(1.5);
  });

  it("threads_a_zero_cap_by_presence_not_truthiness", () => {
    // spec(§7) — the carry rule is PRESENCE (`!== undefined`), NOT truthiness: a 0 cap is a real
    // (spend-anything-fails) value and must be carried, not dropped. A `opts.maxCostUsd ? … : …`
    // regression would silently omit it and fail-OPEN to the SDK default budget (Lessons 54/55).
    const result = buildExtractionCompletionRequest(meetingReq(), "c", { model: "m", maxCostUsd: 0 });
    expect(result.maxCostUsd).toBe(0);
    expect("maxCostUsd" in result).toBe(true);
  });

  it("omits_maxcostusd_when_absent", () => {
    // spec(§7) — absent cap ⇒ the maxCostUsd KEY is omitted (conditional-spread), not undefined-valued,
    // so the SDK's own default budget applies when the enforcer supplies none.
    const result = buildExtractionCompletionRequest(meetingReq(), "c", { model: "m" });
    expect("maxCostUsd" in result).toBe(false);
  });

  it("betas_conditional_and_default_exported", () => {
    // spec(§19.5) — betas conditional-spread (present⇒carried verbatim, absent⇒key omitted); the exported
    // default extraction-betas constant is a non-empty readonly string[] (matches the Copilot 1M-context default).
    const withBetas = buildExtractionCompletionRequest(meetingReq(), "c", {
      model: "m",
      betas: ["context-1m-2025-08-07"],
    });
    expect(withBetas.betas).toEqual(["context-1m-2025-08-07"]);
    const without = buildExtractionCompletionRequest(meetingReq(), "c", { model: "m" });
    expect("betas" in without).toBe(false);
    expect(Array.isArray(DEFAULT_EXTRACTION_BETAS)).toBe(true);
    expect(DEFAULT_EXTRACTION_BETAS.length).toBeGreaterThan(0);
  });

  it("source_request_maps_identically", () => {
    // spec(§19.5) — one assembler serves BOTH legs; a buildSourceExtractionRequest-shaped request maps
    // the same way (the assembler consumes the built request, not the job — prompt/source-agnostic).
    const req = sourceReq();
    const result = buildExtractionCompletionRequest(req, "source doc body", { model: "m" });
    expect(result.systemPrompt).toBe(req.prompt);
    expect(result.userPrompt).toBe("source doc body");
    expect(result.outputSchema).toBe(req.outputConfig.format.schema);
  });

  it("is_total_pure_no_throw", () => {
    // spec(§16) — total: returns a value for every input in the type; an empty content string still maps
    // (schema resolution already happened upstream); no throw, no Result, no I/O. Minimal clean shape.
    const result = buildExtractionCompletionRequest(meetingReq(), "", { model: "m" });
    expect(result.userPrompt).toBe("");
    expect("maxCostUsd" in result).toBe(false);
    expect("betas" in result).toBe(false);
  });
});
