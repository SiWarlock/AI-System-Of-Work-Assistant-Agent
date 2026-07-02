// spec(§9 / task 7.14) — the CROSS-STORE DELETION SAGA driver + its two activities.
//
// The most safety-critical §9 workflow of this wave (REQ-F-013 / REQ-F-018 / RET-3 /
// Flow 7). These tests pin, with the driver driven over in-memory fakes + the FakeClock
// (no Temporal server, no real store):
//   inv-1  EXPLICIT owner-intent gate — implicit/unauthorized intent → intent_rejected,
//          NO durable step.
//   inv-2  HUMAN-OWNED preservation — a human-owned region is NEVER tombstoned; a
//          human-owned-only subject → plan_rejected; the derived plan carries ONLY
//          non-human-owned regions, and the preserved regions are recorded.
//   inv-3  ORDERED, per-step steps: (1) Markdown tombstone (COMMIT POINT) → (2) GBrain
//          purge → (3) event tombstone (history preserved) → (4) reconcile.
//   inv-4  CRASH-replay idempotency: a crash after step 1 re-drives with NO
//          double-tombstone + NO resurrected GBrain entry; a COMPLETED deletion re-run
//          is a whole-saga no-op.
//   inv-5  PARTIAL post-commit failure → compensating (never a rollback) + a distinct
//          health item; a dangling external ref is surfaced, never silent.
import { describe, it, expect } from "vitest";
import { isOk, workspaceId, sourceId } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  KnowledgeMutationPlan,
} from "@sow/contracts";
import {
  runDeletionSaga,
  DEFAULT_RETENTION_POLICY,
  deletionSagaMachine,
} from "../src/workflows/deletionSaga";
import type {
  DeletionSagaDeps,
  DeletionSagaInput,
  DeletionSubject,
  RetentionPolicy,
  VerifyIntentPort,
  VerifyIntentError,
  VerifyIntentErrorCode,
  VerifiedIntent,
  BuildDeletionPlanPort,
  BuildDeletionPlanFailure,
  BuildDeletionPlanFailureCode,
  DerivedDeletionPlan,
  TombstoneMarkdownPort,
  TombstoneCommitSuccess,
  TombstoneFailure,
  TombstoneFailureCode,
  PurgeGbrainPort,
  PurgeGbrainError,
  PurgeGbrainErrorCode,
  TombstoneEventStorePort,
  EventTombstoneError,
  EventTombstoneErrorCode,
  ReconcileRefsPort,
  ReconcileOutcome,
  ReconcileError,
  ReconcileErrorCode,
  DeletionHealthSink,
  DeletionWorkflowFailure,
  DeletionSurfaceOutcome,
  DeletionHealthSinkError,
} from "../src/workflows/deletionSaga";
import {
  createVerifyIntentActivity,
  createBuildDeletionPlanActivity,
} from "../src/activities/deletionPlan";
import type {
  SubjectRegion,
  SubjectRegionSource,
  DeletionIntentRecord,
  OwnerAuthorityCheck,
} from "../src/activities/deletionPlan";
import { InMemoryWorkflowRunRepo, FakeClock } from "./support/fakes";

const WS = workspaceId("ws-employer");

// --- builders --------------------------------------------------------------

function makeSubject(partial: Partial<DeletionSubject> = {}): DeletionSubject {
  return {
    subjectRef: "note:meetings/acme/closeout-1",
    workspaceId: WS,
    ...partial,
  };
}

function makeInput(partial: Partial<DeletionSagaInput> = {}): DeletionSagaInput {
  return {
    run: {
      workflowId: "wf-del-1" as DeletionSagaInput["run"]["workflowId"],
      trigger: "owner_action",
      idempotencyKey: "idem-del-1",
      workspaceId: "ws-employer",
    },
    subject: makeSubject(),
    ...partial,
  };
}

function makeDerivedPlan(partial: Partial<DerivedDeletionPlan> = {}): DerivedDeletionPlan {
  const plan: KnowledgeMutationPlan = {
    planId: "plan-del-1" as KnowledgeMutationPlan["planId"],
    workspaceId: WS,
    sourceRefs: [{ sourceId: sourceId("src-intent-1") }],
    creates: [],
    patches: [{ path: "meetings/acme/closeout-1.md", regionId: "derived-summary", newBody: "" }],
    linkMutations: [],
    frontmatterUpdates: [],
    externalActionProposals: [],
    confidence: 1,
    requiresApproval: false,
    provenanceOrigin: "human",
  };
  return {
    plan,
    preservedRegions: [],
    contentDiscriminator: "content-disc-1",
    purgeKey: "purge-key-1",
    eventTombstoneKey: "event-key-1",
    reconcileKey: "reconcile-key-1",
    ...partial,
  };
}

// --- fakes -----------------------------------------------------------------

type VerifyConfig = { ok: true } | { fail: VerifyIntentErrorCode };
class FakeVerifyIntentPort implements VerifyIntentPort {
  readonly calls: DeletionSubject[] = [];
  constructor(private readonly config: VerifyConfig = { ok: true }) {}
  verify(subject: DeletionSubject): Promise<Result<VerifiedIntent, VerifyIntentError>> {
    this.calls.push(subject);
    if ("fail" in this.config) {
      return Promise.resolve({
        ok: false,
        error: { code: this.config.fail, message: `verify fail: ${this.config.fail}` },
      });
    }
    return Promise.resolve({
      ok: true,
      value: { verified: true, subject, authorizedBy: "owner-alice" },
    });
  }
}

type BuildConfig = { ok?: DerivedDeletionPlan } | { fail: BuildDeletionPlanFailureCode };
class FakeBuildPlanPort implements BuildDeletionPlanPort {
  readonly calls: { intent: VerifiedIntent; retention: RetentionPolicy }[] = [];
  constructor(private readonly config: BuildConfig = {}) {}
  build(
    intent: VerifiedIntent,
    retention: RetentionPolicy,
  ): Promise<Result<DerivedDeletionPlan, BuildDeletionPlanFailure>> {
    this.calls.push({ intent, retention });
    if ("fail" in this.config) {
      return Promise.resolve({
        ok: false,
        error: { code: this.config.fail, message: `build fail: ${this.config.fail}` },
      });
    }
    return Promise.resolve({ ok: true, value: this.config.ok ?? makeDerivedPlan() });
  }
}

// The tombstone fake is idempotent BY plan key (planId): a re-commit of the same plan
// replays the same revision, tracked by `writeCount` — the double-tombstone probe.
class FakeTombstonePort implements TombstoneMarkdownPort {
  writeCount = 0;
  readonly committedPlans: KnowledgeMutationPlan[] = [];
  private readonly byKey = new Map<string, string>();
  constructor(private readonly failWith?: TombstoneFailureCode) {}
  tombstone(
    plan: KnowledgeMutationPlan,
  ): Promise<Result<TombstoneCommitSuccess, TombstoneFailure>> {
    if (this.failWith !== undefined) {
      return Promise.resolve({
        ok: false,
        error: { code: this.failWith, message: `tombstone fail: ${this.failWith}` },
      });
    }
    this.committedPlans.push(plan);
    const key = String(plan.planId);
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      return Promise.resolve({ ok: true, value: { revisionId: existing, replayed: true } });
    }
    this.writeCount += 1;
    const revisionId = `rev-${this.writeCount}`;
    this.byKey.set(key, revisionId);
    return Promise.resolve({ ok: true, value: { revisionId, replayed: false } });
  }
}

// The purge fake is idempotent BY purgeKey: a re-drive over an already-purged key does
// NOT bump `purgeCount` — the resurrection probe. `failUntil` fails the first N calls
// (models a transient post-commit purge failure that recovers on re-drive).
class FakePurgePort implements PurgeGbrainPort {
  purgeCount = 0;
  private callN = 0;
  private readonly purged = new Set<string>();
  constructor(
    private readonly opts: { failWith?: PurgeGbrainErrorCode; failUntil?: number } = {},
  ) {}
  purge(revisionId: string, purgeKey: string): Promise<Result<void, PurgeGbrainError>> {
    this.callN += 1;
    if (this.opts.failWith !== undefined && this.callN <= (this.opts.failUntil ?? Infinity)) {
      return Promise.resolve({
        ok: false,
        error: { code: this.opts.failWith, message: `purge fail: ${this.opts.failWith}` },
      });
    }
    if (!this.purged.has(purgeKey)) {
      this.purged.add(purgeKey);
      this.purgeCount += 1;
    }
    return Promise.resolve({ ok: true, value: undefined });
  }
}

// The event-tombstone fake is append-once BY eventTombstoneKey: a re-drive does NOT
// bump `appendCount` — the double-tombstone probe. It NEVER hard-deletes (append-only).
class FakeEventTombstonePort implements TombstoneEventStorePort {
  appendCount = 0;
  private readonly appended = new Set<string>();
  constructor(private readonly failWith?: EventTombstoneErrorCode) {}
  tombstone(subjectRef: string, key: string): Promise<Result<void, EventTombstoneError>> {
    if (this.failWith !== undefined) {
      return Promise.resolve({
        ok: false,
        error: { code: this.failWith, message: `event fail: ${this.failWith}` },
      });
    }
    if (!this.appended.has(key)) {
      this.appended.add(key);
      this.appendCount += 1;
    }
    return Promise.resolve({ ok: true, value: undefined });
  }
}

class FakeReconcilePort implements ReconcileRefsPort {
  reconcileCount = 0;
  constructor(
    private readonly opts: { failWith?: ReconcileErrorCode; dangling?: readonly string[] } = {},
  ) {}
  reconcile(subjectRef: string, key: string): Promise<Result<ReconcileOutcome, ReconcileError>> {
    this.reconcileCount += 1;
    if (this.opts.failWith !== undefined) {
      return Promise.resolve({
        ok: false,
        error: { code: this.opts.failWith, message: `reconcile fail: ${this.opts.failWith}` },
      });
    }
    return Promise.resolve({ ok: true, value: { danglingRefs: this.opts.dangling ?? [] } });
  }
}

class FakeHealthSink implements DeletionHealthSink {
  readonly surfaced: DeletionWorkflowFailure[] = [];
  surface(
    failure: DeletionWorkflowFailure,
  ): Promise<Result<DeletionSurfaceOutcome, DeletionHealthSinkError>> {
    this.surfaced.push(failure);
    return Promise.resolve({ ok: true, value: { routedToHealth: true, routedToOutbox: false } });
  }
}

function makeDeps(overrides: Partial<DeletionSagaDeps> = {}): DeletionSagaDeps {
  return {
    verifyIntent: new FakeVerifyIntentPort(),
    buildPlan: new FakeBuildPlanPort(),
    tombstoneMarkdown: new FakeTombstonePort(),
    purgeGbrain: new FakePurgePort(),
    tombstoneEvents: new FakeEventTombstonePort(),
    reconcileRefs: new FakeReconcilePort(),
    health: new FakeHealthSink(),
    runs: new InMemoryWorkflowRunRepo(),
    clock: new FakeClock(),
    ...overrides,
  };
}

// ===========================================================================
// The local state machine
// ===========================================================================

describe("spec(§9 task 7.14) deletionSagaMachine — pure/total, ordered, compensating", () => {
  it("walks the ordered happy path requested → deleted", () => {
    const order = [
      "requested",
      "intent_verified",
      "plan_built",
      "markdown_tombstoned",
      "gbrain_purged",
      "events_tombstoned",
      "refs_reconciled",
      "deleted",
    ] as const;
    let cursor: (typeof order)[number] = "requested";
    for (let i = 1; i < order.length; i++) {
      const step = deletionSagaMachine.transition(cursor, order[i]!);
      expect(isOk(step)).toBe(true);
      if (isOk(step)) cursor = step.value as (typeof order)[number];
    }
    expect(cursor).toBe("deleted");
    expect(deletionSagaMachine.isTerminal("deleted")).toBe(true);
  });

  it("FORBIDS teleporting past the commit point (plan_built → deleted is illegal)", () => {
    const step = deletionSagaMachine.transition("plan_built", "deleted");
    expect(isOk(step)).toBe(false);
  });

  it("post-commit steps can only reach a downstream step OR compensating (never rollback)", () => {
    // markdown_tombstoned cannot go back to plan_built (no rollback of the durable commit).
    expect(isOk(deletionSagaMachine.transition("markdown_tombstoned", "plan_built"))).toBe(false);
    expect(isOk(deletionSagaMachine.transition("markdown_tombstoned", "gbrain_purged"))).toBe(true);
    expect(isOk(deletionSagaMachine.transition("markdown_tombstoned", "compensating"))).toBe(true);
  });
});

// ===========================================================================
// inv-1 — EXPLICIT owner intent
// ===========================================================================

describe("spec(§9 inv-1 REQ-F-013) explicit owner intent gate", () => {
  it("implicit intent → intent_rejected with NO durable step + a distinct health item", async () => {
    const tombstone = new FakeTombstonePort();
    const deps = makeDeps({
      verifyIntent: new FakeVerifyIntentPort({ fail: "no_explicit_intent" }),
      tombstoneMarkdown: tombstone,
    });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("intent_rejected");
    // NO durable step happened.
    expect(tombstone.writeCount).toBe(0);
    expect(out.revisionId).toBeUndefined();
    // Distinct health item routed (nothing silent).
    const sink = deps.health as FakeHealthSink;
    expect(sink.surfaced).toHaveLength(1);
    expect(sink.surfaced[0]?.failureClass).toBe("conflict_review");
  });

  it("unauthorized actor → intent_rejected, no commit", async () => {
    const tombstone = new FakeTombstonePort();
    const deps = makeDeps({
      verifyIntent: new FakeVerifyIntentPort({ fail: "intent_unauthorized" }),
      tombstoneMarkdown: tombstone,
    });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("intent_rejected");
    expect(tombstone.writeCount).toBe(0);
  });
});

// ===========================================================================
// inv-2 — human-owned preservation
// ===========================================================================

describe("spec(§9 inv-2 REQ-F-018/RET-3) human-owned preservation", () => {
  it("human-owned-only subject → plan_rejected (refused), NO tombstone commit", async () => {
    const tombstone = new FakeTombstonePort();
    const deps = makeDeps({
      buildPlan: new FakeBuildPlanPort({ fail: "human_owned_only" }),
      tombstoneMarkdown: tombstone,
    });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("plan_rejected");
    expect(tombstone.writeCount).toBe(0);
    const sink = deps.health as FakeHealthSink;
    expect(sink.surfaced[0]?.failureClass).toBe("conflict_review");
  });

  it("retention-blocked subject → plan_rejected (inside the RET-3 window), NO commit", async () => {
    const tombstone = new FakeTombstonePort();
    const deps = makeDeps({
      buildPlan: new FakeBuildPlanPort({ fail: "retention_blocked" }),
      tombstoneMarkdown: tombstone,
    });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("plan_rejected");
    expect(tombstone.writeCount).toBe(0);
  });

  it("carries the DELIBERATELY-preserved human-owned regions onto the outcome (proof inv-2 ran)", async () => {
    const derived = makeDerivedPlan({ preservedRegions: ["human-notes", "human-decision"] });
    const deps = makeDeps({ buildPlan: new FakeBuildPlanPort({ ok: derived }) });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("deleted");
    expect(out.preservedRegions).toEqual(["human-notes", "human-decision"]);
  });
});

// ===========================================================================
// inv-3 — ordered steps
// ===========================================================================

describe("spec(§9 inv-3 Flow 7) ordered cross-store steps", () => {
  it("happy path drives all four steps in order and ends deleted", async () => {
    const tombstone = new FakeTombstonePort();
    const purge = new FakePurgePort();
    const events = new FakeEventTombstonePort();
    const reconcile = new FakeReconcilePort();
    const deps = makeDeps({
      tombstoneMarkdown: tombstone,
      purgeGbrain: purge,
      tombstoneEvents: events,
      reconcileRefs: reconcile,
    });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("deleted");
    expect(tombstone.writeCount).toBe(1); // step 1 (commit point)
    expect(purge.purgeCount).toBe(1); // step 2
    expect(events.appendCount).toBe(1); // step 3 (append-once)
    expect(reconcile.reconcileCount).toBe(1); // step 4
    expect(out.revisionId).toBe("rev-1");
    expect(out.danglingRefs).toEqual([]);
    // Happy path surfaces NO health item.
    expect((deps.health as FakeHealthSink).surfaced).toHaveLength(0);
  });

  it("commit-point (step 1) failure → commit_failed with NO downstream step", async () => {
    const purge = new FakePurgePort();
    const events = new FakeEventTombstonePort();
    const deps = makeDeps({
      tombstoneMarkdown: new FakeTombstonePort("write_conflict"),
      purgeGbrain: purge,
      tombstoneEvents: events,
    });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("commit_failed");
    expect(purge.purgeCount).toBe(0); // no downstream step after a failed commit
    expect(events.appendCount).toBe(0);
    expect((deps.health as FakeHealthSink).surfaced[0]?.failureClass).toBe("write_through_failed");
  });
});

// ===========================================================================
// inv-4 — crash-replay idempotency + completed re-run no-op
// ===========================================================================

describe("spec(§9 inv-4 LIFE-3) crash-mid-saga re-drives idempotently", () => {
  it("crash AFTER step 1: a re-drive from the start does NOT double-tombstone and does NOT resurrect GBrain", async () => {
    // Shared, stateful fakes across two drives (same run — a crash-replay). The plan
    // is stable (same planId) so the tombstone replay is a no-op; the purge key is
    // stable so a re-purge is a no-op.
    const runs = new InMemoryWorkflowRunRepo();
    const clock = new FakeClock();
    const derived = makeDerivedPlan();
    const buildPlan = new FakeBuildPlanPort({ ok: derived });
    const tombstone = new FakeTombstonePort();
    const purge = new FakePurgePort();
    const events = new FakeEventTombstonePort();
    const reconcile = new FakeReconcilePort();

    // Drive 1: crash after step 1 by making step 2 (purge) fail this drive only... but
    // to simulate a true crash we instead cut the first drive short at step 2 with a
    // transient failure, THEN re-drive fully.
    const purge1 = new FakePurgePort({ failWith: "purge_failed", failUntil: Infinity });
    const deps1: DeletionSagaDeps = makeDeps({
      runs, clock, buildPlan, tombstoneMarkdown: tombstone,
      purgeGbrain: purge1, tombstoneEvents: events, reconcileRefs: reconcile,
    });
    const out1 = await runDeletionSaga(makeInput(), deps1);
    // Step 1 committed; step 2 failed → compensating (durable tombstone stands).
    expect(out1.state).toBe("compensating");
    expect(tombstone.writeCount).toBe(1);

    // Drive 2 (crash-replay of the SAME run): resolveRun reuses the run; the same
    // stable plan replays the tombstone (no 2nd write); purge now succeeds.
    const deps2: DeletionSagaDeps = makeDeps({
      runs, clock, buildPlan, tombstoneMarkdown: tombstone,
      purgeGbrain: purge, tombstoneEvents: events, reconcileRefs: reconcile,
    });
    const out2 = await runDeletionSaga(makeInput(), deps2);
    expect(out2.state).toBe("deleted");
    expect(out2.runReused).toBe(true); // the run was reused (no duplicate run started)
    // NO double-tombstone: exactly ONE underlying Markdown write across both drives.
    expect(tombstone.writeCount).toBe(1);
    // NO resurrected GBrain entry: exactly ONE effective purge (idempotent by key).
    expect(purge.purgeCount).toBe(1);
    // Event tombstone appended exactly once (append-once).
    expect(events.appendCount).toBe(1);
  });

  it("re-running a COMPLETED deletion is a whole-saga no-op (same terminal, no 2nd write)", async () => {
    const runs = new InMemoryWorkflowRunRepo();
    const clock = new FakeClock();
    const derived = makeDerivedPlan();
    const buildPlan = new FakeBuildPlanPort({ ok: derived });
    const tombstone = new FakeTombstonePort();
    const purge = new FakePurgePort();
    const events = new FakeEventTombstonePort();
    const reconcile = new FakeReconcilePort();
    const shared = { runs, clock, buildPlan, tombstoneMarkdown: tombstone, purgeGbrain: purge, tombstoneEvents: events, reconcileRefs: reconcile };

    const first = await runDeletionSaga(makeInput(), makeDeps(shared));
    expect(first.state).toBe("deleted");
    const second = await runDeletionSaga(makeInput(), makeDeps(shared));
    expect(second.state).toBe("deleted");
    expect(second.runReused).toBe(true);
    // No second underlying write anywhere.
    expect(tombstone.writeCount).toBe(1);
    expect(purge.purgeCount).toBe(1);
    expect(events.appendCount).toBe(1);
  });
});

// ===========================================================================
// inv-5 — partial post-commit failure → compensating + health; dangling refs
// ===========================================================================

describe("spec(§9 inv-5) partial post-commit failure → compensating + health", () => {
  it("event-store (step 3) failure → compensating, tombstone stands, distinct health item", async () => {
    const tombstone = new FakeTombstonePort();
    const deps = makeDeps({
      tombstoneMarkdown: tombstone,
      tombstoneEvents: new FakeEventTombstonePort("append_failed"),
    });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("compensating");
    expect(tombstone.writeCount).toBe(1); // the durable commit stands (no rollback)
    expect(out.revisionId).toBe("rev-1");
    expect((deps.health as FakeHealthSink).surfaced[0]?.failureClass).toBe("write_through_failed");
  });

  it("a dangling external ref is SURFACED (never silent) → compensating with the refs on the outcome", async () => {
    const deps = makeDeps({
      reconcileRefs: new FakeReconcilePort({ dangling: ["gcal:evt-9", "notebooklm:doc-3"] }),
    });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("compensating");
    expect(out.danglingRefs).toEqual(["gcal:evt-9", "notebooklm:doc-3"]);
    const sink = deps.health as FakeHealthSink;
    expect(sink.surfaced).toHaveLength(1);
    expect(sink.surfaced[0]?.message).toContain("dangling");
  });

  it("reconcile hard failure → compensating (durable tombstone stands)", async () => {
    const tombstone = new FakeTombstonePort();
    const deps = makeDeps({
      tombstoneMarkdown: tombstone,
      reconcileRefs: new FakeReconcilePort({ failWith: "reconcile_failed" }),
    });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("compensating");
    expect(tombstone.writeCount).toBe(1);
  });

  it("(d) same-key/different-content commit → NEVER 'deleted' (fail-closed to compensating + health)", async () => {
    // A tombstone port that reports a committed content discriminator DIFFERING from the
    // current derived plan's — a same-key/different-content collision. The driver must
    // FAIL CLOSED to compensating (surfaced via health), never silently succeed.
    const collidingTombstone: TombstoneMarkdownPort = {
      tombstone(): Promise<Result<TombstoneCommitSuccess, TombstoneFailure>> {
        return Promise.resolve({
          ok: true,
          value: {
            revisionId: "rev-stale",
            replayed: true,
            committedContentDiscriminator: "content-disc-STALE",
          },
        });
      },
    };
    const derived = makeDerivedPlan(); // contentDiscriminator: "content-disc-1"
    const purge = new FakePurgePort();
    const deps = makeDeps({
      buildPlan: new FakeBuildPlanPort({ ok: derived }),
      tombstoneMarkdown: collidingTombstone,
      purgeGbrain: purge,
    });
    const out = await runDeletionSaga(makeInput(), deps);
    // NEVER 'deleted' on a content-collision.
    expect(out.state).not.toBe("deleted");
    expect(out.state).toBe("compensating");
    // No downstream step ran (fail-closed BEFORE the purge).
    expect(purge.purgeCount).toBe(0);
    // A distinct 7.5 health item was surfaced (nothing silent — inv-5).
    const sink = deps.health as FakeHealthSink;
    expect(sink.surfaced).toHaveLength(1);
    expect(sink.surfaced[0]?.message).toContain("does not match");
  });
});

// ===========================================================================
// The activities — verify intent + derive plan (the governance seam)
// ===========================================================================

describe("spec(§9 task 7.14) createVerifyIntentActivity — REQ-F-013 gate", () => {
  const authAll: OwnerAuthorityCheck = { isAuthorized: () => true };
  const authNone: OwnerAuthorityCheck = { isAuthorized: () => false };

  it("explicit + authorized → VerifiedIntent", async () => {
    const port = createVerifyIntentActivity({
      intent: { explicit: true, authorizedBy: "owner-alice" },
      authority: authAll,
    });
    const res = await port.verify(makeSubject());
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.verified).toBe(true);
      expect(res.value.authorizedBy).toBe("owner-alice");
    }
  });

  it("implicit request → no_explicit_intent (never runs on inferred intent)", async () => {
    const port = createVerifyIntentActivity({
      intent: { explicit: false, authorizedBy: "owner-alice" },
      authority: authAll,
    });
    const res = await port.verify(makeSubject());
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) expect(res.error.code).toBe("no_explicit_intent");
  });

  it("unauthorized actor → intent_unauthorized", async () => {
    const port = createVerifyIntentActivity({
      intent: { explicit: true, authorizedBy: "not-the-owner" },
      authority: authNone,
    });
    const res = await port.verify(makeSubject());
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) expect(res.error.code).toBe("intent_unauthorized");
  });
});

describe("spec(§9 task 7.14 inv-2) createBuildDeletionPlanActivity — derive + preserve human-owned", () => {
  const verifiedIntent: VerifiedIntent = {
    verified: true,
    subject: makeSubject(),
    authorizedBy: "owner-alice",
  };

  function regionSource(regions: readonly SubjectRegion[]): SubjectRegionSource {
    return { regions: () => regions };
  }

  function buildPortFor(regions: readonly SubjectRegion[]): BuildDeletionPlanPort {
    return createBuildDeletionPlanActivity({
      regionSource: regionSource(regions),
      sourceRef: { sourceId: sourceId("src-intent-1") },
    });
  }

  it("EXCLUDES the human-owned region from the tombstone plan and records it as preserved", async () => {
    const port = buildPortFor([
      { path: "n.md", regionId: "derived-summary", humanOwned: false, contentClass: "derived", contentHash: "h-summary-1" },
      { path: "n.md", regionId: "human-notes", humanOwned: true, contentClass: "derived", contentHash: "h-notes-1" },
    ]);
    const res = await port.build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    // The plan tombstones ONLY the non-human-owned region — the guard reads exactly
    // what flows to the commit (the plan's patches), not a decoy.
    const patchedRegions = res.value.plan.patches.map((p) => p.regionId);
    expect(patchedRegions).toEqual(["derived-summary"]);
    expect(patchedRegions).not.toContain("human-notes");
    // The preserved region is recorded (proof the preservation ran over the real set).
    expect(res.value.preservedRegions).toEqual(["human-notes"]);
    // WS-2/WS-4: the plan is stamped with the BOUND workspace, never a caller value.
    expect(res.value.plan.workspaceId).toBe(WS);
  });

  it("human-owned-ONLY subject → human_owned_only (refuse; never a partial human-owned prune)", async () => {
    const port = buildPortFor([
      { path: "n.md", regionId: "human-notes", humanOwned: true, contentClass: "derived", contentHash: "h-notes-1" },
    ]);
    const res = await port.build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) expect(res.error.code).toBe("human_owned_only");
  });

  it("raw audio WITHOUT an audited synthesis is retention-blocked (RET-3)", async () => {
    const port = buildPortFor([
      { path: "n.md", regionId: "raw-audio", humanOwned: false, contentClass: "raw_audio", auditedSynthesisExists: false, contentHash: "h-audio-1" },
    ]);
    const res = await port.build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) expect(res.error.code).toBe("retention_blocked");
  });

  it("raw audio WITH an audited synthesis is prune-eligible", async () => {
    const port = buildPortFor([
      { path: "n.md", regionId: "raw-audio", humanOwned: false, contentClass: "raw_audio", auditedSynthesisExists: true, contentHash: "h-audio-1" },
    ]);
    const res = await port.build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.plan.patches.map((p) => p.regionId)).toEqual(["raw-audio"]);
  });

  it("other raw content inside the 30d window is retention-blocked; after it is eligible", async () => {
    const inside = buildPortFor([
      { path: "n.md", regionId: "raw-doc", humanOwned: false, contentClass: "raw", ageDays: 5, contentHash: "h-doc-1" },
    ]);
    const insideRes = await inside.build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(insideRes)).toBe(false);

    const after = buildPortFor([
      { path: "n.md", regionId: "raw-doc", humanOwned: false, contentClass: "raw", ageDays: 45, contentHash: "h-doc-1" },
    ]);
    const afterRes = await after.build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(afterRes)).toBe(true);
  });

  it("derives STABLE per-step keys bound to (subject, workspace) so replay is a no-op", async () => {
    const regions: readonly SubjectRegion[] = [
      { path: "n.md", regionId: "derived-summary", humanOwned: false, contentClass: "derived", contentHash: "h-summary-1" },
    ];
    const a = await buildPortFor(regions).build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    const b = await buildPortFor(regions).build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(a) && isOk(b)).toBe(true);
    if (!isOk(a) || !isOk(b)) return;
    expect(a.value.plan.planId).toBe(b.value.plan.planId);
    expect(a.value.purgeKey).toBe(b.value.purgeKey);
    expect(a.value.eventTombstoneKey).toBe(b.value.eventTombstoneKey);
    expect(a.value.reconcileKey).toBe(b.value.reconcileKey);
    // Distinct operations → distinct keys.
    expect(new Set([a.value.purgeKey, a.value.eventTombstoneKey, a.value.reconcileKey]).size).toBe(3);
  });

  // --- content-blindness finding (7.14 adversarial-verify HIGH) -------------

  it("(a) two drives with DIFFERENT region sets → DIFFERENT planId + purgeKey", async () => {
    // A region a human edited to become human-owned is DROPPED between drives; a newly-
    // materialized automated region is ADDED. The keys MUST diverge so the second
    // drive's changed patch set is NOT silently discarded under a stale plan key.
    const drive1 = await buildPortFor([
      { path: "n.md", regionId: "derived-summary", humanOwned: false, contentClass: "derived", contentHash: "h-summary-1" },
    ]).build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    const drive2 = await buildPortFor([
      { path: "n.md", regionId: "derived-summary", humanOwned: false, contentClass: "derived", contentHash: "h-summary-1" },
      { path: "n.md", regionId: "derived-actions", humanOwned: false, contentClass: "derived", contentHash: "h-actions-1" },
    ]).build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(drive1) && isOk(drive2)).toBe(true);
    if (!isOk(drive1) || !isOk(drive2)) return;
    // DIFFERENT content → DIFFERENT keys (no stale-key collision).
    expect(drive1.value.plan.planId).not.toBe(drive2.value.plan.planId);
    expect(drive1.value.purgeKey).not.toBe(drive2.value.purgeKey);
    expect(drive1.value.contentDiscriminator).not.toBe(drive2.value.contentDiscriminator);
    // The second drive's NEW region IS in the tombstone plan (not discarded).
    const drive2Regions = drive2.value.plan.patches.map((p) => p.regionId);
    expect(drive2Regions).toContain("derived-actions");
    expect(drive2Regions).toContain("derived-summary");
  });

  it("(b) crash-replay with IDENTICAL content → SAME keys (idempotent, no double-tombstone)", async () => {
    const regions: readonly SubjectRegion[] = [
      { path: "n.md", regionId: "derived-summary", humanOwned: false, contentClass: "derived", contentHash: "h-summary-1" },
    ];
    const a = await buildPortFor(regions).build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    const b = await buildPortFor(regions).build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(a) && isOk(b)).toBe(true);
    if (!isOk(a) || !isOk(b)) return;
    // Identical derived content → identical keys → an idempotent replay.
    expect(a.value.plan.planId).toBe(b.value.plan.planId);
    expect(a.value.purgeKey).toBe(b.value.purgeKey);
    expect(a.value.contentDiscriminator).toBe(b.value.contentDiscriminator);
  });

  it("(c) SAME {path, regionId}, DIFFERENT contentHash (re-materialized) → DIFFERENT planId + purgeKey → run #2 tombstones + purges", async () => {
    // THE CASE THE FIRST FIX MISSED. Run #1 tombstones the original live content (C1) of
    // region `derived-summary`. The subject is later RE-MATERIALIZED under the SAME region
    // id with NEW live content (C2). Because a tombstone patch always sets newBody = "",
    // hashing the patch set would give run #1 and run #2 the SAME discriminator → SAME
    // planId/purgeKey → run #2 replays run #1's revision (C2 never tombstoned) and the
    // purge no-ops (the re-indexed GBrain entry survives) while the saga reports 'deleted'.
    // Hashing the region's CURRENT contentHash makes the keys DIVERGE so run #2 actually
    // tombstones + purges.
    const run1 = await buildPortFor([
      { path: "n.md", regionId: "derived-summary", humanOwned: false, contentClass: "derived", contentHash: "hash-C1" },
    ]).build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    const run2 = await buildPortFor([
      { path: "n.md", regionId: "derived-summary", humanOwned: false, contentClass: "derived", contentHash: "hash-C2" },
    ]).build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(run1) && isOk(run2)).toBe(true);
    if (!isOk(run1) || !isOk(run2)) return;
    // IDENTICAL region-ID SET but DIFFERENT live content → the keys MUST diverge.
    expect(run1.value.plan.planId).not.toBe(run2.value.plan.planId);
    expect(run1.value.purgeKey).not.toBe(run2.value.purgeKey);
    expect(run1.value.contentDiscriminator).not.toBe(run2.value.contentDiscriminator);
    // The tombstone patch for both is the SAME {path, regionId} with newBody = "" —
    // proving the discriminator is NOT reading the patch body (which is empty) but the
    // region's live contentHash.
    expect(run1.value.plan.patches).toEqual(run2.value.plan.patches);

    // Prove the tombstone port (idempotent BY planId) actually re-writes on run #2 — a
    // shared tombstone fake keyed by planId must bump twice because the plan ids differ.
    const tombstone = new FakeTombstonePort();
    const t1 = await tombstone.tombstone(run1.value.plan);
    const t2 = await tombstone.tombstone(run2.value.plan);
    expect(isOk(t1) && isOk(t2)).toBe(true);
    expect(tombstone.writeCount).toBe(2); // run #2 re-tombstoned C2 (not a replay of C1)

    // Prove the purge port (idempotent BY purgeKey) actually purges on run #2 — a shared
    // purge fake keyed by purgeKey must bump twice because the keys differ. No resurrected
    // GBrain entry.
    const purge = new FakePurgePort();
    const p1 = await purge.purge("rev-run1", run1.value.purgeKey);
    const p2 = await purge.purge("rev-run2", run2.value.purgeKey);
    expect(isOk(p1) && isOk(p2)).toBe(true);
    expect(purge.purgeCount).toBe(2); // run #2 was NOT deduped against run #1
  });

  it("(c') region-SET change still diverges (same-region-id case does not weaken the set-change guard)", async () => {
    // Keep the ORIGINAL region-set-change coverage from the first fix: a DROPPED region /
    // ADDED region between drives still yields divergent keys.
    const run1 = await buildPortFor([
      { path: "n.md", regionId: "derived-v1", humanOwned: false, contentClass: "derived", contentHash: "h-v1" },
    ]).build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    const run2 = await buildPortFor([
      { path: "n.md", regionId: "derived-v2", humanOwned: false, contentClass: "derived", contentHash: "h-v2" },
    ]).build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(run1) && isOk(run2)).toBe(true);
    if (!isOk(run1) || !isOk(run2)) return;
    expect(run1.value.purgeKey).not.toBe(run2.value.purgeKey);
    const purge = new FakePurgePort();
    const p1 = await purge.purge("rev-run1", run1.value.purgeKey);
    const p2 = await purge.purge("rev-run2", run2.value.purgeKey);
    expect(isOk(p1) && isOk(p2)).toBe(true);
    expect(purge.purgeCount).toBe(2);
  });
});
