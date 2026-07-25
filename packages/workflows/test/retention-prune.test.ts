// spec(§16.4 · RET-1 · RET-3 · REQ-F-018 · LIFE-2) — task 7.19.
//
// The AUTOMATED retention-pruning SCHEDULED workflow (a sibling of the 7.11 period
// review): a pure `runRetentionPrune` driver over injected ports + a `prunePolicy`
// SELECTION activity. These tests pin, driven over in-memory fakes + a FakeClock (no
// Temporal server, no real store):
//   • prunePolicy SELECTION (RET-3): a >30d assistant-held raw payload is due; an
//     externally-authoritative link (§10.1) is NEVER selected; an undispositioned
//     parked source is retained (re-entry guard); human-owned + derived-semantic notes
//     are NEVER selected (RET-3).
//   • driver RET-3 one-writer: any Markdown removal routes ONLY through the injected
//     KnowledgeWriter tombstone port — there is NO raw fs/markdown delete path, and no
//     human-owned/derived section is ever removed.
//   • driver idempotence (RET-1): re-running over already-pruned records is a no-op.
//   • driver LIFE-2: a missed schedule collapses to ONE run on wake (`collapsed`);
//     nothing-due parks with NO durable write.
//   • driver §16 health: every failure/park routes a DISTINCT §16 HealthItem reusing
//     EXISTING FailureClass members (missed_or_late_schedule / write_through_failed) —
//     NO new FailureClass member.
import { describe, it, expect } from "vitest";
import { isOk, ok, workspaceId, sourceId } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  WorkflowRunRef,
  KnowledgeMutationPlan,
} from "@sow/contracts";
import { DEFAULT_RETENTION_POLICY } from "../src/workflows/deletionSaga";
import {
  runRetentionPrune,
  retentionPruneMachine,
} from "../src/workflows/retentionPrune";
import type {
  PrunableRecord,
  PrunableDispositionState,
  PrunablePayloadStore,
  PrunablePayloadStoreError,
  PruneTombstonePort,
  PruneTombstoneSuccess,
  PruneTombstoneFailure,
  PruneAuditPort,
  PruneAuditEntry,
  PruneAuditError,
  PrunePolicyPort,
  PruneSelectionRequest,
  PruneSelection,
  PrunePolicyError,
  RetentionPruneDeps,
  RetentionPruneInput,
} from "../src/workflows/retentionPrune";
import {
  createPrunePolicyActivity,
  type PrunableRecordSource,
} from "../src/activities/prunePolicy";
import type {
  Clock,
  WorkflowRunRefRepository,
  ScheduleStore,
  ScheduleBookkeeping,
  DbResult,
} from "../src/ports/operational";

const WS: WorkspaceId = workspaceId("ws-employer");
const NOW = "2026-07-01T00:00:00.000Z";
const DAY_MS = 86_400_000;

function daysBefore(iso: string, days: number): string {
  return new Date(Date.parse(iso) - days * DAY_MS).toISOString();
}

// ── fakes ─────────────────────────────────────────────────────────────────────

class FakeClock implements Clock {
  constructor(private readonly wall: string = NOW) {}
  now(): string {
    return this.wall;
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

/** Shared read+delete store: implements BOTH the activity's record SOURCE and the driver's payload STORE. */
class InMemoryPrunableStore implements PrunableRecordSource, PrunablePayloadStore {
  readonly deleted: string[] = [];
  private readonly byId = new Map<string, PrunableRecord>();
  constructor(records: readonly PrunableRecord[]) {
    for (const r of records) this.byId.set(r.recordId, r);
  }
  candidates(_request: PruneSelectionRequest): readonly PrunableRecord[] {
    return [...this.byId.values()];
  }
  delete(recordId: string): Promise<Result<void, PrunablePayloadStoreError>> {
    this.byId.delete(recordId);
    this.deleted.push(recordId);
    return Promise.resolve(ok(undefined));
  }
}

class FailingPayloadStore implements PrunablePayloadStore {
  delete(_recordId: string): Promise<Result<void, PrunablePayloadStoreError>> {
    return Promise.resolve({ ok: false, error: { code: "delete_failed", message: "store delete faulted" } });
  }
}

class RecordingTombstonePort implements PruneTombstonePort {
  writeCount = 0;
  readonly plans: KnowledgeMutationPlan[] = [];
  tombstone(plan: KnowledgeMutationPlan): Promise<Result<PruneTombstoneSuccess, PruneTombstoneFailure>> {
    this.writeCount += 1;
    this.plans.push(plan);
    return Promise.resolve(ok({ revisionId: `rev-${this.writeCount}`, replayed: false }));
  }
}

class RefuseTombstonePort implements PruneTombstonePort {
  tombstone(_plan: KnowledgeMutationPlan): Promise<Result<PruneTombstoneSuccess, PruneTombstoneFailure>> {
    return Promise.resolve({ ok: false, error: { code: "commit_failed", message: "kw tombstone faulted" } });
  }
}

class RecordingAuditPort implements PruneAuditPort {
  readonly entries: PruneAuditEntry[] = [];
  record(entry: PruneAuditEntry): Promise<Result<void, PruneAuditError>> {
    this.entries.push(entry);
    return Promise.resolve(ok(undefined));
  }
}

class RecordingHealthSink {
  readonly surfaced: Array<{ failureClass: string; subjectRef: string; message: string }> = [];
  surface(failure: { failureClass: string; subjectRef: string; message: string }): Promise<Result<{ routedToHealth: boolean; routedToOutbox: boolean }, { code: "surface_failed" | "outbox_failed"; message: string }>> {
    this.surfaced.push(failure);
    return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
  }
}

class FailingPolicyPort implements PrunePolicyPort {
  select(_request: PruneSelectionRequest): Promise<Result<PruneSelection, PrunePolicyError>> {
    return Promise.resolve({ ok: false, error: { code: "enumeration_failed", message: "candidate enumeration faulted" } });
  }
}

/** ScheduleStore with configurable bookkeeping + a put spy. */
class InMemoryScheduleStore implements ScheduleStore {
  putCount = 0;
  constructor(private bookkeeping: ScheduleBookkeeping | undefined = undefined) {}
  getBookkeeping(_scheduleId: string): Promise<ScheduleBookkeeping | undefined> {
    return Promise.resolve(this.bookkeeping);
  }
  put(bookkeeping: ScheduleBookkeeping): Promise<void> {
    this.putCount += 1;
    this.bookkeeping = bookkeeping;
    return Promise.resolve();
  }
}

/** A non-persisting schedule store (always first-run path) — isolates the empty-selection idempotence. */
class NullScheduleStore implements ScheduleStore {
  getBookkeeping(_scheduleId: string): Promise<ScheduleBookkeeping | undefined> {
    return Promise.resolve(undefined);
  }
  put(_bookkeeping: ScheduleBookkeeping): Promise<void> {
    return Promise.resolve();
  }
}

// ── builders ────────────────────────────────────────────────────────────────

function record(partial: Partial<PrunableRecord> & { recordId: string }): PrunableRecord {
  return {
    workspaceId: WS,
    contentClass: "raw",
    assistantHeld: true,
    externallyAuthoritative: false,
    humanOwned: false,
    ...partial,
  };
}

/** An assistant-held raw payload, `days` old (defaults > window). */
function rawRecord(opts: { recordId: string; days: number; markdownRemoval?: KnowledgeMutationPlan }): PrunableRecord {
  return record({
    recordId: opts.recordId,
    contentClass: "raw",
    capturedAt: daysBefore(NOW, opts.days),
    ...(opts.markdownRemoval !== undefined ? { markdownRemoval: opts.markdownRemoval } : {}),
  });
}

function tombstonePlanFor(regionId: string): KnowledgeMutationPlan {
  return {
    planId: `plan-${regionId}` as KnowledgeMutationPlan["planId"],
    workspaceId: WS,
    sourceRefs: [{ sourceId: sourceId("src-prune-1") }],
    creates: [],
    patches: [{ path: "meetings/acme/closeout-1.md", regionId, newBody: "" }],
    linkMutations: [],
    frontmatterUpdates: [],
    externalActionProposals: [],
    confidence: 1,
    requiresApproval: false,
    provenanceOrigin: "human",
  };
}

function policyOver(records: readonly PrunableRecord[]): PrunePolicyPort {
  return createPrunePolicyActivity({ source: new InMemoryPrunableStore(records) });
}

function request(): PruneSelectionRequest {
  return { workspaceId: WS, retention: DEFAULT_RETENTION_POLICY, now: NOW };
}

function makeInput(): RetentionPruneInput {
  return {
    run: {
      workflowId: "wf-prune-1" as RetentionPruneInput["run"]["workflowId"],
      trigger: "schedule",
      idempotencyKey: "idem-prune-1",
      workspaceId: "ws-employer",
    },
    scheduleId: "retention-prune",
    intervalMs: DAY_MS,
    catchUpWindowMs: 30 * DAY_MS,
    workspaceId: WS,
  };
}

function makeDeps(overrides: Partial<RetentionPruneDeps> & { store: PrunablePayloadStore; policy: PrunePolicyPort }): RetentionPruneDeps {
  return {
    tombstone: new RecordingTombstonePort(),
    audit: new RecordingAuditPort(),
    health: new RecordingHealthSink() as unknown as RetentionPruneDeps["health"],
    runs: new InMemoryWorkflowRunRepo(),
    schedule: new InMemoryScheduleStore(),
    clock: new FakeClock(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// (A) prunePolicy SELECTION — RET-3 window + exclusions
// ═══════════════════════════════════════════════════════════════════════════

describe("§16.4 prunePolicy — RET-3 selection over assistant-held raw capture", () => {
  it("prune_selects_window_expired_assistant_payload — a >30d raw payload is due; a fresh one is skipped inside its window", async () => {
    const port = policyOver([
      rawRecord({ recordId: "r-old", days: 40 }),
      rawRecord({ recordId: "r-fresh", days: 5 }),
    ]);
    const res = await port.select(request());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.due.map((r) => r.recordId)).toEqual(["r-old"]);
    expect(res.value.skipped.find((s) => s.recordId === "r-fresh")?.reason).toBe("inside_window");
  });

  it("prune_skips_externally_authoritative_link — a Granola/Calendar-linked source is NEVER selected (§10.1)", async () => {
    const port = policyOver([
      record({ recordId: "grn-1", contentClass: "raw", externallyAuthoritative: true, assistantHeld: false, capturedAt: daysBefore(NOW, 90) }),
    ]);
    const res = await port.select(request());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.due).toEqual([]);
    expect(res.value.skipped.find((s) => s.recordId === "grn-1")?.reason).toBe("externally_authoritative");
  });

  it("prune_skips_undispositioned_parked_source — a parked-but-undispositioned source is retained (re-entry guard)", async () => {
    const parked: PrunableDispositionState = "queued_for_review";
    const dispositioned: PrunableDispositionState = "dispositioned";
    const port = policyOver([
      record({ recordId: "src-parked", contentClass: "raw", dispositionState: parked, capturedAt: daysBefore(NOW, 90) }),
      record({ recordId: "src-done", contentClass: "raw", dispositionState: dispositioned, capturedAt: daysBefore(NOW, 90) }),
    ]);
    const res = await port.select(request());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    // The undispositioned parked source is retained; the dispositioned twin (same age) is due.
    expect(res.value.due.map((r) => r.recordId)).toEqual(["src-done"]);
    expect(res.value.skipped.find((s) => s.recordId === "src-parked")?.reason).toBe("undispositioned_parked");
  });

  it("raw audio uses the audited-synthesis predicate (NOT the window) — Q1", async () => {
    // Raw audio 5 days old (inside any window) but WITH an audited synthesis ⇒ eligible.
    const withSynthesis = policyOver([
      record({ recordId: "aud-1", contentClass: "raw_audio", auditedSynthesisExists: true, capturedAt: daysBefore(NOW, 5) }),
    ]);
    const r1 = await withSynthesis.select(request());
    expect(isOk(r1) && r1.value.due.map((r) => r.recordId)).toEqual(["aud-1"]);
    // Raw audio 90 days old (past any window) but WITHOUT an audited synthesis ⇒ blocked.
    const noSynthesis = policyOver([
      record({ recordId: "aud-2", contentClass: "raw_audio", auditedSynthesisExists: false, capturedAt: daysBefore(NOW, 90) }),
    ]);
    const r2 = await noSynthesis.select(request());
    expect(isOk(r2)).toBe(true);
    if (!isOk(r2)) return;
    expect(r2.value.due).toEqual([]);
    expect(r2.value.skipped.find((s) => s.recordId === "aud-2")?.reason).toBe("inside_window");
  });

  it("prune_skips_already_pruned_record — RET-1 idempotence guard (logical-prune store keeps the row)", async () => {
    // An otherwise-due raw payload flagged already-pruned is retained (a real store that
    // logically prunes but keeps the row relies on this flag to avoid a re-tombstone).
    const port = policyOver([
      record({ recordId: "raw-done", contentClass: "raw", alreadyPruned: true, capturedAt: daysBefore(NOW, 90) }),
      rawRecord({ recordId: "raw-open", days: 40 }),
    ]);
    const res = await port.select(request());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.due.map((r) => r.recordId)).toEqual(["raw-open"]);
    expect(res.value.skipped.find((s) => s.recordId === "raw-done")?.reason).toBe("already_pruned");
  });

  it("prune_skips_non_candidate_records — non-assistant-held + unknown content class fail safe (never pruned)", async () => {
    const port = policyOver([
      record({ recordId: "not-held", contentClass: "raw", assistantHeld: false, capturedAt: daysBefore(NOW, 90) }),
      record({ recordId: "cached-1", contentClass: "cached", capturedAt: daysBefore(NOW, 90) }),
    ]);
    const res = await port.select(request());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.due).toEqual([]);
    expect(res.value.skipped.find((s) => s.recordId === "not-held")?.reason).toBe("not_assistant_held");
    expect(res.value.skipped.find((s) => s.recordId === "cached-1")?.reason).toBe("unknown_class");
  });

  it("prune_age_fail_safe — an absent or malformed capturedAt is NEVER pruned (age 0 ⇒ inside_window)", async () => {
    const port = policyOver([
      record({ recordId: "no-ts", contentClass: "raw" }), // capturedAt absent
      record({ recordId: "bad-ts", contentClass: "raw", capturedAt: "not-a-date" }),
    ]);
    const res = await port.select(request());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.due).toEqual([]);
    expect(res.value.skipped.map((s) => s.reason)).toEqual(["inside_window", "inside_window"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (B) driver — RET-3 one-writer, idempotence, LIFE-2, §16 health
// ═══════════════════════════════════════════════════════════════════════════

describe("§16.4 runRetentionPrune — RET-3 one-writer + idempotent + LIFE-2 + §16 health", () => {
  it("prune_markdown_removal_routes_through_kw_only — KW tombstone only; human-owned + derived preserved; audited", async () => {
    const store = new InMemoryPrunableStore([
      rawRecord({ recordId: "raw-1", days: 40, markdownRemoval: tombstonePlanFor("raw-transcript") }),
      record({ recordId: "human-1", contentClass: "raw", humanOwned: true, capturedAt: daysBefore(NOW, 90) }),
      record({ recordId: "derived-1", contentClass: "derived", capturedAt: daysBefore(NOW, 90) }),
    ]);
    const tombstone = new RecordingTombstonePort();
    const audit = new RecordingAuditPort();
    const out = await runRetentionPrune(makeInput(), makeDeps({ store, tombstone, audit, policy: createPrunePolicyActivity({ source: store }) }));

    expect(out.state).toBe("done");
    expect(out.removedRecordIds).toEqual(["raw-1"]);
    // RET-3 one-writer: the ONLY Markdown mutation path is the KW tombstone port.
    expect(tombstone.writeCount).toBe(1);
    expect(tombstone.plans[0]?.patches.map((p) => p.regionId)).toEqual(["raw-transcript"]);
    // The assistant-held operational copy is deleted directly; human-owned + derived are NEVER removed.
    expect(store.deleted).toEqual(["raw-1"]);
    expect(store.deleted).not.toContain("human-1");
    expect(store.deleted).not.toContain("derived-1");
    // Each removal is audit-logged.
    expect(audit.entries.map((e) => e.recordId)).toEqual(["raw-1"]);
  });

  it("prune_is_idempotent — re-running over already-pruned records is a no-op (no double-tombstone)", async () => {
    const store = new InMemoryPrunableStore([
      rawRecord({ recordId: "raw-1", days: 40, markdownRemoval: tombstonePlanFor("raw-transcript") }),
    ]);
    const tombstone = new RecordingTombstonePort();
    // A non-persisting schedule store keeps BOTH drives on the first-run path (no LIFE-2
    // gating), so the 2nd drive's no-op is proven by the EMPTY selection over the
    // already-pruned store — not by a schedule park.
    const deps = makeDeps({ store, tombstone, policy: createPrunePolicyActivity({ source: store }), schedule: new NullScheduleStore() });

    const first = await runRetentionPrune(makeInput(), deps);
    expect(first.removedRecordIds).toEqual(["raw-1"]);
    expect(tombstone.writeCount).toBe(1);

    // Second drive (same idempotencyKey ⇒ run reused; the record was already removed).
    const second = await runRetentionPrune(makeInput(), deps);
    expect(second.runReused).toBe(true);
    expect(second.removedRecordIds).toEqual([]);
    expect(tombstone.writeCount).toBe(1); // NOT re-tombstoned
  });

  it("prune_missed_schedule_collapses_on_wake — many missed ⇒ one collapsed run; nothing-due parks with NO write", async () => {
    // (a) collapse: last run 10 intervals ago, 30-day catch-up window ⇒ one run, collapsed true.
    const collapseStore = new InMemoryPrunableStore([rawRecord({ recordId: "raw-1", days: 40 })]);
    const collapseSchedule = new InMemoryScheduleStore({ scheduleId: "retention-prune", lastRunWall: daysBefore(NOW, 10) });
    const collapsed = await runRetentionPrune(
      makeInput(),
      makeDeps({ store: collapseStore, policy: createPrunePolicyActivity({ source: collapseStore }), schedule: collapseSchedule }),
    );
    expect(collapsed.state).toBe("done");
    expect(collapsed.collapsed).toBe(true);

    // (b) nothing due: last run 12h ago (< 1 day interval) ⇒ park, NO durable write.
    const idleStore = new InMemoryPrunableStore([rawRecord({ recordId: "raw-1", days: 40 })]);
    const idleSchedule = new InMemoryScheduleStore({ scheduleId: "retention-prune", lastRunWall: daysBefore(NOW, 0.5) });
    const idle = await runRetentionPrune(
      makeInput(),
      makeDeps({ store: idleStore, policy: createPrunePolicyActivity({ source: idleStore }), schedule: idleSchedule }),
    );
    expect(idle.state).toBe("no_run_due");
    expect(idle.collapsed).toBe(false);
    expect(idle.removedRecordIds).toEqual([]);
    expect(idleSchedule.putCount).toBe(0); // nothing-due wrote nothing
    expect((idleStore as InMemoryPrunableStore).deleted).toEqual([]);
  });

  it("prune_failure_mints_existing_failureclass — every failure/park reuses an EXISTING FailureClass (no new member)", async () => {
    const dueRecord = () => new InMemoryPrunableStore([rawRecord({ recordId: "raw-1", days: 40, markdownRemoval: tombstonePlanFor("raw-transcript") })]);

    const cases: Array<{ name: string; deps: () => RetentionPruneDeps; expectState: string; expectClass: string }> = [
      {
        name: "kw tombstone fault",
        deps: () => {
          const store = dueRecord();
          return makeDeps({ store, tombstone: new RefuseTombstonePort(), policy: createPrunePolicyActivity({ source: store }) });
        },
        expectState: "tombstone_failed",
        expectClass: "write_through_failed",
      },
      {
        name: "store delete fault",
        deps: () => {
          const source = dueRecord();
          return makeDeps({ store: new FailingPayloadStore(), policy: createPrunePolicyActivity({ source }) });
        },
        expectState: "purge_failed",
        expectClass: "write_through_failed",
      },
      {
        name: "selection fault",
        deps: () => makeDeps({ store: new FailingPayloadStore(), policy: new FailingPolicyPort() }),
        expectState: "selection_failed",
        expectClass: "write_through_failed",
      },
      {
        name: "missed / nothing-due",
        deps: () => {
          const store = dueRecord();
          return makeDeps({
            store,
            policy: createPrunePolicyActivity({ source: store }),
            schedule: new InMemoryScheduleStore({ scheduleId: "retention-prune", lastRunWall: daysBefore(NOW, 0.5) }),
          });
        },
        expectState: "no_run_due",
        expectClass: "missed_or_late_schedule",
      },
    ];

    for (const c of cases) {
      const deps = c.deps();
      const out = await runRetentionPrune(makeInput(), deps);
      expect(out.state, c.name).toBe(c.expectState);
      const sink = deps.health as unknown as RecordingHealthSink;
      expect(sink.surfaced.at(-1)?.failureClass, c.name).toBe(c.expectClass);
    }
  });

  it("retentionPruneMachine is total — the happy path is legal and an illegal jump is refused", () => {
    // happy edges legal
    expect(isOk(retentionPruneMachine.transition("scheduled", "candidates_selected"))).toBe(true);
    expect(isOk(retentionPruneMachine.transition("candidates_selected", "removed"))).toBe(true);
    expect(isOk(retentionPruneMachine.transition("removed", "done"))).toBe(true);
    // an illegal teleport is refused (never throws)
    expect(isOk(retentionPruneMachine.transition("scheduled", "done"))).toBe(false);
  });
});
