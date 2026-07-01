// Atomic all-or-nothing vault write primitive (§6, task 4.1). The KnowledgeWriter
// is the sole autonomous writer of canonical Markdown (safety rule 1); this module
// is the low-level file-commit primitive it stands on. A plan commits at exactly
// one new revision or NOTHING is written — a mid-apply failure leaves the working
// tree byte-identical to the prior revision.
//
// Mechanism (temp-write + rename, §6): every changed file is first staged to a
// sibling temp path; only once EVERY stage write has succeeded do we rename the
// temps into place. A rename failure mid-commit rolls the already-renamed files
// back to their captured prior bytes, so the vault never lingers in a partial
// state. No throw crosses this boundary — every failure is a typed `Result` (§16).
//
// The filesystem is injected as a `VaultFs` port so unit tests drive a REAL temp
// directory (deterministic, not a behavior mock) or a fault-injecting fake to
// prove the all-or-nothing guarantee.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";

/**
 * Injected filesystem port over a single workspace vault directory. Paths are
 * vault-relative. `read` returns `undefined` for a missing file (never throws for
 * absence); `remove` is a no-op on a missing file.
 */
export interface VaultFs {
  /** File content, or `undefined` when the file does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Every Markdown file path currently in the vault (vault-relative). */
  list(): Promise<string[]>;
  /** Write `content` to `path`, creating parent directories as needed. */
  write(path: string, content: string): Promise<void>;
  /** Rename `from` onto `to`, replacing `to` if it exists. */
  rename(from: string, to: string): Promise<void>;
  /** Remove `path`; a no-op when the file is absent. */
  remove(path: string): Promise<void>;
}

/** A single file to (over)write as part of one atomic commit. */
export interface FileChange {
  readonly path: string;
  readonly content: string;
}

/** Typed failure of an atomic commit (never thrown, §16). */
export type AtomicError =
  | { readonly code: "stage_failed"; readonly path: string; readonly cause: unknown }
  | { readonly code: "commit_failed"; readonly path: string; readonly cause: unknown };

const tempPath = (path: string, token: string): string => `${path}.${token}.kwtmp`;

/**
 * Commit `changes` atomically. `token` is a caller-supplied deterministic suffix
 * for the staging temp files (the target revision id) — the primitive itself
 * introduces no clock/random, keeping it reproducible.
 *
 * Contract: on `ok` every change is durably in place; on `err` the vault is left
 * exactly as it was before the call (all-or-nothing). An empty change set is a
 * no-op `ok`.
 */
export async function atomicCommit(
  fs: VaultFs,
  changes: readonly FileChange[],
  token: string,
): Promise<Result<void, AtomicError>> {
  if (changes.length === 0) {
    return ok(undefined);
  }

  // Phase 1 — stage every change to a temp file. Any failure aborts before a
  // single live file is touched; staged temps are swept so nothing leaks.
  const staged: { readonly change: FileChange; readonly tmp: string }[] = [];
  for (const change of changes) {
    const tmp = tempPath(change.path, token);
    try {
      await fs.write(tmp, change.content);
      staged.push({ change, tmp });
    } catch (cause) {
      await sweep(fs, staged.map((s) => s.tmp));
      return err({ code: "stage_failed", path: change.path, cause });
    }
  }

  // Capture prior bytes of every target BEFORE any rename, so a mid-commit
  // failure can restore the exact pre-commit state.
  const priors = new Map<string, string | undefined>();
  for (const { change } of staged) {
    priors.set(change.path, await fs.read(change.path));
  }

  // Phase 2 — rename staged temps into place. On failure, roll back the renames
  // already applied (restore prior bytes / delete files that did not exist) and
  // sweep the not-yet-renamed temps.
  const renamed: FileChange[] = [];
  for (let i = 0; i < staged.length; i++) {
    const entry = staged[i]!;
    try {
      await fs.rename(entry.tmp, entry.change.path);
      renamed.push(entry.change);
    } catch (cause) {
      await rollback(fs, renamed, priors);
      await sweep(fs, staged.slice(i).map((s) => s.tmp));
      return err({ code: "commit_failed", path: entry.change.path, cause });
    }
  }

  return ok(undefined);
}

/** Best-effort deletion of staged temp files (failures are swallowed). */
async function sweep(fs: VaultFs, tmps: readonly string[]): Promise<void> {
  for (const tmp of tmps) {
    try {
      await fs.remove(tmp);
    } catch {
      // best-effort cleanup; a lingering temp never affects canonical bytes.
    }
  }
}

/** Restore already-renamed targets to their captured prior bytes. */
async function rollback(
  fs: VaultFs,
  renamed: readonly FileChange[],
  priors: ReadonlyMap<string, string | undefined>,
): Promise<void> {
  for (const change of renamed) {
    const prior = priors.get(change.path);
    try {
      if (prior === undefined) {
        await fs.remove(change.path);
      } else {
        await fs.write(change.path, prior);
      }
    } catch {
      // best-effort; the caller surfaces commit_failed regardless.
    }
  }
}
