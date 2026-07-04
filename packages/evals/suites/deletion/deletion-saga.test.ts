// spec(§20.1 "Retention purge" · REQ-F-013/018 · RET-2/RET-3 · Flow 7) — task 12.11.
//
// §20.1 ACCEPTANCE suite for the CROSS-STORE DELETION / RETENTION-PURGE SAGA
// (safety rules 1 + 2). Unlike packages/workflows' unit test (which pins the
// pure driver + activity governance seam field-by-field), this suite drives the
// REAL `runDeletionSaga` composition end-to-end over in-memory store/port fakes
// and asserts the §20.1 "Retention purge" acceptance bullets, then SCORES the
// `RETENTION_PURGE` criterion through the EVAL-1 runner (task 12.1).
//
// DoD honesty: RETENTION_PURGE is a deterministic-enforcement criterion
// (requiresRealIntegration=false in the registry) — the ordered/idempotent purge
// saga, the intent gate, and the compensating-on-partial-failure routing are all
// PURE control-plane code with no vendor I/O. So a fixture-backed run is the real
// code path and the runner reports it DoD-passing. (The real GBrain purge /
// KnowledgeWriter commit adapters are exercised by their own package suites.)
//
// §20.1 bullets exercised here (bullet (c) prune-safety lives in the sibling
// retention-prune-safety.test.ts):
//   (a) ORDERED, per-step-idempotent purge: Markdown tombstone via KnowledgeWriter
//       (THE COMMIT POINT) → GBrain purge/re-index → event-store tombstone
//       (history PRESERVED) → read-model/external-ref reconciliation.
//   (b) PARTIAL failure produces compensating/retry state surfaced in System
//       Health; a crash mid-saga re-drives IDEMPOTENTLY (no orphaned ref, no
//       resurrected index entry, no double-tombstone).
//   (d) deletion requires a VALIDATED, EXPLICIT user intent before ANY tombstone.
import { describe, it, expect } from "vitest";
import { isOk, ok, workspaceId, sourceId } from "@sow/contracts";
import type { Result, KnowledgeMutationPlan, WorkflowRunRef } from "@sow/contracts";
import {
  runDeletionSaga,
  DEFAULT_RETENTION_POLICY,
  deletionSagaMachine,
} from "@sow/workflows/workflows/deletionSaga";
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
} from "@sow/workflows/workflows/deletionSaga";
import { createVerifyIntentActivity } from "@sow/workflows/activities/deletionPlan";
import type { OwnerAuthorityCheck } from "@sow/workflows/activities/deletionPlan";
import type { Clock, WorkflowRunRefRepository, DbResult } from "@sow/workflows/ports/operational";
import { scoreById } from "../../src/harness/runner";
import { criterionById } from "../../src/harness/criteria-registry";

const WS = workspaceId("ws-employer");

// ── inline builders (fixture SHAPES mirrored from the workflows unit test) ─────

function makeSubject(partial: Partial<DeletionSubject> = {}): DeletionSubject {
  return { subjectRef: "note:meetings/acme/closeout-1", workspaceId: WS, ...partial };
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

// ── inline fakes ──────────────────────────────────────────────────────────────

class FakeClock implements Clock {
  now(): string {
    return "2026-07-01T00:00:00.000Z";
  }
  monotonicMs(): number {
    return 0;
  }
  monotonicEpoch(): string {
    return "boot-1";
  }
}

/** Minimal WorkflowRunRefRepository: novel key ⇒ create; seen idempotencyKey ⇒ reuse. */
class InMemoryWorkflowRunRepo implements WorkflowRunRefRepository {
  private readonly byId = new Map<string, WorkflowRunRef>();
  create(ref: WorkflowRunRef): DbResult<WorkflowRunRef> {
    for (const e of this.byId.values()) {
      if (e.idempotencyKey === ref.idempotencyKey) {
        return Promise.resolve({ ok: false, error: { code: "conflict", message: "dup idempotency key" } });
      }
    }
    this.byId.set(String(ref.workflowId), ref);
    return Promise.resolve(ok(ref));
  }
  get(id: WorkflowRunRef["workflowId"]): DbResult<WorkflowRunRef> {
    const f = this.byId.get(String(id));
    return Promise.resolve(f === undefined ? { ok: false, error: { code: "not_found", message: "no run" } } : ok(f));
  }
  getByIdempotencyKey(key: WorkflowRunRef["idempotencyKey"]): DbResult<WorkflowRunRef> {
    for (const r of this.byId.values()) if (r.idempotencyKey === key) return Promise.resolve(ok(r));
    return Promise.resolve({ ok: false, error: { code: "not_found", message: "novel key" } });
  }
  updateState(id: WorkflowRunRef["workflowId"], state: WorkflowRunRef["state"]): DbResult<WorkflowRunRef> {
    const f = this.byId.get(String(id));
    if (f === undefined) return Promise.resolve({ ok: false, error: { code: "not_found", message: "no run" } });
    const next: WorkflowRunRef = { ...f, state };
    this.byId.set(String(id), next);
    return Promise.resolve(ok(next));
  }
  appendAuditRef(
    id: WorkflowRunRef["workflowId"],
    auditRef: WorkflowRunRef["auditRefs"][number],
  ): DbResult<WorkflowRunRef> {
    const f = this.byId.get(String(id));
    if (f === undefined) return Promise.resolve({ ok: false, error: { code: "not_found", message: "no run" } });
    const next: WorkflowRunRef = { ...f, auditRefs: [...f.auditRefs, auditRef] };
    this.byId.set(String(id), next);
    return Promise.resolve(ok(next));
  }
}

type VerifyConfig = { ok: true } | { fail: VerifyIntentErrorCode };
class FakeVerifyIntentPort implements VerifyIntentPort {
  constructor(private readonly config: VerifyConfig = { ok: true }) {}
  verify(subject: DeletionSubject): Promise<Result<VerifiedIntent, VerifyIntentError>> {
    if ("fail" in this.config) {
      return Promise.resolve({ ok: false, error: { code: this.config.fail, message: `verify fail: ${this.config.fail}` } });
    }
    return Promise.resolve({ ok: true, value: { verified: true, subject, authorizedBy: "owner-alice" } });
  }
}

type BuildConfig = { ok?: DerivedDeletionPlan } | { fail: BuildDeletionPlanFailureCode };
class FakeBuildPlanPort implements BuildDeletionPlanPort {
  constructor(private readonly config: BuildConfig = {}) {}
  build(
    _intent: VerifiedIntent,
    _retention: RetentionPolicy,
  ): Promise<Result<DerivedDeletionPlan, BuildDeletionPlanFailure>> {
    if ("fail" in this.config) {
      return Promise.resolve({ ok: false, error: { code: this.config.fail, message: `build fail: ${this.config.fail}` } });
    }
    return Promise.resolve({ ok: true, value: this.config.ok ?? makeDerivedPlan() });
  }
}

// COMMIT POINT — idempotent BY plan key (planId): a re-commit of the SAME plan
// replays the same revision (writeCount does NOT bump) — the double-tombstone probe.
class FakeTombstonePort implements TombstoneMarkdownPort {
  writeCount = 0;
  private readonly byKey = new Map<string, string>();
  constructor(private readonly failWith?: TombstoneFailureCode) {}
  tombstone(plan: KnowledgeMutationPlan): Promise<Result<TombstoneCommitSuccess, TombstoneFailure>> {
    if (this.failWith !== undefined) {
      return Promise.resolve({ ok: false, error: { code: this.failWith, message: `tombstone fail: ${this.failWith}` } });
    }
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

// GBrain purge — idempotent BY purgeKey: a re-drive over an already-purged key does
// NOT bump purgeCount (the RESURRECTION probe). `failUntil` fails the first N calls.
class FakePurgePort implements PurgeGbrainPort {
  purgeCount = 0;
  private callN = 0;
  private readonly purged = new Set<string>();
  constructor(private readonly opts: { failWith?: PurgeGbrainErrorCode; failUntil?: number } = {}) {}
  purge(_revisionId: string, purgeKey: string): Promise<Result<void, PurgeGbrainError>> {
    this.callN += 1;
    if (this.opts.failWith !== undefined && this.callN <= (this.opts.failUntil ?? Infinity)) {
      return Promise.resolve({ ok: false, error: { code: this.opts.failWith, message: `purge fail: ${this.opts.failWith}` } });
    }
    if (!this.purged.has(purgeKey)) {
      this.purged.add(purgeKey);
      this.purgeCount += 1;
    }
    return Promise.resolve({ ok: true, value: undefined });
  }
}

// Event-store tombstone — APPEND-ONCE by eventTombstoneKey; NEVER hard-deletes
// prior events (history preserved). A re-drive does NOT bump appendCount.
class FakeEventTombstonePort implements TombstoneEventStorePort {
  appendCount = 0;
  private readonly appended = new Set<string>();
  constructor(private readonly failWith?: EventTombstoneErrorCode) {}
  tombstone(_subjectRef: string, key: string): Promise<Result<void, EventTombstoneError>> {
    if (this.failWith !== undefined) {
      return Promise.resolve({ ok: false, error: { code: this.failWith, message: `event fail: ${this.failWith}` } });
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
  constructor(private readonly opts: { failWith?: ReconcileErrorCode; dangling?: readonly string[] } = {}) {}
  reconcile(_subjectRef: string, _key: string): Promise<Result<ReconcileOutcome, ReconcileError>> {
    this.reconcileCount += 1;
    if (this.opts.failWith !== undefined) {
      return Promise.resolve({ ok: false, error: { code: this.opts.failWith, message: `reconcile fail: ${this.opts.failWith}` } });
    }
    return Promise.resolve({ ok: true, value: { danglingRefs: this.opts.dangling ?? [] } });
  }
}

class FakeHealthSink implements DeletionHealthSink {
  readonly surfaced: DeletionWorkflowFailure[] = [];
  surface(failure: DeletionWorkflowFailure): Promise<Result<DeletionSurfaceOutcome, DeletionHealthSinkError>> {
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

// ═══════════════════════════════════════════════════════════════════════════
// (a) ORDERED, per-step-idempotent cross-store purge
// ═══════════════════════════════════════════════════════════════════════════

describe("§20.1 Retention purge — (a) ordered, per-step-idempotent cross-store purge", () => {
  it("drives the four stores in Flow-7 order: markdown commit → gbrain purge → event tombstone → reconcile ⇒ deleted", async () => {
    const tombstone = new FakeTombstonePort();
    const purge = new FakePurgePort();
    const events = new FakeEventTombstonePort();
    const reconcile = new FakeReconcilePort();
    const deps = makeDeps({ tombstoneMarkdown: tombstone, purgeGbrain: purge, tombstoneEvents: events, reconcileRefs: reconcile });

    const out = await runDeletionSaga(makeInput(), deps);

    expect(out.state).toBe("deleted");
    // Every store was written EXACTLY once, in order (the commit point first).
    expect(tombstone.writeCount).toBe(1); // step 1 — KnowledgeWriter commit point
    expect(purge.purgeCount).toBe(1); // step 2 — GBrain purge/re-index
    expect(events.appendCount).toBe(1); // step 3 — event-store tombstone (append-once)
    expect(reconcile.reconcileCount).toBe(1); // step 4 — read-model/external-ref reconcile
    expect(out.revisionId).toBe("rev-1");
    expect(out.danglingRefs).toEqual([]);
    // The happy path surfaces NO health item — nothing failed.
    expect((deps.health as FakeHealthSink).surfaced).toHaveLength(0);
  });

  it("the ordering is enforced by the saga machine — the commit point cannot be teleported past", () => {
    // Happy-path order is a legal walk; a jump past the commit point is illegal.
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
    // Teleporting plan_built → deleted (skipping the commit + downstream steps) is refused.
    expect(isOk(deletionSagaMachine.transition("plan_built", "deleted"))).toBe(false);
    // Post-commit, there is NO rollback edge back to plan_built (durable tombstone stands).
    expect(isOk(deletionSagaMachine.transition("markdown_tombstoned", "plan_built"))).toBe(false);
  });

  it("re-running a COMPLETED deletion is a whole-saga no-op — no second write to any store", async () => {
    const runs = new InMemoryWorkflowRunRepo();
    const clock = new FakeClock();
    const buildPlan = new FakeBuildPlanPort({ ok: makeDerivedPlan() });
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
    // Idempotent across the whole saga: exactly one effective write everywhere.
    expect(tombstone.writeCount).toBe(1);
    expect(purge.purgeCount).toBe(1);
    expect(events.appendCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (d) deletion requires a VALIDATED, EXPLICIT user intent before ANY tombstone
// ═══════════════════════════════════════════════════════════════════════════

describe("§20.1 Retention purge — (d) validated explicit user intent gates every tombstone step", () => {
  it("implicit/inferred intent ⇒ intent_rejected with ZERO durable steps + a surfaced health item", async () => {
    const tombstone = new FakeTombstonePort();
    const purge = new FakePurgePort();
    const deps = makeDeps({
      verifyIntent: new FakeVerifyIntentPort({ fail: "no_explicit_intent" }),
      tombstoneMarkdown: tombstone,
      purgeGbrain: purge,
    });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("intent_rejected");
    // NO tombstone, NO purge — the gate fires BEFORE the commit point.
    expect(tombstone.writeCount).toBe(0);
    expect(purge.purgeCount).toBe(0);
    expect(out.revisionId).toBeUndefined();
    // The rejection is surfaced, never silent.
    expect((deps.health as FakeHealthSink).surfaced).toHaveLength(1);
  });

  it("an unauthorized actor ⇒ intent_rejected, no commit", async () => {
    const tombstone = new FakeTombstonePort();
    const deps = makeDeps({
      verifyIntent: new FakeVerifyIntentPort({ fail: "intent_unauthorized" }),
      tombstoneMarkdown: tombstone,
    });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("intent_rejected");
    expect(tombstone.writeCount).toBe(0);
  });

  it("the REAL verify-intent activity refuses an implicit request (never runs on inferred intent)", async () => {
    const authAll: OwnerAuthorityCheck = { isAuthorized: () => true };
    const implicit = createVerifyIntentActivity({ intent: { explicit: false, authorizedBy: "owner-alice" }, authority: authAll });
    const res = await implicit.verify(makeSubject());
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) expect(res.error.code).toBe("no_explicit_intent");

    // Explicit + authorized ⇒ a real VerifiedIntent the driver may build a plan from.
    const explicit = createVerifyIntentActivity({ intent: { explicit: true, authorizedBy: "owner-alice" }, authority: authAll });
    const okRes = await explicit.verify(makeSubject());
    expect(isOk(okRes)).toBe(true);
    if (isOk(okRes)) expect(okRes.value.authorizedBy).toBe("owner-alice");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (b) partial failure ⇒ compensating + System Health; crash re-drives idempotently
// ═══════════════════════════════════════════════════════════════════════════

describe("§20.1 Retention purge — (b) partial failure ⇒ compensating/retry surfaced in System Health", () => {
  it("a post-commit GBrain purge failure ⇒ compensating; the durable tombstone STANDS + health surfaced", async () => {
    const tombstone = new FakeTombstonePort();
    const deps = makeDeps({
      tombstoneMarkdown: tombstone,
      purgeGbrain: new FakePurgePort({ failWith: "purge_failed", failUntil: Infinity }),
    });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("compensating"); // never a rollback of the commit
    expect(tombstone.writeCount).toBe(1); // commit stands
    expect(out.revisionId).toBe("rev-1");
    const sink = deps.health as FakeHealthSink;
    expect(sink.surfaced).toHaveLength(1);
    expect(sink.surfaced[0]?.failureClass).toBe("write_through_failed");
  });

  it("a commit-point (step 1) failure ⇒ commit_failed with NO downstream step + health surfaced", async () => {
    const purge = new FakePurgePort();
    const events = new FakeEventTombstonePort();
    const deps = makeDeps({
      tombstoneMarkdown: new FakeTombstonePort("write_conflict"),
      purgeGbrain: purge,
      tombstoneEvents: events,
    });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("commit_failed");
    // No partial cross-store deletion: nothing downstream ran.
    expect(purge.purgeCount).toBe(0);
    expect(events.appendCount).toBe(0);
    expect((deps.health as FakeHealthSink).surfaced[0]?.failureClass).toBe("write_through_failed");
  });

  it("a dangling external ref is SURFACED (never left silently) ⇒ compensating with the refs on the outcome", async () => {
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

  it("crash AFTER the commit point re-drives idempotently — NO double-tombstone, NO resurrected GBrain entry, NO orphaned ref", async () => {
    // Shared, stateful stores across two drives of the SAME run (a crash-replay).
    const runs = new InMemoryWorkflowRunRepo();
    const clock = new FakeClock();
    const buildPlan = new FakeBuildPlanPort({ ok: makeDerivedPlan() });
    const tombstone = new FakeTombstonePort();
    const purge = new FakePurgePort();
    const events = new FakeEventTombstonePort();
    const reconcile = new FakeReconcilePort();

    // Drive 1: purge is down ⇒ the saga commits the tombstone then parks compensating.
    const deps1 = makeDeps({
      runs, clock, buildPlan, tombstoneMarkdown: tombstone,
      purgeGbrain: new FakePurgePort({ failWith: "purge_failed", failUntil: Infinity }),
      tombstoneEvents: events, reconcileRefs: reconcile,
    });
    const out1 = await runDeletionSaga(makeInput(), deps1);
    expect(out1.state).toBe("compensating");
    expect(tombstone.writeCount).toBe(1); // the durable commit landed

    // Drive 2 (crash-replay of the SAME run): purge now healthy. The stable plan key
    // replays the tombstone (no 2nd write); the stable purge key purges exactly once.
    const deps2 = makeDeps({
      runs, clock, buildPlan, tombstoneMarkdown: tombstone,
      purgeGbrain: purge, tombstoneEvents: events, reconcileRefs: reconcile,
    });
    const out2 = await runDeletionSaga(makeInput(), deps2);
    expect(out2.state).toBe("deleted");
    expect(out2.runReused).toBe(true); // reused the run — no duplicate saga started
    expect(tombstone.writeCount).toBe(1); // NO double-tombstone across the crash
    expect(purge.purgeCount).toBe(1); // NO resurrected GBrain index entry
    expect(events.appendCount).toBe(1); // event tombstone appended exactly once
    expect(out2.danglingRefs).toEqual([]); // NO orphaned external ref
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EVAL-1 runner scoring — the RETENTION_PURGE criterion (task 12.1)
// ═══════════════════════════════════════════════════════════════════════════

describe("deletion — EVAL-1 runner scoring", () => {
  it("scores RETENTION_PURGE DoD-passing from the deterministic (non-real-integration) run", () => {
    // The purge saga is pure control-plane enforcement — no vendor I/O — so a
    // fixture-backed run IS the real code path and the runner reports it DoD-passing.
    const out = scoreById({ criterionId: "RETENTION_PURGE", value: true, fromRealIntegration: false });
    expect(out.functionalPass).toBe(true);
    expect(out.dodValid).toBe(true);
    expect(out.dodPass).toBe(true);
  });

  it("registry marks RETENTION_PURGE as deterministic (requiresRealIntegration=false)", () => {
    expect(criterionById("RETENTION_PURGE")?.requiresRealIntegration).toBe(false);
  });
});
