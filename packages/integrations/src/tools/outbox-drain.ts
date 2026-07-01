// @sow/integrations — slice 6.5 WRITE OUTBOX: replay-safe drain (§8/§9, §20.1).
//
// On reconnect/wake, `drainOutbox` lists the DUE held entries
// (`OutboxRepository.listDue`) and re-drives each through the SAME 6.2 Tool-Gateway
// pipeline (`dispatchExternalWrite`). Because that pipeline runs the MANDATORY
// pre-write existence check + the stored-receipt replay gate BEFORE any create, a
// re-driven held write produces NO duplicate external action:
//   • an entry whose receipt already exists (prior successful write / a crash after
//     commit) → dispatch returns `reused`; adapter.create is NEVER called again.
//   • a still-unreachable entry → dispatch returns `held`; we RE-HOLD it with a
//     bumped attempt count + a `nextAttemptAt` from the injected bounded backoff
//     (never spins, never drops).
//   • a vendor-rejected/conflict re-drive → the entry goes terminal (rejected),
//     typed, never a silent drop.
//
// CRASH SAFETY: the drain is idempotent. A terminal (receipt_recorded | rejected |
// expired) entry is excluded by `listDue`, so re-running the drain after a crash
// re-drives ONLY the still-open entries and double-applies nothing.
//
// §9 WORKFLOW ENTRY-POINT: `drainOutbox(outbox, deps)` is a clean deps-injected
// signature callable as a Temporal activity — all effects (adapter, stores, clock,
// backoff) are injected; no real network/clock/randomness in the module.
//
// §16: async, returns typed counts, NEVER throws.
import { isOk } from "@sow/contracts";
import type {
  ProposedAction,
  ExternalWriteEnvelope,
  TargetSystem,
} from "@sow/contracts";
import type { OutboxRepository, OutboxEntry } from "../ports/persistence";
import {
  dispatchExternalWrite,
  type ExternalWriteDeps,
  type ExternalWriteResult,
} from "./gateway";
import { nextDelayMs, EXHAUSTED, type BackoffConfig } from "../connectors/backoff";

// The precondition marker every held envelope carries. `preconditions` must be a
// non-empty array of non-empty strings (schema `z.array(z.string().min(1))`); the
// mandatory pre-write existence check is the load-bearing precondition (safety
// invariant 2), so the drain reconstructs it explicitly.
const EXISTENCE_PRECONDITION = "exists_check" as const;

// A reconstructed action's approvalPolicy. The persisted OutboxEntry does not store
// the original approvalPolicy (it is not needed to re-drive — the gateway's
// approval verdict comes from the injected `requireApproval`). The schema requires
// a non-empty string; a queued/held write is one that already cleared (or is
// re-clearing) the approval gate, so we reconstruct the neutral queued marker.
const REDRIVE_APPROVAL_POLICY = "queued" as const;

/**
 * Reconstruct the linked `ProposedAction` from a persisted `OutboxEntry`. The four
 * linkage keys (actionId / targetSystem / canonicalObjectKey / idempotencyKey) are
 * preserved verbatim so the gateway's `envelopeMatchesAction` linkage pin holds;
 * the stored `payload` re-drives the create. Pure.
 */
function rebuildAction(entry: OutboxEntry): ProposedAction {
  return {
    actionId: entry.actionRef as ProposedAction["actionId"],
    targetSystem: entry.targetSystem as TargetSystem,
    canonicalObjectKey: entry.canonicalObjectKey,
    payload: (entry.payload as Record<string, unknown>) ?? {},
    approvalPolicy: REDRIVE_APPROVAL_POLICY,
    idempotencyKey: entry.idempotencyKey,
  };
}

/**
 * Reconstruct the `ExternalWriteEnvelope` from a persisted `OutboxEntry`. The
 * stored `payloadHash` + the four linkage keys are copied verbatim, so the
 * re-driven envelope passes the candidate-gate AND the `envelopeMatchesAction`
 * linkage pin against the reconstructed action. Pure.
 */
function rebuildEnvelope(entry: OutboxEntry): ExternalWriteEnvelope {
  return {
    actionId: entry.actionRef as ExternalWriteEnvelope["actionId"],
    targetSystem: entry.targetSystem as TargetSystem,
    canonicalObjectKey: entry.canonicalObjectKey,
    idempotencyKey: entry.idempotencyKey,
    preconditions: [EXISTENCE_PRECONDITION],
    payloadHash: entry.payloadHash,
  };
}

/**
 * Injected effects for one drain pass. `gatewayDeps` is the SAME dependency bundle
 * the live Tool Gateway uses (adapter + receiptStore + approval hooks + audit +
 * clock) — the drain re-drives through the identical pipeline. `backoffCfg` bounds
 * the re-hold delay for a still-unreachable entry. `clock` stamps `updatedAt` /
 * `nextAttemptAt`. `jitter` (optional) is injected into the backoff (never
 * `Math.random()`).
 */
export interface DrainDeps {
  readonly gatewayDeps: ExternalWriteDeps;
  readonly now: string;
  readonly limit: number;
  readonly backoffCfg: BackoffConfig;
  readonly clock: () => string;
  readonly jitter?: (baseDelayMs: number) => number;
}

/** The typed outcome counts of a drain pass (§16 — enumerable, never throws). */
export interface DrainResult {
  /** Entries that dispatched a fresh create this pass (status → receipt_recorded). */
  readonly drained: number;
  /** Entries whose existing receipt was reused — zero duplicate creates. */
  readonly reused: number;
  /** Entries still unreachable/awaiting approval — re-held with bumped backoff. */
  readonly held: number;
  /** Entries the vendor rejected/conflicted — terminal-rejected (typed drop). */
  readonly failed: number;
}

/**
 * Compute the `nextAttemptAt` for a re-held entry from the bounded backoff. The
 * attempt number is 1-indexed against the entry's NEW attempt count. On
 * `exhausted` we still return a bounded delay (`maxMs`) — a held item never
 * silently expires; exhaustion is surfaced via the depth/health signal, not by
 * dropping the entry. Pure (injected clock/jitter).
 */
function computeNextAttemptAt(
  attempts: number,
  deps: DrainDeps,
): string {
  const delay = nextDelayMs(attempts, deps.backoffCfg, deps.jitter);
  const delayMs = delay === EXHAUSTED ? deps.backoffCfg.maxMs : delay;
  return new Date(new Date(deps.now).getTime() + delayMs).toISOString();
}

/**
 * Fold one dispatch outcome back onto the outbox entry: advance to a terminal
 * status on a committed/reused/rejected result, or re-hold (bump attempts +
 * backoff) on a still-held result. Persists via `outbox.update`. Returns the
 * bucket the entry falls into so the caller can tally. Never throws.
 */
async function applyOutcome(
  outbox: OutboxRepository,
  entry: OutboxEntry,
  outcome: ExternalWriteResult,
  deps: DrainDeps,
): Promise<keyof DrainResult> {
  const now = deps.clock();
  switch (outcome.status) {
    case "created": {
      await outbox.update({
        ...entry,
        status: "receipt_recorded",
        writeReceipt: outcome.receipt,
        updatedAt: now,
      });
      return "drained";
    }
    case "reused": {
      await outbox.update({
        ...entry,
        status: "receipt_recorded",
        writeReceipt: outcome.receipt,
        updatedAt: now,
      });
      return "reused";
    }
    case "held":
    case "approval_pending": {
      // Still cannot dispatch — RE-HOLD (never drop, never expire). Bump attempts
      // + set a bounded-backoff nextAttemptAt so the next pass re-drives it later.
      const attempts = entry.attempts + 1;
      await outbox.update({
        ...entry,
        status: outcome.status === "approval_pending" ? "proposed" : "retry_queued",
        attempts,
        nextAttemptAt: computeNextAttemptAt(attempts, deps),
        updatedAt: now,
      });
      return "held";
    }
    case "conflict":
    case "rejected":
    default: {
      // A typed terminal failure — mark rejected (NEVER a silent drop, NEVER a
      // blind overwrite). The reason is already redaction-safe from the gateway.
      await outbox.update({
        ...entry,
        status: "rejected",
        attempts: entry.attempts + 1,
        updatedAt: now,
      });
      return "failed";
    }
  }
}

/**
 * Drain the outbox: re-drive every DUE held entry through the SAME Tool-Gateway
 * dispatch pipeline (replay-safe, zero duplicate external writes) and fold each
 * outcome back onto the entry. Idempotent across crashes (terminal entries are
 * excluded by `listDue`). Callable as the §9 workflow entry-point. Never throws.
 */
export async function drainOutbox(
  outbox: OutboxRepository,
  deps: DrainDeps,
): Promise<DrainResult> {
  const counts = { drained: 0, reused: 0, held: 0, failed: 0 };

  const due = await outbox.listDue(deps.now, deps.limit);
  if (!isOk(due)) {
    // A store fault on the list is fail-closed: nothing drained, nothing dropped.
    return counts;
  }

  for (const entry of due.value) {
    // Reconstruct the linked envelope + action from the persisted entry and
    // re-drive through the identical dispatch pipeline (existence check + replay
    // gate → no duplicate create).
    const env = rebuildEnvelope(entry);
    const action = rebuildAction(entry);
    const outcome = await dispatchExternalWrite(env, action, deps.gatewayDeps);
    const bucket = await applyOutcome(outbox, entry, outcome, deps);
    counts[bucket] += 1;
  }

  return counts;
}
