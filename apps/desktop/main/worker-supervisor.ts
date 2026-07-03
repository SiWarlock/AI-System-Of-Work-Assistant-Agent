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

export type WorkerStatus = "starting" | "ready" | "restarting" | "stopped";

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
  let child: WorkerChild | null = null;
  let stopped = false;
  let attempt = 0;
  let status: WorkerStatus = "stopped";
  let cancelTimer: (() => void) | null = null;

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
