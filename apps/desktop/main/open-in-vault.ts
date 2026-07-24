// Task 9.12 — open-in-Obsidian / reveal-in-vault, path-scoped (REQ-UX-003 / §11; §5 no-arbitrary-open).
//
// A renderer-supplied path crossing the trusted preload bridge is STILL untrusted. Main opens/reveals ONLY
// a path whose REAL (symlink-resolved) location is contained within a configured workspace/global repo root
// — every other request fails closed with NO filesystem side effect, NO disclosure of why, and NEVER throws.
//
// `guardVaultPath` is PURE + electron-free (realpath/stat injected as seams) so it compiles + unit-tests under
// the DOM-less node tsconfig (desktop LESSONS §2/§3 — `import {shell} from "electron"` must NOT reach here).
// The real `shell` binding lives in main/ipc.ts, which passes the openPath/showInFolder seams into
// `performVaultAction`. Three layers, mirroring main/app-protocol.ts (lexical) + worker copilotVaultRead.ts +
// worker LESSON 17 (realpath-before-open, the `+sep` guard, one authoritative predicate, never-throws):
//   1. LEXICAL — resolve the path absolutely + require it be a configured root or strictly under `root + sep`.
//   2. REALPATH re-containment — resolve the REAL path of BOTH the target and the matched root, re-check
//      containment; a symlink whose realpath escapes the root is caught here (the layer the lexical one lacks).
//   3. isFile — `open` targets a regular file; `reveal` (show-in-folder) may target a directory / repo root.
import { resolve, sep } from "node:path";
import { ok, err, isOk } from "@sow/contracts";
import type { Result } from "@sow/contracts";

/** The two path-scoped operations. `open` launches the file in its default app; `reveal` shows it in Finder. */
export type VaultOp = "open" | "reveal";

/** Why a request was refused — internal (drives the fail-closed reason; never disclosed to the renderer). */
export type VaultRejectReason =
  | "malformed" // non-string / empty / NUL-injection — rejected BEFORE any fs seam
  | "outside_roots" // not lexically contained under any configured root (covers traversal + sibling-prefix)
  | "escapes_roots" // lexically contained, but its REAL path escapes the root (symlink escape)
  | "not_a_file" // `open` target is not a regular file
  | "fs_fault"; // a realpath/stat seam faulted (missing target, permission, throw) — fail closed

export interface VaultReject {
  readonly reason: VaultRejectReason;
}

/** Injected filesystem seams so the guard is node-testable with zero real fs. Real bindings live in ipc.ts. */
export interface VaultGuardDeps {
  /** Resolve a path's symlink-canonical absolute location (real `fs.promises.realpath` at boot). */
  readonly realpath: (absPath: string) => Promise<string>;
  /** Stat a path — only `isFile()` is consulted (real `fs.promises.stat` at boot). */
  readonly stat: (absPath: string) => Promise<{ isFile: () => boolean }>;
}

/** The containment predicate: the resolved path is the root itself, or strictly under `root + sep`. The
 *  `+ sep` guard rejects a sibling that merely shares the root's string prefix (`/vault-evil` vs `/vault`). */
function containedUnder(full: string, root: string): boolean {
  return full === root || full.startsWith(root + sep);
}

/**
 * Guard an untrusted requested path against the configured vault roots. Returns `ok({ absPath })` with the
 * REAL (symlink-resolved) path on success — callers act on `absPath`, never the requested path, which NARROWS
 * (does not fully close) the TOCTOU window between check and open: the resolved symlink can't be re-pointed,
 * though an ancestor swapped after this call is re-resolved by the shell. Any refusal / fault is a typed
 * `VaultReject`; NEVER throws (§16).
 */
export async function guardVaultPath(
  requestedPath: unknown,
  roots: readonly string[],
  op: VaultOp,
  deps: VaultGuardDeps,
): Promise<Result<{ absPath: string }, VaultReject>> {
  try {
    // (0) malformed: non-string / empty / NUL-injection — fail closed BEFORE any fs seam runs.
    if (typeof requestedPath !== "string" || requestedPath.length === 0 || requestedPath.includes("\0")) {
      return err({ reason: "malformed" });
    }

    // (1) LEXICAL containment: resolve absolutely, require containment under >=1 configured root.
    const absReq = resolve(requestedPath);
    const matchedRoot = roots.map((r) => resolve(r)).find((r) => containedUnder(absReq, r));
    if (matchedRoot === undefined) return err({ reason: "outside_roots" });

    // (2) REALPATH re-containment: resolve the REAL path of BOTH the target and the matched root, then
    // re-check. realpath-ing BOTH sides so a symlinked ANCESTOR (e.g. macOS /Users) can't false-reject a
    // legitimate path — only a target whose REAL location escapes the REAL root is refused.
    const [realTarget, realRoot] = await Promise.all([deps.realpath(absReq), deps.realpath(matchedRoot)]);
    if (!containedUnder(realTarget, realRoot)) return err({ reason: "escapes_roots" });

    // (3) `open` requires a regular file; `reveal` (show-in-folder) may target a directory / repo root.
    if (op === "open") {
      const st = await deps.stat(realTarget);
      if (!st.isFile()) return err({ reason: "not_a_file" });
    }

    return ok({ absPath: realTarget });
  } catch {
    // §16 never-throws: any seam fault (missing target, permission, realpath/stat throw) fails closed.
    return err({ reason: "fs_fault" });
  }
}

/** Injected shell seams (real `shell` bound in ipc.ts) plus the guard's fs seams. */
export interface VaultActionDeps extends VaultGuardDeps {
  /** `shell.openPath` — resolves to "" on success, or a non-empty error string (may echo the path) on failure. */
  readonly openPath: (absPath: string) => Promise<string>;
  /** `shell.showItemInFolder` — reveals the item in the OS file manager. */
  readonly showInFolder: (absPath: string) => void;
}

/**
 * Guard then dispatch to the shell. On a rejected path NO shell call is made. The shell's own error string is
 * NEVER surfaced (rule 7 — it may echo the path); the caller learns only `{ ok }`. NEVER throws (§16).
 */
export async function performVaultAction(
  op: VaultOp,
  requestedPath: unknown,
  roots: readonly string[],
  deps: VaultActionDeps,
): Promise<{ ok: boolean }> {
  const guarded = await guardVaultPath(requestedPath, roots, op, deps);
  if (!isOk(guarded)) return { ok: false }; // rejected ⇒ no shell call, no disclosure
  try {
    if (op === "open") {
      const failureMsg = await deps.openPath(guarded.value.absPath);
      return { ok: failureMsg === "" };
    }
    deps.showInFolder(guarded.value.absPath);
    return { ok: true };
  } catch {
    return { ok: false }; // a shell fault yields { ok: false } — no throw, no disclosure
  }
}
