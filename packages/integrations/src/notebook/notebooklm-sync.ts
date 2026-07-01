// @sow/integrations — 6.6 notebooklm.sync: Drive-backed managed-doc upsert.
//
// `createNotebookLmSync(deps)` implements `NotebookPort`. For each of the five
// 00–04 slots it UPSERTS the mapped Drive doc THROUGH the Tool Gateway / Drive
// adapter, using a STABLE per-slot canonicalObjectKey =
//   buildCanonicalObjectKey({ targetSystem:'drive', identity:{ project, slot } })
// so a re-sync updates IN PLACE — idempotent, NO duplicate Drive docs on replay
// (safety invariant 2 is enforced by the gateway's pre-write existence check /
// receipt reuse; this module just supplies the stable key).
//
// A missing/unlinked managed source — a blank mapping slot id, or an adapter-404
// surfaced by the gateway — yields a typed `reattach_required` state for that
// slot (re-add/refresh the NotebookLM source), NOT a silent failure and NOT a
// throw (§16 fail-closed). Any other gateway fault (a non-404 reject / conflict /
// hold) fails the whole sync closed with a typed `NotebookError`.
//
// SCOPE (arch_gap / §15): Drive-backed ONLY — the direct NotebookLM API is
// V1.1/spike-gated, so this module never talks to NotebookLM directly. Reported
// in flags.
//
// §16: every method returns a typed Result; nothing throws across the boundary.
// PURITY: no real network/clock/randomness — the gateway deps + clock are
// injected; `buildCanonicalObjectKey` / `buildIdempotencyKey` are pure.
import { ok, err, isOk, actionId } from "@sow/contracts";
import type { Result, ProposedAction, NotebookMapping } from "@sow/contracts";
import { buildCanonicalObjectKey, buildIdempotencyKey } from "@sow/domain";
import {
  dispatchExternalWrite,
  type ExternalWriteDeps,
  type ExternalWriteResult,
} from "../tools/gateway";
import { buildEnvelopeFromAction } from "../tools/envelope";
import { holdWrite, type HoldDeps } from "../tools/outbox";
import type { OutboxRepository } from "../ports/persistence";
import {
  NOTEBOOK_SLOTS,
  type NotebookPort,
  type NotebookSlot,
  type ManagedDocBodies,
  type NotebookSyncResult,
  type NotebookError,
} from "./notebook-port";

/** The stable operation label the per-slot idempotencyKey is built over. */
const SYNC_OPERATION = "notebooklm.sync" as const;

/**
 * Injected deps for the sync. `gateway` — the fully-wired Tool-Gateway
 * `ExternalWriteDeps` (Drive adapter + receipt store + approval verdict +
 * audit/log sinks + clock) the per-slot dispatch runs against. `approvalPolicy` —
 * the `ProposedAction.approvalPolicy` stamped on each slot's action (the gateway's
 * own `requireApproval` verdict is what actually gates; this is the recorded
 * policy label). `clock` — injected ISO clock for the actions' construction path
 * (no `Date.now()` in src).
 */
export interface NotebookSyncDeps {
  readonly gateway: ExternalWriteDeps;
  readonly approvalPolicy: string;
  readonly clock: () => string;
  /**
   * Optional write-outbox wiring (§8 hold-through-outage). When present, a slot
   * whose Drive write comes back HELD because the target is unreachable (an
   * outage, not a 404/reattach) is enqueued to the outbox via `holdWrite` — held,
   * NOT dropped, and NOT a hard sync failure — for a replay-safe drain later. When
   * absent, an unreachable hold fails the sync closed (backward-compatible).
   */
  readonly outbox?: {
    readonly repo: OutboxRepository;
    readonly hold: HoldDeps;
    readonly workspaceId: string;
  };
}

/** A `reattach_required` reason surfaced by the gateway = a 404 / not-found /
 * unlinked-source fault on the Drive doc. Matched case-insensitively against the
 * gateway's redaction-safe `reason` string (which carries only the adapter's
 * diagnostic — never raw content). */
const REATTACH_SIGNAL = /\b404\b|not[_\s-]?found|unlinked|missing/i;

function isReattachReason(reason: string): boolean {
  return REATTACH_SIGNAL.test(reason);
}

// The result of dispatching one slot: upserted (created/reused), reattach
// (missing/unlinked source), held (unreachable → enqueued to the outbox for a
// replay-safe drain), or a hard failure that fails the whole sync closed.
type SlotOutcome =
  | { readonly kind: "upserted" }
  | { readonly kind: "reattach" }
  | { readonly kind: "held" }
  | { readonly kind: "error"; readonly error: NotebookError };

// Build the ProposedAction for one slot: a Drive upsert keyed by the stable
// per-slot canonicalObjectKey + idempotencyKey. The payload carries the target
// Drive doc id, the slot, and the assembled body — it is hashed into the
// envelope's payloadHash and never logged raw (the gateway redacts).
function buildSlotAction(
  mapping: NotebookMapping,
  slot: NotebookSlot,
  body: string,
  driveDocId: string,
  approvalPolicy: string,
): ProposedAction {
  const identity = { project: mapping.projectId, slot };
  const canonicalObjectKey = buildCanonicalObjectKey({ targetSystem: "drive", identity });
  const idempotencyKey = buildIdempotencyKey({ operation: SYNC_OPERATION, identity });
  return {
    actionId: actionId(`${SYNC_OPERATION}:${mapping.projectId}:${slot}`),
    targetSystem: "drive",
    canonicalObjectKey,
    payload: {
      operation: SYNC_OPERATION,
      driveFolderId: mapping.driveFolderId,
      driveDocId,
      slot,
      body,
    },
    approvalPolicy,
    idempotencyKey,
  };
}

// Map the gateway's ExternalWriteResult onto a slot outcome. created/reused →
// upserted (idempotent in-place, no duplicate Drive doc). A 404/not-found/
// unlinked reason (on any typed hold/conflict/reject) → reattach. Anything else →
// a hard failure (fail-closed; never reported as a clean upsert).
function classifyDispatch(slot: NotebookSlot, result: ExternalWriteResult): SlotOutcome {
  switch (result.status) {
    case "created":
    case "reused":
      return { kind: "upserted" };
    case "approval_pending":
      // Approval-gated: the doc is NOT yet written. Not a reattach; the sync
      // fails closed so the caller does not treat a pending write as synced.
      return {
        kind: "error",
        error: { code: "dispatch_failed", slot, message: "slot upsert awaiting approval" },
      };
    case "conflict":
    case "held":
    case "rejected":
      return isReattachReason(result.reason)
        ? { kind: "reattach" }
        : {
            kind: "error",
            error: { code: "dispatch_failed", slot, message: `${result.status}: ${result.reason}` },
          };
  }
}

// Upsert one slot end-to-end: blank mapping id → reattach (no dispatch); else
// build the action + envelope and dispatch through the gateway.
async function syncSlot(
  mapping: NotebookMapping,
  slot: NotebookSlot,
  body: string,
  deps: NotebookSyncDeps,
): Promise<SlotOutcome> {
  const driveDocId = mapping.managedDocIds[slot];
  // A blank/whitespace mapping id means the managed source is not linked — surface
  // reattach WITHOUT issuing any external write.
  if (driveDocId.trim().length === 0) {
    return { kind: "reattach" };
  }

  const action = buildSlotAction(mapping, slot, body, driveDocId, deps.approvalPolicy);
  const built = buildEnvelopeFromAction(action, { preconditions: ["exists_check"] });
  if (!built.ok) {
    return {
      kind: "error",
      error: { code: "gate_rejected", slot, message: built.error.message },
    };
  }

  const dispatched = await dispatchExternalWrite(built.value, action, deps.gateway);

  // §8 HOLD-THROUGH-OUTAGE: a held write whose reason is NOT a reattach (i.e. the
  // Drive target is unreachable — an outage, not a missing/unlinked source) is
  // enqueued to the write outbox for a replay-safe drain later, rather than
  // dropped or failed. Only when an outbox is wired; otherwise it falls through to
  // the fail-closed classifier (backward-compatible).
  if (
    dispatched.status === "held" &&
    !isReattachReason(dispatched.reason) &&
    deps.outbox !== undefined
  ) {
    const held = await holdWrite(
      {
        env: built.value,
        action,
        reason: "unreachable",
        workspaceId: deps.outbox.workspaceId,
      },
      deps.outbox.repo,
      deps.outbox.hold,
    );
    if (!isOk(held)) {
      return {
        kind: "error",
        error: {
          code: "dispatch_failed",
          slot,
          message: `slot held but outbox enqueue failed: ${held.error.message}`,
        },
      };
    }
    return { kind: "held" };
  }

  return classifyDispatch(slot, dispatched);
}

/**
 * Factory: a `NotebookPort` whose `sync` upserts all five 00–04 managed docs for
 * a `NotebookMapping` through the injected Tool Gateway. Slots are processed in
 * canonical 00→04 order; the upserted / reattachRequired lists partition the five
 * slots. The first hard (non-reattach) fault fails the whole sync closed. Never
 * throws.
 */
export function createNotebookLmSync(deps: NotebookSyncDeps): NotebookPort {
  return {
    async sync(
      mapping: NotebookMapping,
      bodies: ManagedDocBodies,
    ): Promise<Result<NotebookSyncResult, NotebookError>> {
      const upserted: NotebookSlot[] = [];
      const reattachRequired: NotebookSlot[] = [];
      const heldForRetry: NotebookSlot[] = [];

      for (const slot of NOTEBOOK_SLOTS) {
        const outcome = await syncSlot(mapping, slot, bodies[slot], deps);
        if (outcome.kind === "error") {
          return err(outcome.error);
        }
        if (outcome.kind === "reattach") {
          reattachRequired.push(slot);
        } else if (outcome.kind === "held") {
          heldForRetry.push(slot);
        } else {
          upserted.push(slot);
        }
      }

      return ok({ upserted, reattachRequired, heldForRetry });
    },
  };
}
