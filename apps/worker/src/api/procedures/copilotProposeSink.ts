// §8/§9.8 — Phase-C C5.3b: the concrete CopilotProposeSink (worker side).
//
// Records a Copilot proposal as a PENDING §9.8 Approval via a DIRECT ApprovalRepository write. It is NOT a
// Temporal activity and does NOT run the approval-flow workflow — the in-process Copilot has no workflow
// context and needs none: recording a pending card is two repository calls (get-then-create). It mirrors the
// stable-id derivation of `createRecordPendingActivity` (so an in-process record and any Temporal re-drive
// collide on ONE row) but ADDS the payloadHash-divergence reject the activity omits, and registry-validates
// the server-bound workspaceId.
//
// The THREE security contracts (from the C5.3 adversarial verification):
//   (a) WORKSPACE PROVENANCE (safety rule 4): `workspaceId` is the agent-job's SERVER-BOUND workspace (bound
//       by the runner, never model-derived). It is registry-validated (`workspaceConfig.get`; unknown ⇒
//       fail-closed, approvals untouched), folded into the derived id, AND stored on the card's own
//       `workspaceId` column (packages/db/src/schema/approvals.ts), which the per-workspace inbox reads.
//       ⛔ CORRECTED 2026-09-22: this used to say the Approval row "has NO workspace column", which the §9.8
//       workspace-scoping work made false, and which this file's own `pending` record contradicted.
//   (b) PAYLOAD-SWAP TOCTOU (safety rule 3): the idempotencyKey excludes payload. So on a same-id hit whose
//       `payloadHash` DIVERGES from the recorded card, REJECT — never overwrite (an owner who approved payload
//       A must never have A' execute). First-write-wins on an identical re-drive; the concurrent-create race
//       (PK conflict) re-reads and re-checks divergence.
//   (c) REDACTION + NO AUTO-APPLY: a DbError folds to a bounded UPPER_SNAKE cause code + static message (never
//       the driver's raw message/cause). The sink NEVER throws (typed Result), NEVER calls
//       applyTransition/dispatch (no auto-apply — the owner drives that via the §9.8 command path), and
//       DELIBERATELY skips the §8 receipt-store reserve (reservation belongs at dispatch-after-approval).
import { ok, err, isOk, failure } from "@sow/contracts";
import type {
  Approval,
  ExternalWriteEnvelope,
  FailureVariant,
  ProposedAction,
  Result,
  WorkspaceId,
} from "@sow/contracts";
import type { ApprovalRepository, DbError, OutboxRepository, WorkspaceConfigRepository } from "@sow/db";
import { holdWrite } from "@sow/integrations";
import { approvalIdFor } from "@sow/domain";
import type { CopilotProposeReceipt, CopilotProposeSink } from "./copilotPropose";

/** The SERVER-side actor recorded on a Copilot proposal card — never a model value. */
export const COPILOT_PROPOSE_ACTOR = "copilot-agent";

/** Default pending-card expiry (7 days) — an un-actioned proposal lapses rather than lingering forever. */
export const COPILOT_PROPOSE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Construction deps for the concrete sink. `now` is an injected ISO clock (testable + no ambient Date). */
export interface ApprovalsProposeSinkDeps {
  readonly approvals: ApprovalRepository;
  readonly workspaceConfig: WorkspaceConfigRepository;
  /**
   * Where the card's action + envelope are SAVED, so the owner's approval can later be dispatched
   * through the Tool Gateway (Linear slice 3+4). REQUIRED: a card saved without them has nothing to send.
   */
  readonly outbox: OutboxRepository;
  /** Returns the current time as an ISO-8601 string (for expiresAt). */
  readonly now: () => string;
  /** Pending-card expiry window; defaults to COPILOT_PROPOSE_EXPIRY_MS. */
  readonly expiryMs?: number;
  /** The recorded actor; defaults to COPILOT_PROPOSE_ACTOR (a server value). */
  readonly actor?: string;
}

/**
 * Fold a DbError into a bounded, redaction-safe FailureVariant (contract c). Mirrors approvalCommands.ts
 * `dbErrorToFailure` (incl. the `constraint_violation` case) with COPILOT_PROPOSE_* cause codes — only the
 * enum `code` is read; the driver's raw `message`/`cause` are DROPPED.
 */
function dbErrorToProposeFailure(e: DbError): FailureVariant {
  switch (e.code) {
    case "conflict":
      return failure("write_conflict", "copilot propose: approval record conflict", {
        cause: { code: "COPILOT_PROPOSE_RECORD_CONFLICT" },
      });
    case "not_found":
      return failure("validation_rejected", "copilot propose: approval not found", {
        cause: { code: "COPILOT_PROPOSE_RECORD_NOT_FOUND" },
      });
    case "constraint_violation":
      return failure("write_conflict", "copilot propose: approval record rejected", {
        cause: { code: "COPILOT_PROPOSE_RECORD_CONSTRAINT" },
      });
    case "serialization_failure":
      return failure("degraded_unavailable", "copilot propose: approval store retryable", {
        retryable: true,
        cause: { code: "COPILOT_PROPOSE_STORE_SERIALIZATION" },
      });
    case "unavailable":
      return failure("degraded_unavailable", "copilot propose: approval store unavailable", {
        retryable: true,
        cause: { code: "COPILOT_PROPOSE_STORE_UNAVAILABLE" },
      });
    case "unknown":
    default:
      return failure("degraded_unavailable", "copilot propose: approval store error", {
        cause: { code: "COPILOT_PROPOSE_STORE_UNKNOWN" },
      });
  }
}

/** The payloadHash-divergence check on a same-id hit (contract b). Equal ⇒ no-op; diverge ⇒ REJECT. */
function reconcileExisting(
  existing: Approval,
  envelope: ExternalWriteEnvelope,
): Result<CopilotProposeReceipt, FailureVariant> {
  if (existing.payloadHash === envelope.payloadHash) {
    return ok({ approvalRef: String(existing.id), created: false }); // first-write-wins, idempotent no-op
  }
  return err(
    failure("write_conflict", "copilot propose: a different proposal is already pending for this object", {
      cause: { code: "COPILOT_PROPOSE_PAYLOAD_CONFLICT" },
    }),
  );
}

/**
 * The concrete CopilotProposeSink over the §9.8 ApprovalRepository. Records a pending card, honoring the three
 * contracts above. Pure apart from the injected repositories + clock; never throws (typed Result throughout).
 */
export function createApprovalsProposeSink(deps: ApprovalsProposeSinkDeps): CopilotProposeSink {
  const expiryMs = deps.expiryMs ?? COPILOT_PROPOSE_EXPIRY_MS;
  const actor = deps.actor ?? COPILOT_PROPOSE_ACTOR;
  return {
    record: async ({ action, envelope, workspaceId }): Promise<Result<CopilotProposeReceipt, FailureVariant>> => {
      // (a) Registry-validate the SERVER-BOUND workspace BEFORE any approvals I/O — unknown ⇒ fail closed.
      const ws = await deps.workspaceConfig.get(workspaceId as WorkspaceId);
      if (!isOk(ws)) {
        return err(
          failure("validation_rejected", "copilot propose: unknown workspace", {
            cause: { code: "COPILOT_PROPOSE_UNKNOWN_WORKSPACE" },
          }),
        );
      }
      // The ONE approval-id minter (`approvalIdFor`) — shared with createRecordPendingActivity and the gateway's
      // own lookup, so an in-process record, a Temporal re-drive and the gateway all resolve ONE row (rule 3).
      // Workspace folded in (no cross-ws bleed).
      const id = approvalIdFor({ idempotencyKey: envelope.idempotencyKey, workspace: String(workspaceId) });
      // (b) get-then-create: a hit is first-write-wins / divergence-reject.
      const existing = await deps.approvals.get(id);
      if (isOk(existing)) return reconcileExisting(existing.value, envelope);

      // (c) SAVE the action + envelope BEFORE the card (Linear slice 3+4, rule 3). The dispatch that follows the
      // owner's approval rebuilds the write from this entry, so a card must never exist without it: a save
      // failure returns BEFORE `approvals.create`. `not_approved` ⇒ status `proposed` — awaiting approval,
      // never dispatched from here. The entry carries the CARD's workspace (rule 4). `holdWrite` reuses an
      // entry already saved under this idempotencyKey, so a re-drive never saves a second one. The id is
      // derived from the replay key: deterministic, no clock or RNG.
      const saved = await holdWrite(
        { env: envelope, action, reason: "not_approved", workspaceId: String(workspaceId) },
        deps.outbox,
        { clock: deps.now, outboxId: () => `ob_${envelope.idempotencyKey}` },
      );
      if (!isOk(saved)) {
        return err(
          failure("degraded_unavailable", "copilot propose: could not save the action to send", {
            cause: { code: "COPILOT_PROPOSE_OUTBOX_UNAVAILABLE" },
          }),
        );
      }

      const pending: Approval = {
        id,
        actionRef: action.actionId,
        // §13.10a — the Copilot EXTERNAL-write propose sink records an external_action subject (a §8
        // ProposedAction, referenced by actionRef). The SEMANTIC-write sibling (a KMP → planRef,
        // subjectKind: "semantic_mutation") is the separate §13.10a KMP-propose sink (Slice E).
        subjectKind: "external_action",
        // WS-4 inbox-scope: store the SAME raw `workspaceId` used to DERIVE `id` (above) and QUERIED by
        // readModel.pendingApprovals — NOT the registry-resolved `ws.value.id`. If workspaceConfig.get ever
        // canonicalizes (slug→id/alias), storing the resolved id would make the write-key diverge from the
        // read-key and fail-closed EXCLUDE the card from its own inbox. Write-key === read-key by construction.
        workspaceId,
        status: "pending",
        actor,
        channel: "mac",
        payloadHash: envelope.payloadHash,
        expiresAt: new Date(Date.parse(deps.now()) + expiryMs).toISOString(),
      };
      const created = await deps.approvals.create(pending);
      if (isOk(created)) return ok({ approvalRef: String(id), created: true });
      // A create conflict = a concurrent first-writer race → re-read + re-check divergence (the racer may have
      // written a divergent payload). A re-read miss / any other DbError folds to a bounded failure.
      if (created.error.code === "conflict") {
        const reRead = await deps.approvals.get(id);
        if (isOk(reRead)) return reconcileExisting(reRead.value, envelope);
      }
      return err(dbErrorToProposeFailure(created.error));
    },
  };
}
