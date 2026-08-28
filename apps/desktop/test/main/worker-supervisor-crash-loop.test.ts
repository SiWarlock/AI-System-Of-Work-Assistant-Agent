// apps/desktop — the CRASH-LOOP guard (task 10.4 / LIFE).
//
// ⛔ THE DEFECT THESE PIN. The supervisor incremented `attempt`, backed off, and
// respawned FOREVER. `restartBackoffMs` caps at 10s, so a worker that can never start
// — bad config, missing binary, corrupt store — was restarted every ten seconds for
// the life of the app while `status()` sat on `"restarting"` indefinitely. There was
// no threshold and no terminal state, so the single condition an operator most needs
// to see ("it has given up") was indistinguishable from "it is about to retry".
//
// `apps/worker`'s `decideRestart` has held the correct policy the whole time and has
// zero production callers; Electron main cannot import it (desktop LESSON 17 keeps
// `@sow/worker` external from the main bundle), so the guard is reimplemented here
// and the two are required to agree. These tests pin THIS side.
import { describe, it, expect } from "vitest";
import {
  createWorkerSupervisor,
  type WorkerChild,
  type WorkerHostConfig,
} from "../../main/worker-supervisor";

class FakeChild implements WorkerChild {
  sent: unknown[] = [];
  killed: string[] = [];
  private handlers: Record<string, ((arg: unknown) => void)[]> = {};
  send(msg: unknown): void {
    this.sent.push(msg);
  }
  on(event: string, cb: (arg: never) => void): void {
    (this.handlers[event] ??= []).push(cb as (arg: unknown) => void);
  }
  kill(signal?: string): void {
    this.killed.push(signal ?? "SIGTERM");
  }
  emit(event: string, arg?: unknown): void {
    (this.handlers[event] ?? []).forEach((h) => h(arg));
  }
}

const CONFIG: WorkerHostConfig = {
  token: "tok-123",
  launchId: "launch-1",
  origins: ["app://sow"],
  hosts: ["127.0.0.1:47100"],
  apiHost: "127.0.0.1",
  apiPort: 47100,
};
const CONNECTION = { httpUrl: "http://127.0.0.1:47100", wsUrl: "ws://127.0.0.1:47100" };

function makeHarness(startAt = 0) {
  const children: FakeChild[] = [];
  const timers: { ms: number; run: () => void }[] = [];
  const logs: { event: string; fields?: Record<string, unknown> }[] = [];
  let clock = startAt;
  const sup = createWorkerSupervisor({
    fork: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    config: CONFIG,
    connection: CONNECTION,
    scheduleRestart: (ms, run) => {
      timers.push({ ms, run });
      return () => {};
    },
    log: (event, fields) => logs.push({ event, ...(fields ? { fields } : {}) }),
    now: () => clock,
  });
  return {
    children,
    timers,
    logs,
    sup,
    advance: (ms: number): void => {
      clock += ms;
    },
    /** Crash the newest child, then run whatever restart timer that scheduled. */
    crashAndRestart: (): void => {
      children[children.length - 1]?.emit("exit", 1);
      const t = timers.pop();
      if (t) t.run();
    },
  };
}

describe("worker supervisor — crash-loop guard", () => {
  it("STOPS respawning at the threshold instead of restarting forever", async () => {
    const h = makeHarness();
    h.sup.start();
    expect(h.children).toHaveLength(1);

    // Five crashes inside the window. The 5th trips the threshold.
    for (let i = 0; i < 5; i += 1) {
      h.children[h.children.length - 1]?.emit("exit", 1);
      h.advance(1000);
      const t = h.timers.pop();
      if (t) t.run();
    }

    // Before the fix this kept forking forever and `status()` stayed "restarting".
    expect(h.sup.status()).toBe("worker_down");
    const forked = h.children.length;
    // No further timer was scheduled, so nothing can respawn it.
    expect(h.timers).toHaveLength(0);
    // And a stray late exit from the dead child cannot resurrect it.
    h.children[h.children.length - 1]?.emit("exit", 1);
    expect(h.children).toHaveLength(forked);
    expect(h.sup.status()).toBe("worker_down");
  });

  it("logs a distinct worker.down event naming the crash-loop, never silently", async () => {
    const h = makeHarness();
    h.sup.start();
    for (let i = 0; i < 5; i += 1) {
      h.children[h.children.length - 1]?.emit("exit", 1);
      h.advance(1000);
      const t = h.timers.pop();
      if (t) t.run();
    }
    const down = h.logs.find((l) => l.event === "worker.down");
    expect(down).toBeDefined();
    expect(down?.fields?.["reason"]).toBe("crash_loop");
    expect(down?.fields?.["threshold"]).toBe(5);
  });

  it("NON-VACUITY: below the threshold it still restarts normally", async () => {
    // Without this, a guard that simply refused to ever restart would pass the pin
    // above — the supervisor's whole job is to restart.
    const h = makeHarness();
    h.sup.start();
    for (let i = 0; i < 4; i += 1) {
      h.children[h.children.length - 1]?.emit("exit", 1);
      h.advance(1000);
      const t = h.timers.pop();
      if (t) t.run();
    }
    expect(h.sup.status()).toBe("restarting");
    expect(h.children).toHaveLength(5); // 1 initial + 4 respawns
  });

  it("crashes OUTSIDE the rolling window roll off — a slow trickle is not a loop", async () => {
    // The window is what separates "failing repeatedly right now" from "restarted a
    // few times over an afternoon", and conflating them would declare a healthy
    // long-running app dead.
    const h = makeHarness();
    h.sup.start();
    for (let i = 0; i < 8; i += 1) {
      h.children[h.children.length - 1]?.emit("exit", 1);
      h.advance(61_000); // each crash is a full window apart
      const t = h.timers.pop();
      if (t) t.run();
    }
    expect(h.sup.status()).not.toBe("worker_down");
    expect(h.children).toHaveLength(9);
  });

  it("a deliberate start() clears the crash history — the operator can retry", async () => {
    const h = makeHarness();
    h.sup.start();
    for (let i = 0; i < 5; i += 1) {
      h.children[h.children.length - 1]?.emit("exit", 1);
      h.advance(1000);
      const t = h.timers.pop();
      if (t) t.run();
    }
    expect(h.sup.status()).toBe("worker_down");

    h.sup.start();
    expect(h.sup.status()).not.toBe("worker_down");
    // And it takes a full fresh threshold to trip again, not one more crash.
    for (let i = 0; i < 4; i += 1) {
      h.children[h.children.length - 1]?.emit("exit", 1);
      h.advance(1000);
      const t = h.timers.pop();
      if (t) t.run();
    }
    expect(h.sup.status()).toBe("restarting");
  });

  it("worker_down is DISTINCT from stopped — 'it gave up' is not 'I turned it off'", async () => {
    const h = makeHarness();
    h.sup.start();
    for (let i = 0; i < 5; i += 1) {
      h.children[h.children.length - 1]?.emit("exit", 1);
      h.advance(1000);
      const t = h.timers.pop();
      if (t) t.run();
    }
    expect(h.sup.status()).toBe("worker_down");
    expect(h.sup.status()).not.toBe("stopped");
  });
});
