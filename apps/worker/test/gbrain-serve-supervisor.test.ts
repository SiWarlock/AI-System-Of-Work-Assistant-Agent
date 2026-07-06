// SS1 (Option A — app-managed serve) — the gbrain-serve supervisor's DETERMINISTIC core: spawn a
// `gbrain serve --http --enable-dcr` process, poll it until ready, restart it on crash (bounded), and tear it
// down cleanly. The spawn / probe / sleep are INJECTED seams (the real child_process + fetch are integration-
// gated), so the state machine is fully unit-tested here. Fail-closed; never throws.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import { createGbrainServeSupervisor } from "../src/gbrainServeSupervisor";
import type { GbrainServeHandle, GbrainServeSupervisorDeps } from "../src/gbrainServeSupervisor";

const BASE = "http://127.0.0.1:8899";

/** A fake serve handle whose exit can be triggered by the test; records kills. */
function fakeHandle(): GbrainServeHandle & { triggerExit: (code: number | null) => void; killed: () => number } {
  let onExit: ((info: { code: number | null; signal: string | null }) => void) | undefined;
  let kills = 0;
  return {
    onExit: (cb) => {
      onExit = cb;
    },
    kill: () => {
      kills += 1;
    },
    triggerExit: (code) => onExit?.({ code, signal: null }),
    killed: () => kills,
  };
}

/** A spawner that hands out a fresh fake handle per call and records them. */
function fakeSpawner(): { spawn: GbrainServeSupervisorDeps["spawn"]; handles: ReturnType<typeof fakeHandle>[] } {
  const handles: ReturnType<typeof fakeHandle>[] = [];
  return {
    spawn: () => {
      const h = fakeHandle();
      handles.push(h);
      return h;
    },
    handles,
  };
}

/** A probe that returns false `falseCount` times, then true. Records the number of probes. */
function readyAfter(falseCount: number): { probe: GbrainServeSupervisorDeps["probe"]; probes: () => number } {
  let n = 0;
  return {
    probe: async () => {
      n += 1;
      return n > falseCount;
    },
    probes: () => n,
  };
}

const noSleep: GbrainServeSupervisorDeps["sleep"] = async () => {};

describe("createGbrainServeSupervisor — spawn → ready → restart → dispose (injected seams; never throws)", () => {
  it("start(): spawns once, polls until ready, and returns the base url", async () => {
    const sp = fakeSpawner();
    const pr = readyAfter(2); // ready on the 3rd probe
    const sup = createGbrainServeSupervisor({ baseUrl: BASE, spawn: sp.spawn, probe: pr.probe, sleep: noSleep });
    const r = await sup.start();
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.baseUrl).toBe(BASE);
    expect(sp.handles.length).toBe(1); // spawned once
    expect(pr.probes()).toBe(3); // polled until ready
    await sup.dispose();
  });

  it("start(): if the serve never becomes ready, times out (bounded polls) and disposes (kills the process)", async () => {
    const sp = fakeSpawner();
    const neverReady: GbrainServeSupervisorDeps["probe"] = async () => false;
    const sup = createGbrainServeSupervisor({
      baseUrl: BASE,
      spawn: sp.spawn,
      probe: neverReady,
      sleep: noSleep,
      readinessTimeoutMs: 2000,
      probeIntervalMs: 500,
    });
    const r = await sup.start();
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("GBRAIN_SERVE_NOT_READY");
    expect(sp.handles[0]!.killed()).toBeGreaterThan(0); // the failed process was killed
  });

  it("restart-on-crash: a process exit BEFORE dispose respawns (bounded by maxRestarts)", async () => {
    const sp = fakeSpawner();
    const pr = readyAfter(0); // ready immediately
    const sup = createGbrainServeSupervisor({ baseUrl: BASE, spawn: sp.spawn, probe: pr.probe, sleep: noSleep, maxRestarts: 2 });
    await sup.start();
    expect(sp.handles.length).toBe(1);
    sp.handles[0]!.triggerExit(1); // crash → respawn (1)
    expect(sp.handles.length).toBe(2);
    sp.handles[1]!.triggerExit(1); // crash → respawn (2)
    expect(sp.handles.length).toBe(3);
    sp.handles[2]!.triggerExit(1); // crash → maxRestarts hit → NO further respawn
    expect(sp.handles.length).toBe(3);
    await sup.dispose();
  });

  it("dispose(): kills the current process AND stops restart-on-crash (a later exit does NOT respawn)", async () => {
    const sp = fakeSpawner();
    const pr = readyAfter(0);
    const sup = createGbrainServeSupervisor({ baseUrl: BASE, spawn: sp.spawn, probe: pr.probe, sleep: noSleep, maxRestarts: 5 });
    await sup.start();
    await sup.dispose();
    expect(sp.handles[0]!.killed()).toBeGreaterThan(0);
    sp.handles[0]!.triggerExit(0); // exit AFTER dispose ⇒ must NOT respawn
    expect(sp.handles.length).toBe(1);
  });

  it("dispose() is idempotent and start() never throws even if the spawner throws", async () => {
    const throwingSpawn: GbrainServeSupervisorDeps["spawn"] = () => {
      throw new Error("spawn failed");
    };
    const sup = createGbrainServeSupervisor({ baseUrl: BASE, spawn: throwingSpawn, probe: async () => true, sleep: noSleep });
    const r = await sup.start();
    expect(isErr(r)).toBe(true); // fail-closed, not a throw
    if (isErr(r)) expect(r.error.cause?.code).toBe("GBRAIN_SERVE_SPAWN_FAILED");
    await sup.dispose();
    await sup.dispose(); // idempotent — no throw
  });

  it("start() fails closed for a NON-LOOPBACK base url (never spawns or probes off-box)", async () => {
    const sp = fakeSpawner();
    const sup = createGbrainServeSupervisor({ baseUrl: "http://gbrain.example.com", spawn: sp.spawn, probe: async () => true, sleep: noSleep });
    const r = await sup.start();
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("GBRAIN_SERVE_NON_LOOPBACK");
    expect(sp.handles.length).toBe(0); // never spawned
  });

  it("start() is call-once: a second start() fails closed and does NOT orphan a second process", async () => {
    const sp = fakeSpawner();
    const sup = createGbrainServeSupervisor({ baseUrl: BASE, spawn: sp.spawn, probe: async () => true, sleep: noSleep });
    await sup.start();
    const r2 = await sup.start();
    expect(isErr(r2)).toBe(true);
    if (isErr(r2)) expect(r2.error.cause?.code).toBe("GBRAIN_SERVE_ALREADY_STARTED");
    expect(sp.handles.length).toBe(1); // no second spawn
    await sup.dispose();
  });

  it("dispose() DURING the poll loop aborts start() promptly (does not wait out maxPolls, nor report success)", async () => {
    const sp = fakeSpawner();
    let n = 0;
    let sup: ReturnType<typeof createGbrainServeSupervisor> | undefined;
    const probe: GbrainServeSupervisorDeps["probe"] = async () => {
      n += 1;
      if (n === 2) await sup!.dispose(); // shutdown lands mid-startup, on the 2nd probe
      return false;
    };
    // A huge readiness budget so a NON-prompt abort would be obvious (thousands of polls).
    sup = createGbrainServeSupervisor({ baseUrl: BASE, spawn: sp.spawn, probe, sleep: noSleep, readinessTimeoutMs: 1_000_000, probeIntervalMs: 1 });
    const r = await sup.start();
    expect(isErr(r)).toBe(true); // never reports success for a disposed process
    expect(n).toBeLessThan(5); // aborted promptly, not ~1,000,000 polls
  });

  it("a probe that throws is treated as not-ready (fail-closed), never a throw out of start()", async () => {
    const sp = fakeSpawner();
    let n = 0;
    const flakyProbe: GbrainServeSupervisorDeps["probe"] = async () => {
      n += 1;
      if (n <= 2) throw new Error("connection refused");
      return true;
    };
    const sup = createGbrainServeSupervisor({ baseUrl: BASE, spawn: sp.spawn, probe: flakyProbe, sleep: noSleep });
    const r = await sup.start();
    expect(isOk(r)).toBe(true); // recovered once the probe stopped throwing
    await sup.dispose();
  });
});
