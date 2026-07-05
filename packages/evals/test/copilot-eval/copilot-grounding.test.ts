// spec(§4.6 Copilot Q&A / PRD §20.1 / EVAL-1) — Copilot SYNTHESIS eval: grounding + citation
// correctness (the model-prose quality the deterministic governance suite explicitly defers).
//
// TWO tiers:
//   1. The DETERMINISTIC grader (`gradeCopilotAnswer`) + a synthetic labeled corpus, graded over each
//      case's GOLDEN reference answer — always runs (CI floor). This pins the grader + proves every
//      corpus case is gradeable and its expectations are satisfiable.
//   2. A GATED real-model tier (SOW_COPILOT_REAL_EVAL=1) that generates answers with the real Claude
//      Sonnet synthesis adapter and grades them — skipped by default (non-deterministic, costs money,
//      needs the local `claude` login). See the bottom describe.
import { describe, it, expect } from "vitest";
import { isOk } from "@sow/contracts";
import type { ProviderRoute } from "@sow/contracts";
import {
  gradeCopilotAnswer,
  isRefusalAnswer,
  type CopilotModelOutput,
} from "../../src/copilot-eval/grader";
import { COPILOT_EVAL_CORPUS, COPILOT_EVAL_FLOOR } from "../../src/copilot-eval/corpus";

const context = {
  workspaceId: "employer-work",
  blocks: ["The vendor SLA target is 99.9% uptime.", "The contract renews annually in March."],
  sources: [
    { citationId: "gbrain:sla-note", title: "Vendor SLA" },
    { citationId: "gbrain:contract-note", title: "Contract terms" },
  ],
};

const grounded: CopilotModelOutput = {
  answer: ["The vendor SLA target is 99.9% uptime."],
  citations: [{ citationId: "gbrain:sla-note", title: "Vendor SLA" }],
};

describe("gradeCopilotAnswer — the deterministic grounding + citation grader", () => {
  it("a grounded, correctly-cited answer PASSES", () => {
    const g = gradeCopilotAnswer(grounded, context, { mustCite: ["gbrain:sla-note"] });
    expect(g.pass).toBe(true);
    expect(g.citationsGrounded).toBe(true);
    expect(g.requiredCitationsPresent).toBe(true);
  });

  it("a HALLUCINATED citation (id not in the retrieved set) FAILS citationsGrounded", () => {
    const out: CopilotModelOutput = {
      answer: ["Some claim."],
      citations: [{ citationId: "gbrain:INVENTED", title: "Made up" }],
    };
    const g = gradeCopilotAnswer(out, context, {});
    expect(g.citationsGrounded).toBe(false);
    expect(g.pass).toBe(false);
  });

  it("a MISSING required citation FAILS requiredCitationsPresent", () => {
    const g = gradeCopilotAnswer(grounded, context, { mustCite: ["gbrain:contract-note"] });
    expect(g.requiredCitationsPresent).toBe(false);
    expect(g.pass).toBe(false);
  });

  it("a FORBIDDEN (fabricated) claim FAILS noForbiddenClaims", () => {
    const out: CopilotModelOutput = {
      answer: ["The SLA target is 99.9% and the penalty is $50,000 per breach."],
      citations: [{ citationId: "gbrain:sla-note", title: "Vendor SLA" }],
    };
    // The context never states a penalty figure — it must not be invented (REQ-F-017).
    const g = gradeCopilotAnswer(out, context, { forbidden: ["$50,000", "penalty"] });
    expect(g.noForbiddenClaims).toBe(false);
    expect(g.pass).toBe(false);
  });

  it("a correct REFUSAL (context can't answer) PASSES when refuse is expected", () => {
    const out: CopilotModelOutput = {
      answer: ["I couldn't find anything about that in this workspace."],
      citations: [],
    };
    const g = gradeCopilotAnswer(out, context, { refuse: true });
    expect(g.refusalCorrect).toBe(true);
    expect(g.pass).toBe(true);
  });

  it("a SPURIOUS refusal on an answerable case FAILS", () => {
    const out: CopilotModelOutput = { answer: ["I couldn't find anything relevant."], citations: [] };
    const g = gradeCopilotAnswer(out, context, { mustCite: ["gbrain:sla-note"] });
    expect(g.refusalCorrect).toBe(false);
    expect(g.pass).toBe(false);
  });

  it("a GROUNDED refusal MAY cite the topic source (a grounded refusal-with-context is correct)", () => {
    // Real Sonnet behavior: "I couldn't find a figure; the note only flags it as a concern [cite]."
    const out: CopilotModelOutput = {
      answer: ["I couldn't find a specific figure; the note only flags it as a concern."],
      citations: [{ citationId: "gbrain:sla-note", title: "Vendor SLA" }], // grounded (in the retrieved set)
    };
    const g = gradeCopilotAnswer(out, context, { refuse: true });
    expect(g.refusalCorrect).toBe(true);
    expect(g.citationsGrounded).toBe(true);
    expect(g.pass).toBe(true);
  });

  it("a refusal citing a HALLUCINATED source FAILS via citationsGrounded (not refusalCorrect)", () => {
    const out: CopilotModelOutput = {
      answer: ["I couldn't find that."],
      citations: [{ citationId: "gbrain:INVENTED", title: "x" }],
    };
    const g = gradeCopilotAnswer(out, context, { refuse: true });
    expect(g.refusalCorrect).toBe(true); // it IS a refusal...
    expect(g.citationsGrounded).toBe(false); // ...but the citation is invented
    expect(g.pass).toBe(false);
  });

  it("an empty citations list is trivially grounded (no invented source)", () => {
    const g = gradeCopilotAnswer({ answer: ["A general statement."], citations: [] }, context, {});
    expect(g.citationsGrounded).toBe(true);
  });

  it("a VACUOUS answer with the right citation FAILS (citation bookkeeping ≠ correctness)", () => {
    const vacuous: CopilotModelOutput = {
      answer: ["Here is what I found in the workspace."],
      citations: [{ citationId: "gbrain:sla-note", title: "Vendor SLA" }],
    };
    const g = gradeCopilotAnswer(vacuous, context, { mustCite: ["gbrain:sla-note"], mustContain: ["99.9"] });
    expect(g.citationsGrounded).toBe(true); // the citation IS grounded...
    expect(g.contentPresent).toBe(false); // ...but the answer never states the fact
    expect(g.pass).toBe(false);
  });

  it("a WRONG-fact answer with the right citation FAILS via the content axis", () => {
    const wrong: CopilotModelOutput = {
      answer: ["The vendor SLA target is 50% uptime."], // contradicts the retrieved 99.9%
      citations: [{ citationId: "gbrain:sla-note", title: "Vendor SLA" }],
    };
    const g = gradeCopilotAnswer(wrong, context, { mustCite: ["gbrain:sla-note"], mustContain: ["99.9"] });
    expect(g.pass).toBe(false);
  });
});

describe("isRefusalAnswer — refusal phrase detector", () => {
  it("detects common refusal phrasings", () => {
    expect(isRefusalAnswer(["I couldn't find anything about that."])).toBe(true);
    expect(isRefusalAnswer(["There is no information on this in the context."])).toBe(true);
    expect(isRefusalAnswer(["I don't have anything on that topic."])).toBe(true);
  });
  it("does not flag a substantive answer as a refusal", () => {
    expect(isRefusalAnswer(["The SLA target is 99.9% uptime."])).toBe(false);
  });
});

describe("Copilot grounding corpus — labeled synthetic cases (EVAL-1 floor)", () => {
  it(`meets the floor of ${String(COPILOT_EVAL_FLOOR)} cases`, () => {
    expect(COPILOT_EVAL_CORPUS.length).toBeGreaterThanOrEqual(COPILOT_EVAL_FLOOR);
  });

  it("every case is well-formed (unique id, aligned context, golden citations ⊆ retrieved sources)", () => {
    const ids = new Set<string>();
    for (const c of COPILOT_EVAL_CORPUS) {
      expect(c.id.length, c.id).toBeGreaterThan(0);
      expect(ids.has(c.id), `duplicate id ${c.id}`).toBe(false);
      ids.add(c.id);
      expect(c.question.length, c.id).toBeGreaterThan(0);
      expect(c.context.blocks.length, `${c.id} block↔source alignment`).toBe(c.context.sources.length);
      const srcIds = new Set(c.context.sources.map((s) => s.citationId));
      for (const cit of c.golden.citations) {
        expect(srcIds.has(cit.citationId), `${c.id} golden cites a non-retrieved source`).toBe(true);
      }
    }
  });

  it.each(COPILOT_EVAL_CORPUS)("golden reference answer PASSES the grader: $id", (c) => {
    const g = gradeCopilotAnswer(c.golden, c.context, c.expect);
    expect(g.pass, `${c.id}: ${g.failures.join("; ")}`).toBe(true);
  });
});

// ── GATED real-model tier — generates answers with the real Claude Sonnet synthesis adapter and grades
// them. Skipped by default: non-deterministic, costs money, and needs the ambient local `claude` login.
// Enable with SOW_COPILOT_REAL_EVAL=1 (e.g. `SOW_COPILOT_REAL_EVAL=1 pnpm --filter @sow/evals test`).
//
// NOTE on the axes on this tier: it grades the adapter's RECONCILED candidate (mapCompletionToCandidate
// drops any citationId not in the retrieved set), so `citationsGrounded` is TRUE BY CONSTRUCTION here —
// the real model-quality signal is `contentPresent` (did it state the grounded fact), `noForbiddenClaims`
// (did it fabricate), and `refusalCorrect` (did it refuse when it should). The hallucination-drop itself
// is covered deterministically in the worker adapter's own tests, not here.
const REAL_EVAL = process.env["SOW_COPILOT_REAL_EVAL"] === "1";
describe.skipIf(!REAL_EVAL)("REAL Claude Sonnet synthesis — grounding + citation (gated)", () => {
  const route: ProviderRoute = {
    provider: "claude",
    model: "claude-sonnet-5",
    endpoint: "https://api.anthropic.com",
    egressClass: "cloud",
  };
  it.each(COPILOT_EVAL_CORPUS)(
    "case stays grounded via the real adapter: $id",
    async (c) => {
      const { createClaudeCopilotSynthesis } = await import(
        "@sow/worker/api/procedures/copilotClaudeSynthesis"
      );
      const { createClaudeSubscriptionCompletion } = await import("@sow/providers");
      const synth = createClaudeCopilotSynthesis(createClaudeSubscriptionCompletion());
      const r = await synth.synthesize(c.context.workspaceId, c.question, c.context, route);
      expect(isOk(r), `${c.id}: synthesis failed`).toBe(true);
      if (isOk(r)) {
        const output: CopilotModelOutput = { answer: r.value.answer, citations: r.value.citations };
        const g = gradeCopilotAnswer(output, c.context, c.expect);
        expect(g.pass, `${c.id}: ${g.failures.join("; ")}`).toBe(true);
      }
    },
    60_000,
  );
});
