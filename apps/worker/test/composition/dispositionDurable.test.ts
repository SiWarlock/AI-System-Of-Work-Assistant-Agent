// Task 15.5 — the durable disposition seams (worker leg). RED-first. HIGHEST safety bar
// (rule-3 replay-safety + WS-8 registry-validated rescope + rule-2 re-gate + L3 fail-closed).
//
// Extracts the C1 disposition seams into testable factories over the durable SourceDisposition store:
//   - createDurableDispositionStore → the real DispositionStore (isParked reflects the store — no
//     longer hardwired true; insert CAS + a redaction-safe audit; fail-closed).
//   - createDurableParkedReader → the real ParkedSourceReader (reads the parked SourceEnvelope back;
//     a genuinely-absent source is a typed source_unavailable, distinct from a store fault).
//   - createRegistryValidatedRescope → the rescope with the owner override REGISTRY-VALIDATED (WS-8 —
//     an unregistered workspace override is rejected; contentHash preserved, inv-D).
//   - createReenterRunner → re-drives THROUGH the candidate gate (rule 2) reusing the idempotencyKey;
//     an already-committed key REPLAYS over the real KnowledgeRevisionStore (runReused, rule 3/inv-D).
//
// GUARDRAIL (raw candidate content at rest, orch23): the stored raw SourceEnvelope is server-side
// operational only — the disposition audit record carries SUMMARIES ONLY (never the raw body/content).
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, type Result } from "@sow/contracts";
import type { AuditRecord, SourceEnvelope, WorkflowRunRef } from "@sow/contracts";
import type { DbError, ReadModelRecord, ReadModelRepository, SourceDispositionRepository, SourceDispositionRow } from "@sow/db";
import type { CommittedRevision, KnowledgeRevisionStore } from "@sow/knowledge";
import { createRecordDispositionActivity, type TriageDisposition } from "@sow/workflows";
import { READ_MODEL_KEYS } from "../../src/api/adapters/readModel";
import {
  createDurableDispositionStore,
  createDurableParkedReader,
  createRegistryValidatedRescope,
  createReenterRunner,
} from "../../src/composition/dispositionDurable";

const NOW = "2026-07-15T00:00:00.000Z";
const runRef = { workflowId: "wf-155", trigger: "owner_action", state: "running", idempotencyKey: "run:155", auditRefs: [] } as unknown as WorkflowRunRef;

const envelope = (over: Partial<SourceEnvelope> = {}): SourceEnvelope => ({
  sourceId: "src-1" as SourceEnvelope["sourceId"],
  workspaceId: "capture-ws" as SourceEnvelope["workspaceId"],
  origin: "https://example.com/x",
  contentHash: "sha256:c1",
  type: "youtube_video",
  sensitivity: "normal",
  routingHints: {},
  ...over,
});
const dbRow = (over: Partial<SourceDispositionRow> = {}): SourceDispositionRow => ({
  sourceId: "src-1",
  sourceEnvelope: envelope(),
  idempotencyKey: "src:capture-ws:sha256:c1",
  state: "queued_for_review",
  dispositionKey: null,
  auditRef: null,
  parkedAt: NOW,
  dispositionedAt: null,
  ...over,
});

class FakeDispositionRepo implements SourceDispositionRepository {
  rows = new Map<string, SourceDispositionRow>();
  faultOn: "park" | "getBySourceId" | "getByDispositionKey" | "recordDisposition" | null = null;
  faults = new Set<"park" | "getBySourceId" | "getByDispositionKey" | "recordDisposition">();
  private faulting(m: "park" | "getBySourceId" | "getByDispositionKey" | "recordDisposition"): boolean {
    return this.faultOn === m || this.faults.has(m);
  }
  seed(...rs: SourceDispositionRow[]): this { for (const r of rs) this.rows.set(r.sourceId, r); return this; }
  async park(row: SourceDispositionRow): Promise<Result<void, DbError>> {
    if (this.faulting("park")) return err({ code: "unavailable", message: "x" });
    if (!this.rows.has(row.sourceId)) this.rows.set(row.sourceId, row); // first-write-wins
    return ok(undefined);
  }
  async getBySourceId(sourceId: string): Promise<Result<SourceDispositionRow | undefined, DbError>> {
    if (this.faulting("getBySourceId")) return err({ code: "unavailable", message: "x" });
    return ok(this.rows.get(sourceId));
  }
  async getByDispositionKey(key: string): Promise<Result<SourceDispositionRow | undefined, DbError>> {
    if (this.faulting("getByDispositionKey")) return err({ code: "unavailable", message: "x" });
    return ok([...this.rows.values()].find((r) => r.dispositionKey === key));
  }
  async recordDisposition(sourceId: string, dispositionKey: string, auditRef: string, at: string): Promise<Result<SourceDispositionRow, DbError>> {
    if (this.faulting("recordDisposition")) return err({ code: "unavailable", message: "x" });
    const r = this.rows.get(sourceId);
    if (!r) return err({ code: "not_found", message: "x" });
    // CAS first-write-wins: a row already dispositioned (dispositionKey set) is a conflict.
    if (r.dispositionKey !== null) return err({ code: "conflict", message: "x" });
    const next: SourceDispositionRow = { ...r, state: "dispositioned", dispositionKey, auditRef, dispositionedAt: at };
    this.rows.set(sourceId, next);
    return ok(next);
  }
}

class FakeAudit {
  appended: AuditRecord[] = [];
  async append(record: AuditRecord): Promise<Result<void, DbError>> { this.appended.push(record); return ok(undefined); }
  async query(): Promise<Result<AuditRecord[], DbError>> { return ok([...this.appended]); }
}

function fakeReadModels(registered: readonly string[]): ReadModelRepository {
  return {
    async get(key: string): Promise<Result<ReadModelRecord, DbError>> {
      if (key === READ_MODEL_KEYS.registry) return ok({ readModelKey: key, data: { workspaceIds: registered }, rebuiltAt: NOW } as ReadModelRecord);
      return err({ code: "not_found", message: "x" });
    },
    async put(r: ReadModelRecord): Promise<Result<ReadModelRecord, DbError>> { return ok(r); },
    async clear(): Promise<Result<void, DbError>> { return ok(undefined); },
  };
}

const disp = (over: Partial<TriageDisposition> = {}): TriageDisposition => ({
  sourceId: "src-1",
  workspaceId: "route-ws" as TriageDisposition["workspaceId"],
  channel: "mac",
  ...over,
});

describe("createDurableDispositionStore (15.5 — real isParked + CAS + redaction-safe audit)", () => {
  it("is_parked_reflects_the_store: isParked is true iff a parked row exists (NOT the hardwired true); absent ⇒ false [spec(§19.2)]", async () => {
    const repo = new FakeDispositionRepo().seed(dbRow());
    const store = createDurableDispositionStore({ repo, audit: new FakeAudit(), now: () => NOW, runRef });
    expect(isOk(await store.isParked("src-1")) && (await store.isParked("src-1") as { value: boolean }).value).toBe(true);
    expect(isOk(await store.isParked("never")) && (await store.isParked("never") as { value: boolean }).value).toBe(false);
  });

  it("insert CAS-records + mints an audit that carries SUMMARIES ONLY — the raw parked body/content is NEVER in the audit (guardrail, rule 7) [spec(§16)]", async () => {
    const repo = new FakeDispositionRepo().seed(dbRow({ sourceEnvelope: envelope({ body: "SECRET raw transcript body line1\nline2" } as Partial<SourceEnvelope>) }));
    const audit = new FakeAudit();
    const store = createDurableDispositionStore({ repo, audit, now: () => NOW, runRef });
    const res = await store.insert("dkey-1", disp());
    expect(isOk(res)).toBe(true);
    // the audit record contains no raw body — only summaries/refs/hash.
    expect(JSON.stringify(audit.appended)).not.toContain("SECRET raw transcript body");
    expect(audit.appended).toHaveLength(1);
  });

  it("isParked / insert faults are typed errs — never masked (fail-closed, Lesson 3) [spec(§16)]", async () => {
    const repoA = new FakeDispositionRepo().seed(dbRow()); repoA.faultOn = "getBySourceId";
    const storeA = createDurableDispositionStore({ repo: repoA, audit: new FakeAudit(), now: () => NOW, runRef });
    expect(isErr(await storeA.isParked("src-1"))).toBe(true); // never a masked false not-parked
    const repoB = new FakeDispositionRepo().seed(dbRow()); repoB.faultOn = "recordDisposition";
    const storeB = createDurableDispositionStore({ repo: repoB, audit: new FakeAudit(), now: () => NOW, runRef });
    expect(isErr(await storeB.insert("dkey-1", disp()))).toBe(true); // never a masked ok
  });
});

describe("createDurableParkedReader (15.5 — reads the parked SourceEnvelope back)", () => {
  it("parked_reader_reads_back_the_source_envelope: a parked source ⇒ the persisted SourceEnvelope; a genuinely-absent source ⇒ typed source_unavailable (distinct from a fault) [spec(G5)]", async () => {
    const repo = new FakeDispositionRepo().seed(dbRow());
    const reader = createDurableParkedReader(repo);
    const got = await reader.read("src-1");
    expect(isOk(got) && got.value.contentHash).toBe("sha256:c1"); // returns the parked SourceEnvelope itself
    expect(isOk(got) && String(got.value.sourceId)).toBe("src-1");
    const absent = await reader.read("nope");
    expect(isErr(absent) && absent.error.code).toBe("source_unavailable");
  });
});

describe("createRegistryValidatedRescope (15.5 — WS-8 registry-validated owner override)", () => {
  it("rescope_registry_validates_the_override_workspace: a REGISTERED override ⇒ reScoped.workspaceId = override + contentHash preserved (inv-C/inv-D); an UNREGISTERED override ⇒ rejected (WS-8) [spec(inv-C)]", async () => {
    const repo = new FakeDispositionRepo().seed(dbRow());
    const reader = createDurableParkedReader(repo);
    const okRescope = createRegistryValidatedRescope({ reader, readModels: fakeReadModels(["route-ws"]) });
    const good = await okRescope.rescope(disp({ workspaceId: "route-ws" as TriageDisposition["workspaceId"] }));
    expect(isOk(good) && String(good.value.workspaceId)).toBe("route-ws"); // owner override applied
    expect(isOk(good) && good.value.contentHash).toBe("sha256:c1"); // contentHash PRESERVED (inv-D)
    const badRescope = createRegistryValidatedRescope({ reader, readModels: fakeReadModels([]) }); // ws not registered
    const bad = await badRescope.rescope(disp({ workspaceId: "attacker-ws" as TriageDisposition["workspaceId"] }));
    expect(isErr(bad)).toBe(true); // an unregistered override is rejected — never a raw cross-workspace bind
  });

  it("rescope_fails_closed_on_a_registry_fault: a registry READ fault ⇒ rescope_failed — never a raw bind on an unverifiable workspace (WS-8 fail-closed) [spec(§16)]", async () => {
    const repo = new FakeDispositionRepo().seed(dbRow());
    const reader = createDurableParkedReader(repo);
    // A readModels whose registry read FAULTS (not a benign miss).
    const faulting: ReadModelRepository = {
      async get(): Promise<Result<ReadModelRecord, DbError>> { return err({ code: "unavailable", message: "x" }); },
      async put(r: ReadModelRecord): Promise<Result<ReadModelRecord, DbError>> { return ok(r); },
      async clear(): Promise<Result<void, DbError>> { return ok(undefined); },
    };
    const rescope = createRegistryValidatedRescope({ reader, readModels: faulting });
    const res = await rescope.rescope(disp({ workspaceId: "route-ws" as TriageDisposition["workspaceId"] }));
    expect(isErr(res) && res.error.code).toBe("rescope_failed");
  });
});

describe("createReenterRunner (15.5 — re-gate + idempotencyKey replay)", () => {
  const committed = { idempotencyKey: "run:155" } as unknown as CommittedRevision;
  const revStore = (has: boolean): KnowledgeRevisionStore => ({
    getByIdempotencyKey: async () => (has ? committed : undefined),
    record: async () => {},
  });

  it("reenter_reuses_idempotency_key_replays_when_committed: an already-committed key ⇒ runReused=true, no duplicate (replay over the real KnowledgeRevisionStore, rule 3/inv-D) [spec(§9)]", async () => {
    const runner = createReenterRunner({ reGate: async () => ok(undefined), revisions: revStore(true) });
    const res = await runner.run(envelope({ workspaceId: "route-ws" as SourceEnvelope["workspaceId"] }), "run:155");
    expect(isOk(res) && res.value.runReused).toBe(true); // replayed — the committed revision stands
    const fresh = createReenterRunner({ reGate: async () => ok(undefined), revisions: revStore(false) });
    const res2 = await fresh.run(envelope(), "novel-key");
    expect(isOk(res2) && res2.value.runReused).toBe(false); // novel key — fresh re-entry
  });

  it("reenter_redrives_through_the_candidate_gate: a re-scoped source REJECTED by the candidate gate ⇒ reentry_failed (rule 2 — never a raw-around-gate re-entry) [spec(rule 2)]", async () => {
    const runner = createReenterRunner({ reGate: async () => err({ code: "rejected" as const }), revisions: revStore(false) });
    const res = await runner.run(envelope(), "run:155");
    expect(isErr(res) && res.error.code).toBe("reentry_failed");
  });
});

describe("exactly-once via the REAL record activity over the durable store (15.5 — inv-A/inv-B + fail-closed)", () => {
  it("exactly_once_hit_reuses_the_prior_audit_ref: the SAME decision recorded twice ⇒ first `recorded`, second `noop` reusing the SAME auditRef; ONE audit appended (inv-A/inv-B) [spec(§9)]", async () => {
    const repo = new FakeDispositionRepo().seed(dbRow()); // parked
    const audit = new FakeAudit();
    const store = createDurableDispositionStore({ repo, audit, now: () => NOW, runRef });
    const activity = createRecordDispositionActivity({ store });
    const first = await activity.record(disp());
    const second = await activity.record(disp()); // SAME decision ⇒ SAME channel-free dispositionKey
    expect(isOk(first) && first.value.outcome).toBe("recorded");
    expect(isOk(second) && second.value.outcome).toBe("noop");
    expect(isOk(first) && isOk(second) && String(first.value.auditRef) === String(second.value.auditRef)).toBe(true); // reused
    expect(audit.appended).toHaveLength(1); // exactly-once: no second audit record
  });

  it("record_path_fails_closed_on_a_getByKey_step_fault: a fault at the getByKey step degrades to undefined but the CAS insert re-hits the unreachable store ⇒ typed err — never a masked silent record (proves the getByKey-degrade is safe) [spec(§16)]", async () => {
    const repo = new FakeDispositionRepo().seed(dbRow()); // parked ⇒ isParked (getBySourceId) works
    repo.faults.add("getByDispositionKey"); // the getByKey step faults → degrades to undefined
    repo.faults.add("recordDisposition"); // …and the CAS insert re-hits the unreachable store
    const store = createDurableDispositionStore({ repo, audit: new FakeAudit(), now: () => NOW, runRef });
    const activity = createRecordDispositionActivity({ store });
    const res = await activity.record(disp());
    expect(isErr(res) && res.error.code).toBe("record_failed"); // fail-closed — no silent record
  });
});
