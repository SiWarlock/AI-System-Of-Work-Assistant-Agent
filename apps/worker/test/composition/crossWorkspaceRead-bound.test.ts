// Task 24.52 — bound the audit-persist path in `resolveApprovedCrossWorkspaceSlice` BEFORE any
// real `GclAuditPersistPort` binds. RED-first.
//
// `serveProjection` (`@sow/knowledge`) internally `await persistDenialAudit(...)`, which itself
// `await`s `auditPersist.persistDenial(...)` when a port is injected — and the read loop in
// `crossWorkspaceRead.ts` `await`s `serveProjection` PER ROW, serially. Today the composition
// root never passes an `auditPersist`, so this is dormant (reachability-waived) — but once a real
// port binds, an unbounded per-row await would make N denials cost N serial write-latencies, and a
// port that never resolves would hang the WHOLE read forever. This file pins the bound BEFORE that
// port exists, per the brief: "bound the audit-persist path BEFORE any real port binds."
//
// TWO invariants must survive the fix (stated explicitly so a future edit doesn't re-break them):
//   1. the denial itself must NEVER depend on the audit write (24.33's invariant) — a projection
//      that fails the gate is withheld/counted regardless of whether its audit write ever lands.
//   2. `persistDenialAudit`'s own never-throw contract is untouched (it lives in @sow/knowledge,
//      out of this package's territory) — this file only bounds ITS CALLER's wait on it.
import { describe, it, expect, vi } from "vitest";
import { ok, err, isOk, type Result } from "@sow/contracts";
import type { GclProjection, Workspace, VisibilityLevel } from "@sow/contracts";
import type {
  CrossWorkspaceLinkRow,
  CrossWorkspaceLinkStatus,
  CrossWorkspaceLinkRepository,
  GclProjectionRepository,
  WorkspaceConfigRepository,
  DbError,
} from "@sow/db";
import type { GclAuditPersistPort } from "@sow/knowledge";
import type { AuditSignal } from "@sow/policy";
import {
  resolveApprovedCrossWorkspaceSlice,
  boundAuditPersist,
  type CrossWorkspaceReadOutcome,
} from "../../src/composition/crossWorkspaceRead";

const NOW = "2026-08-24T00:00:00.000Z";
const wsp = (s: string): GclProjection["workspaceId"] => s as GclProjection["workspaceId"];

function gclProj(over: Partial<GclProjection> = {}): GclProjection {
  return {
    workspaceId: wsp("ws-b"),
    visibilityLevel: "coordination",
    projectionType: "coordination",
    sanitizedPayload: { headline: "Q3 launch on track" },
    sourceRefs: [],
    ...over,
  } as GclProjection;
}

function link(over: Partial<CrossWorkspaceLinkRow> = {}): CrossWorkspaceLinkRow {
  return {
    linkId: "link-1",
    fromWorkspaceId: "ws-a" as CrossWorkspaceLinkRow["fromWorkspaceId"],
    toWorkspaceId: "ws-b" as CrossWorkspaceLinkRow["toWorkspaceId"],
    scopeProjectionType: "coordination",
    scopeVisibilityLevel: "coordination",
    status: "approved",
    createdAt: NOW,
    approvedAt: NOW,
    revokedAt: null,
    ...over,
  };
}

function workspace(id: string, defaultVisibility: VisibilityLevel): Workspace {
  return { id, defaultVisibility } as unknown as Workspace;
}

class FakeLinkRepo implements CrossWorkspaceLinkRepository {
  rows = new Map<string, CrossWorkspaceLinkRow>();
  seed(...rs: CrossWorkspaceLinkRow[]): this {
    for (const r of rs) this.rows.set(r.linkId, r);
    return this;
  }
  async create(row: CrossWorkspaceLinkRow): Promise<Result<CrossWorkspaceLinkRow, DbError>> {
    this.rows.set(row.linkId, row);
    return ok(row);
  }
  async get(linkId: string): Promise<Result<CrossWorkspaceLinkRow, DbError>> {
    const r = this.rows.get(linkId);
    return r ? ok(r) : err({ code: "not_found", message: "x" });
  }
  async listApprovedForReader(fromWorkspaceId: CrossWorkspaceLinkRow["fromWorkspaceId"]): Promise<Result<CrossWorkspaceLinkRow[], DbError>> {
    return ok([...this.rows.values()].filter((r) => r.fromWorkspaceId === fromWorkspaceId && r.status === "approved"));
  }
  async setStatus(linkId: string, status: CrossWorkspaceLinkStatus, at: string): Promise<Result<CrossWorkspaceLinkRow, DbError>> {
    const r = this.rows.get(linkId);
    if (!r) return err({ code: "not_found", message: "x" });
    const next: CrossWorkspaceLinkRow = { ...r, status, approvedAt: status === "approved" ? at : r.approvedAt, revokedAt: status === "revoked" ? at : r.revokedAt };
    this.rows.set(linkId, next);
    return ok(next);
  }
}

class FakeGclRepo implements GclProjectionRepository {
  byWorkspace = new Map<string, GclProjection[]>();
  seed(workspaceId: string, ...ps: GclProjection[]): this {
    this.byWorkspace.set(workspaceId, [...(this.byWorkspace.get(workspaceId) ?? []), ...ps]);
    return this;
  }
  async listByWorkspace(workspaceId: GclProjection["workspaceId"]): Promise<Result<GclProjection[], DbError>> {
    return ok(this.byWorkspace.get(workspaceId) ?? []);
  }
  async listByVisibility(): Promise<Result<GclProjection[], DbError>> {
    return ok([]);
  }
  async get(): Promise<Result<GclProjection, DbError>> {
    return err({ code: "not_found", message: "x" });
  }
  async upsert(p: GclProjection): Promise<Result<GclProjection, DbError>> {
    return ok(p);
  }
}

class FakeWorkspaceConfigRepo implements WorkspaceConfigRepository {
  rows = new Map<string, Workspace>();
  seed(ws: Workspace): this {
    this.rows.set(String(ws.id), ws);
    return this;
  }
  async get(id: Workspace["id"]): Promise<Result<Workspace, DbError>> {
    const r = this.rows.get(String(id));
    return r ? ok(r) : err({ code: "not_found", message: "x" });
  }
  list(): never {
    throw new Error("must not be called by this gate");
  }
  upsert(): never {
    throw new Error("must not be called by this gate");
  }
  updateProvisioningFields(): never {
    throw new Error("must not be called by this gate");
  }
  insertIfAbsent(): never {
    throw new Error("must not be called by this gate");
  }
}

/** N rows that all exceed a tightened ceiling (each triggers `serveProjection`'s per-row denial,
 *  and therefore ONE `persistDenialAudit` → `auditPersist.persistDenial` call each). */
function nOverCeilingRows(n: number): { links: FakeLinkRepo; gcl: FakeGclRepo; workspaceConfig: FakeWorkspaceConfigRepo } {
  const links = new FakeLinkRepo().seed(link()); // scope: coordination/coordination
  const gcl = new FakeGclRepo();
  for (let i = 0; i < n; i += 1) {
    gcl.seed("ws-b", gclProj({ sanitizedPayload: { headline: `row ${i}` } }));
  }
  const workspaceConfig = new FakeWorkspaceConfigRepo().seed(workspace("ws-b", "isolated")); // below "coordination" ⇒ every row exceeds
  return { links, gcl, workspaceConfig };
}

function fixtureSignal(): AuditSignal {
  return {
    actor: "system",
    event: "gcl_denial",
    refs: ["ws-b"],
    payloadHash: "hash-1",
    beforeSummary: "before",
    afterSummary: "after",
  };
}

describe("resolveApprovedCrossWorkspaceSlice — 24.52 bounded audit-persist path", () => {
  it("does_not_serially_await_N_controlled_delay_persistDenial_writes: the read settles via microtasks alone, with fake timers NEVER advanced — a naive `await auditPersist.persistDenial(...)` per row would hang here", async () => {
    vi.useFakeTimers();
    try {
      const N = 5;
      const { links, gcl, workspaceConfig } = nOverCeilingRows(N);
      // A write that would only ever settle after a macrotask timer no test here ever advances.
      const auditPersist: GclAuditPersistPort = {
        persistDenial: () => new Promise((resolve) => setTimeout(resolve, 10_000)),
      };
      const res = await resolveApprovedCrossWorkspaceSlice(
        { links, gclProjections: gcl, workspaceConfig, auditPersist },
        "ws-a",
      );
      // Reaching this line at all (without vi.advanceTimersByTimeAsync) proves the read never
      // depended on the 10s timer firing — i.e., never serially awaited the write.
      expect(isOk(res)).toBe(true);
      if (isOk(res)) expect(res.value.visibilityExceededCount).toBe(N); // the denial itself is untouched (24.33)
    } finally {
      vi.useRealTimers();
    }
  });

  it("a_never_resolving_audit_persist_port_does_not_block_the_denial_from_completing: the read settles well before an independent guard timer, even though persistDenial never resolves", async () => {
    const auditPersist: GclAuditPersistPort = {
      persistDenial: () => new Promise(() => {}), // never resolves, never rejects
    };
    const { links, gcl, workspaceConfig } = nOverCeilingRows(1);
    let guardFired = false;
    const guard = new Promise<"guard">((resolve) => {
      setTimeout(() => {
        guardFired = true;
        resolve("guard");
      }, 300);
    });
    const call = resolveApprovedCrossWorkspaceSlice(
      { links, gclProjections: gcl, workspaceConfig, auditPersist },
      "ws-a",
    );
    const winner = await Promise.race([call, guard]);
    // Unconditional assertions (Lesson 15 — never assert only inside a branch a resolve could skip).
    expect(guardFired).toBe(false); // the call won the race — it never blocked on the dead port
    expect(winner).not.toBe("guard");
    expect(isOk(winner as Result<CrossWorkspaceReadOutcome, unknown>)).toBe(true);
  });
});

describe("boundAuditPersist — the bounded fire-and-forget queue itself (24.52)", () => {
  function signalArgs(): [AuditSignal, string] {
    return [fixtureSignal(), "ws-b"];
  }

  it("queue_full_drop: a write beyond maxConcurrent is counted as dropped and the real port is never even invoked for it", async () => {
    let started = 0;
    let drops = 0;
    const real: GclAuditPersistPort = {
      persistDenial: () => {
        started += 1;
        return new Promise(() => {}); // holds its slot forever
      },
    };
    const bounded = boundAuditPersist(real, () => {
      drops += 1;
    }, { maxConcurrent: 1, perWriteTimeoutMs: 100_000 });
    await bounded.persistDenial(...signalArgs());
    expect(started).toBe(1);
    expect(drops).toBe(0);
    await bounded.persistDenial(...signalArgs()); // the ONE slot is still held by the never-resolving write
    expect(started).toBe(1); // the real port is NEVER invoked for the dropped call
    expect(drops).toBe(1); // counted — never silently dropped
  });

  it("per_write_timeout_drop: a write exceeding perWriteTimeoutMs is counted as dropped and frees its slot for the next call", async () => {
    vi.useFakeTimers();
    try {
      let drops = 0;
      const real: GclAuditPersistPort = {
        persistDenial: () => new Promise(() => {}), // never settles on its own
      };
      const bounded = boundAuditPersist(real, () => {
        drops += 1;
      }, { maxConcurrent: 1, perWriteTimeoutMs: 50 });
      await bounded.persistDenial(...signalArgs());
      expect(drops).toBe(0);
      await vi.advanceTimersByTimeAsync(50);
      expect(drops).toBe(1); // the per-write timeout fired — counted
      // The slot is freed by the timeout — a SECOND call now has capacity and is not queue-dropped.
      await bounded.persistDenial(...signalArgs());
      expect(drops).toBe(1); // unchanged: this call had a free slot
    } finally {
      vi.useRealTimers();
    }
  });

  it("a_write_that_completes_within_the_timeout_is_never_counted_as_dropped: the counter is non-vacuous", async () => {
    let drops = 0;
    let delivered: string | undefined;
    const real: GclAuditPersistPort = {
      persistDenial: async (_signal, workspaceId) => {
        delivered = workspaceId;
      },
    };
    const bounded = boundAuditPersist(real, () => {
      drops += 1;
    }, { maxConcurrent: 4, perWriteTimeoutMs: 5_000 });
    await bounded.persistDenial(...signalArgs());
    // Let the fire-and-forget microtask chain settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(delivered).toBe("ws-b");
    expect(drops).toBe(0); // a clean, timely write is never counted as a drop
  });
});
