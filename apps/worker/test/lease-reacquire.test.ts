// 10.4b — worker-side single-instance lease RE-ACQUIRE on (re)start (LIFE-1).
//
// Ungated Vitest: no Temporal server, no real DB. On (re)start the worker
// re-acquires the LIFE-1 lease through the @sow/db InstanceLeaseRepository, which
// this module adapts onto the @sow/workflows InstanceLeaseStore port (mirroring
// the last-run repo→port adapter) and drives via the PURE decideLease. The
// LOAD-BEARING guarantee, pinned here: if a LIVE instance already holds a valid
// (unexpired) lease, the new worker does NOT double-run — decideLease returns
// 'passive', so there are never two owners of the operational store / GBrain files.
// A store fault fails CLOSED to passive (never a risky acquire). Never throws (§16).

import { describe, it, expect } from "vitest";
import { ok, err, isOk } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type {
  DbError,
  InstanceLeaseRepository,
  LeaseRecordRow,
} from "@sow/db";
import {
  createLeaseStoreAdapter,
  reacquireLease,
  type ReacquireInput,
} from "../src/lifecycle/lease-reacquire";

const TQ = "sow-control-plane";
const NOW = "2026-07-02T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const TTL = 30_000;

const row = (partial: Partial<LeaseRecordRow> = {}): LeaseRecordRow => ({
  taskQueue: TQ,
  ownerId: "owner-A",
  acquiredAt: NOW,
  expiresAt: "2026-07-02T00:00:30.000Z", // unexpired at NOW
  generation: 1,
  ...partial,
});

const dbErr = (code: DbError["code"], message: string = code): DbError => ({ code, message });

const input = (partial: Partial<ReacquireInput> = {}): ReacquireInput => ({
  taskQueue: TQ,
  ownerId: "owner-A",
  now: NOW,
  leaseTtlMs: TTL,
  ...partial,
});

// A minimal in-memory InstanceLeaseRepository honoring the CAS contract, so the
// re-acquire path is exercised without a real SQLite/Postgres driver.
class MemLeaseRepo implements InstanceLeaseRepository {
  private stored: LeaseRecordRow | undefined;
  constructor(initial?: LeaseRecordRow) {
    this.stored = initial;
  }
  get(taskQueue: string): Promise<Result<LeaseRecordRow, DbError>> {
    if (this.stored !== undefined && this.stored.taskQueue === taskQueue) {
      return Promise.resolve(ok(this.stored));
    }
    return Promise.resolve(err(dbErr("not_found", `lease ${taskQueue}`)));
  }
  compareAndSet(
    expected: LeaseRecordRow | undefined,
    next: LeaseRecordRow,
  ): Promise<Result<boolean, DbError>> {
    const eq = (a?: LeaseRecordRow, b?: LeaseRecordRow): boolean =>
      a === undefined || b === undefined
        ? a === b
        : a.taskQueue === b.taskQueue &&
          a.ownerId === b.ownerId &&
          a.acquiredAt === b.acquiredAt &&
          a.expiresAt === b.expiresAt &&
          a.generation === b.generation;
    if (!eq(this.stored, expected)) return Promise.resolve(ok(false));
    this.stored = next;
    return Promise.resolve(ok(true));
  }
  peek(): LeaseRecordRow | undefined {
    return this.stored;
  }
}

// A repo whose get succeeds but whose compareAndSet returns a typed DbError — used
// to prove the fault fails CLOSED to a passive outcome (never a risky acquire).
class FaultyCasRepo implements InstanceLeaseRepository {
  constructor(private readonly current: LeaseRecordRow | undefined) {}
  get(_taskQueue: string): Promise<Result<LeaseRecordRow, DbError>> {
    return Promise.resolve(
      this.current ? ok(this.current) : err(dbErr("not_found")),
    );
  }
  compareAndSet(): Promise<Result<boolean, DbError>> {
    return Promise.resolve(err(dbErr("unavailable", "db down")));
  }
}

describe("createLeaseStoreAdapter — @sow/db repo → @sow/workflows InstanceLeaseStore port", () => {
  it("get: a stored row maps to the port DTO; a not_found miss maps to undefined", async () => {
    const repo = new MemLeaseRepo(row());
    const store = createLeaseStoreAdapter(repo);
    const got = await store.get(TQ);
    expect(got?.ownerId).toBe("owner-A");
    const missRepo = new MemLeaseRepo(undefined);
    const missStore = createLeaseStoreAdapter(missRepo);
    expect(await missStore.get(TQ)).toBeUndefined();
  });

  it("compareAndSet: forwards the CAS verdict (win=true, loss=false)", async () => {
    const repo = new MemLeaseRepo(undefined);
    const store = createLeaseStoreAdapter(repo);
    const next: LeaseRecordRow = row({ ownerId: "owner-A" });
    expect(await store.compareAndSet(undefined, next)).toBe(true);
    // second CAS with a stale `expected: undefined` loses (slot now taken)
    expect(await store.compareAndSet(undefined, row({ ownerId: "owner-B" }))).toBe(false);
  });

  it("compareAndSet: a store fault fails CLOSED to false (a fault never authorizes a write)", async () => {
    const repo = new FaultyCasRepo(undefined);
    const store = createLeaseStoreAdapter(repo);
    // The port cannot express a typed failure; a fault must resolve to 'lost' (false)
    // so the pure decideLease treats it as a lost race → passive (fail-closed).
    expect(await store.compareAndSet(undefined, row())).toBe(false);
  });
});

describe("reacquireLease — single-owner guarantee on (re)start (LIFE-1)", () => {
  it("empty slot → acquire (worker takes the lease, writes its record)", async () => {
    const repo = new MemLeaseRepo(undefined);
    const r = await reacquireLease(input({ ownerId: "owner-A" }), repo);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.action).toBe("acquire");
    expect(r.value.mayProcess).toBe(true);
    expect(r.value.next?.ownerId).toBe("owner-A");
    expect(Date.parse(r.value.next!.expiresAt)).toBe(NOW_MS + TTL);
    expect(repo.peek()?.ownerId).toBe("owner-A");
  });

  it("REFUSES a second owner while a valid lease is held → passive, mayProcess=false, no write", async () => {
    // owner-A holds an unexpired lease; owner-B (re)starts and re-acquires.
    const held = row({ ownerId: "owner-A" });
    const repo = new MemLeaseRepo(held);
    const r = await reacquireLease(input({ ownerId: "owner-B" }), repo);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    // The second worker must NOT double-run — no two owners of the operational
    // store / GBrain files.
    expect(r.value.action).toBe("passive");
    expect(r.value.mayProcess).toBe(false);
    expect(r.value.next).toBeUndefined();
    // store untouched — owner-A still holds it.
    expect(repo.peek()?.ownerId).toBe("owner-A");
  });

  it("our OWN live lease → reacquire (supervised respawn renews, still single owner)", async () => {
    const mine = row({ ownerId: "owner-A", generation: 4 });
    const repo = new MemLeaseRepo(mine);
    const r = await reacquireLease(input({ ownerId: "owner-A" }), repo);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.action).toBe("reacquire");
    expect(r.value.mayProcess).toBe(true);
    // renew of our own live lease PRESERVES the fencing token.
    expect(r.value.next?.generation).toBe(4);
  });

  it("another owner's EXPIRED lease → acquire (a crashed prior instance does not block restart)", async () => {
    const stale = row({
      ownerId: "owner-B",
      generation: 5,
      expiresAt: "2026-07-01T23:59:59.000Z", // before NOW → expired
    });
    const repo = new MemLeaseRepo(stale);
    const r = await reacquireLease(input({ ownerId: "owner-A" }), repo);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.action).toBe("acquire");
    expect(r.value.mayProcess).toBe(true);
    // fresh acquire by a new holder BUMPS the fencing token off the last committed.
    expect(r.value.next?.generation).toBe(6);
    expect(repo.peek()?.ownerId).toBe("owner-A");
  });

  it("a CAS store fault fails CLOSED → passive, mayProcess=false (never a risky double-run)", async () => {
    const repo = new FaultyCasRepo(undefined);
    const r = await reacquireLease(input({ ownerId: "owner-A" }), repo);
    // fail-closed: a fault resolves to passive, not an acquire and not a throw.
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.mayProcess).toBe(false);
    expect(r.value.action).toBe("passive");
  });
});
