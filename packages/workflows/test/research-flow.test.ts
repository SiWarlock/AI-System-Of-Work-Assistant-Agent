// spec(13.14, §7 RES-2, REQ-F-017/022) — /research: ONE RES-1 dossier → candidate
// gate → a single KnowledgeMutationPlan note-create → KnowledgeWriter.
//
// The DRIVER is pure (no @temporalio, no node:crypto, no Date.now) — every port
// is INJECTED (dormant over a faked RunResearchQueryPort — §ARM-RESEARCH stays
// owner-gated; this pins the FLOW MACHINERY only). Mirrors the 7.6-template
// drivers (copilotQa.ts, connectorSyncHealth.ts): a local total state machine,
// resolveRun idempotency, every failure routed through the health sink.
import { describe, it, expect, vi } from "vitest";
import { ok, err, workspaceId, sourceId, workflowId, planId } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { runResearch, researchMachine } from "../src/workflows/research";
import type {
  ResearchInput,
  ResearchDeps,
} from "../src/workflows/research";
import type {
  ResearchQuery,
  ResearchDossier,
  ResearchQueryFailure,
  RunResearchQueryPort,
  BuildResearchNotePlanPort,
  BuildResearchNoteFailure,
  CommitKnowledgePort,
  KnowledgeCommitSuccess,
  KnowledgeCommitFailure,
  ResearchHealthSink,
  ResearchFailure,
} from "../src/ports/research";
import type { Clock, WorkflowRunRefRepository } from "../src/ports/operational";
import type { WorkflowRunRef } from "@sow/contracts";
import type { DbResult } from "../src/ports/operational";
import type { KnowledgeMutationPlan } from "@sow/contracts";

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

const DOSSIER: ResearchDossier = {
  validated: true,
  query: "Rust async runtimes 2026",
  summary: "Tokio remains dominant.",
  citations: [{ url: "https://example.com/a", title: "Async Rust Survey" }],
};

const PLAN: KnowledgeMutationPlan = {
  planId: planId("plan-research-1"),
  workspaceId: workspaceId("ws-1"),
  sourceRefs: [{ sourceId: sourceId("research-run-1") }],
  creates: [{ path: "Research/Web/ws-1/rust-async-runtimes-2026.md", body: "# body" }],
  patches: [],
  linkMutations: [],
  frontmatterUpdates: [],
  externalActionProposals: [],
  confidence: 1,
  requiresApproval: false,
  provenanceOrigin: "ingestion",
};

function queryReturning(result: Result<ResearchDossier, ResearchQueryFailure>): RunResearchQueryPort {
  return { run: vi.fn(() => Promise.resolve(result)) };
}

function buildPlanReturning(
  result: Result<KnowledgeMutationPlan, BuildResearchNoteFailure>,
): BuildResearchNotePlanPort {
  return { build: vi.fn(() => Promise.resolve(result)) };
}

function commitReturning(
  result: Result<KnowledgeCommitSuccess, KnowledgeCommitFailure>,
): CommitKnowledgePort {
  return { commit: vi.fn(() => Promise.resolve(result)) };
}

const QUERY: ResearchQuery = { workspaceId: workspaceId("ws-1"), text: "Rust async runtimes 2026" };

function baseInput(overrides: Partial<ResearchInput> = {}): ResearchInput {
  return {
    run: {
      workflowId: workflowId("wf-research-1"),
      trigger: "owner_action",
      workspaceId: "ws-1",
      idempotencyKey: "idem-research-1",
    },
    query: QUERY,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ResearchDeps> = {}): ResearchDeps {
  return {
    query: queryReturning(ok(DOSSIER)),
    buildPlan: buildPlanReturning(ok(PLAN)),
    commit: commitReturning(ok({ revisionId: "rev-1", replayed: false })),
    health: makeHealthSink().sink,
    runs: makeRuns(),
    clock: makeClock(),
    ...overrides,
  };
}

describe("spec(§9) researchMachine — pure + total", () => {
  it("walks the happy edge received → queried → planned → done", () => {
    let s = researchMachine.transition("received", "queried");
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    s = researchMachine.transition(s.value, "planned");
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    s = researchMachine.transition(s.value, "done");
    expect(s.ok).toBe(true);
  });

  it("rejects the forbidden edge received → done (query + plan cannot be skipped)", () => {
    const s = researchMachine.transition("received", "done");
    expect(s.ok).toBe(false);
  });
});

describe("spec(13.14) /research happy path — a dossier lands as a committed candidate note", () => {
  it("queries RES-1, builds the plan, commits it, and reaches done with a revisionId", async () => {
    const query = queryReturning(ok(DOSSIER));
    const buildPlan = buildPlanReturning(ok(PLAN));
    const commit = commitReturning(ok({ revisionId: "rev-42", replayed: false }));
    const { sink, surfaced } = makeHealthSink();

    const out = await runResearch(baseInput(), makeDeps({ query, buildPlan, commit, health: sink }));

    expect(out.state).toBe("done");
    expect(out.revisionId).toBe("rev-42");
    expect(surfaced).toHaveLength(0);
    expect((query.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(QUERY);
    expect((buildPlan.build as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(DOSSIER, QUERY.workspaceId);
    expect((commit.commit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(PLAN);
  });
});

describe("spec(13.14) /research failure branches — every failure surfaces, nothing silent", () => {
  it("a provider_failed RES-1 query parks in query_failed and surfaces (no plan built, no commit)", async () => {
    const query = queryReturning(err<ResearchQueryFailure>({ code: "provider_failed", message: "boom" }));
    const buildPlan = buildPlanReturning(ok(PLAN));
    const commit = commitReturning(ok({ revisionId: "rev-1", replayed: false }));
    const { sink, surfaced } = makeHealthSink();

    const out = await runResearch(baseInput(), makeDeps({ query, buildPlan, commit, health: sink }));

    expect(out.state).toBe("query_failed");
    expect(surfaced).toHaveLength(1);
    expect((buildPlan.build as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((commit.commit as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("an egress_vetoed RES-1 query fails CLOSED — never a cloud fallback, no partial side effect", async () => {
    const query = queryReturning(err<ResearchQueryFailure>({ code: "egress_vetoed", message: "employer-work ack off" }));
    const buildPlan = buildPlanReturning(ok(PLAN));
    const commit = commitReturning(ok({ revisionId: "rev-1", replayed: false }));
    const { sink, surfaced } = makeHealthSink();

    const out = await runResearch(baseInput(), makeDeps({ query, buildPlan, commit, health: sink }));

    expect(out.state).toBe("query_failed");
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.failureClass).toBe("egress_denied");
    expect((commit.commit as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("a plan-derivation path_escape failure parks in plan_failed and surfaces (no commit)", async () => {
    const query = queryReturning(ok(DOSSIER));
    const buildPlan = buildPlanReturning(
      err<BuildResearchNoteFailure>({ code: "path_escape", message: "unsafe path" }),
    );
    const commit = commitReturning(ok({ revisionId: "rev-1", replayed: false }));
    const { sink, surfaced } = makeHealthSink();

    const out = await runResearch(baseInput(), makeDeps({ query, buildPlan, commit, health: sink }));

    expect(out.state).toBe("plan_failed");
    expect(surfaced).toHaveLength(1);
    expect((commit.commit as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("a KnowledgeWriter write_conflict parks in commit_rejected and surfaces via the SHARED commitFailureClass mapper", async () => {
    const query = queryReturning(ok(DOSSIER));
    const buildPlan = buildPlanReturning(ok(PLAN));
    const commit = commitReturning(
      err<KnowledgeCommitFailure>({ code: "write_conflict", message: "stale revision" }),
    );
    const { sink, surfaced } = makeHealthSink();

    const out = await runResearch(baseInput(), makeDeps({ query, buildPlan, commit, health: sink }));

    expect(out.state).toBe("commit_rejected");
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.failureClass).toBe("write_through_failed");
  });

  it("a secret_found rejection maps through the SAME shared mapper to security_violation", async () => {
    const query = queryReturning(ok(DOSSIER));
    const buildPlan = buildPlanReturning(ok(PLAN));
    const commit = commitReturning(
      err<KnowledgeCommitFailure>({ code: "secret_found", message: "leaked token" }),
    );
    const { sink, surfaced } = makeHealthSink();

    const out = await runResearch(baseInput(), makeDeps({ query, buildPlan, commit, health: sink }));

    expect(out.state).toBe("commit_rejected");
    expect(surfaced[0]!.failureClass).toBe("security_violation");
  });
});

describe("spec(inv-5) /research idempotent replay", () => {
  it("a seen idempotencyKey reuses the existing run", async () => {
    const runs = makeRuns();
    const deps = makeDeps({ runs });
    const first = await runResearch(baseInput(), deps);
    expect(first.runReused).toBe(false);
    const second = await runResearch(baseInput(), deps);
    expect(second.runReused).toBe(true);
  });
});
