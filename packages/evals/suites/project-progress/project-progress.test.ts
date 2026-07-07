// spec(§20.1 "Project progress" · REQ-F-011 · PRJ-3/4) — task 12.10.
//
// §20.1 ACCEPTANCE suite: PROJECT PROGRESS is a DETERMINISTIC PARSE, never a
// model estimate. Unlike the packages/workflows unit test (which drives the pure
// projectSync driver + activities in isolation), this ACCEPTANCE suite asserts the
// three §20.1 / task-12.10 bullets end-to-end over the REAL @sow/workflows
// deterministic-progress activities, the REAL @sow/workflows projectSync DRIVER,
// and the REAL @sow/domain no-inference gate — then SCORES the `PROJECT_PROGRESS`
// criterion through the EVAL-1 runner (task 12.1).
//
// DoD honesty: `PROJECT_PROGRESS` is `requiresRealIntegration=false` — the whole
// invariant is DETERMINISTIC enforcement (a pure checkbox parser + a pure
// derive-from-facts seam + a pure no-inference validator), so no live vendor is
// needed to certify it. The runner therefore reports it BOTH functionally-passing
// AND DoD-passing from this in-process run; the suite asserts exactly that.
//
// Acceptance criteria exercised (§20.1 / task 12.10 bullets):
//   (a) progress is computed DETERMINISTICALLY from checkbox / status counts — a
//       pure function of raw plan/provider text — NOT model-invented; identical
//       input ⇒ identical tally (replay-safe).
//   (b) the parser HARD-FAILS on ambiguous / unparseable status into a TYPED
//       failure state (parse_failed / ambiguous_status / connector_stale), never
//       silently zeroed or guessed; the driver folds each to its distinct machine
//       state with NO Markdown commit.
//   (c) model-invented blockers / next-actions are REJECTED (no-inference gate) and
//       a model-supplied percentage can NEVER become the committed number — the
//       committed progress is sourced ONLY from the deterministic parse.
import { describe, it, expect } from "vitest";
import {
  ok,
  err,
  isOk,
  workflowId,
  workspaceId,
  planId,
  sourceId,
} from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  WorkflowRunRef,
  KnowledgeMutationPlan,
} from "@sow/contracts";
import { validateNoInference, TBD } from "@sow/domain";
import {
  countCheckboxes,
  computePercent,
  createDeterministicProgressActivity,
  createBuildSyncOutputsActivity,
} from "@sow/workflows/activities/deterministicProgress";
import type {
  RawProgressReader,
  RawProgressSource,
  SyncOutputsProjection,
} from "@sow/workflows/activities/deterministicProgress";
import {
  runProjectSync,
  PROJECT_SYNC_STATES,
} from "@sow/workflows/workflows/projectSync";
import type {
  ProjectSyncInput,
  ProjectSyncDeps,
} from "@sow/workflows/workflows/projectSync";
import type {
  ProjectSyncContext,
  ProjectRegistryEntry,
  ResolveRegistryPort,
  ResolveRegistryError,
  ParseProgressPort,
  ParseProgressError,
  DeterministicProgress,
  SynthesizeNarrativePort,
  ProjectSyncSynthesizeFailure,
  ProgressNarrativeDraft,
  ValidateNarrativePort,
  ValidatedNarrative,
  NarrativeRejection,
  BuildSyncOutputsPort,
  CommitStatusPort,
  StatusCommitSuccess,
  StatusCommitFailure,
  ProjectSyncUpdateDashboardPort,
  ProjectSyncUpdateDashboardError,
  ProjectSyncProposeActionsPort,
  ProjectSyncProposeResult,
  ProjectSyncProposeError,
  ProjectSyncHealthSink,
  ProjectSyncFailure,
  ProjectSyncSurfaceOutcome,
  ProjectSyncHealthSinkError,
} from "@sow/workflows/ports/projectSync";
import type {
  Clock,
  WorkflowRunRefRepository,
  DbError,
  DbResult,
} from "@sow/workflows/ports/operational";
import { scoreById } from "../../src/harness/runner";
import { criterionById } from "../../src/harness/criteria-registry";

// ---------------------------------------------------------------------------
// Inline fixtures — pure literals only (no Date.now / Math.random), matching the
// exemplar's inline-fixture discipline. These fakes SATISFY the real port
// interfaces so the REAL driver runs in-process with no Temporal / DB / vendor.
// ---------------------------------------------------------------------------

const PROJECT_WS: WorkspaceId = workspaceId("ws-emp-acme");

const makeContext = (
  partial: Partial<ProjectSyncContext> = {},
): ProjectSyncContext => ({ projectRef: "acme-api", ...partial });

/** A raw-source reader (the REAL activity's injected I/O seam). */
const makeReader = (sources: readonly RawProgressSource[]): RawProgressReader => ({
  read(): Promise<Result<readonly RawProgressSource[], ParseProgressError>> {
    return Promise.resolve(ok(sources));
  },
});

const makeFailingReader = (code: ParseProgressError["code"]): RawProgressReader => ({
  read(): Promise<Result<readonly RawProgressSource[], ParseProgressError>> {
    return Promise.resolve(err({ code, message: `reader failed: ${code}` }));
  },
});

// --- trivial happy-path ports for the driver -------------------------------

class FakeRegistryPort implements ResolveRegistryPort {
  constructor(private readonly ws: WorkspaceId = PROJECT_WS) {}
  resolve(): Promise<Result<ProjectRegistryEntry, ResolveRegistryError>> {
    return Promise.resolve(
      ok({
        projectId: "acme-api",
        workspaceId: this.ws,
        planPath: "employer-work/acme-api/IMPLEMENTATION_PLAN.md",
        progressProviders: [],
        // §13.5 — the registry now seeds the sync outputs' project identity.
        title: "Acme API",
        slug: "employer-work/acme-api",
        lifecycleState: "active",
      }),
    );
  }
}

/** Emits a candidate narrative; the caller supplies the prose fields. */
class FakeSynthesizePort implements SynthesizeNarrativePort {
  constructor(private readonly draft: ProgressNarrativeDraft) {}
  synthesize(): Promise<Result<ProgressNarrativeDraft, ProjectSyncSynthesizeFailure>> {
    return Promise.resolve(ok(this.draft));
  }
}

/** The REAL domain no-inference gate wired behind the ValidateNarrativePort. */
class RealNoInferenceValidatePort implements ValidateNarrativePort {
  validate(
    draft: ProgressNarrativeDraft,
  ): Result<ValidatedNarrative, NarrativeRejection> {
    const checked = validateNoInference(draft.fields);
    if (!checked.ok) {
      return err({
        code: "no_inference_violation",
        message: "REQ-F-017: inferred/unsupported field(s)",
        rejections: checked.error,
      });
    }
    return ok({
      validated: true,
      fields: draft.fields,
      ...(draft.schemaId !== undefined ? { schemaId: draft.schemaId } : {}),
    });
  }
}

/** Records the plan the driver derived so a test can inspect the committed number. */
class CapturingCommitPort implements CommitStatusPort {
  lastPlan: KnowledgeMutationPlan | undefined;
  writeCount = 0;
  commit(
    plan: KnowledgeMutationPlan,
  ): Promise<Result<StatusCommitSuccess, StatusCommitFailure>> {
    this.lastPlan = plan;
    this.writeCount += 1;
    return Promise.resolve(ok({ revisionId: `rev-${this.writeCount}`, replayed: false }));
  }
}

class FakeDashboardPort implements ProjectSyncUpdateDashboardPort {
  update(): Promise<Result<void, ProjectSyncUpdateDashboardError>> {
    return Promise.resolve(ok(undefined));
  }
}

class FakeProposePort implements ProjectSyncProposeActionsPort {
  propose(): Promise<Result<ProjectSyncProposeResult, ProjectSyncProposeError>> {
    return Promise.resolve(err({ code: "rejected", message: "no external actions" }));
  }
}

class RecordingHealthSink implements ProjectSyncHealthSink {
  readonly surfaced: ProjectSyncFailure[] = [];
  surface(
    failure: ProjectSyncFailure,
  ): Promise<Result<ProjectSyncSurfaceOutcome, ProjectSyncHealthSinkError>> {
    this.surfaced.push(failure);
    return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
  }
}

/** Minimal deterministic clock + in-memory run repo (drive resolveRun). */
const fixedClock: Clock = { now: () => "2026-07-01T00:00:00.000Z" };

class InMemoryRunRepo implements WorkflowRunRefRepository {
  private readonly byId = new Map<string, WorkflowRunRef>();
  create(ref: WorkflowRunRef): DbResult<WorkflowRunRef> {
    for (const existing of this.byId.values()) {
      if (existing.idempotencyKey === ref.idempotencyKey) {
        return Promise.resolve(err(conflict("dup idempotencyKey")));
      }
    }
    this.byId.set(ref.workflowId, ref);
    return Promise.resolve(ok(ref));
  }
  get(id: WorkflowRunRef["workflowId"]): DbResult<WorkflowRunRef> {
    const f = this.byId.get(id);
    return Promise.resolve(f ? ok(f) : err(notFound(`no run: ${id}`)));
  }
  getByIdempotencyKey(
    key: WorkflowRunRef["idempotencyKey"],
  ): DbResult<WorkflowRunRef> {
    for (const ref of this.byId.values()) {
      if (ref.idempotencyKey === key) return Promise.resolve(ok(ref));
    }
    return Promise.resolve(err(notFound(`no run for key: ${key}`)));
  }
  updateState(
    id: WorkflowRunRef["workflowId"],
    state: WorkflowRunRef["state"],
  ): DbResult<WorkflowRunRef> {
    const f = this.byId.get(id);
    if (f === undefined) return Promise.resolve(err(notFound(`no run: ${id}`)));
    const next = { ...f, state };
    this.byId.set(id, next);
    return Promise.resolve(ok(next));
  }
  appendAuditRef(
    id: WorkflowRunRef["workflowId"],
    auditRef: WorkflowRunRef["auditRefs"][number],
  ): DbResult<WorkflowRunRef> {
    const f = this.byId.get(id);
    if (f === undefined) return Promise.resolve(err(notFound(`no run: ${id}`)));
    const next = { ...f, auditRefs: [...f.auditRefs, auditRef] };
    this.byId.set(id, next);
    return Promise.resolve(ok(next));
  }
}

const notFound = (message: string): DbError => ({ code: "not_found", message });
const conflict = (message: string): DbError => ({ code: "conflict", message });

const makeInput = (over: Partial<ProjectSyncInput> = {}): ProjectSyncInput => ({
  run: {
    workflowId: workflowId("wf-ps-progress-1"),
    trigger: "schedule",
    idempotencyKey: "idem-ps-progress-1",
    workspaceId: PROJECT_WS,
  },
  context: makeContext(),
  ...over,
});

/**
 * A REAL projection for the derive-from-validated seam: the committed number is
 * read ONLY from the deterministic `progress` (never the narrative), and the prose
 * is read off the validated narrative fields (REQ-F-011). Passed to the REAL
 * `createBuildSyncOutputsActivity`.
 */
const factsOnlyProjection: SyncOutputsProjection = {
  project(validated, progress, ws) {
    const proseValue = (name: string): unknown =>
      validated.fields[name] === undefined ? TBD : validated.fields[name]?.value;
    return ok({
      note: {
        path: `projects/${String(ws)}/status.md`,
        body: "project status",
        frontmatter: {
          // ★ REQ-F-011: numeric progress from the DETERMINISTIC facts only.
          percentComplete: progress.percentComplete,
          completedCount: progress.completedCount,
          totalCount: progress.totalCount,
          // prose off the validated narrative
          explanation: proseValue("explanation"),
          blockers: proseValue("blockers"),
          nextActions: proseValue("nextActions"),
        },
      },
      dashboard: { percentComplete: progress.percentComplete },
      actions: [],
    });
  },
};

/** Assemble a driver dep set with the REAL parse + REAL build activities. */
const makeDeps = (opts: {
  reader: RawProgressReader;
  draft: ProgressNarrativeDraft;
  commit?: CapturingCommitPort;
  health?: RecordingHealthSink;
}): { deps: ProjectSyncDeps; commit: CapturingCommitPort; health: RecordingHealthSink } => {
  const commit = opts.commit ?? new CapturingCommitPort();
  const health = opts.health ?? new RecordingHealthSink();
  const deps: ProjectSyncDeps = {
    registry: new FakeRegistryPort(),
    parse: createDeterministicProgressActivity({ reader: opts.reader }),
    synthesize: new FakeSynthesizePort(opts.draft),
    validate: new RealNoInferenceValidatePort(),
    buildOutputs: createBuildSyncOutputsActivity({
      projection: factsOnlyProjection,
      sourceRef: { sourceId: sourceId("src-plan-1") },
      planIdentity: { project: "acme-api" },
    }),
    commit,
    dashboard: new FakeDashboardPort(),
    propose: new FakeProposePort(),
    health,
    runs: new InMemoryRunRepo(),
    clock: fixedClock,
  };
  return { deps, commit, health };
};

/** A safe, evidence-backed / TBD narrative (passes the no-inference gate). */
const safeDraft = (
  over: Partial<ProgressNarrativeDraft["fields"]> = {},
): ProgressNarrativeDraft => ({
  fields: {
    explanation: { value: "Auth redesign underway.", evidenceRef: "plan#L40" },
    blockers: { value: TBD },
    nextActions: { value: "Wire the gateway.", evidenceRef: "plan#L52" },
    ...over,
  },
  schemaId: "sow:project-sync-output",
});

// ===========================================================================
// (a) progress is DETERMINISTIC from checkbox/status counts — NOT model-invented
// ===========================================================================

describe("§20.1 Project progress — (a) deterministic checkbox/status counts, not model-invented", () => {
  it("countCheckboxes tallies [x]/[ ] purely from text (any case)", () => {
    const tally = countCheckboxes("- [x] a\n- [ ] b\n- [X] c\n- [ ] d\n");
    expect(tally.completed).toBe(2);
    expect(tally.total).toBe(4);
    expect(tally.ambiguous).toBe(false);
    expect(computePercent(tally.completed, tally.total)).toBe(50);
  });

  it("computePercent is a pure function of the counts (0 when total is 0 — never NaN)", () => {
    expect(computePercent(0, 0)).toBe(0);
    expect(computePercent(3, 4)).toBe(75);
    expect(computePercent(7, 10)).toBe(70);
  });

  it("the REAL parse activity derives progress from raw plan text (no model input at all)", async () => {
    const activity = createDeterministicProgressActivity({
      reader: makeReader([{ source: "plan", text: "- [x] a\n- [x] b\n- [ ] c\n- [ ] d\n- [ ] e\n" }]),
    });
    const res = await activity.parse(makeContext());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.completedCount).toBe(2);
      expect(res.value.totalCount).toBe(5);
      expect(res.value.percentComplete).toBe(40); // 2/5, deterministically computed
    }
  });

  it("sums per-source counts deterministically across plan + provider sources", async () => {
    const activity = createDeterministicProgressActivity({
      reader: makeReader([
        { source: "plan", text: "- [x] a\n- [ ] b\n" },
        { source: "linear-1", text: "- [x] c\n- [x] d\n" },
      ]),
    });
    const res = await activity.parse(makeContext());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.completedCount).toBe(3);
      expect(res.value.totalCount).toBe(4);
      expect(res.value.percentComplete).toBe(75);
      expect(res.value.perProvider).toHaveLength(2);
    }
  });

  it("is replay-safe: identical raw input ⇒ identical progress (no clock/random)", async () => {
    const text = "- [x] a\n- [ ] b\n- [x] c\n";
    const activity = createDeterministicProgressActivity({ reader: makeReader([{ source: "plan", text }]) });
    const first = await activity.parse(makeContext());
    const second = await activity.parse(makeContext());
    expect(first).toEqual(second);
  });
});

// ===========================================================================
// (b) HARD-FAIL on ambiguous / unparseable — typed state, never silently zeroed
// ===========================================================================

describe("§20.1 Project progress — (b) hard-fails into a typed state, never zeroed/guessed", () => {
  it("an ambiguous marker ([?]) → ambiguous_status err, NOT ok(0) — refuses to guess (PRJ-4)", async () => {
    const activity = createDeterministicProgressActivity({
      reader: makeReader([{ source: "plan", text: "- [x] a\n- [?] b\n- [ ] c\n" }]),
    });
    const res = await activity.parse(makeContext());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("ambiguous_status");
  });

  it("an unreadable plan → parse_failed err propagates fail-closed (no guessed number)", async () => {
    const activity = createDeterministicProgressActivity({ reader: makeFailingReader("parse_failed") });
    const res = await activity.parse(makeContext());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("parse_failed");
  });

  it("a stale connector source → connector_stale err (does not count stale status, LIFE-2)", async () => {
    const activity = createDeterministicProgressActivity({
      reader: makeReader([{ source: "linear-1", text: "- [x] a\n", stale: true }]),
    });
    const res = await activity.parse(makeContext());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("connector_stale");
  });

  it("parse_failed and ambiguous_status are TYPED project-sync machine states", () => {
    expect(PROJECT_SYNC_STATES).toContain("parse_failed");
    expect(PROJECT_SYNC_STATES).toContain("ambiguous_status");
    expect(PROJECT_SYNC_STATES).toContain("connector_stale");
  });

  it("end-to-end: an ambiguous status halts the REAL driver at ambiguous_status with NO commit + a health item", async () => {
    const { deps, commit, health } = makeDeps({
      reader: makeReader([{ source: "plan", text: "- [x] a\n- [-] b\n" }]),
      draft: safeDraft(),
    });
    const outcome = await runProjectSync(makeInput(), deps);
    expect(outcome.state).toBe("ambiguous_status");
    expect(commit.writeCount).toBe(0); // nothing silently written
    expect(health.surfaced).toHaveLength(1); // nothing fails silently
  });

  it("end-to-end: an unparseable plan halts the REAL driver at parse_failed with NO commit", async () => {
    const { deps, commit } = makeDeps({
      reader: makeFailingReader("parse_failed"),
      draft: safeDraft(),
    });
    const outcome = await runProjectSync(makeInput(), deps);
    expect(outcome.state).toBe("parse_failed");
    expect(commit.writeCount).toBe(0);
  });
});

// ===========================================================================
// (c) model-invented blockers/next-actions rejected; model % never committed
// ===========================================================================

describe("§20.1 Project progress — (c) model-invented content rejected in favor of the deterministic parse", () => {
  it("a model-invented blocker (concrete value, no evidence) is rejected by the no-inference gate", () => {
    const checked = validateNoInference({
      blockers: { value: "Waiting on Bob to approve the migration." }, // invented, no evidenceRef
    });
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.error[0]?.code).toBe("inferred_owner_or_date");
      expect(checked.error[0]?.field).toBe("blockers");
    }
  });

  it("evidence-backed / TBD blockers + next-actions pass the gate", () => {
    const checked = validateNoInference({
      blockers: { value: TBD },
      nextActions: { value: "Ship the gateway.", evidenceRef: "plan#L52" },
    });
    expect(checked.ok).toBe(true);
  });

  it("end-to-end: a model-invented next-action drives the REAL driver to schema_rejected with NO commit", async () => {
    const { deps, commit } = makeDeps({
      reader: makeReader([{ source: "plan", text: "- [x] a\n- [ ] b\n" }]),
      // nextActions is a concrete claim with NO evidenceRef → no-inference reject.
      draft: safeDraft({ nextActions: { value: "Ask Alice to finish auth." } }),
    });
    const outcome = await runProjectSync(makeInput(), deps);
    expect(outcome.state).toBe("schema_rejected");
    expect(commit.writeCount).toBe(0);
  });

  it("end-to-end: the committed number is the DETERMINISTIC parse (40%), NEVER a narrative-supplied percent (99)", async () => {
    // The narrative smuggles an (evidence-cited, so gate-passing) 'percent' field
    // claiming 99. The deterministic plan says 40% (2 of 5). The committed number
    // MUST be 40 — the model's number can never source the committed progress.
    const { deps, commit } = makeDeps({
      reader: makeReader([{ source: "plan", text: "- [x] a\n- [x] b\n- [ ] c\n- [ ] d\n- [ ] e\n" }]),
      draft: safeDraft({ percent: { value: "99", evidenceRef: "model#claim" } }),
    });
    const outcome = await runProjectSync(makeInput(), deps);
    expect(outcome.state).toBe("done");
    const fm = commit.lastPlan?.creates[0]?.frontmatter;
    expect(fm?.percentComplete).toBe(40);
    expect(fm?.percentComplete).not.toBe(99);
    expect(fm?.percentComplete).not.toBe("99");
  });

  it("plan-level confidence is 1 (a deterministic fact, not a model estimate)", async () => {
    const { deps, commit } = makeDeps({
      reader: makeReader([{ source: "plan", text: "- [x] a\n- [ ] b\n" }]),
      draft: safeDraft(),
    });
    const outcome = await runProjectSync(makeInput(), deps);
    expect(outcome.state).toBe("done");
    expect(commit.lastPlan?.confidence).toBe(1);
    // WS-2/WS-4: the committed plan targets the registry-bound workspace.
    expect(commit.lastPlan?.workspaceId).toBe(PROJECT_WS);
  });
});

// ===========================================================================
// EVAL-1 runner scoring — the criterion is deterministic (no real vendor needed)
// ===========================================================================

describe("project-progress — EVAL-1 runner scoring", () => {
  it("PROJECT_PROGRESS passes functionally AND DoD (requiresRealIntegration=false)", () => {
    // The invariant is deterministic enforcement (the real code path exercised
    // above), so a from-mock measurement is still DoD-valid.
    const out = scoreById({
      criterionId: "PROJECT_PROGRESS",
      value: true,
      fromRealIntegration: false,
    });
    expect(out.functionalPass).toBe(true);
    expect(out.dodValid).toBe(true);
    expect(out.dodPass).toBe(true);
  });

  it("registry marks PROJECT_PROGRESS as NOT real-integration-required", () => {
    expect(criterionById("PROJECT_PROGRESS")?.requiresRealIntegration).toBe(false);
  });
});
