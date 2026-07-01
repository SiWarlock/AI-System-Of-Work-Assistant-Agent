// spec(§7) — ClaudeAgentSdkRuntimeAdapter (5.8): request→port-call→normalized-output
// + error/cancel mapping, ING-7 tool-policy enforcement, and log redaction, all
// against a MOCK transport (no real SDK I/O).
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { Result, AgentJob, ToolPolicy, ProviderRoute, ToolId } from "@sow/contracts";
import { validAgentJob } from "@sow/contracts";
import {
  createClaudeAgentSdkRuntime,
  buildClaudeAgentInvocation,
  CLAUDE_AGENT_SDK_RUNTIME_ID,
  type ClaudeAgentTransport,
  type ClaudeAgentInvocation,
  type ClaudeAgentRawResult,
  type ClaudeAgentTransportError,
  type ClaudeAgentTransportErrorKind,
} from "../src/runtime/claude-agent-sdk-runtime";
import type { RuntimeErrorKind } from "../src/ports/agent-runtime-port";

const sdkRoute: ProviderRoute = {
  runtime: CLAUDE_AGENT_SDK_RUNTIME_ID,
  model: "claude-opus-4",
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
};

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return { ...validAgentJob, providerRoute: sdkRoute, ...overrides };
}

const readOnlyPolicy: ToolPolicy = {
  mode: "read_only",
  allowedTools: ["read.file" as ToolId, "gbrain.query" as ToolId],
  deniedTools: [],
  allowsMutating: false,
};

/** A mock transport that records the invocation it received and returns a canned outcome. */
class SpyTransport implements ClaudeAgentTransport {
  public calls: ClaudeAgentInvocation[] = [];
  constructor(private readonly outcome: Result<ClaudeAgentRawResult, ClaudeAgentTransportError>) {}
  async invoke(
    inv: ClaudeAgentInvocation,
    signal?: AbortSignal,
  ): Promise<Result<ClaudeAgentRawResult, ClaudeAgentTransportError>> {
    this.calls.push(inv);
    if (signal?.aborted) return err({ kind: "cancelled", message: "aborted" });
    return this.outcome;
  }
}

const okRaw: ClaudeAgentRawResult = {
  status: "completed",
  candidateOutput: { plan: "candidate" },
  usage: { runtimeSeconds: 4, costUsd: 0.02 },
  logs: [{ level: "info", message: "tool loop ok" }],
};

describe("ClaudeAgentSdkRuntimeAdapter — identity + request mapping", () => {
  it("exposes the open runtimeId (distinct from a closed ProviderId)", () => {
    const rt = createClaudeAgentSdkRuntime(new SpyTransport(ok(okRaw)));
    expect(rt.runtimeId).toBe("claude-agent-sdk");
  });

  it("maps the job onto an invocation: effective allow-list, read-only + trust flags, route", async () => {
    const spy = new SpyTransport(ok(okRaw));
    const rt = createClaudeAgentSdkRuntime(spy);
    await rt.runJob(job({ toolPolicy: readOnlyPolicy, trustLevel: "untrusted", carriesRawContent: true }));
    expect(spy.calls).toHaveLength(1);
    const inv = spy.calls[0]!;
    expect(inv.runtimeId).toBe("claude-agent-sdk");
    expect(inv.model).toBe("claude-opus-4");
    expect(inv.allowedTools).toEqual(["read.file", "gbrain.query"]);
    expect(inv.readOnly).toBe(true);
    expect(inv.untrusted).toBe(true);
    expect(inv.carriesRawContent).toBe(true);
  });

  it("effective allow-list applies deniedTools precedence (deny wins)", () => {
    const built = buildClaudeAgentInvocation(
      job({
        toolPolicy: {
          mode: "read_only",
          allowedTools: ["read.file" as ToolId, "shell.exec" as ToolId],
          deniedTools: ["shell.exec" as ToolId],
          allowsMutating: false,
        },
      }),
    );
    expect(isOk(built)).toBe(true);
    if (isOk(built)) expect(built.value.allowedTools).toEqual(["read.file"]);
  });

  it("rejects a NON-runtime (provider-branch) route with invalid_job", () => {
    const providerRoute: ProviderRoute = {
      provider: "claude",
      model: "claude-opus-4",
      endpoint: "https://api.anthropic.com",
      egressClass: "cloud",
    };
    const built = buildClaudeAgentInvocation(job({ providerRoute }));
    expect(isErr(built)).toBe(true);
    if (isErr(built)) expect(built.error.kind).toBe("invalid_job");
  });
});

describe("ClaudeAgentSdkRuntimeAdapter — ING-7 tool-policy enforcement (defense in depth)", () => {
  it("rejects an untrusted job that is not read-only (scoped_write)", async () => {
    const spy = new SpyTransport(ok(okRaw));
    const rt = createClaudeAgentSdkRuntime(spy);
    const r = await rt.runJob(
      job({
        trustLevel: "untrusted",
        toolPolicy: {
          mode: "scoped_write",
          allowedTools: ["write.file" as ToolId],
          deniedTools: [],
          allowsMutating: true,
        },
      }),
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("tool_policy_violation");
    // Never dispatched — no side effect.
    expect(spy.calls).toHaveLength(0);
  });

  it("maps a runtime-reported mutating-tool attempt under read_only → tool_policy_violation", async () => {
    const spy = new SpyTransport(ok({ ...okRaw, mutatingToolAttempted: true }));
    const rt = createClaudeAgentSdkRuntime(spy);
    const r = await rt.runJob(job({ toolPolicy: readOnlyPolicy }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("tool_policy_violation");
  });
});

describe("ClaudeAgentSdkRuntimeAdapter — output normalization + cancel + redaction", () => {
  it("returns Ok(completed) carrying candidate output (never applied)", async () => {
    const rt = createClaudeAgentSdkRuntime(new SpyTransport(ok(okRaw)));
    const r = await rt.runJob(job({ toolPolicy: readOnlyPolicy }));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.status).toBe("completed");
      expect(r.value.candidateOutput).toEqual({ plan: "candidate" });
      expect(r.value.usage.costUsd).toBe(0.02);
    }
  });

  it("a transport-reported cancel yields a cancelled result with NO committable output", async () => {
    const spy = new SpyTransport(
      ok({ status: "cancelled", candidateOutput: { leaked: "partial" }, usage: { runtimeSeconds: 2 } }),
    );
    const rt = createClaudeAgentSdkRuntime(spy);
    const r = await rt.runJob(job({ toolPolicy: readOnlyPolicy }));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.status).toBe("cancelled");
      // Partial output is discarded (strict side-effect rule).
      expect(r.value.candidateOutput).toBeUndefined();
    }
  });

  it("an already-aborted signal yields Err(cancelled) and never calls the transport", async () => {
    const spy = new SpyTransport(ok(okRaw));
    const rt = createClaudeAgentSdkRuntime(spy);
    const ac = new AbortController();
    ac.abort();
    const r = await rt.runJob(job({ toolPolicy: readOnlyPolicy }), ac.signal);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("cancelled");
    expect(spy.calls).toHaveLength(0);
  });

  it("runs the §16 redactor over logs — a credential-shaped line is scrubbed", async () => {
    const spy = new SpyTransport(
      ok({
        status: "completed",
        candidateOutput: {},
        usage: { runtimeSeconds: 1 },
        logs: [{ level: "warn", message: "auth used sk-ABCDEF1234567890 for call" }],
      }),
    );
    const rt = createClaudeAgentSdkRuntime(spy);
    const r = await rt.runJob(job({ toolPolicy: readOnlyPolicy }));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const msg = r.value.logs[0]!.message;
      expect(msg).not.toContain("sk-ABCDEF1234567890");
      expect(msg).toContain("[REDACTED]");
    }
  });
});

describe("ClaudeAgentSdkRuntimeAdapter — transport error → RuntimeError mapping (never throws)", () => {
  const cases: ReadonlyArray<[ClaudeAgentTransportErrorKind, RuntimeErrorKind]> = [
    ["auth", "auth_unavailable"],
    ["unavailable", "runtime_unavailable"],
    ["transport", "transport_error"],
    ["timeout", "timeout"],
    ["cancelled", "cancelled"],
    ["malformed", "malformed_output"],
    ["tool_violation", "tool_policy_violation"],
  ];
  it.each(cases)("maps transport %s → runtime %s", async (tKind, rKind) => {
    const spy = new SpyTransport(err({ kind: tKind, message: "boom" }));
    const rt = createClaudeAgentSdkRuntime(spy);
    const r = await rt.runJob(job({ toolPolicy: readOnlyPolicy }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe(rKind);
  });
});
