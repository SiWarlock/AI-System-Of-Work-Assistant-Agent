// Tasks 11.1 + 24.1 (REQ-D-005, safety rule 1) — a REAL OS-level advisory single-owner lock.
//
// The one-writer posture checks in `../checks/posture.ts` are READ-AND-REPORT: they observe an ACL bit /
// a mount mode / a `ps` scan and surface a finding, but nothing PHYSICALLY stops a second worker instance
// (or a stray `gbrain serve`) from touching the canonical vault/brain concurrently. This module closes
// that gap for the SoW worker's own instance identity: an atomic O_CREAT|O_EXCL lockfile create is the
// OS's own compare-and-swap — the create either wins outright or fails EEXIST, with NO TOCTOU window a
// second process could race through (unlike "check the file, then write it").
//
//   • acquireSingleOwnerLock(lockPath) — the OS-atomic acquire. A second LIVE holder's create is REFUSED
//     (physically — the `open()` syscall itself fails EEXIST, not merely a reported finding). A lock left
//     behind by a DEAD holder (its pid no longer signalable — ESRCH) is STALE and RECLAIMED: the stale
//     file is removed and acquisition retried once. `release()` is idempotent and only removes the file
//     while it still names US (defense-in-depth against racing a legitimate reclaimer).
//   • resolvePgliteLockHolder(result) — maps an acquire outcome onto the `PgliteLockHolder` producer
//     `evaluateWriteFence` (packages/knowledge/src/gbrain/write-fence.ts, consumed here — NOT edited)
//     expects: `"worker"` only on a definite hold; anything else fails closed to `"unknown"` (default-deny
//     — this module cannot attest a foreign holder is specifically `"gbrain"` without inspecting its
//     identity, and `evaluateWriteFence` treats every non-`"worker"` value identically).
//
// FAIL-CLOSED: an unexpected fs fault (anything other than the expected EEXIST) is NEVER swallowed into a
// false "held" — it propagates, per §16 (an unattributable state must not be silently reported as safe or
// as a known breach). A `readHolderPid` that cannot parse the file (a torn write mid-race, or a foreign
// file) yields `undefined`, which is treated as "cannot confirm staleness" — i.e. NOT reclaimed (fail
// toward refusing acquisition, not toward silently displacing a real holder).
import {
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  unlinkSync,
  constants as fsConstants,
} from "node:fs";
import type { PgliteLockHolder } from "@sow/knowledge";

/** A successful acquisition — `release()` is idempotent and safe to call multiple times. */
export interface LockHeld {
  readonly ok: true;
  readonly release: () => void;
}

/** A refused acquisition — another (live) process holds the lock. */
export interface LockRefused {
  readonly ok: false;
  readonly reason: "held";
  /** The recorded holder pid, or -1 when the lockfile exists but its pid could not be parsed. */
  readonly holderPid: number;
}

export type LockAcquireResult = LockHeld | LockRefused;

/** True iff a process with `pid` can be signaled — i.e. is alive. `ESRCH` is the only definitive "dead"
 *  answer; any other errno (most commonly `EPERM` — alive but owned by another user) fails closed to
 *  "alive" so we never reclaim a lock out from under a holder we merely lack permission to probe. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code !== "ESRCH";
  }
}

/** Read the pid recorded in an existing lockfile. Any read/parse fault (missing, torn write, non-numeric,
 *  non-positive) yields `undefined` — "cannot confirm" a holder identity, never a guessed one. */
function readHolderPid(lockPath: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8").trim();
  } catch {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) return undefined;
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

function acquireInternal(lockPath: string, allowReclaim: boolean): LockAcquireResult {
  let fd: number;
  try {
    fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") throw e; // an unexpected fault — never silently reported as "held" (§16)
    const holderPid = readHolderPid(lockPath);
    if (allowReclaim && holderPid !== undefined && !isProcessAlive(holderPid)) {
      // STALE: the recorded holder is confirmed dead. Reclaim by removing the stale file, then retry
      // ONCE more (allowReclaim=false on the retry — a persistently-unreclaimable file cannot loop).
      try {
        unlinkSync(lockPath);
      } catch {
        // Lost the unlink race to a concurrent reclaimer — fall through to the retry, which will then
        // observe whatever that reclaimer wrote (a live holder ⇒ correctly refused).
      }
      return acquireInternal(lockPath, false);
    }
    return { ok: false, reason: "held", holderPid: holderPid ?? -1 };
  }
  writeSync(fd, String(process.pid));
  closeSync(fd);
  let released = false;
  return {
    ok: true,
    release: (): void => {
      if (released) return;
      released = true;
      // Only remove the file while it STILL names us — defense-in-depth against a race where a stale-
      // reclaim by another process legitimately overwrote it between our acquire and our release.
      if (readHolderPid(lockPath) === process.pid) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Already gone — release is idempotent; nothing further to do.
        }
      }
    },
  };
}

/**
 * Acquire the advisory single-owner lock at `lockPath`. The create is OS-ATOMIC (O_CREAT|O_EXCL) — a
 * second process racing the identical call PHYSICALLY cannot both win; the loser's `open()` fails EEXIST
 * and this returns `{ ok: false, reason: "held", holderPid }`, never a false acquire. A lockfile left by a
 * now-dead holder is reclaimed transparently (one retry after removing the stale file).
 */
export function acquireSingleOwnerLock(lockPath: string): LockAcquireResult {
  return acquireInternal(lockPath, true);
}

/**
 * Map an acquire outcome onto the write-fence's {@link PgliteLockHolder} (packages/knowledge/src/gbrain/
 * write-fence.ts `evaluateWriteFence` input — consumed here, not edited). `"worker"` only on a definite
 * hold; a refusal fails closed to `"unknown"` (default-deny) rather than guessing `"gbrain"` — this module
 * observes ONLY that some other pid holds the file, never that pid's process identity, and
 * `evaluateWriteFence` treats every non-`"worker"` value identically (`pgliteLockHolder !== "worker"` ⇒
 * breach), so the imprecision costs nothing safety-wise.
 */
export function resolvePgliteLockHolder(result: LockAcquireResult): PgliteLockHolder {
  return result.ok ? "worker" : "unknown";
}
