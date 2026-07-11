// @sow/worker — the REAL local-vault file-watcher capture trigger (make-it-real C3b).
//
// The make-it-real arc CAPSTONE + the Temporal Client's first real caller. A real
// node:fs watcher on the configured vault root turns a `.md` add/change into a captured
// `sourceIngestion` run, reusing the arc's already-real seams:
//
//   fs.watch(root) → [filter .md + debounce] → [REALPATH containment double-guard] →
//   C2 createFileReadTransport(root) → extractFileSource → RegisterSourceInput →
//   C3a dispatchSourceIngestion(trigger:"connector_event") → the live §9 workflow.
//
// Load-bearing invariants:
//   • WS-2 / REQ-F-017 (no inference) — `workspaceId`/`sensitivity` come from the
//     watcher's POLICY binding (a vault-per-workspace mapping); `sourceId` is derived
//     from (workspace, relative path). NOTHING is inferred from the file's content.
//   • ROOT-CONFINEMENT, double-guarded — the watcher pre-filters every event by the ONE
//     authoritative `isContainedUnder` predicate (imported from C2, not duplicated) over
//     realpath-resolved paths, so a symlink-escape is dropped BEFORE the read; the C2
//     transport then stays the authoritative read-confinement guard. Local FS path only.
//   • DEGRADED-SAFE (§16) — the capture handler NEVER throws across its boundary. A down
//     Temporal fails CLOSED through C3a (typed err + a surfaced worker_down health item),
//     an unreadable/empty file is a typed `extract_failed`, an escaping/absent path is a
//     typed `ignored` — never a crash, never a silent drop, never unbounded growth.
//   • IDEMPOTENT — the run's dedupe key is `src:${workspaceId}:${contentHash}`, so an EDIT
//     (new content ⇒ new hash) re-ingests while a duplicate EVENT (same content) dedupes
//     at Temporal (REJECT_DUPLICATE) + the driver's resolveRun; debounce coalesces an
//     editor's multi-write burst per path before dispatch even fires.
//
// LOCAL-ONLY. This module uses `node:fs`; like the C2 transport it is worker-side only
// (apps/worker/src) and is NEVER imported by the Temporal workflow sandbox bundle (which
// bundles the packages/workflows drivers), so `node:fs` never enters the sandbox graph.
import { sourceId, workspaceId, workflowId } from "@sow/contracts";
import type { Result, SourceEnvelope } from "@sow/contracts";
import type { SourceIngestionInput } from "@sow/workflows";
import { extractFileSource } from "@sow/integrations/connectors/adapters/file-source";
import type {
  FileExtractTransport,
  FileExtractError,
} from "@sow/integrations/connectors/adapters/file-source";
// REUSE the ONE authoritative root-confinement predicate (no duplicated safety check).
import { isContainedUnder } from "@sow/integrations/connectors/adapters/file-read-transport";
import type {
  DispatchOutcome,
  DispatchError,
  DispatchErrorCode,
} from "../temporal/dispatchSourceIngestion";
import { realpath as fsRealpath } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import { resolve } from "node:path";

/** The default per-path debounce window (ms) — coalesces an editor's multi-write burst. */
export const DEFAULT_DEBOUNCE_MS = 200;

/**
 * The watcher's POLICY binding (vault-per-workspace). `workspaceId`/`sensitivity` come
 * from the ingestion policy that owns this vault root — NEVER inferred from a file's
 * content or path (WS-2 / REQ-F-002 / REQ-F-017).
 */
export interface VaultWatchBinding {
  readonly vaultRoot: string;
  readonly workspaceId: string;
  readonly sensitivity: string;
}

/** The C3a dispatch entry, pre-bound to a Temporal Client (or degraded ⇒ fail-closed). */
export type VaultDispatch = (
  input: SourceIngestionInput,
) => Promise<Result<DispatchOutcome, DispatchError>>;

/** Resolve a path to its REAL absolute path (follows symlinks). Injectable for tests. */
export type Realpath = (p: string) => Promise<string>;

/** A minimal `fs.watch` handle — decoupled from the concrete `node:fs` FSWatcher. */
export interface FsWatcherLike {
  close(): void;
  on(event: "error", listener: (e: unknown) => void): void;
}

/** The `fs.watch` factory (default `node:fs.watch`; injectable so unit tests need no dir). */
export type WatchFactory = (
  path: string,
  opts: { readonly recursive: boolean },
  listener: (eventType: string, filename: string | null) => void,
) => FsWatcherLike;

/**
 * The outcome of a single capture attempt — a closed, typed set (never a throw). The
 * observer sink + tests assert on this deterministically.
 */
export type CaptureOutcome =
  | { readonly kind: "dispatched"; readonly workflowId: string; readonly deduped: boolean }
  | { readonly kind: "ignored"; readonly reason: "not_markdown" | "escapes_root" | "absent" }
  | { readonly kind: "extract_failed"; readonly code: FileExtractError["code"] }
  | { readonly kind: "dispatch_failed"; readonly code: DispatchErrorCode }
  | { readonly kind: "error"; readonly message: string };

export interface VaultWatcherDeps {
  /** C2's ROOT-confined file-read transport (`createFileReadTransport(vaultRoot)`). */
  readonly transport: FileExtractTransport;
  /** C3a's degraded-safe dispatch, bound to a Temporal Client (or fail-closed). */
  readonly dispatch: VaultDispatch;
  /** realpath resolver for the watcher-level containment guard. Default node:fs realpath. */
  readonly realpath?: Realpath;
  /** Per-path debounce window (ms). Default {@link DEFAULT_DEBOUNCE_MS}. */
  readonly debounceMs?: number;
  /** Observer for every capture outcome (logging / test assertion). Faults swallowed. */
  readonly onCapture?: (outcome: CaptureOutcome, relPath: string) => void;
  /** The `fs.watch` factory (`startVaultWatcher` only). Default node:fs.watch. */
  readonly watch?: WatchFactory;
  /**
   * Called when the underlying `fs.watch` fails to START (a SYNCHRONOUS throw — a missing
   * vault root, fd/inotify exhaustion, recursive-watch unsupported). The watcher degrades
   * to a no-op (never crashes boot, §16); the caller logs a redaction-safe code.
   */
  readonly onWatchError?: (e: unknown) => void;
}

/** The pure event handler — the debounced `onEvent` entry + the awaitable `capture`. */
export interface VaultWatchHandler {
  /** The `fs.watch` callback entry: filter + per-path debounce, then schedule `capture`. */
  onEvent(eventType: string, filename: string | null): void;
  /** The per-path capture→dispatch action. NEVER throws; returns a typed outcome. */
  capture(relPath: string): Promise<CaptureOutcome>;
  /** Await all already-DISPATCHED (timer-fired) captures — not still-armed timers (test seam). */
  drain(): Promise<void>;
  /** Clear all pending debounce timers (idempotent). */
  stop(): void;
}

/** A running watcher over a real vault dir — `stop()` clears timers + closes the watch. */
export interface RunningVaultWatcher {
  stop(): void;
}

/** True IFF a path names a Markdown file (the only source type this trigger captures). */
function isMarkdown(relPath: string): boolean {
  return relPath.endsWith(".md");
}

/**
 * The errno code (e.g. "ENOENT") off a thrown error, when present — carried in a typed
 * outcome WITHOUT echoing the absolute filesystem path a raw `e.message` would leak across
 * the boundary (mirrors the C2 transport's redaction discipline).
 */
function errnoCode(e: unknown): string | undefined {
  if (e !== null && typeof e === "object" && "code" in e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Build the capture handler for one vault binding. The returned `capture` runs the full
 * filter→containment→extract→dispatch chain for ONE path and NEVER throws; `onEvent` is
 * the debounced `fs.watch` entry that schedules it.
 */
export function createVaultWatchHandler(
  binding: VaultWatchBinding,
  deps: VaultWatcherDeps,
): VaultWatchHandler {
  const realpathFn: Realpath = deps.realpath ?? fsRealpath;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Set<Promise<unknown>>();

  // The un-guarded outcome computation — may throw; `capture` wraps it fail-closed.
  async function computeOutcome(relPath: string): Promise<CaptureOutcome> {
    // (1) `.md` add/change only — a non-Markdown path never touches the disk.
    if (!isMarkdown(relPath)) return { kind: "ignored", reason: "not_markdown" };

    // (2) ROOT-confinement double-guard — resolve BOTH paths to their realpath, then apply
    // the ONE authoritative containment predicate. A target that no longer exists throws
    // ENOENT ⇒ a delete / rename-away (add/change-only scope: IGNORED). A symlink whose
    // realpath escapes the root is dropped HERE, before the transport read is attempted.
    const realRoot = await realpathFn(binding.vaultRoot);
    let realTarget: string;
    try {
      realTarget = await realpathFn(resolve(realRoot, relPath));
    } catch {
      return { kind: "ignored", reason: "absent" };
    }
    if (!isContainedUnder(realRoot, realTarget)) return { kind: "ignored", reason: "escapes_root" };

    // (3) Capture via C2's ROOT-confined emit-only transport. WS-2: the scoped fields come
    // from the POLICY binding; `sourceId` is derived from (workspace, relative path); the
    // transport re-confines the read. NOTHING is inferred from content (REQ-F-017).
    const candidate = await extractFileSource(
      {
        sourceId: `file:${binding.workspaceId}:${relPath}`,
        workspaceId: binding.workspaceId,
        path: relPath,
        sensitivity: binding.sensitivity,
      },
      deps.transport,
    );
    if (!candidate.ok) return { kind: "extract_failed", code: candidate.error.code };

    const c = candidate.value;
    const source: SourceEnvelope = {
      sourceId: sourceId(c.sourceId),
      workspaceId: workspaceId(c.workspaceId),
      origin: c.origin,
      contentHash: c.contentHash,
      type: c.type,
      sensitivity: c.sensitivity,
      routingHints: c.routingHints,
    };

    // (4) Dispatch a connector-triggered run. The dedupe key is content-versioned so an
    // edit re-ingests but a duplicate event dedupes (Temporal REJECT_DUPLICATE + resolveRun).
    const key = `src:${binding.workspaceId}:${c.contentHash}`;
    const input: SourceIngestionInput = {
      run: {
        workflowId: workflowId(key),
        trigger: "connector_event",
        idempotencyKey: key,
        workspaceId: binding.workspaceId,
      },
      context: { source, envelopes: [] },
    };
    const res = await deps.dispatch(input);
    if (!res.ok) return { kind: "dispatch_failed", code: res.error.code };
    return { kind: "dispatched", workflowId: res.value.workflowId, deduped: res.value.deduped };
  }

  const capture = async (relPath: string): Promise<CaptureOutcome> => {
    let outcome: CaptureOutcome;
    try {
      outcome = await computeOutcome(relPath);
    } catch (e) {
      // §16 — the handler NEVER throws across its boundary; any fault becomes a typed err.
      // The message is REDACTED to an errno code (never the raw `e.message`, which for an fs
      // fault echoes an absolute path) — consistent with the C2 transport.
      const code = errnoCode(e);
      outcome = { kind: "error", message: code !== undefined ? `capture failed (${code})` : "capture failed" };
    }
    try {
      deps.onCapture?.(outcome, relPath);
    } catch {
      // An observer fault must never break the watcher.
    }
    return outcome;
  };

  const onEvent = (_eventType: string, filename: string | null): void => {
    // Pre-filter before scheduling: null filename (some platforms) or non-.md ⇒ no timer.
    if (filename === null || !isMarkdown(filename)) return;
    const existing = timers.get(filename);
    if (existing !== undefined) clearTimeout(existing);
    const t = setTimeout(() => {
      timers.delete(filename);
      // capture() never rejects (it catches), so this promise is always safe to await.
      const p = capture(filename);
      pending.add(p);
      void p.finally(() => pending.delete(p));
    }, debounceMs);
    timers.set(filename, t);
  };

  const drain = async (): Promise<void> => {
    await Promise.all([...pending]);
  };

  const stop = (): void => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };

  return { onEvent, capture, drain, stop };
}

/** The default `fs.watch`-backed factory (`node:fs`). Coerces a Buffer filename to a string. */
const defaultWatchFactory: WatchFactory = (path, opts, listener) =>
  fsWatch(path, { recursive: opts.recursive }, (eventType, filename) =>
    listener(eventType, filename === null ? null : filename.toString()),
  );

/**
 * Start a real watcher over `binding.vaultRoot`: wires `fs.watch` (recursive) to the
 * debounced handler. This is the SAME seam the gated e2e drives with the
 * TestWorkflowEnvironment client (no dormant code). `stop()` clears timers + closes the
 * watch. A watch-level error is swallowed so it can never crash boot (§16).
 */
export function startVaultWatcher(
  binding: VaultWatchBinding,
  deps: VaultWatcherDeps,
): RunningVaultWatcher {
  const handler = createVaultWatchHandler(binding, deps);
  const watchFn = deps.watch ?? defaultWatchFactory;
  let watcher: FsWatcherLike;
  try {
    // `fs.watch` throws SYNCHRONOUSLY when the root does not exist (ENOENT — fs.watch never
    // creates it), on fd/inotify exhaustion (EMFILE / ENOSPC), or when recursive watch is
    // unsupported. The `on("error")` handler only catches POST-construction async faults, so
    // this throw must be caught HERE — it must never propagate out of boot (§16). On failure
    // the watcher degrades to a no-op (timers still clear on stop) + the caller is notified.
    watcher = watchFn(binding.vaultRoot, { recursive: true }, (eventType, filename) =>
      handler.onEvent(eventType, filename),
    );
    watcher.on("error", () => {
      // A watch-level ASYNC fault (e.g. the dir vanished mid-run) must never crash boot (§16).
    });
  } catch (e) {
    deps.onWatchError?.(e);
    return { stop: (): void => handler.stop() };
  }
  const started = watcher;
  return {
    stop: (): void => {
      handler.stop();
      try {
        started.close();
      } catch {
        // close() is idempotent / best-effort.
      }
    },
  };
}
