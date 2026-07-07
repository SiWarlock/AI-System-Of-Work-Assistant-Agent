// §13.10d Vault-B — the Copilot `vault.read` handler (worker side): a symlink-safe, path-traversal-guarded,
// WS-8-scoped read of ONE canonical-Markdown note. The sibling of `handleCopilotGbrainToolCall` for the vault.
//
// The model supplies a note `path`. The handler is LEAK-SAFE + FAIL-CLOSED, with defense in THREE layers:
//   1. LEXICAL pre-filter — attribute the REQUESTED path to a workspace via the SC1 WS-8 core
//      (`decideHitScope`; `slugFault` rejects `..`/absolute/`//`/backslash/control-char) + a lexical
//      `resolve`-under-`vaultRoot` guard. Fast; denies the obvious foreign/traversal before any disk access.
//   2. SYMLINK-SAFE — resolve the REAL path (an injected `realpath` seam) and RE-CHECK against the REAL vault
//      root: the real file MUST stay under the vault, AND its REAL location must RE-ATTRIBUTE to the served
//      workspace. This closes a symlink that points to another workspace's dir INSIDE the vault, or to a file
//      OUTSIDE the vault (arbitrary-file / secrets read) — a hole the purely-lexical guards cannot see.
//   3. READ — the injected `readFile` seam reads the REAL path (size-capped, redaction-safe).
// Any deny/fault/throw yields a STABLE empty result (no leak of WHY). Never throws (§16).
//
// ⚠ WS-8 PRECONDITION (documented, not enforced here): correctness rests on the vault being PARTITIONED so
// each workspace's notes live under a top-level directory equal to its slug prefix (e.g. `employer-work/…`),
// with no foreign/unprefixed notes under another workspace's dir. Under `LegacyContentPolicy {assign,X}` any
// UNPREFIXED note is served ONLY to X — sound under the same single-workspace assumption the retrieval path
// documents. (TOCTOU between realpath and read is out of scope — a local single-user vault, not an adversarial FS.)
import { isOk, err, failure } from "@sow/contracts";
import type { FailureVariant, Result } from "@sow/contracts";
import { decideHitScope } from "@sow/policy";
import type { CopilotWorkspaceScope } from "@sow/policy";
import * as nodePath from "node:path";
import { readFile as fsReadFile, realpath as fsRealpath, stat as fsStat } from "node:fs/promises";

/** One text block of a tool result (structurally compatible with the SDK's CallToolResult content). */
export interface CopilotVaultReadTextBlock {
  readonly type: "text";
  readonly text: string;
}
/** The vault.read result shape (mirrors the gbrain proxy result — a single text block). */
export interface CopilotVaultReadResult {
  readonly content: ReadonlyArray<CopilotVaultReadTextBlock>;
}

/**
 * The injected file reader: an ABSOLUTE (already realpath-resolved + WS-8-scoped) path → the note's UTF-8
 * contents, or a typed fault. Redaction-safe by contract. Boot injects the real `fs` reader; tests inject a fake.
 */
export type CopilotVaultReadFileExec = (absPath: string) => Promise<Result<string, FailureVariant>>;
/**
 * The injected realpath resolver: an absolute path → its symlink-RESOLVED canonical absolute path, or a fault
 * (broken/missing symlink). Boot injects `createFsRealpath()`; tests inject a fake to simulate a symlink.
 */
export type CopilotVaultRealpathExec = (absPath: string) => Promise<Result<string, FailureVariant>>;

/** Deps for the vault.read handler — the served scope, the vault root, and the realpath + file-read seams. */
export interface CopilotVaultReadDeps {
  /** The served workspace scope (server-bound). A path whose REAL location is not attributable to it is DENIED. */
  readonly scope: CopilotWorkspaceScope;
  /** The absolute vault root; every note's REAL path must resolve strictly UNDER it (symlink-safe traversal guard). */
  readonly vaultRoot: string;
  /** The injected realpath resolver (real `fs.realpath` at boot; a fake in tests) — the symlink-safe layer. */
  readonly realpath: CopilotVaultRealpathExec;
  /** The injected file reader (real `fs` at boot; a fake in tests). */
  readonly readFile: CopilotVaultReadFileExec;
}

/** The stable, content-free deny/fault result — never reveals WHY (foreign / traversal / not-found look alike). */
const SAFE_EMPTY: CopilotVaultReadResult = { content: [{ type: "text", text: "" }] };

/** Extract a non-empty string `path` arg from the untrusted model input, else null. */
function readPathArg(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const p = (args as Record<string, unknown>)["path"];
  return typeof p === "string" && p.length > 0 ? p : null;
}

/** Case-insensitively strip a trailing `.md` (the note SLUG is its path without the Markdown extension). */
function slugOf(p: string): string {
  return p.toLowerCase().endsWith(".md") ? p.slice(0, -3) : p;
}
/** Case-insensitively ensure the path carries the `.md` extension (the on-disk canonical note file). */
function fileRelOf(p: string): string {
  return p.toLowerCase().endsWith(".md") ? p : `${p}.md`;
}

/** Keep/drop a note by its slug under the served scope (the WS-8 core). */
function keepSlug(slug: string, scope: CopilotWorkspaceScope): boolean {
  return decideHitScope({ slug }, scope.servedWorkspaceId, scope.registry, scope.policy).decision === "keep";
}

/**
 * Handle a `vault.read` tool call. Fail-closed at every layer (non-string/empty path, foreign/traversal LEXICAL
 * slug, lexical escape, realpath fault, REAL-path escape, REAL-path foreign attribution, read fault). Never throws.
 */
export async function handleCopilotVaultReadCall(
  args: unknown,
  deps: CopilotVaultReadDeps,
): Promise<CopilotVaultReadResult> {
  try {
    const path = readPathArg(args);
    if (path === null) return SAFE_EMPTY;

    // (1) LEXICAL pre-filter: WS-8 + traversal on the REQUESTED path (fast deny; not authoritative alone).
    if (!keepSlug(slugOf(path), deps.scope)) return SAFE_EMPTY;
    const root = nodePath.resolve(deps.vaultRoot);
    const lexResolved = nodePath.resolve(root, fileRelOf(path));
    if (lexResolved === root || !lexResolved.startsWith(root + nodePath.sep)) return SAFE_EMPTY;

    // (2) SYMLINK-SAFE: resolve the REAL paths, then re-check containment AND re-attribute WS-8 on the REAL
    // path. A symlink (to another workspace's dir inside the vault, or to a file outside it) is caught here.
    const [realFile, realRoot] = await Promise.all([deps.realpath(lexResolved), deps.realpath(root)]);
    if (!isOk(realFile) || !isOk(realRoot)) return SAFE_EMPTY; // broken/missing path ⇒ deny
    if (realFile.value !== realRoot.value && !realFile.value.startsWith(realRoot.value + nodePath.sep)) {
      return SAFE_EMPTY; // the REAL file escaped the REAL vault root (out-of-vault symlink)
    }
    const realSlug = slugOf(nodePath.relative(realRoot.value, realFile.value).split(nodePath.sep).join("/"));
    if (!keepSlug(realSlug, deps.scope)) return SAFE_EMPTY; // the REAL file attributes to a FOREIGN workspace

    // (3) Read the REAL (symlink-resolved, contained, in-workspace) note.
    const read = await deps.readFile(realFile.value);
    if (!isOk(read)) return SAFE_EMPTY;
    return { content: [{ type: "text", text: read.value }] };
  } catch {
    // Structural never-throws (§16 / safety 7): any unexpected error fails closed with no content.
    return SAFE_EMPTY;
  }
}

// ── the real fs seams (imperative — integration-tested against a tmpdir, never in the default unit suite) ──

/** Knobs for the real fs vault reader. */
export interface FsVaultReadOptions {
  /** Max note size (bytes); a larger note fails closed. Defaults to 1 MiB. */
  readonly maxBytes?: number;
}

/**
 * The REAL vault file reader over an ABSOLUTE (handler-guarded) path. REDACTION-SAFE: on ANY failure it returns
 * ONLY a stable typed fault code — the fs error message (which may echo the path) is DROPPED (§16 / safety 7).
 * `stat`s FIRST so the size cap is enforced BEFORE the file is buffered (no OOM on a pathological note), and a
 * non-regular-file (directory / device / socket) is denied. The handler realpath-guards the path before this runs.
 */
export function createFsVaultReadFileExec(options?: FsVaultReadOptions): CopilotVaultReadFileExec {
  const maxBytes = options?.maxBytes ?? 1024 * 1024;
  return async (absPath) => {
    try {
      const st = await fsStat(absPath);
      if (!st.isFile()) {
        return err(failure("validation_rejected", "vault path is not a regular file", { retryable: false, cause: { code: "VAULT_READ_NOT_FILE" } }));
      }
      if (st.size > maxBytes) {
        return err(failure("validation_rejected", "vault note too large", { retryable: false, cause: { code: "VAULT_READ_TOO_LARGE" } }));
      }
      const buf = await fsReadFile(absPath);
      return { ok: true, value: buf.toString("utf8") };
    } catch {
      return err(failure("degraded_unavailable", "vault read failed", { retryable: false, cause: { code: "VAULT_READ_FAULT" } }));
    }
  };
}

/**
 * The REAL realpath resolver: an absolute path → its symlink-resolved canonical path, or a stable fault
 * (broken/missing symlink, permission). Redaction-safe (drops the fs message). This is the seam the handler's
 * symlink-safe layer (2) drives; the handler compares the resolved file + root, so this does NO scope logic.
 */
export function createFsRealpath(): CopilotVaultRealpathExec {
  return async (absPath) => {
    try {
      return { ok: true, value: await fsRealpath(absPath) };
    } catch {
      return err(failure("degraded_unavailable", "vault realpath failed", { retryable: false, cause: { code: "VAULT_REALPATH_FAULT" } }));
    }
  };
}
