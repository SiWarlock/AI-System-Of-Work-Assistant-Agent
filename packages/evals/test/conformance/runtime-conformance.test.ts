// spec(§7) — runtime-adapter conformance runner (task 5.10). MOCK AgentRuntimePort
// (no real SDK/subprocess): a conformant AgentResult ⇒ passing; non-conformant ⇒
// failing; a typed runtime Err ⇒ failing; a cancel ⇒ failing. Drives the real
// `validAgentJob` fixture through the port (REQ-I-002/003). Never throws (§16).
import { describe, expect, it } from "vitest";
import { ok, err, validAgentJob } from "@sow/contracts";
import type { Result, Capability } from "@sow/contracts";
import {
  runtimeError,
  type AgentRuntimePort,
  type RuntimeError,
} from "@sow/providers/ports/agent-runtime-port";
import type { AgentResult } from "@sow/providers/ports/agent-result";
import {
  runRuntimeConformance,
  runRuntimeConformanceIfKeyed,
  type RuntimeConformanceCase,
} from "../../src/conformance/runtime-conformance";
import {
  MEETING_CLOSE_OUTPUT_SCHEMA_ID,
  conformantMeetingCloseOutput,
  nonConformantMeetingCloseOutput,
  fixtureConformanceGate,
} from "../../fixtures/conformance/index";

const NOW = "2026-06-30T12:00:00.000Z";
const now = (): string => NOW;

const runtimeCase: RuntimeConformanceCase = {
  capability: "meeting.close" as Capability,
  model: "claude-opus-4",
  egressClass: "cloud",
  outputSchemaId: MEETING_CLOSE_OUTPUT_SCHEMA_ID,
  job: validAgentJob,
};

function runtimeReturning(res: Result<AgentResult, RuntimeError>): AgentRuntimePort {
  return {
    runtimeId: "claude-agent-sdk",
    runJob: () => Promise.resolve(res),
  };
}

function completed(candidateOutput: unknown): Result<AgentResult, RuntimeError> {
  return ok({ status: "completed", candidateOutput, usage: { runtimeSeconds: 5 }, logs: [] });
}

describe("runRuntimeConformance — spec(§7)", () => {
  it("marks a conformant runtime result PASSING (subjectKind runtime)", async () => {
    const [r] = await runRuntimeConformance(
      runtimeReturning(completed(conformantMeetingCloseOutput)),
      [runtimeCase],
      now,
      fixtureConformanceGate,
    );
    expect(r?.status).toBe("passing");
    expect(r?.subjectKind).toBe("runtime");
    expect(r?.subjectId).toBe("claude-agent-sdk");
    expect(r?.capability).toBe("meeting.close");
  });

  it("marks a non-conformant runtime result FAILING", async () => {
    const [r] = await runRuntimeConformance(
      runtimeReturning(completed(nonConformantMeetingCloseOutput)),
      [runtimeCase],
      now,
      fixtureConformanceGate,
    );
    expect(r?.status).toBe("failing");
    expect(r?.detail).toMatch(/^schema_violation:/);
  });

  it("maps a typed runtime Err to FAILING (e.g. tool_policy_violation)", async () => {
    const [r] = await runRuntimeConformance(
      runtimeReturning(err(runtimeError("tool_policy_violation", "mutating tool on read_only job"))),
      [runtimeCase],
      now,
      fixtureConformanceGate,
    );
    expect(r?.status).toBe("failing");
    expect(r?.detail).toBe("runtime_error:tool_policy_violation");
  });

  it("maps a cancel to FAILING (no committable output)", async () => {
    const cancelled: Result<AgentResult, RuntimeError> = ok({
      status: "cancelled",
      candidateOutput: conformantMeetingCloseOutput,
      usage: { runtimeSeconds: 2 },
      logs: [],
    });
    const [r] = await runRuntimeConformance(runtimeReturning(cancelled), [runtimeCase], now, fixtureConformanceGate);
    expect(r?.status).toBe("failing");
    expect(r?.detail).toBe("cancelled");
  });

  it("skips real runs by default (key-gated eval path)", async () => {
    const skipped = await runRuntimeConformanceIfKeyed(
      runtimeReturning(completed(conformantMeetingCloseOutput)),
      [runtimeCase],
      now,
      fixtureConformanceGate,
      {},
    );
    expect(skipped).toBeUndefined();
  });
});
