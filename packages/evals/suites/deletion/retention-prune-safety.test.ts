// spec(§20.1 "Retention purge" · REQ-F-018 · RET-3 · KN-7) — task 12.11.
//
// §20.1 ACCEPTANCE suite, bullet (c): retention prune-safety NEVER deletes
// human-owned sections / derived notes that are still inside their retention
// window. This drives the REAL `createBuildDeletionPlanActivity` (the governance
// deriver that decides WHAT the tombstone plan may touch) plus the REAL
// `runDeletionSaga` composition, and asserts:
//   • a human-owned region is EXCLUDED from the derived tombstone plan and is
//     recorded as deliberately PRESERVED (proof the preservation ran over the
//     real region set, not a decoy);
//   • a human-owned-ONLY subject is REFUSED (human_owned_only) — never a partial
//     human-owned prune — and the saga lands plan_rejected with NO tombstone;
//   • RET-3 retention windows hold: raw meeting audio is prune-blocked until an
//     audited synthesis exists; other raw content is blocked inside its window.
//
// DoD honesty: prune-safety is deterministic control-plane enforcement (the
// RETENTION_PURGE criterion is requiresRealIntegration=false) — no vendor I/O —
// so this fixture-backed run is the real code path. The criterion is scored
// through the EVAL-1 runner in the sibling deletion-saga.test.ts.
import { describe, it, expect } from "vitest";
import { isOk, ok, workspaceId, sourceId } from "@sow/contracts";
import type { Result, KnowledgeMutationPlan, WorkflowRunRef } from "@sow/contracts";
import { runDeletionSaga, DEFAULT_RETENTION_POLICY } from "@sow/workflows/workflows/deletionSaga";
import type {
  DeletionSagaDeps,
  DeletionSagaInput,
  DeletionSubject,
  RetentionPolicy,
  VerifyIntentPort,
  VerifyIntentError,
  VerifiedIntent,
  BuildDeletionPlanPort,
  BuildDeletionPlanFailure,
  BuildDeletionPlanFailureCode,
  DerivedDeletionPlan,
  TombstoneMarkdownPort,
  TombstoneCommitSuccess,
  TombstoneFailure,
  PurgeGbrainPort,
  PurgeGbrainError,
  TombstoneEventStorePort,
  EventTombstoneError,
  ReconcileRefsPort,
  ReconcileOutcome,
  ReconcileError,
  DeletionHealthSink,
  DeletionWorkflowFailure,
  DeletionSurfaceOutcome,
  DeletionHealthSinkError,
} from "@sow/workflows/workflows/deletionSaga";
import { createBuildDeletionPlanActivity } from "@sow/workflows/activities/deletionPlan";
import type { SubjectRegion, SubjectRegionSource } from "@sow/workflows/activities/deletionPlan";
import type { Clock, WorkflowRunRefRepository, DbResult } from "@sow/workflows/ports/operational";

const WS = workspaceId("ws-employer");

const verifiedIntent: VerifiedIntent = {
  verified: true,
  subject: { subjectRef: "note:meetings/acme/closeout-1", workspaceId: WS },
  authorizedBy: "owner-alice",
};

function buildPortFor(regions: readonly SubjectRegion[]): BuildDeletionPlanPort {
  const regionSource: SubjectRegionSource = { regions: () => regions };
  return createBuildDeletionPlanActivity({ regionSource, sourceRef: { sourceId: sourceId("src-intent-1") } });
}

// ═══════════════════════════════════════════════════════════════════════════
// (c) prune-safety over the REAL deriver — human-owned + derived notes preserved
// ═══════════════════════════════════════════════════════════════════════════

describe("§20.1 Retention purge — (c) prune-safety NEVER deletes human-owned sections", () => {
  it("EXCLUDES the human-owned region from the tombstone plan and records it as preserved", async () => {
    const port = buildPortFor([
      { path: "n.md", regionId: "derived-summary", humanOwned: false, contentClass: "derived", contentHash: "h-summary-1" },
      { path: "n.md", regionId: "human-notes", humanOwned: true, contentClass: "derived", contentHash: "h-notes-1" },
    ]);
    const res = await port.build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    // The plan tombstones ONLY the non-human-owned region — read exactly what flows
    // to the KnowledgeWriter commit (the plan's patches), not a decoy descriptor.
    const patched = res.value.plan.patches.map((p) => p.regionId);
    expect(patched).toEqual(["derived-summary"]);
    expect(patched).not.toContain("human-notes");
    // The human-owned region is recorded as deliberately preserved.
    expect(res.value.preservedRegions).toEqual(["human-notes"]);
    // WS-2/WS-4: the plan is stamped with the BOUND workspace, never a caller value.
    expect(res.value.plan.workspaceId).toBe(WS);
  });

  it("a human-owned-ONLY subject is REFUSED (human_owned_only) — never a partial human-owned prune", async () => {
    const port = buildPortFor([
      { path: "n.md", regionId: "human-notes", humanOwned: true, contentClass: "derived", contentHash: "h-notes-1" },
    ]);
    const res = await port.build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) expect(res.error.code).toBe("human_owned_only");
  });

  it("RET-3: raw meeting audio is prune-blocked WITHOUT an audited synthesis, eligible WITH one", async () => {
    const blocked = await buildPortFor([
      { path: "n.md", regionId: "raw-audio", humanOwned: false, contentClass: "raw_audio", auditedSynthesisExists: false, contentHash: "h-audio-1" },
    ]).build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(blocked)).toBe(false);
    if (!isOk(blocked)) expect(blocked.error.code).toBe("retention_blocked");

    const eligible = await buildPortFor([
      { path: "n.md", regionId: "raw-audio", humanOwned: false, contentClass: "raw_audio", auditedSynthesisExists: true, contentHash: "h-audio-1" },
    ]).build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(eligible)).toBe(true);
    if (isOk(eligible)) expect(eligible.value.plan.patches.map((p) => p.regionId)).toEqual(["raw-audio"]);
  });

  it("RET-3: other raw content inside its retention window is blocked; after the window it is eligible", async () => {
    const inside = await buildPortFor([
      { path: "n.md", regionId: "raw-doc", humanOwned: false, contentClass: "raw", ageDays: 5, contentHash: "h-doc-1" },
    ]).build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(inside)).toBe(false);
    if (!isOk(inside)) expect(inside.error.code).toBe("retention_blocked");

    const after = await buildPortFor([
      { path: "n.md", regionId: "raw-doc", humanOwned: false, contentClass: "raw", ageDays: 45, contentHash: "h-doc-1" },
    ]).build(verifiedIntent, DEFAULT_RETENTION_POLICY);
    expect(isOk(after)).toBe(true);
  });
});

// ── inline fakes for the saga-level prune-safety assertions ────────────────────

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

class OkVerifyIntentPort implements VerifyIntentPort {
  verify(subject: DeletionSubject): Promise<Result<VerifiedIntent, VerifyIntentError>> {
    return Promise.resolve({ ok: true, value: { verified: true, subject, authorizedBy: "owner-alice" } });
  }
}

class RefuseBuildPlanPort implements BuildDeletionPlanPort {
  constructor(private readonly code: BuildDeletionPlanFailureCode) {}
  build(_i: VerifiedIntent, _r: RetentionPolicy): Promise<Result<DerivedDeletionPlan, BuildDeletionPlanFailure>> {
    return Promise.resolve({ ok: false, error: { code: this.code, message: `refused: ${this.code}` } });
  }
}

class FixedBuildPlanPort implements BuildDeletionPlanPort {
  constructor(private readonly plan: DerivedDeletionPlan) {}
  build(_i: VerifiedIntent, _r: RetentionPolicy): Promise<Result<DerivedDeletionPlan, BuildDeletionPlanFailure>> {
    return Promise.resolve({ ok: true, value: this.plan });
  }
}

class RecordingTombstonePort implements TombstoneMarkdownPort {
  writeCount = 0;
  tombstone(_plan: KnowledgeMutationPlan): Promise<Result<TombstoneCommitSuccess, TombstoneFailure>> {
    this.writeCount += 1;
    return Promise.resolve({ ok: true, value: { revisionId: `rev-${this.writeCount}`, replayed: false } });
  }
}

class OkPurgePort implements PurgeGbrainPort {
  purge(): Promise<Result<void, PurgeGbrainError>> {
    return Promise.resolve({ ok: true, value: undefined });
  }
}
class OkEventPort implements TombstoneEventStorePort {
  tombstone(): Promise<Result<void, EventTombstoneError>> {
    return Promise.resolve({ ok: true, value: undefined });
  }
}
class OkReconcilePort implements ReconcileRefsPort {
  reconcile(): Promise<Result<ReconcileOutcome, ReconcileError>> {
    return Promise.resolve({ ok: true, value: { danglingRefs: [] } });
  }
}
class RecordingHealthSink implements DeletionHealthSink {
  readonly surfaced: DeletionWorkflowFailure[] = [];
  surface(failure: DeletionWorkflowFailure): Promise<Result<DeletionSurfaceOutcome, DeletionHealthSinkError>> {
    this.surfaced.push(failure);
    return Promise.resolve({ ok: true, value: { routedToHealth: true, routedToOutbox: false } });
  }
}

function makeInput(): DeletionSagaInput {
  return {
    run: {
      workflowId: "wf-del-prune-1" as DeletionSagaInput["run"]["workflowId"],
      trigger: "owner_action",
      idempotencyKey: "idem-del-prune-1",
      workspaceId: "ws-employer",
    },
    subject: { subjectRef: "note:meetings/acme/closeout-1", workspaceId: WS },
  };
}

function makeDeps(overrides: Partial<DeletionSagaDeps>): DeletionSagaDeps {
  return {
    verifyIntent: new OkVerifyIntentPort(),
    buildPlan: new FixedBuildPlanPort(makeDerivedPlan()),
    tombstoneMarkdown: new RecordingTombstonePort(),
    purgeGbrain: new OkPurgePort(),
    tombstoneEvents: new OkEventPort(),
    reconcileRefs: new OkReconcilePort(),
    health: new RecordingHealthSink(),
    runs: new InMemoryWorkflowRunRepo(),
    clock: new FakeClock(),
    ...overrides,
  };
}

function makeDerivedPlan(partial: Partial<DerivedDeletionPlan> = {}): DerivedDeletionPlan {
  const plan: KnowledgeMutationPlan = {
    planId: "plan-prune-1" as KnowledgeMutationPlan["planId"],
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

describe("§20.1 Retention purge — (c) prune-safety refusal HARD-STOPS the saga before the commit point", () => {
  it("a human_owned_only refusal ⇒ plan_rejected with NO tombstone commit + a surfaced health item", async () => {
    const tombstone = new RecordingTombstonePort();
    const deps = makeDeps({ buildPlan: new RefuseBuildPlanPort("human_owned_only"), tombstoneMarkdown: tombstone });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("plan_rejected");
    expect(tombstone.writeCount).toBe(0); // the human-owned subject was NEVER tombstoned
    expect((deps.health as RecordingHealthSink).surfaced).toHaveLength(1);
  });

  it("a retention_blocked refusal ⇒ plan_rejected, NO commit (inside the RET-3 window)", async () => {
    const tombstone = new RecordingTombstonePort();
    const deps = makeDeps({ buildPlan: new RefuseBuildPlanPort("retention_blocked"), tombstoneMarkdown: tombstone });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("plan_rejected");
    expect(tombstone.writeCount).toBe(0);
  });

  it("carries the deliberately-preserved human-owned regions onto the outcome even on the deleted happy path", async () => {
    const derived = makeDerivedPlan({ preservedRegions: ["human-notes", "human-decision"] });
    const deps = makeDeps({ buildPlan: new FixedBuildPlanPort(derived) });
    const out = await runDeletionSaga(makeInput(), deps);
    expect(out.state).toBe("deleted");
    // Proof the preservation set survives to the outcome — the human sections are named.
    expect(out.preservedRegions).toEqual(["human-notes", "human-decision"]);
  });
});
