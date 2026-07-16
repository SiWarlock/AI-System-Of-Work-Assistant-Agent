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
  temporalDbPathUnder,
  temporalManagementPlan,
  type TemporalHandle,
} from "../../worker-host/temporal-supervisor";

// A representative Electron userData dir (main resolves app.getPath("userData")); the tests never touch it.
const USER_DATA = "/Users/me/Library/Application Support/SoW";
const DB_PATH = temporalDbPathUnder(USER_DATA); // <userData>/temporal/dev.db

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

describe("temporalServerArgs — loopback-only, args-array (no shell), PERSISTENT storage", () => {
  it("forces EVERY listener loopback (`--ip` + `--ui-ip`) AND persists via `--db-filename` (never in-memory)", () => {
    expect(temporalServerArgs("127.0.0.1", "7233", DB_PATH)).toEqual([
      "server",
      "start-dev",
      "--ip",
      "127.0.0.1",
      "--port",
      "7233",
      "--ui-ip",
      "127.0.0.1",
      "--db-filename",
      DB_PATH,
    ]);
  });

  it("ANTI-REGRESSION: the args ALWAYS carry `--db-filename` with a non-empty path — the in-memory drift can never silently return", () => {
    const args = temporalServerArgs("127.0.0.1", "7233", DB_PATH);
    const i = args.indexOf("--db-filename");
    expect(i).toBeGreaterThanOrEqual(0); // the flag is present
    expect(args[i + 1]).toBe(DB_PATH); // …with the persistent path
    expect((args[i + 1] ?? "").length).toBeGreaterThan(0); // never empty (which temporal treats as ephemeral)
  });

  it("is an ARRAY of DISCRETE tokens (not a single shell string) — spaces in a path arg are safe (shell:false)", () => {
    const args = temporalServerArgs("127.0.0.1", "7233", DB_PATH);
    expect(Array.isArray(args)).toBe(true);
    expect(args.every((a) => typeof a === "string")).toBe(true);
    // The safety is STRUCTURAL: each flag + value is its own array element (spawn shell:false), so a
    // db path containing spaces (macOS "Application Support") is passed verbatim, never re-split/interpolated.
    expect(args.length).toBeGreaterThan(6); // many discrete tokens, never one concatenated command line
    expect(args[0]).toBe("server"); // the FLAG tokens carry no whitespace/metachars (values may)
    expect(args.filter((a) => a.startsWith("--")).every((a) => !/[\s&;|]/.test(a))).toBe(true);
  });
});

describe("temporalDbPathUnder — persistent SQLite path under app userData (§13, never in-memory / /tmp)", () => {
  it("derives `<userData>/temporal/dev.db` — userData-derived, not caller/attacker-controlled, no traversal", () => {
    expect(temporalDbPathUnder(USER_DATA)).toBe(`${USER_DATA}/temporal/dev.db`);
    // Under the app data dir; never /tmp, never an in-memory sentinel, no `..` traversal.
    expect(temporalDbPathUnder(USER_DATA).startsWith(USER_DATA)).toBe(true);
    expect(temporalDbPathUnder(USER_DATA)).not.toMatch(/\.\./);
    expect(temporalDbPathUnder(USER_DATA)).not.toMatch(/^\/tmp/);
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

describe("temporalManagementPlan — fail-safe gate (manage only when opted-in AND a persistent path exists)", () => {
  const DB = "/Users/me/Library/Application Support/SoW/sow.db";

  it("returns null (DON'T manage) when the flag is OFF — regardless of dbPath", () => {
    expect(temporalManagementPlan({}, DB)).toBeNull();
    expect(temporalManagementPlan({ SOW_MANAGE_TEMPORAL: "false" }, DB)).toBeNull();
  });

  it("FAIL-SAFE EDGE: flag ON but dbPath absent/empty ⇒ null (SKIP — never an in-memory fallback)", () => {
    expect(temporalManagementPlan({ SOW_MANAGE_TEMPORAL: "true" }, undefined)).toBeNull();
    expect(temporalManagementPlan({ SOW_MANAGE_TEMPORAL: "true" }, "")).toBeNull();
  });

  it("flag ON + a dbPath ⇒ manage with the persistent `<userData>/temporal/dev.db` (sibling of the operational db)", () => {
    expect(temporalManagementPlan({ SOW_MANAGE_TEMPORAL: "true" }, DB)).toEqual({
      dbFilename: "/Users/me/Library/Application Support/SoW/temporal/dev.db",
    });
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

describe("createTemporalSpawner — args-array + resolved bin, NO shell, mkdir-if-absent (real spawn/fs never called in-suite)", () => {
  it("mkdir-recursive's the db parent dir (injected fs seam) THEN spawns with the persistent --db-filename", () => {
    const mkdirImpl = vi.fn((_dir: string, _opts: { recursive: true }) => {});
    const spawnImpl = vi.fn(
      (_command: string, _args: readonly string[], _options: { env: NodeJS.ProcessEnv; stdio: "ignore"; detached: boolean }) => ({
        on: (): void => {},
        once: (): void => {},
        kill: (): void => {},
      }),
    );
    const spawner = createTemporalSpawner({
      binary: "/usr/local/bin/temporal",
      dbFilename: DB_PATH,
      mkdirImpl,
      spawnImpl: spawnImpl as never,
    });
    spawner("127.0.0.1:7233");
    // Directory created-if-absent via the INJECTED seam (no real fs write in-suite).
    expect(mkdirImpl).toHaveBeenCalledWith(`${USER_DATA}/temporal`, { recursive: true });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnImpl.mock.calls[0]!;
    expect(bin).toBe("/usr/local/bin/temporal"); // resolved/absolute bin
    expect(args).toEqual([
      "server",
      "start-dev",
      "--ip",
      "127.0.0.1",
      "--port",
      "7233",
      "--ui-ip",
      "127.0.0.1",
      "--db-filename",
      DB_PATH,
    ]); // args-array, all-loopback, PERSISTENT
    expect((opts as unknown as { shell?: unknown }).shell).not.toBe(true); // never a shell (no injection surface)
    expect(opts.stdio).toBe("ignore"); // redaction-safe: child output never captured
    expect(opts.detached).toBe(false);
  });

  it("ANTI-REGRESSION on the fallback path too: an unparseable address STILL emits --db-filename (never in-memory)", () => {
    const spawnImpl = vi.fn(
      (_c: string, _a: readonly string[], _o: { env: NodeJS.ProcessEnv; stdio: "ignore"; detached: boolean }) => ({
        on: (): void => {},
        once: (): void => {},
        kill: (): void => {},
      }),
    );
    const spawner = createTemporalSpawner({ dbFilename: DB_PATH, mkdirImpl: () => {}, spawnImpl: spawnImpl as never });
    spawner("not-a-parseable-address"); // the hp===null fallback branch (unreachable via the guarded supervisor)
    const args = spawnImpl.mock.calls[0]![1];
    expect(args).toContain("--db-filename");
    expect(args[args.indexOf("--db-filename") + 1]).toBe(DB_PATH); // persistent even on the fallback
  });

  it("mkdir is BEST-EFFORT: a throwing mkdirImpl does NOT block the spawn (temporal degrades fail-closed, not silent-ephemeral)", () => {
    const mkdirImpl = vi.fn(() => {
      throw new Error("EACCES");
    });
    const spawnImpl = vi.fn(
      (_c: string, _a: readonly string[], _o: { env: NodeJS.ProcessEnv; stdio: "ignore"; detached: boolean }) => ({
        on: (): void => {},
        once: (): void => {},
        kill: (): void => {},
      }),
    );
    const spawner = createTemporalSpawner({ dbFilename: DB_PATH, mkdirImpl, spawnImpl: spawnImpl as never });
    expect(() => spawner("127.0.0.1:7233")).not.toThrow(); // the mkdir fault never escapes the spawner
    expect(spawnImpl).toHaveBeenCalledTimes(1); // spawn still attempted with the persistent --db-filename
    expect(spawnImpl.mock.calls[0]![1]).toContain("--db-filename");
  });
});
