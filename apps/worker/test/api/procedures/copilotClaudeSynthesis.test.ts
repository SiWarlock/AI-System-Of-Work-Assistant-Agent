// §9.6-real P2.3 — the REAL Copilot synthesis adapter (deterministic surface only).
//
// The adapter turns retrieved context into a CandidateCopilotAnswer by calling the Claude
// SUBSCRIPTION completion client (@sow/providers). The real `query()` I/O + the model's prose are
// EVAL-tested (P2.5); THIS pins the deterministic parts a bug would silently corrupt:
//   • prompt assembly (the model sees the question + citationId-tagged passages),
//   • output → candidate MAPPING with CITATION RECONCILIATION (grounding: only retrieved citationIds
//     survive, and the AUTHORITATIVE retrieved title wins over the model's echo), and
//   • error FOLDING that is redaction-safe by construction (no raw SDK message crosses into a
//     FailureVariant — only a stable cause code + a content-free message).
// The completion client is a FAKE — no SDK, no network.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, processorId } from "@sow/contracts";
import type { ProviderRoute, Result } from "@sow/contracts";
import type {
  ClaudeSubscriptionCompletion,
  CompletionRequest,
  CompletionOutput,
  CompletionError,
} from "@sow/providers";
import type { RetrievedContext } from "../../../src/api/procedures/copilot";
import { decideCopilotEgress, buildCopilotJob } from "../../../src/api/procedures/copilot";
import { deriveCopilotContentTrust } from "../../../src/api/procedures/copilotAgentSynthesis";
import { createInterimDegradedServingOracle } from "../../../src/api/procedures/copilotProvenanceStamp";
import type {
  CopilotServingOracle,
  CopilotServingVerdict,
} from "../../../src/api/procedures/copilotProvenanceStamp";
import {
  createClaudeCopilotSynthesis,
  buildCopilotUserPrompt,
  mapCompletionToCandidate,
  foldCompletionError,
  createClaudeCloudRouteSelector,
  cloudCopilotPosture,
  buildCopilotDeps,
  buildInterimCopilotScopeRegistry,
  copilotWorkspaceType,
  resolveCopilotWorkspaces,
  WELL_KNOWN_COPILOT_WORKSPACES,
  COPILOT_SYSTEM_PROMPT,
  COPILOT_OUTPUT_SCHEMA,
  DEFAULT_COPILOT_MAX_COST_USD,
  type CopilotWorkspace,
} from "../../../src/api/procedures/copilotClaudeSynthesis";
import { workspaceId } from "@sow/contracts";
import type { GbrainQueryExec } from "../../../src/api/procedures/copilotGbrainSubprocess";
import type { LegacyContentPolicy } from "@sow/policy";

/** Read `provider` off a ProviderRoute union without a cast (only the provider arm carries it). */
function providerOf(route: ProviderRoute): string | undefined {
  return "provider" in route ? route.provider : undefined;
}

const cloudRoute: ProviderRoute = {
  provider: "claude",
  model: "claude-opus-4",
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
};

// A genuine local route (provider "ollama") — this adapter must REFUSE it before any egress.
const localRoute: ProviderRoute = {
  provider: "ollama",
  model: "llama3.1",
  endpoint: "http://127.0.0.1:11434",
  egressClass: "local",
};

const ctx: RetrievedContext = {
  workspaceId: "ws-employer",
  blocks: ["A decision was logged on the vendor review.", "The SLA target is 99.9%."],
  sources: [
    { citationId: "src:note-1", title: "Vendor review — decisions" },
    { citationId: "src:note-2", title: "Pricing memo" },
  ],
};

type CompleteResult = Result<CompletionOutput, CompletionError>;

/** A fake completion client that records the requests it was handed and returns a canned result. */
function recordingClient(result: CompleteResult): {
  readonly client: ClaudeSubscriptionCompletion;
  readonly calls: CompletionRequest[];
} {
  const calls: CompletionRequest[] = [];
  const client: ClaudeSubscriptionCompletion = {
    complete: async (req: CompletionRequest): Promise<CompleteResult> => {
      calls.push(req);
      return result;
    },
  };
  return { client, calls };
}

/** A well-formed model output over `ctx`, both citationIds valid. */
const goodOutput = {
  answer: ["A vendor decision was logged.", "The SLA target is 99.9%."],
  citations: [
    { citationId: "src:note-1", title: "Vendor review — decisions" },
    { citationId: "src:note-2", title: "Pricing memo" },
  ],
};

describe("buildCopilotUserPrompt — question + citationId-tagged passages", () => {
  it("includes the question and tags every source with its citationId + title", () => {
    const prompt = buildCopilotUserPrompt("what did we decide?", ctx);
    expect(prompt).toContain("what did we decide?");
    expect(prompt).toContain("src:note-1");
    expect(prompt).toContain("Vendor review — decisions");
    expect(prompt).toContain("src:note-2");
  });

  it("includes each passage's block text (paired to its source by index)", () => {
    const prompt = buildCopilotUserPrompt("q", ctx);
    expect(prompt).toContain("A decision was logged on the vendor review.");
    expect(prompt).toContain("The SLA target is 99.9%.");
  });

  it("with EMPTY context: still carries the question, marks 'no context', tags no citationId", () => {
    const prompt = buildCopilotUserPrompt("obscure question", {
      workspaceId: "ws-employer",
      blocks: [],
      sources: [],
    });
    expect(prompt).toContain("obscure question");
    expect(prompt).not.toContain("src:note-1");
    expect(prompt.toLowerCase()).toContain("no context");
  });

  it("a source WITHOUT a paired block (sources.length > blocks.length) still tags it, marks no excerpt", () => {
    const prompt = buildCopilotUserPrompt("q", {
      workspaceId: "ws-employer",
      blocks: [], // no excerpts at all
      sources: [{ citationId: "src:note-1", title: "Vendor review — decisions" }],
    });
    expect(prompt).toContain("src:note-1"); // still citable
    expect(prompt.toLowerCase()).toContain("no excerpt available");
  });

  it("an EXTRA block with no paired source (blocks.length > sources.length) is OMITTED (grounding-first)", () => {
    const prompt = buildCopilotUserPrompt("q", {
      workspaceId: "ws-employer",
      blocks: ["cited excerpt", "UNCITABLE_ORPHAN_BLOCK"],
      sources: [{ citationId: "src:note-1", title: "Vendor review — decisions" }],
    });
    expect(prompt).toContain("cited excerpt");
    // A block with no citationId can't be cited, so it never reaches the model.
    expect(prompt).not.toContain("UNCITABLE_ORPHAN_BLOCK");
  });
});

describe("COPILOT_SYSTEM_PROMPT / COPILOT_OUTPUT_SCHEMA — governed synthesis contract", () => {
  it("the system prompt encodes grounding + cite-by-citationId + no-invention (REQ-F-017)", () => {
    expect(COPILOT_SYSTEM_PROMPT.length).toBeGreaterThan(80);
    expect(COPILOT_SYSTEM_PROMPT).toContain("citationId");
    expect(COPILOT_SYSTEM_PROMPT.toLowerCase()).toMatch(/only|grounded/);
    expect(COPILOT_SYSTEM_PROMPT.toLowerCase()).toMatch(/not.*(invent|assume|infer)|no.*(invent|inference)/);
  });

  it("the output schema requires an `answer` array and a `citations` array", () => {
    expect(COPILOT_OUTPUT_SCHEMA.type).toBe("object");
    const required = COPILOT_OUTPUT_SCHEMA.required as string[];
    expect(required).toContain("answer");
    expect(required).toContain("citations");
  });
});

describe("mapCompletionToCandidate — shape gate + citation reconciliation (grounding)", () => {
  it("a well-formed output whose citationIds are all in the retrieved set → ok, answer preserved", () => {
    const r = mapCompletionToCandidate(goodOutput, ctx);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.answer).toEqual(goodOutput.answer);
      expect(r.value.citations).toEqual(ctx.sources);
    }
  });

  it("DROPS a hallucinated citationId not in the retrieved set (grounding — model can't invent a source)", () => {
    const out = {
      answer: ["Answer."],
      citations: [
        { citationId: "src:note-1", title: "Vendor review — decisions" },
        { citationId: "src:FABRICATED", title: "Made-up source" },
      ],
    };
    const r = mapCompletionToCandidate(out, ctx);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.citations).toEqual([{ citationId: "src:note-1", title: "Vendor review — decisions" }]);
    }
  });

  it("uses the AUTHORITATIVE retrieved title, IGNORING a title the model tried to inject", () => {
    const out = {
      answer: ["Answer."],
      citations: [{ citationId: "src:note-1", title: "INJECTED ../../etc/passwd TITLE" }],
    };
    const r = mapCompletionToCandidate(out, ctx);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.citations[0]?.title).toBe("Vendor review — decisions");
    }
  });

  it("DEDUPES a repeated citationId to a single authoritative citation", () => {
    const out = {
      answer: ["Answer."],
      citations: [
        { citationId: "src:note-1", title: "Vendor review — decisions" },
        { citationId: "src:note-1", title: "Vendor review — decisions" },
      ],
    };
    const r = mapCompletionToCandidate(out, ctx);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.citations).toHaveLength(1);
  });

  it("preserves the model's citation ORDER after reconciliation", () => {
    const out = {
      answer: ["Answer."],
      citations: [
        { citationId: "src:note-2", title: "Pricing memo" },
        { citationId: "src:note-1", title: "Vendor review — decisions" },
      ],
    };
    const r = mapCompletionToCandidate(out, ctx);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.citations.map((c) => c.citationId)).toEqual(["src:note-2", "src:note-1"]);
    }
  });

  it("dedupe keeps the FIRST occurrence's position when a repeat is interleaved with other cites", () => {
    // note-2, note-1, then note-2 AGAIN → the second note-2 is dropped, note-2 keeps its first slot.
    const out = {
      answer: ["Answer."],
      citations: [
        { citationId: "src:note-2", title: "Pricing memo" },
        { citationId: "src:note-1", title: "Vendor review — decisions" },
        { citationId: "src:note-2", title: "Pricing memo" },
      ],
    };
    const r = mapCompletionToCandidate(out, ctx);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.citations.map((c) => c.citationId)).toEqual(["src:note-2", "src:note-1"]);
    }
  });

  it("a citation missing its `citationId` → err (fail-closed, symmetric to the missing-title case)", () => {
    const r = mapCompletionToCandidate({ answer: ["a"], citations: [{ title: "Orphan title" }] }, ctx);
    expect(isErr(r)).toBe(true);
  });

  it("a valid shape with an EMPTY answer array → ok (the downstream gate rejects empty, not the map)", () => {
    const r = mapCompletionToCandidate({ answer: [], citations: [] }, ctx);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.answer).toEqual([]);
  });

  it("MISSING `answer` → err(schema_rejected, COPILOT_OUTPUT_MALFORMED) — fail-closed", () => {
    const r = mapCompletionToCandidate({ citations: [] }, ctx);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("schema_rejected");
      expect(r.error.cause?.code).toBe("COPILOT_OUTPUT_MALFORMED");
    }
  });

  it("`answer` that is not an array of strings → err (fail-closed)", () => {
    const r = mapCompletionToCandidate({ answer: [1, 2], citations: [] }, ctx);
    expect(isErr(r)).toBe(true);
  });

  it("`citations` that is not an array → err (fail-closed)", () => {
    const r = mapCompletionToCandidate({ answer: ["a"], citations: "nope" }, ctx);
    expect(isErr(r)).toBe(true);
  });

  it("a citation missing its `title` → err (fail-closed on a malformed citation)", () => {
    const r = mapCompletionToCandidate({ answer: ["a"], citations: [{ citationId: "src:note-1" }] }, ctx);
    expect(isErr(r)).toBe(true);
  });

  it("a non-object structured output (null / string) → err (fail-closed)", () => {
    expect(isErr(mapCompletionToCandidate(null, ctx))).toBe(true);
    expect(isErr(mapCompletionToCandidate("just a string", ctx))).toBe(true);
  });
});

describe("foldCompletionError — CompletionError → FailureVariant (redaction-safe by construction)", () => {
  const cases: ReadonlyArray<{
    readonly kind: CompletionError["kind"];
    readonly failureKind: string;
    readonly code: string;
    readonly retryable: boolean;
  }> = [
    { kind: "budget", failureKind: "budget_exceeded", code: "COPILOT_SYNTHESIS_BUDGET", retryable: false },
    { kind: "malformed", failureKind: "schema_rejected", code: "COPILOT_SYNTHESIS_MALFORMED", retryable: false },
    { kind: "auth", failureKind: "provider_failed", code: "COPILOT_SYNTHESIS_AUTH", retryable: false },
    { kind: "rate_limited", failureKind: "provider_failed", code: "COPILOT_SYNTHESIS_RATE_LIMITED", retryable: true },
    { kind: "timeout", failureKind: "provider_failed", code: "COPILOT_SYNTHESIS_TIMEOUT", retryable: true },
    { kind: "transport", failureKind: "provider_failed", code: "COPILOT_SYNTHESIS_TRANSPORT", retryable: true },
    { kind: "cancelled", failureKind: "provider_failed", code: "COPILOT_SYNTHESIS_CANCELLED", retryable: false },
  ];

  for (const c of cases) {
    it(`${c.kind} → ${c.failureKind} / ${c.code} (retryable ${String(c.retryable)})`, () => {
      const fv = foldCompletionError({ kind: c.kind, message: "irrelevant", retryable: c.retryable });
      expect(fv.kind).toBe(c.failureKind);
      expect(fv.cause?.code).toBe(c.code);
      expect(fv.retryable).toBe(c.retryable);
    });
  }

  it("NEVER carries the raw SDK message into the FailureVariant (no content leak — §16 carry-forward)", () => {
    const secret = "Bearer sk-ant-SECRET-abc123 raw employer note body";
    const fv = foldCompletionError({ kind: "transport", message: secret, retryable: true });
    expect(fv.message).not.toContain("SECRET");
    expect(fv.message).not.toContain("sk-ant");
    expect(fv.message).not.toContain("employer note");
    // Only a stable UPPER_SNAKE cause code — the sole field that survives §16 redaction.
    expect(fv.cause?.code).toMatch(/^[A-Z0-9_]+$/);
  });
});

describe("createClaudeCopilotSynthesis — the wired CopilotSynthesisPort over a fake client", () => {
  it("happy path: ok completion → reconciled candidate answer", async () => {
    const { client } = recordingClient(ok({ structuredOutput: goodOutput, costUsd: 0.01 }));
    const synth = createClaudeCopilotSynthesis(client);
    const r = await synth.synthesize("ws-employer", "what did we decide?", ctx, cloudRoute);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.answer).toEqual(goodOutput.answer);
      expect(r.value.citations).toEqual(ctx.sources);
    }
  });

  it("a completion ERROR folds to a typed FailureVariant (provider_failed / stable code)", async () => {
    const { client } = recordingClient(err({ kind: "auth", message: "login expired", retryable: false }));
    const synth = createClaudeCopilotSynthesis(client);
    const r = await synth.synthesize("ws-employer", "q", ctx, cloudRoute);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("provider_failed");
      expect(r.error.cause?.code).toBe("COPILOT_SYNTHESIS_AUTH");
    }
  });

  it("REFUSES a non-Claude (local) route BEFORE any egress — the client is never called (rule 5 D-in-D)", async () => {
    const { client, calls } = recordingClient(ok({ structuredOutput: goodOutput, costUsd: 0.01 }));
    const synth = createClaudeCopilotSynthesis(client);
    const r = await synth.synthesize("ws-employer", "q", ctx, localRoute);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("validation_rejected");
      expect(r.error.cause?.code).toBe("COPILOT_ROUTE_NOT_CLAUDE");
    }
    expect(calls).toHaveLength(0); // no prompt shipped to the wrong processor
  });

  it("an ok completion carrying a MALFORMED structured output → err(schema_rejected) — fail-closed", async () => {
    const { client } = recordingClient(ok({ structuredOutput: { not: "a copilot answer" }, costUsd: 0.01 }));
    const synth = createClaudeCopilotSynthesis(client);
    const r = await synth.synthesize("ws-employer", "q", ctx, cloudRoute);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("schema_rejected");
      expect(r.error.cause?.code).toBe("COPILOT_OUTPUT_MALFORMED");
    }
  });

  it("assembles the request from the route + governed prompts + schema + default budget", async () => {
    const { client, calls } = recordingClient(ok({ structuredOutput: goodOutput, costUsd: 0.01 }));
    const synth = createClaudeCopilotSynthesis(client);
    await synth.synthesize("ws-employer", "what did we decide?", ctx, cloudRoute);
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.model).toBe(cloudRoute.model); // uses the veto-CLEARED route's model (never re-selects)
    expect(req.systemPrompt).toBe(COPILOT_SYSTEM_PROMPT);
    expect(req.userPrompt).toContain("what did we decide?");
    expect(req.userPrompt).toContain("src:note-1");
    expect(req.outputSchema).toBe(COPILOT_OUTPUT_SCHEMA);
    expect(req.maxCostUsd).toBe(DEFAULT_COPILOT_MAX_COST_USD);
  });

  it("honors a caller-supplied per-answer cost cap", async () => {
    const { client, calls } = recordingClient(ok({ structuredOutput: goodOutput, costUsd: 0.01 }));
    const synth = createClaudeCopilotSynthesis(client, { maxCostUsd: 1.5 });
    await synth.synthesize("ws-employer", "q", ctx, cloudRoute);
    expect(calls[0]!.maxCostUsd).toBe(1.5);
  });
});

// ── P2.4: the real cloud route selector + consent posture (wire it live) ─────────────────
describe("createClaudeCloudRouteSelector — the real cloud Claude provider route", () => {
  it("selects a Claude PROVIDER route with cloud egress (satisfies the P2.3 adapter guard)", async () => {
    const sel = createClaudeCloudRouteSelector();
    const r = await sel.select("ws-employer", cloudCopilotPosture("ws-employer", "employer_work"));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(providerOf(r.value)).toBe("claude");
      expect(r.value.egressClass).toBe("cloud");
    }
  });

  it("honors a caller-supplied model id", async () => {
    const sel = createClaudeCloudRouteSelector("claude-sonnet-5");
    const r = await sel.select("ws", cloudCopilotPosture("ws", "employer_work"));
    if (isOk(r)) expect(r.value.model).toBe("claude-sonnet-5");
  });

  it("the selected cloud route is ACCEPTED by the synthesis adapter's Claude-route guard", async () => {
    const { client } = recordingClient(ok({ structuredOutput: goodOutput, costUsd: 0.01 }));
    const synth = createClaudeCopilotSynthesis(client);
    const routeR = await createClaudeCloudRouteSelector().select(
      "ws-employer",
      cloudCopilotPosture("ws-employer", "employer_work"),
    );
    expect(isOk(routeR)).toBe(true);
    if (isOk(routeR)) {
      const r = await synth.synthesize("ws-employer", "q", ctx, routeR.value);
      expect(isOk(r)).toBe(true); // NOT COPILOT_ROUTE_NOT_CLAUDE — the route + adapter agree
    }
  });
});

describe("cloudCopilotPosture — the interim consent posture (owner accepts employer cloud + notice)", () => {
  it("allowlists the claude processor for raw content and ACKS employer-work egress", () => {
    const p = cloudCopilotPosture("ws-employer", "employer_work");
    expect(p.type).toBe("employer_work");
    expect(p.egress.employerRawEgressAcknowledged).toBe(true);
    expect(p.egress.allowedProcessors).toContain(processorId("claude"));
    expect(p.egress.rawContentAllowedProcessors).toContain(processorId("claude"));
  });

  it("does NOT ack for a personal workspace (the employer branch never applies)", () => {
    const p = cloudCopilotPosture("ws-personal", "personal_business");
    expect(p.egress.employerRawEgressAcknowledged).toBe(false);
    expect(p.egress.allowedProcessors).toContain(processorId("claude"));
  });
});

describe("P2.4 governance outcome: cloud route + consent posture → veto ALLOWS, notice fires", () => {
  it("employer-work → ALLOW the cloud route WITH the egressProcessor notice (the whole point)", async () => {
    const posture = cloudCopilotPosture("ws-employer", "employer_work");
    const routeR = await createClaudeCloudRouteSelector().select("ws-employer", posture);
    expect(isOk(routeR)).toBe(true);
    if (isOk(routeR)) {
      const d = decideCopilotEgress({
        job: buildCopilotJob("ws-employer", routeR.value),
        route: routeR.value,
        posture,
      });
      expect(isOk(d)).toBe(true);
      if (isOk(d)) expect(d.value.egressProcessor).toBe("claude"); // NOTICE fires for real
    }
  });

  it("personal-business → ALLOW the cloud route with NO notice (non-employer cloud needs none)", async () => {
    const posture = cloudCopilotPosture("ws-personal", "personal_business");
    const routeR = await createClaudeCloudRouteSelector().select("ws-personal", posture);
    expect(isOk(routeR)).toBe(true);
    if (isOk(routeR)) {
      const d = decideCopilotEgress({
        job: buildCopilotJob("ws-personal", routeR.value),
        route: routeR.value,
        posture,
      });
      expect(isOk(d)).toBe(true);
      if (isOk(d)) expect(d.value.egressProcessor).toBeUndefined();
    }
  });
});

describe("buildCopilotDeps — the flag branch, unit-tested (a flipped ternary can't ship silently)", () => {
  const employer: readonly CopilotWorkspace[] = [{ id: "ws-employer", type: "employer_work" }];
  const okCompletion = () => recordingClient(ok({ structuredOutput: goodOutput, costUsd: 0.01 })).client;

  it("OFF: fail-closed posture (ack off) + local route (no notice); the completion factory is NEVER called", async () => {
    let factoryCalls = 0;
    const deps = buildCopilotDeps({
      realCopilot: false,
      workspaces: employer,
      completion: () => {
        factoryCalls++;
        return okCompletion();
      },
    });
    expect(factoryCalls).toBe(0); // the real SDK client is never even constructed when OFF

    const posture = await deps.workspacePosture.resolve("ws-employer");
    expect(isOk(posture)).toBe(true);
    if (isOk(posture)) {
      expect(posture.value.egress.employerRawEgressAcknowledged).toBe(false);
      const routeR = await deps.routeSelector.select("ws-employer", posture.value);
      expect(isOk(routeR)).toBe(true);
      if (isOk(routeR)) {
        const d = decideCopilotEgress({
          job: buildCopilotJob("ws-employer", routeR.value),
          route: routeR.value,
          posture: posture.value,
        });
        expect(isOk(d)).toBe(true);
        if (isOk(d)) expect(d.value.egressProcessor).toBeUndefined(); // local ⇒ no egress, no notice
      }
    }
  });

  it("ON: consent posture (ack on) + cloud route + real synthesis (fake client); factory called EXACTLY once", async () => {
    let factoryCalls = 0;
    const deps = buildCopilotDeps({
      realCopilot: true,
      workspaces: employer,
      completion: () => {
        factoryCalls++;
        return okCompletion();
      },
    });
    expect(factoryCalls).toBe(1);

    const posture = await deps.workspacePosture.resolve("ws-employer");
    expect(isOk(posture)).toBe(true);
    if (isOk(posture)) expect(posture.value.egress.employerRawEgressAcknowledged).toBe(true);

    const routeR = await deps.routeSelector.select(
      "ws-employer",
      cloudCopilotPosture("ws-employer", "employer_work"),
    );
    expect(isOk(routeR)).toBe(true);
    if (isOk(routeR)) {
      expect(providerOf(routeR.value)).toBe("claude");
      // The fake-backed real synthesis produces a reconciled candidate over the cloud route.
      const synthR = await deps.synthesis.synthesize("ws-employer", "q", ctx, routeR.value);
      expect(isOk(synthR)).toBe(true);
      if (isOk(synthR)) expect(synthR.value.citations).toEqual(ctx.sources);
    }
  });

  it("threads the model override into the cloud route selector", async () => {
    const deps = buildCopilotDeps({
      realCopilot: true,
      workspaces: employer,
      model: "claude-sonnet-5",
      completion: okCompletion,
    });
    const routeR = await deps.routeSelector.select(
      "ws-employer",
      cloudCopilotPosture("ws-employer", "employer_work"),
    );
    if (isOk(routeR)) expect(routeR.value.model).toBe("claude-sonnet-5");
  });

  it("with no provisioned workspaces, every posture resolve fails CLOSED (WORKSPACE_NOT_FOUND)", async () => {
    const deps = buildCopilotDeps({ realCopilot: true, workspaces: [], completion: okCompletion });
    const posture = await deps.workspacePosture.resolve("ws-employer");
    expect(isErr(posture)).toBe(true);
  });

  it("threads betas into the synthesis request (default 1M-context beta, no explicit override)", async () => {
    const { client, calls } = recordingClient(ok({ structuredOutput: goodOutput, costUsd: 0.01 }));
    const deps = buildCopilotDeps({
      realCopilot: true,
      workspaces: employer,
      completion: () => client,
    });
    const routeR = await deps.routeSelector.select("ws-employer", cloudCopilotPosture("ws-employer", "employer_work"));
    if (isOk(routeR)) await deps.synthesis.synthesize("ws-employer", "q", ctx, routeR.value);
    expect(calls[0]!.betas).toEqual(["context-1m-2025-08-07"]);
  });

  it("threads a NON-default betas OVERRIDE through buildCopilotDeps (not just the default)", async () => {
    const { client, calls } = recordingClient(ok({ structuredOutput: goodOutput, costUsd: 0.01 }));
    const deps = buildCopilotDeps({
      realCopilot: true,
      workspaces: employer,
      betas: ["context-1m-2025-08-07", "some-other-beta"],
      completion: () => client,
    });
    const routeR = await deps.routeSelector.select("ws-employer", cloudCopilotPosture("ws-employer", "employer_work"));
    if (isOk(routeR)) await deps.synthesis.synthesize("ws-employer", "q", ctx, routeR.value);
    expect(calls[0]!.betas).toEqual(["context-1m-2025-08-07", "some-other-beta"]);
  });
});

describe("resolveCopilotWorkspaces / copilotWorkspaceType — decouple Copilot reachability from devProvision", () => {
  it("copilotWorkspaceType maps the two personal scopes explicitly; everything else → most-restrictive employer_work", () => {
    expect(copilotWorkspaceType("personal-business")).toBe("personal_business");
    expect(copilotWorkspaceType("personal-life")).toBe("personal_life");
    expect(copilotWorkspaceType("employer-work")).toBe("employer_work");
    expect(copilotWorkspaceType("acme-corp-subscope")).toBe("employer_work"); // unknown → employer_work
    expect(copilotWorkspaceType("")).toBe("employer_work");
  });

  it("WELL_KNOWN_COPILOT_WORKSPACES lists the 3 scopes with correct types", () => {
    expect(WELL_KNOWN_COPILOT_WORKSPACES).toEqual([
      { id: "employer-work", type: "employer_work" },
      { id: "personal-business", type: "personal_business" },
      { id: "personal-life", type: "personal_life" },
    ]);
  });

  it("an EXPLICIT list wins verbatim (highest precedence)", () => {
    const explicit: readonly CopilotWorkspace[] = [{ id: "personal-business", type: "personal_business" }];
    expect(resolveCopilotWorkspaces({ explicit, realCopilot: true })).toBe(explicit);
    // even with devProvision present, explicit still wins
    expect(
      resolveCopilotWorkspaces({ explicit, devProvision: [{ workspaceId: "employer-work" }], realCopilot: true }),
    ).toBe(explicit);
  });

  it("no explicit + devProvision present → derived from devProvision with correct types (backward compat)", () => {
    const r = resolveCopilotWorkspaces({
      devProvision: [{ workspaceId: "employer-work" }, { workspaceId: "personal-business" }],
      realCopilot: true,
    });
    expect(r).toEqual([
      { id: "employer-work", type: "employer_work" },
      { id: "personal-business", type: "personal_business" },
    ]);
  });

  it("no explicit + no devProvision + realCopilot ON → the 3 well-known scopes (the reachability fix)", () => {
    expect(resolveCopilotWorkspaces({ realCopilot: true })).toEqual(WELL_KNOWN_COPILOT_WORKSPACES);
    expect(resolveCopilotWorkspaces({ devProvision: [], realCopilot: true })).toEqual(WELL_KNOWN_COPILOT_WORKSPACES);
  });

  it("no explicit + no devProvision + realCopilot OFF → empty (interim stub answers nothing, unchanged)", () => {
    expect(resolveCopilotWorkspaces({ realCopilot: false })).toEqual([]);
    expect(resolveCopilotWorkspaces({ devProvision: [], realCopilot: false })).toEqual([]);
  });
});

describe("buildCopilotDeps — P3-live gbrain retrieval branch (only the served workspace reads gbrain)", () => {
  const served = "personal-business";
  const workspaces: readonly CopilotWorkspace[] = [
    { id: served, type: "personal_business" },
    { id: "employer-work", type: "employer_work" },
  ];
  // A gbrain `call query` hit (only chunk_text/slug/title are mapped; source_id is the SOURCE, not an id).
  const gbrainHits = [
    { slug: "sessions/028", chunk_text: "the seed says X", title: "Session 028", source_id: "default" },
  ];
  const okCompletion = () => recordingClient(ok({ structuredOutput: goodOutput, costUsd: 0.01 })).client;

  it("real path + gbrainExec: the SERVED workspace reads gbrain; the factory is called EXACTLY once", async () => {
    let factoryCalls = 0;
    const deps = buildCopilotDeps({
      realCopilot: true,
      workspaces,
      completion: okCompletion,
      gbrainExec: () => {
        factoryCalls++;
        return async () => ok(gbrainHits);
      },
    });
    expect(factoryCalls).toBe(1); // the CLI transport is constructed once, only on the gbrain path
    const r = await deps.retrieval.retrieve(served, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.blocks).toEqual(["the seed says X"]);
      expect(r.value.sources).toEqual([{ citationId: "gbrain:sessions:028", title: "Session 028" }]);
    }
  });

  it("real path + gbrainExec: a NON-served workspace stays on the fixture (empty) and never reads gbrain (WS-8)", async () => {
    let execCalls = 0;
    const deps = buildCopilotDeps({
      realCopilot: true,
      workspaces,
      completion: okCompletion,
      gbrainExec: () => async () => {
        execCalls++;
        return ok(gbrainHits);
      },
    });
    const r = await deps.retrieval.retrieve("employer-work", "q");
    expect(execCalls).toBe(0); // no cross-workspace brain read
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.blocks).toEqual([]);
  });

  it("gbrainExec is IGNORED when realCopilot is OFF (fixture stub; the factory is NEVER called)", async () => {
    let factoryCalls = 0;
    const deps = buildCopilotDeps({
      realCopilot: false,
      workspaces,
      completion: okCompletion,
      gbrainExec: () => {
        factoryCalls++;
        return async () => ok(gbrainHits);
      },
    });
    expect(factoryCalls).toBe(0);
    const r = await deps.retrieval.retrieve(served, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.blocks).toEqual([]); // fixture empty, not gbrain
  });

  it("WITHOUT gbrainExec the real path keeps the fixture retrieval (served workspace returns empty, not gbrain)", async () => {
    const deps = buildCopilotDeps({ realCopilot: true, workspaces, completion: okCompletion });
    const r = await deps.retrieval.retrieve(served, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.blocks).toEqual([]);
  });

  it("honors a gbrainWorkspaceId override (that workspace reads gbrain; personal-business falls back to fixture)", async () => {
    const deps = buildCopilotDeps({
      realCopilot: true,
      workspaces,
      completion: okCompletion,
      gbrainWorkspaceId: "employer-work",
      gbrainExec: () => async () => ok(gbrainHits),
    });
    const rEmp = await deps.retrieval.retrieve("employer-work", "q");
    expect(isOk(rEmp)).toBe(true);
    if (isOk(rEmp)) expect(rEmp.value.blocks).toEqual(["the seed says X"]); // now gbrain-served
    const rPb = await deps.retrieval.retrieve(served, "q");
    expect(isOk(rPb)).toBe(true);
    if (isOk(rPb)) expect(rPb.value.blocks).toEqual([]); // now the fixture fallback
  });
});

describe("buildCopilotDeps — C5.4b provenance-stamping decorator (a flipped ternary can't ship silently)", () => {
  const served = "personal-business";
  const workspaces: readonly CopilotWorkspace[] = [{ id: served, type: "personal_business" }];
  const gbrainHits = [
    { slug: "sessions/028", chunk_text: "the seed says X", title: "Session 028", source_id: "default" },
  ];
  const okCompletion = () => recordingClient(ok({ structuredOutput: goodOutput, costUsd: 0.01 })).client;

  /** A spy serving oracle returning a fixed verdict; records how many times it was consulted. */
  function spyOracle(verdict: CopilotServingVerdict): { oracle: CopilotServingOracle; calls: () => number } {
    let n = 0;
    return {
      oracle: { admit: () => { n++; return Promise.resolve(ok(verdict)); } },
      calls: () => n,
    };
  }

  it("real path + servingOracle: the retrieval is DECORATED — the oracle is consulted AND a gated verdict stamps knowledge_writer", async () => {
    const spy = spyOracle({ mode: "gated", admittedCitationIds: new Set(["gbrain:sessions:028"]) });
    const deps = buildCopilotDeps({
      realCopilot: true,
      workspaces,
      completion: okCompletion,
      gbrainExec: () => async () => ok(gbrainHits),
      servingOracle: () => spy.oracle,
    });
    const r = await deps.retrieval.retrieve(served, "q");
    expect(spy.calls()).toBe(1); // the decorator wraps the retrieval — drop the wrapping and this is 0
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.sources).toEqual([
        { citationId: "gbrain:sessions:028", title: "Session 028", provenance: "knowledge_writer" },
      ]);
      expect(deriveCopilotContentTrust(r.value)).toBe("trusted");
    }
  });

  it("real path + the INTERIM oracle: a live gbrain hit is STILL un-stamped ⇒ untrusted (structurally OFF today)", async () => {
    const deps = buildCopilotDeps({
      realCopilot: true,
      workspaces,
      completion: okCompletion,
      gbrainExec: () => async () => ok(gbrainHits),
      servingOracle: createInterimDegradedServingOracle,
    });
    const r = await deps.retrieval.retrieve(served, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.sources).toEqual([{ citationId: "gbrain:sessions:028", title: "Session 028" }]);
      expect(deriveCopilotContentTrust(r.value)).toBe("untrusted"); // no live path yields a knowledge_writer stamp
    }
  });

  it("servingOracle is IGNORED when realCopilot is OFF (the factory is NEVER called)", async () => {
    let factoryCalls = 0;
    const deps = buildCopilotDeps({
      realCopilot: false,
      workspaces,
      completion: okCompletion,
      servingOracle: () => { factoryCalls++; return createInterimDegradedServingOracle(); },
    });
    expect(factoryCalls).toBe(0);
    const r = await deps.retrieval.retrieve(served, "q");
    expect(isOk(r)).toBe(true); // interim stub path, unchanged
  });

  it("WITHOUT servingOracle the real path is UNDECORATED (sources un-provenanced — the pre-C5.4b behavior)", async () => {
    const deps = buildCopilotDeps({
      realCopilot: true,
      workspaces,
      completion: okCompletion,
      gbrainExec: () => async () => ok(gbrainHits),
    });
    const r = await deps.retrieval.retrieve(served, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.sources).toEqual([{ citationId: "gbrain:sessions:028", title: "Session 028" }]);
      expect(deriveCopilotContentTrust(r.value)).toBe("untrusted");
    }
  });
});

describe("Sonnet 5 1M — the default model + the 1M-context beta (P2.4b)", () => {
  it("the DEFAULT Copilot model is Claude Sonnet 5", async () => {
    const r = await createClaudeCloudRouteSelector().select("ws", cloudCopilotPosture("ws", "employer_work"));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.model).toBe("claude-sonnet-5");
  });

  it("requests the 1M-context beta BY DEFAULT", async () => {
    const { client, calls } = recordingClient(ok({ structuredOutput: goodOutput, costUsd: 0.01 }));
    const synth = createClaudeCopilotSynthesis(client);
    await synth.synthesize("ws", "q", ctx, cloudRoute);
    expect(calls[0]!.betas).toEqual(["context-1m-2025-08-07"]);
  });

  it("honors a betas override (e.g. [] to disable 1M for a non-Sonnet model)", async () => {
    const { client, calls } = recordingClient(ok({ structuredOutput: goodOutput, costUsd: 0.01 }));
    const synth = createClaudeCopilotSynthesis(client, { betas: [] });
    await synth.synthesize("ws", "q", ctx, cloudRoute);
    expect(calls[0]!.betas).toEqual([]);
  });
});

// ── SC3 (§13.10 gate a) — the P1 boot wiring: interim registry + gbrainWorkspaceScope ─────────────────
describe("buildInterimCopilotScopeRegistry — the interim workspace→slug-prefix map (no authoritative source yet)", () => {
  it("maps each workspace to a single slug-prefix = its own id (the gbrain-workspaces convention)", () => {
    const reg = buildInterimCopilotScopeRegistry([
      { id: "employer-work", type: "employer_work" },
      { id: "personal-business", type: "personal_business" },
    ]);
    expect(reg.descriptors).toHaveLength(2);
    expect(reg.descriptors[0]).toMatchObject({ workspaceId: "employer-work", slugPrefixes: ["employer-work"] });
    expect(reg.descriptors[1]!.slugPrefixes).toEqual(["personal-business"]);
  });
  it("returns an empty registry for no workspaces", () => {
    expect(buildInterimCopilotScopeRegistry([]).descriptors).toEqual([]);
  });
});

describe("buildCopilotDeps — SC3 gbrainWorkspaceScope wires the P1 filter into the served retrieval", () => {
  const workspaces: CopilotWorkspace[] = [
    { id: "personal-business", type: "personal_business" },
    { id: "employer-work", type: "employer_work" },
  ];
  const rawHit = (slug: string, chunk: string, title: string): Record<string, unknown> => ({
    slug,
    chunk_text: chunk,
    title,
    source_id: "default",
  });
  const okExec =
    (hits: unknown): GbrainQueryExec =>
    async () =>
      ok(hits);
  const completion = () => recordingClient(ok({ structuredOutput: goodOutput, costUsd: 0.01 })).client;
  const ASSIGN_BUSINESS: LegacyContentPolicy = { mode: "assign", toWorkspaceId: workspaceId("personal-business") };
  const rawWithForeign = [rawHit("personal-business/mine", "mine", "Mine"), rawHit("employer-work/secret", "leak", "Leak")];

  it("with gbrainWorkspaceScope: DROPS the FOREIGN hit from the served workspace's retrieval", async () => {
    const deps = buildCopilotDeps({
      realCopilot: true,
      workspaces,
      completion,
      gbrainExec: () => okExec(rawWithForeign),
      gbrainWorkspaceId: "personal-business",
      gbrainWorkspaceScope: { registry: buildInterimCopilotScopeRegistry(workspaces), policy: ASSIGN_BUSINESS },
    });
    const r = await deps.retrieval.retrieve("personal-business", "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.blocks).toEqual(["mine"]); // employer hit dropped before the context is built
      expect(r.value.sources.every((s) => !s.citationId.includes("employer-work"))).toBe(true);
    }
  });

  it("WITHOUT gbrainWorkspaceScope: passthrough (back-compat — foreign hit survives)", async () => {
    const deps = buildCopilotDeps({
      realCopilot: true,
      workspaces,
      completion,
      gbrainExec: () => okExec(rawWithForeign),
      gbrainWorkspaceId: "personal-business",
    });
    const r = await deps.retrieval.retrieve("personal-business", "q");
    expect(isOk(r) && r.value.blocks).toEqual(["mine", "leak"]);
  });

  it("under the boot DEFAULT {deny}: an unprefixed/legacy hit is DROPPED (⚠ today's whole brain is unprefixed ⇒ zero retrieval — why the owner posture is {assign,personal-business}, not the default)", async () => {
    const deps = buildCopilotDeps({
      realCopilot: true,
      workspaces,
      completion,
      gbrainExec: () => okExec([rawHit("sessions/041", "legacy", "Legacy"), rawHit("personal-business/mine", "mine", "Mine")]),
      gbrainWorkspaceId: "personal-business",
      gbrainWorkspaceScope: { registry: buildInterimCopilotScopeRegistry(workspaces), policy: { mode: "deny" } },
    });
    const r = await deps.retrieval.retrieve("personal-business", "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.blocks).toEqual(["mine"]); // legacy sessions/041 dropped; only the prefixed hit survives
  });

  it("the filter is bound to the served id: a legacy hit is KEPT under {assign,personal-business} served=personal-business", async () => {
    const deps = buildCopilotDeps({
      realCopilot: true,
      workspaces,
      completion,
      gbrainExec: () => okExec([rawHit("sessions/041", "legacy", "Legacy")]),
      gbrainWorkspaceId: "personal-business",
      gbrainWorkspaceScope: { registry: buildInterimCopilotScopeRegistry(workspaces), policy: ASSIGN_BUSINESS },
    });
    const r = await deps.retrieval.retrieve("personal-business", "q");
    expect(isOk(r) && r.value.blocks).toEqual(["legacy"]);
  });
});
