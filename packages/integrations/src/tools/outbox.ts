// @sow/integrations — slice 6.5 WRITE OUTBOX: hold-on-outage (§8/§9 replay gate).
//
// The Tool Gateway (`dispatchExternalWrite`, 6.2) returns `{status:'held'}` when a
// write CANNOT proceed right now — the target is unreachable (adapter/existence-
// probe fault) or the action is queued awaiting approval. Rather than DROP or FAIL
// that write, the caller hands it to `holdWrite`, which persists the FULL envelope
// (idempotencyKey + canonicalObjectKey + payloadHash + targetSystem + payload) as
// an OutboxEntry via `OutboxRepository.enqueue`. The reconnect drain (6.5b) later
// re-drives the entry replay-safely.
//
// Safety invariant 4 (this slice's load-bearing rule): HELD ITEMS NEVER SILENTLY
// EXPIRE. A held entry is mapped onto a NON-TERMINAL ProposedAction machine state
// (proposed | retry_queued), so `listDue` always returns it — a held write is never
// silently lost. Terminal states (receipt_recorded | rejected | expired) are
// reserved for the drain's committed outcomes, never for a hold.
//
// REPLAY IDEMPOTENCY: re-holding the SAME idempotencyKey is a no-op — the existing
// entry is reused, never a second enqueue (the §8 replay gate on the outbox).
//
// §16: async, returns a typed Result, NEVER throws. Pure apart from injected deps
// (`clock`, `outboxId`) — no `Date.now()` / `Math.random()` in this module.
import type {
  ProposedAction,
  ExternalWriteEnvelope,
  Result,
} from "@sow/contracts";
import { ok, err, isOk } from "@sow/contracts";
import type { OutboxRepository, OutboxEntry } from "../ports/persistence";
import type { DbError } from "@sow/db";
import {
  buildToolWriteHealthSignal,
  type GatewayHealthSignal,
} from "../health/health-signal";

/**
 * Why a write is being held. Each maps onto a NON-TERMINAL machine state so the
 * entry stays drainable (never expires):
 *   • `unreachable` — the target/existence probe faulted (dispatch returned held)
 *     → `retry_queued` (the drain will re-attempt on reconnect).
 *   • `queued`      — a generic queued-for-dispatch hold → `retry_queued`.
 *   • `not_approved`— dispatch returned approval_pending; the write waits for the
 *     approval to land → `proposed` (awaiting the approval gate, not yet retryable).
 */
export type HoldReason = "unreachable" | "queued" | "not_approved";

/** Injected effects for a hold — no real clock/randomness in the module (§16). */
export interface HoldDeps {
  /** ISO timestamp source (injected — never `Date.now()`). */
  readonly clock: () => string;
  /** Fresh outbox id source (injected — never `Math.random()`/`crypto`). */
  readonly outboxId: () => string;
}

/** The write to hold: the linked envelope + action + the reason + workspace. */
export interface HoldWriteArgs {
  readonly env: ExternalWriteEnvelope;
  readonly action: ProposedAction;
  readonly reason: HoldReason;
  readonly workspaceId: string;
}

/**
 * Map a hold reason onto a NON-TERMINAL ProposedAction machine state. A held entry
 * is NEVER terminal (receipt_recorded | rejected | expired) — that would make it
 * silently expire from `listDue`. `unreachable`/`queued` → `retry_queued` (the
 * drain re-attempts); `not_approved` → `proposed` (awaiting the approval gate).
 */
export function toOutboxStatus(reason: HoldReason): "proposed" | "retry_queued" {
  return reason === "not_approved" ? "proposed" : "retry_queued";
}

/**
 * Hold a write that cannot dispatch now: persist its FULL envelope as a
 * (non-terminal) OutboxEntry so the drain can re-drive it replay-safely. A replay
 * (same idempotencyKey already held) is a no-op — the existing entry is reused,
 * never a second enqueue. Returns the persisted (or reused) entry, or a typed
 * store error. Never throws.
 */
export async function holdWrite(
  args: HoldWriteArgs,
  outbox: OutboxRepository,
  deps: HoldDeps,
): Promise<Result<OutboxEntry, DbError>> {
  const { env, action, reason, workspaceId } = args;

  // REPLAY gate: a write already held under this idempotencyKey is reused, never
  // re-enqueued. (A `not_found` from the store means novel → enqueue below.)
  const existing = await outbox.getByIdempotencyKey(env.idempotencyKey);
  if (isOk(existing)) {
    return ok(existing.value);
  }

  const now = deps.clock();
  const entry: OutboxEntry = {
    outboxId: deps.outboxId(),
    actionRef: action.actionId,
    workspaceId,
    targetSystem: env.targetSystem,
    canonicalObjectKey: env.canonicalObjectKey,
    idempotencyKey: env.idempotencyKey,
    payloadHash: env.payloadHash,
    status: toOutboxStatus(reason),
    payload: action.payload,
    attempts: 0,
    enqueuedAt: now,
    updatedAt: now,
  };

  const enqueued = await outbox.enqueue(entry);
  if (!isOk(enqueued)) {
    return err(enqueued.error);
  }
  return ok(enqueued.value);
}

/** Inputs to the OBS-2 depth check. `depthThreshold` — depth ABOVE which we emit. */
export interface OutboxHealthDeps {
  readonly now: string;
  readonly depthThreshold: number;
  /** Upper bound on entries scanned for the depth probe. */
  readonly limit: number;
}

/**
 * OBS-2 depth signal. When the count of DUE (non-terminal, held) outbox entries
 * exceeds `depthThreshold`, emit a `write_through_failed` GatewayHealthSignal so
 * the operator sees the blocked write-through backlog. This is READ-ONLY — it
 * NEVER expires or mutates a held entry (held items never silently expire).
 * Returns `undefined` when depth is at/below the threshold (or on a store fault —
 * a health probe never fails the caller). Never throws.
 */
export async function outboxHealth(
  outbox: OutboxRepository,
  deps: OutboxHealthDeps,
): Promise<GatewayHealthSignal | undefined> {
  const due = await outbox.listDue(deps.now, deps.limit);
  if (!isOk(due)) {
    return undefined;
  }
  const depth = due.value.length;
  if (depth <= deps.depthThreshold) {
    return undefined;
  }
  return buildToolWriteHealthSignal({
    subjectRef: "outbox",
    reason: `outbox depth ${depth} exceeds threshold ${deps.depthThreshold}`,
    kind: "write_through_failed",
  });
}
