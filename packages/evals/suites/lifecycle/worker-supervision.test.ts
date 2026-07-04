// spec(§20.1 "Sleep-through-brief & resume" · LIFE-1 · §16 · OBS-2 · REQ-NF-006) — task 12.19.
//
// §20.1 acceptance suite — the WORKER-SUPERVISION + DEGRADED-mode half of
// "Sleep-through-brief & resume" (safety rule 3). It drives the REAL pure worker
// lifecycle SUTs — @sow/worker's decideRestart / supervisionBackoffMs (restart +
// bounded backoff + crash-loop → worker_down), decideLease (single-owner
// re-acquire), and the Temporal-unavailable / Keychain-locked degraded-mode
// controllers — all effect-injected, no Temporal server, no Keychain, no network.
//
// This suite asserts the §20.1 bullets; it does NOT re-score the criterion (the
// registered suite path suites/lifecycle/sleep-wake-restart.test.ts owns the
// SLEEP_THROUGH_BRIEF_RESUME runner integration).
//
// Acceptance bullets exercised (§20.1 / task 12.19):
//  (c) worker supervision: restart-on-crash with BOUNDED backoff (monotonic/capped);
//      crash-loop threshold → decideRestart returns 'worker_down' with an OBS-2
//      failureClass (surfaced, not looping); on respawn the single-instance lease is
//      re-acquired (a stale prior holder is fenced by a bumped generation).
//  (d) Temporal-unavailable and Keychain-locked are first-class DEGRADED modes
//      (block/hold/retry-with-backoff + a typed repair message) — NOT crashes.
import { describe, it, expect, vi } from "vitest";
import { isOk, auditId } from "@sow/contracts";
import type { ProviderId } from "@sow/contracts";
import type { DrainResult } from "@sow/integrations";
import type { LeaseRecord } from "@sow/workflows/ports/operational";
import type { WakeReason } from "@sow/workflows";
import {
  decideRestart,
  supervisionBackoffMs,
  DEFAULT_SUPERVISION_CONFIG,
} from "@sow/worker/lifecycle/supervision-policy";
import { decideLease } from "@sow/worker/lease/instanceLease";
import { SOW_CONTROL_PLANE_TASK_QUEUE } from "@sow/workflows/runtime/taskQueue";
import {
  createHealthSurface,
  type HealthSurfaceStore,
  type SurfacedHealthItem,
} from "@sow/worker/health/surface";
import { createTemporalUnavailabilityController } from "@sow/worker/lifecycle/degraded/temporal-unavailable";
import {
  createKeychainLockController,
  type ProviderDegradationStore,
} from "@sow/worker/lifecycle/degraded/keychain-locked";

const NOW = "2026-07-02T00:00:00.000Z";
const AUDIT = auditId("audit:sleep-resume:supervision");
const at = (msAgo: number): string => new Date(Date.parse(NOW) - msAgo).toISOString();

function makeHealthSurface(): ReturnType<typeof createHealthSurface> {
  const rows = new Map<string, SurfacedHealthItem>();
  const store: HealthSurfaceStore = {
    getByDedupeKey: (k) => Promise.resolve(rows.get(k)),
    put: (row) => {
      rows.set(row.dedupeKey, row);
      return Promise.resolve();
    },
    list: () => Promise.resolve([...rows.values()]),
  };
  return createHealthSurface(store);
}

// ── (c) supervision: restart with bounded backoff; crash-loop → worker_down ─────

describe("§20.1 sleep-through — worker RESTARTS on crash with a BOUNDED, capped backoff", () => {
  const cfg = DEFAULT_SUPERVISION_CONFIG;

  it("a lone crash restarts after the base backoff (never declares the worker down)", () => {
    const d = decideRestart({ taskQueue: "default", now: NOW, recentCrashes: [], config: cfg });
    expect(d.action).toBe("restart");
    if (d.action === "restart") {
      expect(d.restartCount).toBe(0);
      expect(d.backoffMs).toBe(cfg.baseMs);
    }
  });

  it("backoff is MONOTONIC non-decreasing in the restart count and CAPPED at maxMs (no overflow)", () => {
    let prev = -1;
    for (let count = 0; count <= 50; count++) {
      const b = supervisionBackoffMs(count, cfg);
      expect(b).toBeGreaterThanOrEqual(prev); // monotonic non-decreasing
      expect(b).toBeLessThanOrEqual(cfg.maxMs); // bounded — never blows past the cap
      expect(Number.isFinite(b)).toBe(true); // capped exponent ⇒ never Infinity
      prev = b;
    }
    // an absurd count is still clamped to the cap (not Infinity, not NaN)
    expect(supervisionBackoffMs(1_000_000, cfg)).toBe(cfg.maxMs);
  });

  it("in-window crashes escalate the bounded backoff exponentially but stay ≤ maxMs", () => {
    const two = decideRestart({
      taskQueue: "default",
      now: NOW,
      recentCrashes: [at(1_000), at(2_000)],
      config: cfg,
    });
    expect(two.action).toBe("restart");
    if (two.action === "restart") {
      expect(two.restartCount).toBe(2);
      expect(two.backoffMs).toBe(cfg.baseMs * 4); // 2^2
      expect(two.backoffMs).toBeLessThanOrEqual(cfg.maxMs);
    }
  });
});

describe("§20.1 sleep-through — a CRASH-LOOP trips the guard: worker_down (OBS-2), not an infinite respawn", () => {
  const cfg = DEFAULT_SUPERVISION_CONFIG;

  it("threshold reached → decideRestart returns 'worker_down' with an OBS-2 failureClass + typed repair message", () => {
    const crashes = Array.from({ length: cfg.crashLoopThreshold }, (_, i) => at((i + 1) * 1_000));
    const d = decideRestart({ taskQueue: "control-plane", now: NOW, recentCrashes: crashes, config: cfg });
    expect(d.action).toBe("worker_down"); // stops respawning — the guard
    if (d.action === "worker_down") {
      expect(d.failureClass).toBe("worker_down"); // OBS-2 health class, surfaced
      expect(d.subjectRef).toBe("control-plane");
      expect(d.message).toContain("crash-loop"); // a typed, human-readable repair message
    }
  });

  it("crashes OUTSIDE the rolling window roll off — a stale ledger never trips a false loop", () => {
    const stale = Array.from({ length: cfg.crashLoopThreshold }, () =>
      at(cfg.crashLoopWindowMs + 5_000),
    );
    const d = decideRestart({ taskQueue: "default", now: NOW, recentCrashes: stale, config: cfg });
    expect(d.action).toBe("restart"); // all rolled off ⇒ back to a healthy restart
  });
});

describe("§20.1 sleep-through — on respawn the SINGLE-INSTANCE lease is re-acquired (no split-brain)", () => {
  it("an EXPIRED prior holder is fenced: acquire with a BUMPED generation", async () => {
    const expired: LeaseRecord = {
      taskQueue: "default",
      ownerId: "worker-old",
      acquiredAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-07-01T00:00:30.000Z", // long past `now`
      generation: 5,
    };
    const r = await decideLease(
      {
        taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE,
        ownerId: "worker-new",
        now: NOW,
        leaseTtlMs: 30_000,
        current: expired,
      },
      { get: () => Promise.resolve(expired), compareAndSet: () => Promise.resolve(true) },
    );
    expect(isOk(r) && r.value.action).toBe("acquire");
    if (isOk(r)) expect(r.value.next?.generation).toBe(6); // fences the sleep-paused prior holder
  });

  it("ANOTHER instance's LIVE lease → passive (this respawn never writes → single owner preserved)", async () => {
    const other: LeaseRecord = {
      taskQueue: "default",
      ownerId: "worker-live",
      acquiredAt: NOW,
      expiresAt: new Date(Date.parse(NOW) + 30_000).toISOString(),
      generation: 3,
    };
    const cas = vi.fn(() => Promise.resolve(true));
    const r = await decideLease(
      {
        taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE,
        ownerId: "worker-new",
        now: NOW,
        leaseTtlMs: 30_000,
        current: other,
      },
      { get: () => Promise.resolve(other), compareAndSet: cas },
    );
    expect(isOk(r) && r.value.action).toBe("passive");
    expect(cas).not.toHaveBeenCalled(); // no risky write while another owner is live
  });
});

// ── (d) DEGRADED modes: Temporal-unavailable + Keychain-locked (not crashes) ────

describe("§20.1 sleep-through — Temporal-unavailable is a DEGRADED mode: HOLDS dispatch + retries with backoff", () => {
  it("outage HOLDS jobs (never sent to a dead Temporal, never dropped) + surfaces a repair item; reconnect drains", async () => {
    const dispatched: string[] = [];
    const surface = makeHealthSurface();
    const ctrl = createTemporalUnavailabilityController({
      surface,
      auditRef: AUDIT,
      dispatch: (jobId) => {
        dispatched.push(jobId);
        return Promise.resolve();
      },
      config: { backoff: DEFAULT_SUPERVISION_CONFIG },
    });

    // connection lost → a worker_down repair item + a BOUNDED reconnect backoff (not a crash)
    const lost = await ctrl.onConnectionLost({ now: NOW, recentFailures: [] });
    expect(isOk(lost)).toBe(true);
    if (isOk(lost)) {
      expect(lost.value.healthItem.failureClass).toBe("worker_down");
      expect(lost.value.retryInMs).toBe(DEFAULT_SUPERVISION_CONFIG.baseMs); // retry-with-backoff
    }
    expect(ctrl.isDegraded()).toBe(true);

    // dispatches during the outage are HELD, not sent to a dead server
    const d1 = await ctrl.onDispatchRequest("job-1", { now: NOW });
    const d2 = await ctrl.onDispatchRequest("job-2", { now: NOW });
    expect(isOk(d1) && d1.value.disposition).toBe("held");
    expect(isOk(d2) && d2.value.disposition).toBe("held");
    expect(dispatched).toEqual([]); // nothing lost, nothing sent

    // reconnect → auto-clear + drain the held queue through the normal path, in order
    const re = await ctrl.onReconnect({ now: "2026-07-02T00:01:00.000Z" });
    expect(isOk(re) && re.value.resumedCount).toBe(2);
    expect(dispatched).toEqual(["job-1", "job-2"]);
    expect(ctrl.isDegraded()).toBe(false);

    // idempotent: a spurious second reconnect finds an empty queue (no duplicate dispatch)
    const re2 = await ctrl.onReconnect({ now: "2026-07-02T00:02:00.000Z" });
    expect(isOk(re2) && re2.value.resumedCount).toBe(0);
    expect(dispatched).toEqual(["job-1", "job-2"]);
  });
});

describe("§20.1 sleep-through — Keychain-locked is a DEGRADED mode: HOLDS jobs RETRYABLE + resumes on unlock", () => {
  function fakeDegradationStore(): ProviderDegradationStore {
    const set = new Set<ProviderId>();
    return {
      markDegraded: (p) => {
        set.add(p);
        return Promise.resolve();
      },
      clearDegraded: (p) => {
        set.delete(p);
        return Promise.resolve();
      },
      isDegraded: (p) => Promise.resolve(set.has(p)),
    };
  }
  const provider = "openrouter" as ProviderId;
  const emptyDrain: DrainResult = { drained: 0, reused: 0, held: 0, failed: 0 };

  it("lock → provider degraded + repair item; jobs held RETRYABLE (never terminal); unlock re-attempts via §8 drain", async () => {
    const surface = makeHealthSurface();
    const degradationStore = fakeDegradationStore();
    const wakeDrain = vi.fn((_e: { reason: WakeReason; now: string }) => Promise.resolve(emptyDrain));
    const ctrl = createKeychainLockController({ surface, degradationStore, auditRef: AUDIT, wakeDrain });

    const locked = await ctrl.onKeychainLocked({ subjectRef: provider, now: NOW });
    expect(isOk(locked)).toBe(true);
    if (isOk(locked)) {
      expect(locked.value.healthItem.failureClass).toBe("worker_down"); // surfaced repair item
      expect(locked.value.degradedProvider).toBe(provider);
    }
    expect(await degradationStore.isDegraded(provider)).toBe(true);

    // a dependent job is HELD RETRYABLE — never failed_terminal (no work lost while asleep)
    const held = await ctrl.holdJob("job-1", { subjectRef: provider });
    expect(isOk(held) && held.value.disposition).toBe("held_retryable");
    expect(isOk(held) && held.value.retryable).toBe(true);
    expect(ctrl.heldJobs()).toEqual(["job-1"]);

    // unlock (LIFE-6 wake) → re-attempt via the idempotent §8 outbox drain; clear degraded
    const unlocked = await ctrl.onUnlock({ reason: "power_resume", now: "2026-07-02T01:00:00.000Z" });
    expect(isOk(unlocked)).toBe(true);
    if (isOk(unlocked)) expect(unlocked.value.releasedCount).toBe(1);
    expect(wakeDrain).toHaveBeenCalledTimes(1); // the §8 drain ran exactly once
    expect(await degradationStore.isDegraded(provider)).toBe(false); // cleared
    expect(ctrl.heldJobs()).toEqual([]); // released
  });
});
