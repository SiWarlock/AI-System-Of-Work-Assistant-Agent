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
// throw (§16 fail-closed). A non-reattach HOLD is enqueued to the write outbox
// when one is wired (`NotebookSyncDeps.outbox`, §8 hold-through-outage) and only
// fails the sync closed when it is not. The hold's CAUSE rides
// `NotebookSyncDetail.heldDetail` (the gateway's closed `adapterCode` + its
// redaction-safe reason) so a locked Keychain and a Drive outage are not the same
// observation, and `NotebookSyncDetail.outcome` names the partial state so an `ok`
// with held/reattach slots is never readable as "the notebook is in sync". Every
// OTHER gateway fault — a non-404 reject, a conflict, an approval_pending — fails
// the whole sync closed with a typed `NotebookError`.
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
import { buildCanonicalObjectKey, buildIdempotencyKey, sha256Hex } from "@sow/domain";
import {
  dispatchExternalWrite,
  type ExternalWriteDeps,
  type ExternalWriteResult,
} from "../tools/gateway";
import type { AdapterError } from "../tools/adapter-port";
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

/**
 * R2 FIX: a `reattach_required` outcome is discriminated by the closed
 * `AdapterError.code` riding `ExternalWriteResult.adapterCode` — a real FIELD,
 * never by parsing the human-readable `reason` string. Control flow must never
 * depend on parsing a redaction-safe diagnostic meant for an operator's eyes.
 *
 * PRIOR BUGS (both were free-text matching over `reason`, in two shapes):
 *   R1 — a regex (`/\b404\b|not[_\s-]?found|unlinked|missing/i`) matched
 *        DESCRIPTIVE fault text that a later redaction pass removed, so a
 *        Drive 404 (`existence-check fault (rejected)` / `create fault
 *        (rejected)`) never matched and failed the WHOLE five-slot sync
 *        closed instead of yielding a per-slot reattach.
 *   R1.5 — the follow-up fix swapped the regex for `reason.endsWith("(" +
 *        REATTACH_CODE + ")")`: tidier, but STILL string-matching a value
 *        whose exact shape is gateway-internal formatting, not a contract.
 *        The moment the gateway's `reason` format changed shape again (to
 *        restore the adapter's diagnostic message alongside the code — see
 *        gateway.ts's `ExternalWriteResult` doc comment) this `endsWith`
 *        check broke a second time, silently.
 * The fix: read `result.adapterCode` directly. It is a real field, set from
 * `AdapterError.code` at every gateway construction site that originates from
 * an adapter fault (existence-check / create), and it is untouched by any
 * change to `reason`'s prose. This cannot break the same way again.
 */
const REATTACH_CODE = "not_found" as const;

function isReattachResult(
  result: Extract<ExternalWriteResult, { status: "conflict" | "held" | "rejected" }>,
): boolean {
  return result.adapterCode === REATTACH_CODE;
}

/**
 * WHY a held slot's CAUSE has to reach the caller.
 *
 * `NotebookSyncResult.heldForRetry` carries slot NAMES only. So before this type
 * existed, a Drive outage and a locked Keychain (the 21.10 credential seam) were
 * INDISTINGUISHABLE at the boundary: both produced `ok({heldForRetry:[…]})` with
 * nothing naming the cause — and the operator remedies are opposite (one waits for
 * the vendor to come back, the other unlocks the Keychain and re-runs). The hold
 * branch below had the gateway's own typed fault in hand and dropped it on the
 * floor.
 *
 * WHAT THIS CAN AND CANNOT TELL APART — do not read it as more than it is:
 *   • `adapterCode` PRESENT ⇒ the hold came from a real `AdapterError` raised by
 *     the Drive adapter (the gateway sets it at both the existence-check and the
 *     create fault arm, gateway.ts steps 3/5). Today only `"unreachable"` reaches
 *     a `held` status — a genuine "could not reach the target at all" outage.
 *   • `adapterCode` ABSENT ⇒ the hold did NOT originate from an adapter fault. The
 *     gateway has exactly two such holds: the §21.10 credential fault (a missing /
 *     locked / denied / empty write token, gateway.ts:239) and the
 *     reservation-in-progress hold (a concurrent dispatch is mid-create,
 *     gateway.ts:320). These two are NOT distinguishable by any typed field the
 *     gateway exposes — `ExternalWriteResult` carries no `faultDetail` — so the
 *     operator distinguishes them by READING `reason`, which carries the closed
 *     `"locked"`/`"missing"`/`"denied"`/`"empty"` token for the credential case
 *     (worker LESSONS §41) and a fixed reservation literal for the other.
 *
 * ⛔ `reason` is for a HUMAN, not for control flow. Nothing in this module branches
 * on it — the reattach signal reads `adapterCode` (see `isReattachResult`), and a
 * consumer that needs to branch on a held cause must do the same. Forwarding the
 * string is what restores the operator signal; parsing it is what broke this module
 * twice already (R1 / R1.5 above).
 */
export interface NotebookHeldSlot {
  /** The 00–04 slot whose write was held. */
  readonly slot: NotebookSlot;
  /**
   * The gateway's closed `AdapterError.code` when the hold came from an adapter
   * fault; ABSENT for a hold that never originated from one (see above). Branch on
   * THIS, never on `reason`.
   */
  readonly adapterCode?: AdapterError["code"];
  /**
   * The gateway's redaction-safe operator diagnostic, forwarded VERBATIM. Safe by
   * construction or by contract at every `held` site (gateway.ts's
   * `ExternalWriteResult` doc comment): a closed code in a fixed template, or an
   * adapter-authored `AdapterError.message`. Never re-sanitized here — the one
   * boundary that owes that duty is the adapter, and double-redacting would only
   * cost the operator the cause without adding safety.
   */
  readonly reason: string;
}

/**
 * The five-slot sync result, widened with the per-slot hold causes and an explicit
 * completeness discriminant. Extends `NotebookSyncResult`, so every existing caller
 * typed against the narrower port keeps compiling and reading the same three lists.
 *
 * `outcome` — `"synced"` ONLY when all five slots upserted; `"incomplete"` when ANY
 * slot needed reattach or was held. This exists because `ok` alone was being read as
 * "the notebook is in sync", which it is not: a held slot's Drive doc still carries
 * the PREVIOUS body until the outbox drains, and a reattach slot was never written
 * at all. See `createNotebookLmSync`'s doc comment for why the held case is still an
 * `ok` rather than an `err`.
 *
 * `heldDetail` — one entry per slot in `heldForRetry`, in the same canonical 00→04 order,
 * naming WHY that slot was held.
 */
export interface NotebookSyncDetail extends NotebookSyncResult {
  readonly outcome: "synced" | "incomplete";
  readonly heldDetail: readonly NotebookHeldSlot[];
}

/**
 * `NotebookPort` narrowed to the detail-carrying result. Assignable to
 * `NotebookPort` (the result type only widens), so the workflow driver + any other
 * consumer typed against the base port is unaffected.
 */
export interface NotebookSyncDetailPort extends NotebookPort {
  sync(
    mapping: NotebookMapping,
    bodies: ManagedDocBodies,
  ): Promise<Result<NotebookSyncDetail, NotebookError>>;
}

// The result of dispatching one slot: upserted (created/reused), reattach
// (missing/unlinked source), held (enqueued to the outbox for a replay-safe drain,
// carrying the cause), or a hard failure that fails the whole sync closed.
type SlotOutcome =
  | { readonly kind: "upserted" }
  | { readonly kind: "reattach" }
  | { readonly kind: "held"; readonly held: NotebookHeldSlot }
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
  // WHICH OBJECT — stable per slot, and deliberately CONTENT-FREE: the §8 pre-write
  // existence probe must resolve to the SAME Drive doc on every sync, so an edit
  // updates that doc in place rather than creating a second one (safety rule 3).
  const canonicalObjectKey = buildCanonicalObjectKey({ targetSystem: "drive", identity });
  // WHICH WRITE — and therefore CONTENT-BEARING. ⛔ This previously keyed on the
  // identity alone, so every sync of a slot produced the SAME idempotencyKey: the
  // receipt store replayed the first receipt, the gateway returned `reused`, and
  // `classifyDispatch` folded that to `upserted`. Measured consequence — a re-sync
  // whose bodies had CHANGED issued ZERO vendor writes, carried none of the new
  // content, and still reported `outcome: "synced"`. Edited notes never reached
  // Drive and the caller was told the vault was in sync.
  //
  // Hashing the body makes the key vary with content, which is exactly the
  // distinction rule 3 wants: an IDENTICAL re-sync is a replay (reuse the receipt,
  // no duplicate write), a CHANGED body is a new write against the same object.
  const idempotencyKey = buildIdempotencyKey({
    operation: SYNC_OPERATION,
    identity: { ...identity, bodyHash: sha256Hex(body) },
  });
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
// upserted (idempotent in-place, no duplicate Drive doc). A closed `not_found`
// adapterCode (on any typed held/conflict/rejected status — see
// isReattachResult) → reattach. Anything else → a hard failure (fail-closed;
// never reported as a clean upsert).
function classifyDispatch(slot: NotebookSlot, result: ExternalWriteResult): SlotOutcome {
  switch (result.status) {
    case "created":
    case "updated":
    case "reused":
      // `updated` is a real in-place write of THIS body — the whole point of the
      // sync — so it counts as upserted exactly like `created`. (Before the update
      // path existed, a changed body silently took the `reused` arm and reported
      // "synced" while writing nothing; that was the bug.)
      return { kind: "upserted" };
    case "superseded":
      // Unreachable on this path today: `superseded` requires an `intentCreatedAt`,
      // which only a RE-DRIVE supplies, and this is always a fresh dispatch. If it
      // ever arrives, a fresh intent being called out-of-date is a contradiction —
      // fail CLOSED and surface it rather than silently counting a slot that was
      // never written.
      return {
        kind: "error",
        error: { code: "dispatch_failed", slot, message: `superseded: ${result.reason}` },
      };
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
      return isReattachResult(result)
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

  // §8 HOLD-THROUGH-OUTAGE: a held write that is NOT a reattach is enqueued to the
  // write outbox for a replay-safe drain later, rather than dropped or failed.
  // Only when an outbox is wired; otherwise it falls through to the fail-closed
  // classifier (backward-compatible).
  //
  // WHAT `held` CAN NOW BE — say only what is true. Since the gateway's
  // existence-fault arm learned to branch on the closed adapter code (gateway.ts
  // step 3), a `held` reaching here is one of exactly three things, and all three
  // are genuinely retryable: an `unreachable` adapter fault (the Drive target
  // could not be reached at all), the §21.10 credential fault (a missing/locked/
  // denied/empty write token — a locked Keychain does get unlocked), or the
  // reservation-in-progress hold (a concurrent dispatch is mid-create). A
  // PERMANENT vendor refusal no longer lands here at all: it arrives as
  // `rejected` and falls to `classifyDispatch`, which fails the sync closed.
  // Before that fix a 401 was enqueued as `reason:"unreachable"` and the sync
  // still returned ok — a permanent auth failure recorded as an outage.
  // The two non-adapter holds carry no `adapterCode`, so they are correctly never
  // reattach; they are enqueued with the same `"unreachable"` outbox reason,
  // which is the outbox's own retryability label, not a claim about the cause.
  if (dispatched.status === "held" && !isReattachResult(dispatched)) {
    // ⛔ THE OUTBOX IS AN AUTO-RETRY CONVENIENCE, NOT THE DEFINITION OF `held`.
    // This branch used to require `deps.outbox !== undefined`, so with no outbox
    // wired a genuinely RETRYABLE hold — a Drive 429, a 503, a network outage, a
    // locked Keychain — fell through to `classifyDispatch` and failed the WHOLE
    // five-slot sync closed. Whether the operator happens to have an outbox bound
    // is unrelated to whether this particular write can succeed later, so it must
    // not change the CLASSIFICATION of the fault. Without an outbox the slot is
    // still held; it simply will not be retried unattended.
    if (deps.outbox !== undefined) {
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
    }
    // CARRY THE CAUSE. The gateway's typed fault is in hand right here and is the
    // ONLY place it exists — `heldForRetry` is slot names, so dropping it made a
    // locked Keychain and a Drive outage the same observation at the boundary.
    // `adapterCode` is conditionally spread so the field is ABSENT (not
    // `undefined`) for a non-adapter hold, keeping "did this come from an adapter
    // fault?" answerable with an `in`/`!== undefined` check.
    return {
      kind: "held",
      held: {
        slot,
        ...(dispatched.adapterCode !== undefined ? { adapterCode: dispatched.adapterCode } : {}),
        reason: dispatched.reason,
      },
    };
  }

  return classifyDispatch(slot, dispatched);
}

/**
 * Factory: a `NotebookPort` whose `sync` upserts all five 00–04 managed docs for
 * a `NotebookMapping` through the injected Tool Gateway. Slots are processed in
 * canonical 00→04 order; the upserted / reattachRequired / heldForRetry lists
 * partition the five slots. The first hard (non-reattach, non-held) fault fails the
 * whole sync closed. Never throws.
 *
 * WHY A HELD SLOT IS STILL AN `ok` — the decision, and its cost.
 *
 * A held write is not a lost write: `syncSlot` only reports `held` AFTER `holdWrite`
 * durably enqueued it to the write outbox (an enqueue fault is an `err`, not a
 * hold), so the write is committed to a replay-safe drain. That is a genuine PARTIAL
 * SUCCESS — the other slots really did upsert — and it is a different disposition
 * from a hard fault. The existing consumer already depends on that difference:
 * `packages/workflows/src/workflows/notebookLmSync.ts` folds a non-empty
 * `heldForRetry` into the distinct `outbox_held` machine state plus its own
 * `write_through_failed` health item, while an `err` folds to `sync_failed`.
 * Collapsing hold into `err` would erase that state, discard the upserted /
 * reattach partition the same result carries, and turn a self-healing outage into a
 * terminal failure — the exact "retryable made permanent" regression this round
 * exists to avoid.
 *
 * The real defect was the OPPOSITE half: `ok` was readable as "the notebook is in
 * sync" when it was not. So the partial state is no longer something a caller must
 * remember to derive from an array length — `outcome` names it (`"synced"` ONLY when
 * all five slots upserted), and `heldDetail` names WHY each held slot was held. A caller
 * that reads nothing but `res.ok` is still wrong, which TypeScript cannot prevent on
 * a partial-success result; what it can no longer be is UNINFORMED.
 */
export function createNotebookLmSync(deps: NotebookSyncDeps): NotebookSyncDetailPort {
  return {
    async sync(
      mapping: NotebookMapping,
      bodies: ManagedDocBodies,
    ): Promise<Result<NotebookSyncDetail, NotebookError>> {
      const upserted: NotebookSlot[] = [];
      const reattachRequired: NotebookSlot[] = [];
      const heldForRetry: NotebookSlot[] = [];
      const heldDetail: NotebookHeldSlot[] = [];

      for (const slot of NOTEBOOK_SLOTS) {
        const outcome = await syncSlot(mapping, slot, bodies[slot], deps);
        if (outcome.kind === "error") {
          return err(outcome.error);
        }
        if (outcome.kind === "reattach") {
          reattachRequired.push(slot);
        } else if (outcome.kind === "held") {
          heldForRetry.push(slot);
          heldDetail.push(outcome.held);
        } else {
          upserted.push(slot);
        }
      }

      // `"synced"` ⟺ nothing needed reattach and nothing was held. Derived from the
      // two non-upserted lists rather than `upserted.length === NOTEBOOK_SLOTS
      // .length` so it stays correct if the slot set ever changes.
      const outcome = reattachRequired.length === 0 && heldForRetry.length === 0
        ? "synced"
        : "incomplete";

      return ok({ outcome, upserted, reattachRequired, heldForRetry, heldDetail });
    },
  };
}
