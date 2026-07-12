// C6 (b)-1 §13.10 — the on-request, READ-ONLY Copilot briefing skill bound to the workspace-scoped
// §9.4 Today read-model. It assembles this workspace's Today (recent activity + inbox) into a CANDIDATE
// context and runs it through the SAME governed synthesis core as answerCopilotQuestion (WS-8 re-guard →
// posture → egress veto → synthesis-on-veto-cleared-route → candidate/UI-safe gate). NO write, propose OFF.
// The governed-core reuse is single-sourced (runGovernedCopilotSynthesis) so the safety machinery cannot drift.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { Approval, DataOwner, EgressPolicy, ProviderRoute, WorkspaceType } from "@sow/contracts";
import { processorId } from "@sow/contracts";
import {
  createStubSynthesis,
  createLocalWorkspacePosture,
  createLocalRouteSelector,
  localWorkspacePosture,
  unknownWorkspace,
  type RetrievedContext,
  type CopilotSynthesisPort,
  type WorkspacePosture,
} from "../../../src/api/procedures/copilot";
import {
  answerCopilotBriefing,
  createFixtureBriefingRetrieval,
  createReadModelBriefingRetrieval,
  BRIEFING_DIRECTIVE,
  type CopilotBriefingDeps,
  type CopilotBriefingRetrievalPort,
  type BriefingTodayPort,
} from "../../../src/api/procedures/copilotBriefing";

const WS = "ws-personal";
const OTHER = "ws-employer";

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

/** A candidate Today context (blocks = UiSafe summaries, sources = citations to Today items). */
function todayCtx(workspaceId: string): RetrievedContext {
  return {
    workspaceId,
    blocks: ["Decision logged on the vendor review.", "3 items awaiting triage."],
    sources: [{ citationId: "chg:1", title: "Vendor review — decision" }],
  };
}

/** Briefing deps: fixture retrieval + reused governed-core fakes (local posture + local route ⇒ allow, no notice). */
function briefingDeps(
  retrieval: CopilotBriefingRetrievalPort,
  over: Partial<CopilotBriefingDeps> = {},
): CopilotBriefingDeps {
  return {
    retrieval,
    synthesis: createStubSynthesis(),
    workspacePosture: createLocalWorkspacePosture({ [WS]: localWorkspacePosture(WS) }),
    routeSelector: createLocalRouteSelector(),
    ...over,
  };
}

/** A synthesizer that MUST NOT run (pins fail-closed-before-synthesis). */
const neverSynth: CopilotSynthesisPort = {
  synthesize: () => {
    throw new Error("synthesis must not run on a fail-closed briefing");
  },
};

describe("answerCopilotBriefing — governed, read-only, WS-8 (§6/§7 · §9.4 Today)", () => {
  it("briefing_synthesizes_workspace_today_for_known_workspace — ok(UiSafeCopilotAnswer), cited", async () => {
    // spec(§9) happy path: assemble Today → governed synthesis → gated UI-safe answer.
    const r = await answerCopilotBriefing(briefingDeps(createFixtureBriefingRetrieval({ [WS]: todayCtx(WS) })), {
      workspaceId: WS,
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.answer.length).toBeGreaterThan(0);
      expect(r.value.citations[0]?.citationId).toBe("chg:1");
    }
  });

  it("briefing_unknown_workspace_fails_closed — err WORKSPACE_NOT_FOUND, no synthesis", async () => {
    // spec(§6) WS-8 fail-closed — an unknown workspace never synthesizes.
    const r = await answerCopilotBriefing(
      briefingDeps(createFixtureBriefingRetrieval({ [WS]: todayCtx(WS) }), { synthesis: neverSynth }),
      { workspaceId: OTHER },
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("briefing_reguards_foreign_workspace_context — foreign-scoped context ⇒ RETRIEVAL_SCOPE_MISMATCH", async () => {
    // spec(§6) defense-in-depth: a (buggy/malicious) retrieval handing back FOREIGN-scoped context fails closed.
    const foreignRetrieval: CopilotBriefingRetrievalPort = { assemble: () => ok(todayCtx(OTHER)) };
    const r = await answerCopilotBriefing(briefingDeps(foreignRetrieval, { synthesis: neverSynth }), {
      workspaceId: WS,
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("RETRIEVAL_SCOPE_MISMATCH");
  });

  it("briefing_no_raw_content_only_uisafe_items — the real adapter assembles ONLY UiSafe items + counts (no raw approval content)", async () => {
    // spec(rule 2) candidate-data + no-raw-bodies: workspaceCards/approvalInbox are RAW at the port
    // (redaction is the procedure's job), so the briefing assembles blocks from ONLY already-UiSafe
    // items (recentChanges/ingestion summaries) + a COUNT of approvals — never raw approval content.
    const RAW_APPROVAL_SECRET = "RAW_APPROVAL_PAYLOAD_should_never_surface";
    const fakeToday: BriefingTodayPort = {
      recentChanges: (ws) =>
        ws === WS
          ? ok([{ changeId: "chg:1", kind: "decision", summary: "Vendor review decision", occurredAt: "2026-07-12T00:00:00.000Z" }])
          : err(unknownWorkspace()),
      ingestionInbox: () => ok([{ sourceId: "src:1", type: "youtube", sensitivity: "normal", summary: "Parked video" }]),
      approvalInbox: () => ok([{ id: "apr:1", actionRef: RAW_APPROVAL_SECRET, status: "pending", channel: "mac" } as Approval]),
    };
    const adapter = createReadModelBriefingRetrieval(fakeToday);
    const assembled = await adapter.assemble(WS);
    expect(isOk(assembled)).toBe(true);
    if (isOk(assembled)) {
      expect(assembled.value.workspaceId).toBe(WS);
      // Raw approval content NEVER enters the assembled blocks (only a count).
      expect(assembled.value.blocks.some((b) => b.includes(RAW_APPROVAL_SECRET))).toBe(false);
      // The already-UiSafe recentChange + ingestion summaries DO.
      expect(assembled.value.blocks.some((b) => b.includes("Vendor review decision"))).toBe(true);
      expect(assembled.value.blocks.some((b) => b.includes("Parked video"))).toBe(true);
    }
    // End-to-end: the served answer never echoes the raw approval secret either.
    const r = await answerCopilotBriefing(briefingDeps(adapter), { workspaceId: WS });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(JSON.stringify(r.value).includes(RAW_APPROVAL_SECRET)).toBe(false);
  });

  it("briefing_no_raw_adapter_fails_closed_on_unknown_workspace — the real adapter fails closed (WS-8)", async () => {
    // spec(§6) the real read-model adapter's own WS-8 fail-closed (recentChanges err short-circuits).
    const fakeToday: BriefingTodayPort = {
      recentChanges: () => err(unknownWorkspace()),
      ingestionInbox: () => ok([]),
      approvalInbox: () => ok([]),
    };
    const r = await createReadModelBriefingRetrieval(fakeToday).assemble(OTHER);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("briefing_empty_today_still_gates_ok — the launch state (0 recent / 0 ingestion / 0 approvals) assembles + gates ok", async () => {
    // spec(§9) empty-until-producer launch state (boot documents this): no rows ⇒ count-only blocks +
    // [] sources ⇒ the stub emits a valid 1-line answer that passes the candidate gate. Pins the
    // documented launch behavior so a future citations.min(1) / stub tweak can't silently break it.
    const emptyToday: BriefingTodayPort = {
      recentChanges: () => ok([]),
      ingestionInbox: () => ok([]),
      approvalInbox: () => ok([]),
    };
    const adapter = createReadModelBriefingRetrieval(emptyToday);
    const assembled = await adapter.assemble(WS);
    expect(isOk(assembled)).toBe(true);
    if (isOk(assembled)) {
      expect(assembled.value.workspaceId).toBe(WS);
      expect(assembled.value.sources).toEqual([]);
      expect(assembled.value.blocks.some((b) => b.includes("0 approval"))).toBe(true);
      expect(assembled.value.blocks.some((b) => b.includes("0 item"))).toBe(true);
    }
    const r = await answerCopilotBriefing(briefingDeps(adapter), { workspaceId: WS });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.answer.length).toBeGreaterThan(0);
  });

  it("briefing_egress_vetoed_employer_work_cloud_ack_off — fails closed BEFORE synthesis (no provider call)", async () => {
    // spec(rule 5) egress veto governs the briefing: employer-work + cloud + ack OFF ⇒ DENY, no synthesis.
    const r = await answerCopilotBriefing(
      briefingDeps(createFixtureBriefingRetrieval({ [WS]: todayCtx(WS) }), {
        synthesis: neverSynth,
        workspacePosture: createLocalWorkspacePosture({ [WS]: posture(employerWs, egressPolicy({ employerRawEgressAcknowledged: false })) }),
        routeSelector: createLocalRouteSelector(cloudRoute),
      }),
      { workspaceId: WS },
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });

  it("briefing_employer_work_cloud_egress_notice — an allowed employer-work cloud route threads egressProcessor", async () => {
    // spec(rule 5) the Employer-Work notice threads onto the answer (employer-work + cloud + ack ON).
    const r = await answerCopilotBriefing(
      briefingDeps(createFixtureBriefingRetrieval({ [WS]: todayCtx(WS) }), {
        workspacePosture: createLocalWorkspacePosture({ [WS]: posture(employerWs, egressPolicy({ employerRawEgressAcknowledged: true })) }),
        routeSelector: createLocalRouteSelector(cloudRoute),
      }),
      { workspaceId: WS },
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.egressProcessor).toBe("claude");
  });

  it("briefing_reuses_governed_core_not_reimplemented — synthesis gets the veto-CLEARED route + the briefing directive", async () => {
    // spec(§7) structural: routing through the SAME governed core means the spy synth sees the vetoed
    // cloud route (only reachable via decideCopilotEgress) + the fixed BRIEFING_DIRECTIVE as its question.
    let receivedRoute: ProviderRoute | null = null;
    let receivedQuestion: string | null = null;
    const spySynth: CopilotSynthesisPort = {
      synthesize: (_ws, question, _ctx, route) => {
        receivedRoute = route;
        receivedQuestion = question;
        return ok({ answer: ["ok"], citations: [] });
      },
    };
    await answerCopilotBriefing(
      briefingDeps(createFixtureBriefingRetrieval({ [WS]: todayCtx(WS) }), {
        synthesis: spySynth,
        workspacePosture: createLocalWorkspacePosture({ [WS]: posture(employerWs, egressPolicy({ employerRawEgressAcknowledged: true })) }),
        routeSelector: createLocalRouteSelector(cloudRoute),
      }),
      { workspaceId: WS },
    );
    expect(receivedRoute).toBe(cloudRoute);
    expect(receivedQuestion).toBe(BRIEFING_DIRECTIVE);
  });
});
