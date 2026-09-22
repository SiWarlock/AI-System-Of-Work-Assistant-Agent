// @sow/worker — the Approvals-screen dispatch for an EXTERNAL action. Linear slice 3+4, step 3.
//
// When the owner approves an `external_action` card, this SENDS the write. It finds the action + envelope the
// proposer saved with the card (`approvalOutboxId`, step 2), checks that they still match the approval, and
// dispatches them through the Tool Gateway — the only external-write path (rule 3) — scoped to the APPROVAL's
// own workspace (rule 4). The outcome is folded onto the saved entry with the drain's own `applyOutcome`, so a
// HELD write is kept for the wake drain to retry instead of being lost.
//
// ⛔ EVERY REFUSAL SENDS NOTHING. The guards run before the gateway and each one is a reason the write must not
// go out: not approved, not an external action, no onboarded workspace, nothing saved, a saved entry for a
// different workspace (rule 4), or a saved payload that is not the approved one (rule 3 — a swapped payload
// never executes).
//
// ⛔ OWNER DECISION (2026-09-22): WRITES OFF ⇒ REFUSE, NEVER FAKE. With no real sender selected, the write
// adapters sit over the in-memory stub, which fabricates success receipts. So when the card's OWN system has no
// real sender (`armedTargets`) this refuses as `writes_off` BEFORE the gateway: no receipt, and the saved entry
// stays `proposed`. It can be sent later by re-running this dispatch once that system is armed (the Approvals
// screen's "Send now", step 4); nothing else re-drives it on a desktop install, where the wake drain does not run.
//
// ⭐ THE GATEWAY'S APPROVAL HOOKS ARE FIXED HERE, NOT RE-DERIVED. This runs only for a card the owner has
// already approved, and only after the saved entry is proven to be that card's (same id, workspace and
// payload). So `requireApproval` is always true (the stricter verdict; never the auto-allow branch), and
// `isApproved` compares the envelope to THIS entry. `recordPendingApproval` refuses: a dispatch never creates a
// card, so it can never create a duplicate one.
import {
  ok,
  err,
  auditId,
  type Approval,
  type AuditRecord,
  type FailureVariant,
  type Result,
  type TargetSystem,
} from "@sow/contracts";
import { approvalIdFor, approvalOutboxId } from "@sow/domain";
import type { OutboxRepository, WorkspaceConfigRepository } from "@sow/db";
import { UNASSIGNED_WORKSPACE } from "@sow/db/schema/approvals";
import {
  applyOutcome,
  createUnroutedWriteAdapter,
  dispatchRouted,
  rebuildAction,
  rebuildEnvelope,
  type BackoffConfig,
  type ExternalWriteDeps,
  type ExternalWriteResult,
  type ReceiptStore,
  type WriteAdapterRegistry,
  type WriteSecretsAccessor,
} from "@sow/integrations";
import type { DispatchApprovalFn } from "../api/procedures/approvalCommands";
import { DEFAULT_DRAIN_BACKOFF } from "./outboxDrainBind";
import type { HealthFailure } from "../health/surface";

/** Why a write was refused before the gateway. Closed and content-free (rule 7). */
export type ExternalApprovalRefusal =
  | "writes_off"
  | "unassigned_workspace"
  | "unknown_workspace"
  | "no_saved_action"
  | "workspace_mismatch"
  | "payload_mismatch";

export type ExternalApprovalOutcome =
  | { readonly kind: "skipped"; readonly reason: "not_external" | "not_approved" }
  /** A rejected or expired card's saved entry was closed, so nothing can re-drive it. */
  | { readonly kind: "closed" }
  | { readonly kind: "refused"; readonly reason: ExternalApprovalRefusal }
  | { readonly kind: "already_done" }
  | { readonly kind: "dispatched"; readonly status: ExternalWriteResult["status"] };

/** A dispatch that did not end in a written receipt, reported for System Health. Content-free. */
export interface ExternalApprovalFailure {
  readonly kind: "held" | "rejected" | "conflict" | "integrity";
  readonly approvalId: string;
  readonly reason?: ExternalApprovalRefusal;
}

export interface ExternalApprovalDispatchDeps {
  /**
   * The systems with a REAL sender (`backends.armedTargets`). A card for a system NOT in it is refused as
   * `writes_off` and its saved entry is left untouched, so it can still be sent once that system is armed —
   * never stubbed, and never closed as rejected by a router that does not serve it.
   */
  readonly armedTargets: ReadonlySet<TargetSystem>;
  readonly outbox: OutboxRepository;
  readonly workspaceConfig: WorkspaceConfigRepository;
  readonly receiptStore: ReceiptStore;
  readonly writeAdapters: WriteAdapterRegistry;
  readonly audit: (rec: AuditRecord) => Promise<void>;
  readonly clock: () => string;
  /** The gateway's credential pre-check. Optional: the Linear sender also resolves its key per request. */
  readonly secrets?: WriteSecretsAccessor;
  readonly backoffCfg?: BackoffConfig;
  /** Reports a held, rejected, conflicting or mismatched write (boot binds System Health). Must not throw. */
  readonly onFailure?: (f: ExternalApprovalFailure) => Promise<void>;
}

const TERMINAL = new Set(["receipt_recorded", "rejected", "expired"]);

/**
 * Send the write an approved `external_action` card stands for, or refuse without writing. TOTAL: never throws.
 * The repositories return typed Results; an unexpected throw anywhere (a repository, the gateway, the outcome
 * fold) is caught and reported as a rejected dispatch. ⚠ If that throw came AFTER the vendor accepted the write,
 * "rejected" understates it — the receipt store still holds the truth, and a re-dispatch reuses it (rule 3).
 */
export async function dispatchExternalApproval(
  approval: Approval,
  deps: ExternalApprovalDispatchDeps,
): Promise<ExternalApprovalOutcome> {
  let outcome: ExternalApprovalOutcome;
  try {
    outcome = await decideAndSend(approval, deps);
  } catch {
    outcome = { kind: "dispatched", status: "rejected" };
  }
  const failure = failureOf(outcome, String(approval.id));
  if (failure !== undefined && deps.onFailure !== undefined) {
    try {
      await deps.onFailure(failure);
    } catch {
      /* reporting must never fail the dispatch */
    }
  }
  return outcome;
}

async function decideAndSend(approval: Approval, deps: ExternalApprovalDispatchDeps): Promise<ExternalApprovalOutcome> {
  if (approval.subjectKind === "semantic_mutation") return { kind: "skipped", reason: "not_external" };
  if (approval.status === "rejected" || approval.status === "expired") return closeSavedEntry(approval, deps);
  if (approval.status !== "approved") return { kind: "skipped", reason: "not_approved" };

  const ws = String(approval.workspaceId);
  if (ws === UNASSIGNED_WORKSPACE) return { kind: "refused", reason: "unassigned_workspace" };
  const onboarded = await deps.workspaceConfig.get(approval.workspaceId);
  if (!onboarded.ok) return { kind: "refused", reason: "unknown_workspace" };

  const saved = await deps.outbox.get(approvalOutboxId(approval.id));
  if (!saved.ok) return { kind: "refused", reason: "no_saved_action" };
  const entry = saved.value;
  if (entry.workspaceId !== ws) return { kind: "refused", reason: "workspace_mismatch" };
  // The saved entry must be THIS card's: its replay key + workspace derive this card's id.
  if (String(approvalIdFor({ idempotencyKey: entry.idempotencyKey, workspace: entry.workspaceId })) !== String(approval.id)) {
    return { kind: "refused", reason: "no_saved_action" };
  }
  if (entry.payloadHash !== approval.payloadHash) return { kind: "refused", reason: "payload_mismatch" };
  if (TERMINAL.has(entry.status)) return { kind: "already_done" };

  if (!deps.armedTargets.has(entry.targetSystem as TargetSystem)) return { kind: "refused", reason: "writes_off" };

  const env = rebuildEnvelope(entry);
  const action = rebuildAction(entry);
  const gatewayDeps: ExternalWriteDeps = {
    adapter: createUnroutedWriteAdapter(), // dispatchRouted replaces it with the target's adapter
    receiptStore: deps.receiptStore,
    requireApproval: () => ({ requiresApproval: true }),
    isApproved: async (e) => e.idempotencyKey === entry.idempotencyKey,
    recordPendingApproval: async () => err({ code: "refused", message: "a dispatch never records a card" }),
    audit: deps.audit,
    clock: deps.clock,
    ...(deps.secrets !== undefined ? { secrets: deps.secrets } : {}),
  };
  const result: ExternalWriteResult = await dispatchRouted(deps.writeAdapters, env, action, gatewayDeps, undefined, {
    workspaceId: ws,
    intentCreatedAt: entry.enqueuedAt,
  });
  await applyOutcome(deps.outbox, entry, result, {
    now: deps.clock(),
    clock: deps.clock,
    backoffCfg: deps.backoffCfg ?? DEFAULT_DRAIN_BACKOFF,
  });
  return { kind: "dispatched", status: result.status };
}

/**
 * A rejected or expired card will never be sent, so close its saved entry. Otherwise the entry stays
 * `proposed` — "due" to the wake drain — and an armed drain would re-drive it forever (review 2026-09-22).
 * Touches only an entry that is provably this card's; anything else is left alone.
 */
async function closeSavedEntry(approval: Approval, deps: ExternalApprovalDispatchDeps): Promise<ExternalApprovalOutcome> {
  const saved = await deps.outbox.get(approvalOutboxId(approval.id));
  if (!saved.ok) return { kind: "skipped", reason: "not_approved" };
  const entry = saved.value;
  const ours =
    entry.workspaceId === String(approval.workspaceId) &&
    String(approvalIdFor({ idempotencyKey: entry.idempotencyKey, workspace: entry.workspaceId })) === String(approval.id);
  if (!ours) return { kind: "skipped", reason: "not_approved" };
  if (!TERMINAL.has(entry.status)) {
    await deps.outbox.update({ ...entry, status: "rejected", updatedAt: deps.clock() });
  }
  return { kind: "closed" };
}

function failureOf(outcome: ExternalApprovalOutcome, approvalId: string): ExternalApprovalFailure | undefined {
  if (outcome.kind === "dispatched") {
    if (outcome.status === "held" || outcome.status === "approval_pending") return { kind: "held", approvalId };
    if (outcome.status === "rejected" || outcome.status === "superseded") return { kind: "rejected", approvalId };
    if (outcome.status === "conflict") return { kind: "conflict", approvalId };
    return undefined;
  }
  if (outcome.kind === "refused" && (outcome.reason === "workspace_mismatch" || outcome.reason === "payload_mismatch")) {
    return { kind: "integrity", approvalId, reason: outcome.reason };
  }
  return undefined;
}

/**
 * The `DispatchApprovalFn` the Approvals screen's decide command calls. Always `ok`: by the time it runs, the
 * owner's decision has already been recorded, so an `err` would make the screen say "Couldn't decide — try
 * again" about a decision that DID land, and that retry cannot re-dispatch. What happened to the write is on
 * the saved entry (and in System Health via `onFailure`).
 */
export function createExternalApprovalDispatch(deps: ExternalApprovalDispatchDeps): DispatchApprovalFn {
  return async (approval: Approval): Promise<Result<void, FailureVariant>> => {
    await dispatchExternalApproval(approval, deps); // total: never throws
    return ok(undefined);
  };
}

/**
 * What boot binds for `external_action` approvals: the caller's explicit override when one is supplied (tests,
 * or a host that needs a different sender), otherwise the REAL guarded dispatcher. The real one is built only
 * when it is used. Before Linear slice 3+4 the desktop host supplied a no-op here, so approving an external
 * action sent nothing in every configuration.
 */
export function resolveExternalApprovalDispatch(
  override: DispatchApprovalFn | undefined,
  buildReal: () => DispatchApprovalFn,
): DispatchApprovalFn {
  return override ?? buildReal();
}

/** A reported dispatch failure as a System Health item: a closed class, keyed by the approval, no content. */
export function externalApprovalFailureToHealth(f: ExternalApprovalFailure, now: string): HealthFailure {
  const message =
    f.kind === "held"
      ? "approved external write held; it will be retried"
      : f.kind === "rejected"
        ? "approved external write was rejected"
        : f.kind === "conflict"
          ? "approved external write hit a conflict"
          : `approved external write refused: ${f.reason ?? "integrity"}`;
  return {
    failureClass: f.kind === "held" || f.kind === "rejected" ? "write_through_failed" : "conflict_review",
    subjectRef: f.approvalId,
    message,
    auditRef: auditId(`approval-dispatch:${f.approvalId}`),
    now,
  };
}
