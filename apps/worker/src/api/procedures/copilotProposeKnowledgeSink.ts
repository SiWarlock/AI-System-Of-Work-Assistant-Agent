// §13.10a — Slice E: the concrete KMP-propose sink → §9.8 Approvals (worker side).
//
// The SEMANTIC-write sibling of `createApprovalsProposeSink` (copilotProposeSink.ts, which records an
// EXTERNAL-write ProposedAction). Records a derived, validated `KnowledgeMutationPlan` as TWO durable rows:
//   (1) a PENDING row in the pending-KMP store (Slice D) — the immutable plan the executor commits, and
//   (2) a PENDING §9.8 Approval carrying `subjectKind: "semantic_mutation"` + `planRef` → the stored plan.
// On owner approval the executor (Slice F) re-fetches the plan by `planRef`, re-validates it through
// `KnowledgeMutationPlanSchema`, and commits it via KnowledgeWriter (safety rules 1+2 — the sole autonomous
// Markdown writer; NEVER a direct/auto write here).
//
// THE SECURITY CONTRACTS (mirroring the external sink + the Slice-C/D security forward-guidance):
//   (a) WORKSPACE PROVENANCE (safety rule 4 / FG-1): `workspaceId` is the agent-job's SERVER-BOUND workspace
//       (bound by the runner, never model-derived). It is registry-validated (`workspaceConfig.get`; unknown ⇒
//       fail-closed, NEITHER store touched) AND cross-checked against the KMP's OWN `plan.workspaceId` — a plan
//       derived for workspace X must never be recorded under workspace Y. It is folded into the derived
//       Approval id so two workspaces never share a card.
//   (b) PAYLOAD-SWAP TOCTOU (safety rule 3): `payloadHash` is the canonical, replay-stable hash over the KMP
//       (the SAME `payloadHash` written to BOTH rows — the executor re-hashes the fetched plan and compares
//       against the FROZEN `Approval.payloadHash`). The pending-KMP store is first-write-wins (planId PK); a
//       same-planId hit whose hash DIVERGES is REJECTED — never overwrite an approvable plan. The KMP store is
//       the PRIMARY gate (a divergent re-propose is rejected there BEFORE the Approval is touched); the
//       Approval reconcile is defense-in-depth for the create race.
//       ORDERING: the KMP store is recorded FIRST, so no Approval ever references a MISSING plan (a dangling
//       card the owner could see but the executor could not commit). An Approval-create failure AFTER a
//       successful store-record leaves an ORPHAN plan row (harmless — no card references it, so it is never
//       served or committed). The pending-KMP store has NO TTL (unlike the Approval's expiresAt), so an orphan
//       is not time-reaped; it resolves when a retry hits the identical-hash fall-through that heals the
//       missing card. (A background sweep of card-less pending-KMP rows is a possible future cleanup.)
//   (c) REDACTION + NO AUTO-APPLY: a DbError folds to a bounded UPPER_SNAKE cause code + static message (never
//       the driver's raw message/cause). The sink NEVER throws (typed Result) and NEVER calls
//       applyTransition / applyPlan / KnowledgeWriter — the owner drives commit via §9.8 → Slice F.
import { ok, err, isOk, failure, approvalId as makeApprovalId } from "@sow/contracts";
import type {
  Approval,
  FailureVariant,
  KnowledgeMutationPlan,
  Result,
  WorkspaceId,
} from "@sow/contracts";
import type {
  ApprovalRepository,
  DbError,
  PendingKnowledgeMutation,
  PendingKnowledgeMutationRepository,
  WorkspaceConfigRepository,
} from "@sow/db";
import { buildIdempotencyKey } from "@sow/domain";
import { payloadHash } from "@sow/integrations";
import { COPILOT_PROPOSE_ACTOR, COPILOT_PROPOSE_EXPIRY_MS } from "./copilotProposeSink";

/** The SERVER-side actor recorded on a Copilot semantic proposal — never a model value (shared value). */
export const COPILOT_PROPOSE_KNOWLEDGE_ACTOR = COPILOT_PROPOSE_ACTOR;

/** Pending-card expiry (7d) — an un-actioned proposal lapses rather than lingering forever (shared value). */
export const COPILOT_PROPOSE_KNOWLEDGE_EXPIRY_MS = COPILOT_PROPOSE_EXPIRY_MS;

/** Proof a semantic proposal was recorded. `created:false` ⇒ an idempotent re-drive (no 2nd card/row). */
export interface CopilotKnowledgeProposeReceipt {
  readonly approvalRef: string;
  readonly planRef: string;
  readonly created: boolean;
}

/**
 * The seam that records a derived KMP as a pending §9.8 semantic-mutation card + its stored plan, idempotent
 * by the plan's `planId`. A fake in tests; the concrete impl is `createApprovalsKnowledgeProposeSink`.
 */
export interface CopilotKnowledgeProposeSink {
  record(input: {
    readonly plan: KnowledgeMutationPlan;
    readonly workspaceId: WorkspaceId;
  }): Promise<Result<CopilotKnowledgeProposeReceipt, FailureVariant>>;
}

/** Construction deps. `now` is an injected ISO clock (testable + no ambient Date). */
export interface ApprovalsKnowledgeProposeSinkDeps {
  readonly approvals: ApprovalRepository;
  readonly pendingKmp: PendingKnowledgeMutationRepository;
  readonly workspaceConfig: WorkspaceConfigRepository;
  readonly now: () => string;
  readonly expiryMs?: number;
  readonly actor?: string;
}

/**
 * Fold a DbError into a bounded, redaction-safe FailureVariant (contract c). Only the enum `code` is read;
 * the driver's raw `message`/`cause` are DROPPED. Cause codes are KNOWLEDGE-prefixed so a semantic-store
 * failure is distinguishable from the external sink's.
 */
function dbErrorToFailure(e: DbError): FailureVariant {
  switch (e.code) {
    case "conflict":
      return failure("write_conflict", "copilot knowledge propose: store conflict", {
        cause: { code: "COPILOT_PROPOSE_KNOWLEDGE_STORE_CONFLICT" },
      });
    case "not_found":
      return failure("validation_rejected", "copilot knowledge propose: store row not found", {
        cause: { code: "COPILOT_PROPOSE_KNOWLEDGE_STORE_NOT_FOUND" },
      });
    case "constraint_violation":
      return failure("write_conflict", "copilot knowledge propose: store rejected", {
        cause: { code: "COPILOT_PROPOSE_KNOWLEDGE_STORE_CONSTRAINT" },
      });
    case "serialization_failure":
      return failure("degraded_unavailable", "copilot knowledge propose: store retryable", {
        retryable: true,
        cause: { code: "COPILOT_PROPOSE_KNOWLEDGE_STORE_SERIALIZATION" },
      });
    case "unavailable":
      return failure("degraded_unavailable", "copilot knowledge propose: store unavailable", {
        retryable: true,
        cause: { code: "COPILOT_PROPOSE_KNOWLEDGE_STORE_UNAVAILABLE" },
      });
    case "unknown":
    default:
      return failure("degraded_unavailable", "copilot knowledge propose: store error", {
        cause: { code: "COPILOT_PROPOSE_KNOWLEDGE_STORE_UNKNOWN" },
      });
  }
}

/** The payloadHash-divergence check on a same-planId Approval hit (contract b). Equal ⇒ no-op; diverge ⇒ REJECT. */
function reconcileApproval(
  existing: Approval,
  hash: string,
  planRef: string,
): Result<CopilotKnowledgeProposeReceipt, FailureVariant> {
  if (existing.payloadHash === hash) {
    return ok({ approvalRef: String(existing.id), planRef, created: false }); // first-write-wins, idempotent no-op
  }
  return err(
    failure("write_conflict", "copilot knowledge propose: a different plan is already pending for this note", {
      cause: { code: "COPILOT_PROPOSE_KNOWLEDGE_PLAN_CONFLICT" },
    }),
  );
}

/**
 * The concrete `CopilotKnowledgeProposeSink` over the pending-KMP store + the §9.8 ApprovalRepository. Records
 * a pending card + its stored plan, honoring the three contracts above. Pure apart from the injected
 * repositories + clock; never throws (typed Result throughout).
 */
export function createApprovalsKnowledgeProposeSink(
  deps: ApprovalsKnowledgeProposeSinkDeps,
): CopilotKnowledgeProposeSink {
  const expiryMs = deps.expiryMs ?? COPILOT_PROPOSE_KNOWLEDGE_EXPIRY_MS;
  const actor = deps.actor ?? COPILOT_PROPOSE_KNOWLEDGE_ACTOR;
  return {
    record: async ({ plan, workspaceId }): Promise<Result<CopilotKnowledgeProposeReceipt, FailureVariant>> => {
      // (a) Registry-validate the SERVER-BOUND workspace BEFORE any store I/O — unknown ⇒ fail closed.
      const ws = await deps.workspaceConfig.get(workspaceId);
      if (!isOk(ws)) {
        return err(
          failure("validation_rejected", "copilot knowledge propose: unknown workspace", {
            cause: { code: "COPILOT_PROPOSE_KNOWLEDGE_UNKNOWN_WORKSPACE" },
          }),
        );
      }
      // (a / FG-1) The KMP must BELONG to the server-bound workspace. The plan's workspaceId is derived
      // server-side (Slice B) from the same bound workspace; a mismatch means a plan for another workspace is
      // being recorded here — reject before ANY store write (a cross-workspace planId must not drive a commit
      // into the wrong workspace, WS-8).
      if (String(plan.workspaceId) !== String(workspaceId)) {
        return err(
          failure("validation_rejected", "copilot knowledge propose: plan/workspace mismatch", {
            cause: { code: "COPILOT_PROPOSE_KNOWLEDGE_WORKSPACE_MISMATCH" },
          }),
        );
      }

      const planId = String(plan.planId);
      // (b) The canonical, replay-stable hash over the KMP — the SAME value on BOTH rows (the executor's
      // FROZEN-Approval-payloadHash comparison, Slice F, hinges on this).
      const hash = payloadHash(plan as unknown as Record<string, unknown>);

      // (b) Record the pending-KMP store FIRST (ordering: no dangling Approval). First-write-wins on planId;
      // a same-planId hit whose hash DIVERGES is rejected here, before the Approval is touched.
      const entry: PendingKnowledgeMutation = {
        planId,
        workspaceId: String(workspaceId),
        plan,
        payloadHash: hash,
        status: "pending",
        recordedAt: deps.now(),
      };
      const stored = await deps.pendingKmp.record(entry);
      if (!isOk(stored)) {
        if (stored.error.code !== "conflict") return err(dbErrorToFailure(stored.error));
        // Conflict ⇒ a row already exists for this planId. Re-read + divergence-check: identical ⇒ idempotent
        // (heal a prior partial run that recorded the plan but not the card); divergent ⇒ REJECT.
        const existingKmp = await deps.pendingKmp.get(planId);
        if (!isOk(existingKmp)) return err(dbErrorToFailure(existingKmp.error));
        if (existingKmp.value.payloadHash !== hash) {
          return err(
            failure("write_conflict", "copilot knowledge propose: a different plan is already pending for this note", {
              cause: { code: "COPILOT_PROPOSE_KNOWLEDGE_PLAN_CONFLICT" },
            }),
          );
        }
      }

      // Derive the stable Approval id from the planId (workspace-folded — no cross-workspace bleed; an
      // in-process record and any re-drive collide on ONE card). A DISTINCT operation namespace from the
      // external sink's "approval.pending" so a semantic card's id can never collide with an external one's.
      const id = makeApprovalId(
        buildIdempotencyKey({
          operation: "approval.pending.knowledge",
          identity: { planRef: planId, workspace: String(workspaceId) },
        }),
      );
      // (b) get-then-create: a hit is first-write-wins / divergence-reject.
      const existing = await deps.approvals.get(id);
      if (isOk(existing)) return reconcileApproval(existing.value, hash, planId);

      const pending: Approval = {
        id,
        // §13.10a — a SEMANTIC-mutation card: planRef → the stored KMP; NO actionRef (the refine forbids it).
        planRef: plan.planId,
        subjectKind: "semantic_mutation",
        // WS-4 inbox-scope: store the SAME raw workspaceId used to DERIVE the id (write-key === read-key).
        workspaceId,
        status: "pending",
        actor,
        channel: "mac",
        payloadHash: hash,
        expiresAt: new Date(Date.parse(deps.now()) + expiryMs).toISOString(),
      };
      const created = await deps.approvals.create(pending);
      if (isOk(created)) return ok({ approvalRef: String(id), planRef: planId, created: true });
      // A create conflict = a concurrent first-writer race → re-read + re-check divergence.
      if (created.error.code === "conflict") {
        const reRead = await deps.approvals.get(id);
        if (isOk(reRead)) return reconcileApproval(reRead.value, hash, planId);
      }
      return err(dbErrorToFailure(created.error));
    },
  };
}
