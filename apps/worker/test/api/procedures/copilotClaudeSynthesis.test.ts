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
import {
  createClaudeCopilotSynthesis,
  buildCopilotUserPrompt,
  mapCompletionToCandidate,
  foldCompletionError,
  createClaudeCloudRouteSelector,
  cloudCopilotPosture,
  buildCopilotDeps,
  COPILOT_SYSTEM_PROMPT,
  COPILOT_OUTPUT_SCHEMA,
  DEFAULT_COPILOT_MAX_COST_USD,
  type CopilotWorkspace,
} from "../../../src/api/procedures/copilotClaudeSynthesis";

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
});
