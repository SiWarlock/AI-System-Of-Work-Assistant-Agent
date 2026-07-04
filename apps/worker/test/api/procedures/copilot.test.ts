// §9.6 A2/A3 — Copilot retrieval (WS-8 fail-closed) + governed synthesis (egress veto + stub).
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, failure } from "@sow/contracts";
import type { AgentJob, DataOwner, EgressPolicy, ProviderRoute, WorkspaceType } from "@sow/contracts";
import { processorId } from "@sow/contracts";
import {
  createFixtureRetrieval,
  enforceRetrievalScope,
  guardCopilotEgress,
  createStubSynthesis,
  toUiSafeCopilotAnswer,
  answerCopilotQuestion,
  type RetrievedContext,
  type CandidateCopilotAnswer,
  type CopilotDeps,
  type CopilotSynthesisPort,
} from "../../../src/api/procedures/copilot";

const WS = "ws-employer";
const OTHER = "ws-personal";

function ctx(workspaceId: string): RetrievedContext {
  return {
    workspaceId,
    blocks: ["A decision was logged on the vendor review."],
    sources: [{ citationId: "src:note-1", title: "Vendor review — decisions" }],
  };
}

describe("Copilot fixture retrieval — workspace-scoped, fail-closed (WS-8)", () => {
  it("returns candidate context scoped to a KNOWN workspace", async () => {
    const retrieval = createFixtureRetrieval({ [WS]: ctx(WS) });
    const r = await retrieval.retrieve(WS, "what did we decide?");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.workspaceId).toBe(WS);
      expect(r.value.blocks.length).toBeGreaterThan(0);
      expect(r.value.sources[0]?.citationId).toBe("src:note-1");
    }
  });

  it("an UNKNOWN workspace fails CLOSED (typed err, never a throw — §16)", async () => {
    const retrieval = createFixtureRetrieval({ [WS]: ctx(WS) });
    const r = await retrieval.retrieve(OTHER, "anything");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("validation_rejected");
      // Codebase-wide cause code (matches readModel.ts / systemHealth), not a bespoke one.
      expect(r.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  it("NEVER returns a FOREIGN workspace's context even if the fixture is mis-keyed (WS-8)", async () => {
    // A fixture keyed under WS but carrying OTHER's scope must fail closed — never leak OTHER.
    const retrieval = createFixtureRetrieval({ [WS]: ctx(OTHER) });
    const r = await retrieval.retrieve(WS, "q");
    expect(isErr(r)).toBe(true);
  });

  it("a prototype-chain key ('__proto__') is 'unknown workspace', never an inherited object", async () => {
    const retrieval = createFixtureRetrieval({ [WS]: ctx(WS) });
    const r = await retrieval.retrieve("__proto__", "q");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });
});

describe("enforceRetrievalScope — cross-workspace guard (defense-in-depth WS-8)", () => {
  it("passes a context whose workspaceId matches the requested scope", () => {
    const r = enforceRetrievalScope(WS, ctx(WS));
    expect(isOk(r)).toBe(true);
  });

  it("REJECTS a context whose workspaceId differs from the requested scope", () => {
    const r = enforceRetrievalScope(WS, ctx(OTHER));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("RETRIEVAL_SCOPE_MISMATCH");
  });

  it("REJECTS an empty requested scope (never treat '' as a workspace)", () => {
    const r = enforceRetrievalScope("", ctx(""));
    expect(isErr(r)).toBe(true);
  });

  it("fails CLOSED (typed err, no throw) on a null / non-object context from a malicious adapter", () => {
    const r = enforceRetrievalScope(WS, null as unknown as RetrievedContext);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("RETRIEVAL_SCOPE_MISMATCH");
  });
});

// ── A3: governed synthesis — the Employer-Work egress veto + the interim stub ─────────────
const cloudRoute: ProviderRoute = {
  provider: "claude",
  model: "claude-opus-4",
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
};
const localRoute: ProviderRoute = {
  provider: "ollama",
  model: "llama3.1",
  endpoint: "http://127.0.0.1:11434",
  egressClass: "local",
};
const tunneledLocalRoute: ProviderRoute = {
  // egressClass claims 'local' but the endpoint is remote — the exfil hole the veto must catch.
  provider: "ollama",
  model: "llama3.1",
  endpoint: "https://exfil.example.com:11434",
  egressClass: "local",
};

const copilotJob = (over: Partial<AgentJob> = {}): AgentJob => ({
  id: "job-copilot-001" as AgentJob["id"],
  workflowRunId: "wf-copilot-001" as AgentJob["workflowRunId"],
  workspaceId: "ws-001" as AgentJob["workspaceId"],
  capability: "meeting.close" as AgentJob["capability"],
  contextRefs: [{ refKind: "source", ref: "src:1" }],
  outputSchemaId: "sow:knowledge-mutation-plan",
  toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
  providerRoute: cloudRoute,
  trustLevel: "trusted",
  carriesRawContent: true,
  maxRuntimeSeconds: 300,
  idempotencyKey: "idem-copilot-001",
  ...over,
});

const egressPolicy = (over: Partial<EgressPolicy> = {}): EgressPolicy => ({
  workspaceId: "ws-001" as EgressPolicy["workspaceId"],
  allowedProcessors: [processorId("claude")],
  rawContentAllowedProcessors: [processorId("claude")],
  employerRawEgressAcknowledged: false,
  ...over,
});

const employerWs: { type: WorkspaceType; dataOwner: DataOwner } = { type: "employer_work", dataOwner: "employer" };
const personalWs: { type: WorkspaceType; dataOwner: DataOwner } = { type: "personal_business", dataOwner: "user" };

describe("guardCopilotEgress — Employer-Work raw-egress veto (safety rule 5, reuses egressVeto)", () => {
  it("DENIES a CLOUD route for employer-work raw content with egress-ack OFF (fail closed, no cloud fallback)", () => {
    const r = guardCopilotEgress({
      job: copilotJob(),
      route: cloudRoute,
      egress: egressPolicy({ employerRawEgressAcknowledged: false }),
      workspace: employerWs,
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });

  it("ALLOWS a genuine loopback-LOCAL route for employer-work raw content with ack OFF", () => {
    const r = guardCopilotEgress({
      job: copilotJob(),
      route: localRoute,
      egress: egressPolicy({ employerRawEgressAcknowledged: false }),
      workspace: employerWs,
    });
    expect(isOk(r)).toBe(true);
    // The permitted route is the SAME one handed in — the veto narrows/denies, never substitutes.
    if (isOk(r)) expect(r.value).toEqual(localRoute);
  });

  it("DENIES a TUNNELED-'local' route (remote endpoint) for employer raw + ack OFF — the exfil hole", () => {
    const r = guardCopilotEgress({
      job: copilotJob(),
      route: tunneledLocalRoute,
      egress: egressPolicy({ employerRawEgressAcknowledged: false }),
      workspace: employerWs,
    });
    expect(isErr(r)).toBe(true);
    // The most safety-critical case — pin WHICH denial fired (the raw-egress veto, not the allowlist).
    if (isErr(r)) expect(r.error.cause?.code).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });

  it("ALLOWS a cloud route once egress-ack is ON (allowlisted processor)", () => {
    const r = guardCopilotEgress({
      job: copilotJob(),
      route: cloudRoute,
      egress: egressPolicy({ employerRawEgressAcknowledged: true }),
      workspace: employerWs,
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toEqual(cloudRoute);
  });

  it("ALLOWS a personal-workspace cloud route (allowlisted; no employer veto)", () => {
    const r = guardCopilotEgress({
      job: copilotJob({ workspaceId: "ws-personal" as AgentJob["workspaceId"] }),
      route: cloudRoute,
      egress: egressPolicy({ workspaceId: "ws-personal" as EgressPolicy["workspaceId"] }),
      workspace: personalWs,
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toEqual(cloudRoute);
  });

  it("FORCES carriesRawContent — a caller can't bypass the veto by declaring the job carries none", () => {
    // Even with carriesRawContent:false on the job, the guard treats Copilot as raw-content-bearing,
    // so an employer cloud route with ack OFF is STILL denied (no bypass).
    const r = guardCopilotEgress({
      job: copilotJob({ carriesRawContent: false }),
      route: cloudRoute,
      egress: egressPolicy({ employerRawEgressAcknowledged: false }),
      workspace: employerWs,
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });
});

describe("createStubSynthesis — honest interim, cites sources, NEVER echoes raw blocks (A1 redact-by-type)", () => {
  const RAW = "RAW_SECRET_BLOCK_should_never_surface";
  const withSources: RetrievedContext = {
    workspaceId: WS,
    blocks: [RAW],
    sources: [
      { citationId: "src:note-1", title: "Vendor review — decisions" },
      { citationId: "src:note-2", title: "Pricing memo" },
    ],
  };

  it("produces a cited candidate answer WITHOUT echoing any raw block verbatim", async () => {
    const synth = createStubSynthesis();
    const r = await synth.synthesize(WS, "what did we decide?", withSources);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.answer.length).toBeGreaterThan(0);
      // Cites the retrieved sources.
      expect(r.value.citations).toEqual(withSources.sources);
      // NEVER echoes a raw block into the answer (the A1 redact-by-type obligation).
      expect(r.value.answer.some((b) => b.includes(RAW))).toBe(false);
    }
  });

  it("returns a 'nothing found' candidate with NO citations when retrieval is empty", async () => {
    const synth = createStubSynthesis();
    const r = await synth.synthesize(WS, "obscure question", { workspaceId: WS, blocks: [], sources: [] });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.answer.length).toBeGreaterThan(0);
      expect(r.value.citations).toEqual([]);
    }
  });
});

// ── A4: the candidate-data gate (toUiSafeCopilotAnswer) + the ask orchestration ───────────
describe("toUiSafeCopilotAnswer — candidate-data + WS-8 leakage gate (A1)", () => {
  const goodCandidate: CandidateCopilotAnswer = {
    answer: ["Two decisions were logged.", "The SLA was adopted."],
    citations: [{ citationId: "src:note-1", title: "Vendor review — decisions" }],
  };

  it("accepts a well-formed candidate and returns a validated UiSafeCopilotAnswer", () => {
    const r = toUiSafeCopilotAnswer(goodCandidate);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.answer).toEqual(goodCandidate.answer);
      expect(r.value.citations[0]?.citationId).toBe("src:note-1");
    }
  });

  it("NORMALIZES a multi-line answer block to single-line (redact-by-type shape defense)", () => {
    const r = toUiSafeCopilotAnswer({ ...goodCandidate, answer: ["line one\nleaked second line"] });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.answer[0]).toBe("line one leaked second line"); // collapsed, single-line
  });

  it("REJECTS a candidate whose citationId is a path/URL (leak-shaped; fails the opaque-ref gate)", () => {
    const r = toUiSafeCopilotAnswer({
      ...goodCandidate,
      citations: [{ citationId: "/Users/x/secret.md", title: "x" }],
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("schema_rejected");
  });

  it("REJECTS a candidate with an EMPTY answer (never serve a contentless answer)", () => {
    const r = toUiSafeCopilotAnswer({ ...goodCandidate, answer: [] });
    expect(isErr(r)).toBe(true);
  });
});

describe("answerCopilotQuestion — the read-only ask orchestration (retrieve → scope → synth → gate)", () => {
  const deps = (ctx: RetrievedContext): CopilotDeps => ({
    retrieval: createFixtureRetrieval({ [WS]: ctx }),
    synthesis: createStubSynthesis(),
  });

  it("answers a KNOWN workspace with a validated, cited UiSafeCopilotAnswer", async () => {
    const r = await answerCopilotQuestion(deps(ctx(WS)), { workspaceId: WS, question: "what did we decide?" });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.answer.length).toBeGreaterThan(0);
      expect(r.value.citations[0]?.citationId).toBe("src:note-1");
    }
  });

  it("fails CLOSED for an UNKNOWN workspace (retrieval err short-circuits — never synthesizes)", async () => {
    const r = await answerCopilotQuestion(deps(ctx(WS)), { workspaceId: OTHER, question: "anything" });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("fails CLOSED when retrieval returns FOREIGN-scoped context (WS-8 defense-in-depth)", async () => {
    // A mis-keyed fixture: retrieve(WS) yields context scoped to OTHER → the scope guard rejects.
    const r = await answerCopilotQuestion(deps(ctx(OTHER)), { workspaceId: WS, question: "q" });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("RETRIEVAL_SCOPE_MISMATCH");
  });

  it("fails CLOSED when SYNTHESIS errors — the answer is never partially served", async () => {
    const failingSynth: CopilotSynthesisPort = {
      synthesize: () => err(failure("provider_failed", "synthesis unavailable", { cause: { code: "SYNTH_DOWN" } })),
    };
    const r = await answerCopilotQuestion(
      { retrieval: createFixtureRetrieval({ [WS]: ctx(WS) }), synthesis: failingSynth },
      { workspaceId: WS, question: "q" },
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("SYNTH_DOWN");
  });

  it("fails CLOSED when the synthesized candidate FAILS the UI-safe gate (rejected, not served)", async () => {
    // A synthesizer emitting a leak-shaped citationId → the candidate-data gate must reject it.
    const leakySynth: CopilotSynthesisPort = {
      synthesize: () => ok({ answer: ["x"], citations: [{ citationId: "https://leak.example/doc", title: "t" }] }),
    };
    const r = await answerCopilotQuestion(
      { retrieval: createFixtureRetrieval({ [WS]: ctx(WS) }), synthesis: leakySynth },
      { workspaceId: WS, question: "q" },
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("COPILOT_ANSWER_REJECTED");
  });
});
