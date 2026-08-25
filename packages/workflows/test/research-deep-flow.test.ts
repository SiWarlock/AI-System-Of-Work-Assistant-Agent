// spec(13.14, §7 RES-2, §6 KN-10, REQ-F-017/022) — /research-deep: the vault-first
// 5-phase governed flow. Phase 1 (SCAN) is zero-egress; phases 2-4 (ANALYZE
// GAPS / FILL GAPS / SYNTHESIZE DELTA) are egress-classed RES-1 calls; phase 5
// (PROPAGATE) entity-grounds + plans each recommended update (13.8a/13.8c, BOTH
// packages/knowledge territory) behind ONE injected port, and THIS driver's job
// is tier routing only: AUTO commits, PROPOSE routes to §9.8 approval, and a
// WITHHELD (unresolved-entity) item is surfaced — NEVER fabricated into a
// commit (13.8a's "ground before write" contract, pinned at this boundary).
//
// The DRIVER is pure — same 7.6-template shape as research.ts/copilotQa.ts —
// every port injected/faked, §ARM-RESEARCH stays owner-gated (this pins the
// FLOW MACHINERY only).
import { describe, it, expect, vi } from "vitest";
import { ok, err, workspaceId, planId, workflowId } from "@sow/contracts";
import type { Result, KnowledgeMutationPlan } from "@sow/contracts";
import { runResearchDeep, researchDeepMachine } from "../src/workflows/researchDeep";
import type { ResearchDeepInput, ResearchDeepDeps } from "../src/workflows/researchDeep";
import type {
  VaultBaseline,
  ScanVaultPort,
  ScanVaultFailure,
  AnalyzeGapsPort,
  AnalyzeGapsFailure,
  GapQuery,
  FillGapsPort,
  SynthesizeDeltaPort,
  SynthesizeDeltaFailure,
  SynthesisDelta,
  PropagateResearchPort,
  PropagateResearchFailure,
  PropagatedUpdateOutcome,
} from "../src/ports/researchDeep";
import type {
  ResearchDossier,
  ResearchQueryFailure,
  CommitKnowledgePort,
  KnowledgeCommitSuccess,
  KnowledgeCommitFailure,
  ProposeKnowledgeApprovalPort,
  ProposeKnowledgeApprovalResult,
  ProposeKnowledgeApprovalError,
  ResearchHealthSink,
  ResearchFailure,
} from "../src/ports/research";
import type { Clock, WorkflowRunRefRepository } from "../src/ports/operational";
import type { WorkflowRunRef } from "@sow/contracts";
import type { DbResult } from "../src/ports/operational";

const NOW = "2026-08-25T12:00:00.000Z";
function makeClock(now: string = NOW): Clock {
  return { now: () => now };
}

function makeRuns(): WorkflowRunRefRepository {
  const store = new Map<string, WorkflowRunRef>();
  const notFound = { ok: false as const, error: { code: "not_found" as const, message: "nf" } };
  return {
    getByIdempotencyKey: vi.fn((k: string): DbResult<WorkflowRunRef> => {
      const hit = store.get(k);
      return Promise.resolve(hit ? ok(hit) : notFound);
    }),
    create: vi.fn((r: WorkflowRunRef): DbResult<WorkflowRunRef> => {
      store.set(r.idempotencyKey, r);
      return Promise.resolve(ok(r));
    }),
    get: vi.fn((): DbResult<WorkflowRunRef> => Promise.resolve(notFound)),
    update: vi.fn((r: WorkflowRunRef): DbResult<WorkflowRunRef> => Promise.resolve(ok(r))),
  } as unknown as WorkflowRunRefRepository;
}

function makeHealthSink(): { sink: ResearchHealthSink; surfaced: ResearchFailure[] } {
  const surfaced: ResearchFailure[] = [];
  const sink: ResearchHealthSink = {
    surface: vi.fn((f: ResearchFailure) => {
      surfaced.push(f);
      return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
    }),
  };
  return { sink, surfaced };
}

const WS = workspaceId("ws-1");
const TOPIC = "Rust async runtimes 2026";

const BASELINE: VaultBaseline = { notes: [{ path: "Research/Web/ws-1/prior.md", summary: "prior note" }] };
const GAP_QUERIES: readonly GapQuery[] = [{ text: "tokio vs smol 2026" }, { text: "embedded rust async 2026" }];
const GAP_DOSSIER: ResearchDossier = {
  validated: true,
  query: "tokio vs smol 2026",
  summary: "tokio still dominant",
  citations: [{ url: "https://example.com/x" }],
};
const DELTA: SynthesisDelta = {
  summary: "smol gaining embedded share",
  recommendedUpdates: [
    { entityName: "smol (crate)", change: "note embedded gains", citations: GAP_DOSSIER.citations },
  ],
};

function autoPlan(id: string): KnowledgeMutationPlan {
  return {
    planId: planId(id),
    workspaceId: WS,
    sourceRefs: [],
    creates: [{ path: `Research/Web/ws-1/${id}.md`, body: "body" }],
    patches: [],
    linkMutations: [],
    frontmatterUpdates: [],
    externalActionProposals: [],
    confidence: 1,
    requiresApproval: false,
    provenanceOrigin: "ingestion",
  };
}

function proposePlan(id: string): KnowledgeMutationPlan {
  return { ...autoPlan(id), requiresApproval: true };
}

function scanReturning(result: Result<VaultBaseline, ScanVaultFailure>): ScanVaultPort {
  return { scan: vi.fn(() => Promise.resolve(result)) };
}
function analyzeReturning(result: Result<readonly GapQuery[], AnalyzeGapsFailure>): AnalyzeGapsPort {
  return { analyze: vi.fn(() => Promise.resolve(result)) };
}
function fillReturning(result: Result<readonly ResearchDossier[], ResearchQueryFailure>): FillGapsPort {
  return { fill: vi.fn(() => Promise.resolve(result)) };
}
function synthesizeReturning(result: Result<SynthesisDelta, SynthesizeDeltaFailure>): SynthesizeDeltaPort {
  return { synthesize: vi.fn(() => Promise.resolve(result)) };
}
function propagateReturning(
  result: Result<readonly PropagatedUpdateOutcome[], PropagateResearchFailure>,
): PropagateResearchPort {
  return { propagate: vi.fn(() => Promise.resolve(result)) };
}
function commitCapturing(
  behavior: (plan: KnowledgeMutationPlan) => Result<KnowledgeCommitSuccess, KnowledgeCommitFailure>,
): { port: CommitKnowledgePort; calls: KnowledgeMutationPlan[] } {
  const calls: KnowledgeMutationPlan[] = [];
  return {
    port: { commit: vi.fn((p: KnowledgeMutationPlan) => { calls.push(p); return Promise.resolve(behavior(p)); }) },
    calls,
  };
}
function proposeCapturing(
  behavior: () => Result<ProposeKnowledgeApprovalResult, ProposeKnowledgeApprovalError>,
): { port: ProposeKnowledgeApprovalPort; calls: KnowledgeMutationPlan[] } {
  const calls: KnowledgeMutationPlan[] = [];
  return {
    port: { propose: vi.fn((p: KnowledgeMutationPlan) => { calls.push(p); return Promise.resolve(behavior()); }) },
    calls,
  };
}

function baseInput(overrides: Partial<ResearchDeepInput> = {}): ResearchDeepInput {
  return {
    run: {
      workflowId: workflowId("wf-research-deep-1"),
      trigger: "owner_action",
      workspaceId: "ws-1",
      idempotencyKey: "idem-research-deep-1",
    },
    workspaceId: WS,
    topic: TOPIC,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ResearchDeepDeps> = {}): ResearchDeepDeps {
  return {
    scan: scanReturning(ok(BASELINE)),
    analyzeGaps: analyzeReturning(ok(GAP_QUERIES)),
    fillGaps: fillReturning(ok([GAP_DOSSIER])),
    synthesizeDelta: synthesizeReturning(ok(DELTA)),
    propagate: propagateReturning(
      ok([{ kind: "grounded", entityName: "smol (crate)", plan: autoPlan("smol-plan") }]),
    ),
    commit: commitCapturing(() => ok({ revisionId: "rev-1", replayed: false })).port,
    health: makeHealthSink().sink,
    runs: makeRuns(),
    clock: makeClock(),
    ...overrides,
  };
}

describe("spec(§9) researchDeepMachine — pure + total", () => {
  it("walks the happy edge received → scanned → gaps_identified → gaps_filled → synthesized → propagated → done", () => {
    let s = researchDeepMachine.transition("received", "scanned");
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    s = researchDeepMachine.transition(s.value, "gaps_identified");
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    s = researchDeepMachine.transition(s.value, "gaps_filled");
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    s = researchDeepMachine.transition(s.value, "synthesized");
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    s = researchDeepMachine.transition(s.value, "propagated");
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    s = researchDeepMachine.transition(s.value, "done");
    expect(s.ok).toBe(true);
  });

  it("rejects skipping a phase (received → synthesized)", () => {
    const s = researchDeepMachine.transition("received", "synthesized");
    expect(s.ok).toBe(false);
  });
});

describe("spec(13.14) /research-deep happy path — scan → gaps → fill → synthesize → propagate", () => {
  it("walks all 5 phases and AUTO-commits a grounded update", async () => {
    const scan = scanReturning(ok(BASELINE));
    const analyzeGaps = analyzeReturning(ok(GAP_QUERIES));
    const fillGaps = fillReturning(ok([GAP_DOSSIER]));
    const synthesizeDelta = synthesizeReturning(ok(DELTA));
    const propagate = propagateReturning(
      ok([{ kind: "grounded", entityName: "smol (crate)", plan: autoPlan("smol-plan") }]),
    );
    const { port: commit, calls: committedPlans } = commitCapturing(() => ok({ revisionId: "rev-9", replayed: false }));
    const { sink, surfaced } = makeHealthSink();

    const out = await runResearchDeep(
      baseInput(),
      makeDeps({ scan, analyzeGaps, fillGaps, synthesizeDelta, propagate, commit, health: sink }),
    );

    expect(out.state).toBe("done");
    expect(surfaced).toHaveLength(0);
    expect(committedPlans.map((p) => String(p.planId))).toEqual(["smol-plan"]);
    expect(out.committed).toEqual(["smol (crate)"]);
    expect(out.queuedForApproval).toEqual([]);
    expect(out.withheld).toEqual([]);
    // each phase received the PREVIOUS phase's actual output, not a decoy.
    expect((analyzeGaps.analyze as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(BASELINE, TOPIC);
    expect((fillGaps.fill as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(GAP_QUERIES);
    expect((synthesizeDelta.synthesize as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(BASELINE, [GAP_DOSSIER], TOPIC);
    expect((propagate.propagate as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(DELTA, WS);
  });
});

describe("spec(13.14) /research-deep phase failures — fail-closed, nothing silent", () => {
  it("phase 1 scan_failed parks with NO downstream call made", async () => {
    const scan = scanReturning(err<ScanVaultFailure>({ code: "scan_failed", message: "gbrain unavailable" }));
    const analyzeGaps = analyzeReturning(ok(GAP_QUERIES));
    const { sink, surfaced } = makeHealthSink();

    const out = await runResearchDeep(baseInput(), makeDeps({ scan, analyzeGaps, health: sink }));

    expect(out.state).toBe("scan_failed");
    expect(surfaced).toHaveLength(1);
    expect((analyzeGaps.analyze as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("phase 2 egress_vetoed fails CLOSED — never a cloud fallback, no fill/synthesize/propagate call", async () => {
    const analyzeGaps = analyzeReturning(
      err<AnalyzeGapsFailure>({ code: "egress_vetoed", message: "employer-work ack off" }),
    );
    const fillGaps = fillReturning(ok([GAP_DOSSIER]));
    const { sink, surfaced } = makeHealthSink();

    const out = await runResearchDeep(baseInput(), makeDeps({ analyzeGaps, fillGaps, health: sink }));

    expect(out.state).toBe("gap_analysis_failed");
    expect(surfaced[0]!.failureClass).toBe("egress_denied");
    expect((fillGaps.fill as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("phase 3 gap_fill_failed parks with NO synthesize/propagate call", async () => {
    const fillGaps = fillReturning(err<ResearchQueryFailure>({ code: "provider_failed", message: "boom" }));
    const synthesizeDelta = synthesizeReturning(ok(DELTA));
    const { sink, surfaced } = makeHealthSink();

    const out = await runResearchDeep(baseInput(), makeDeps({ fillGaps, synthesizeDelta, health: sink }));

    expect(out.state).toBe("gap_fill_failed");
    expect(surfaced).toHaveLength(1);
    expect((synthesizeDelta.synthesize as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("phase 4 synthesis_failed parks with NO propagate call", async () => {
    const synthesizeDelta = synthesizeReturning(
      err<SynthesizeDeltaFailure>({ code: "schema_rejected", message: "malformed delta" }),
    );
    const propagate = propagateReturning(ok([]));
    const { sink, surfaced } = makeHealthSink();

    const out = await runResearchDeep(baseInput(), makeDeps({ synthesizeDelta, propagate, health: sink }));

    expect(out.state).toBe("synthesis_failed");
    expect((propagate.propagate as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("phase 5 PORT-LEVEL propagation_failed is terminal (distinct from a per-update withhold)", async () => {
    const propagate = propagateReturning(
      err<PropagateResearchFailure>({ code: "propagation_failed", message: "entity resolver unavailable" }),
    );
    const { port: commit, calls } = commitCapturing(() => ok({ revisionId: "rev-1", replayed: false }));
    const { sink, surfaced } = makeHealthSink();

    const out = await runResearchDeep(baseInput(), makeDeps({ propagate, commit, health: sink }));

    expect(out.state).toBe("propagation_failed");
    expect(surfaced).toHaveLength(1);
    expect(calls).toEqual([]);
  });
});

describe("spec(13.8a, 13.14) phase 5 — a withheld entity is surfaced, NEVER fabricated into a commit", () => {
  it("a withheld recommended update reaches propagated/done WITHOUT ever calling commit or propose for it", async () => {
    const propagate = propagateReturning(
      ok([{ kind: "withheld", entityName: "Ambiguous Corp", reason: "2+ candidate matches" }]),
    );
    const { port: commit, calls: committedPlans } = commitCapturing(() => ok({ revisionId: "rev-1", replayed: false }));
    const { port: propose, calls: proposedPlans } = proposeCapturing(() => ok({ approvalRef: "appr-1", created: true }));
    const { sink, surfaced } = makeHealthSink();

    const out = await runResearchDeep(
      baseInput(),
      makeDeps({ propagate, commit, health: sink, proposeKnowledgeApproval: propose }),
    );

    expect(out.state).toBe("done"); // best-effort — a withhold is NOT terminal
    expect(out.withheld).toEqual(["Ambiguous Corp"]);
    expect(out.committed).toEqual([]);
    expect(committedPlans).toEqual([]);
    expect(proposedPlans).toEqual([]);
    // the withhold IS surfaced (never silent) even though the run still reaches done.
    expect(surfaced.some((f) => f.message.includes("Ambiguous Corp"))).toBe(true);
  });
});

describe("spec(§6 KN-10, 13.14) phase 5 tier routing — AUTO commits, PROPOSE never reaches commit", () => {
  it("a_propose_tier_grounded_update_never_reaches_commit — the load-bearing safety pin", async () => {
    const propagate = propagateReturning(
      ok([{ kind: "grounded", entityName: "Human-Relevant Corp", plan: proposePlan("propose-only") }]),
    );
    const { port: commit, calls: committedPlans } = commitCapturing(() => ok({ revisionId: "rev-1", replayed: false }));
    const { port: propose, calls: proposedPlans } = proposeCapturing(() => ok({ approvalRef: "appr-1", created: true }));

    const out = await runResearchDeep(
      baseInput(),
      makeDeps({ propagate, commit, proposeKnowledgeApproval: propose }),
    );

    expect(committedPlans.map((p) => String(p.planId))).not.toContain("propose-only");
    expect(proposedPlans.map((p) => String(p.planId))).toEqual(["propose-only"]);
    expect(out.queuedForApproval).toEqual(["Human-Relevant Corp"]);
    expect(out.state).toBe("done");
  });

  it("an absent proposeKnowledgeApproval port fails closed: the PROPOSE plan is withheld AND surfaced, never auto-committed", async () => {
    const propagate = propagateReturning(
      ok([{ kind: "grounded", entityName: "Unbound Corp", plan: proposePlan("unbound-propose") }]),
    );
    const { port: commit, calls: committedPlans } = commitCapturing(() => ok({ revisionId: "rev-1", replayed: false }));
    const { sink, surfaced } = makeHealthSink();

    const out = await runResearchDeep(
      baseInput(),
      makeDeps({ propagate, commit, health: sink, proposeKnowledgeApproval: undefined }),
    );

    expect(committedPlans).toEqual([]);
    expect(out.queuedForApproval).toEqual([]);
    expect(surfaced).toHaveLength(1);
    expect(out.state).toBe("done");
  });

  it("a per-plan commit failure surfaces but does NOT fail the whole run (degrade-not-fail, best-effort)", async () => {
    const propagate = propagateReturning(
      ok([{ kind: "grounded", entityName: "Fails Corp", plan: autoPlan("fails-plan") }]),
    );
    const { port: commit } = commitCapturing(() =>
      err<KnowledgeCommitFailure>({ code: "write_conflict", message: "stale" }),
    );
    const { sink, surfaced } = makeHealthSink();

    const out = await runResearchDeep(baseInput(), makeDeps({ propagate, commit, health: sink }));

    expect(out.state).toBe("done");
    expect(out.committed).toEqual([]);
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.failureClass).toBe("write_through_failed");
  });
});

describe("spec(inv-5) /research-deep idempotent replay", () => {
  it("a seen idempotencyKey reuses the existing run", async () => {
    const runs = makeRuns();
    const deps = makeDeps({ runs });
    const first = await runResearchDeep(baseInput(), deps);
    expect(first.runReused).toBe(false);
    const second = await runResearchDeep(baseInput(), deps);
    expect(second.runReused).toBe(true);
  });
});
