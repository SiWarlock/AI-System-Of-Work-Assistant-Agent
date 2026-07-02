// 10.4 — the PURE worker-supervision policy (restart + bounded backoff +
// crash-loop → worker-down). LIFE-1 / §16 supervision.
//
// This module is the deterministic core of worker supervision: given the recent
// crash history (a ledger of restart timestamps) + an injected wall-clock reading
// + config, it decides whether the supervisor should RESTART the worker (with a
// bounded, deterministic backoff) or declare WORKER_DOWN (a crash-loop tripped the
// guard, so respawning forever would burn the machine — we stop and surface it).
//
// It imports NEITHER @temporalio NOR node:crypto, calls NO Date.now()/Math.random()
// (the "now" is passed in) and performs NO I/O — so it is Vitest-unit-testable with
// no real spawn and safe to reason about deterministically. It never throws (§16):
// the decision is a closed, enumerable discriminated union.
//
// DEFERRED (Phase 9, desktop track): the Electron-main SUPERVISOR that actually
// spawns/kills the worker child process, feeds this policy its crash ledger, and
// sleeps `backoffMs` before respawn is NOT built here — apps/desktop is unscaffolded.
// This pure decision is the testable heart; the spawn placement mirrors the Phase-3
// session-auth deferment. See the wiringFactory note in the session recap.

import type { FailureClass } from "@sow/contracts";

/**
 * Supervision tuning. All bounds are explicit + config-driven so the backoff curve
 * and crash-loop guard are deterministic and testable (no magic constants buried in
 * the decision). `baseMs`/`maxMs` shape the exponential backoff; a crash-loop is
 * `crashLoopThreshold` restarts within `crashLoopWindowMs`.
 */
export interface SupervisionConfig {
  /** Backoff for restart #0 (doubles each subsequent restart). */
  readonly baseMs: number;
  /** Hard cap on the backoff — the curve never exceeds this (bounded). */
  readonly maxMs: number;
  /** N restarts within the window trips the crash-loop guard → worker_down. */
  readonly crashLoopThreshold: number;
  /** The rolling window (ms) over which restarts count toward the crash-loop. */
  readonly crashLoopWindowMs: number;
}

/**
 * A sane default profile (bounded, positive). 500ms base doubling to a 60s cap; a
 * crash-loop is 5 restarts within 60s — enough to ride out a transient dependency
 * blip while stopping a genuine boot-crash loop fast.
 */
export const DEFAULT_SUPERVISION_CONFIG: SupervisionConfig = {
  baseMs: 500,
  maxMs: 60_000,
  crashLoopThreshold: 5,
  crashLoopWindowMs: 60_000,
};

/** Inputs to a supervision decision (clock injected via `now`; no Date.now()). */
export interface SupervisionInput {
  /** The task queue whose worker is being supervised (the health subjectRef). */
  readonly taskQueue: string;
  /** The injected wall-clock reading (ISO-8601) — NEVER Date.now(). */
  readonly now: string;
  /**
   * Recent crash timestamps (ISO-8601). Order-independent — the policy windows
   * them against `now`; a crash at/older than `now - crashLoopWindowMs` rolls off.
   */
  readonly recentCrashes: readonly string[];
  readonly config: SupervisionConfig;
}

/**
 * The supervision decision — a closed, enumerable discriminated union (§16). Either
 * RESTART the worker after `backoffMs`, or declare WORKER_DOWN because the crash-loop
 * guard tripped (the infinite-respawn stop). The worker_down branch carries exactly
 * what the health surface needs to materialize an OBS-2 item.
 */
export type SupervisionDecision =
  | {
      readonly action: "restart";
      /** Bounded, deterministic backoff before respawn. */
      readonly backoffMs: number;
      /** In-window restart count that produced this backoff (0-based curve index). */
      readonly restartCount: number;
    }
  | {
      readonly action: "worker_down";
      /** OBS-2 System-Health class to surface (crash-loop → worker_down). */
      readonly failureClass: FailureClass;
      /** The health subjectRef (the task queue). */
      readonly subjectRef: string;
      readonly message: string;
    };

/**
 * Bounded, deterministic exponential backoff for the given (0-based) restart count.
 * PURE: `base * 2^count`, clamped to `[0-index, maxMs]`, with the EXPONENT capped
 * before Math.pow so a huge count can never overflow to Infinity. Monotonic
 * non-decreasing in `count`; identical `count` ⇒ identical delay (no random/clock).
 */
export function supervisionBackoffMs(count: number, config: SupervisionConfig): number {
  const n = count < 0 ? 0 : Math.floor(count);
  // Cap the exponent first: base * 2^cappedExp stays finite; then cap the product.
  // 2^40 * baseMs already dwarfs any realistic maxMs, so 40 is a safe exponent lid.
  const cappedExp = Math.min(n, 40);
  const raw = config.baseMs * Math.pow(2, cappedExp);
  return Math.min(raw, config.maxMs);
}

/**
 * Decide whether to RESTART (bounded backoff) or declare WORKER_DOWN (crash-loop).
 * PURE + clock-injected; never throws (§16).
 *
 * Rules:
 *   • Count the crashes strictly INSIDE the rolling window (`crashLoopWindowMs`):
 *     a crash timestamp `t` counts IFF `now - t < window` — a crash exactly at (or
 *     older than) the window edge rolls off. Malformed timestamps are ignored
 *     (fail-safe: an unparseable entry never inflates the count into a false loop).
 *   • `in-window count >= crashLoopThreshold` → WORKER_DOWN (stop respawning; the
 *     infinite-respawn guard). The health surface materializes a worker_down item.
 *   • otherwise → RESTART with `supervisionBackoffMs(in-window count, config)` — the
 *     count is the 0-based curve index, so the first restart (0 prior in-window
 *     crashes) waits `baseMs`.
 */
export function decideRestart(input: SupervisionInput): SupervisionDecision {
  const { taskQueue, now, recentCrashes, config } = input;
  const nowMs = Date.parse(now);
  const windowStart = nowMs - config.crashLoopWindowMs;

  // In-window crash count. `t` counts IFF windowStart < t <= now (strictly newer
  // than the window edge). Unparseable timestamps are skipped (fail-safe).
  let inWindow = 0;
  for (const iso of recentCrashes) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    if (t > windowStart && t <= nowMs) inWindow += 1;
  }

  if (inWindow >= config.crashLoopThreshold) {
    return {
      action: "worker_down",
      failureClass: "worker_down",
      subjectRef: taskQueue,
      message: `worker supervision: crash-loop on ${taskQueue} — ${inWindow} restarts within ${config.crashLoopWindowMs}ms (threshold ${config.crashLoopThreshold}); declining to respawn`,
    };
  }

  return {
    action: "restart",
    backoffMs: supervisionBackoffMs(inWindow, config),
    restartCount: inWindow,
  };
}
