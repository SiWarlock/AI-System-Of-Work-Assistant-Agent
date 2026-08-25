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
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
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

/** The embedding dimension every scratch brain this harness creates is pinned to — matches the
 *  owner's real `~/.gbrain/config.json` (`embedding_dimensions: 1024`) and the `voyage-code-3`
 *  model's actual configured output width (Voyage only permits {256, 512, 1024, 2048} for that
 *  model — never gbrain's own `DEFAULT_EMBEDDING_DIMENSIONS = 1536` fallback). */
export const SCRATCH_EMBEDDING_DIMENSIONS = 1024;

/**
 * `gbrain init --pglite` scoped to `home` via `GBRAIN_HOME` — creates a brand-new, empty
 * PGLite brain under `<home>/.gbrain`. Fixed argv, `shell:false`, bounded timeout.
 *
 * ⛔ TRAP folded in here (confirmed live, task PAID-GO34-RETRY, 2026-08-25): a bare `gbrain init`
 * writes a FRESH `config.json` that OMITS `embedding_dimensions` entirely — confirmed by writing
 * the key into a config.json that already exists BEFORE `init` runs: `init` overwrites the file
 * unconditionally, the key does not survive. Without it, gbrain's pre-engine-connect
 * `configureGateway` (installed `gbrain` 0.35.1.0, `src/cli.ts:1334`) falls back to
 * `DEFAULT_EMBEDDING_DIMENSIONS = 1536` (`src/core/ai/gateway.ts:46`), and every `gbrain
 * put`/`embed` then fails closed with a Voyage API rejection ("voyage-code-3 supports
 * output_dimension only in {256,512,1024,2048}, got 1536") BEFORE any embedding is
 * computed/billed — the exact defect the owner's real `~/.gbrain/config.json` hit and was fixed
 * for by hand-adding the key. So a SCRATCH brain reproduces that trap cold unless something
 * patches it in — which is what this function now does, unconditionally, right after `init`, so
 * every scratch brain this harness creates is born correct rather than re-hitting it.
 *
 * ⚠ THIS FIX ALONE DOES NOT MAKE A FRESH SCRATCH `put`/`embed` SUCCEED (re-confirmed live the
 * same session — see the "GO#3/GO#4 paid-embedding leg" describe block in
 * `gbrain-four-go-acceptance.test.ts`). It only fixes the API-rejection layer above. A SEPARATE,
 * PGLite-specific defect remains, confirmed by reading the installed `gbrain` 0.35.1.0 source at
 * `/Users/dreddy/gbrain` (a different repo entirely — not fixed here, per root CLAUDE.md and this
 * package's territory): the embedded/PGLite schema (`src/core/schema-embedded.ts:139`) hardcodes
 * `embedding vector(1536)`, and — unlike the Postgres/Supabase engine path
 * (`src/core/postgres-engine.ts:57`, which regex-substitutes `vector(1536)` → `vector(${dims})`
 * at connect time) — the embedded/PGLite path never receives that substitution, REGARDLESS of
 * `--embedding-dimensions`/config value passed to `gbrain init --pglite`. So a fresh scratch
 * PGLite brain's `content_chunks.embedding` column is ALWAYS `vector(1536)`, while
 * `voyage-code-3` can only be configured to output {256,512,1024,2048} — no value satisfies
 * both. `put`/`embed` still fails, now one layer deeper: at the DB-insert step (pgvector:
 * "expected 1536 dimensions, not 1024") AFTER a real, billed Voyage call has already succeeded.
 */
export async function initScratchBrain(home: string): Promise<void> {
  await execFileAsync("gbrain", ["init", "--pglite"], {
    env: { ...process.env, GBRAIN_HOME: home },
    timeout: SCRATCH_GBRAIN_EXEC_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    shell: false,
    windowsHide: true,
  });

  const configPath = join(home, ".gbrain", "config.json");
  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw) as Record<string, unknown>;
  config["embedding_dimensions"] = SCRATCH_EMBEDDING_DIMENSIONS;
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

/** Outcome of a real `gbrain put` — deliberately fail-closed to a typed result (never throws) so a
 *  caller can assert on EITHER outcome (the embed-path defect this call exists to probe currently
 *  makes every real `put` fail; a caller pins that fact rather than the helper masking it). */
export interface PutScratchPageResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `gbrain put <slug> --content <md>` scoped to `home` via `GBRAIN_HOME` — a REAL page write that
 * chunks + embeds (a REAL paid Voyage embedding-API call per `gbrain put --help`: "Chunks, embeds,
 * reconciles tags..."). Fixed argv, `shell:false`, bounded timeout, `content` passed as a single
 * argv element (never shell-interpolated). Callers MUST gate this behind `SOW_GBRAIN_LIVE=1` and an
 * explicit owner cost authorization — see this package's `gbrain-four-go-acceptance.test.ts` header.
 */
export async function putScratchBrainPage(
  home: string,
  slug: string,
  content: string,
): Promise<PutScratchPageResult> {
  try {
    const { stdout, stderr } = await execFileAsync("gbrain", ["put", slug, "--content", content], {
      env: { ...process.env, GBRAIN_HOME: home },
      timeout: SCRATCH_GBRAIN_EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      shell: false,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr };
  } catch (cause) {
    const asExecError = cause as { readonly stdout?: string; readonly stderr?: string };
    return {
      ok: false,
      stdout: asExecError.stdout ?? "",
      stderr: asExecError.stderr ?? (cause instanceof Error ? cause.message : String(cause)),
    };
  }
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

export interface ScratchImportResult {
  readonly imported: number;
  readonly skipped: number;
  readonly errors: number;
  readonly chunks: number;
}

/**
 * `gbrain import <fixtureDir> --no-embed --json` scoped to `home` via `GBRAIN_HOME` — a REAL
 * page write into the scratch brain's DB that makes ZERO embedding-API calls (`--no-embed`
 * chunks the content but skips the embed step — live-verified: no Voyage network call is made,
 * `chunks` still reports the chunk count, `imported`/`errors` reflect the real DB write).
 * Extends the GO#4 fs-extract oracle leg (task PAID-GO34-RETRY) from a
 * read-only fs walk to a real DB round-trip, without touching the paid-embedding path.
 * Fail-closed to `undefined` (never throws).
 */
export async function runScratchGbrainImportNoEmbed(
  home: string,
  fixtureDir: string,
): Promise<ScratchImportResult | undefined> {
  try {
    const { stdout } = await execFileAsync("gbrain", ["import", fixtureDir, "--no-embed", "--json"], {
      env: { ...process.env, GBRAIN_HOME: home },
      timeout: SCRATCH_GBRAIN_EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      shell: false,
      windowsHide: true,
    });
    const raw = extractLastJsonObject(stdout);
    if (raw === undefined) return undefined;
    const imported = raw["imported"];
    const skipped = raw["skipped"];
    const errors = raw["errors"];
    const chunks = raw["chunks"];
    if (
      typeof imported !== "number" ||
      typeof skipped !== "number" ||
      typeof errors !== "number" ||
      typeof chunks !== "number"
    ) {
      return undefined;
    }
    return { imported, skipped, errors, chunks };
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
