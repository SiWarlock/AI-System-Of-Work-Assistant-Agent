// spec(§9) — task 7.6 MEETING CLOSEOUT — the PURE orchestration driver.
//
// These tests drive `runMeetingCloseout` (the pure driver) over the meeting-closeout
// activity-port FAKES (test/support/meeting-fakes.ts) + the foundation FakeClock +
// InMemoryWorkflowRunRepo + InMemoryHealthItemStore-backed sink. The driver imports
// NEITHER @temporalio NOR node:crypto and calls NO Date.now()/Math.random(), so it
// runs entirely in-memory with no Temporal server (root CLAUDE.md ★ two-layer split).
//
// The suite pins the 7.6 safety invariants:
//   • happy path drives detected → … → summarized (no illegal machine edge).
//   • correlation LOW-CONFIDENCE → needs_routing_review, NO commit, NO workspace guess.
//   • validator rejection → schema_rejected, NO KnowledgeWriter commit + NO external write.
//   • broker rejection → provider_failed (retryable per code).
//   • KnowledgeWriter conflict → write_conflict.
//   • approval-required external action → approval_pending.
//   • REPLAY from the start after a simulated mid-pipeline restart → the commit and the
//     external write are REUSED (fakes report replayed/reused; each happens exactly once).
//   • EVERY failure branch surfaces a 7.5 health item (nothing silent, inv-5).
import { describe, it, expect } from "vitest";
import { isOk, ok } from "@sow/contracts";
import { workflowId } from "@sow/contracts";
import type {
  WorkspaceId,
  KnowledgeMutationPlan,
  Result,
  SourceEnvelope,
} from "@sow/contracts";
import { err } from "@sow/contracts";
import type { MeetingParkPort, MeetingParkFailure } from "../src/ports/meetingCloseout";
import { runMeetingCloseout } from "../src/workflows/meetingCloseout";
import type {
  MeetingCloseoutInput,
  MeetingCloseoutDeps,
} from "../src/workflows/meetingCloseout";
import {
  FakeCorrelatePort,
  FakeAgentJobPort,
  FakeValidatePort,
  FakeBuildOutputsPort,
  FakeCommitPort,
  FakeProposePort,
  FakeReindexPort,
  FakeMeetingHealthSink,
  makeMeetingContext,
  makeAgentExtraction,
} from "./support/meeting-fakes";
import { FakeClock, InMemoryWorkflowRunRepo } from "./support/fakes";
import type { CorrelateErrorCode } from "../src/ports/meetingCloseout";
import type { MeetingAgentFailureCode } from "../src/ports/meetingCloseout";
import type { KnowledgeCommitFailureCode } from "../src/ports/meetingCloseout";
import type { ProposeErrorCode } from "../src/ports/meetingCloseout";
import type { BuildOutputsFailureCode } from "../src/ports/meetingCloseout";
import type {
  CommitKnowledgePort,
  KnowledgeCommitSuccess,
  KnowledgeCommitFailure,
} from "../src/ports/meetingCloseout";

// --- fixtures --------------------------------------------------------------

const WS = "ws-employer" as WorkspaceId;

/**
 * The happy-path input. The semantic outputs (plan + actions) are NO LONGER
 * caller-supplied — they are DERIVED inside the pipeline by the BuildOutputsPort —
 * so the input is just the run submission + the pre-correlation context.
 */
function makeInput(partial: Partial<MeetingCloseoutInput> = {}): MeetingCloseoutInput {
  return {
    run: {
      workflowId: workflowId("wf-mc-1"),
      trigger: "connector_event",
      idempotencyKey: "idem-run-mc-1",
      workspaceId: WS,
    },
    context: makeMeetingContext(),
    ...partial,
  };
}

/** Build a fresh, all-green dep set with the fakes; override any port per test. */
function makeDeps(overrides: Partial<MeetingCloseoutDeps> = {}): MeetingCloseoutDeps {
  return {
    correlate: new FakeCorrelatePort({ confidence: "high", workspaceId: WS }),
    agent: new FakeAgentJobPort({ result: "accepted" }),
    validate: new FakeValidatePort(),
    buildOutputs: new FakeBuildOutputsPort(),
    commit: new FakeCommitPort(),
    propose: new FakeProposePort(),
    reindex: new FakeReindexPort(),
    health: new FakeMeetingHealthSink(),
    park: new FakeMeetingParkPort(),
    runs: new InMemoryWorkflowRunRepo(),
    clock: new FakeClock(),
    ...overrides,
  };
}

/**
 * A fake {@link MeetingParkPort} that RECORDS every park call and dedupes by the source identity
 * (first-write-wins) — mirroring the durable `repo.park`. Construct with `{ fail: true }` to simulate a
 * park-store fault. `parked` holds the set of durably-parked sourceIds (its size is the row count).
 */
class FakeMeetingParkPort implements MeetingParkPort {
  readonly calls: Array<{ source: SourceEnvelope; idempotencyKey: string }> = [];
  readonly parked = new Set<string>();
  constructor(private readonly opts: { fail?: boolean } = {}) {}
  park(source: SourceEnvelope, idempotencyKey: string): Promise<Result<void, MeetingParkFailure>> {
    this.calls.push({ source, idempotencyKey });
    if (this.opts.fail) return Promise.resolve(err({ code: "park_failed", message: "disposition store down" }));
    this.parked.add(String(source.sourceId)); // first-write-wins by sourceId (idempotent)
    return Promise.resolve(ok(undefined));
  }
}

/** Alias for readability: what the CapturingCommitPort records. */
type KnowledgeMutationPlanCapture = KnowledgeMutationPlan;

/**
 * A commit port that RECORDS every plan the driver hands it (so a regression test
 * can assert the DERIVED plan — its workspaceId + frontmatter — rather than a
 * caller-supplied one). Succeeds idempotently like the FakeCommitPort.
 */
class CapturingCommitPort implements CommitKnowledgePort {
  constructor(private readonly captured: KnowledgeMutationPlanCapture[]) {}
  private n = 0;
  commit(
    plan: KnowledgeMutationPlan,
  ): Promise<Result<KnowledgeCommitSuccess, KnowledgeCommitFailure>> {
    this.captured.push(plan);
    this.n += 1;
    return Promise.resolve(ok({ revisionId: `rev-cap-${this.n}`, replayed: false }));
  }
}

// --- happy path ------------------------------------------------------------

describe("runMeetingCloseout — happy path", () => {
  it("drives detected → … → summarized with exactly one commit and one external create", async () => {
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const reindex = new FakeReindexPort();
    const deps = makeDeps({ commit, propose, reindex });

    const outcome = await runMeetingCloseout(makeInput(), deps);

    expect(outcome.state).toBe("summarized");
    expect(commit.writeCount).toBe(1);
    expect(propose.createCount).toBe(1);
    // GBrain re-index runs AFTER the Markdown commit (inv-4): the committed
    // revision is present in the reindexed set.
    expect(outcome.context.revisionId).toBeDefined();
    expect(reindex.reindexed).toContain(outcome.context.revisionId);
    // workspace bound before durable write (WS-2 / inv-1).
    expect(outcome.context.workspaceId).toBe(WS);
  });

  it("resolves the run idempotently through the foundation seam (reused on a seen key)", async () => {
    const runs = new InMemoryWorkflowRunRepo();
    const deps = makeDeps({ runs });

    const first = await runMeetingCloseout(makeInput(), deps);
    expect(isOk(first.run)).toBe(true);

    // Re-drive with the SAME idempotencyKey but fresh port fakes: resolveRun reuses
    // the existing run — no duplicate run started.
    const second = await runMeetingCloseout(makeInput(), makeDeps({ runs }));
    expect(second.runReused).toBe(true);
  });
});

// --- correlation low-confidence → needs_routing_review ---------------------

describe("runMeetingCloseout — low-confidence correlation", () => {
  it("routes to needs_routing_review with NO commit and NO guessed workspace (inv-1)", async () => {
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const health = new FakeMeetingHealthSink();
    const deps = makeDeps({
      correlate: new FakeCorrelatePort({ confidence: "low", reason: "ambiguous" }),
      commit,
      propose,
      health,
    });

    const outcome = await runMeetingCloseout(makeInput(), deps);

    expect(outcome.state).toBe("needs_routing_review");
    // NO durable writes on the parked path.
    expect(commit.writeCount).toBe(0);
    expect(propose.createCount).toBe(0);
    // NEVER guesses a workspace (inv-1 / WS-2).
    expect(outcome.context.workspaceId).toBeUndefined();
    // Parked to the Ingestion Inbox is surfaced as a health item (nothing silent).
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- broker rejection → provider_failed ------------------------------------

describe("runMeetingCloseout — broker rejection", () => {
  it("lands in provider_failed with NO commit, and surfaces a health item", async () => {
    const commit = new FakeCommitPort();
    const health = new FakeMeetingHealthSink();
    const rejection: MeetingAgentFailureCode = "provider_failed";
    const deps = makeDeps({
      agent: new FakeAgentJobPort({ result: "rejected", rejection }),
      commit,
      health,
    });

    const outcome = await runMeetingCloseout(makeInput(), deps);

    expect(outcome.state).toBe("provider_failed");
    expect(commit.writeCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("maps an ING-7 admission rejection to provider_failed (mutating tool on untrusted transcript, inv-2)", async () => {
    const rejection: MeetingAgentFailureCode = "admission_rejected";
    const commit = new FakeCommitPort();
    const deps = makeDeps({
      agent: new FakeAgentJobPort({ result: "rejected", rejection }),
      commit,
    });

    const outcome = await runMeetingCloseout(makeInput(), deps);

    expect(outcome.state).toBe("provider_failed");
    // job never produced an extraction → no commit.
    expect(commit.writeCount).toBe(0);
  });
});

// --- validator rejection → schema_rejected, NO PARTIAL COMMIT --------------

describe("runMeetingCloseout — validator rejection", () => {
  it("hard-rejects an inferred field → schema_rejected, NO commit, NO external write (inv-3)", async () => {
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const health = new FakeMeetingHealthSink();
    // An inferred owner with NO evidenceRef — the REAL no-inference rule rejects it.
    const badExtraction = makeAgentExtraction({
      fields: { owner: { value: "Alice" }, dueDate: { value: "2026-08-01" } },
    });
    const deps = makeDeps({
      agent: new FakeAgentJobPort({ result: "accepted", extraction: badExtraction }),
      commit,
      propose,
      health,
    });

    const outcome = await runMeetingCloseout(makeInput(), deps);

    expect(outcome.state).toBe("schema_rejected");
    // NO PARTIAL COMMIT: neither a Markdown commit nor an external write happened.
    expect(commit.writeCount).toBe(0);
    expect(propose.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("hard-rejects on the schema gate → schema_rejected, NO commit (inv-3)", async () => {
    const commit = new FakeCommitPort();
    const deps = makeDeps({
      validate: new FakeValidatePort({ forceSchemaReject: true }),
      commit,
    });

    const outcome = await runMeetingCloseout(makeInput(), deps);

    expect(outcome.state).toBe("schema_rejected");
    expect(commit.writeCount).toBe(0);
  });
});

// --- KnowledgeWriter write_conflict ----------------------------------------

describe("runMeetingCloseout — write conflict", () => {
  it("lands in write_conflict on a compare-revision clash, with NO external write and a health item", async () => {
    const propose = new FakeProposePort();
    const health = new FakeMeetingHealthSink();
    const failWith: KnowledgeCommitFailureCode = "write_conflict";
    const deps = makeDeps({
      commit: new FakeCommitPort({ failWith }),
      propose,
      health,
    });

    const outcome = await runMeetingCloseout(makeInput(), deps);

    expect(outcome.state).toBe("write_conflict");
    // The commit failed → the external-action stage is never reached.
    expect(propose.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- approval-required external action → approval_pending ------------------

describe("runMeetingCloseout — approval-required external action", () => {
  it("parks in approval_pending (fail-closed, no external write) and surfaces a health item", async () => {
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort({ failWith: "approval_pending" satisfies ProposeErrorCode });
    const health = new FakeMeetingHealthSink();
    const deps = makeDeps({ commit, propose, health });

    const outcome = await runMeetingCloseout(makeInput(), deps);

    expect(outcome.state).toBe("approval_pending");
    // The Markdown commit stands (it precedes the external stage), but the external
    // write fails closed — no create.
    expect(commit.writeCount).toBe(1);
    expect(propose.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("holds to outbox_retry when the external action is held (non-terminal)", async () => {
    const propose = new FakeProposePort({ failWith: "held" satisfies ProposeErrorCode });
    const health = new FakeMeetingHealthSink();
    const deps = makeDeps({ propose, health });

    const outcome = await runMeetingCloseout(makeInput(), deps);

    expect(outcome.state).toBe("outbox_retry");
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- correlator hard-failure → provider_failed-style surfacing ------------

describe("runMeetingCloseout — correlator failure", () => {
  it("surfaces a health item when the correlator itself fails (not low-confidence)", async () => {
    const health = new FakeMeetingHealthSink();
    const failWith: CorrelateErrorCode = "correlation_source_unavailable";
    const deps = makeDeps({
      correlate: new FakeCorrelatePort({ failWith }),
      health,
    });

    const outcome = await runMeetingCloseout(makeInput(), deps);

    // A correlator error is a routing-review park (fail-closed; never guesses).
    expect(outcome.state).toBe("needs_routing_review");
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- REPLAY-SAFETY: re-run from the start reuses commit + external write ----

describe("runMeetingCloseout — replay safety (LIFE-3)", () => {
  it("re-drives from the start after a mid-pipeline restart with NO duplicate commit and NO duplicate external write (inv-5)", async () => {
    // Shared, DURABLE fakes survive the "restart": the commit port and propose port
    // keep their idempotency maps across both drives (as the real KnowledgeWriter +
    // Tool Gateway do). The run repo persists the resolved run.
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const runs = new InMemoryWorkflowRunRepo();

    // First drive completes the durable steps.
    const first = await runMeetingCloseout(makeInput(), makeDeps({ commit, propose, runs }));
    expect(first.state).toBe("summarized");
    expect(commit.writeCount).toBe(1);
    expect(propose.createCount).toBe(1);
    const firstRevision = first.context.revisionId;

    // Simulate a restart: re-drive the WHOLE pipeline from the start with fresh
    // fakes for the pure/read stages but the SAME durable commit/propose/runs.
    const second = await runMeetingCloseout(makeInput(), makeDeps({ commit, propose, runs }));

    expect(second.state).toBe("summarized");
    // The durable writes are REUSED — each happened exactly once across both drives.
    expect(commit.writeCount).toBe(1);
    expect(propose.createCount).toBe(1);
    // The replayed commit returns the SAME revision.
    expect(second.context.revisionId).toBe(firstRevision);
    // The run was reused, not re-created.
    expect(second.runReused).toBe(true);
  });
});

// --- inv-5: EVERY failure branch surfaces a health item --------------------

describe("runMeetingCloseout — nothing fails silently (inv-5)", () => {
  it("every failure branch routes through the health sink", async () => {
    // low-confidence correlation
    {
      const health = new FakeMeetingHealthSink();
      await runMeetingCloseout(
        makeInput(),
        makeDeps({ correlate: new FakeCorrelatePort({ confidence: "low" }), health }),
      );
      expect(health.surfaced.length).toBeGreaterThanOrEqual(1);
    }
    // broker rejection
    {
      const health = new FakeMeetingHealthSink();
      await runMeetingCloseout(
        makeInput(),
        makeDeps({ agent: new FakeAgentJobPort({ result: "rejected" }), health }),
      );
      expect(health.surfaced.length).toBeGreaterThanOrEqual(1);
    }
    // validator rejection
    {
      const health = new FakeMeetingHealthSink();
      await runMeetingCloseout(
        makeInput(),
        makeDeps({ validate: new FakeValidatePort({ forceSchemaReject: true }), health }),
      );
      expect(health.surfaced.length).toBeGreaterThanOrEqual(1);
    }
    // write conflict
    {
      const health = new FakeMeetingHealthSink();
      await runMeetingCloseout(
        makeInput(),
        makeDeps({ commit: new FakeCommitPort({ failWith: "write_conflict" }), health }),
      );
      expect(health.surfaced.length).toBeGreaterThanOrEqual(1);
    }
    // output-derivation failure (buildOutputs fails → schema_rejected, no commit)
    {
      const health = new FakeMeetingHealthSink();
      const commit = new FakeCommitPort();
      await runMeetingCloseout(
        makeInput(),
        makeDeps({
          buildOutputs: new FakeBuildOutputsPort({ failWith: "build_failed" }),
          commit,
          health,
        }),
      );
      expect(health.surfaced.length).toBeGreaterThanOrEqual(1);
      expect(commit.writeCount).toBe(0);
    }
  });
});

// --- REGRESSION: the outputs are DERIVED from validated data, never caller-supplied
//
// These pin the two adversarial-verify findings the buildOutputs seam closes:
//   CRITICAL — an inferred owner/date is rejected at validate, so buildOutputs is
//     NEVER reached and commit NEVER runs (the no-inference gate is no longer
//     theater: a caller cannot smuggle an inferred value into a pre-built plan).
//   HIGH — the committed plan's workspaceId is the CORRELATION-BOUND workspace, not
//     a caller-controlled value; a caller cannot redirect the durable write.
// Plus: the derived owner/date frontmatter comes ONLY from the validated fields.

describe("runMeetingCloseout — outputs derived from validated data (regression)", () => {
  it("[CRITICAL] an inferred owner is rejected at validate → schema_rejected; buildOutputs + commit NEVER run", async () => {
    const buildOutputs = new FakeBuildOutputsPort();
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const health = new FakeMeetingHealthSink();
    // An inferred owner (concrete value, NO evidenceRef) — the REAL no-inference
    // rule hard-rejects it at validate (REQ-F-017), BEFORE any output is derived.
    const inferred = makeAgentExtraction({
      fields: { owner: { value: "Alice" }, dueDate: { value: "2026-08-01" } },
    });
    const deps = makeDeps({
      agent: new FakeAgentJobPort({ result: "accepted", extraction: inferred }),
      buildOutputs,
      commit,
      propose,
      health,
    });

    const outcome = await runMeetingCloseout(makeInput(), deps);

    expect(outcome.state).toBe("schema_rejected");
    // The bypass is closed: the inferred value can NEVER reach the deriver or the
    // KnowledgeWriter — buildOutputs was never called, commit never ran.
    expect(buildOutputs.calls).toHaveLength(0);
    expect(commit.writeCount).toBe(0);
    expect(propose.createCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("[HIGH] the committed plan targets the CORRELATION-BOUND workspace, not a caller value", async () => {
    // Bind workspace W at correlation; the caller has no plan/workspace input at all.
    const boundWs = "ws-correlation-bound" as WorkspaceId;
    const buildOutputs = new FakeBuildOutputsPort();
    // Capture the plan the driver actually hands to commit.
    const committedPlans: KnowledgeMutationPlanCapture[] = [];
    const commit = new CapturingCommitPort(committedPlans);
    const deps = makeDeps({
      correlate: new FakeCorrelatePort({ confidence: "high", workspaceId: boundWs }),
      buildOutputs,
      commit,
    });

    const outcome = await runMeetingCloseout(makeInput(), deps);

    expect(outcome.state).toBe("summarized");
    // buildOutputs was handed the bound workspace (WS-2/WS-4) — not a caller field.
    expect(buildOutputs.calls).toHaveLength(1);
    expect(buildOutputs.calls[0]?.workspaceId).toBe(boundWs);
    // The plan that actually reached the commit carries the bound workspace.
    expect(committedPlans).toHaveLength(1);
    expect(committedPlans[0]?.workspaceId).toBe(boundWs);
  });

  it("the derived owner/date frontmatter comes ONLY from the validated extraction fields", async () => {
    const buildOutputs = new FakeBuildOutputsPort();
    const committedPlans: KnowledgeMutationPlanCapture[] = [];
    const commit = new CapturingCommitPort(committedPlans);
    // A validated extraction with an evidence-backed owner + a TBD dueDate.
    const validExtraction = makeAgentExtraction({
      fields: {
        owner: { value: "Carol", evidenceRef: "transcript#L42" },
        dueDate: { value: "TBD" as never },
      },
    });
    const deps = makeDeps({
      agent: new FakeAgentJobPort({ result: "accepted", extraction: validExtraction }),
      buildOutputs,
      commit,
    });

    const outcome = await runMeetingCloseout(makeInput(), deps);

    expect(outcome.state).toBe("summarized");
    // buildOutputs received exactly the validated fields.
    expect(buildOutputs.calls[0]?.validated.fields.owner?.value).toBe("Carol");
    // The committed plan's frontmatter carries the VALIDATED owner value (derived),
    // and the unstated dueDate stays TBD — never invented.
    const create = committedPlans[0]?.creates[0];
    expect(create?.frontmatter?.owner).toBe("Carol");
    expect(create?.frontmatter?.dueDate).toBe("TBD");
  });

  it("a caller cannot inject a plan: the input has no plan/actions surface (compile-time proof) and the write is derived", async () => {
    // MeetingCloseoutInput has NO `plan`/`actions` fields — the only way outputs
    // reach the commit is via the injected BuildOutputsPort. This test drives the
    // full happy path with a derived one-action plan and asserts exactly one commit
    // + one external create came from the DERIVED outputs.
    const commit = new FakeCommitPort();
    const propose = new FakeProposePort();
    const deps = makeDeps({
      buildOutputs: new FakeBuildOutputsPort({ actionCount: 1 }),
      commit,
      propose,
    });

    const outcome = await runMeetingCloseout(makeInput(), deps);

    expect(outcome.state).toBe("summarized");
    expect(commit.writeCount).toBe(1);
    expect(propose.createCount).toBe(1);
    // A derivation failure would fold to schema_rejected with no partial commit.
    const failing = new FakeCommitPort();
    const failedOutcome = await runMeetingCloseout(
      makeInput(),
      makeDeps({
        buildOutputs: new FakeBuildOutputsPort({
          failWith: "unmappable_extraction" satisfies BuildOutputsFailureCode,
        }),
        commit: failing,
      }),
    );
    expect(failedOutcome.state).toBe("schema_rejected");
    expect(failing.writeCount).toBe(0);
  });
});

// ── G5: the low-confidence routing-review PARK (closes G5) ──────────────────────
// On a low-confidence correlation (inv-1: NO workspace guess) the un-routable meeting must be durably
// PARKED into the Ingestion Inbox (via the injected MeetingParkPort) so a human can reroute it (15.8) —
// not merely health-surfaced. The routing-TARGET workspace stays UNBOUND; the park is idempotent
// (first-write-wins by source identity); a park fault surfaces a DISTINCT health signal + still resolves
// needs_routing_review (never a false "parked"); a correlator ERROR does NOT park.
describe("runMeetingCloseout — G5 low-confidence park", () => {
  it("low_confidence_meeting_parks_a_disposition — a confidence:'low' outcome durably parks (via deps.park) keyed by the meeting identity; state = needs_routing_review — spec(§19.2/§9)", async () => {
    const park = new FakeMeetingParkPort();
    const deps = makeDeps({
      correlate: new FakeCorrelatePort({ confidence: "low", reason: "ambiguous" }),
      park,
    });
    const outcome = await runMeetingCloseout(makeInput(), deps);
    expect(outcome.state).toBe("needs_routing_review");
    expect(park.calls).toHaveLength(1);
    expect(park.calls[0]?.idempotencyKey).toBe(String(makeInput().run.workflowId)); // the meeting identity
    expect(park.parked.size).toBe(1); // durably parked to the inbox
  });

  it("parked_disposition_binds_no_routing_workspace — the parked source carries NO guessed routing-target workspace (inv-1); the driver never binds context.workspaceId on a low-confidence park (WS-8) — spec(§9 inv-1)", async () => {
    const park = new FakeMeetingParkPort();
    const deps = makeDeps({
      correlate: new FakeCorrelatePort({ confidence: "low", reason: "ambiguous" }),
      park,
    });
    const input = makeInput();
    const outcome = await runMeetingCloseout(input, deps);
    // The routing-target workspace is UNBOUND — the driver never guessed one (inv-1 / WS-2).
    expect(outcome.context.workspaceId).toBeUndefined();
    // The park was handed the ORIGINAL source unchanged (no rebind / no invented routing target).
    expect(park.calls[0]?.source).toBe(input.context.source);
  });

  it("low_confidence_park_is_idempotent — a re-driven low-confidence meeting parks ONCE (the store is first-write-wins by source identity; no duplicate inbox row) — spec(rule 3 / L36)", async () => {
    const park = new FakeMeetingParkPort();
    const correlate = new FakeCorrelatePort({ confidence: "low", reason: "ambiguous" });
    const deps = makeDeps({ correlate, park });
    await runMeetingCloseout(makeInput(), deps);
    await runMeetingCloseout(makeInput(), deps); // replay / re-drive of the SAME low-confidence meeting
    expect(park.calls).toHaveLength(2); // the driver attempts the park on every drive…
    expect(park.parked.size).toBe(1); // …but the store dedupes → ONE inbox row (rule 3)
  });

  it("park_write_fault_surfaces_and_does_not_false_park — a park-store fault surfaces a DISTINCT (write_through_failed) health signal + resolves needs_routing_review, never a false 'parked' nor a silent loss — spec(§9 fail-safe / §16)", async () => {
    const park = new FakeMeetingParkPort({ fail: true });
    const health = new FakeMeetingHealthSink();
    const deps = makeDeps({
      correlate: new FakeCorrelatePort({ confidence: "low", reason: "ambiguous" }),
      park,
      health,
    });
    const outcome = await runMeetingCloseout(makeInput(), deps);
    expect(outcome.state).toBe("needs_routing_review"); // still resolves — never a false "parked"
    expect(outcome.surfaced?.failureClass).toBe("write_through_failed"); // a DISTINCT park-failed signal
    expect(health.surfaced.some((f) => f.failureClass === "write_through_failed")).toBe(true); // nothing silent
  });

  it("correlator_error_does_not_park — a correlator ERROR health-surfaces WITHOUT a park row (a transient source fault is a retry candidate, not a routing-review item) — spec(§9 Q4)", async () => {
    const park = new FakeMeetingParkPort();
    const deps = makeDeps({
      correlate: new FakeCorrelatePort({ failWith: "correlation_source_unavailable" }),
      park,
    });
    const outcome = await runMeetingCloseout(makeInput(), deps);
    expect(outcome.state).toBe("needs_routing_review");
    expect(park.calls).toHaveLength(0); // NO spurious inbox row on a transient correlator fault
  });

  it("high_confidence_meeting_does_not_park — a high-confidence outcome runs the full pipeline with ZERO park write (no regression / no misroute) — spec(§9)", async () => {
    const park = new FakeMeetingParkPort();
    const deps = makeDeps({
      correlate: new FakeCorrelatePort({ confidence: "high", workspaceId: WS }),
      park,
    });
    const outcome = await runMeetingCloseout(makeInput(), deps);
    expect(outcome.state).not.toBe("needs_routing_review");
    expect(park.calls).toHaveLength(0);
  });
});
