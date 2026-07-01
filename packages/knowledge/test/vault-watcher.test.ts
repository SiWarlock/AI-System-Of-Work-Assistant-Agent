// spec(§6) — per-vault fs-watcher (task 4.6): debounces multi-file sync bursts so
// a single logical external sync (Obsidian Sync / iCloud / git pull) resolves to
// ONE revision recompute (not per-file churn), and enforces the LIFE-6 wake/restart
// ordering — pending KnowledgeWriter writes are applied BEFORE queued GBrain index
// jobs are drained, and the index drain re-derives current Markdown by revision id
// (no stale-revision indexing).
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import {
  coalesceBurst,
  createVaultWatcher,
  runWakeReconcile,
  type FsEvent,
  type FsEventBatch,
  type WatchTimer,
  type WakeReconcileDeps,
} from "../src/fs-watch/vault-watcher";
import type { RevisionId } from "../src/knowledge-writer/revision";
import { ok, err } from "@sow/contracts";

// ── debounce coalescing (pure) ───────────────────────────────────────────────

describe("coalesceBurst — one logical sync → one recompute", () => {
  it("collapses a rapid multi-file burst (within the window) into ONE batch", () => {
    const events: FsEvent[] = [
      { path: "a.md", kind: "change", at: 0 },
      { path: "b.md", kind: "change", at: 20 },
      { path: "c.md", kind: "add", at: 40 },
      { path: "d.md", kind: "change", at: 60 },
    ];
    const batches = coalesceBurst(events, 200);
    expect(batches).toHaveLength(1);
    expect([...(batches[0]?.paths ?? [])].sort()).toEqual(["a.md", "b.md", "c.md", "d.md"]);
  });

  it("splits events separated by more than the window into distinct batches", () => {
    const events: FsEvent[] = [
      { path: "a.md", kind: "change", at: 0 },
      { path: "b.md", kind: "change", at: 50 },
      { path: "z.md", kind: "change", at: 5000 }, // a later, unrelated edit
    ];
    const batches = coalesceBurst(events, 200);
    expect(batches).toHaveLength(2);
    expect(batches[0]?.paths).toEqual(["a.md", "b.md"]);
    expect(batches[1]?.paths).toEqual(["z.md"]);
  });

  it("de-duplicates repeated paths within a burst", () => {
    const events: FsEvent[] = [
      { path: "a.md", kind: "add", at: 0 },
      { path: "a.md", kind: "change", at: 10 },
    ];
    const batches = coalesceBurst(events, 200);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.paths).toEqual(["a.md"]);
  });
});

// ── stateful trailing-edge debouncer ─────────────────────────────────────────

/** A manual timer double: captures the scheduled fn so the test fires it. */
function manualTimer(): WatchTimer & { fire(): void; pendingCount(): number } {
  let scheduled: (() => void) | null = null;
  let token = 0;
  return {
    set(fn) {
      scheduled = fn;
      return ++token;
    },
    clear() {
      scheduled = null;
    },
    fire() {
      const fn = scheduled;
      scheduled = null;
      fn?.();
    },
    pendingCount() {
      return scheduled === null ? 0 : 1;
    },
  };
}

describe("createVaultWatcher — trailing debounce", () => {
  it("fires onSettled ONCE for a burst of notifications, carrying every path", () => {
    const timer = manualTimer();
    let clock = 0;
    const settled: FsEventBatch[] = [];
    const watcher = createVaultWatcher({
      windowMs: 200,
      timer,
      clock: () => clock,
      onSettled: (b) => settled.push(b),
    });

    clock = 0;
    watcher.notify({ path: "a.md", kind: "change" });
    clock = 20;
    watcher.notify({ path: "b.md", kind: "change" });
    clock = 40;
    watcher.notify({ path: "c.md", kind: "add" });

    // Every notify reset the timer; nothing has settled yet.
    expect(settled).toHaveLength(0);
    expect(timer.pendingCount()).toBe(1);

    timer.fire(); // window elapses after the last notify

    expect(settled).toHaveLength(1);
    expect([...(settled[0]?.paths ?? [])].sort()).toEqual(["a.md", "b.md", "c.md"]);
    // Buffer is cleared: a fresh notify starts a new, independent batch.
    watcher.notify({ path: "d.md", kind: "change" });
    timer.fire();
    expect(settled).toHaveLength(2);
    expect(settled[1]?.paths).toEqual(["d.md"]);
  });
});

// ── LIFE-6 wake/restart ordering ─────────────────────────────────────────────

describe("runWakeReconcile — LIFE-6 ordering", () => {
  function orderingDeps(order: string[], overrides: Partial<WakeReconcileDeps> = {}): WakeReconcileDeps {
    return {
      applyPendingWrites: async () => {
        order.push("applyPendingWrites");
        return ok({ appliedRevisionId: "rev:pending-applied" as RevisionId, appliedCount: 2 });
      },
      currentRevisionId: async () => "rev:current" as RevisionId,
      drainIndexJobs: async (rev: RevisionId) => {
        order.push(`drainIndexJobs:${rev}`);
        return ok({ drainedCount: 3, atRevisionId: rev });
      },
      ...overrides,
    };
  }

  it("applies pending KW writes BEFORE draining GBrain index jobs", async () => {
    const order: string[] = [];
    const out = await runWakeReconcile(orderingDeps(order));
    expect(isOk(out)).toBe(true);
    expect(order).toEqual(["applyPendingWrites", "drainIndexJobs:rev:current"]);
  });

  it("drains the index at the CURRENT revision (no stale-revision indexing)", async () => {
    const order: string[] = [];
    const out = await runWakeReconcile(orderingDeps(order));
    expect(isOk(out) && out.value.drainedAtRevisionId).toBe("rev:current");
  });

  it("when pending-write apply FAILS, the index drain is NOT run (fails closed)", async () => {
    const order: string[] = [];
    const out = await runWakeReconcile(
      orderingDeps(order, {
        applyPendingWrites: async () => {
          order.push("applyPendingWrites");
          return err({ code: "apply_failed", message: "vault locked" });
        },
      }),
    );
    expect(isErr(out)).toBe(true);
    expect(order).toEqual(["applyPendingWrites"]); // drain never reached
  });
});
