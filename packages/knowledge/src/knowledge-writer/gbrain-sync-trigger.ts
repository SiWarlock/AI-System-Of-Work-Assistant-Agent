// Post-commit GBrain sync trigger (§6, task 4.4). Fires ONLY after the Markdown
// commit has durably landed (safety rule 1: committed_to_markdown never rolls
// back — writer.ts step 8). The trigger is ASYNCHRONOUS and best-effort: it
// enqueues a durable re-index job and kicks the async index, but it NEVER rolls
// back, blocks, or invalidates the committed Markdown (REQ-D-001; the brain is a
// DERIVED store). A GBrain-sync failure therefore leaves the commit intact and
// degrades to a durable outbox entry + a distinct `sync_lagging` System Health
// item (§16) — commit durability is independent of index success.
//
// IDEMPOTENCY: keyed by (workspaceId, revisionId). A duplicate trigger for the
// same committed revision collapses to ONE effective index (no second enqueue, no
// second dispatch) — task 4.4 bullet 2.
//
// NEVER THROWS across the boundary (§16): every outcome is a typed `Result`,
// including a badly-behaved injected dispatcher that throws (caught → sync_lagging).
import { ok, err } from "@sow/contracts";
import { HealthItemSchema } from "@sow/contracts";
import type { HealthItem, Result } from "@sow/contracts";
import { knowledgeMutationMachine } from "@sow/domain";
import type { RevisionId } from "./revision";
import {
  buildSyncOutboxEntry,
  type GbrainSyncOutboxEntry,
  type GbrainSyncOutboxStore,
} from "./sync-outbox";

// ── inputs / injected deps ──────────────────────────────────────────────────

/** The just-committed revision the trigger must schedule a re-index for. */
export interface GbrainSyncTriggerInput {
  readonly workspaceId: string;
  readonly committedRevisionId: RevisionId;
  readonly planId: string;
  /** AuditId of the commit that produced this revision (health-item linkage). */
  readonly auditRef: string;
  readonly sourceEventRef?: string;
}

/** Typed failure surface of the async index kick (the task-4.8 dispatcher). */
export interface GbrainSyncDispatchError {
  readonly code: "gbrain_unavailable" | "dispatch_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Injected async index kick — the seam to the task-4.8 index-apply. Optional: when
 * absent, the trigger only enqueues (drain-on-wake, task 4.6, handles dispatch).
 * Returns a typed `Result`; the trigger also defends against it THROWING.
 */
export type GbrainIndexDispatcher = (
  entry: GbrainSyncOutboxEntry,
) => Promise<Result<void, GbrainSyncDispatchError>>;

export interface GbrainSyncTriggerDeps {
  readonly outbox: GbrainSyncOutboxStore;
  /** Injected clock (ISO-8601) — keeps the trigger deterministic under test. */
  readonly now: () => string;
  /** Injected System Health id minter (no ambient random). */
  readonly newHealthItemId: () => string;
  readonly dispatchIndex?: GbrainIndexDispatcher;
}

// ── outcome / fault ─────────────────────────────────────────────────────────

/**
 * - `queued` — enqueued; no dispatcher wired, drain-on-wake will index it.
 * - `already_queued` — idempotent collapse: an entry already existed (no re-work).
 * - `dispatched` — enqueued + the async re-index kick succeeded.
 * - `lagging` — enqueued but the re-index kick failed; durable retry + health item.
 */
export type GbrainSyncOutcomeKind =
  | "queued"
  | "already_queued"
  | "dispatched"
  | "lagging";

export interface GbrainSyncOutcome {
  readonly kind: GbrainSyncOutcomeKind;
  readonly entry: GbrainSyncOutboxEntry;
  /** The advanced Knowledge Mutation state this outcome reflects. */
  readonly mutationState: "gbrain_sync_queued" | "sync_lagging";
  /** Present IFF `kind === "lagging"`: the distinct sync_lagging item (§16). */
  readonly healthItem?: HealthItem;
}

/**
 * The ONLY hard fault: the operational sync outbox itself is unavailable, so the
 * re-index could not even be durably queued. The Markdown commit is STILL intact
 * (the trigger holds no vault handle and never rolls back) — so the fault carries
 * a `sync_lagging` HealthItem for System Health rather than failing the commit.
 */
export interface GbrainSyncTriggerFault {
  readonly code: "outbox_unavailable";
  readonly message: string;
  readonly healthItem: HealthItem;
  readonly cause?: unknown;
}

// ── trigger ─────────────────────────────────────────────────────────────────

// The two Knowledge Mutation states this trigger advances into. Asserted against
// the shared DOMAIN_MODEL machine at module load so a future edit that removed the
// committed_to_markdown → gbrain_sync_queued or gbrain_sync_queued → sync_lagging
// edge trips this invariant (rather than silently drifting). The values stay
// narrow literals; the machine is the source of the EDGE, not the label.
const QUEUED_STATE = "gbrain_sync_queued" as const;
const LAGGING_STATE = "sync_lagging" as const;

// Load-time fail-fast: only trips if the DOMAIN_MODEL machine loses these edges.
if (
  !knowledgeMutationMachine.canTransition("committed_to_markdown", QUEUED_STATE) ||
  !knowledgeMutationMachine.canTransition(QUEUED_STATE, LAGGING_STATE)
) {
  throw new Error(
    "invariant: Knowledge Mutation machine is missing the committed_to_markdown → " +
      "gbrain_sync_queued → sync_lagging edges the GBrain sync trigger depends on",
  );
}

/**
 * Trigger the post-commit GBrain re-index. See the module header for the
 * async / idempotent / never-rolls-back contract. Returns a typed outcome (or a
 * typed `outbox_unavailable` fault, itself carrying a health item); NEVER throws.
 */
export async function triggerGbrainSync(
  input: GbrainSyncTriggerInput,
  deps: GbrainSyncTriggerDeps,
): Promise<Result<GbrainSyncOutcome, GbrainSyncTriggerFault>> {
  // 1 — idempotent collapse: a prior trigger for this revision already queued it.
  const existing = await deps.outbox.getByKey(
    input.workspaceId,
    input.committedRevisionId,
  );
  if (!existing.ok) {
    return err(
      outboxUnavailable(deps, input, "getByKey", existing.error.message, existing.error),
    );
  }
  if (existing.value !== undefined) {
    return ok({
      kind: "already_queued",
      entry: existing.value,
      mutationState: QUEUED_STATE,
    });
  }

  // 2 — persist a fresh durable job (advances committed_to_markdown →
  //     gbrain_sync_queued). This is operational truth; a persist fault degrades
  //     to sync_lagging but NEVER rolls back the (durable) Markdown commit.
  const fresh = buildSyncOutboxEntry({
    workspaceId: input.workspaceId,
    revisionId: input.committedRevisionId,
    planId: input.planId,
    auditRef: input.auditRef,
    ...(input.sourceEventRef !== undefined
      ? { sourceEventRef: input.sourceEventRef }
      : {}),
    enqueuedAt: deps.now(),
  });
  const enq = await deps.outbox.enqueue(fresh);
  if (!enq.ok) {
    return err(
      outboxUnavailable(deps, input, "enqueue", enq.error.message, enq.error),
    );
  }
  const entry = enq.value;

  // 3 — no dispatcher wired: leave it queued for drain-on-wake (task 4.6).
  if (deps.dispatchIndex === undefined) {
    return ok({ kind: "queued", entry, mutationState: QUEUED_STATE });
  }

  // 4 — best-effort async re-index kick. Any failure (typed err OR a thrown
  //     dispatcher) degrades to sync_lagging: durable retry + distinct health item.
  const dispatch = await runDispatch(deps.dispatchIndex, entry);
  if (dispatch.ok) {
    return ok({ kind: "dispatched", entry, mutationState: QUEUED_STATE });
  }

  const lagging: GbrainSyncOutboxEntry = {
    ...entry,
    status: LAGGING_STATE,
    attempts: entry.attempts + 1,
    lastAttemptAt: deps.now(),
    lastError: dispatch.error.message,
  };
  // Persist the lagging advance for retry bookkeeping. If the update itself
  // fails, the entry is still durably enqueued (step 2) as gbrain_sync_queued, so
  // drain-on-wake still retries it — swallow the update fault, stay lagging.
  await deps.outbox.update(lagging);

  return ok({
    kind: "lagging",
    entry: lagging,
    mutationState: LAGGING_STATE,
    healthItem: buildSyncLaggingHealthItem(deps, input, dispatch.error.message),
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Await the injected dispatcher, converting a THROWN error into a typed err. */
async function runDispatch(
  dispatch: GbrainIndexDispatcher,
  entry: GbrainSyncOutboxEntry,
): Promise<Result<void, GbrainSyncDispatchError>> {
  try {
    return await dispatch(entry);
  } catch (cause) {
    return err({
      code: "dispatch_failed",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
}

function outboxUnavailable(
  deps: GbrainSyncTriggerDeps,
  input: GbrainSyncTriggerInput,
  op: string,
  message: string,
  cause: unknown,
): GbrainSyncTriggerFault {
  return {
    code: "outbox_unavailable",
    message: `GBrain sync outbox ${op} unavailable: ${message}`,
    healthItem: buildSyncLaggingHealthItem(
      deps,
      input,
      `sync outbox ${op} unavailable`,
    ),
    cause,
  };
}

/**
 * Build the distinct `sync_lagging` System Health item (§16), validated through
 * the frozen `HealthItemSchema` so a malformed record can never surface. On the
 * (unreachable) parse-fail path we still return a minimal, type-correct item — the
 * trigger must never throw and must always surface the lag.
 */
function buildSyncLaggingHealthItem(
  deps: GbrainSyncTriggerDeps,
  input: GbrainSyncTriggerInput,
  reason: string,
): HealthItem {
  const candidate = {
    id: deps.newHealthItemId(),
    failureClass: "sync_lagging" as const,
    // severity is an OPEN string upstream (no closed enum) — see HealthItem model.
    severity: "warn",
    message:
      `GBrain re-index lagging for workspace ${input.workspaceId} at revision ` +
      `${input.committedRevisionId}: ${reason}. Markdown commit is durable; ` +
      `retry via the sync outbox.`,
    auditRef: input.auditRef,
    openedAt: deps.now(),
    state: "open" as const,
  };
  const parsed = HealthItemSchema.safeParse(candidate);
  return parsed.success ? parsed.data : (candidate as unknown as HealthItem);
}
