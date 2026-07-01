// spec(§7) — provider conformance runner (task 5.10). MOCK ModelProviderPort (no
// real API): a conformant fixture output ⇒ passing; a non-conformant output ⇒
// failing; a typed provider Err ⇒ failing; a cooperative cancel ⇒ failing (no
// committable output, REQ-S-007). The runner never throws (§16).
import { describe, expect, it } from "vitest";
import { ok, err } from "@sow/contracts";
import type { Result, Capability, ProviderRoute } from "@sow/contracts";
import {
  providerError,
  type ModelProviderPort,
  type ProviderOutput,
  type ProviderError,
} from "@sow/providers/ports/model-provider-port";
import {
  runProviderConformance,
  runProviderConformanceIfKeyed,
  type ProviderConformanceCase,
} from "../../src/conformance/provider-conformance";
import {
  MEETING_CLOSE_OUTPUT_SCHEMA_ID,
  conformantMeetingCloseOutput,
  nonConformantMeetingCloseOutput,
  fixtureConformanceGate,
} from "../../fixtures/conformance/index";

const NOW = "2026-06-30T12:00:00.000Z";
const now = (): string => NOW;

const cloudRoute: ProviderRoute = {
  provider: "openrouter",
  model: "anthropic/claude-haiku-4.5",
  endpoint: "https://openrouter.ai/api/v1",
  egressClass: "cloud",
};

const meetingCloseCase: ProviderConformanceCase = {
  capability: "meeting.close" as Capability,
  model: "anthropic/claude-haiku-4.5",
  route: cloudRoute,
  outputSchemaId: MEETING_CLOSE_OUTPUT_SCHEMA_ID,
  inputRefs: [{ refKind: "source", ref: "src:granola:1" }],
  idempotencyKey: "idem-conf-1",
  maxRuntimeSeconds: 180,
};

function portReturning(res: Result<ProviderOutput, ProviderError>): ModelProviderPort {
  return {
    providerId: "openrouter",
    complete: () => Promise.resolve(res),
  };
}

function completed(candidateOutput: unknown): Result<ProviderOutput, ProviderError> {
  return ok({ status: "completed", candidateOutput, usage: { runtimeSeconds: 3 }, logs: [] });
}

describe("runProviderConformance — spec(§7)", () => {
  it("marks a conformant fixture output PASSING", async () => {
    const [r] = await runProviderConformance(
      portReturning(completed(conformantMeetingCloseOutput)),
      [meetingCloseCase],
      now,
      fixtureConformanceGate,
    );
    expect(r?.status).toBe("passing");
    expect(r?.subjectKind).toBe("provider");
    expect(r?.subjectId).toBe("openrouter");
    expect(r?.capability).toBe("meeting.close");
    expect(r?.egressClass).toBe("cloud");
    expect(r?.checkedAt).toBe(NOW);
    expect(r?.detail).toBeUndefined();
  });

  it("marks a non-conformant fixture output FAILING with a redaction-safe detail", async () => {
    const [r] = await runProviderConformance(
      portReturning(completed(nonConformantMeetingCloseOutput)),
      [meetingCloseCase],
      now,
      fixtureConformanceGate,
    );
    expect(r?.status).toBe("failing");
    expect(r?.detail).toMatch(/^schema_violation:/);
  });

  it("maps a typed provider Err to FAILING (never throws)", async () => {
    const [r] = await runProviderConformance(
      portReturning(err(providerError("model_unavailable", "pinned model absent"))),
      [meetingCloseCase],
      now,
      fixtureConformanceGate,
    );
    expect(r?.status).toBe("failing");
    expect(r?.detail).toBe("provider_error:model_unavailable");
  });

  it("maps a cooperative cancel to FAILING (no committable output, REQ-S-007)", async () => {
    const cancelled: Result<ProviderOutput, ProviderError> = ok({
      status: "cancelled",
      candidateOutput: conformantMeetingCloseOutput,
      usage: { runtimeSeconds: 1 },
      logs: [],
    });
    const [r] = await runProviderConformance(
      portReturning(cancelled),
      [meetingCloseCase],
      now,
      fixtureConformanceGate,
    );
    expect(r?.status).toBe("failing");
    expect(r?.detail).toBe("cancelled");
  });

  it("produces one result per case, in order", async () => {
    const results = await runProviderConformance(
      portReturning(completed(conformantMeetingCloseOutput)),
      [meetingCloseCase, meetingCloseCase],
      now,
      fixtureConformanceGate,
    );
    expect(results).toHaveLength(2);
  });

  it("skips real runs by default (key-gated eval path)", async () => {
    const skipped = await runProviderConformanceIfKeyed(
      portReturning(completed(conformantMeetingCloseOutput)),
      [meetingCloseCase],
      now,
      fixtureConformanceGate,
      {},
    );
    expect(skipped).toBeUndefined();

    const run = await runProviderConformanceIfKeyed(
      portReturning(completed(conformantMeetingCloseOutput)),
      [meetingCloseCase],
      now,
      fixtureConformanceGate,
      { SOW_PROVIDER_CONFORMANCE: "1" },
    );
    expect(run).toHaveLength(1);
    expect(run?.[0]?.status).toBe("passing");
  });
});
