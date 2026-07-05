// §9.6-real P2.2 — the PURE mapping surface of the Claude-subscription completion client. The real
// `query()` I/O is eval/integration-tested; THIS pins `extractCompletion`, where a mapping bug would
// silently corrupt (or fabricate) a Copilot answer. Messages are fabricated + cast to the SDK shape.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { extractCompletion } from "../src/model/claude-subscription-completion";

/** A fabricated SDK success result carrying (optionally) the structured output. */
function successResult(structuredOutput: unknown, costUsd = 0.012): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    result: "text form",
    structured_output: structuredOutput,
    total_cost_usd: costUsd,
    is_error: false,
    num_turns: 1,
  } as unknown as SDKMessage;
}

/** A fabricated SDK error result of a given subtype. */
function errorResult(subtype: string, errors: string[] = []): SDKMessage {
  return {
    type: "result",
    subtype,
    is_error: true,
    errors,
    total_cost_usd: 0.001,
    num_turns: 1,
  } as unknown as SDKMessage;
}

const assistant = { type: "assistant", message: { content: [] } } as unknown as SDKMessage;

describe("extractCompletion — SDK result → CompletionOutput | typed error (§9.6-real P2.2)", () => {
  it("a SUCCESS result with structured_output → ok({ structuredOutput, costUsd })", () => {
    const out = { answer: ["A decision was logged."], citations: [{ citationId: "c1", title: "Note" }] };
    const r = extractCompletion([assistant, successResult(out, 0.02)]);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.structuredOutput).toEqual(out);
      expect(r.value.costUsd).toBe(0.02);
    }
  });

  it("a SUCCESS result with NO structured_output → err(malformed) (fail-closed, never fabricate)", () => {
    const r = extractCompletion([successResult(undefined)]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("malformed");
  });

  it("a SUCCESS result whose structured_output is JSON null → err(malformed) (== null, not just undefined)", () => {
    const r = extractCompletion([successResult(null)]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("malformed");
  });

  it("error_max_budget_usd → err(budget)", () => {
    const r = extractCompletion([errorResult("error_max_budget_usd", ["over budget"])]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("budget");
      expect(r.error.message).toContain("over budget");
    }
  });

  it("error_max_structured_output_retries → err(malformed) (the model never produced valid JSON)", () => {
    const r = extractCompletion([errorResult("error_max_structured_output_retries")]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("malformed");
  });

  it("error_during_execution → err(transport, retryable)", () => {
    const r = extractCompletion([errorResult("error_during_execution", ["boom"])]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("transport");
      expect(r.error.retryable).toBe(true);
    }
  });

  it("NO result message in the stream → err(transport, retryable) (fail-closed)", () => {
    const r = extractCompletion([assistant, assistant]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("transport");
  });
});
