// Task 9.4b (D4) — the worker-child supervisor (main process).
//
// Main forks the built worker-host as a background child, injects the launch config
// over the child IPC channel (token/allowlist/port — NEVER env/argv), waits for its
// `ready`, and RESTARTS it (bounded backoff) if it exits. The fork + timer are
// INJECTED so the lifecycle is unit-tested without spawning a real process; the
// Electron glue (system-node execPath + --conditions + loader paths) lives in
// index.ts and is exercised by launching the app.
import type { WorkerConnection } from "./worker-launch";

/** The config main injects into the worker-host child over IPC (mirrors worker-host/index.ts). */
export interface WorkerHostConfig {
  readonly token: string;
  readonly launchId: string;
  readonly origins: readonly string[];
  readonly hosts: readonly string[];
  readonly apiHost: string;
  readonly apiPort: number;
  readonly dbPath?: string;
  readonly vaultRoot?: string;
  /** OPEN-THE-GATES auto-ingest opt-in (owner env; default OFF) + its config — mirrors worker-host/index.ts. */
  readonly autoIngest?: boolean;
  readonly ingestWorkspaceId?: string;
  readonly temporalAddress?: string;
  /** Path-β subscription-extraction arming (owner env; default OFF/dormant). PLAIN DATA only — the fork IPC
   *  channel cannot carry the makeCompletion/checkReachable thunks (§19.5); bootWorker supplies those. */
  readonly subscriptionArm?: { readonly enabled?: boolean; readonly model?: string };
  /** §5 egress-processor allowlist forwarded into the auto-ingest proof-spine EgressPolicy (18.31); default absent ⇒ []. */
  readonly egressAllowedProcessors?: readonly string[];
  /** 11.3a — the resolved `config/gbrain.pin` path (packaged vs dev; see main/gbrain-pin-path.ts), forwarded
   *  to bootWorker's `gbrainStartupVerify.pinPath`. Default absent ⇒ the startup verify never runs (today's
   *  degraded boot, byte-equivalent). Mirrors worker-host/index.ts. */
  readonly gbrainPinPath?: string;
}

/** The minimal child-process surface the supervisor drives (a real fork or a fake). */
export interface WorkerChild {
  send(msg: unknown): void;
  on(event: "message", cb: (msg: unknown) => void): void;
  on(event: "exit", cb: (code: number | null) => void): void;
  kill(signal?: string): void;
}

/** The loopback connection + token the renderer needs to reach the worker. */
export interface WorkerHostConnection extends WorkerConnection {
  readonly token: string;
}

/**
 * `worker_down` is the CRASH-LOOP terminal state: the supervisor has stopped
 * respawning because the worker failed too many times inside the rolling window.
 * Distinct from `stopped` (a deliberate `stop()`), because the operator needs to
 * tell "I turned it off" apart from "it gave up".
 */
export type WorkerStatus = "starting" | "ready" | "restarting" | "stopped" | "worker_down";

export interface SupervisorDeps {
  /** Fork the worker-host child (system node + --conditions + resolve-loader). Injected. */
  readonly fork: () => WorkerChild;
  /** The config injected on each (re)spawn. */
  readonly config: WorkerHostConfig;
  /** The pinned loopback URLs the renderer targets (token added by connection()). */
  readonly connection: WorkerConnection;
  /** Schedule a restart after `ms`; returns a canceler. Injected for deterministic tests. */
  readonly scheduleRestart: (ms: number, run: () => void) => () => void;
  /** Optional structured log sink (main's redaction-safe logger / console). */
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
  /**
   * Monotonic-ish millisecond clock for the crash-loop window. INJECTED so the guard
   * is deterministically testable — a wall-clock read here would make the terminal
   * state untestable without sleeping. Defaults to `Date.now`.
   */
  readonly now?: () => number;
}

export interface WorkerSupervisor {
  start(): void;
  stop(): void;
  /** The static loopback connection + session token (the port is pinned, so always known). */
  connection(): WorkerHostConnection;
  status(): WorkerStatus;
}

const RESTART_BASE_MS = 500;
const RESTART_CAP_MS = 10_000;

/**
 * CRASH-LOOP GUARD (task 10.4 / LIFE — the infinite-respawn defect).
 *
 * ⛔ WHAT WAS WRONG. This supervisor incremented `attempt`, backed off, and respawned
 * — FOREVER. The backoff caps at 10s, so a worker that can never start (bad config, a
 * missing binary, a corrupt store) was restarted every 10 seconds for the life of the
 * app, and the UI never left `restarting`. There was no threshold and no terminal
 * state: the one condition an operator most needs told them nothing.
 *
 * ⚠ DELIBERATE DUPLICATION, and the reason matters. `apps/worker`'s
 * `decideRestart` (`lifecycle/supervision-policy.ts`) is the canonical statement of
 * this policy and is a pure function — but Electron MAIN cannot import it: desktop
 * LESSON 17 keeps `@sow/worker` EXTERNAL from the main bundle, and a runtime
 * `@sow/worker` import there resolves to raw `.ts` and crashes at load. The same
 * trade already exists one function down (`restartBackoffMs` mirrors
 * `supervisionBackoffMs`), so this follows the established precedent rather than
 * inventing a new one.
 * ⇒ THE TWO MUST AGREE. Both implement: count crashes strictly INSIDE the rolling
 * window, and at `>= threshold` stop respawning and report `worker_down`. If either
 * side's policy changes, change both.
 */
const CRASH_LOOP_THRESHOLD = 5;
const CRASH_LOOP_WINDOW_MS = 60_000;

/** Bounded exponential backoff for restart attempt `attempt` (>= 1). Never 0, never unbounded. */
export function restartBackoffMs(attempt: number): number {
  const a = Math.max(1, Math.floor(attempt));
  const exp = Math.min(a - 1, 20); // cap the exponent so Math.pow can't overflow
  return Math.min(RESTART_BASE_MS * 2 ** exp, RESTART_CAP_MS);
}

function isReadyMessage(msg: unknown): msg is { type: "ready"; port: number } {
  return typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "ready";
}

function isErrorMessage(msg: unknown): msg is { type: "error"; message: string } {
  return typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "error";
}

/** Build the supervisor. `start()` forks + injects config; exits trigger bounded-backoff restarts. */
export function createWorkerSupervisor(deps: SupervisorDeps): WorkerSupervisor {
  const log = deps.log ?? ((): void => {});
  const now = deps.now ?? ((): number => Date.now());
  let child: WorkerChild | null = null;
  let stopped = false;
  let attempt = 0;
  let status: WorkerStatus = "stopped";
  let cancelTimer: (() => void) | null = null;
  /** Crash timestamps inside the rolling window (oldest first). */
  const crashes: number[] = [];

  const spawn = (): void => {
    if (stopped) return;
    status = attempt === 0 ? "starting" : "restarting";
    const current = deps.fork();
    child = current;

    current.on("message", (msg: unknown) => {
      if (isReadyMessage(msg)) {
        status = "ready";
        attempt = 0;
        log("worker.ready", { port: msg.port });
      } else if (isErrorMessage(msg)) {
        log("worker.error", { message: msg.message });
      }
    });

    current.on("exit", (code: number | null) => {
      // Ignore a post-stop exit or an exit from a stale (already-replaced) child.
      if (stopped || current !== child) return;
      log("worker.exit", { code });

      // CRASH-LOOP GUARD. Record this crash, drop the ones that have rolled off the
      // window, and stop respawning once the window holds `CRASH_LOOP_THRESHOLD`.
      const nowMs = now();
      crashes.push(nowMs);
      const windowStart = nowMs - CRASH_LOOP_WINDOW_MS;
      while (crashes.length > 0 && crashes[0]! <= windowStart) crashes.shift();

      if (crashes.length >= CRASH_LOOP_THRESHOLD) {
        // TERMINAL: decline to respawn and say so. Previously this branch did not
        // exist and the worker was restarted forever with the UI stuck on
        // `restarting` — a permanent failure rendered as a transient one.
        stopped = true;
        child = null;
        status = "worker_down";
        log("worker.down", {
          reason: "crash_loop",
          crashes: crashes.length,
          windowMs: CRASH_LOOP_WINDOW_MS,
          threshold: CRASH_LOOP_THRESHOLD,
        });
        return;
      }

      attempt += 1;
      status = "restarting";
      cancelTimer = deps.scheduleRestart(restartBackoffMs(attempt), spawn);
    });

    current.send({ type: "config", config: deps.config });
  };

  return {
    start(): void {
      stopped = false;
      attempt = 0;
      crashes.length = 0; // a deliberate restart clears the crash-loop history
      spawn();
    },
    stop(): void {
      stopped = true;
      status = "stopped";
      if (cancelTimer) {
        cancelTimer();
        cancelTimer = null;
      }
      if (child) {
        child.kill("SIGTERM");
        child = null;
      }
    },
    connection: (): WorkerHostConnection => ({ ...deps.connection, token: deps.config.token }),
    status: (): WorkerStatus => status,
  };
}
