// spec(§7) — Two-port contracts (ModelProviderPort / AgentRuntimePort) + shared AgentResult:
// shape, constructors/guards, and the cancellation-aware never-throw Result surface.
import { describe, it, expect } from "vitest";
import { isOk, isErr, ok, err } from "@sow/contracts";
import type { Result, AgentJob, ProviderRoute, Capability } from "@sow/contracts";
import { validAgentJob } from "@sow/contracts";
import {
  makeAgentResult,
  emptyUsage,
  isCompleted,
  isCancelled,
  AgentResultStatus,
  type AgentResult,
  type AgentUsage,
  type AgentLogEntry,
} from "../src/ports/agent-result";
import {
  providerError,
  ProviderErrorKind,
  type ModelProviderPort,
  type ProviderRequest,
  type ProviderOutput,
  type ProviderError,
} from "../src/ports/model-provider-port";
import {
  runtimeError,
  RuntimeErrorKind,
  type AgentRuntimePort,
  type RuntimeError,
} from "../src/ports/agent-runtime-port";

// A cloud route so both ports have a concrete resolved target to carry.
const cloudRoute: ProviderRoute = {
  provider: "claude",
  model: "claude-opus-4",
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
};

describe("AgentResult — shared normalization envelope", () => {
  it("AgentResultStatus is the closed { completed, cancelled } set", () => {
    expect([...AgentResultStatus]).toEqual(["completed", "cancelled"]);
  });

  it("emptyUsage() is a zeroed runtime meter (no cost yet)", () => {
    const u: AgentUsage = emptyUsage();
    expect(u.runtimeSeconds).toBe(0);
    expect(u.costUsd).toBeUndefined();
  });

  it("makeAgentResult carries candidate output + usage + isolated logs (5.6 redaction surface)", () => {
    const logs: AgentLogEntry[] = [{ level: "info", message: "provider call ok" }];
    const r: AgentResult = makeAgentResult({
      status: "completed",
      candidateOutput: { title: "candidate" },
      usage: { runtimeSeconds: 2, costUsd: 0.01 },
      logs,
    });
    expect(r.status).toBe("completed");
    expect(r.candidateOutput).toEqual({ title: "candidate" });
    expect(r.usage.costUsd).toBe(0.01);
    // logs is an isolated field the downstream redactor (5.6) owns.
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]?.message).toBe("provider call ok");
  });

  it("isCompleted / isCancelled partition the status", () => {
    const done = makeAgentResult({ status: "completed", candidateOutput: 1, usage: emptyUsage(), logs: [] });
    const stopped = makeAgentResult({ status: "cancelled", candidateOutput: undefined, usage: emptyUsage(), logs: [] });
    expect(isCompleted(done)).toBe(true);
    expect(isCancelled(done)).toBe(false);
    expect(isCancelled(stopped)).toBe(true);
    expect(isCompleted(stopped)).toBe(false);
  });
});

describe("ProviderError / RuntimeError — typed, enumerable, never thrown", () => {
  it("ProviderErrorKind enumerates the raw-provider failure surface", () => {
    expect([...ProviderErrorKind]).toEqual([
      "invalid_request",
      "auth_unavailable",
      "model_unavailable",
      "transport_error",
      "rate_limited",
      "timeout",
      "cancelled",
      "malformed_output",
    ]);
  });

  it("RuntimeErrorKind enumerates the agentic-runtime failure surface (incl. tool-policy violation)", () => {
    expect([...RuntimeErrorKind]).toEqual([
      "invalid_job",
      "auth_unavailable",
      "runtime_unavailable",
      "tool_policy_violation",
      "transport_error",
      "timeout",
      "cancelled",
      "malformed_output",
    ]);
  });

  it("providerError defaults retryable=false and carries kind + message", () => {
    const e: ProviderError = providerError("model_unavailable", "no such model");
    expect(e.kind).toBe("model_unavailable");
    expect(e.message).toBe("no such model");
    expect(e.retryable).toBe(false);
  });

  it("providerError honors an explicit retryable flag", () => {
    const e = providerError("rate_limited", "429", { retryable: true });
    expect(e.retryable).toBe(true);
  });

  it("runtimeError defaults retryable=false and carries kind + message", () => {
    const e: RuntimeError = runtimeError("tool_policy_violation", "read_only job attempted a mutating tool");
    expect(e.kind).toBe("tool_policy_violation");
    expect(e.retryable).toBe(false);
  });
});

// --- Fake in-memory ports implementing each interface, proving the contract shape ---

class FakeModelProvider implements ModelProviderPort {
  readonly providerId = "claude" as const;
  constructor(private readonly outcome: Result<ProviderOutput, ProviderError>) {}
  async complete(_req: ProviderRequest, signal?: AbortSignal): Promise<Result<ProviderOutput, ProviderError>> {
    if (signal?.aborted) return err(providerError("cancelled", "aborted before dispatch"));
    return this.outcome;
  }
}

class FakeAgentRuntime implements AgentRuntimePort {
  readonly runtimeId = "claude-agent-sdk";
  constructor(private readonly outcome: Result<AgentResult, RuntimeError>) {}
  async runJob(_job: AgentJob, signal?: AbortSignal): Promise<Result<AgentResult, RuntimeError>> {
    if (signal?.aborted) return err(runtimeError("cancelled", "aborted before dispatch"));
    return this.outcome;
  }
}

describe("ModelProviderPort — raw schema-validated completion, no agentic loop", () => {
  const req: ProviderRequest = {
    route: cloudRoute,
    model: "claude-opus-4",
    capability: "note.extract" as Capability,
    inputRefs: [],
    outputSchemaId: "sow:knowledge-mutation-plan",
    budget: { maxRuntimeSeconds: 30, maxCostUsd: 0.5 },
    idempotencyKey: "idem-1",
  };

  it("returns Ok(ProviderOutput) carrying candidate output (never applied)", async () => {
    const out: ProviderOutput = {
      status: "completed",
      candidateOutput: { plan: "candidate" },
      usage: { runtimeSeconds: 1 },
      logs: [],
    };
    const port = new FakeModelProvider(ok(out));
    const r = await port.complete(req);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.candidateOutput).toEqual({ plan: "candidate" });
  });

  it("returns a typed Err — never throws — on failure", async () => {
    const port = new FakeModelProvider(err(providerError("transport_error", "ECONNRESET", { retryable: true })));
    const r = await port.complete(req);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("transport_error");
  });

  it("is cancellation-aware: an already-aborted signal yields Err(cancelled), no side effect", async () => {
    const out: ProviderOutput = { status: "completed", candidateOutput: {}, usage: emptyUsage(), logs: [] };
    const port = new FakeModelProvider(ok(out));
    const ac = new AbortController();
    ac.abort();
    const r = await port.complete(req, ac.signal);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("cancelled");
  });
});

describe("AgentRuntimePort — agentic runtime, returns the shared AgentResult", () => {
  it("returns Ok(AgentResult) for a driven AgentJob", async () => {
    const result = makeAgentResult({
      status: "completed",
      candidateOutput: { decisions: [] },
      usage: { runtimeSeconds: 5, costUsd: 0.02 },
      logs: [{ level: "debug", message: "tool loop" }],
    });
    const port = new FakeAgentRuntime(ok(result));
    const r = await port.runJob(validAgentJob as unknown as AgentJob);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(isCompleted(r.value)).toBe(true);
  });

  it("is cancellation-aware: an already-aborted signal yields Err(cancelled)", async () => {
    const result = makeAgentResult({ status: "completed", candidateOutput: {}, usage: emptyUsage(), logs: [] });
    const port = new FakeAgentRuntime(ok(result));
    const ac = new AbortController();
    ac.abort();
    const r = await port.runJob(validAgentJob as unknown as AgentJob, ac.signal);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("cancelled");
  });

  it("a single adapter's runtimeId is distinct from a ModelProviderPort's providerId (two-layer split)", () => {
    const runtime = new FakeAgentRuntime(err(runtimeError("runtime_unavailable", "down")));
    const provider = new FakeModelProvider(err(providerError("model_unavailable", "down")));
    // The runtime is keyed by an open runtime id; the provider by a closed ProviderId.
    expect(runtime.runtimeId).toBe("claude-agent-sdk");
    expect(provider.providerId).toBe("claude");
  });
});
