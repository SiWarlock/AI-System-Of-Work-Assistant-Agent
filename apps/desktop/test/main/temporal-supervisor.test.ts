// Task 14.4 — the app-managed local Temporal supervisor (worker-host). Mirrors the gbrain-serve
// supervisor (apps/worker gbrainServeSupervisor.ts): a PURE state machine (spawn→ready→restart→
// dispose) over an INJECTED spawner/probe/sleep, so the suite drives a CONTROLLED/MOCK process and
// NEVER spawns a real Temporal server (the owner condition). The real spawner/probe are separate,
// integration-gated seams bound only at app boot.
//
// Safety legs (security=invariant): loopback-only bind (--ip 127.0.0.1, never 0.0.0.0), args-array +
// absolute/resolved bin (no shell injection — Lesson 10 analog), no-orphan shutdown, env-gated OFF
// default (byte-equivalent).
import { describe, it, expect, vi } from "vitest";
import {
  createTemporalSupervisor,
  temporalServerArgs,
  shouldManageTemporal,
  createTemporalSpawner,
  parseTemporalHostPort,
  type TemporalHandle,
} from "../../worker-host/temporal-supervisor";

/** A controllable mock process handle: capture the exit callback, spy the kill, drive crashes. */
function mockHandle(): { handle: TemporalHandle; fireExit: () => void; killed: () => number } {
  let exitCb: (() => void) | undefined;
  let kills = 0;
  return {
    handle: {
      onExit: (cb) => {
        exitCb = () => cb({ code: 1, signal: null });
      },
      kill: () => {
        kills += 1;
      },
    },
    fireExit: () => exitCb?.(),
    killed: () => kills,
  };
}

const immediateSleep = (): Promise<void> => Promise.resolve();

describe("temporalServerArgs — loopback-only, args-array (no shell)", () => {
  it("forces EVERY listener to the loopback host — `--ip` (gRPC/frontend) AND `--ui-ip` (Web UI)", () => {
    expect(temporalServerArgs("127.0.0.1", "7233")).toEqual([
      "server",
      "start-dev",
      "--ip",
      "127.0.0.1",
      "--port",
      "7233",
      "--ui-ip",
      "127.0.0.1",
    ]);
  });

  it("is an ARRAY of discrete tokens — no shell string, no interpolation surface", () => {
    const args = temporalServerArgs("127.0.0.1", "7233");
    expect(Array.isArray(args)).toBe(true);
    expect(args.every((a) => typeof a === "string")).toBe(true);
    expect(args.some((a) => a.includes(" ") || a.includes("&") || a.includes(";"))).toBe(false);
  });
});

describe("parseTemporalHostPort — the security-relevant parser feeding the loopback gate", () => {
  it("parses IPv4 host:port (lowercased host, numeric port)", () => {
    expect(parseTemporalHostPort("127.0.0.1:7233")).toEqual({ host: "127.0.0.1", port: "7233" });
    expect(parseTemporalHostPort("  127.0.0.1:7233  ")).toEqual({ host: "127.0.0.1", port: "7233" });
    expect(parseTemporalHostPort("LocalHost:7233")).toEqual({ host: "localhost", port: "7233" });
  });

  it("parses bracketed IPv6 (`[::1]:7233` → host `::1`) so the loopback check sees the real host", () => {
    expect(parseTemporalHostPort("[::1]:7233")).toEqual({ host: "::1", port: "7233" });
  });

  it("fails closed (null) on every structural anomaly", () => {
    for (const bad of [
      "", // empty
      "127.0.0.1", // no port
      "127.0.0.1:", // empty port
      "127.0.0.1:abc", // non-numeric port
      "127.0.0.1:0", // out-of-range port
      "127.0.0.1:99999", // out-of-range port
      "[::1]", // bracketed, no port
      "[::1]7233", // bracketed, missing colon
      ":7233", // no host
    ]) {
      expect(parseTemporalHostPort(bad)).toBeNull();
    }
  });
});

describe("shouldManageTemporal — env-gated OFF by default (byte-equivalent)", () => {
  it("is OFF unless the flag is exactly 'true'", () => {
    expect(shouldManageTemporal({})).toBe(false);
    expect(shouldManageTemporal({ SOW_MANAGE_TEMPORAL: undefined })).toBe(false);
    expect(shouldManageTemporal({ SOW_MANAGE_TEMPORAL: "1" })).toBe(false);
    expect(shouldManageTemporal({ SOW_MANAGE_TEMPORAL: "false" })).toBe(false);
    expect(shouldManageTemporal({ SOW_MANAGE_TEMPORAL: "TRUE" })).toBe(false);
    expect(shouldManageTemporal({ SOW_MANAGE_TEMPORAL: "true" })).toBe(true);
  });
});

describe("createTemporalSupervisor — spawn / ready / crash / dispose (mock process)", () => {
  it("spawns the loopback process ONCE on start and reports ready when the probe is healthy", async () => {
    const m = mockHandle();
    const spawn = vi.fn(() => m.handle);
    const probe = vi.fn(async () => true);
    const sup = createTemporalSupervisor({ address: "127.0.0.1:7233", spawn, probe, sleep: immediateSleep });
    const r = await sup.start();
    expect(r.ok).toBe(true); // healthy ⇒ the app can leave Temporal-DEGRADED
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith("127.0.0.1:7233");
  });

  it("FAILS CLOSED on a non-loopback address (never spawns) — loopback-only bind", async () => {
    const spawn = vi.fn(() => mockHandle().handle);
    const probe = vi.fn(async () => true);
    for (const addr of ["0.0.0.0:7233", "10.0.0.5:7233", "temporal.example.com:7233"]) {
      const sup = createTemporalSupervisor({ address: addr, spawn, probe, sleep: immediateSleep });
      const r = await sup.start();
      expect(r.ok).toBe(false);
    }
    expect(spawn).not.toHaveBeenCalled(); // never spawned a routable server
  });

  it("fails closed (never throws) when the process never becomes ready + disposes what it spawned", async () => {
    const m = mockHandle();
    const spawn = vi.fn(() => m.handle);
    const probe = vi.fn(async () => false); // never healthy
    const sup = createTemporalSupervisor({
      address: "127.0.0.1:7233",
      spawn,
      probe,
      sleep: immediateSleep,
      readinessTimeoutMs: 5,
      probeIntervalMs: 1,
    });
    const r = await sup.start();
    expect(r.ok).toBe(false);
    expect(m.killed()).toBeGreaterThan(0); // cleaned up the process it spawned
  });

  it("respawns on an UNEXPECTED crash (bounded by maxRestarts), never after dispose (no orphan)", async () => {
    const m = mockHandle();
    const spawn = vi.fn(() => m.handle);
    const probe = vi.fn(async () => true);
    const sup = createTemporalSupervisor({ address: "127.0.0.1:7233", spawn, probe, sleep: immediateSleep, maxRestarts: 2 });
    await sup.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    m.fireExit(); // crash 1 → respawn
    m.fireExit(); // crash 2 → respawn
    m.fireExit(); // crash 3 → over the bound → give up
    expect(spawn).toHaveBeenCalledTimes(3); // initial + 2 bounded respawns, not 4
  });

  it("dispose() kills the process and STOPS restart-on-crash (a post-dispose exit never respawns)", async () => {
    const m = mockHandle();
    const spawn = vi.fn(() => m.handle);
    const probe = vi.fn(async () => true);
    const sup = createTemporalSupervisor({ address: "127.0.0.1:7233", spawn, probe, sleep: immediateSleep });
    await sup.start();
    await sup.dispose();
    expect(m.killed()).toBeGreaterThan(0);
    m.fireExit(); // a crash AFTER dispose must NOT respawn
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe("createTemporalSpawner — args-array + resolved bin, NO shell (real spawn never called in-suite)", () => {
  it("invokes the injected spawn impl with (binary, args-array, no-shell opts) — never a shell string", () => {
    const spawnImpl = vi.fn(
      (_command: string, _args: readonly string[], _options: { env: NodeJS.ProcessEnv; stdio: "ignore"; detached: boolean }) => ({
        on: (): void => {},
        once: (): void => {},
        kill: (): void => {},
      }),
    );
    const spawner = createTemporalSpawner({ binary: "/usr/local/bin/temporal", spawnImpl: spawnImpl as never });
    spawner("127.0.0.1:7233");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnImpl.mock.calls[0]!;
    expect(bin).toBe("/usr/local/bin/temporal"); // resolved/absolute bin
    expect(args).toEqual(["server", "start-dev", "--ip", "127.0.0.1", "--port", "7233", "--ui-ip", "127.0.0.1"]); // args-array, all-loopback
    // `shell` is structurally absent from SpawnImpl's options type (can't pass shell:true), and never set at runtime.
    expect((opts as unknown as { shell?: unknown }).shell).not.toBe(true); // never a shell (no injection surface)
    expect(opts.stdio).toBe("ignore"); // redaction-safe: child output never captured
    expect(opts.detached).toBe(false);
  });
});
