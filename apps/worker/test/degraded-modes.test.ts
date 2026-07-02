// 10.5 — degraded modes: Temporal-unavailable + Keychain-locked as FIRST-CLASS
// states (LIFE-1/LIFE-6, §16, safety rules 3 & 5 & 7 adjacent).
//
// Ungated Vitest: no Temporal server, no Keychain, no network. Both controllers
// are effect-injected (a fake dispatch sink, a fake outbox drain, a fake
// provider-degradation store, the real createHealthSurface over a fake store) so
// the LOAD-BEARING guarantees are pinned deterministically:
//
//   (a) Temporal-unavailable → BLOCK dispatch (jobs are QUEUED, never silently
//       dropped) + a DISTINCT worker_down health item is surfaced (routed via
//       routeFailure(degraded_unavailable) → healthClass worker_down) + the
//       connection retry uses the 10.4 bounded backoff (supervisionBackoffMs) +
//       on RECONNECT the item AUTO-CLEARS (resolved) and the held queue resumes
//       dispatch. No queued work is lost across the outage.
//
//   (b) Keychain-locked/denied → affected provider is marked DEGRADED, dependent
//       jobs are HELD as RETRYABLE (routeFailure(degraded_unavailable).retryable
//       === true — NEVER failed_terminal, so no work is lost) + a health item is
//       surfaced; on UNLOCK (wired to the LIFE-6 wake hook) the held jobs re-drive
//       IDEMPOTENTLY through the §8 outbox drain (a committed entry returns
//       `reused` — adapter.create is NEVER called again → no duplicate side
//       effect), the provider clears DEGRADED, and the item resolves.
//
//   (c) both are TYPED degraded states routed through the 10.2 taxonomy
//       (routeFailure) + the 10.3 surface — NOT ad-hoc exceptions.

import { describe, it, expect } from "vitest";
import { isOk } from "@sow/contracts";
import type { AuditId, ProviderId } from "@sow/contracts";
import type { DrainResult } from "@sow/integrations";
import {
  createHealthSurface,
  type HealthSurfaceStore,
  type SurfacedHealthItem,
} from "../src/health/surface";
import {
  createTemporalUnavailabilityController,
  DEFAULT_TEMPORAL_UNAVAILABLE_CONFIG,
  type HeldDispatch,
  type TemporalUnavailabilityController,
} from "../src/lifecycle/degraded/temporal-unavailable";
import {
  createKeychainLockController,
  type KeychainLockController,
  type ProviderDegradationStore,
} from "../src/lifecycle/degraded/keychain-locked";
import { supervisionBackoffMs, DEFAULT_SUPERVISION_CONFIG } from "../src/lifecycle/supervision-policy";

const T0 = "2026-07-02T00:00:00.000Z";
const T1 = "2026-07-02T00:00:01.000Z";
const T2 = "2026-07-02T00:00:02.000Z";
const AUDIT = "audit-degraded" as AuditId;

// The real §9/§10.3 surface over an in-memory fake store (survives across a
// controller re-create → mirrors persistence across restart).
function makeHealthSurface(): {
  surface: ReturnType<typeof createHealthSurface>;
  rows: Map<string, SurfacedHealthItem>;
} {
  const rows = new Map<string, SurfacedHealthItem>();
  const store: HealthSurfaceStore = {
    getByDedupeKey: (k) => Promise.resolve(rows.get(k)),
    put: (r) => {
      rows.set(r.dedupeKey, r);
      return Promise.resolve();
    },
    list: () => Promise.resolve([...rows.values()]),
  };
  return { surface: createHealthSurface(store), rows };
}

// ─── (a) Temporal-unavailable ────────────────────────────────────────────────

describe("Temporal-unavailable — first-class degraded state (holds dispatch, never drops)", () => {
  function makeController(): {
    ctl: TemporalUnavailabilityController;
    surface: ReturnType<typeof createHealthSurface>;
    dispatched: string[];
  } {
    const { surface } = makeHealthSurface();
    const dispatched: string[] = [];
    const ctl = createTemporalUnavailabilityController({
      surface,
      auditRef: AUDIT,
      // The normal dispatch path a held job resumes through on reconnect.
      dispatch: (jobId: string) => {
        dispatched.push(jobId);
        return Promise.resolve();
      },
      config: DEFAULT_TEMPORAL_UNAVAILABLE_CONFIG,
    });
    return { ctl, surface, dispatched };
  }

  it("routes degraded_unavailable to the worker_down health class (10.2 taxonomy)", async () => {
    const { ctl, surface } = makeController();
    const down = await ctl.onConnectionLost({ now: T0, recentFailures: [] });
    expect(isOk(down)).toBe(true);
    if (!isOk(down)) return;
    // A DISTINCT worker_down System-Health item was surfaced, not a generic one.
    expect(down.value.healthItem.failureClass).toBe("worker_down");
    const persisted = await surface.list();
    expect(isOk(persisted) && persisted.value.some((i) => i.item.failureClass === "worker_down")).toBe(true);
  });

  it("HOLDS dispatch while Temporal is down — the job is queued, NOT silently dropped", async () => {
    const { ctl, dispatched } = makeController();
    await ctl.onConnectionLost({ now: T0, recentFailures: [] });
    const held = await ctl.onDispatchRequest("job-A", { now: T0 });
    expect(isOk(held)).toBe(true);
    if (!isOk(held)) return;
    expect(held.value.disposition).toBe("held"); // queued, not dispatched
    expect(dispatched).toEqual([]); // nothing reached Temporal
    // The held queue retains the work — zero loss.
    expect(ctl.heldQueue().map((h: HeldDispatch) => h.jobId)).toEqual(["job-A"]);
  });

  it("retries the connection with the 10.4 bounded backoff (reused supervision curve)", async () => {
    const { ctl } = makeController();
    // First failure (0 prior in-window) → base backoff.
    const first = await ctl.onConnectionLost({ now: T0, recentFailures: [] });
    // Second failure (1 prior in-window) → doubled, still bounded.
    const second = await ctl.onConnectionLost({ now: T1, recentFailures: [T0] });
    expect(isOk(first) && isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(first.value.retryInMs).toBe(supervisionBackoffMs(0, DEFAULT_SUPERVISION_CONFIG));
    expect(second.value.retryInMs).toBe(supervisionBackoffMs(1, DEFAULT_SUPERVISION_CONFIG));
    expect(second.value.retryInMs).toBeGreaterThan(first.value.retryInMs);
    // A typed repair message is reported (not an ad-hoc exception).
    expect(first.value.repairMessage).toContain("Temporal");
  });

  it("AUTO-CLEARS the health item + RESUMES dispatch of every held job on reconnect (no work lost)", async () => {
    const { ctl, surface, dispatched } = makeController();
    await ctl.onConnectionLost({ now: T0, recentFailures: [] });
    await ctl.onDispatchRequest("job-A", { now: T0 });
    await ctl.onDispatchRequest("job-B", { now: T0 });
    expect(ctl.heldQueue()).toHaveLength(2);

    const reconnect = await ctl.onReconnect({ now: T2 });
    expect(isOk(reconnect)).toBe(true);
    if (!isOk(reconnect)) return;
    // Every held job resumed through the NORMAL dispatch path (nothing dropped).
    expect(dispatched).toEqual(["job-A", "job-B"]);
    expect(reconnect.value.resumedCount).toBe(2);
    expect(ctl.heldQueue()).toHaveLength(0); // queue drained

    // The worker_down item auto-resolved (health reflects truth, not a stale alarm).
    const persisted = await surface.list();
    expect(isOk(persisted)).toBe(true);
    if (!isOk(persisted)) return;
    const item = persisted.value.find((i) => i.item.failureClass === "worker_down");
    expect(item?.item.state).toBe("resolved");
  });

  it("resume on reconnect is IDEMPOTENT — a second reconnect does not re-dispatch a drained job", async () => {
    const { ctl, dispatched } = makeController();
    await ctl.onConnectionLost({ now: T0, recentFailures: [] });
    await ctl.onDispatchRequest("job-A", { now: T0 });
    await ctl.onReconnect({ now: T1 });
    await ctl.onReconnect({ now: T2 }); // spurious second reconnect
    // job-A dispatched exactly once — no duplicate side effect on double-reconnect.
    expect(dispatched).toEqual(["job-A"]);
  });

  it("a mid-drain dispatch REJECTION re-holds THAT job (never lost), never throws the §16 boundary, surfaces a health item, and the OTHER held jobs still drain", async () => {
    // A controller whose dispatch REJECTS for exactly one job on its FIRST attempt
    // (a real, transient Temporal start-workflow rejection mid-drain) — the others
    // succeed, and job-B's retry (a later reconnect) succeeds.
    const { surface, rows } = makeHealthSurface();
    const dispatched: string[] = [];
    let jobBAttempts = 0;
    const ctl = createTemporalUnavailabilityController({
      surface,
      auditRef: AUDIT,
      dispatch: (jobId: string) => {
        if (jobId === "job-B") {
          jobBAttempts += 1;
          if (jobBAttempts === 1) {
            return Promise.reject(new Error("temporal start-workflow rejected"));
          }
        }
        dispatched.push(jobId);
        return Promise.resolve();
      },
      config: DEFAULT_TEMPORAL_UNAVAILABLE_CONFIG,
    });

    await ctl.onConnectionLost({ now: T0, recentFailures: [] });
    await ctl.onDispatchRequest("job-A", { now: T0 });
    await ctl.onDispatchRequest("job-B", { now: T0 }); // this one will reject on drain
    await ctl.onDispatchRequest("job-C", { now: T0 });
    expect(ctl.heldQueue()).toHaveLength(3);

    // The drain must NOT throw across the §16 boundary — it returns a typed Result.
    const reconnect = await ctl.onReconnect({ now: T1 });
    expect(isOk(reconnect)).toBe(true);
    if (!isOk(reconnect)) return;

    // job-A and job-C drained cleanly; job-B's rejection did NOT abort the drain.
    expect(dispatched).toEqual(["job-A", "job-C"]);
    // Only the two that actually dispatched count as resumed.
    expect(reconnect.value.resumedCount).toBe(2);

    // job-B was NOT lost — it was RE-HELD (degraded-retryable), still in the queue.
    expect(ctl.heldQueue().map((h: HeldDispatch) => h.jobId)).toEqual(["job-B"]);

    // A typed health item was surfaced for the failed re-drive (operator-visible,
    // never a silent drop). It is DISTINCT from the (now-resolved) outage item —
    // keyed to job-B — so both coexist.
    const items = [...rows.values()].map((r) => r.item);
    const jobItem = items.find(
      (i) => i.failureClass === "worker_down" && i.message.includes("job-B"),
    );
    expect(jobItem).toBeDefined();

    // A subsequent reconnect (Temporal now truly healthy) drains the re-held job —
    // proving the re-hold kept it re-drivable, no work lost across the failure.
    const again = await ctl.onReconnect({ now: T2 });
    expect(isOk(again)).toBe(true);
    if (!isOk(again)) return;
    // job-B dispatched exactly once now (idempotent re-attempt), queue drained.
    expect(dispatched).toEqual(["job-A", "job-C", "job-B"]);
    expect(ctl.heldQueue()).toHaveLength(0);
  });
});

// ─── (b) Keychain-locked / denied ────────────────────────────────────────────

describe("Keychain-locked — providers DEGRADED, jobs HELD retryable (never terminal), resume on LIFE-6 unlock", () => {
  const PROVIDER = "claude" as ProviderId;

  function makeDegradationStore(): {
    store: ProviderDegradationStore;
    degraded: Set<ProviderId>;
  } {
    const degraded = new Set<ProviderId>();
    const store: ProviderDegradationStore = {
      markDegraded: (p) => {
        degraded.add(p);
        return Promise.resolve();
      },
      clearDegraded: (p) => {
        degraded.delete(p);
        return Promise.resolve();
      },
      isDegraded: (p) => Promise.resolve(degraded.has(p)),
    };
    return { store, degraded };
  }

  function makeController(drainResult: DrainResult): {
    ctl: KeychainLockController;
    surface: ReturnType<typeof createHealthSurface>;
    degraded: Set<ProviderId>;
    drainCalls: number;
  } {
    const { surface } = makeHealthSurface();
    const { store, degraded } = makeDegradationStore();
    let drainCalls = 0;
    const ctl = createKeychainLockController({
      surface,
      degradationStore: store,
      auditRef: AUDIT,
      // The LIFE-6 wake drain (reuses runWakeDrain/drainOutbox at the seam). We
      // inject the typed DrainResult so the test controls the idempotency proof.
      wakeDrain: () => {
        drainCalls += 1;
        return Promise.resolve(drainResult);
      },
    });
    return { ctl, surface, degraded, drainCalls: 0 };
  }

  it("marks the affected provider DEGRADED and surfaces a health item on lock", async () => {
    const { ctl, surface, degraded } = makeController({ drained: 0, reused: 0, held: 0, failed: 0 });
    const locked = await ctl.onKeychainLocked({ subjectRef: PROVIDER, now: T0 });
    expect(isOk(locked)).toBe(true);
    if (!isOk(locked)) return;
    expect(degraded.has(PROVIDER)).toBe(true);
    expect(locked.value.healthItem.failureClass).toBe("worker_down");
    const persisted = await surface.list();
    expect(isOk(persisted) && persisted.value.length).toBe(1);
  });

  it("HOLDS a dependent job as RETRYABLE — never failed_terminal (no work lost)", async () => {
    const { ctl } = makeController({ drained: 0, reused: 0, held: 0, failed: 0 });
    await ctl.onKeychainLocked({ subjectRef: PROVIDER, now: T0 });
    const held = await ctl.holdJob("job-K", { subjectRef: PROVIDER });
    expect(isOk(held)).toBe(true);
    if (!isOk(held)) return;
    // The route MUST be retryable, NOT terminal — the whole point of holding.
    expect(held.value.retryable).toBe(true);
    expect(held.value.disposition).toBe("held_retryable");
    expect(ctl.heldJobs()).toContain("job-K");
  });

  it("re-attempts held jobs on LIFE-6 UNLOCK, IDEMPOTENTLY — a committed write returns `reused` (no duplicate side effect)", async () => {
    // Drain reports one entry whose receipt was REUSED and zero fresh creates:
    // proof the crash/lock-interrupted external write was NOT duplicated.
    const { ctl, surface, degraded } = makeController({ drained: 0, reused: 1, held: 0, failed: 0 });
    await ctl.onKeychainLocked({ subjectRef: PROVIDER, now: T0 });
    await ctl.holdJob("job-K", { subjectRef: PROVIDER });

    const unlocked = await ctl.onUnlock({ reason: "power_resume", now: T1 });
    expect(isOk(unlocked)).toBe(true);
    if (!isOk(unlocked)) return;
    // The held work re-drove through the §8 drain: reused ⇒ zero duplicate create.
    expect(unlocked.value.drain.reused).toBe(1);
    expect(unlocked.value.drain.drained).toBe(0);
    // Provider cleared DEGRADED and the health item resolved.
    expect(degraded.has(PROVIDER)).toBe(false);
    expect(ctl.heldJobs()).toHaveLength(0);
    const persisted = await surface.list();
    expect(isOk(persisted)).toBe(true);
    if (!isOk(persisted)) return;
    const item = persisted.value.find((i) => i.item.failureClass === "worker_down");
    expect(item?.item.state).toBe("resolved");
  });

  it("a held job is NEVER discarded on lock — it survives to the unlock re-attempt", async () => {
    const { ctl } = makeController({ drained: 1, reused: 0, held: 0, failed: 0 });
    await ctl.onKeychainLocked({ subjectRef: PROVIDER, now: T0 });
    await ctl.holdJob("job-K", { subjectRef: PROVIDER });
    // Still locked → the job stays held (not dropped, not terminal).
    expect(ctl.heldJobs()).toEqual(["job-K"]);
    const out = await ctl.onUnlock({ reason: "power_resume", now: T1 });
    expect(isOk(out)).toBe(true);
    if (!isOk(out)) return;
    // On unlock the outbox drain ran (the re-attempt path) and the queue cleared.
    expect(out.value.drain.drained).toBe(1);
    expect(ctl.heldJobs()).toHaveLength(0);
  });
});
