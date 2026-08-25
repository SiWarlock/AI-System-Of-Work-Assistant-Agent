// Scratch-gbrain harness (task 12.7 / 12.22 — the eval-side, real-binary acceptance suites).
//
// Spins up a DISPOSABLE, fully-isolated gbrain instance for a live conformance test: a brand
// new PGLite database under a temp `GBRAIN_HOME` (gbrain's own write-isolation override — see
// the installed gbrain's `gbrain-home-isolation.test.ts`), NEVER the developer's real
// `~/.gbrain` brain. Every helper here is LOCAL-ONLY exec (fixed argv, `shell:false`, bounded
// timeout) mirroring the production safety pattern in
// `packages/knowledge/src/gbrain/gbrain-version-probe.ts` — no shell-string interpolation, no
// unbounded hang.
//
// ⛔ SAFETY INVARIANT this module exists to uphold: a mutating eval MUST NEVER point at the
// default brain. Every helper below takes an explicit `home` (the scratch `GBRAIN_HOME`) and
// threads it into the child's environment; nothing here ever execs `gbrain` without it.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const execFileAsync = promisify(execFile);

/** Default bounded timeout for a one-shot `gbrain` CLI invocation (init/doctor/extract). A
 *  non-`--fast` `doctor` call round-trips a real embedding-provider network probe (measured
 *  live in this session at ~30s against BOTH a scratch and the real brain), so this carries
 *  real headroom above that. */
export const SCRATCH_GBRAIN_EXEC_TIMEOUT_MS = 45_000;
const MAX_BUFFER = 4 * 1024 * 1024;

/** Create a fresh temp dir to use as an isolated `GBRAIN_HOME` (never the real `~/.gbrain`). */
export async function mkScratchGbrainHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sow-eval-gbrain-home-"));
}

/** Recursively remove a scratch `GBRAIN_HOME` (best-effort; never throws). */
export async function rmScratchGbrainHome(home: string): Promise<void> {
  try {
    await rm(home, { recursive: true, force: true });
  } catch {
    // best-effort teardown — a leftover temp dir is not a correctness issue.
  }
}

/**
 * `gbrain init --pglite` scoped to `home` via `GBRAIN_HOME` — creates a brand-new, empty
 * PGLite brain under `<home>/.gbrain`. Fixed argv, `shell:false`, bounded timeout.
 */
export async function initScratchBrain(home: string): Promise<void> {
  await execFileAsync("gbrain", ["init", "--pglite"], {
    env: { ...process.env, GBRAIN_HOME: home },
    timeout: SCRATCH_GBRAIN_EXEC_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    shell: false,
    windowsHide: true,
  });
}

/** Bind to loopback port 0 to obtain an OS-assigned free port, then release it. */
export async function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("could not determine an assigned loopback port"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

export interface ScratchGbrainServeHandle {
  readonly baseUrl: string;
  readonly port: number;
  /** SIGTERM the server and await its exit (best-effort; never throws). */
  readonly stop: () => Promise<void>;
}

/**
 * Start a REAL `gbrain serve --http --enable-dcr` bound to loopback, scoped to `home` via
 * `GBRAIN_HOME` — the HTTP MCP + OAuth 2.1 transport (never stdio `gbrain serve`, which has no
 * scope gate at all — the design invariant `packages/knowledge/src/gbrain/write-fence.ts`
 * encodes). Polls `/health` until the server answers or `readyTimeoutMs` elapses.
 */
export async function startScratchGbrainHttpServe(
  home: string,
  opts?: { readonly port?: number; readonly readyTimeoutMs?: number },
): Promise<ScratchGbrainServeHandle> {
  const port = opts?.port ?? (await findFreeLoopbackPort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const readyTimeoutMs = opts?.readyTimeoutMs ?? 20_000;

  const child: ChildProcess = spawn(
    "gbrain",
    ["serve", "--http", "--port", String(port), "--enable-dcr"],
    {
      env: { ...process.env, GBRAIN_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    },
  );

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error("scratch gbrain serve --http exited before becoming ready");
    }
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (res.status >= 200 && res.status < 500) {
        ready = true;
        break;
      }
    } catch {
      // not up yet — retry until the deadline.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) {
    child.kill("SIGTERM");
    throw new Error(`scratch gbrain serve --http did not become ready within ${readyTimeoutMs}ms`);
  }

  const stop = async (): Promise<void> => {
    if (exited) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      // hard-kill fallback so a stuck teardown never hangs the suite.
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 5_000);
    });
  };

  return { baseUrl, port, stop };
}

/**
 * Best-effort extract the JSON object from `gbrain doctor --json` / `gbrain extract --json`
 * stdout: both commands emit human-readable progress lines to stdout THEN the JSON result —
 * but the TWO commands were live-verified this session to format it DIFFERENTLY: `doctor
 * --json` emits compact single-line JSON as its final line, while `extract ... --json` emits
 * PRETTY-PRINTED multi-line JSON as its final block. Handles both: (1) fast path — the last
 * non-empty line alone parses (the compact case); (2) fallback — walk backward for the last
 * line that is exactly `{` (a pretty-printed object's opening line) and parse from there to
 * EOF. Anything else fails closed to `undefined` rather than risk parsing a progress line that
 * happens to look JSON-shaped. Never throws.
 */
function extractLastJsonObject(stdout: string): Record<string, unknown> | undefined {
  const asObject = (v: unknown): Record<string, unknown> | undefined =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

  const lines = stdout.split(/\r?\n/);
  const nonEmpty = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  const last = nonEmpty.at(-1);
  if (last !== undefined) {
    try {
      const compact = asObject(JSON.parse(last));
      if (compact !== undefined) return compact;
    } catch {
      // not the compact single-line case — fall through to the pretty-printed scan.
    }
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.trim() !== "{") continue;
    try {
      const pretty = asObject(JSON.parse(lines.slice(i).join("\n").trim()));
      if (pretty !== undefined) return pretty;
    } catch {
      // this "{" line's suffix didn't parse — keep scanning further back for an earlier one.
    }
  }
  return undefined;
}

export interface GbrainDoctorCheck {
  readonly name: string;
  readonly status: string;
  readonly message?: string;
}

export interface GbrainDoctorResult {
  readonly raw: Record<string, unknown>;
  readonly checks: readonly GbrainDoctorCheck[];
}

/** Run a REAL `gbrain doctor --json` scoped to `home`, parsed into typed checks. Fail-closed to `undefined` (never throws). */
export async function runScratchGbrainDoctor(
  home: string,
  opts?: { readonly fast?: boolean },
): Promise<GbrainDoctorResult | undefined> {
  const args = ["doctor", "--json", ...(opts?.fast === true ? ["--fast"] : [])];
  try {
    const { stdout } = await execFileAsync("gbrain", args, {
      env: { ...process.env, GBRAIN_HOME: home },
      timeout: SCRATCH_GBRAIN_EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      shell: false,
      windowsHide: true,
    });
    const raw = extractLastJsonObject(stdout);
    if (raw === undefined) return undefined;
    const rawChecks = raw["checks"];
    const checks: GbrainDoctorCheck[] = Array.isArray(rawChecks)
      ? rawChecks
          .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object")
          .map((c) => ({
            name: String(c["name"]),
            status: String(c["status"]),
            ...(typeof c["message"] === "string" ? { message: c["message"] } : {}),
          }))
      : [];
    return { raw, checks };
  } catch {
    return undefined;
  }
}

/**
 * Run a REAL `gbrain extract links --source fs --dry-run --json` over a LOCAL markdown
 * fixture directory — read-only, no DB, no embedding call (the design doc's named
 * "corroborating cross-check oracle", `docs/design/gbrain-write-through-divergence.md` §3).
 * Does NOT need a `GBRAIN_HOME` / initialized brain — `--source fs` walks the files directly.
 */
export async function runFsExtractLinksDryRun(
  fixtureDir: string,
): Promise<{ readonly links_created: number; readonly pages_processed: number } | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "gbrain",
      ["extract", "links", "--source", "fs", "--dir", fixtureDir, "--dry-run", "--json"],
      { timeout: SCRATCH_GBRAIN_EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, shell: false, windowsHide: true },
    );
    const raw = extractLastJsonObject(stdout);
    if (raw === undefined) return undefined;
    const linksCreated = raw["links_created"];
    const pagesProcessed = raw["pages_processed"];
    if (typeof linksCreated !== "number" || typeof pagesProcessed !== "number") return undefined;
    return { links_created: linksCreated, pages_processed: pagesProcessed };
  } catch {
    return undefined;
  }
}

/** `gbrain --version` stdout, trimmed. Fail-closed to `undefined` (never throws). */
export async function runGbrainVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("gbrain", ["--version"], {
      timeout: 10_000,
      maxBuffer: MAX_BUFFER,
      shell: false,
      windowsHide: true,
    });
    const t = stdout.trim();
    return t.length > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}
