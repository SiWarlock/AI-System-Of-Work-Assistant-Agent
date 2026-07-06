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
//       fail-closed, approvals untouched) and folded into the derived id — the Approval row has NO workspace
//       column, so the id fold is the sole write-attribution (a per-workspace inbox READ scope is a separate
//       §9.8 go-live blocker, tracked for C5.4).
//   (b) PAYLOAD-SWAP TOCTOU (safety rule 3): the idempotencyKey excludes payload. So on a same-id hit whose
//       `payloadHash` DIVERGES from the recorded card, REJECT — never overwrite (an owner who approved payload
//       A must never have A' execute). First-write-wins on an identical re-drive; the concurrent-create race
//       (PK conflict) re-reads and re-checks divergence.
//   (c) REDACTION + NO AUTO-APPLY: a DbError folds to a bounded UPPER_SNAKE cause code + static message (never
//       the driver's raw message/cause). The sink NEVER throws (typed Result), NEVER calls
//       applyTransition/dispatch (no auto-apply — the owner drives that via the §9.8 command path), and
//       DELIBERATELY skips the §8 receipt-store reserve (reservation belongs at dispatch-after-approval).
import { ok, err, isOk, failure, approvalId as makeApprovalId } from "@sow/contracts";
import type {
  Approval,
  ExternalWriteEnvelope,
  FailureVariant,
  ProposedAction,
  Result,
  WorkspaceId,
} from "@sow/contracts";
import type { ApprovalRepository, DbError, WorkspaceConfigRepository } from "@sow/db";
import { buildIdempotencyKey } from "@sow/domain";
import type { CopilotProposeReceipt, CopilotProposeSink } from "./copilotPropose";

/** The SERVER-side actor recorded on a Copilot proposal card — never a model value. */
export const COPILOT_PROPOSE_ACTOR = "copilot-agent";

/** Default pending-card expiry (7 days) — an un-actioned proposal lapses rather than lingering forever. */
export const COPILOT_PROPOSE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Construction deps for the concrete sink. `now` is an injected ISO clock (testable + no ambient Date). */
export interface ApprovalsProposeSinkDeps {
  readonly approvals: ApprovalRepository;
  readonly workspaceConfig: WorkspaceConfigRepository;
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
      // Derive the stable id EXACTLY as createRecordPendingActivity — workspace folded in (no cross-ws bleed);
      // an in-process record and any Temporal re-drive collide on ONE row.
      const id = makeApprovalId(
        buildIdempotencyKey({
          operation: "approval.pending",
          identity: { idempotencyKey: envelope.idempotencyKey, workspace: String(workspaceId) },
        }),
      );
      // (b) get-then-create: a hit is first-write-wins / divergence-reject.
      const existing = await deps.approvals.get(id);
      if (isOk(existing)) return reconcileExisting(existing.value, envelope);

      const pending: Approval = {
        id,
        actionRef: action.actionId,
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
