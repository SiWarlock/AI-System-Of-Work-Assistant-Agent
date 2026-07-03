import { describe, it, expect } from "vitest";
import {
  createWorkerSupervisor,
  restartBackoffMs,
  type WorkerChild,
  type WorkerHostConfig,
} from "../../main/worker-supervisor";

// A controllable fake of the child-process surface the supervisor drives.
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

interface Harness {
  children: FakeChild[];
  timers: { ms: number; run: () => void }[];
  sup: ReturnType<typeof createWorkerSupervisor>;
}

function makeHarness(): Harness {
  const children: FakeChild[] = [];
  const timers: { ms: number; run: () => void }[] = [];
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
  });
  return { children, timers, sup };
}

describe("createWorkerSupervisor — spawn, ready, supervise", () => {
  it("start() forks one child and injects the config over IPC", () => {
    const h = makeHarness();
    h.sup.start();
    expect(h.children).toHaveLength(1);
    expect(h.children[0]!.sent).toEqual([{ type: "config", config: CONFIG }]);
    expect(h.sup.status()).toBe("starting");
  });

  it("becomes ready on the child's ready message", () => {
    const h = makeHarness();
    h.sup.start();
    h.children[0]!.emit("message", { type: "ready", port: 47100 });
    expect(h.sup.status()).toBe("ready");
  });

  it("connection() exposes the pinned loopback URLs + the session token", () => {
    const h = makeHarness();
    expect(h.sup.connection()).toEqual({
      httpUrl: "http://127.0.0.1:47100",
      wsUrl: "ws://127.0.0.1:47100",
      token: "tok-123",
    });
  });

  it("restarts (with backoff) when the child exits unexpectedly", () => {
    const h = makeHarness();
    h.sup.start();
    h.children[0]!.emit("exit", 1);
    expect(h.sup.status()).toBe("restarting");
    expect(h.timers).toHaveLength(1);
    // running the scheduled restart re-forks + re-injects config
    h.timers[0]!.run();
    expect(h.children).toHaveLength(2);
    expect(h.children[1]!.sent).toEqual([{ type: "config", config: CONFIG }]);
  });

  it("stop() kills the child and suppresses any restart", () => {
    const h = makeHarness();
    h.sup.start();
    h.sup.stop();
    expect(h.children[0]!.killed).toContain("SIGTERM");
    expect(h.sup.status()).toBe("stopped");
    // a late exit after stop must NOT schedule a restart
    h.children[0]!.emit("exit", 0);
    expect(h.timers).toHaveLength(0);
  });

  it("ignores an exit from a stale (already-replaced) child", () => {
    const h = makeHarness();
    h.sup.start();
    h.children[0]!.emit("exit", 1); // schedules restart
    h.timers[0]!.run(); // child[1] now current
    const before = h.timers.length;
    h.children[0]!.emit("exit", 1); // stale child exits again — must be ignored
    expect(h.timers).toHaveLength(before);
  });
});

describe("restartBackoffMs — bounded exponential", () => {
  it("grows with attempts and caps", () => {
    expect(restartBackoffMs(1)).toBeGreaterThan(0);
    expect(restartBackoffMs(2)).toBeGreaterThan(restartBackoffMs(1));
    expect(restartBackoffMs(100)).toBeLessThanOrEqual(10_000);
    expect(restartBackoffMs(100)).toBeGreaterThan(0);
  });
});
