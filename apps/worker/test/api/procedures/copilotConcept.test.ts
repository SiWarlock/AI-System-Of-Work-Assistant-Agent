// C6 (b)-2 §13.10 — the on-request, READ-ONLY Copilot CONCEPT-synthesis skill. Given a concept term it
// retrieves the asking workspace's KNOWLEDGE for it and synthesizes a governed explanation through the SAME
// single-sourced governed core as answerCopilotQuestion / answerCopilotBriefing (runGovernedCopilotSynthesis:
// WS-8 re-guard → posture → egress veto → synthesis-on-veto-cleared-route → candidate/UI-safe gate). NO write,
// propose OFF. The concept term is CLIENT input (bounded at parseConceptInput — tested via the router in
// queries.test.ts) → same injection posture as Q&A, governed by the egress veto + candidate gate.
import { describe, it, expect } from "vitest";
import { ok, isOk, isErr } from "@sow/contracts";
import type { DataOwner, EgressPolicy, ProviderRoute, WorkspaceType } from "@sow/contracts";
import { processorId } from "@sow/contracts";
import {
  createFixtureRetrieval,
  createStubSynthesis,
  createLocalWorkspacePosture,
  createLocalRouteSelector,
  localWorkspacePosture,
  type RetrievedContext,
  type CopilotDeps,
  type CopilotRetrievalPort,
  type CopilotSynthesisPort,
  type WorkspacePosture,
} from "../../../src/api/procedures/copilot";
import {
  answerCopilotConcept,
  conceptDirective,
  type CopilotConceptInput,
} from "../../../src/api/procedures/copilotConcept";

const WS = "ws-personal";
const OTHER = "ws-employer";
const CONCEPT = "vendor SLA policy";

const cloudRoute: ProviderRoute = { provider: "claude", model: "claude-opus-4", endpoint: "https://api.anthropic.com", egressClass: "cloud" };
const employerWs: { type: WorkspaceType; dataOwner: DataOwner } = { type: "employer_work", dataOwner: "employer" };
const egressPolicy = (over: Partial<EgressPolicy> = {}): EgressPolicy => ({
  workspaceId: WS as EgressPolicy["workspaceId"],
  allowedProcessors: [processorId("claude")],
  rawContentAllowedProcessors: [processorId("claude")],
  employerRawEgressAcknowledged: false,
  ...over,
});
const posture = (ws: { type: WorkspaceType; dataOwner: DataOwner }, egress: EgressPolicy): WorkspacePosture => ({
  type: ws.type,
  dataOwner: ws.dataOwner,
  egress,
});

function ctx(workspaceId: string): RetrievedContext {
  return {
    workspaceId,
    blocks: ["A decision was logged on the vendor SLA."],
    sources: [{ citationId: "src:note-1", title: "Vendor review — decisions" }],
  };
}

/** Concept deps: the SAME CopilotDeps as Q&A (knowledge retrieval + the shared governed core). */
function conceptDeps(retrieval: CopilotRetrievalPort, over: Partial<CopilotDeps> = {}): CopilotDeps {
  return {
    retrieval,
    synthesis: createStubSynthesis(),
    workspacePosture: createLocalWorkspacePosture({ [WS]: localWorkspacePosture(WS) }),
    routeSelector: createLocalRouteSelector(),
    ...over,
  };
}

const neverSynth: CopilotSynthesisPort = {
  synthesize: () => {
    throw new Error("synthesis must not run on a fail-closed concept request");
  },
};

describe("answerCopilotConcept — governed, read-only, WS-8 (§6/§7 · workspace knowledge)", () => {
  it("concept_synthesizes_for_known_workspace — ok(UiSafeCopilotAnswer), cited", async () => {
    // spec(§6/§7) happy path: retrieve knowledge for the concept → governed synthesis → gated answer.
    const r = await answerCopilotConcept(conceptDeps(createFixtureRetrieval({ [WS]: ctx(WS) })), {
      workspaceId: WS,
      concept: CONCEPT,
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.answer.length).toBeGreaterThan(0);
      expect(r.value.citations[0]?.citationId).toBe("src:note-1");
    }
  });

  it("concept_unknown_workspace_fails_closed — err WORKSPACE_NOT_FOUND, no synthesis", async () => {
    // spec(§6) WS-8 fail-closed — an unknown workspace never synthesizes.
    const r = await answerCopilotConcept(
      conceptDeps(createFixtureRetrieval({ [WS]: ctx(WS) }), { synthesis: neverSynth }),
      { workspaceId: OTHER, concept: CONCEPT },
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("concept_reguards_foreign_workspace_context — foreign-scoped ctx ⇒ RETRIEVAL_SCOPE_MISMATCH", async () => {
    // spec(§6) defense-in-depth: a mis-keyed retrieval handing back FOREIGN-scoped context fails closed.
    const r = await answerCopilotConcept(
      conceptDeps(createFixtureRetrieval({ [WS]: ctx(OTHER) }), { synthesis: neverSynth }),
      { workspaceId: WS, concept: CONCEPT },
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("RETRIEVAL_SCOPE_MISMATCH");
  });

  it("concept_term_is_retrieval_query_and_directive — the term is the retrieval query AND folded into the directive", async () => {
    // spec(concept-framing) the concept term drives retrieval (retrieve(ws, concept)) AND is folded into the
    // server-fixed CONCEPT_DIRECTIVE passed to synthesis (a spy retrieval + spy synthesis both see it).
    let retrievalQuery: string | null = null;
    const spyRetrieval: CopilotRetrievalPort = {
      retrieve: (_ws, query) => {
        retrievalQuery = query;
        return ok(ctx(WS));
      },
    };
    let synthQuestion: string | null = null;
    const spySynth: CopilotSynthesisPort = {
      synthesize: (_ws, question, _ctx, _route) => {
        synthQuestion = question;
        return ok({ answer: ["ok"], citations: [] });
      },
    };
    await answerCopilotConcept(conceptDeps(spyRetrieval, { synthesis: spySynth }), { workspaceId: WS, concept: CONCEPT });
    expect(retrievalQuery).toBe(CONCEPT); // raw term is the retrieval query
    expect(synthQuestion).toBe(conceptDirective(CONCEPT)); // framed directive (which embeds the term) is the synthesis question
    expect(synthQuestion).toContain(CONCEPT);
  });

  it("concept_egress_vetoed_employer_work_cloud_ack_off — fails closed BEFORE synthesis (no provider call)", async () => {
    // spec(rule 5) egress veto governs the concept answer: employer-work + cloud + ack OFF ⇒ DENY, no synthesis.
    const r = await answerCopilotConcept(
      conceptDeps(createFixtureRetrieval({ [WS]: ctx(WS) }), {
        synthesis: neverSynth,
        workspacePosture: createLocalWorkspacePosture({ [WS]: posture(employerWs, egressPolicy({ employerRawEgressAcknowledged: false })) }),
        routeSelector: createLocalRouteSelector(cloudRoute),
      }),
      { workspaceId: WS, concept: CONCEPT },
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });

  it("concept_employer_work_cloud_egress_notice — an allowed employer-work cloud route threads egressProcessor", async () => {
    // spec(rule 5 / P1.2b) the Employer-Work notice threads onto the answer (employer-work + cloud + ack ON).
    const r = await answerCopilotConcept(
      conceptDeps(createFixtureRetrieval({ [WS]: ctx(WS) }), {
        workspacePosture: createLocalWorkspacePosture({ [WS]: posture(employerWs, egressPolicy({ employerRawEgressAcknowledged: true })) }),
        routeSelector: createLocalRouteSelector(cloudRoute),
      }),
      { workspaceId: WS, concept: CONCEPT },
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.egressProcessor).toBe("claude");
  });

  it("concept_reuses_governed_core — synthesis gets the veto-CLEARED route (single-sourced, no drift)", async () => {
    // spec(§7) structural: routing through the SAME governed core means the spy synth sees the vetoed cloud route.
    let receivedRoute: ProviderRoute | null = null;
    const spySynth: CopilotSynthesisPort = {
      synthesize: (_ws, _q, _ctx, route) => {
        receivedRoute = route;
        return ok({ answer: ["ok"], citations: [] });
      },
    };
    await answerCopilotConcept(
      conceptDeps(createFixtureRetrieval({ [WS]: ctx(WS) }), {
        synthesis: spySynth,
        workspacePosture: createLocalWorkspacePosture({ [WS]: posture(employerWs, egressPolicy({ employerRawEgressAcknowledged: true })) }),
        routeSelector: createLocalRouteSelector(cloudRoute),
      }),
      { workspaceId: WS, concept: CONCEPT },
    );
    expect(receivedRoute).toBe(cloudRoute);
  });
});
