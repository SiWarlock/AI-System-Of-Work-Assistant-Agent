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
// backoff) are injected; no real network/clock/randomness in the module. Task
// 21.4a — `deps.dispatch` is the injectable ROUTED-DISPATCH seam: when BOUND, the
// drain re-drives each held entry through it instead of the raw
// `dispatchExternalWrite` import, so the drain shares the SAME target-routing
// decision as the live dispatch path (the worker binds
// `dispatch: (e,a,d) => dispatchRouted(backends.writeAdapters, e, a, d)` — the
// identical expression already bound to `propose`/`dispatchApproved` at the
// composition root, `buildActivities.ts:669`/`:749`). An ABSENT `dispatch` keeps
// the pre-21.4 behavior BYTE-EQUIVALENT: `dispatchExternalWrite` is called
// directly, unrouted, exactly as before this field existed.
//
// SINGLE-WORKSPACE-SCOPED (task 24.50, safety rule 4). `deps.gatewayDeps` carries
// ONE bound approval posture — `requireApproval` closes over a `ResolvedWorkspacePolicy`
// captured once, at bind time (see `apps/worker/src/composition/backends.ts`'s
// `makeRequireApproval`: "the resolved workspace posture is captured at bind
// time"). `OutboxRepository.listDue` does NOT filter by workspace, so a drain pass
// over a mixed-workspace outbox would otherwise evaluate every entry — regardless
// of which workspace it actually belongs to — against that ONE bound posture: a
// structural cross-workspace mis-evaluation on the WRITE side, the write-path
// analogue of safety rule 4's raw cross-workspace read veto. The fix is
// structural, not a threading fix: `deps.workspaceId` names the workspace
// `gatewayDeps` was bound for, and the drain SKIPS (no dispatch, no store
// mutation, no attempts bump) any due entry whose OWN `workspaceId` disagrees —
// making a cross-workspace mix unrepresentable at the drain rather than widening
// `ExternalWriteDeps.requireApproval`'s signature (owned by apps/worker /
// packages/workflows / packages/evals, outside this package). A mixed outbox is
// drained by ONE PASS PER WORKSPACE, each with its own correctly-bound
// `gatewayDeps` + matching `workspaceId`.
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

// FALLBACK-ONLY marker (task 24.15). The persisted OutboxEntry DOES now store the
// original approvalPolicy (`OutboxEntry.approvalPolicy?: string`, task 24.35) — a
// held write reconstructs the FAITHFUL original token below (the token itself is a
// historical record of what was proposed, deliberately NOT re-derived; it is the
// gateway's other conjuncts — the resolved workspace posture — that are re-read
// fresh at redrive time, per `@sow/policy`'s `requiresApproval`). This literal is
// the fallback for any entry with NO persisted value at all — not only a
// pre-24.35 legacy row, but any future producer that enqueues without going
// through `holdWrite`: the schema requires a non-empty string, and an absent
// original policy must fail SAFE — "queued" is never AUTO_PRIVATE_POLICY, so a
// row with no persisted policy always gates on redrive rather than silently
// auto-allowing.
const REDRIVE_APPROVAL_POLICY = "queued" as const;

/**
 * Reconstruct the linked `ProposedAction` from a persisted `OutboxEntry`. The four
 * linkage keys (actionId / targetSystem / canonicalObjectKey / idempotencyKey) are
 * preserved verbatim so the gateway's `envelopeMatchesAction` linkage pin holds;
 * the stored `payload` re-drives the create; `approvalPolicy` is the FAITHFUL
 * original token (task 24.15) — or, for any entry with no persisted value (a
 * pre-24.35 legacy row, or a future producer bypassing `holdWrite`), the
 * fail-safe `REDRIVE_APPROVAL_POLICY` fallback (never auto-eligible). Pure.
 *
 * `entry.workspaceId` is deliberately NOT threaded onto the reconstructed
 * `ProposedAction` (no such field exists there) — the workspace-scope check
 * (task 24.50) reads `entry.workspaceId` directly in `drainOutbox`'s loop,
 * BEFORE this reconstruction runs, so a mis-scoped entry never reaches here.
 */
function rebuildAction(entry: OutboxEntry): ProposedAction {
  return {
    actionId: entry.actionRef as ProposedAction["actionId"],
    targetSystem: entry.targetSystem as TargetSystem,
    canonicalObjectKey: entry.canonicalObjectKey,
    payload: (entry.payload as Record<string, unknown>) ?? {},
    approvalPolicy: entry.approvalPolicy ?? REDRIVE_APPROVAL_POLICY,
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
  /**
   * 24.50 — the workspace `gatewayDeps.requireApproval`'s bound posture was
   * RESOLVED FOR (see the module header). REQUIRED, deliberately: every caller
   * must state its scope — there is no safe default that wouldn't silently
   * re-open the mis-binding this field exists to close. A due entry whose
   * PERSISTED `OutboxEntry.workspaceId` disagrees with this value is skipped by
   * `drainOutbox` (see `counts.skipped`) rather than evaluated against the wrong
   * workspace's posture. A mixed-workspace outbox is drained by one pass per
   * workspace, each binding both `gatewayDeps` AND this field to the SAME
   * workspace.
   */
  readonly workspaceId: string;
  readonly now: string;
  readonly limit: number;
  readonly backoffCfg: BackoffConfig;
  readonly clock: () => string;
  readonly jitter?: (baseDelayMs: number) => number;
  /**
   * 21.4a — the injectable ROUTED-DISPATCH seam. OPTIONAL: absent ⇒ byte-
   * equivalent to pre-21.4 behavior (`dispatchExternalWrite` is called directly).
   * Bound, the drain re-drives each entry through THIS function instead — the
   * worker binds it to `dispatchRouted` over the write-adapter registry, the SAME
   * expression already used by the live `propose`/`dispatchApproved` paths — so
   * a held write reaches the correct per-vendor adapter instead of whatever
   * (possibly fail-closed sentinel) adapter sits on `gatewayDeps.adapter`.
   */
  readonly dispatch?: (
    env: ExternalWriteEnvelope,
    action: ProposedAction,
    deps: ExternalWriteDeps,
  ) => Promise<ExternalWriteResult>;
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
  /**
   * 24.50 — entries SKIPPED because `entry.workspaceId !== deps.workspaceId`:
   * the cross-workspace-mismatch guard fired. NOT an attempt (attempts is NOT
   * bumped, no `nextAttemptAt` is set, no store write happens at all) — the
   * entry is left exactly as it was for a later, correctly-scoped pass to drain.
   */
  readonly skipped: number;
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
 *
 * SINGLE-WORKSPACE-SCOPED (task 24.50): `listDue` does not filter by workspace,
 * so `deps.workspaceId` must name the workspace `deps.gatewayDeps` was bound for
 * — a due entry whose OWN `workspaceId` disagrees is skipped, never evaluated
 * against the wrong posture. Drain a mixed-workspace outbox with one pass per
 * workspace.
 */
export async function drainOutbox(
  outbox: OutboxRepository,
  deps: DrainDeps,
): Promise<DrainResult> {
  const counts = { drained: 0, reused: 0, held: 0, failed: 0, skipped: 0 };
  // 21.4a: an injected `dispatch` shares the live path's target-routing decision;
  // absent, fall back to the pre-21.4 direct call (byte-equivalent).
  const dispatch = deps.dispatch ?? dispatchExternalWrite;

  const due = await outbox.listDue(deps.now, deps.limit);
  if (!isOk(due)) {
    // A store fault on the list is fail-closed: nothing drained, nothing dropped.
    return counts;
  }

  for (const entry of due.value) {
    // 24.50 STRUCTURAL cross-workspace guard: `gatewayDeps.requireApproval`'s
    // posture is bound for `deps.workspaceId` ONLY (see module header +
    // `DrainDeps.workspaceId`'s docblock). An entry from any OTHER workspace is
    // SKIPPED before it reaches the (wrongly-bound) predicate or the gateway at
    // all — no dispatch, no store write, no attempts bump, no nextAttemptAt. The
    // entry is left exactly as it was so a later pass, correctly scoped to ITS
    // workspace, still drains it (held items still never silently expire).
    if (entry.workspaceId !== deps.workspaceId) {
      counts.skipped += 1;
      continue;
    }

    // Reconstruct the linked envelope + action from the persisted entry and
    // re-drive through the identical dispatch pipeline (existence check + replay
    // gate → no duplicate create).
    const env = rebuildEnvelope(entry);
    const action = rebuildAction(entry);
    const outcome = await dispatch(env, action, deps.gatewayDeps);
    const bucket = await applyOutcome(outbox, entry, outcome, deps);
    counts[bucket] += 1;
  }

  return counts;
}
