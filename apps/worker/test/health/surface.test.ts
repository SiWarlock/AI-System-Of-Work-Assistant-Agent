// Task 10.3 — System Health SURFACE (OBS-1/OBS-2). The worker-layer failure →
// typed HealthItem materializer that is: (a) DISTINCT per OBS-2 FailureClass;
// (b) AUDIT-LINKED + PERSISTENT (via the injected health repo/store, survives
// restart); (c) IDEMPOTENT dedupe by (failureClass, subjectRef) — a recurring
// same-class same-subject failure bumps occurrenceCount/lastSeen on the ONE open
// item, never a duplicate; (d) lifecycle open → acknowledged | resolved (resolved
// terminal) with AUTO-RESOLVE when the underlying condition clears; (e)
// acknowledge/resolve survives a simulated restart (re-read from the store).
//
// The surface is unit-testable with a FAKE persistent store implementing the
// HealthSurfaceStore port (getByDedupeKey/put/list) — the real @sow/db binding is
// the integrator step. Never throws across the boundary (§16): typed Result.

import { describe, it, expect } from "vitest";
import { isOk, isErr, auditId } from "@sow/contracts";
import type { AuditId, FailureClass } from "@sow/contracts";
import {
  createHealthSurface,
  type HealthSurfaceStore,
  type SurfacedHealthItem,
  type HealthFailure,
} from "../../src/health/surface";

const NOW = "2026-07-02T00:00:00.000Z";
const LATER = "2026-07-02T01:00:00.000Z";
const LATER2 = "2026-07-02T02:00:00.000Z";
const AUDIT: AuditId = auditId("audit-001");
const AUDIT2: AuditId = auditId("audit-002");

/**
 * An in-memory PERSISTENT store implementing the HealthSurfaceStore port. The
 * backing Map IS the "durable" tier: a fresh createHealthSurface(sameStore)
 * simulates a process restart (state re-read from the store, not from surface
 * memory).
 */
function makeFakeStore(seed: SurfacedHealthItem[] = []): HealthSurfaceStore & {
  readonly rows: Map<string, SurfacedHealthItem>;
} {
  const rows = new Map<string, SurfacedHealthItem>();
  for (const r of seed) rows.set(r.dedupeKey, r);
  return {
    rows,
    getByDedupeKey(dedupeKey: string): Promise<SurfacedHealthItem | undefined> {
      return Promise.resolve(rows.get(dedupeKey));
    },
    put(record: SurfacedHealthItem): Promise<void> {
      rows.set(record.dedupeKey, record);
      return Promise.resolve();
    },
    list(): Promise<SurfacedHealthItem[]> {
      return Promise.resolve([...rows.values()]);
    },
  };
}

const failure = (partial: Partial<HealthFailure> = {}): HealthFailure => ({
  failureClass: "connector_unreachable" as FailureClass,
  subjectRef: "connector:calendar",
  message: "calendar connector unreachable",
  auditRef: AUDIT,
  now: NOW,
  ...partial,
});

describe("createHealthSurface — record (materialize + dedupe)", () => {
  it("materializes ONE open, audit-linked, distinct item per (failureClass, subjectRef) on first sight", async () => {
    const store = makeFakeStore();
    const surface = createHealthSurface(store);

    const r = await surface.record(failure());
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    expect(r.value.item.failureClass).toBe("connector_unreachable");
    expect(r.value.item.state).toBe("open");
    // AUDIT-LINKED: carries the auditRef of the occurrence.
    expect(r.value.item.auditRef).toBe(AUDIT);
    expect(r.value.occurrenceCount).toBe(1);
    expect(r.value.openedAt).toBe(NOW);
    expect(r.value.lastSeen).toBe(NOW);
    // PERSISTENT: written to the injected store.
    expect(store.rows.size).toBe(1);
  });

  it("same-class same-subject twice → ONE item with occurrenceCount 2 (idempotent dedupe, no duplicate)", async () => {
    const store = makeFakeStore();
    const surface = createHealthSurface(store);

    await surface.record(failure({ now: NOW }));
    const second = await surface.record(
      failure({ now: LATER, auditRef: AUDIT2, message: "still unreachable" }),
    );

    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    // Exactly ONE stored item — no duplicate.
    expect(store.rows.size).toBe(1);
    expect(second.value.occurrenceCount).toBe(2);
    // openedAt PRESERVED from the first sight; lastSeen + auditRef refresh.
    expect(second.value.openedAt).toBe(NOW);
    expect(second.value.lastSeen).toBe(LATER);
    expect(second.value.item.auditRef).toBe(AUDIT2);
    // Still OPEN (a recurrence does not resolve it).
    expect(second.value.item.state).toBe("open");
  });

  it("distinct FailureClasses → DISTINCT items (discriminated, not one generic item)", async () => {
    const store = makeFakeStore();
    const surface = createHealthSurface(store);

    const classes: FailureClass[] = [
      "connector_unreachable",
      "write_through_failed",
      "budget_breach",
      "missed_or_late_schedule",
      "schema_rejection",
    ];
    for (const failureClass of classes) {
      const r = await surface.record(failure({ failureClass, subjectRef: `subj:${failureClass}` }));
      expect(isOk(r)).toBe(true);
    }
    expect(store.rows.size).toBe(classes.length);
    const listed = await surface.list();
    expect(isOk(listed)).toBe(true);
    if (!isOk(listed)) return;
    expect(new Set(listed.value.map((i) => i.item.failureClass)).size).toBe(classes.length);
  });

  it("SAME class but DIFFERENT subject → distinct items (dedupe is (class, subject), not class alone)", async () => {
    const store = makeFakeStore();
    const surface = createHealthSurface(store);
    await surface.record(failure({ subjectRef: "connector:calendar" }));
    await surface.record(failure({ subjectRef: "connector:todoist" }));
    expect(store.rows.size).toBe(2);
  });

  it("every materialized item carries an auditRef (never absent)", async () => {
    const store = makeFakeStore();
    const surface = createHealthSurface(store);
    const r = await surface.record(failure());
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.item.auditRef).toBeTruthy();
  });
});

describe("createHealthSurface — lifecycle acknowledge / resolve", () => {
  it("acknowledge moves open → acknowledged (persisted, occurrenceCount + openedAt preserved)", async () => {
    const store = makeFakeStore();
    const surface = createHealthSurface(store);
    await surface.record(failure());

    const acked = await surface.acknowledge({
      failureClass: "connector_unreachable" as FailureClass,
      subjectRef: "connector:calendar",
    });
    expect(isOk(acked)).toBe(true);
    if (!isOk(acked)) return;
    expect(acked.value?.item.state).toBe("acknowledged");
    expect(acked.value?.occurrenceCount).toBe(1);
    expect(acked.value?.openedAt).toBe(NOW);
  });

  it("a recurrence after acknowledge stays ACKNOWLEDGED (does not silently reopen), bumps occurrenceCount", async () => {
    const store = makeFakeStore();
    const surface = createHealthSurface(store);
    await surface.record(failure({ now: NOW }));
    await surface.acknowledge({
      failureClass: "connector_unreachable" as FailureClass,
      subjectRef: "connector:calendar",
    });
    const recur = await surface.record(failure({ now: LATER, auditRef: AUDIT2 }));
    expect(isOk(recur)).toBe(true);
    if (!isOk(recur)) return;
    expect(recur.value.item.state).toBe("acknowledged");
    expect(recur.value.occurrenceCount).toBe(2);
  });

  it("auto-resolve when the underlying condition clears: open → resolved (resolvedAt set, terminal)", async () => {
    const store = makeFakeStore();
    const surface = createHealthSurface(store);
    await surface.record(failure());

    const cleared = await surface.resolve({
      failureClass: "connector_unreachable" as FailureClass,
      subjectRef: "connector:calendar",
      now: LATER,
    });
    expect(isOk(cleared)).toBe(true);
    if (!isOk(cleared)) return;
    expect(cleared.value?.item.state).toBe("resolved");
    expect(cleared.value?.item.resolvedAt).toBe(LATER);
  });

  it("resolve is IDEMPOTENT for an unseen subject (no item) → ok(undefined), not an error", async () => {
    const store = makeFakeStore();
    const surface = createHealthSurface(store);
    const cleared = await surface.resolve({
      failureClass: "budget_breach" as FailureClass,
      subjectRef: "never-seen",
      now: NOW,
    });
    expect(isOk(cleared)).toBe(true);
    if (!isOk(cleared)) return;
    expect(cleared.value).toBeUndefined();
  });

  it("a NEW failure AFTER auto-resolve REOPENS a fresh open item (terminal → reopen, fresh openedAt)", async () => {
    const store = makeFakeStore();
    const surface = createHealthSurface(store);
    await surface.record(failure({ now: NOW }));
    await surface.resolve({
      failureClass: "connector_unreachable" as FailureClass,
      subjectRef: "connector:calendar",
      now: LATER,
    });
    const reopened = await surface.record(failure({ now: LATER2, auditRef: AUDIT2 }));
    expect(isOk(reopened)).toBe(true);
    if (!isOk(reopened)) return;
    expect(reopened.value.item.state).toBe("open");
    expect(reopened.value.item.resolvedAt).toBeUndefined();
    // Fresh lifecycle: openedAt is the reopen time, occurrenceCount restarts at 1.
    expect(reopened.value.openedAt).toBe(LATER2);
    expect(reopened.value.occurrenceCount).toBe(1);
  });
});

describe("createHealthSurface — persistence survives a simulated restart", () => {
  it("acknowledge state survives a simulated restart (re-read from the store, not surface memory)", async () => {
    const store = makeFakeStore();
    const s1 = createHealthSurface(store);
    await s1.record(failure());
    await s1.acknowledge({
      failureClass: "connector_unreachable" as FailureClass,
      subjectRef: "connector:calendar",
    });

    // Simulate a restart: a BRAND NEW surface over the SAME persistent store.
    const s2 = createHealthSurface(store);
    const listed = await s2.list();
    expect(isOk(listed)).toBe(true);
    if (!isOk(listed)) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]?.item.state).toBe("acknowledged");

    // And a recurrence AFTER restart still sees the acknowledged item (no reset).
    const recur = await s2.record(failure({ now: LATER }));
    expect(isOk(recur)).toBe(true);
    if (!isOk(recur)) return;
    expect(recur.value.item.state).toBe("acknowledged");
    expect(recur.value.occurrenceCount).toBe(2);
  });

  it("resolved (terminal) state survives a simulated restart", async () => {
    const store = makeFakeStore();
    const s1 = createHealthSurface(store);
    await s1.record(failure());
    await s1.resolve({
      failureClass: "connector_unreachable" as FailureClass,
      subjectRef: "connector:calendar",
      now: LATER,
    });

    const s2 = createHealthSurface(store);
    const listed = await s2.list();
    expect(isOk(listed)).toBe(true);
    if (!isOk(listed)) return;
    expect(listed.value[0]?.item.state).toBe("resolved");
    expect(listed.value[0]?.item.resolvedAt).toBe(LATER);
  });
});

describe("createHealthSurface — OBS-1 read model", () => {
  it("counts open|acknowledged as ACTIVE and excludes resolved (health reflects truth, not stale alarms)", async () => {
    const store = makeFakeStore();
    const surface = createHealthSurface(store);
    // open
    await surface.record(failure({ subjectRef: "connector:a" }));
    // acknowledged
    await surface.record(failure({ subjectRef: "connector:b" }));
    await surface.acknowledge({
      failureClass: "connector_unreachable" as FailureClass,
      subjectRef: "connector:b",
    });
    // resolved (auto-resolve — should NOT count as active)
    await surface.record(failure({ subjectRef: "connector:c" }));
    await surface.resolve({
      failureClass: "connector_unreachable" as FailureClass,
      subjectRef: "connector:c",
      now: LATER,
    });

    const rm = await surface.readModel({
      runs: [
        { workflowId: "wf-1", state: "failed", trigger: "schedule" },
        { workflowId: "wf-2", state: "completed", trigger: "schedule" },
      ],
      queueDepth: 3,
      outboxDepth: 2,
      blockedWriteThroughs: 1,
      nextScheduledRunAt: LATER,
    });
    expect(isOk(rm)).toBe(true);
    if (!isOk(rm)) return;
    // open + acknowledged = 2 active; resolved excluded.
    expect(rm.value.openHealthItemCount).toBe(2);
    expect(rm.value.runCounts.failed).toBe(1);
    expect(rm.value.runCounts.completed).toBe(1);
    expect(rm.value.failedRuns).toHaveLength(1);
    expect(rm.value.queueDepth).toBe(3);
    expect(rm.value.outboxDepth).toBe(2);
    expect(rm.value.blockedWriteThroughs).toBe(1);
    expect(rm.value.nextScheduledRunAt).toBe(LATER);
  });

  it("groups the active health items by FailureClass for the OBS-1 per-class surfaces", async () => {
    const store = makeFakeStore();
    const surface = createHealthSurface(store);
    await surface.record(failure({ failureClass: "connector_unreachable" as FailureClass, subjectRef: "a" }));
    await surface.record(failure({ failureClass: "connector_unreachable" as FailureClass, subjectRef: "b" }));
    await surface.record(failure({ failureClass: "budget_breach" as FailureClass, subjectRef: "c" }));

    const rm = await surface.readModel({
      runs: [],
      queueDepth: 0,
      outboxDepth: 0,
      blockedWriteThroughs: 0,
    });
    expect(isOk(rm)).toBe(true);
    if (!isOk(rm)) return;
    expect(rm.value.activeByClass.connector_unreachable).toBe(2);
    expect(rm.value.activeByClass.budget_breach).toBe(1);
  });
});

describe("createHealthSurface — §16 no-throw / typed error surface", () => {
  it("a store read fault becomes a typed err (never a throw across the boundary)", async () => {
    const store: HealthSurfaceStore = {
      getByDedupeKey(): Promise<SurfacedHealthItem | undefined> {
        return Promise.reject(new Error("db down"));
      },
      put(): Promise<void> {
        return Promise.resolve();
      },
      list(): Promise<SurfacedHealthItem[]> {
        return Promise.resolve([]);
      },
    };
    const surface = createHealthSurface(store);
    const r = await surface.record(failure());
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("persist_failed");
  });

  it("a store write fault becomes a typed err", async () => {
    const store: HealthSurfaceStore = {
      getByDedupeKey(): Promise<SurfacedHealthItem | undefined> {
        return Promise.resolve(undefined);
      },
      put(): Promise<void> {
        return Promise.reject(new Error("write failed"));
      },
      list(): Promise<SurfacedHealthItem[]> {
        return Promise.resolve([]);
      },
    };
    const surface = createHealthSurface(store);
    const r = await surface.record(failure());
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("persist_failed");
  });
});
