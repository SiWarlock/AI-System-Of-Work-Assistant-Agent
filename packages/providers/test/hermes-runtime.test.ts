// spec(§7) — HermesRuntimeAdapter (5.8): one-shot CLI subprocess shape, the BANKED
// empty-toolset security invariant (LESSONS §1), ING-7 --safe-mode isolation,
// result→AgentResult mapping, cancel-with-no-side-effect, and log redaction — all
// against a MOCK subprocess transport (no real hermes spawn).
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { Result, AgentJob, ToolPolicy, ProviderRoute, ToolId } from "@sow/contracts";
import { validAgentJob } from "@sow/contracts";
import {
  createHermesRuntime,
  buildHermesCommand,
  HERMES_RUNTIME_ID,
  HERMES_SIGTERM_EXIT_CODE,
  type HermesTransport,
  type HermesCommand,
  type HermesProcessResult,
  type HermesSpawnError,
} from "../src/runtime/hermes-runtime";

const hermesRoute: ProviderRoute = {
  runtime: HERMES_RUNTIME_ID,
  model: "deepseek/deepseek-v4-pro",
  endpoint: "https://openrouter.ai/api",
  egressClass: "cloud",
};

const readOnlyPolicy: ToolPolicy = {
  mode: "read_only",
  allowedTools: ["clarify" as ToolId],
  deniedTools: [],
  allowsMutating: false,
};

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return { ...validAgentJob, providerRoute: hermesRoute, toolPolicy: readOnlyPolicy, ...overrides };
}

/** A mock subprocess transport recording the command it was asked to spawn. */
class SpyTransport implements HermesTransport {
  public calls: HermesCommand[] = [];
  constructor(private readonly outcome: Result<HermesProcessResult, HermesSpawnError>) {}
  async spawn(
    cmd: HermesCommand,
    signal?: AbortSignal,
  ): Promise<Result<HermesProcessResult, HermesSpawnError>> {
    this.calls.push(cmd);
    if (signal?.aborted) return err({ kind: "killed", message: "aborted" });
    return this.outcome;
  }
}

const goodProc: HermesProcessResult = {
  exitCode: 0,
  stdout: '{"meeting_title":"X","decisions":[],"action_items":[]}',
  stderr: "session_id=abc",
  runtimeSeconds: 9,
};

/** helper: index of a flag's value in an argv array. */
function argAfter(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("HermesRuntimeAdapter — command build (one-shot CLI shape)", () => {
  it("builds `hermes chat -q <prompt> -Q -t <toolset> -m <model> --max-turns N --source tool`", () => {
    const built = buildHermesCommand(job(), { provider: "openrouter" });
    expect(isOk(built)).toBe(true);
    if (!isOk(built)) return;
    const { bin, args } = built.value;
    expect(bin).toBe("hermes");
    expect(args[0]).toBe("chat");
    expect(args).toContain("-q");
    expect(args).toContain("-Q");
    expect(argAfter(args, "-t")).toBe("clarify");
    expect(argAfter(args, "-m")).toBe("deepseek/deepseek-v4-pro");
    expect(argAfter(args, "--provider")).toBe("openrouter");
    expect(argAfter(args, "--max-turns")).toBe("1");
    expect(argAfter(args, "--source")).toBe("tool");
  });

  it("multi-tool policy → comma-joined -t, deniedTools applied (deny wins)", () => {
    const built = buildHermesCommand(
      job({
        toolPolicy: {
          mode: "read_only",
          allowedTools: ["clarify" as ToolId, "gbrain.query" as ToolId, "shell.exec" as ToolId],
          deniedTools: ["shell.exec" as ToolId],
          allowsMutating: false,
        },
      }),
    );
    expect(isOk(built)).toBe(true);
    if (isOk(built)) expect(argAfter(built.value.args, "-t")).toBe("clarify,gbrain.query");
  });

  it("a TRUSTED job does NOT get --safe-mode", () => {
    const built = buildHermesCommand(job({ trustLevel: "trusted", carriesRawContent: false }));
    expect(isOk(built)).toBe(true);
    if (isOk(built)) expect(built.value.args).not.toContain("--safe-mode");
  });

  it("an UNTRUSTED (ING-7) job gets --safe-mode (injection isolation)", () => {
    const built = buildHermesCommand(job({ trustLevel: "untrusted" }));
    expect(isOk(built)).toBe(true);
    if (isOk(built)) expect(built.value.args).toContain("--safe-mode");
  });

  it("a raw-content job gets --safe-mode even when trusted", () => {
    const built = buildHermesCommand(job({ trustLevel: "trusted", carriesRawContent: true }));
    expect(isOk(built)).toBe(true);
    if (isOk(built)) expect(built.value.args).toContain("--safe-mode");
  });

  it("the default prompt renderer inlines NO raw content — only references", () => {
    const built = buildHermesCommand(job({ contextRefs: [{ refKind: "source", ref: "src:99" }] }));
    expect(isOk(built)).toBe(true);
    if (isOk(built)) {
      const prompt = argAfter(built.value.args, "-q")!;
      expect(prompt).toContain("source:src:99");
    }
  });

  it("rejects a NON-runtime (provider-branch) route with invalid_job", () => {
    const providerRoute: ProviderRoute = {
      provider: "openrouter",
      model: "x",
      endpoint: "https://openrouter.ai/api",
      egressClass: "cloud",
    };
    const built = buildHermesCommand(job({ providerRoute }));
    expect(isErr(built)).toBe(true);
    if (isErr(built)) expect(built.error.kind).toBe("invalid_job");
  });
});

describe("HermesRuntimeAdapter — BANKED security invariant: empty -t ⇒ full mutating fallback (LESSONS §1)", () => {
  it("an EMPTY effective toolset is REFUSED (tool_policy_violation) — never builds a command", () => {
    const built = buildHermesCommand(
      job({ toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false } }),
    );
    expect(isErr(built)).toBe(true);
    if (isErr(built)) {
      expect(built.error.kind).toBe("tool_policy_violation");
      expect(built.error.message).toMatch(/empty/i);
    }
  });

  it("a toolset emptied by deniedTools is ALSO refused (deny leaves nothing)", () => {
    const built = buildHermesCommand(
      job({
        toolPolicy: {
          mode: "read_only",
          allowedTools: ["clarify" as ToolId],
          deniedTools: ["clarify" as ToolId],
          allowsMutating: false,
        },
      }),
    );
    expect(isErr(built)).toBe(true);
    if (isErr(built)) expect(built.error.kind).toBe("tool_policy_violation");
  });

  it("runJob with an empty toolset NEVER spawns the subprocess (no empty -t reaches hermes)", async () => {
    const spy = new SpyTransport(ok(goodProc));
    const rt = createHermesRuntime(spy);
    const r = await rt.runJob(
      job({ toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false } }),
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("tool_policy_violation");
    expect(spy.calls).toHaveLength(0);
  });

  it("no built command ever carries an empty `-t` value", () => {
    const built = buildHermesCommand(job());
    expect(isOk(built)).toBe(true);
    if (isOk(built)) {
      const t = argAfter(built.value.args, "-t");
      expect(t).toBeDefined();
      expect(t!.length).toBeGreaterThan(0);
    }
  });

  it("rejects an untrusted job whose policy admits mutation (ING-7)", () => {
    const built = buildHermesCommand(
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
    expect(isErr(built)).toBe(true);
    if (isErr(built)) expect(built.error.kind).toBe("tool_policy_violation");
  });
});

describe("HermesRuntimeAdapter — result → AgentResult mapping", () => {
  it("exit 0 + JSON stdout → Ok(completed) with parsed candidate output", async () => {
    const rt = createHermesRuntime(new SpyTransport(ok(goodProc)));
    const r = await rt.runJob(job());
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.status).toBe("completed");
      expect(r.value.candidateOutput).toEqual({ meeting_title: "X", decisions: [], action_items: [] });
      expect(r.value.usage.runtimeSeconds).toBe(9);
    }
  });

  it("SIGTERM (exit 124) → Ok(cancelled) with NO committable output (COST-1)", async () => {
    const rt = createHermesRuntime(
      new SpyTransport(ok({ exitCode: HERMES_SIGTERM_EXIT_CODE, stdout: "", stderr: "", runtimeSeconds: 4 })),
    );
    const r = await rt.runJob(job());
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.status).toBe("cancelled");
      expect(r.value.candidateOutput).toBeUndefined();
    }
  });

  it("a non-zero, non-124 exit → Err(transport_error)", async () => {
    const rt = createHermesRuntime(new SpyTransport(ok({ exitCode: 2, stdout: "", stderr: "boom", runtimeSeconds: 1 })));
    const r = await rt.runJob(job());
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("transport_error");
  });

  it("exit 0 but non-JSON stdout → Err(malformed_output)", async () => {
    const rt = createHermesRuntime(new SpyTransport(ok({ exitCode: 0, stdout: "not json", stderr: "", runtimeSeconds: 1 })));
    const r = await rt.runJob(job());
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("malformed_output");
  });

  it("exit 0 but empty stdout → Err(malformed_output)", async () => {
    const rt = createHermesRuntime(new SpyTransport(ok({ exitCode: 0, stdout: "   ", stderr: "", runtimeSeconds: 1 })));
    const r = await rt.runJob(job());
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("malformed_output");
  });

  it("raw stderr (session id / content) never lands in the emitted logs", async () => {
    const rt = createHermesRuntime(
      new SpyTransport(ok({ ...goodProc, stderr: "session_id=abc secret sk-DEADBEEF12345678" })),
    );
    const r = await rt.runJob(job());
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const joined = r.value.logs.map((l) => l.message).join(" ");
      expect(joined).not.toContain("sk-DEADBEEF12345678");
      expect(joined).not.toContain("session_id=abc");
    }
  });
});

describe("HermesRuntimeAdapter — cancel + spawn-error mapping (never throws)", () => {
  it("an already-aborted signal yields Err(cancelled) and never spawns", async () => {
    const spy = new SpyTransport(ok(goodProc));
    const rt = createHermesRuntime(spy);
    const ac = new AbortController();
    ac.abort();
    const r = await rt.runJob(job(), ac.signal);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("cancelled");
    expect(spy.calls).toHaveLength(0);
  });

  it("transport not_installed → Err(runtime_unavailable) (spawn-if-present; matrix re-routes)", async () => {
    const rt = createHermesRuntime(new SpyTransport(err({ kind: "not_installed", message: "hermes not found" })));
    const r = await rt.runJob(job());
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("runtime_unavailable");
      expect(r.error.retryable).toBe(true);
    }
  });

  it("transport killed → Err(cancelled); spawn_failed → transport_error; timeout → timeout", async () => {
    const killed = createHermesRuntime(new SpyTransport(err({ kind: "killed", message: "sigterm" })));
    const failed = createHermesRuntime(new SpyTransport(err({ kind: "spawn_failed", message: "eacces" })));
    const timedOut = createHermesRuntime(new SpyTransport(err({ kind: "timeout", message: "deadline" })));
    const rk = await killed.runJob(job());
    const rf = await failed.runJob(job());
    const rt = await timedOut.runJob(job());
    if (isErr(rk)) expect(rk.error.kind).toBe("cancelled");
    if (isErr(rf)) expect(rf.error.kind).toBe("transport_error");
    if (isErr(rt)) expect(rt.error.kind).toBe("timeout");
    expect(isErr(rk) && isErr(rf) && isErr(rt)).toBe(true);
  });
});
