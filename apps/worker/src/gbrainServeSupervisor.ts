// Option A (app-managed serve) SS1 — the gbrain-serve supervisor.
//
// The agentic Copilot tools + the "http" retrieval transport both read a running `gbrain serve --http
// --enable-dcr` (one process owns the PGlite DB; readers go over loopback HTTP — the mandated transport). This
// supervisor OWNS that process's lifecycle: spawn it, poll until it is ready, restart it on an unexpected crash
// (bounded), and tear it down on shutdown. It yields the ready base URL that boot points the http transports at.
//
// Split for TDD: the DETERMINISTIC core (`createGbrainServeSupervisor` — the spawn→ready→restart→dispose state
// machine over an INJECTED spawner / probe / sleep) is unit-tested; the imperative seams (`createGbrainServeSpawner`
// via child_process, `createGbrainServeProbe` via fetch) are integration-gated (never in the default suite,
// mirroring `createGbrainCliExec`). Fail-closed + redaction-safe (a spawn/probe fault yields only a stable code —
// never the child's stderr, which could echo a path/host); NEVER throws.
//
// ⚠ BIND-INTERFACE RESIDUAL (rule 5 / rule 4 — documented, not fully closable here): `gbrain serve --http`
// exposes `--port` but NO `--host`/bind-interface flag (verified against the gbrain CLI). So this supervisor
// forces the PORT (parsed from baseUrl) but CANNOT force the server's bind interface — that is gbrain's default,
// which is loopback (DEFAULT_GBRAIN_HTTP_URL=127.0.0.1 + gbrain's local-brain design). We enforce loopback on
// EVERY surface we own — `start()` refuses a non-loopback baseUrl, and the client transports (copilotGbrainHttp)
// loopback-guard before any request — but a hostile/upgraded gbrain that binds 0.0.0.0 would still expose the DCR
// MCP server to the LAN. Mitigation beyond our control: run on a host without an untrusted LAN, or a firewall
// rule; a gbrain `--host` flag is the real fix (upstream). Surface this to the owner before a shared-network deploy.
import { spawn as nodeSpawn } from "node:child_process";
import { err, failure } from "@sow/contracts";
import type { Result, FailureVariant } from "@sow/contracts";
import { isLoopbackUrl } from "./api/procedures/copilotGbrainHttp";

/** Parse the port out of a base url (`http://127.0.0.1:8899` → "8899"), or null if none/unparseable. */
function portOf(baseUrl: string): string | null {
  try {
    const p = new URL(baseUrl).port;
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

/** A handle to a spawned serve process — register an exit callback + kill it. The real impl wraps a ChildProcess. */
export interface GbrainServeHandle {
  /** Register the (single) exit callback; fires once when the process exits. */
  readonly onExit: (cb: (info: { readonly code: number | null; readonly signal: string | null }) => void) => void;
  /** Terminate the process. Idempotent — safe to call more than once. */
  readonly kill: () => void;
}

/** Injected: spawn a `gbrain serve --http --enable-dcr` bound to `baseUrl`. Real impl = `createGbrainServeSpawner`. */
export type GbrainServeSpawner = (baseUrl: string) => GbrainServeHandle;

/** Injected: probe whether the serve at `baseUrl` is ready. Real impl = `createGbrainServeProbe` (fetch). */
export type GbrainServeProbe = (baseUrl: string) => Promise<boolean>;

/** Injected sleep between readiness probes (real impl = setTimeout; tests inject an immediate resolver). */
export type Sleep = (ms: number) => Promise<void>;

/** Construction deps: the base url to serve at + the three injectable seams + bounded timing/restart knobs. */
export interface GbrainServeSupervisorDeps {
  /** The loopback base url the serve binds (e.g. `http://127.0.0.1:8899`); the http transports read `${base}/mcp`. */
  readonly baseUrl: string;
  readonly spawn: GbrainServeSpawner;
  readonly probe: GbrainServeProbe;
  readonly sleep: Sleep;
  /** Max time to wait for first-ready before failing closed. Default 30_000. */
  readonly readinessTimeoutMs?: number;
  /** Delay between readiness probes. Default 500. */
  readonly probeIntervalMs?: number;
  /** Max unexpected-crash respawns before giving up (post-ready crashes just let the exec fail closed). Default 3. */
  readonly maxRestarts?: number;
}

export interface GbrainServeSupervisor {
  /** Spawn the serve + wait until ready (probe true) or the readiness timeout. Fail-closed; never throws. */
  readonly start: () => Promise<Result<{ readonly baseUrl: string }, FailureVariant>>;
  /** Kill the process + stop restart-on-crash. Idempotent; never throws. */
  readonly dispose: () => Promise<void>;
}

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_INTERVAL_MS = 500;
const DEFAULT_MAX_RESTARTS = 3;

function serveFault(code: string, message: string): FailureVariant {
  // Redaction-safe: a stable code only — never the child's stderr / the resolved path / host.
  return failure("degraded_unavailable", message, { retryable: true, cause: { code } });
}

/**
 * Build the supervisor over the injected seams. `start()` spawns + polls until ready; an unexpected exit BEFORE
 * dispose respawns (bounded by `maxRestarts`); `dispose()` kills the process and permanently stops respawning.
 * All state is closure-local. Pure w.r.t. its injected seams; NEVER throws (spawn/probe faults fail closed).
 */
export function createGbrainServeSupervisor(deps: GbrainServeSupervisorDeps): GbrainServeSupervisor {
  const readinessTimeoutMs = deps.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const probeIntervalMs = deps.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const maxRestarts = deps.maxRestarts ?? DEFAULT_MAX_RESTARTS;

  let disposing = false;
  let started = false;
  let restarts = 0;
  let handle: GbrainServeHandle | undefined;

  // Spawn once + wire restart-on-crash. Returns a spawn fault (redaction-safe) if the spawner itself throws.
  const spawnOnce = (): FailureVariant | null => {
    let h: GbrainServeHandle;
    try {
      h = deps.spawn(deps.baseUrl);
    } catch {
      return serveFault("GBRAIN_SERVE_SPAWN_FAILED", "gbrain serve failed to spawn");
    }
    handle = h;
    h.onExit(() => {
      // A DISPOSE-driven exit must never respawn; an unexpected crash respawns up to the LIFETIME bound
      // (`restarts` is cumulative, never reset — after `maxRestarts` total crashes the supervisor gives up and
      // the http exec fails closed; a backoff + reset-on-sustained-uptime is a deferred robustness follow-up).
      if (disposing) return;
      if (restarts >= maxRestarts) return;
      restarts += 1;
      // A respawn-time spawn fault is intentionally swallowed here (onExit can't return it): `handle` is left at
      // the dead process, probes fail, and the path degrades fail-closed — no throw, no signal to surface.
      spawnOnce();
    });
    return null;
  };

  const dispose = async (): Promise<void> => {
    // Sets `disposing` FIRST so the kill-triggered onExit reads it and does not respawn. NOTE: fire-and-forget —
    // dispose does not await the child's actual exit, so a dispose-then-immediate-start on the SAME port could
    // race the OS port release. The boot lifecycle is start-once-at-boot / dispose-at-shutdown (no rapid restart),
    // so this is an accepted tradeoff; a bounded await-exit (+ SIGTERM→SIGKILL escalation) is a robustness follow-up.
    disposing = true;
    try {
      handle?.kill();
    } catch {
      // ignore — a kill on an already-dead process must never throw out of dispose.
    }
    handle = undefined;
  };

  const start = async (): Promise<Result<{ readonly baseUrl: string }, FailureVariant>> => {
    // Rule 5 / defense-in-depth: NEVER spawn or probe a non-loopback serve. The client transports also
    // loopback-guard; this guards the server WE manage. Fail closed BEFORE any spawn/probe.
    if (!isLoopbackUrl(deps.baseUrl)) {
      return err(serveFault("GBRAIN_SERVE_NON_LOOPBACK", "gbrain serve base url is not loopback"));
    }
    // Call-once: a second start() would orphan the running process (dispose only kills the CURRENT handle) and
    // leave its onExit wired (a later crash of the orphan could phantom-respawn). Fail closed on re-entry.
    if (started) return err(serveFault("GBRAIN_SERVE_ALREADY_STARTED", "gbrain serve supervisor already started"));
    started = true;

    const spawnFault = spawnOnce();
    if (spawnFault !== null) return err(spawnFault);

    // Bounded, iteration-based poll (no wall-clock — deterministic + no Date.now()): at most
    // ceil(timeout / interval) probes. A probe that throws counts as not-ready (fail-closed), never propagates.
    const maxPolls = Math.max(1, Math.ceil(readinessTimeoutMs / Math.max(1, probeIntervalMs)));
    for (let i = 0; i < maxPolls; i++) {
      if (disposing) break; // a dispose before/between probes aborts the wait promptly
      let ready = false;
      try {
        ready = await deps.probe(deps.baseUrl);
      } catch {
        ready = false;
      }
      // Re-check AFTER the (awaited) probe: a dispose that landed while the probe was in flight must NOT report
      // success for a process we just killed.
      if (disposing) break;
      if (ready) return { ok: true, value: { baseUrl: deps.baseUrl } };
      if (i < maxPolls - 1) await deps.sleep(probeIntervalMs); // no trailing sleep on the last iteration
    }
    // Never became ready (or was disposed mid-startup) — fail closed and clean up the process we spawned.
    await dispose();
    return err(serveFault("GBRAIN_SERVE_NOT_READY", "gbrain serve did not become ready in time"));
  };

  return { start, dispose };
}

// ── the imperative seams (integration-gated — never in the default unit suite) ────────────────────────────────

/** Options for the real serve spawner. */
export interface GbrainServeSpawnerOptions {
  /** The gbrain binary (name on PATH or absolute). Defaults to "gbrain". */
  readonly binary?: string;
  /** Extra args after `serve --http --enable-dcr` (e.g. a `--port`), if the local gbrain needs them. */
  readonly extraArgs?: readonly string[];
}

/**
 * The REAL spawner: `gbrain serve --http --enable-dcr` as a long-lived child. Inherits the parent env (gbrain
 * needs VOYAGE_API_KEY for embeddings + its own DB path) MINUS a stale `GBRAIN_EMBEDDING_MODEL` override (same
 * hygiene as `createGbrainCliExec`). stdio is IGNORED (never piped to a log sink — the child's output may echo a
 * path/host; §16 / safety 7). Integration-gated; not unit-tested (it spawns a real server).
 */
export function createGbrainServeSpawner(options?: GbrainServeSpawnerOptions): GbrainServeSpawner {
  const binary = options?.binary ?? "gbrain";
  const extraArgs = options?.extraArgs ?? [];
  return (baseUrl: string): GbrainServeHandle => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env["GBRAIN_EMBEDDING_MODEL"];
    // Force the serve onto the SAME port the probe + transports read (parsed from baseUrl) so they can never
    // disagree. gbrain `serve --http` supports `--port` but NOT `--host` — see the header's BIND-INTERFACE
    // RESIDUAL: the bind interface is gbrain's (loopback) default, which we cannot override from a flag.
    const port = portOf(baseUrl);
    const portArgs = port !== null ? ["--port", port] : [];
    const child = nodeSpawn(binary, ["serve", "--http", "--enable-dcr", ...portArgs, ...extraArgs], {
      env,
      stdio: "ignore", // redaction-safe: never capture the child's stderr/stdout
      detached: false,
    });
    // Swallow spawn errors on the child object so an ENOENT (missing binary) never becomes an unhandled 'error'.
    child.on("error", () => {});
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
 * The REAL readiness probe: a serve that is LISTENING answers `${baseUrl}/mcp` with SOME HTTP status (even a 401
 * when DCR auth is required) — that is "ready" for our purposes (the http transports handle auth themselves). A
 * network error (connection refused before the port is up), a timeout, or an abort ⇒ not ready. Never throws.
 * Integration-gated. Loopback-only base urls are the only ones the transports accept, so no off-box probe.
 */
export function createGbrainServeProbe(options?: { readonly timeoutMs?: number }): GbrainServeProbe {
  const timeoutMs = options?.timeoutMs ?? 2000;
  return async (baseUrl: string): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Any resolved HTTP response means the port is up + serving; a thrown error means not-yet-listening.
      await fetch(`${baseUrl}/mcp`, { method: "GET", signal: controller.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The real sleep seam (setTimeout) for the supervisor's readiness poll. */
export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
