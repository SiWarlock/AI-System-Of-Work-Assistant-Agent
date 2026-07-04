// spec(§7 · §20.2 · REQ-I-001/002) — task 12.5.
//
// The §20.1/§20.2 acceptance suite for the provider/runtime conformance RELEASE
// GATE. Unlike the packages/evals unit tests (which pin each conformance runner in
// isolation), this drives the WHOLE gate over the PINNED model set: it runs the
// real `runProviderConformance` / `runRuntimeConformance` per pinned pair through
// the fixture schema gate, then folds the results through the real
// `matrixEligibility` / `releaseBlockingFailures` / `meetingCloseDoD` — the §7
// "conformance is the contract" chain — and finally scores PROVIDER_CONFORMANCE +
// RUNTIME_CONFORMANCE through the EVAL-1 runner (task 12.1).
//
// DoD honesty: this run is over the FIXTURE conformance gate with mock ports/
// runtimes — NOT a real conformant provider — so §20.2 forbids reporting it
// DoD-passing. The suite asserts exactly that: functionally-passing but NOT
// DoD-certified. Real-provider certification lands with the key-gated
// SOW_PROVIDER_CONFORMANCE / SOW_RUNTIME_CONFORMANCE eval runs.
//
// Acceptance criteria exercised (§20.1/§20.2 · task 12.5 bullets):
//  (a) conformance runs per (enabled provider × capability × pinned-model) pair;
//      a FAILING pair is disabled/ineligible in the matrix and (if cloud) flagged
//      release-blocking.
//  (b) OpenAI-compatible endpoints are NOT assumed identical — a structured-output
//      failure on ONE endpoint fails ONLY that pair.
//  (c) conformanceStatus is recorded per ProviderProfile (one status per pinned pair).
//  (d) the RELEASE GATE asserts ≥1 conformant subject for meeting.close; local
//      Ollama/LM Studio pairs are OPTIONAL — never the release gate.
import { describe, it, expect } from "vitest";
import { ok, validAgentJob } from "@sow/contracts";
import type { ConformanceResult, ConformanceStatus } from "@sow/contracts";
import type { ModelProviderPort, ProviderOutput } from "@sow/providers/ports/model-provider-port";
import type { AgentRuntimePort } from "@sow/providers/ports/agent-runtime-port";
import type { AgentResult } from "@sow/providers/ports/agent-result";
import {
  runProviderConformance,
  type ProviderConformanceCase,
} from "../../src/conformance/provider-conformance";
import {
  runRuntimeConformance,
  type RuntimeConformanceCase,
} from "../../src/conformance/runtime-conformance";
import {
  matrixEligibility,
  releaseBlockingFailures,
  meetingCloseDoD,
  hasEligibleFor,
} from "../../src/conformance/matrix-eligibility";
import {
  MEETING_CLOSE_OUTPUT_SCHEMA_ID,
  conformantMeetingCloseOutput,
  nonConformantMeetingCloseOutput,
  fixtureConformanceGate,
} from "../../fixtures/conformance/index";
import {
  PINNED_MODELS,
  pinnedProviderPairs,
  pinnedRuntimePairs,
  pinnedProviderRoute,
  type PinnedModel,
} from "../../src/conformance/pinned-models";
import { scoreById } from "../../src/harness/runner";
import { criterionById } from "../../src/harness/criteria-registry";

// ── deterministic clock (no Date.now / Math.random) ─────────────────────────────
const NOW = "2026-06-30T12:00:00.000Z";
const now = (): string => NOW;

// ── mock ports that echo a fixture output (conformant | non-conformant) ─────────
function providerOutput(candidateOutput: unknown): ProviderOutput {
  return { status: "completed", candidateOutput, usage: { runtimeSeconds: 3 }, logs: [] };
}
function agentResult(candidateOutput: unknown): AgentResult {
  return { status: "completed", candidateOutput, usage: { runtimeSeconds: 5 }, logs: [] };
}

/** A ModelProviderPort whose subjectId is the pin's, emitting the chosen fixture output. */
function providerPortFor(pin: PinnedModel, conformant: boolean): ModelProviderPort {
  const out = conformant ? conformantMeetingCloseOutput : nonConformantMeetingCloseOutput;
  return {
    providerId: pin.subjectId,
    complete: () => Promise.resolve(ok(providerOutput(out))),
  } as unknown as ModelProviderPort;
}
function runtimePortFor(pin: PinnedModel, conformant: boolean): AgentRuntimePort {
  const out = conformant ? conformantMeetingCloseOutput : nonConformantMeetingCloseOutput;
  return {
    runtimeId: pin.subjectId,
    runJob: () => Promise.resolve(ok(agentResult(out))),
  } as unknown as AgentRuntimePort;
}

function providerCase(pin: PinnedModel): ProviderConformanceCase {
  return {
    capability: pin.capability,
    model: pin.model,
    route: pinnedProviderRoute(pin),
    outputSchemaId: MEETING_CLOSE_OUTPUT_SCHEMA_ID,
    inputRefs: [{ refKind: "source", ref: "src:granola:1" }],
    idempotencyKey: `idem-${pin.subjectId}`,
    maxRuntimeSeconds: 180,
  };
}
function runtimeCase(pin: PinnedModel): RuntimeConformanceCase {
  return {
    capability: pin.capability,
    model: pin.model,
    egressClass: pin.egressClass,
    outputSchemaId: MEETING_CLOSE_OUTPUT_SCHEMA_ID,
    job: validAgentJob,
  };
}

/**
 * Run conformance for the whole PINNED set (one mock port/runtime per pin), gated by
 * the fixture schema gate. `conformantWhen` decides which pins produce a conformant
 * output — the whole point of the release gate is that a subset can fail.
 */
async function runPinnedConformance(
  conformantWhen: (pin: PinnedModel) => boolean,
): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  for (const pin of pinnedProviderPairs()) {
    const [r] = await runProviderConformance(
      providerPortFor(pin, conformantWhen(pin)),
      [providerCase(pin)],
      now,
      fixtureConformanceGate,
    );
    if (r) results.push(r);
  }
  for (const pin of pinnedRuntimePairs()) {
    const [r] = await runRuntimeConformance(
      runtimePortFor(pin, conformantWhen(pin)),
      [runtimeCase(pin)],
      now,
      fixtureConformanceGate,
    );
    if (r) results.push(r);
  }
  return results;
}

const bySubject = (results: readonly ConformanceResult[], id: string): ConformanceResult | undefined =>
  results.find((r) => r.subjectId === id);

// ── (a) conformance runs per pair; a failing pair is disabled + release-blocking ──
describe("§20.2 release gate — conformance runs per pinned pair", () => {
  it("produces exactly one ConformanceResult per pinned (subject × capability × model) pair", async () => {
    const results = await runPinnedConformance(() => true);
    expect(results).toHaveLength(PINNED_MODELS.length);
    // every pinned subject is represented, tagged with the right layer + egress.
    for (const pin of PINNED_MODELS) {
      const r = bySubject(results, pin.subjectId);
      expect(r).toBeDefined();
      expect(r?.subjectKind).toBe(pin.subjectKind);
      expect(r?.capability).toBe(pin.capability);
      expect(r?.egressClass).toBe(pin.egressClass);
    }
  });

  it("a FAILING pinned pair is DISABLED + ineligible in the matrix, and (cloud) release-blocking", async () => {
    // OpenRouter emits a non-conformant structured output; everyone else conforms.
    const results = await runPinnedConformance((p) => p.subjectId !== "openrouter");

    const views = matrixEligibility(results);
    const openrouterView = views.find((v) => v.subjectId === "openrouter");
    const claudeView = views.find((v) => v.subjectId === "claude");
    expect(openrouterView).toMatchObject({ eligible: false, effectiveStatus: "disabled" });
    expect(claudeView).toMatchObject({ eligible: true, effectiveStatus: "passing" });

    // the failing CLOUD pair is release-blocking; only it.
    const blocking = releaseBlockingFailures(results);
    expect(blocking.map((b) => b.subjectId)).toEqual(["openrouter"]);
  });
});

// ── (b) OpenAI-compatible endpoints are NOT assumed identical ───────────────────
describe("§7 release gate — OpenAI-compatible endpoints are not assumed identical", () => {
  it("a structured-output failure on ONE endpoint fails ONLY that pair", async () => {
    // OpenRouter and OpenAI are both OpenAI-compatible CLOUD pins. Fail OpenAI only.
    const results = await runPinnedConformance((p) => p.subjectId !== "openai");

    expect(bySubject(results, "openai")?.status).toBe("failing");
    expect(bySubject(results, "openrouter")?.status).toBe("passing");

    // matrix: the sibling OpenAI-compatible endpoint stays eligible — no contagion.
    const views = matrixEligibility(results);
    expect(views.find((v) => v.subjectId === "openai")).toMatchObject({ eligible: false });
    expect(views.find((v) => v.subjectId === "openrouter")).toMatchObject({ eligible: true });

    // exactly one release-blocker; the failure did not spread to the other endpoint.
    const blocking = releaseBlockingFailures(results);
    expect(blocking.map((b) => b.subjectId)).toEqual(["openai"]);
  });
});

// ── (c) conformanceStatus recorded per ProviderProfile (one status per pinned pair) ──
describe("§7 release gate — conformanceStatus recorded per ProviderProfile", () => {
  it("projects one status per pinned pair (passing/failing), keyed by subject", async () => {
    const results = await runPinnedConformance((p) => p.subjectId !== "openai");

    // A ProviderProfile-shaped projection: ConformanceResult.status maps directly
    // onto ProviderProfile.conformanceStatus (per the conformance-result contract).
    const profiles: Record<string, ConformanceStatus> = Object.fromEntries(
      results.map((r) => [r.subjectId, r.status]),
    );

    expect(profiles["claude"]).toBe("passing");
    expect(profiles["openrouter"]).toBe("passing");
    expect(profiles["openai"]).toBe("failing");
    expect(profiles["ollama"]).toBe("passing");
    expect(profiles["claude-agent-sdk"]).toBe("passing");

    // a status is recorded for EVERY pinned pair — no pair is left un-assessed.
    expect(Object.keys(profiles).sort()).toEqual(
      PINNED_MODELS.map((p) => p.subjectId).sort(),
    );
  });
});

// ── (d) the RELEASE GATE: ≥1 conformant meeting.close subject; local pairs optional ──
describe("§20.2 release gate — ≥1 conformant meeting.close subject; local pairs optional", () => {
  it("PASSES the gate when a conformant CLOUD subject exists for meeting.close", async () => {
    const results = await runPinnedConformance(() => true);
    expect(hasEligibleFor(results, "meeting.close")).toBe(true);
    const dod = meetingCloseDoD({
      results,
      workspaceType: "personal_business",
      employerRawEgressAcknowledged: false,
    });
    expect(dod).toEqual({ certifiable: true, reason: "ok" });
  });

  it("a LOCAL (Ollama) conformance failure is NOT release-blocking and does NOT fail the gate", async () => {
    // Fail ONLY the optional local pin; every cloud subject still conforms.
    const results = await runPinnedConformance((p) => p.subjectId !== "ollama");

    expect(bySubject(results, "ollama")?.status).toBe("failing");
    // the local failure is excluded from release-blockers (optional zero-egress path).
    expect(releaseBlockingFailures(results)).toHaveLength(0);
    // and the gate still certifies off the conformant cloud subjects.
    const dod = meetingCloseDoD({
      results,
      workspaceType: "personal_business",
      employerRawEgressAcknowledged: false,
    });
    expect(dod.certifiable).toBe(true);
  });

  it("a LOCAL conformant pair ALONE never carries the gate — cloud failures still block", async () => {
    // Only the optional local Ollama conforms; every CLOUD subject fails.
    const results = await runPinnedConformance((p) => p.egressClass === "local");

    // the gate is technically satisfiable (a conformant subject exists), but the
    // release is BLOCKED by the failing cloud subjects — the local pair is a bonus,
    // never a substitute for the required cloud path.
    const blocking = releaseBlockingFailures(results);
    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking.every((b) => b.egressClass === "cloud")).toBe(true);
  });

  it("BLOCKS the gate when ZERO subjects conform for meeting.close", async () => {
    const results = await runPinnedConformance(() => false);
    expect(hasEligibleFor(results, "meeting.close")).toBe(false);
    const dod = meetingCloseDoD({
      results,
      workspaceType: "personal_business",
      employerRawEgressAcknowledged: false,
    });
    expect(dod).toEqual({
      certifiable: false,
      reason: "no_conformant_meeting_close_subject",
    });
    // every cloud pair is release-blocking; local excluded.
    const blocking = releaseBlockingFailures(results);
    expect(blocking.every((b) => b.egressClass === "cloud")).toBe(true);
    expect(blocking.some((b) => b.subjectId === "ollama")).toBe(false);
  });
});

// ── EVAL-1 runner scoring — DoD honesty (§20.2) ─────────────────────────────────
describe("§20.2 release gate — EVAL-1 runner scoring (DoD honesty)", () => {
  it("marks PROVIDER_CONFORMANCE functionally-passing but NOT DoD-certified (fixture gate)", () => {
    // The whole gate holds over the pinned set ⇒ functional pass. But this ran over
    // the FIXTURE schema gate with mock ports — not a real conformant provider — so
    // §20.2 forbids reporting it DoD-passing. The runner enforces it.
    const out = scoreById({
      criterionId: "PROVIDER_CONFORMANCE",
      value: true,
      fromRealIntegration: false,
    });
    expect(out.functionalPass).toBe(true);
    expect(out.dodValid).toBe(false);
    expect(out.dodPass).toBe(false);
    expect(out.reason).toContain("DoD-INVALID");
  });

  it("marks RUNTIME_CONFORMANCE functionally-passing but NOT DoD-certified (fixture gate)", () => {
    const out = scoreById({
      criterionId: "RUNTIME_CONFORMANCE",
      value: true,
      fromRealIntegration: false,
    });
    expect(out.functionalPass).toBe(true);
    expect(out.dodValid).toBe(false);
    expect(out.dodPass).toBe(false);
    expect(out.reason).toContain("DoD-INVALID");
  });

  it("BOTH criteria would be DoD-certified from a real conformant-integration run", () => {
    for (const id of ["PROVIDER_CONFORMANCE", "RUNTIME_CONFORMANCE"] as const) {
      const out = scoreById({ criterionId: id, value: true, fromRealIntegration: true });
      expect(out.dodPass).toBe(true);
    }
  });

  it("registry marks both conformance criteria real-integration-required", () => {
    expect(criterionById("PROVIDER_CONFORMANCE")?.requiresRealIntegration).toBe(true);
    expect(criterionById("RUNTIME_CONFORMANCE")?.requiresRealIntegration).toBe(true);
  });
});
