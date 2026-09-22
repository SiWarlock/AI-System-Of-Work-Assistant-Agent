// @sow/worker — the Approvals-screen dispatch for an EXTERNAL action. Linear slice 3+4, step 3.
//
// When the owner approves an `external_action` card, this SENDS the write. It finds the action + envelope the
// proposer saved with the card (`approvalOutboxId`, step 2), checks that they still match the approval, and
// dispatches them through the Tool Gateway — the only external-write path (rule 3) — scoped to the APPROVAL's
// own workspace (rule 4). The outcome is folded onto the saved entry with the drain's own `applyOutcome`, so a
// HELD write is kept (`retry_queued`) instead of being lost. ⚠ Kept is not retried automatically everywhere: the
// wake drain that re-drives it runs only where the proof spine does (auto-ingest on); on a desktop install it waits
// for the owner's "Send now" (`approvalSend.sendNow`).
//
// ⛔ EVERY REFUSAL SENDS NOTHING. The guards run before the gateway and each one is a reason the write must not
// go out: not approved, not an external action, no onboarded workspace, nothing saved, a saved entry for a
// different workspace (rule 4), or a saved payload that is not the approved one (rule 3 — a swapped payload
// never executes).
//
// ⛔ OWNER DECISION (2026-09-22): WRITES OFF ⇒ REFUSE, NEVER FAKE. With no real sender selected, the write
// adapters sit over the in-memory stub, which fabricates success receipts. So when the card's OWN system, in the
// card's OWN workspace, has no real sender (`armedFor`) this refuses as `writes_off` BEFORE the gateway: no receipt,
// and the saved entry
// stays `proposed`, so a LATER dispatch can still send it once that system is armed. The decide command dispatches
// only on a real transition, so an already-approved card is re-dispatched by "Send now" (`approvalSend.sendNow`,
// step 4d), which uses this same single-flight sender — or, where the proof spine runs, by the wake drain.
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
import type { ApprovalSendRefusal, ApprovalSendState } from "@sow/contracts/api/ui-safe";
import { approvalIdFor, approvalOutboxId } from "@sow/domain";
import type { OutboxEntry, OutboxRepository, WorkspaceConfigRepository } from "@sow/db";
import { UNASSIGNED_WORKSPACE } from "@sow/db/schema/approvals";
import {
  applyOutcome,
  createUnroutedWriteAdapter,
  payloadHash,
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
  | ApprovalSendRefusal // the integrity reasons the screen can show
  | "writes_off"
  | "no_saved_action"
  | "store_unavailable" // the saved action could not be read — NOT the same as "nothing saved"
  | "unknown_status"; // a saved-action status this version does not recognise

export type ExternalApprovalOutcome =
  | { readonly kind: "skipped"; readonly reason: "not_external" | "not_approved" }
  /** A rejected or edited card's saved entry was closed, so nothing can re-drive it. */
  | { readonly kind: "closed" }
  | { readonly kind: "refused"; readonly reason: ExternalApprovalRefusal }
  | { readonly kind: "already_done" }
  | { readonly kind: "dispatched"; readonly status: ExternalWriteResult["status"] };

/**
 * An APPROVED card whose write did not end in a receipt, reported for System Health. Content-free. `not_sent`
 * is the owner decision's "and say so" (2026-09-22): writes off, nothing saved, or no onboarded workspace — the
 * owner approved it and it will not go out until something changes.
 */
export interface ExternalApprovalFailure {
  readonly kind: "held" | "rejected" | "conflict" | "integrity" | "not_sent";
  readonly approvalId: string;
  readonly reason?: ExternalApprovalRefusal;
}

export interface ExternalApprovalDispatchDeps {
  /**
   * Does the card's system, in the card's workspace, have a REAL sender that can authenticate
   * (`backends.armedFor`)? `false` ⇒ refused as `writes_off`, saved entry untouched — never stubbed, and never
   * closed as rejected by a router that does not serve the system or a key lookup that has no key there.
   */
  readonly armedFor: (targetSystem: TargetSystem, workspaceId: string) => boolean;
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
  /**
   * Called once an approval's write has gone out (a receipt was recorded or reused). Boot binds it to RESOLVE the
   * approval's earlier "not sent" / "held" System Health item — otherwise Health keeps showing an open failure for
   * a write that was sent (review 2026-09-22). Must not throw.
   */
  readonly onSent?: (approvalId: string) => Promise<void>;
}

const TERMINAL = new Set(["receipt_recorded", "rejected", "expired"]);

/** What `checkSavedAction` found: the card's own saved action, an integrity refusal, nothing, or a store fault. */
export type SavedActionCheck =
  | { readonly kind: "verified"; readonly entry: OutboxEntry }
  | { readonly kind: "refused"; readonly reason: ApprovalSendRefusal }
  | { readonly kind: "no_saved_action" }
  | { readonly kind: "store_fault" };

/**
 * Find the action + envelope saved with THIS card and prove it is this card's: same workspace (rule 4), its replay
 * key + workspace derive this card's id, and the same payload (rule 3). The ONE check the dispatcher, the details
 * view and "Send now" share. A store fault is `store_fault`, never "nothing saved".
 */
export async function checkSavedAction(
  approval: Approval,
  deps: Pick<ExternalApprovalDispatchDeps, "outbox" | "workspaceConfig">,
): Promise<SavedActionCheck> {
  const ws = String(approval.workspaceId);
  if (ws === UNASSIGNED_WORKSPACE) return { kind: "refused", reason: "unassigned_workspace" };
  const onboarded = await deps.workspaceConfig.get(approval.workspaceId);
  if (!onboarded.ok) {
    return onboarded.error.code === "not_found" ? { kind: "refused", reason: "unknown_workspace" } : { kind: "store_fault" };
  }
  const saved = await deps.outbox.get(approvalOutboxId(approval.id));
  if (!saved.ok) return saved.error.code === "not_found" ? { kind: "no_saved_action" } : { kind: "store_fault" };
  const entry = saved.value;
  if (entry.workspaceId !== ws) return { kind: "refused", reason: "workspace_mismatch" };
  if (String(approvalIdFor({ idempotencyKey: entry.idempotencyKey, workspace: entry.workspaceId })) !== String(approval.id)) {
    return { kind: "refused", reason: "not_this_cards_action" };
  }
  if (entry.payloadHash !== approval.payloadHash) return { kind: "refused", reason: "payload_mismatch" };
  // ⛔ RULE 3 — re-hash the payload that will actually be SENT (and shown), not just compare two stored hash
  // columns. Review 2026-09-22 (critic, measured): with only the column compare, an entry whose payload was changed
  // out of band — hash column untouched — was shown as verified and sent. Same defence-in-depth as the semantic
  // path's `payloadHash(row.plan) !== approval.payloadHash` (semanticMutationDispatch.ts).
  const payload = entry.payload;
  if (typeof payload !== "object" || payload === null || payloadHash(payload as Record<string, unknown>) !== approval.payloadHash) {
    return { kind: "refused", reason: "payload_mismatch" };
  }
  return { kind: "verified", entry };
}

/** The states in which a write is actually attempted. Everything else refuses or reports. */
export const DISPATCHABLE: ReadonlySet<ApprovalSendState> = new Set<ApprovalSendState>(["ready", "held"]);

/**
 * The card's send state, from the card, its saved-action check, and whether its system has a real sender in its
 * workspace. PURE. Order: integrity refusal → nothing saved → the owner's own "no" (rejected / edited / expired
 * card) → a finished entry (sent / rejected / expired) → a still-open card → writes off → the entry's retry state. `store_fault` is returned as-is so a caller can fail
 * the request instead of showing a false state.
 */
export function sendStateOf(
  approval: Approval,
  check: SavedActionCheck,
  armedFor: (targetSystem: TargetSystem, workspaceId: string) => boolean,
): { readonly state: ApprovalSendState; readonly refusal?: ApprovalSendRefusal } | "store_fault" {
  if (check.kind === "store_fault") return "store_fault";
  if (check.kind === "refused") return { state: "refused", refusal: check.reason };
  if (check.kind === "no_saved_action") return { state: "no_send_record" };
  const entry = check.entry;
  // The owner's own "no" first: a rejected or edited card closes its entry as "rejected", which must read as "not
  // approved", never as "refused by the vendor" (review 2026-09-22, measured).
  if (approval.status === "rejected" || approval.status === "edited" || approval.status === "expired") return { state: "not_approved" };
  if (entry.status === "receipt_recorded") return { state: "sent" };
  if (entry.status === "rejected") return { state: "rejected" };
  if (entry.status === "expired") return { state: "expired" };
  if (approval.status === "pending" || approval.status === "deferred") return { state: "awaiting_approval" };
  if (approval.status !== "approved") return { state: "not_approved" };
  if (!armedFor(entry.targetSystem as TargetSystem, entry.workspaceId)) return { state: "writes_off" };
  if (entry.status === "proposed") return { state: "ready" };
  if (entry.status === "retry_queued") return { state: "held" };
  return { state: "unknown" };
}

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
  const sent =
    outcome.kind === "dispatched" && (outcome.status === "created" || outcome.status === "updated" || outcome.status === "reused");
  if (sent && deps.onSent !== undefined) {
    try {
      await deps.onSent(String(approval.id));
    } catch {
      /* reporting must never fail the dispatch */
    }
  }
  return outcome;
}

async function decideAndSend(approval: Approval, deps: ExternalApprovalDispatchDeps): Promise<ExternalApprovalOutcome> {
  if (approval.subjectKind === "semantic_mutation") return { kind: "skipped", reason: "not_external" };
  if (approval.status === "rejected" || approval.status === "edited" || approval.status === "expired") {
    return closeSavedEntry(approval, deps);
  }
  if (approval.status !== "approved") return { kind: "skipped", reason: "not_approved" };

  const ws = String(approval.workspaceId);
  const check = await checkSavedAction(approval, deps);
  const st = sendStateOf(approval, check, deps.armedFor);
  if (st === "store_fault") return { kind: "refused", reason: "store_unavailable" };
  if (!DISPATCHABLE.has(st.state)) {
    switch (st.state) {
      case "refused":
        return { kind: "refused", reason: st.refusal ?? "not_this_cards_action" };
      case "no_send_record":
        return { kind: "refused", reason: "no_saved_action" };
      case "writes_off":
        return { kind: "refused", reason: "writes_off" };
      case "sent":
      case "rejected":
      case "expired":
        return { kind: "already_done" };
      default:
        return { kind: "refused", reason: "unknown_status" };
    }
  }
  if (check.kind !== "verified") return { kind: "refused", reason: "no_saved_action" }; // unreachable: DISPATCHABLE implies verified
  const entry = check.entry;

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
 * A rejected or EDITED card will never be sent (both are terminal), so close its saved entry. Otherwise the entry
 * stays `proposed` — "due" to the wake drain — and an armed drain would re-drive it forever (review 2026-09-22;
 * `edited` added the same day after the critic measured it). `expired` is handled the same way for completeness,
 * but nothing that sets `expired` calls this port today (the decide command has no expire decision; only the
 * never-started approval-flow workflow expires cards). Touches only an entry that is provably this card's.
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
  if (outcome.kind === "refused") {
    if (outcome.reason === "workspace_mismatch" || outcome.reason === "payload_mismatch" || outcome.reason === "not_this_cards_action") {
      return { kind: "integrity", approvalId, reason: outcome.reason };
    }
    return { kind: "not_sent", approvalId, reason: outcome.reason };
  }
  return undefined;
}

/** Sends one approval's write (or refuses). Built once at boot and shared by the decide command and "Send now". */
export type ExternalApprovalSender = (approval: Approval) => Promise<ExternalApprovalOutcome>;

/**
 * The shared sender: {@link dispatchExternalApproval}, SINGLE-FLIGHT per approval id (rule 3). A second call for an
 * approval whose send is still running gets THAT call's result instead of starting another — so two "Send now"
 * clicks, or a decide and a "Send now" together, make one existence probe and at most one create. After the first
 * settles, a new call re-checks from scratch (and finds the card already sent).
 */
export function createExternalApprovalSender(deps: ExternalApprovalDispatchDeps): ExternalApprovalSender {
  const inflight = new Map<string, Promise<ExternalApprovalOutcome>>();
  return (approval: Approval): Promise<ExternalApprovalOutcome> => {
    const key = String(approval.id);
    const running = inflight.get(key);
    if (running !== undefined) return running;
    const started = dispatchExternalApproval(approval, deps).finally(() => inflight.delete(key));
    inflight.set(key, started);
    return started;
  };
}

/**
 * The `DispatchApprovalFn` the Approvals screen's decide command calls. Always `ok`: by the time it runs, the
 * owner's decision has already been recorded, so an `err` would make the screen say "Couldn't decide — try
 * again" about a decision that DID land, and that retry cannot re-dispatch. What happened to the write is on
 * the saved entry (and in System Health via `onFailure`).
 */
export function createExternalApprovalDispatch(send: ExternalApprovalSender): DispatchApprovalFn {
  return async (approval: Approval): Promise<Result<void, FailureVariant>> => {
    await send(approval); // total: never throws
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
    f.kind === "not_sent"
      ? `approved external write not sent: ${f.reason ?? "unknown"}`
      : f.kind === "held"
      ? "approved external write held; it will be retried"
      : f.kind === "rejected"
        ? "approved external write was rejected"
        : f.kind === "conflict"
          ? "approved external write hit a conflict"
          : `approved external write refused: ${f.reason ?? "integrity"}`;
  return {
    failureClass: f.kind === "held" || f.kind === "rejected" || f.kind === "not_sent" ? "write_through_failed" : "conflict_review",
    subjectRef: f.approvalId,
    message,
    auditRef: auditId(`approval-dispatch:${f.approvalId}`),
    now,
  };
}
