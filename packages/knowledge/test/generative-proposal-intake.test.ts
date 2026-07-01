// spec(§6) — GenerativeProposalIntake (task 4.18): the ONLY path a generative
// output reaches canonical state — propose-only, non-circular. Generative output
// (a SoW worker ModelProviderPort/AgentJob call over read-only, ServingGate-filtered
// context — NEVER gbrain in-engine synthesize/dream) → GBrainProposedFact candidate
// → JSON-Schema + no-inference gate (REQ-F-017) → KnowledgeMutationPlan
// (provenanceOrigin='gbrain_proposal', requiresApproval default-true) → KnowledgeWriter.
// Evidence MUST cite already-canonical Markdown / an ingested SourceEnvelope; the
// proposal's own scratch origin is recorded for audit but INADMISSIBLE as support.
// auto-write-and-serve modes are HARD-DISABLED. Pure/deterministic, typed Result.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import type { CanonicalSourceRef } from "@sow/contracts";
import {
  intakeGenerativeProposal,
  runGenerativeProposal,
  type RawGenerativeCandidate,
  type GenerativeIntakeDeps,
  type ModelProviderPort,
} from "../src/gbrain/remediation/generative-proposal-intake";

const WS = "ws-employer";

function proposal(over: Record<string, unknown> = {}): unknown {
  return {
    proposalId: "prop-1",
    workspaceId: WS,
    factKind: "page",
    proposedContent: { path: "notes/idea.md", body: "synthesized body", title: "Idea" },
    evidenceRefs: [{ kind: "markdown", ref: "notes/source.md", span: "L1-L5" }],
    confidence: 0.8,
    generatedBy: "synthesis",
    ...over,
  };
}

function candidate(over: Partial<RawGenerativeCandidate> = {}): RawGenerativeCandidate {
  return {
    proposal: over.proposal ?? proposal(),
    scratchOrigin: over.scratchOrigin ?? "scratch:brain/tmp-42#L9",
    containedContext: over.containedContext ?? true,
  };
}

let n = 0;
const deps: GenerativeIntakeDeps = {
  isEvidenceAdmissible: () => true,
  newPlanId: () => `plan-${(n += 1)}`,
};

describe("GenerativeProposalIntake — happy path (propose-only → plan requiring approval)", () => {
  it("produces a KnowledgeMutationPlan with provenanceOrigin='gbrain_proposal', gbrainProposalRef, and evidence-derived sourceRefs", () => {
    const r = intakeGenerativeProposal(candidate(), deps);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const { plan } = r.value;
    expect(plan.provenanceOrigin).toBe("gbrain_proposal");
    expect(plan.gbrainProposalRef as string).toBe("prop-1");
    expect(plan.workspaceId as string).toBe(WS);
    expect(plan.sourceRefs.map((s) => s.sourceId as string)).toEqual(["notes/source.md"]);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]?.path).toBe("notes/idea.md");
  });

  it("HARD-DISABLES auto-write-and-serve: requiresApproval on the produced plan is TRUE even when the proposal says false", () => {
    const r = intakeGenerativeProposal(candidate({ proposal: proposal({ requiresApproval: false }) }), deps);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.plan.requiresApproval).toBe(true);
  });

  it("records the scratch origin for audit but NEVER admits it into sourceRefs (non-circular)", () => {
    const r = intakeGenerativeProposal(candidate(), deps);
    if (!isOk(r)) throw new Error("expected ok");
    expect(r.value.scratchOriginAudited).toBe("scratch:brain/tmp-42#L9");
    for (const s of r.value.plan.sourceRefs) {
      expect(s.sourceId as string).not.toContain("scratch");
    }
  });

  it("maps a source_envelope evidence ref to a plan sourceRef", () => {
    const p = proposal({ evidenceRefs: [{ kind: "source_envelope", ref: "src-envelope-7" }] });
    const r = intakeGenerativeProposal(candidate({ proposal: p }), deps);
    if (!isOk(r)) throw new Error("expected ok");
    expect(r.value.plan.sourceRefs.map((s) => s.sourceId as string)).toEqual(["src-envelope-7"]);
  });
});

describe("GenerativeProposalIntake — non-circular evidence + contained-context enforcement", () => {
  it("rejects an UNCONTAINED generation (context was not ServingGate-filtered)", () => {
    const r = intakeGenerativeProposal(candidate({ containedContext: false }), deps);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("uncontained_generation");
  });

  it("rejects when an evidence ref is INADMISSIBLE (not already-canonical Markdown / not an ingested SourceEnvelope)", () => {
    const strict: GenerativeIntakeDeps = { ...deps, isEvidenceAdmissible: () => false };
    const r = intakeGenerativeProposal(candidate(), strict);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("inadmissible_evidence");
  });

  it("the scratch origin can never be laundered in as evidence: an empty evidenceRefs proposal is schema-rejected (≥1 canonical ref)", () => {
    const r = intakeGenerativeProposal(candidate({ proposal: proposal({ evidenceRefs: [] }) }), deps);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("schema_rejected");
  });
});

describe("GenerativeProposalIntake — JSON-Schema gate", () => {
  it("rejects a schema-invalid proposal (confidence out of [0,1])", () => {
    const r = intakeGenerativeProposal(candidate({ proposal: proposal({ confidence: 1.5 }) }), deps);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("schema_rejected");
  });

  it("rejects an incomplete page proposal (proposedContent missing body) rather than inventing content (no-inference)", () => {
    const p = proposal({ proposedContent: { path: "notes/idea.md" } });
    const r = intakeGenerativeProposal(candidate({ proposal: p }), deps);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("proposed_content_incomplete");
  });
});

describe("GenerativeProposalIntake — ModelProviderPort inversion (P5)", () => {
  it("runGenerativeProposal consumes the in-package ModelProviderPort and intakes its output", async () => {
    const contained: readonly CanonicalSourceRef[] = [{ kind: "markdown", ref: "notes/source.md" }];
    const port: ModelProviderPort = {
      async generate() {
        return { proposal: proposal(), scratchOrigin: "scratch:brain/tmp-9" };
      },
    };
    const r = await runGenerativeProposal(
      port,
      { workspaceId: WS, capability: "gbrain.synthesis", containedContext: contained },
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.plan.provenanceOrigin).toBe("gbrain_proposal");
    expect(r.value.plan.requiresApproval).toBe(true);
  });
});
