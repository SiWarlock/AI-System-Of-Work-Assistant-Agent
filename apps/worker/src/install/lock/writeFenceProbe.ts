// apps/worker — task 24.1: BIND the OS one-writer lock to the KnowledgeWriter's
// write fence (REQ-S-NEW-008, safety rule 1).
//
// ⛔ THE GAP THIS CLOSES, in 24.1's own words. `acquireSingleOwnerLock` was wired at
// boot (`68ec73c9`) so a second worker on the same durable `dbPath` is physically
// refused — but boot.ts recorded the remaining scope itself: it "does NOT bind
// `resolvePgliteLockHolder` → `packages/knowledge`'s `evaluateWriteFence` … so the
// OS lock is a real ACQUISITION but not yet the thing that would make a refused
// write PHYSICALLY blocked at the gbrain/vault write layer." The fence was
// DETECTIVE. The Done-when demands PREVENTIVE: "denied at the OS layer … physically
// blocked, not just reported".
//
// ⭐ WHERE THE BLOCK LIVES, and why not at boot. The obvious reading of "hard-refuse"
// is to make `bootWorker` refuse to return — but that is both a large breaking change
// to a contract with no failure variant AND the wrong layer. The fence guards WRITES,
// not the process lifecycle, and the lock can be LOST while the process runs: a
// refusal decided once at startup would authorize every later write on a fact that
// has since expired. So the probe is evaluated PER COMMIT, at
// `atomicCommit` — before a single byte is staged.
//
// SCOPE, STATED RATHER THAN IMPLIED. Two of `evaluateWriteFence`'s three inputs are
// bound to real facts here; the third is not, and pretending otherwise would be the
// overclaim this repo keeps finding:
//   • `pgliteLockHolder`     — REAL, from `resolvePgliteLockHolder(lockResult)`.
//   • `workerIsSoleVaultWriter` — CALLER-SUPPLIED. There is no filesystem-ACL prober
//     in this repo yet, so the caller states the fact it can actually establish. It
//     defaults to `false` (fail-closed) rather than an optimistic `true`.
//   • `observedProcesses`    — the CONTINUOUS stray-writer probe (a ps/lsof sweep)
//     does not exist; an empty set is passed, which means `scanForStrayWriters`
//     contributes no alarms. This does NOT weaken the lock check — it means a stray
//     write-capable gbrain process is not yet DETECTED here. Named as a real
//     remaining gap, not silently absorbed.
import { evaluateWriteFence } from "@sow/knowledge";
import type { WriteFenceContext } from "@sow/knowledge";
import type { BrainId } from "@sow/contracts";
import { resolvePgliteLockHolder } from "./singleOwnerLock";
import type { LockAcquireResult } from "./singleOwnerLock";

/** Inputs the worker can actually establish at boot. */
export interface WriteFenceProbeArgs {
  /**
   * The acquire outcome. `undefined` models "we never got an answer" (an exotic fs
   * fault degraded the acquire), which fails CLOSED — an unknown holder is not us.
   */
  readonly lockResult: LockAcquireResult | undefined;
  readonly canonicalBrainId: BrainId;
  /**
   * Whether the worker is the sole OS principal with vault write access. No ACL
   * prober exists yet, so this is the caller's stated fact; it defaults to `false`.
   */
  readonly workerIsSoleVaultWriter: boolean;
  readonly now: () => string;
  readonly auditRef: string;
}

/**
 * Build the per-commit fence probe the KnowledgeWriter consults. Returns the closed
 * breach reason set when the fence is DOWN, or `undefined` when it is intact.
 *
 * Never throws (§16): `evaluateWriteFence` is pure decision logic and this wrapper
 * adds no IO of its own.
 */
export function createWriteFenceProbe(args: WriteFenceProbeArgs): () => readonly string[] | undefined {
  const ctx: WriteFenceContext = { now: args.now, auditRef: args.auditRef };
  return (): readonly string[] | undefined => {
    const verdict = evaluateWriteFence(
      {
        canonicalBrainId: args.canonicalBrainId,
        workerIsSoleVaultWriter: args.workerIsSoleVaultWriter,
        // Default-deny: a missing acquire result is `unknown`, never `worker`.
        pgliteLockHolder:
          args.lockResult === undefined ? "unknown" : resolvePgliteLockHolder(args.lockResult),
        observedProcesses: [],
      },
      ctx,
    );
    return verdict.ok ? undefined : verdict.error.reasons;
  };
}
