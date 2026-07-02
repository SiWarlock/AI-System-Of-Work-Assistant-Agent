// 7.1 — the PURE single-active-instance lease DECISION (LIFE-1).
//
// Ungated Vitest: no Temporal server, no real DB. The decision is pure +
// clock-injected over the InstanceLeaseStore + LeaseRecord ports (foundation).
// It returns a typed Result with an ENUMERABLE closed failure set and NEVER
// throws across the boundary (§16); a store fault fails CLOSED to 'passive'
// (never a risky 'acquire' → no split-brain).

import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import type {
  InstanceLeaseStore,
  LeaseRecord,
} from "@sow/workflows/ports/operational";
import { SOW_CONTROL_PLANE_TASK_QUEUE } from "@sow/workflows/runtime/taskQueue";
import {
  decideLease,
  isFencedStale,
  type LeaseDecisionInput,
} from "../src/lease/instanceLease";

const TQ = SOW_CONTROL_PLANE_TASK_QUEUE;
const NOW = "2026-07-01T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const TTL = 30_000;

const rec = (partial: Partial<LeaseRecord> = {}): LeaseRecord => ({
  taskQueue: TQ,
  ownerId: "owner-A",
  acquiredAt: NOW,
  expiresAt: "2026-07-01T00:00:30.000Z",
  generation: 1,
  ...partial,
});

const baseInput = (
  partial: Partial<LeaseDecisionInput> = {},
): LeaseDecisionInput => ({
  taskQueue: TQ,
  ownerId: "owner-A",
  now: NOW,
  leaseTtlMs: TTL,
  current: undefined,
  ...partial,
});

// A minimal in-memory store honoring the compareAndSet CAS contract, so the
// decision's write-through can be exercised without the shared fakes (not
// exported from @sow/workflows' package surface).
class MemLeaseStore implements InstanceLeaseStore {
  private stored: LeaseRecord | undefined;
  constructor(initial?: LeaseRecord) {
    this.stored = initial;
  }
  get(_taskQueue: string): Promise<LeaseRecord | undefined> {
    return Promise.resolve(this.stored);
  }
  compareAndSet(
    expected: LeaseRecord | undefined,
    next: LeaseRecord,
  ): Promise<boolean> {
    const eq = (a?: LeaseRecord, b?: LeaseRecord): boolean =>
      a === undefined || b === undefined
        ? a === b
        : a.taskQueue === b.taskQueue &&
          a.ownerId === b.ownerId &&
          a.acquiredAt === b.acquiredAt &&
          a.expiresAt === b.expiresAt &&
          a.generation === b.generation;
    if (!eq(this.stored, expected)) return Promise.resolve(false);
    this.stored = next;
    return Promise.resolve(true);
  }
  peek(): LeaseRecord | undefined {
    return this.stored;
  }
}

// A store whose compareAndSet always throws — used to prove fail-closed handling
// (the decision must translate the fault into a typed 'passive' outcome, never
// leak a throw and never 'acquire').
class ThrowingLeaseStore implements InstanceLeaseStore {
  constructor(private readonly current: LeaseRecord | undefined) {}
  get(_taskQueue: string): Promise<LeaseRecord | undefined> {
    return Promise.resolve(this.current);
  }
  compareAndSet(): Promise<boolean> {
    return Promise.reject(new Error("store down"));
  }
}

describe("decideLease — LIFE-1 single-active-instance", () => {
  it("no current lease → acquire (writes our record via compareAndSet)", async () => {
    const store = new MemLeaseStore(undefined);
    const r = await decideLease(baseInput({ current: undefined }), store);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.action).toBe("acquire");
    expect(r.value.next).toBeDefined();
    expect(r.value.next?.ownerId).toBe("owner-A");
    expect(r.value.next?.taskQueue).toBe(TQ);
    // TTL applied off the injected clock (no Date.now()).
    expect(Date.parse(r.value.next!.expiresAt)).toBe(NOW_MS + TTL);
    // Fresh acquire off no lease bumps the token from 0 → 1.
    expect(r.value.next?.generation).toBe(1);
    expect(store.peek()?.ownerId).toBe("owner-A");
  });

  it("another instance's UNEXPIRED lease → passive (no split-brain, no write)", async () => {
    const other = rec({ ownerId: "owner-B" }); // expires after NOW
    const store = new MemLeaseStore(other);
    const r = await decideLease(
      baseInput({ ownerId: "owner-A", current: other }),
      store,
    );
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.action).toBe("passive");
    expect(r.value.next).toBeUndefined();
    // store untouched — the other owner still holds it.
    expect(store.peek()?.ownerId).toBe("owner-B");
  });

  it("another instance's EXPIRED lease → acquire (crashed instance does not block)", async () => {
    const stale = rec({
      ownerId: "owner-B",
      expiresAt: "2026-06-30T23:59:59.000Z", // before NOW
    });
    const store = new MemLeaseStore(stale);
    const r = await decideLease(
      baseInput({ ownerId: "owner-A", current: stale }),
      store,
    );
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.action).toBe("acquire");
    expect(r.value.next?.ownerId).toBe("owner-A");
    expect(store.peek()?.ownerId).toBe("owner-A");
  });

  it("our own lease → reacquire (supervised respawn renews)", async () => {
    const mine = rec({ ownerId: "owner-A" });
    const store = new MemLeaseStore(mine);
    const r = await decideLease(
      baseInput({ ownerId: "owner-A", current: mine }),
      store,
    );
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.action).toBe("reacquire");
    // renewal pushes expiry forward off the injected clock.
    expect(Date.parse(r.value.next!.expiresAt)).toBe(NOW_MS + TTL);
    // A renew of our OWN live lease PRESERVES the fencing token (rec() → gen 1).
    expect(r.value.next?.generation).toBe(1);
    expect(store.peek()?.ownerId).toBe("owner-A");
  });

  it("store fault → passive, typed err (fail-closed, never acquire)", async () => {
    const store = new ThrowingLeaseStore(undefined);
    const r = await decideLease(baseInput({ current: undefined }), store);
    // fail-closed: a fault is a typed passive outcome, not a thrown error and
    // NEVER an 'acquire' that could double-process.
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("store_fault");
    expect(r.error.action).toBe("passive");
  });

  it("lost compareAndSet race → passive (exactly one instance acquires)", async () => {
    // Two instances both observe no lease and both try to acquire. The store's
    // CAS lets exactly one win; the loser's compareAndSet returns false and the
    // decision must resolve to passive (not a bogus acquire).
    const store = new MemLeaseStore(undefined);
    const rA = await decideLease(
      baseInput({ ownerId: "owner-A", current: undefined }),
      store,
    );
    // owner-B still passes current:undefined (its stale read) but the store now
    // holds A's record → CAS mismatch → false → passive.
    const rB = await decideLease(
      baseInput({ ownerId: "owner-B", current: undefined }),
      store,
    );
    expect(isOk(rA)).toBe(true);
    if (isOk(rA)) expect(rA.value.action).toBe("acquire");
    expect(isErr(rB)).toBe(true);
    if (isErr(rB)) {
      expect(rB.error.code).toBe("lost_race");
      expect(rB.error.action).toBe("passive");
    }
    expect(store.peek()?.ownerId).toBe("owner-A");
  });

  it("acquiring over another owner's EXPIRED gen-5 lease BUMPS the token to 6 (new holder)", async () => {
    // A prior holder (owner-B) held the lease at generation 5, then its lease
    // TTL expired. owner-A reclaims it: a fresh acquire by a NEW holder must bump
    // the fencing token off the last committed generation (5 → 6) so any in-flight
    // effect the paused owner-B still carries (issued at gen 5) is fenced out.
    const stale = rec({
      ownerId: "owner-B",
      generation: 5,
      expiresAt: "2026-06-30T23:59:59.000Z", // before NOW
    });
    const store = new MemLeaseStore(stale);
    const r = await decideLease(
      baseInput({ ownerId: "owner-A", current: stale }),
      store,
    );
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.action).toBe("acquire");
    expect(r.value.next?.generation).toBe(6);
    expect(store.peek()?.generation).toBe(6);
  });

  it("reacquire (renew our OWN live lease) PRESERVES the fencing token", async () => {
    // Renewing our own live lease must NOT bump the token — no new holder took
    // over, so the generation is stable across renewals of the same holder.
    const mine = rec({ ownerId: "owner-A", generation: 7 });
    const store = new MemLeaseStore(mine);
    const r = await decideLease(
      baseInput({ ownerId: "owner-A", current: mine }),
      store,
    );
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.action).toBe("reacquire");
    expect(r.value.next?.generation).toBe(7);
    expect(store.peek()?.generation).toBe(7);
  });

  it("isFencedStale fences a paused older-generation holder once a newer generation exists", () => {
    // A paused gen-5 holder wakes after gen-6 was committed: its issued
    // generation is below the latest → its side effects are fenced out. The
    // current holder (gen-6) operating at the latest generation is NOT fenced.
    expect(isFencedStale(5, 6)).toBe(true);
    expect(isFencedStale(6, 6)).toBe(false);
    // A future/ahead generation is never fenced (defensive: strictly-below only).
    expect(isFencedStale(7, 6)).toBe(false);
  });
});
