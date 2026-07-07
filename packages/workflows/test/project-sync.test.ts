// spec(§9) — task 7.13 PROJECT SYNC — the PURE orchestration driver + the
// deterministic-progress activity.
//
// These tests drive `runProjectSync` (the pure driver) over the project-sync
// activity-port FAKES (test/support/project-sync-fakes.ts) + the foundation
// FakeClock + InMemoryWorkflowRunRepo + a FakeProjectSyncHealthSink. The driver
// imports NEITHER @temporalio NOR node:crypto and calls NO Date.now()/Math.random(),
// so it runs entirely in-memory with no Temporal server (root CLAUDE.md ★ two-layer
// split).
//
// The suite pins the 7.13 safety invariants:
//   • DETERMINISTIC PROGRESS (REQ-F-011 / PRJ-3/4): the committed numeric progress is
//     derived by the deterministic checkbox parser — a MODEL-supplied percentage is
//     IGNORED/REJECTED and is NEVER the source of the number. A parse failure / stale
//     connector / ambiguous status → a typed failure state → a 7.5 health item.
//   • DERIVE-FROM-VALIDATED: the committed plan is derived from the validated
//     narrative + the deterministic facts, stamped with the REGISTRY-BOUND workspace
//     (plan.workspaceId === the bound workspace, never a caller value).
//   • missing provider mapping / provider failure / write conflict → typed failure
//     states → a 7.5 health item (nothing silent).
//   • replay-safety: a re-drive reuses the commit (each once).
import { describe, it, expect } from "vitest";
import { isOk, workflowId } from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";
import { TBD } from "@sow/domain";
import { runProjectSync, projectSyncMachine } from "../src/workflows/projectSync";
import type { ProjectSyncInput, ProjectSyncDeps } from "../src/workflows/projectSync";
import {
  createDeterministicProgressActivity,
  createBuildSyncOutputsActivity,
  countCheckboxes,
  computePercent,
} from "../src/activities/deterministicProgress";
import type {
  RawProgressReader,
  RawProgressSource,
  SyncOutputsProjection,
} from "../src/activities/deterministicProgress";
import {
  FakeResolveRegistryPort,
  FakeParseProgressPort,
  FakeSynthesizeNarrativePort,
  FakeValidateNarrativePort,
  FakeBuildSyncOutputsPort,
  FakeCommitStatusPort,
  FakeUpdateDashboardPort,
  FakeProposePort,
  FakeProjectSyncHealthSink,
  FakeNoteExistsReader,
  makeProjectSyncContext,
  makeRegistryEntry,
  makeProgress,
  makeNarrativeDraft,
  PROJECT_WS,
} from "./support/project-sync-fakes";
import { FakeClock, InMemoryWorkflowRunRepo } from "./support/fakes";
import type {
  ParseProgressError,
  DeterministicProgress,
  BuildSyncOutputsFailure,
  ValidatedNarrative,
} from "../src/ports/projectSync";
import { ok as rOk, err as rErr } from "@sow/contracts";
import type { Result, SourceRef } from "@sow/contracts";
import { sourceId } from "@sow/contracts";

// --- fixtures --------------------------------------------------------------

function makeInput(partial: Partial<ProjectSyncInput> = {}): ProjectSyncInput {
  return {
    run: {
      workflowId: workflowId("wf-ps-1"),
      trigger: "schedule",
      idempotencyKey: "idem-run-ps-1",
      workspaceId: PROJECT_WS,
    },
    context: makeProjectSyncContext(),
    ...partial,
  };
}

/** Fresh, all-green dep set with the fakes; override any port per test. */
function makeDeps(overrides: Partial<ProjectSyncDeps> = {}): ProjectSyncDeps {
  return {
    registry: new FakeResolveRegistryPort(),
    parse: new FakeParseProgressPort(),
    synthesize: new FakeSynthesizeNarrativePort(),
    validate: new FakeValidateNarrativePort(),
    buildOutputs: new FakeBuildSyncOutputsPort(),
    commit: new FakeCommitStatusPort(),
    dashboard: new FakeUpdateDashboardPort(),
    propose: new FakeProposePort(),
    health: new FakeProjectSyncHealthSink(),
    runs: new InMemoryWorkflowRunRepo(),
    clock: new FakeClock(),
    ...overrides,
  };
}

// --- the local machine -----------------------------------------------------

describe("projectSyncMachine — legal + total", () => {
  it("walks the happy path scheduled → … → done", () => {
    let s = "scheduled" as const;
    const path = [
      "registry_resolved",
      "progress_parsed",
      "briefed",
      "synced_committed",
      "dashboard_updated",
      "done",
    ] as const;
    let cursor: string = s;
    for (const to of path) {
      const step = projectSyncMachine.transition(cursor as never, to);
      expect(isOk(step)).toBe(true);
      if (isOk(step)) cursor = step.value;
    }
    expect(cursor).toBe("done");
    expect(projectSyncMachine.isTerminal("done")).toBe(true);
  });

  it("rejects an illegal edge without throwing (§16 total)", () => {
    const step = projectSyncMachine.transition("scheduled", "done");
    expect(isOk(step)).toBe(false);
  });
});

// --- happy path ------------------------------------------------------------

describe("runProjectSync — happy path", () => {
  it("drives scheduled → … → done with a single derived commit + dashboard update", async () => {
    const commit = new FakeCommitStatusPort();
    const dashboard = new FakeUpdateDashboardPort();
    const deps = makeDeps({ commit, dashboard });

    const outcome = await runProjectSync(makeInput(), deps);

    expect(outcome.state).toBe("done");
    expect(commit.writeCount).toBe(1);
    expect(dashboard.payloads).toHaveLength(1);
    expect(outcome.context.revisionId).toBeDefined();
    expect(outcome.surfaced).toBeUndefined();
  });

  it("hands the DETERMINISTIC facts (not the narrative) to the deriver as the numeric source", async () => {
    const buildOutputs = new FakeBuildSyncOutputsPort();
    const progress = makeProgress({ completedCount: 3, totalCount: 4, percentComplete: 75 });
    const parse = new FakeParseProgressPort({ result: "parsed", progress });
    const deps = makeDeps({ buildOutputs, parse });

    const outcome = await runProjectSync(makeInput(), deps);

    expect(outcome.state).toBe("done");
    // The deriver was handed the deterministic facts as the numeric source.
    expect(buildOutputs.calls).toHaveLength(1);
    expect(buildOutputs.calls[0]?.progress.percentComplete).toBe(75);
  });

  it("stamps the committed plan with the REGISTRY-BOUND workspace (WS-2/WS-4)", async () => {
    const buildOutputs = new FakeBuildSyncOutputsPort();
    const boundWs: WorkspaceId = PROJECT_WS;
    const registry = new FakeResolveRegistryPort({
      result: "resolved",
      entry: makeRegistryEntry({ workspaceId: boundWs }),
    });
    const deps = makeDeps({ buildOutputs, registry });

    await runProjectSync(makeInput(), deps);

    expect(buildOutputs.calls[0]?.workspaceId).toBe(boundWs);
  });

  it("derives the build IDENTITY from the registry-bound entry (not swapped/defaulted) + supplies the clock's updatedAt", async () => {
    const buildOutputs = new FakeBuildSyncOutputsPort();
    const registry = new FakeResolveRegistryPort({
      result: "resolved",
      entry: makeRegistryEntry({
        projectId: "proj-xyz",
        title: "Project XYZ",
        slug: "employer-work/xyz",
        lifecycleState: "planning",
      }),
    });
    const deps = makeDeps({ buildOutputs, registry });

    await runProjectSync(makeInput(), deps);

    // The driver must thread the registry fields into ProjectIdentity, each in the right slot (a regression
    // that swapped e.g. projectId←workspaceId, or forgot the clock, would pass every other test).
    const call = buildOutputs.calls[0];
    expect(call?.identity).toEqual({
      projectId: "proj-xyz",
      title: "Project XYZ",
      slug: "employer-work/xyz",
      lifecycleState: "planning",
    });
    expect(typeof call?.updatedAt).toBe("string");
    expect(call?.updatedAt.length).toBeGreaterThan(0);
  });
});

// --- REQ-F-011: a model-supplied percentage is NEVER the source of the number

describe("runProjectSync — REQ-F-011 / PRJ-3/4: model percentages are forbidden", () => {
  it("commits the DETERMINISTIC number even when the narrative claims a different percent", async () => {
    // The narrative (candidate model output) claims 99% — this must be IGNORED.
    const draft = makeNarrativeDraft({
      fields: {
        explanation: { value: "Nearly done!", evidenceRef: "plan#L1" },
        // A model attempting to smuggle a number in as a prose field.
        percentComplete: { value: "99", evidenceRef: "plan#L1" },
      },
    });
    const synthesize = new FakeSynthesizeNarrativePort({ result: "accepted", draft });
    // The deterministic parser says 40% (2 of 5).
    const progress = makeProgress({ completedCount: 2, totalCount: 5, percentComplete: 40 });
    const parse = new FakeParseProgressPort({ result: "parsed", progress });

    // Use the REAL deriver activity so we can inspect the committed frontmatter number.
    const capturingCommit = new CapturingCommitPort();
    const projection: SyncOutputsProjection = {
      project(validated, prog, ws) {
        return rOk({
          mutation: {
            kind: "create",
            note: {
              path: `projects/${String(ws)}/status.md`,
              body: "status",
              // ★ number from the DETERMINISTIC facts; prose off the narrative.
              frontmatter: {
                percentComplete: prog.percentComplete,
                explanation: validated.fields.explanation?.value ?? TBD,
              },
            },
          },
          dashboard: { percentComplete: prog.percentComplete },
          actions: [],
        });
      },
    };
    const sourceRef: SourceRef = { sourceId: sourceId("src-plan-1") };
    const buildOutputs = createBuildSyncOutputsActivity({
      projection,
      sourceRef,
      planIdentity: { project: "acme-api" },
      noteExists: new FakeNoteExistsReader(),
    });
    const deps = makeDeps({ synthesize, parse, buildOutputs, commit: capturingCommit });

    const outcome = await runProjectSync(makeInput(), deps);

    expect(outcome.state).toBe("done");
    const committedFm = capturingCommit.lastPlan?.creates[0]?.frontmatter;
    // The committed number is the DETERMINISTIC 40 — NOT the model's 99.
    expect(committedFm?.percentComplete).toBe(40);
    expect(committedFm?.percentComplete).not.toBe(99);
    expect(committedFm?.percentComplete).not.toBe("99");
  });
});

// --- deterministic parser ---------------------------------------------------

describe("createDeterministicProgressActivity — deterministic checkbox parse", () => {
  it("counts checkboxes deterministically from checkbox text", () => {
    const tally = countCheckboxes("- [x] a\n- [ ] b\n- [X] c\n- [ ] d\n");
    expect(tally.completed).toBe(2);
    expect(tally.total).toBe(4);
    expect(tally.ambiguous).toBe(false);
    expect(computePercent(2, 4)).toBe(50);
    expect(computePercent(0, 0)).toBe(0);
  });

  it("parses a project's progress from raw plan checkboxes", async () => {
    const reader: RawProgressReader = {
      read(): Promise<Result<readonly RawProgressSource[], ParseProgressError>> {
        return Promise.resolve(rOk([{ source: "plan", text: "- [x] a\n- [x] b\n- [ ] c\n" }]));
      },
    };
    const activity = createDeterministicProgressActivity({ reader });
    const result = await activity.parse(makeProjectSyncContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.completedCount).toBe(2);
      expect(result.value.totalCount).toBe(3);
      expect(result.value.percentComplete).toBe(67);
    }
  });

  it("fails closed (ambiguous_status) on an ambiguous status marker — never guesses", async () => {
    const reader: RawProgressReader = {
      read(): Promise<Result<readonly RawProgressSource[], ParseProgressError>> {
        return Promise.resolve(rOk([{ source: "plan", text: "- [x] a\n- [?] b\n" }]));
      },
    };
    const activity = createDeterministicProgressActivity({ reader });
    const result = await activity.parse(makeProjectSyncContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ambiguous_status");
  });

  it("fails closed (connector_stale) on a stale source", async () => {
    const reader: RawProgressReader = {
      read(): Promise<Result<readonly RawProgressSource[], ParseProgressError>> {
        return Promise.resolve(rOk([{ source: "linear-1", text: "- [x] a\n", stale: true }]));
      },
    };
    const activity = createDeterministicProgressActivity({ reader });
    const result = await activity.parse(makeProjectSyncContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("connector_stale");
  });

  it("propagates a reader parse failure (fail-closed, no guessed number)", async () => {
    const reader: RawProgressReader = {
      read(): Promise<Result<readonly RawProgressSource[], ParseProgressError>> {
        return Promise.resolve(rErr({ code: "parse_failed", message: "unreadable plan" }));
      },
    };
    const activity = createDeterministicProgressActivity({ reader });
    const result = await activity.parse(makeProjectSyncContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("parse_failed");
  });
});

// --- typed failure states → 7.5 -------------------------------------------

describe("runProjectSync — typed failures route to 7.5 (nothing silent)", () => {
  it("missing provider mapping → provider_unmapped + a health item, NO commit", async () => {
    const commit = new FakeCommitStatusPort();
    const health = new FakeProjectSyncHealthSink();
    const registry = new FakeResolveRegistryPort({ failWith: "provider_unmapped" });
    const deps = makeDeps({ registry, commit, health });

    const outcome = await runProjectSync(makeInput(), deps);

    expect(outcome.state).toBe("provider_unmapped");
    expect(commit.writeCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
    expect(outcome.surfaced?.failureClass).toBe("conflict_review");
  });

  it("parse failure → parse_failed + a health item, NO commit", async () => {
    const commit = new FakeCommitStatusPort();
    const health = new FakeProjectSyncHealthSink();
    const parse = new FakeParseProgressPort({ failWith: "parse_failed" });
    const deps = makeDeps({ parse, commit, health });

    const outcome = await runProjectSync(makeInput(), deps);

    expect(outcome.state).toBe("parse_failed");
    expect(commit.writeCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("ambiguous status → ambiguous_status, NO commit", async () => {
    const commit = new FakeCommitStatusPort();
    const parse = new FakeParseProgressPort({ failWith: "ambiguous_status" });
    const deps = makeDeps({ parse, commit });

    const outcome = await runProjectSync(makeInput(), deps);

    expect(outcome.state).toBe("ambiguous_status");
    expect(commit.writeCount).toBe(0);
  });

  it("stale connector at parse → connector_stale, NO commit", async () => {
    const commit = new FakeCommitStatusPort();
    const parse = new FakeParseProgressPort({ failWith: "connector_stale" });
    const deps = makeDeps({ parse, commit });

    const outcome = await runProjectSync(makeInput(), deps);

    expect(outcome.state).toBe("connector_stale");
    expect(outcome.surfaced?.failureClass).toBe("connector_unreachable");
    expect(commit.writeCount).toBe(0);
  });

  it("synthesis provider failure → provider_failed, NO commit", async () => {
    const commit = new FakeCommitStatusPort();
    const synthesize = new FakeSynthesizeNarrativePort({ result: "rejected", rejection: "provider_failed" });
    const deps = makeDeps({ synthesize, commit });

    const outcome = await runProjectSync(makeInput(), deps);

    expect(outcome.state).toBe("provider_failed");
    expect(commit.writeCount).toBe(0);
  });

  it("an inferred narrative field → schema_rejected (no-inference), NO commit", async () => {
    const commit = new FakeCommitStatusPort();
    // An inferred field: concrete value with NO evidenceRef → REQ-F-017 hard reject.
    const draft = makeNarrativeDraft({
      fields: { owner: { value: "Alice" } },
    });
    const synthesize = new FakeSynthesizeNarrativePort({ result: "accepted", draft });
    const deps = makeDeps({ synthesize, commit });

    const outcome = await runProjectSync(makeInput(), deps);

    expect(outcome.state).toBe("schema_rejected");
    expect(commit.writeCount).toBe(0);
  });

  it("a derivation failure → schema_rejected, NO partial commit", async () => {
    const commit = new FakeCommitStatusPort();
    const buildOutputs = new FakeBuildSyncOutputsPort({ failWith: "unmappable_progress" });
    const deps = makeDeps({ buildOutputs, commit });

    const outcome = await runProjectSync(makeInput(), deps);

    expect(outcome.state).toBe("schema_rejected");
    expect(commit.writeCount).toBe(0);
  });

  it("a write conflict at commit → write_conflict + a health item", async () => {
    const commit = new FakeCommitStatusPort({ failWith: "write_conflict" });
    const health = new FakeProjectSyncHealthSink();
    const deps = makeDeps({ commit, health });

    const outcome = await runProjectSync(makeInput(), deps);

    expect(outcome.state).toBe("write_conflict");
    expect(health.surfaced).toHaveLength(1);
  });

  it("dashboard failure surfaces a health item but does NOT roll the commit back", async () => {
    const commit = new FakeCommitStatusPort();
    const dashboard = new FakeUpdateDashboardPort({ failWith: "dashboard_failed" });
    const health = new FakeProjectSyncHealthSink();
    const deps = makeDeps({ commit, dashboard, health });

    const outcome = await runProjectSync(makeInput(), deps);

    // The commit stands → the sync still reaches done.
    expect(outcome.state).toBe("done");
    expect(commit.writeCount).toBe(1);
    // The dashboard failure was surfaced (nothing silent).
    expect(health.surfaced.some((f) => f.failureClass === "sync_lagging")).toBe(true);
  });
});

// --- external actions ------------------------------------------------------

describe("runProjectSync — external actions via the Tool Gateway", () => {
  it("dispatches a derived status ping and reaches external_actions_applied → done", async () => {
    const buildOutputs = new FakeBuildSyncOutputsPort({ actionCount: 1 });
    const propose = new FakeProposePort();
    const deps = makeDeps({ buildOutputs, propose });

    const outcome = await runProjectSync(makeInput(), deps);

    expect(outcome.state).toBe("done");
    expect(propose.createCount).toBe(1);
  });

  it("a held external write → outbox_retry (fail-closed, re-drivable)", async () => {
    const buildOutputs = new FakeBuildSyncOutputsPort({ actionCount: 1 });
    const propose = new FakeProposePort({ failWith: "held" });
    const deps = makeDeps({ buildOutputs, propose });

    const outcome = await runProjectSync(makeInput(), deps);

    expect(outcome.state).toBe("outbox_retry");
  });
});

// --- replay ----------------------------------------------------------------

describe("runProjectSync — idempotent replay (inv-5)", () => {
  it("reuses the run on a seen idempotencyKey", async () => {
    const runs = new InMemoryWorkflowRunRepo();
    const deps1 = makeDeps({ runs });
    const first = await runProjectSync(makeInput(), deps1);
    expect(first.runReused).toBe(false);

    const deps2 = makeDeps({ runs });
    const second = await runProjectSync(makeInput(), deps2);
    expect(second.runReused).toBe(true);
  });

  it("a re-drive does NOT double-commit (KnowledgeWriter idempotent by plan key)", async () => {
    const commit = new FakeCommitStatusPort();
    // Same commit instance across two drives → the second commit is an idempotent replay.
    const first = await runProjectSync(makeInput(), makeDeps({ commit }));
    const second = await runProjectSync(makeInput(), makeDeps({ commit }));
    expect(first.state).toBe("done");
    expect(second.state).toBe("done");
    // Only ONE distinct underlying write despite two drives.
    expect(commit.writeCount).toBe(1);
  });
});

// A commit port that captures the last plan it was asked to commit (for inspection).
class CapturingCommitPort extends FakeCommitStatusPort {
  lastPlan: import("@sow/contracts").KnowledgeMutationPlan | undefined;
  override commit(
    plan: import("@sow/contracts").KnowledgeMutationPlan,
  ): ReturnType<FakeCommitStatusPort["commit"]> {
    this.lastPlan = plan;
    return super.commit(plan);
  }
}

// Silence unused-import lint for the type-only re-exports referenced in generics.
void (undefined as unknown as DeterministicProgress | BuildSyncOutputsFailure | ValidatedNarrative);
