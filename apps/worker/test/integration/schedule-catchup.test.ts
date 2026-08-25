// @sow/worker — 25.SCHED leg 2: LIFE-2 missed-occurrence catch-up over REAL,
// RESTART-DURABLE bookkeeping.
//
// packages/workflows/src/runtime/schedule.ts + catchUpWindow.ts are the drivers'
// `deps.schedule` surface (see e.g. retentionPrune.ts, dailyBrief.ts,
// connectorSyncHealth.ts, periodReview.ts — every one reads
// `deps.schedule.getBookkeeping(scheduleId)` then feeds it through
// `collapsedNextRunFromClock`). Every driver's OWN unit suite fakes that store
// in-memory (a real Map), so none of them can catch a wiring regression where
// the store a driver is actually GIVEN at runtime is a STUB that always answers
// `undefined` — exactly the shape of the in-sandbox stub at
// temporal/workflows.ts:513-516 (`connectorSyncHealthWorkflow`'s dormant
// `schedule` seam). Under that stub EVERY tick reads as a never-run schedule:
// the "first run, no catch-up needed" branch fires every single time, so a
// burst of ticks never collapses — it just runs unconditionally, forever
// "silently false-durable" while every driver's own fake-backed unit test
// stays green.
//
// This test proves the OTHER half: fed a REAL @sow/db-backed ScheduleStore
// (composition/store-adapters.ts's `createScheduleStoreAdapter` — the SAME
// adapter `backends.ts:820` binds), a burst of 5 missed hourly occurrences
// collapses to EXACTLY ONE run — and that durability SURVIVES A RESTART (close
// the sqlite connection, reopen a FRESH repo set from the SAME on-disk file,
// the `realSourceCommit.test.ts` restart pattern). `tick()` below mirrors the
// exact read → collapse-decide → (run) → advance sequence every real driver's
// LIFE-2 leg follows (e.g. retentionPrune.ts's `runRetentionPrune` step 2/5) —
// it is NOT a reimplementation of the LIFE-2 math, only the same call sequence
// over the pure `collapsedNextRunFromClock` + `advanceBookkeeping` this package
// already ships.
//
// MUTATION-VERIFY (per the PKG-W2 brief): swapping `store2` below for the
// in-sandbox stub shape (`{ getBookkeeping: async () => undefined, put: async
// () => {} }`) and re-running reds the load-bearing assertion — every tick then
// reports `{ ranNow: true, collapsed: false }` (a first-run every time) instead
// of the real store's `{ ranNow: true, collapsed: true }`. Performed manually
// against a scratch copy during development; the red transcript is recorded in
// the PKG-W2 Step-9 report (not committed here as a second always-passing test
// — that would just re-assert the LIFE-2 math catch-up-window.test.ts already
// pins, not this leg's wiring claim).
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/composition/backends";
import { createScheduleStoreAdapter } from "../../src/composition/store-adapters";
import type { ScheduleStore, Clock } from "@sow/workflows/ports/operational";
import { advanceBookkeeping } from "@sow/workflows/runtime/clock";
import { collapsedNextRunFromClock } from "@sow/workflows/runtime/catchUpWindow";

const SCHED = "life-2-restart-probe";
const HOUR = 3_600_000;

// ── a controllable fake Clock (mirrors last-run.test.ts's fakeClock) ─────────
interface FakeClock extends Clock {
  wallMs: number;
}
function fakeClock(startWallIso: string): FakeClock {
  const c: FakeClock = {
    wallMs: Date.parse(startWallIso),
    now: () => new Date(c.wallMs).toISOString(),
    monotonicMs: () => c.wallMs,
    monotonicEpoch: () => "boot-1",
  };
  return c;
}

/**
 * ONE schedule tick — the exact read → decide → (run) → advance sequence every
 * real driver's LIFE-2 leg follows over `deps.schedule`. Returns whether THIS
 * tick actually ran, and whether it collapsed (>1) missed occurrence into it.
 */
async function tick(
  store: ScheduleStore,
  clock: Clock,
  opts: { readonly intervalMs: number; readonly catchUpWindowMs: number },
): Promise<{ readonly ranNow: boolean; readonly collapsed: boolean }> {
  const bookkeeping = await store.getBookkeeping(SCHED);
  if (bookkeeping === undefined) {
    // First-ever run: every real driver skips catch-up and just proceeds.
    await store.put(advanceBookkeeping(SCHED, clock));
    return { ranNow: true, collapsed: false };
  }
  const catchUp = collapsedNextRunFromClock(bookkeeping, clock, opts);
  if (catchUp.nextRun === null) {
    return { ranNow: false, collapsed: false }; // nothing due — no durable write
  }
  await store.put(advanceBookkeeping(SCHED, clock));
  return { ranNow: true, collapsed: catchUp.collapsed };
}

function tempDbPath(): { readonly path: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sow-schedcatchup-"));
  return {
    path: join(dir, "ops.db"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    },
  };
}

describe("LIFE-2 catch-up over a REAL sqlite ScheduleStore — restart-durable", () => {
  it("5 missed hourly occurrences collapse to EXACTLY ONE run, surviving a restart", async () => {
    const { path: dbPath, cleanup } = tempDbPath();
    const clock = fakeClock("2026-07-01T00:00:00.000Z");

    try {
      // ── worker run #1: first-ever tick seeds bookkeeping, then the worker exits ──
      const db1 = await openDatabase({ dbPath });
      const store1 = createScheduleStoreAdapter(db1.repos.scheduleBookkeeping);
      const t1 = await tick(store1, clock, { intervalMs: HOUR, catchUpWindowMs: 24 * HOUR });
      expect(t1).toEqual({ ranNow: true, collapsed: false }); // first run, nothing to catch up
      db1.conn.close(); // the worker exits — an in-memory store would vanish here

      // ── the worker is asleep for 5 missed hourly occurrences ──
      clock.wallMs += 5 * HOUR;

      // ── worker run #2 (RESTART): a FRESH repo set over the SAME on-disk file ──
      const db2 = await openDatabase({ dbPath });
      try {
        const store2 = createScheduleStoreAdapter(db2.repos.scheduleBookkeeping);

        // Durability check: the fresh store reads back run #1's bookkeeping (not "never run").
        const restarted = await store2.getBookkeeping(SCHED);
        expect(restarted?.lastRunWall).toBe("2026-07-01T00:00:00.000Z");

        const t2 = await tick(store2, clock, { intervalMs: HOUR, catchUpWindowMs: 24 * HOUR });
        // The load-bearing assertion: 5 missed occurrences collapse to ONE run — never 5.
        expect(t2).toEqual({ ranNow: true, collapsed: true });

        // ── an immediate re-tick (no time elapsed) must NOT re-fire ──
        const t3 = await tick(store2, clock, { intervalMs: HOUR, catchUpWindowMs: 24 * HOUR });
        expect(t3).toEqual({ ranNow: false, collapsed: false });

        // Total runs across the whole restart-spanning scenario: exactly 2 (the
        // first-ever run + the ONE collapsed catch-up) — never 1 (first) + 5
        // (one per missed occurrence) = 6, and never a 3rd for the immediate
        // re-tick.
      } finally {
        db2.conn.close();
      }
    } finally {
      cleanup();
    }
  });
});
