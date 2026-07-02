// 10.4a — the PURE worker-supervision policy (restart + bounded backoff +
// crash-loop → worker-down). LIFE-1 / §16 supervision.
//
// Ungated Vitest: no real spawn, no timers, no Temporal server. The policy is a
// pure state machine over a crash LEDGER (the recent restart timestamps) + a
// config — deterministic, clock-injected, and NEVER throwing across the boundary
// (§16). Its two load-bearing guarantees, both pinned here:
//   • backoff is BOUNDED (never exceeds maxMs) and DETERMINISTIC (identical
//     restart count ⇒ identical delay; no Math.random / Date.now).
//   • a CRASH-LOOP (≥ threshold restarts within the window) returns a WORKER_DOWN
//     decision instead of respawning forever — the infinite-respawn guard.

import { describe, it, expect } from "vitest";
import {
  decideRestart,
  supervisionBackoffMs,
  DEFAULT_SUPERVISION_CONFIG,
  type SupervisionConfig,
  type SupervisionInput,
} from "../src/lifecycle/supervision-policy";

const TQ = "sow-control-plane";

const cfg = (partial: Partial<SupervisionConfig> = {}): SupervisionConfig => ({
  baseMs: 500,
  maxMs: 60_000,
  crashLoopThreshold: 5,
  crashLoopWindowMs: 60_000,
  ...partial,
});

// A restart ledger of ISO timestamps, most-recent-first is NOT required — the
// policy windows by parsing them against `now`.
const at = (offsetMs: number, base = Date.parse("2026-07-02T00:01:00.000Z")): string =>
  new Date(base + offsetMs).toISOString();

const input = (partial: Partial<SupervisionInput> = {}): SupervisionInput => ({
  taskQueue: TQ,
  now: "2026-07-02T00:01:00.000Z",
  recentCrashes: [],
  config: cfg(),
  ...partial,
});

describe("supervisionBackoffMs — bounded + deterministic exponential backoff", () => {
  it("is deterministic: identical restart count → identical delay (no random/clock)", () => {
    const c = cfg();
    for (const n of [0, 1, 2, 3, 7]) {
      expect(supervisionBackoffMs(n, c)).toBe(supervisionBackoffMs(n, c));
    }
  });

  it("grows exponentially off baseMs (doubling per restart) below the cap", () => {
    const c = cfg({ baseMs: 500, maxMs: 60_000 });
    expect(supervisionBackoffMs(0, c)).toBe(500); // base * 2^0
    expect(supervisionBackoffMs(1, c)).toBe(1_000); // base * 2^1
    expect(supervisionBackoffMs(2, c)).toBe(2_000);
    expect(supervisionBackoffMs(3, c)).toBe(4_000);
  });

  it("is BOUNDED — never exceeds maxMs no matter how large the restart count", () => {
    const c = cfg({ baseMs: 500, maxMs: 60_000 });
    for (const n of [10, 20, 100, 1_000, 1_000_000]) {
      const d = supervisionBackoffMs(n, c);
      expect(d).toBeLessThanOrEqual(c.maxMs);
      expect(Number.isFinite(d)).toBe(true); // no overflow to Infinity
    }
    expect(supervisionBackoffMs(1_000_000, c)).toBe(60_000);
  });

  it("is monotonic non-decreasing in the restart count", () => {
    const c = cfg();
    let prev = -1;
    for (let n = 0; n <= 30; n++) {
      const d = supervisionBackoffMs(n, c);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it("clamps a negative restart count to 0 (defensive)", () => {
    const c = cfg();
    expect(supervisionBackoffMs(-5, c)).toBe(supervisionBackoffMs(0, c));
  });
});

describe("decideRestart — restart under threshold, worker-down at crash-loop", () => {
  it("no recent crashes → restart with the base backoff", () => {
    const d = decideRestart(input({ recentCrashes: [] }));
    expect(d.action).toBe("restart");
    if (d.action !== "restart") return;
    // 0 crashes in-window ⇒ backoff for restart #0 = base.
    expect(d.backoffMs).toBe(500);
    expect(d.restartCount).toBe(0);
  });

  it("a few crashes within the window → restart with escalating (bounded) backoff", () => {
    // 3 crashes inside the 60s window (threshold is 5) → still restart.
    const crashes = [at(-30_000), at(-20_000), at(-10_000)];
    const d = decideRestart(input({ recentCrashes: crashes }));
    expect(d.action).toBe("restart");
    if (d.action !== "restart") return;
    expect(d.restartCount).toBe(3);
    expect(d.backoffMs).toBe(supervisionBackoffMs(3, cfg()));
    expect(d.backoffMs).toBeLessThanOrEqual(cfg().maxMs);
  });

  it("CRASH-LOOP: ≥ threshold crashes within the window → worker_down, NOT another restart", () => {
    // 5 crashes inside the 60s window == threshold → the infinite-respawn guard
    // trips: the policy declines to respawn and surfaces a worker_down decision.
    const crashes = [at(-50_000), at(-40_000), at(-30_000), at(-20_000), at(-10_000)];
    const d = decideRestart(input({ recentCrashes: crashes }));
    expect(d.action).toBe("worker_down");
    if (d.action !== "worker_down") return;
    expect(d.failureClass).toBe("worker_down");
    expect(d.subjectRef).toBe(TQ);
    expect(d.message.length).toBeGreaterThan(0);
  });

  it("crashes OUTSIDE the window do not count toward the crash-loop (window rolls)", () => {
    // 5 crashes but 4 are older than the 60s window (only 1 is recent) → restart,
    // counting only the in-window crash.
    const crashes = [
      at(-120_000),
      at(-110_000),
      at(-100_000),
      at(-90_000), // all older than 60s window
      at(-5_000), // the only in-window crash
    ];
    const d = decideRestart(input({ recentCrashes: crashes }));
    expect(d.action).toBe("restart");
    if (d.action !== "restart") return;
    expect(d.restartCount).toBe(1);
  });

  it("the window boundary is inclusive-of-now, exclusive-of-stale (a crash exactly at the window edge is stale)", () => {
    // A crash exactly windowMs ago is at/over the fence → NOT counted (rolls off).
    const crashes = [at(-60_000), at(-59_999)];
    const d = decideRestart(input({ recentCrashes: crashes }));
    expect(d.action).toBe("restart");
    if (d.action !== "restart") return;
    // only the -59_999ms crash is inside the window
    expect(d.restartCount).toBe(1);
  });

  it("respects a custom threshold/window from config", () => {
    const c = cfg({ crashLoopThreshold: 2, crashLoopWindowMs: 10_000 });
    const crashes = [at(-5_000), at(-3_000)]; // 2 in a 10s window == threshold
    const d = decideRestart(input({ recentCrashes: crashes, config: c }));
    expect(d.action).toBe("worker_down");
  });

  it("exposes a sane DEFAULT_SUPERVISION_CONFIG (bounded, positive)", () => {
    expect(DEFAULT_SUPERVISION_CONFIG.baseMs).toBeGreaterThan(0);
    expect(DEFAULT_SUPERVISION_CONFIG.maxMs).toBeGreaterThanOrEqual(
      DEFAULT_SUPERVISION_CONFIG.baseMs,
    );
    expect(DEFAULT_SUPERVISION_CONFIG.crashLoopThreshold).toBeGreaterThan(0);
    expect(DEFAULT_SUPERVISION_CONFIG.crashLoopWindowMs).toBeGreaterThan(0);
  });
});
