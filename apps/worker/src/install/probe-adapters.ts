// Install-doctor REAL local probe adapters (task 11.5-a, §13).
//
// The concrete `execFile` / `net`-bind adapters behind the injected collector ports. Both are
// LOCAL-ONLY and NEVER throw across the seam (every fault → a typed outcome the collector
// fail-closes). The gated (SOW_DOCTOR_REAL) test exercises them against the real environment.
//
// EXEC SAFETY (the crux): `execFile` runs a bin + an argv ARRAY with NO shell (`shell:false`),
// so there is NO shell-string / command-injection surface; the argv is a per-probe CONSTANT
// supplied by the collector (never caller-interpolated). A bounded `timeout` + `maxBuffer` cap
// the run; a fault is reported as an errno-`code` ONLY (never the raw stderr / an absolute
// path that `e.message` would leak).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import type { RunCommand, ProbeLoopbackBind, CommandOutcome } from "./probe-collectors";

const execFileAsync = promisify(execFile);

/** Default per-command timeout (ms) — a `--version` / `git remote -v` returns fast. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
/** Default stdout cap (bytes) — a version string / remote list is tiny; cap defensively. */
export const DEFAULT_COMMAND_MAX_BUFFER = 1024 * 1024;

/** Map a thrown execFile error to a typed, REDACTED CommandOutcome (errno code only). */
function classifyExecError(e: unknown): CommandOutcome {
  const err = e as { code?: unknown; signal?: unknown };
  if (err.code === "ENOENT") return { ok: false, code: "not_found", message: "not_found" };
  // The timeout kills the child with `killSignal` (default SIGTERM); key on that / ETIMEDOUT
  // ONLY — a broad `killed===true` would mislabel a maxBuffer-overflow (ENOBUFS) or an
  // external SIGKILL as a timeout. Any fault still fails closed downstream (only `.ok` reads).
  if (err.code === "ETIMEDOUT" || err.signal === "SIGTERM") {
    return { ok: false, code: "timeout", message: "timeout" };
  }
  if (typeof err.code === "number") return { ok: false, code: "nonzero_exit", message: "nonzero_exit" };
  return { ok: false, code: "unknown", message: "unknown" };
}

/**
 * A REAL local-command runner over `node:child_process.execFile`: a fixed argv ARRAY, NO shell
 * (no injection surface), a bounded timeout + output cap. Never throws — every fault becomes a
 * typed, redacted {@link CommandOutcome}.
 */
export function createLocalCommandRunner(opts?: {
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}): RunCommand {
  const timeout = opts?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxBuffer = opts?.maxBufferBytes ?? DEFAULT_COMMAND_MAX_BUFFER;
  return async (req) => {
    try {
      // Default (no `encoding`) ⇒ execFile resolves stdout as a decoded UTF-8 string.
      const { stdout } = await execFileAsync(req.bin, [...req.args], {
        timeout,
        maxBuffer,
        cwd: req.cwd,
        shell: false,
        windowsHide: true,
      });
      return { ok: true, stdout };
    } catch (e) {
      return classifyExecError(e);
    }
  };
}

/**
 * A REAL loopback bind probe: attempts an EXCLUSIVE bind on `127.0.0.1:<port>` (loopback only),
 * releasing it immediately on success. Bound ⇒ bindable; an EADDRINUSE / EACCES / any bind
 * error ⇒ not bindable (assume-worst). Never throws (always resolves).
 */
export function createLoopbackBindProbe(): ProbeLoopbackBind {
  return (port) =>
    new Promise((resolve) => {
      let settled = false;
      let server: ReturnType<typeof createServer> | undefined;
      const finish = (bindable: boolean): void => {
        if (settled) return;
        settled = true;
        try {
          server?.close();
        } catch {
          // best-effort release — a close fault must not reject the probe.
        }
        resolve({ bindable });
      };
      try {
        server = createServer();
        server.once("error", () => finish(false)); // EADDRINUSE / EACCES → not bindable
        // Loopback-only (host 127.0.0.1) + exclusive (never share the port with another handle).
        server.listen({ port, host: "127.0.0.1", exclusive: true }, () => finish(true));
      } catch {
        // A SYNCHRONOUS throw (e.g. RangeError ERR_SOCKET_BAD_PORT for an out-of-range port)
        // fails CLOSED to not-bindable — the probe ALWAYS resolves (§16), never rejects.
        finish(false);
      }
    });
}
