// W1 — the 25.2/25.4 durable scheduled-runtime activities (scheduleArgs.ts's frozen
// `SCHEDULED_RUNTIME_ACTIVITY_NAMES` contract) must never leak a raw @sow/db `DbError` — including
// its VERBATIM driver `cause` — across the Temporal ACTIVITY boundary (workflow history is a durable,
// replayed log sink, safety rule 7).
//
// W1a: `scheduledRunCreate` / `scheduledRunGet` / `scheduledRunGetByIdempotencyKey` /
// `scheduledRunUpdateState` / `scheduledRunAppendAuditRef` were BARE pass-throughs of the real
// `WorkflowRunRefRepository`'s `Result<T, DbError>` — a poisoned `cause` (a DSN, a thrown plain
// object, a real Error) crossed VERBATIM on any fault.
//
// W1b (CRITICAL): `scheduledScheduleGetBookkeeping` / `scheduledSchedulePut` were bare delegates to
// `backends.scheduleStore` (store-adapters.ts's `createScheduleStoreAdapter`), a THROW-shaped port —
// a genuine fault THREW straight across the activity boundary, both violating §16 ("never throw
// across the boundary") and leaking the driver-authored `DbError.message` `faultRejection`
// interpolates into the thrown text.
//
// Drives the REGISTERED activity members (the plain-async functions `buildProofSpineActivities`
// returns) exactly like commitCauseRedaction.test.ts does for `meetingCommit`/`sourceCommit` — never
// the raw repo/store — over REAL `assembleBackends` backends with ONLY `repos.workflowRunRefs` /
// `scheduleStore` swapped for a poisoned fake (every other construction-time dependency the builder
// touches stays real).
import { describe, it, expect, afterEach } from "vitest";
import { err, workspaceId, workflowId, sourceId } from "@sow/contracts";
import type { WorkspaceId, WorkflowRunRef, SourceRef } from "@sow/contracts";
import type { AgentExtraction, MeetingJobInputs } from "@sow/workflows";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import { computeRevisionId } from "@sow/knowledge";
import type { KnowledgeRevisionStore, CommittedRevision } from "@sow/knowledge";
import type { DbError, DbResult, ScheduleBookkeepingRepository, WorkflowRunRefRepository } from "@sow/db";
import type { ScheduleStore } from "@sow/workflows/ports/operational";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import { createScheduleStoreAdapter } from "../../src/composition/store-adapters";
import { buildProofSpineActivities, type ProofSpineParams } from "../../src/composition/buildActivities";
import { SCHEDULED_RUNTIME_ACTIVITY_NAMES } from "../../src/temporal/scheduleArgs";

const NOW = "2026-08-27T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const WS: WorkspaceId = workspaceId("ws-w1-probe");
const EMPTY_VAULT_REVISION = computeRevisionId(new Map());

// The hostile marker every scenario below must NEVER see cross the activity boundary — a
// credential-shaped DSN, exactly the class of value a real Postgres driver's `cause`/`message` can
// carry (the CRITICAL brief's own example).
const POISON_DSN = "postgres://u:PZN9F3A1BSECRET-leak@h/db";
const poisonedCause = { dsn: POISON_DSN };

const runRef: WorkflowRunRef = {
  workflowId: workflowId("wf-w1"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:w1",
  auditRefs: [],
};
const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-w1"),
  workspaceId: WS,
  capability: "meeting.close",
  outputSchemaId: "sow:meeting.close.output",
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:w1",
};
const meetingExtraction: AgentExtraction = {
  fields: { title: { value: "n/a", evidenceRef: "src:w1#0" } },
};
const resolved: ResolvedWorkspacePolicy = {
  workspaceId: String(WS),
  type: "personal_business",
  dataOwner: "user",
  defaultVisibility: "coordination",
  egressPolicy: {
    workspaceId: WS,
    allowedProcessors: [],
    rawContentAllowedProcessors: [],
    employerRawEgressAcknowledged: false,
  },
  providerMatrix: {
    workspaceId: WS,
    allowedProviders: [],
    capabilityDefaults: {} as ResolvedWorkspacePolicy["providerMatrix"]["capabilityDefaults"],
    rawCloudEgressEnabled: false,
  },
};
const sourceRef: SourceRef = { sourceId: sourceId("src-w1") };

function memRevisionStore(): KnowledgeRevisionStore {
  const byKey = new Map<string, CommittedRevision>();
  return {
    getByIdempotencyKey: (k) => Promise.resolve(byKey.get(k)),
    record: (rev) => {
      byKey.set(rev.idempotencyKey, rev);
      return Promise.resolve();
    },
  };
}

function paramsFor(revisions: KnowledgeRevisionStore): ProofSpineParams {
  return {
    resolved,
    correlationSignals: { confidence: 0.95, workspaceId: WS },
    meetingJobInputs,
    meetingExtraction,
    revisions,
    commit: {
      actor: "worker:test",
      sourceEventRef: "evt:w1",
      workflowRunRef: runRef,
      expectedBaseRevision: EMPTY_VAULT_REVISION,
    },
    sourceRef,
    planIdentity: { closeout: "w1:1" },
  };
}

const openBackends: ProofSpineBackends[] = [];
afterEach(() => {
  for (const b of openBackends.splice(0)) b.close();
});

/** Fresh real backends — every OTHER construction-time dependency stays real. */
async function freshBackends(): Promise<ProofSpineBackends> {
  const b = await assembleBackends(
    { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    { candidateOutput: {} },
  );
  openBackends.push(b);
  return b;
}

/** A `WorkflowRunRefRepository` where every method resolves the SAME poisoned `err(DbError)`. */
function poisonedRunRefRepo(error: DbError): WorkflowRunRefRepository {
  const fault: DbResult<never> = Promise.resolve(err(error));
  return {
    create: () => fault as DbResult<WorkflowRunRef>,
    get: () => fault as DbResult<WorkflowRunRef>,
    getByIdempotencyKey: () => fault as DbResult<WorkflowRunRef>,
    updateState: () => fault as DbResult<WorkflowRunRef>,
    appendAuditRef: () => fault as DbResult<WorkflowRunRef>,
  };
}

/** Swap ONLY `repos.workflowRunRefs` on a real backends bundle. */
function withPoisonedRunRefs(b: ProofSpineBackends, repo: WorkflowRunRefRepository): ProofSpineBackends {
  return { ...b, repos: { ...b.repos, workflowRunRefs: repo } };
}

/** Swap ONLY `scheduleStore` on a real backends bundle. */
function withScheduleStore(b: ProofSpineBackends, store: ScheduleStore): ProofSpineBackends {
  return { ...b, scheduleStore: store };
}

describe("W1a — scheduledRunCreate/Get/GetByIdempotencyKey/UpdateState/AppendAuditRef: a poisoned DbError never crosses the activity boundary", () => {
  const scenarios: ReadonlyArray<{ readonly label: string; readonly error: DbError }> = [
    { label: "a Postgres-DSN-bearing cause object", error: { code: "unavailable", message: "connection failed", cause: poisonedCause } },
    { label: "a thrown plain object as cause", error: { code: "unknown", message: "boom", cause: { thrown: true, dsn: POISON_DSN } } },
    { label: "a real Error instance as cause", error: { code: "conflict", message: `duplicate key: ${POISON_DSN}`, cause: new Error(`driver said: ${POISON_DSN}`) } },
  ];

  const members = [
    { name: SCHEDULED_RUNTIME_ACTIVITY_NAMES.runCreate, call: (acts: Record<string, unknown>) => (acts[SCHEDULED_RUNTIME_ACTIVITY_NAMES.runCreate] as (r: WorkflowRunRef) => Promise<unknown>)(runRef) },
    { name: SCHEDULED_RUNTIME_ACTIVITY_NAMES.runGet, call: (acts: Record<string, unknown>) => (acts[SCHEDULED_RUNTIME_ACTIVITY_NAMES.runGet] as (id: string) => Promise<unknown>)(runRef.workflowId) },
    { name: SCHEDULED_RUNTIME_ACTIVITY_NAMES.runGetByIdempotencyKey, call: (acts: Record<string, unknown>) => (acts[SCHEDULED_RUNTIME_ACTIVITY_NAMES.runGetByIdempotencyKey] as (k: string) => Promise<unknown>)(runRef.idempotencyKey) },
    { name: SCHEDULED_RUNTIME_ACTIVITY_NAMES.runUpdateState, call: (acts: Record<string, unknown>) => (acts[SCHEDULED_RUNTIME_ACTIVITY_NAMES.runUpdateState] as (id: string, s: string) => Promise<unknown>)(runRef.workflowId, "running") },
    { name: SCHEDULED_RUNTIME_ACTIVITY_NAMES.runAppendAuditRef, call: (acts: Record<string, unknown>) => (acts[SCHEDULED_RUNTIME_ACTIVITY_NAMES.runAppendAuditRef] as (id: string, ref: string) => Promise<unknown>)(runRef.workflowId, "audit:1") },
  ];

  for (const member of members) {
    for (const scenario of scenarios) {
      it(`${member.name} — ${scenario.label}: cause never crosses, code still does`, async () => {
        const b = withPoisonedRunRefs(await freshBackends(), poisonedRunRefRepo(scenario.error));
        const acts = buildProofSpineActivities(b, paramsFor(memRevisionStore())) as unknown as Record<string, unknown>;
        const res = (await member.call(acts)) as { ok: boolean; error?: { code: string; message: string; cause?: unknown } };
        expect(res.ok).toBe(false);
        if (res.ok) return;
        // `code` — the closed, enumerable DbErrorCode — crosses byte-identically.
        expect(res.error?.code).toBe(scenario.error.code);
        // `cause` never crosses at all.
        expect(res.error && "cause" in res.error).toBe(false);
        const serialized = JSON.stringify(res);
        expect(serialized).not.toContain(POISON_DSN);
        expect(serialized).not.toContain("thrown");
        // `message` is the FIXED generic string, never the driver's own text.
        expect(res.error?.message).not.toBe(scenario.error.message);
      });
    }
  }

  it("the ok arm is untouched on a genuine success", async () => {
    const b = await freshBackends();
    const acts = buildProofSpineActivities(b, paramsFor(memRevisionStore()));
    const res = await acts[SCHEDULED_RUNTIME_ACTIVITY_NAMES.runCreate](runRef);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.workflowId).toBe(runRef.workflowId);
  });
});

describe("W1b (CRITICAL) — scheduledScheduleGetBookkeeping/scheduledSchedulePut: never throw across the activity boundary; a poisoned fault is redacted", () => {
  it("scheduledScheduleGetBookkeeping — a REAL sqlite-adapter-thrown DbError (via the production faultRejection path) RETURNS a typed err, never throws", async () => {
    const poisonedRepo: ScheduleBookkeepingRepository = {
      getBookkeeping: () => Promise.resolve(err({ code: "unavailable", message: `db down: ${POISON_DSN}`, cause: poisonedCause })),
      put: () => Promise.resolve(err({ code: "unavailable", message: `db down: ${POISON_DSN}`, cause: poisonedCause })),
    };
    const b = withScheduleStore(await freshBackends(), createScheduleStoreAdapter(poisonedRepo));
    const acts = buildProofSpineActivities(b, paramsFor(memRevisionStore()));
    // Must not throw/reject — the call resolves to a typed Result.
    const res = await acts[SCHEDULED_RUNTIME_ACTIVITY_NAMES.scheduleGetBookkeeping]("sched-w1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unavailable");
    expect("cause" in res.error).toBe(false);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(POISON_DSN);
    expect(res.error.message).not.toContain(POISON_DSN);
  });

  it("scheduledSchedulePut — the SAME production path RETURNS a typed err, never throws", async () => {
    const poisonedRepo: ScheduleBookkeepingRepository = {
      getBookkeeping: () => Promise.resolve(err({ code: "unavailable", message: `db down: ${POISON_DSN}`, cause: poisonedCause })),
      put: () => Promise.resolve(err({ code: "constraint_violation", message: `bad row: ${POISON_DSN}`, cause: poisonedCause })),
    };
    const b = withScheduleStore(await freshBackends(), createScheduleStoreAdapter(poisonedRepo));
    const acts = buildProofSpineActivities(b, paramsFor(memRevisionStore()));
    const res = await acts[SCHEDULED_RUNTIME_ACTIVITY_NAMES.schedulePut]({ scheduleId: "sched-w1", lastRunWall: NOW });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("constraint_violation");
    expect("cause" in res.error).toBe(false);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(POISON_DSN);
  });

  it("scheduledScheduleGetBookkeeping — a ROGUE throw (a thrown plain object, NOT faultRejection-shaped) still folds to a typed err, never rethrows, never leaks", async () => {
    const rogue: ScheduleStore = {
      getBookkeeping: () => {
        throw { dsn: POISON_DSN, secret: "sk-ROGUE-THROW-LEAK" };
      },
      put: () => Promise.resolve(),
    };
    const b = withScheduleStore(await freshBackends(), rogue);
    const acts = buildProofSpineActivities(b, paramsFor(memRevisionStore()));
    const res = await acts[SCHEDULED_RUNTIME_ACTIVITY_NAMES.scheduleGetBookkeeping]("sched-w1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // No structured code recoverable from a rogue throw ⇒ the closed catch-all, never a crash/guess.
    expect(res.error.code).toBe("unknown");
    expect("cause" in res.error).toBe(false);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(POISON_DSN);
    expect(serialized).not.toContain("sk-ROGUE-THROW-LEAK");
  });

  it("scheduledSchedulePut — a rogue thrown real Error (no structured cause) still folds to a typed err", async () => {
    const rogue: ScheduleStore = {
      getBookkeeping: () => Promise.resolve(undefined),
      put: () => {
        throw new Error(`unexpected failure touching ${POISON_DSN}`);
      },
    };
    const b = withScheduleStore(await freshBackends(), rogue);
    const acts = buildProofSpineActivities(b, paramsFor(memRevisionStore()));
    const res = await acts[SCHEDULED_RUNTIME_ACTIVITY_NAMES.schedulePut]({ scheduleId: "sched-w1", lastRunWall: NOW });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unknown");
    expect("cause" in res.error).toBe(false);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(POISON_DSN);
  });

  it("the ok arm is untouched on a genuine success (a never-run schedule ⇒ ok(undefined))", async () => {
    const b = await freshBackends();
    const acts = buildProofSpineActivities(b, paramsFor(memRevisionStore()));
    const res = await acts[SCHEDULED_RUNTIME_ACTIVITY_NAMES.scheduleGetBookkeeping]("sched-never-run");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBeUndefined();

    const putRes = await acts[SCHEDULED_RUNTIME_ACTIVITY_NAMES.schedulePut]({ scheduleId: "sched-never-run", lastRunWall: NOW });
    expect(putRes.ok).toBe(true);

    const gotRes = await acts[SCHEDULED_RUNTIME_ACTIVITY_NAMES.scheduleGetBookkeeping]("sched-never-run");
    expect(gotRes.ok).toBe(true);
    if (!gotRes.ok) return;
    expect(gotRes.value?.scheduleId).toBe("sched-never-run");
  });
});
