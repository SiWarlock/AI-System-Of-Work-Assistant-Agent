// Task 14.4 — the app-managed local Temporal supervisor (G62 hard-line→substrate downgrade, OWNER
// RATIFIED 2026-07-15). Mirrors the gbrain-serve supervisor (apps/worker gbrainServeSupervisor.ts):
// the worker-host spawns + supervises a LOOPBACK-only local Temporal dev-server (127.0.0.1:7233) so
// product workflows run in-product; the app leaves "Temporal-DEGRADED" once the managed server is
// healthy, and stops it cleanly on quit. Loopback-only, cleanly supervised ⇒ NONE of the 4 hard
// lines (no external egress / spend / credential / real-transport).
//
// Split for TDD: the DETERMINISTIC core (`createTemporalSupervisor` — spawn→ready→restart→dispose
// over an INJECTED spawner/probe/sleep) is unit-tested against a CONTROLLED/MOCK process; the
// imperative seams (`createTemporalSpawner` via child_process, `createTemporalProbe` via net) are
// integration-gated — never in the default suite, so the suite NEVER spawns a real Temporal server
// (the owner condition). Fail-closed + redaction-safe (a spawn/probe fault yields only a stable
// code — never the child's stderr); NEVER throws.
//
// Loopback-only bind: unlike gbrain (no --host flag ⇒ a documented bind residual), Temporal's
// `server start-dev` takes `--ip` (default 127.0.0.1; 0.0.0.0 = all interfaces — Context7
// /temporalio/cli), so we FORCE the bind interface to the loopback host we validated, AND `start()`
// refuses a non-loopback address before any spawn. The bind interface is fully enforced here.
import { spawn as nodeSpawn } from "node:child_process";
import { connect as netConnect } from "node:net";
import { mkdirSync as nodeMkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { err, failure } from "@sow/contracts";
import type { Result, FailureVariant } from "@sow/contracts";
import { isLoopbackHost } from "@sow/policy";

/** A valid TCP port token: 1–5 digits in [1, 65535]. Rejects non-numeric / empty / out-of-range. */
function isNumericPort(port: string): boolean {
  if (!/^[0-9]{1,5}$/.test(port)) return false;
  const n = Number(port);
  return n >= 1 && n <= 65535;
}

/**
 * Parse a Temporal `host:port` address (incl. bracketed IPv6 `[::1]:7233`) → lowercased host + port,
 * or null. The PORT is validated numeric/in-range too — a structurally-invalid port (`:abc`, `:0`,
 * `:99999`) fails HERE so the loopback gate refuses it, rather than reporting host-loopback-ok on a
 * bad port that only breaks later at probe/spawn. Fail-closed on any anomaly.
 */
export function parseTemporalHostPort(address: string): { readonly host: string; readonly port: string } | null {
  const a = address.trim();
  if (a.length === 0) return null;
  if (a.startsWith("[")) {
    const close = a.indexOf("]");
    if (close < 0) return null;
    const host = a.slice(1, close).toLowerCase();
    const rest = a.slice(close + 1);
    if (!rest.startsWith(":")) return null;
    const port = rest.slice(1);
    return host.length > 0 && isNumericPort(port) ? { host, port } : null;
  }
  const idx = a.lastIndexOf(":");
  if (idx <= 0) return null;
  const host = a.slice(0, idx).toLowerCase();
  const port = a.slice(idx + 1);
  return host.length > 0 && isNumericPort(port) ? { host, port } : null;
}

/**
 * The `temporal server start-dev` args (Context7 /temporalio/cli) — an ARRAY of discrete tokens
 * (never a shell string → no injection surface). Forces EVERY listener onto the validated loopback:
 * `--ip` binds the gRPC frontend/HTTP gateway, and `--ui-ip` binds the Web UI (which otherwise only
 * DEFAULTS to loopback) — so the slice enforces the bind interface rather than relying on Temporal's
 * defaults (metrics/pprof stay disabled by default, port 0). No shell.
 *
 * PERSISTENT storage (§13, LIFE-3): `--db-filename` points at a persistent SQLite file under app data,
 * so in-flight workflow state SURVIVES a restart — never the in-memory default. `dbFilename` is a
 * REQUIRED param (typed non-optional), so a `start-dev` WITHOUT persistent storage is structurally
 * un-buildable — the in-memory drift can never silently return (mirrors worker Lesson 31).
 */
export function temporalServerArgs(host: string, port: string, dbFilename: string): readonly string[] {
  return ["server", "start-dev", "--ip", host, "--port", port, "--ui-ip", host, "--db-filename", dbFilename];
}

/**
 * The persistent Temporal SQLite path under the app userData dir (§13 "under app data, never
 * in-memory / never /tmp"): `<userData>/temporal/dev.db`. Pure + Electron-free — the caller resolves
 * `userData` (main via app.getPath, threaded to the worker-host as `dirname(config.dbPath)`). The
 * path is userData-derived (not caller/attacker-controlled) with no traversal.
 */
export function temporalDbPathUnder(userData: string): string {
  return join(userData, "temporal", "dev.db");
}

/**
 * The fail-closed management decision: whether to manage a local Temporal AND with which persistent
 * db path, given the env + the operational `config.dbPath` (`<userData>/sow.db`). Returns null (DON'T
 * manage) unless the opt-in flag is strictly on AND a dbPath exists to derive userData from — so
 * `SOW_MANAGE_TEMPORAL="true"` with an absent dbPath SKIPS management entirely (never an in-memory
 * fallback). Pure + Electron-free.
 */
export function temporalManagementPlan(
  env: Record<string, string | undefined>,
  dbPath: string | undefined,
): { readonly dbFilename: string } | null {
  if (!shouldManageTemporal(env)) return null;
  if (dbPath === undefined || dbPath.length === 0) return null; // fail-safe: no userData ⇒ no (in-memory) spawn
  return { dbFilename: temporalDbPathUnder(dirname(dbPath)) };
}

/** OFF by default (byte-equivalent): the managed local Temporal spawns ONLY when the operator opts in.
 *  STRICT `=== "true"` (never truthy — mirrors worker Lesson 28), so a stray "1"/"false"/"TRUE" stays OFF. */
export function shouldManageTemporal(env: Record<string, string | undefined>): boolean {
  return env["SOW_MANAGE_TEMPORAL"] === "true";
}

/** A handle to a spawned Temporal process — register an exit callback + kill it. Real impl wraps a ChildProcess. */
export interface TemporalHandle {
  readonly onExit: (cb: (info: { readonly code: number | null; readonly signal: string | null }) => void) => void;
  /** Terminate the process. Idempotent — safe to call more than once. */
  readonly kill: () => void;
}

/** Injected: spawn a loopback `temporal server start-dev` at `address`. Real impl = `createTemporalSpawner`. */
export type TemporalSpawner = (address: string) => TemporalHandle;
/** Injected: probe whether the Temporal frontend at `address` is accepting connections. Real = `createTemporalProbe`. */
export type TemporalProbe = (address: string) => Promise<boolean>;
/** Injected sleep between readiness probes (real = setTimeout; tests inject an immediate resolver). */
export type Sleep = (ms: number) => Promise<void>;

export interface TemporalSupervisorDeps {
  /** The loopback Temporal frontend address (e.g. `127.0.0.1:7233`). `start()` refuses a non-loopback host. */
  readonly address: string;
  readonly spawn: TemporalSpawner;
  readonly probe: TemporalProbe;
  readonly sleep: Sleep;
  /** Max time to wait for first-ready before failing closed. Default 30_000. */
  readonly readinessTimeoutMs?: number;
  /** Delay between readiness probes. Default 500. */
  readonly probeIntervalMs?: number;
  /** Max unexpected-crash respawns (cumulative) before giving up → degrade. Default 3. */
  readonly maxRestarts?: number;
}

export interface TemporalSupervisor {
  /** Spawn + wait until ready (probe true) or the readiness timeout. Fail-closed; never throws. */
  readonly start: () => Promise<Result<{ readonly address: string }, FailureVariant>>;
  /** Kill the process + stop restart-on-crash. Idempotent; never throws. */
  readonly dispose: () => Promise<void>;
}

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_INTERVAL_MS = 500;
const DEFAULT_MAX_RESTARTS = 3;

function temporalFault(code: string, message: string): FailureVariant {
  // Redaction-safe: a stable code only — never the child's stderr / the resolved path / host.
  return failure("degraded_unavailable", message, { retryable: true, cause: { code } });
}

/**
 * Build the supervisor over the injected seams. `start()` refuses a non-loopback address (fail-closed
 * BEFORE any spawn), spawns + polls until ready; an unexpected exit BEFORE dispose respawns (bounded by
 * `maxRestarts`, cumulative); `dispose()` kills the process and permanently stops respawning. All state
 * is closure-local. Pure w.r.t. its injected seams; NEVER throws (spawn/probe faults fail closed).
 */
export function createTemporalSupervisor(deps: TemporalSupervisorDeps): TemporalSupervisor {
  const readinessTimeoutMs = deps.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const probeIntervalMs = deps.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const maxRestarts = deps.maxRestarts ?? DEFAULT_MAX_RESTARTS;

  let disposing = false;
  let started = false;
  let restarts = 0;
  let handle: TemporalHandle | undefined;

  const spawnOnce = (): FailureVariant | null => {
    let h: TemporalHandle;
    try {
      h = deps.spawn(deps.address);
    } catch {
      return temporalFault("TEMPORAL_SPAWN_FAILED", "temporal dev-server failed to spawn");
    }
    handle = h;
    h.onExit(() => {
      // A DISPOSE-driven exit must never respawn; an unexpected crash respawns up to the LIFETIME bound
      // (`restarts` cumulative, never reset — after `maxRestarts` total crashes the supervisor gives up
      // and the path degrades fail-closed; a backoff + reset-on-sustained-uptime is a deferred follow-up).
      if (disposing) return;
      if (restarts >= maxRestarts) return;
      restarts += 1;
      spawnOnce();
    });
    return null;
  };

  const dispose = async (): Promise<void> => {
    // Sets `disposing` FIRST so the kill-triggered onExit reads it and does not respawn (no orphan).
    disposing = true;
    try {
      handle?.kill();
    } catch {
      // ignore — a kill on an already-dead process must never throw out of dispose.
    }
    handle = undefined;
  };

  const start = async (): Promise<Result<{ readonly address: string }, FailureVariant>> => {
    // Safety leg: NEVER spawn a non-loopback Temporal. Parse + validate the host with the authoritative
    // @sow/policy predicate (Lesson 4) BEFORE any spawn. A 0.0.0.0 / routable / unparseable address fails closed.
    const hp = parseTemporalHostPort(deps.address);
    if (hp === null || !isLoopbackHost(hp.host)) {
      return err(temporalFault("TEMPORAL_NON_LOOPBACK", "temporal address is not loopback"));
    }
    // Call-once: a second start() would orphan the running process. Fail closed on re-entry.
    if (started) return err(temporalFault("TEMPORAL_ALREADY_STARTED", "temporal supervisor already started"));
    started = true;

    const spawnFault = spawnOnce();
    if (spawnFault !== null) return err(spawnFault);

    // Bounded, iteration-based poll (no wall-clock — deterministic): at most ceil(timeout / interval) probes.
    const maxPolls = Math.max(1, Math.ceil(readinessTimeoutMs / Math.max(1, probeIntervalMs)));
    for (let i = 0; i < maxPolls; i++) {
      if (disposing) break;
      let ready = false;
      try {
        ready = await deps.probe(deps.address);
      } catch {
        ready = false;
      }
      if (disposing) break; // a dispose that landed while the probe was in flight must not report success
      if (ready) return { ok: true, value: { address: deps.address } };
      if (i < maxPolls - 1) await deps.sleep(probeIntervalMs);
    }
    // Never became ready (or disposed mid-startup) — fail closed and clean up the process we spawned.
    await dispose();
    return err(temporalFault("TEMPORAL_NOT_READY", "temporal dev-server did not become ready in time"));
  };

  return { start, dispose };
}

// ── the imperative seams (integration-gated — never in the default unit suite) ────────────────────

/** A minimal spawn contract (the subset of `node:child_process.spawn` the real spawner uses) — injectable for tests. */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly stdio: "ignore"; readonly detached: boolean },
) => {
  on: (event: "error", cb: () => void) => void;
  once: (event: "exit", cb: (code: number | null, signal: string | null) => void) => void;
  kill: () => void;
};

/** A minimal recursive-mkdir contract (the subset of `node:fs.mkdirSync` the real spawner uses) — injectable for tests. */
export type MkdirImpl = (dir: string, options: { readonly recursive: true }) => void;

/** Options for the real Temporal spawner. */
export interface TemporalSpawnerOptions {
  /** The persistent SQLite db file (`<userData>/temporal/dev.db`) — REQUIRED so the server is never in-memory (§13). */
  readonly dbFilename: string;
  /** The temporal binary (an absolute/resolved path preferred; a PATH name otherwise). Defaults to "temporal". */
  readonly binary?: string;
  /** Extra args after the base `server start-dev …` args. */
  readonly extraArgs?: readonly string[];
  /** Injected spawn impl (tests pass a mock so the suite NEVER spawns a real Temporal). Defaults to node spawn. */
  readonly spawnImpl?: SpawnImpl;
  /** Injected mkdir impl (tests pass a mock so the suite NEVER writes real fs). Defaults to node mkdirSync. */
  readonly mkdirImpl?: MkdirImpl;
}

/**
 * The REAL spawner: `temporal server start-dev --ip <loopback> --port <port> --db-filename <path>` as
 * a long-lived child. Args-array + resolved binary (NO shell string interpolation — no injection
 * surface; Lesson 10 analog). Creates the db's parent dir (`<userData>/temporal/`) recursively BEFORE
 * spawn (created-if-absent) via the injected mkdir seam — so a fresh install's missing dir doesn't
 * fail the launch. stdio IGNORED (never piped to a log sink — the child's output may echo a path/host;
 * §16 / safety 7). Integration-gated; not unit-tested with the real node spawn/fs (it would start a real server).
 */
export function createTemporalSpawner(options: TemporalSpawnerOptions): TemporalSpawner {
  const dbFilename = options.dbFilename;
  const binary = options.binary ?? "temporal";
  const extraArgs = options.extraArgs ?? [];
  const spawnImpl: SpawnImpl = options.spawnImpl ?? (nodeSpawn as unknown as SpawnImpl);
  const mkdirImpl: MkdirImpl = options.mkdirImpl ?? ((dir, opts) => void nodeMkdirSync(dir, opts));
  return (address: string): TemporalHandle => {
    // Persistent storage stays on even off the parseable-address path: the db is address-independent,
    // so a start-dev is NEVER built without --db-filename (no in-memory fallback).
    const hp = parseTemporalHostPort(address);
    const baseArgs =
      hp !== null ? temporalServerArgs(hp.host, hp.port, dbFilename) : ["server", "start-dev", "--db-filename", dbFilename];
    const args = [...baseArgs, ...extraArgs];
    // Create the persistent-db parent dir if absent (created-if-absent) before spawn.
    try {
      mkdirImpl(dirname(dbFilename), { recursive: true });
    } catch {
      // best-effort — a mkdir fault (e.g. a race) must not throw out of the spawner; temporal will surface its own.
    }
    const child = spawnImpl(binary, args, { env: { ...process.env }, stdio: "ignore", detached: false });
    child.on("error", () => {}); // swallow ENOENT (missing binary) so it never becomes an unhandled 'error'
    return {
      onExit: (cb) => {
        child.once("exit", (code, signal) => cb({ code, signal }));
      },
      kill: () => {
        try {
          child.kill();
        } catch {
          // already dead — ignore
        }
      },
    };
  };
}

/**
 * The REAL readiness probe: a TCP connect to the loopback Temporal frontend. A successful connect ⇒
 * the gRPC frontend is listening (ready enough for boot's `connectTemporal` to take over). A refused
 * connection / timeout ⇒ not ready. Never throws. Integration-gated (opens a real socket).
 */
export function createTemporalProbe(options?: { readonly timeoutMs?: number }): TemporalProbe {
  const timeoutMs = options?.timeoutMs ?? 2000;
  return (address: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const hp = parseTemporalHostPort(address);
      if (hp === null) {
        resolve(false);
        return;
      }
      const socket = netConnect({ host: hp.host, port: Number(hp.port) });
      const finish = (ok: boolean): void => {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        finish(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        finish(false);
      });
    });
}

/** The real sleep seam (setTimeout) for the supervisor's readiness poll. */
export function realTemporalSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
