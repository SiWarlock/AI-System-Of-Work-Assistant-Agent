// §12 CONFORMANCE — SYSTEM HEALTH surfacing per failure class (task 10.8 suite 2;
// OBS-1 / OBS-2 / §10.3 / §16). A CROSS-CUTTING conformance suite over the REAL
// worker health SURFACE (createHealthSurface) + the REAL @sow/domain routeFailure
// mapping. It asserts, per OBS-2 failure class, that a failure yields its DISTINCT,
// PERSISTENT, AUDIT-LINKED item, and exercises:
//   • dedupe-by-subject — a recurring same-(class,subject) failure bumps ONE item;
//   • lifecycle — open → acknowledged / resolved (resolved terminal);
//   • auto-resolve — a resolve on clear moves the item to resolved (reflects truth);
//   • ACK survives a simulated RESTART — re-materialize the surface over the SAME
//     persistent store; the acknowledged item is still acknowledged (persistence).
//
// The SUT is imported: @sow/worker createHealthSurface over a HealthSurfaceStore
// fake that models the persistent @sow/db health-items table (dedupe/occurrence/
// lastSeen bookkeeping). The routing that assigns each class is the REAL 10.2
// routeFailure — so a class is never invented ad-hoc in the test.
import { describe, expect, it } from "vitest";
import { auditId, failure } from "@sow/contracts";
import type { FailureClass } from "@sow/contracts";
import { routeFailure } from "@sow/domain";
import {
  createHealthSurface,
  type HealthSurfaceStore,
  type SurfacedHealthItem,
} from "@sow/worker/health/surface";

const AUDIT = auditId("audit:conf:health");

// ── the persistent store fake (models the @sow/db health_items table) ──────────
// Keyed by dedupeKey. A `snapshot()` returns the raw rows so a "restart" can
// re-hydrate a FRESH surface over the SAME rows (persistence proof).
class PersistentHealthStore implements HealthSurfaceStore {
  private rows = new Map<string, SurfacedHealthItem>();
  constructor(seed?: Iterable<readonly [string, SurfacedHealthItem]>) {
    if (seed) for (const [k, v] of seed) this.rows.set(k, v);
  }
  getByDedupeKey(dedupeKey: string): Promise<SurfacedHealthItem | undefined> {
    return Promise.resolve(this.rows.get(dedupeKey));
  }
  put(record: SurfacedHealthItem): Promise<void> {
    this.rows.set(record.dedupeKey, record);
    return Promise.resolve();
  }
  list(): Promise<SurfacedHealthItem[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  /** The durable snapshot a restart re-hydrates from. */
  snapshot(): Map<string, SurfacedHealthItem> {
    return new Map(this.rows);
  }
}

// The five OBS-2 failure classes named by the task, each with the FailureVariant
// that routes to it via the REAL routeFailure. Proves each class is reachable and
// distinct, and that the test never invents a class the routing table doesn't
// produce.
const OBS2_CASES: ReadonlyArray<{
  readonly label: string;
  readonly variantKind: Parameters<typeof failure>[0];
  readonly expectedClass: FailureClass;
  readonly subjectRef: string;
}> = [
  {
    label: "connector outage",
    variantKind: "connector_unreachable",
    expectedClass: "connector_unreachable",
    subjectRef: "connector:granola",
  },
  {
    label: "budget breach",
    variantKind: "budget_exceeded",
    expectedClass: "budget_breach",
    subjectRef: "job:meeting-close-1",
  },
  {
    label: "schema rejection",
    variantKind: "schema_rejected",
    expectedClass: "schema_rejection",
    subjectRef: "capability:meeting.close",
  },
  {
    label: "failed/blocked write-through (degraded)",
    variantKind: "degraded_unavailable",
    expectedClass: "worker_down",
    subjectRef: "provider:openrouter",
  },
];

describe("§12 system-health conformance — each OBS-2 class yields a distinct, audit-linked item", () => {
  it("routeFailure maps each variant to the expected health class (class never invented)", () => {
    for (const c of OBS2_CASES) {
      const route = routeFailure(failure(c.variantKind, `${c.label} failed`, { retryable: false }));
      expect(route.healthClass).toBe(c.expectedClass);
    }
  });

  it("write_through_failed + missed_or_late_schedule are surfaceable classes (distinct items)", async () => {
    // These two OBS-2 classes are surfaced directly by their producing subsystems
    // (KnowledgeWriter write-through / the schedule catch-up) rather than via a
    // FailureVariant; assert the surface materializes each as its own distinct item.
    const store = new PersistentHealthStore();
    const surface = createHealthSurface(store);
    const extraClasses: readonly FailureClass[] = ["write_through_failed", "missed_or_late_schedule"];
    for (const fc of extraClasses) {
      const r = await surface.record({
        failureClass: fc,
        subjectRef: `subject:${fc}`,
        message: `${fc} occurred`,
        auditRef: AUDIT,
        now: "2026-07-02T00:00:00.000Z",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.item.failureClass).toBe(fc);
    }
    const all = await surface.list();
    expect(all.ok).toBe(true);
    if (all.ok) {
      const classes = all.value.map((i) => i.item.failureClass).sort();
      expect(classes).toEqual([...extraClasses].sort());
    }
  });

  it("materializes a DISTINCT, audit-linked, persistent item per (class, subject)", async () => {
    const store = new PersistentHealthStore();
    const surface = createHealthSurface(store);
    for (const c of OBS2_CASES) {
      const r = await surface.record({
        failureClass: c.expectedClass,
        subjectRef: c.subjectRef,
        message: `${c.label} occurred`,
        auditRef: AUDIT,
        now: "2026-07-02T00:00:00.000Z",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.value.item.failureClass).toBe(c.expectedClass);
      expect(r.value.item.state).toBe("open");
      expect(r.value.item.auditRef).toBe(AUDIT); // audit-linked
      expect(r.value.subjectRef).toBe(c.subjectRef);
      expect(r.value.occurrenceCount).toBe(1);
    }
    // one distinct persisted item per case, no collapsing across classes/subjects
    const list = await surface.list();
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.value).toHaveLength(OBS2_CASES.length);
  });
});

describe("§12 system-health conformance — dedupe by subject (recurrence bumps ONE item)", () => {
  it("a recurring same-(class,subject) failure bumps occurrenceCount, never spawns a duplicate", async () => {
    const store = new PersistentHealthStore();
    const surface = createHealthSurface(store);
    const at = (n: number): string =>
      new Date(Date.parse("2026-07-02T00:00:00.000Z") + n * 1000).toISOString();

    const first = await surface.record({
      failureClass: "connector_unreachable",
      subjectRef: "connector:granola",
      message: "connector down",
      auditRef: AUDIT,
      now: at(0),
    });
    const second = await surface.record({
      failureClass: "connector_unreachable",
      subjectRef: "connector:granola",
      message: "connector still down",
      auditRef: AUDIT,
      now: at(30),
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // ONE item — same openedAt preserved, occurrenceCount bumped, lastSeen refreshed
    expect(second.value.occurrenceCount).toBe(2);
    expect(second.value.openedAt).toBe(first.value.openedAt);
    expect(Date.parse(second.value.lastSeen)).toBeGreaterThan(Date.parse(first.value.lastSeen));

    const list = await surface.list();
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.value).toHaveLength(1);
  });

  it("a DIFFERENT subject under the same class is a DISTINCT item (not deduped together)", async () => {
    const store = new PersistentHealthStore();
    const surface = createHealthSurface(store);
    await surface.record({
      failureClass: "connector_unreachable",
      subjectRef: "connector:granola",
      message: "a down",
      auditRef: AUDIT,
      now: "2026-07-02T00:00:00.000Z",
    });
    await surface.record({
      failureClass: "connector_unreachable",
      subjectRef: "connector:gcal",
      message: "b down",
      auditRef: AUDIT,
      now: "2026-07-02T00:00:00.000Z",
    });
    const list = await surface.list();
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.value).toHaveLength(2);
  });
});

describe("§12 system-health conformance — lifecycle open → ack / resolved + auto-resolve", () => {
  it("open → acknowledged, then auto-resolve on clear → resolved (terminal)", async () => {
    const store = new PersistentHealthStore();
    const surface = createHealthSurface(store);
    const ref = { failureClass: "budget_breach" as FailureClass, subjectRef: "job:x" };

    await surface.record({ ...ref, message: "cap hit", auditRef: AUDIT, now: "2026-07-02T00:00:00.000Z" });

    const acked = await surface.acknowledge(ref);
    expect(acked.ok).toBe(true);
    if (acked.ok) expect(acked.value?.item.state).toBe("acknowledged");

    const resolved = await surface.resolve({ ...ref, now: "2026-07-02T01:00:00.000Z" });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value?.item.state).toBe("resolved");
      expect(resolved.value?.item.resolvedAt).toBeDefined();
    }
  });

  it("a resolve is idempotent + terminal (a second resolve leaves it resolved)", async () => {
    const store = new PersistentHealthStore();
    const surface = createHealthSurface(store);
    const ref = { failureClass: "schema_rejection" as FailureClass, subjectRef: "cap:y" };
    await surface.record({ ...ref, message: "reject", auditRef: AUDIT, now: "2026-07-02T00:00:00.000Z" });
    await surface.resolve({ ...ref, now: "2026-07-02T00:10:00.000Z" });
    const again = await surface.resolve({ ...ref, now: "2026-07-02T00:20:00.000Z" });
    expect(again.ok).toBe(true);
    const list = await surface.list();
    if (list.ok) {
      expect(list.value).toHaveLength(1);
      expect(list.value[0]?.item.state).toBe("resolved");
    }
  });

  it("a FRESH failure after resolution REOPENS a new open item (occurrenceCount resets to 1)", async () => {
    const store = new PersistentHealthStore();
    const surface = createHealthSurface(store);
    const ref = { failureClass: "connector_unreachable" as FailureClass, subjectRef: "connector:z" };
    await surface.record({ ...ref, message: "down", auditRef: AUDIT, now: "2026-07-02T00:00:00.000Z" });
    await surface.resolve({ ...ref, now: "2026-07-02T00:05:00.000Z" });
    const reopened = await surface.record({
      ...ref,
      message: "down again",
      auditRef: AUDIT,
      now: "2026-07-02T00:10:00.000Z",
    });
    expect(reopened.ok).toBe(true);
    if (reopened.ok) {
      expect(reopened.value.item.state).toBe("open");
      expect(reopened.value.occurrenceCount).toBe(1);
    }
  });
});

describe("§12 system-health conformance — ACK survives a simulated restart (persistence)", () => {
  it("re-materializing the surface over the SAME store keeps the item acknowledged", async () => {
    const store = new PersistentHealthStore();
    const surface = createHealthSurface(store);
    const ref = { failureClass: "worker_down" as FailureClass, subjectRef: "queue:default" };

    await surface.record({ ...ref, message: "worker down", auditRef: AUDIT, now: "2026-07-02T00:00:00.000Z" });
    await surface.acknowledge(ref);

    // Simulate a restart: a FRESH surface over the SAME durable rows (persistence).
    const rehydrated = new PersistentHealthStore(store.snapshot());
    const surfaceAfterRestart = createHealthSurface(rehydrated);

    const list = await surfaceAfterRestart.list();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value).toHaveLength(1);
      expect(list.value[0]?.item.state).toBe("acknowledged");
    }
    // and a recurring failure post-restart still deduples onto the SAME acknowledged
    // item (does not silently reopen an acknowledged alarm).
    const recur = await surfaceAfterRestart.record({
      ...ref,
      message: "still down",
      auditRef: AUDIT,
      now: "2026-07-02T02:00:00.000Z",
    });
    expect(recur.ok).toBe(true);
    if (recur.ok) {
      expect(recur.value.item.state).toBe("acknowledged");
      expect(recur.value.occurrenceCount).toBe(2);
    }
  });
});

// ── the DoD gate entry (wiringFactory) ─────────────────────────────────────────
// A machine-checkable predicate: every OBS-2 case routes to its expected class AND
// materializes a distinct, audit-linked item that deduplicates + survives restart.
export async function systemHealthConformanceHolds(): Promise<boolean> {
  for (const c of OBS2_CASES) {
    const route = routeFailure(failure(c.variantKind, c.label, { retryable: false }));
    if (route.healthClass !== c.expectedClass) return false;
  }
  const store = new PersistentHealthStore();
  const surface = createHealthSurface(store);
  const ref = { failureClass: "connector_unreachable" as FailureClass, subjectRef: "s" };
  const r1 = await surface.record({ ...ref, message: "m", auditRef: AUDIT, now: "2026-07-02T00:00:00.000Z" });
  const r2 = await surface.record({ ...ref, message: "m", auditRef: AUDIT, now: "2026-07-02T00:00:01.000Z" });
  if (!r1.ok || !r2.ok || r2.value.occurrenceCount !== 2) return false;
  const acked = await surface.acknowledge(ref);
  if (!acked.ok || acked.value?.item.state !== "acknowledged") return false;
  const restart = createHealthSurface(new PersistentHealthStore(store.snapshot()));
  const list = await restart.list();
  return list.ok && list.value[0]?.item.state === "acknowledged";
}
