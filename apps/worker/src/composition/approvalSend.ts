// @sow/worker — the real ApprovalSendPort (Linear slice 3+4, step 4d): details, the unsent list and "Send now",
// over the approvals + outbox + workspace config, sharing the dispatcher's ONE check, ONE state and ONE sender.
//
// ⛔ WS-8. Details and Send now are served only when the requested workspace equals the approval's OWN stored
// workspace, and a foreign card answers EXACTLY like a missing one, so this surface cannot be used to learn
// whether a card exists in another workspace. ⚠ The worker cannot see the screen's scope — it only compares the
// workspace it is ASKED about with the card's own. So the renderer must ask with the ACTIVE scope's workspace, never
// with the card's (which every UiSafeApproval carries). The renderer does so since step 5: apps/desktop/renderer/
// App.tsx resolves the active scope, and apps/desktop/test-dom/app-approval-scope.test.tsx pins that the active
// scope's id is what is asked. "Never the card's" is held by two renderer layers instead (Details is offered only
// for an active-workspace card; the unsent list is filtered to the active workspace), each pinned by its own test.
import { err, ok, failure } from "@sow/contracts";
import type { Approval, FailureVariant, Result, TargetSystem, UiSafeApproval, UiSafeApprovalDetail, UiSafeSendNowResult } from "@sow/contracts";
import type { ApprovalRepository, OutboxRepository, WorkspaceConfigRepository } from "@sow/db";
import type { ApprovalSendPort, ApprovalRefInput, WorkspaceInput } from "../api/procedures/approvalSend";
import { toUiSafeApproval, toUiSafeApprovalDetail, toUiSafeSendNowResult } from "../api/projections/uiSafe";
import { checkSavedAction, sendStateOf, type ExternalApprovalSender, type SavedActionCheck } from "./externalApprovalDispatch";

export interface ApprovalSendPortDeps {
  readonly approvals: ApprovalRepository;
  readonly outbox: OutboxRepository;
  readonly workspaceConfig: WorkspaceConfigRepository;
  readonly armedFor: (targetSystem: TargetSystem, workspaceId: string) => boolean;
  /** The worker's ONE shared sender. Absent (a dispatch override is bound) ⇒ Send now is unavailable, never faked. */
  readonly sender?: ExternalApprovalSender;
}

const MAX_UNSENT = 100;
const NOT_FOUND: Result<never, FailureVariant> = err(
  failure("validation_rejected", "approval not found", { cause: { code: "APPROVAL_NOT_FOUND" } }),
);
const STORE_UNAVAILABLE: Result<never, FailureVariant> = err(
  failure("degraded_unavailable", "approval send state unavailable", { retryable: true, cause: { code: "APPROVAL_SEND_STORE_UNAVAILABLE" } }),
);

/**
 * The card, only if it exists AND belongs to the requested workspace — else the SAME not-found either way (so a
 * foreign card cannot be told apart from a missing one). A STORE FAULT is different: it does not depend on the
 * card's workspace, so it is reported as "unavailable, retry" rather than as "no such card" (review 2026-09-22).
 */
async function ownCard(deps: ApprovalSendPortDeps, input: ApprovalRefInput): Promise<Approval | undefined | "store_fault"> {
  const got = await deps.approvals.get(input.approvalId as Approval["id"]);
  if (!got.ok) return got.error.code === "not_found" ? undefined : "store_fault";
  if (String(got.value.workspaceId) !== input.workspaceId) return undefined;
  return got.value;
}

/**
 * The action's own content for its details — only for Linear, and only when the saved action is provably this
 * card's (same workspace, same id, and a payload that re-hashes to the approved hash). Linear's write sends
 * `title`, `description`, `priority` and `teamId` (linear-write-spec.ts); the first three are shown, and the team by
 * its NAME (`teamName`, saved by the form's proposer from the list it read — Linear slice 5a). ⚠ A card proposed any
 * other way (the Copilot) carries no `teamName` yet, so its team is not shown; a raw team id tells the owner nothing.
 * Corrected 2026-09-22 (review): this used to claim Linear sends "exactly title and description". Amended 2026-09-25.
 */
function contentOf(check: SavedActionCheck): { title?: unknown; description?: unknown; priority?: unknown; teamName?: unknown } {
  if (check.kind !== "verified" || check.entry.targetSystem !== "linear") return {};
  const payload = check.entry.payload;
  if (typeof payload !== "object" || payload === null) return {};
  const p = payload as Record<string, unknown>;
  // `teamName` (Linear slice 5a): the form's proposer saves the team's NAME, read from that workspace's Linear.
  // The team id is never read here — it is what is sent, not what the owner reads.
  return { title: p["title"], description: p["description"], priority: p["priority"], teamName: p["teamName"] };
}

export function createApprovalSendPort(deps: ApprovalSendPortDeps): ApprovalSendPort {
  return {
    async detail(input): Promise<Result<UiSafeApprovalDetail, FailureVariant>> {
      const card = await ownCard(deps, input);
      if (card === "store_fault") return STORE_UNAVAILABLE;
      if (card === undefined) return NOT_FOUND;
      if (card.subjectKind === "semantic_mutation") {
        return err(failure("validation_rejected", "not an external action", { cause: { code: "APPROVAL_DETAIL_UNSUPPORTED" } }));
      }
      const check = await checkSavedAction(card, deps);
      const st = sendStateOf(card, check, deps.armedFor);
      if (st === "store_fault") return STORE_UNAVAILABLE;
      return ok(
        toUiSafeApprovalDetail({
          approvalId: String(card.id),
          sendState: st.state,
          ...(st.refusal !== undefined ? { refusal: st.refusal } : {}),
          ...(check.kind === "verified" ? { targetSystem: check.entry.targetSystem } : {}),
          ...(st.state === "refused" ? {} : contentOf(check)),
        }),
      );
    },

    async unsent(input: WorkspaceInput): Promise<Result<readonly UiSafeApproval[], FailureVariant>> {
      const ws = await deps.workspaceConfig.get(input.workspaceId as Approval["workspaceId"]);
      if (!ws.ok) {
        return ws.error.code === "not_found"
          ? err(failure("validation_rejected", "workspace not found", { cause: { code: "WORKSPACE_NOT_FOUND" } }))
          : STORE_UNAVAILABLE;
      }
      const approved = await deps.approvals.listByStatusAndWorkspace("approved", input.workspaceId as Approval["workspaceId"]);
      if (!approved.ok) return STORE_UNAVAILABLE;
      const rows: { card: UiSafeApproval; refused: boolean; updatedAt: string }[] = [];
      for (const card of approved.value) {
        if (card.subjectKind === "semantic_mutation") continue;
        const check = await checkSavedAction(card, deps);
        const st = sendStateOf(card, check, deps.armedFor);
        if (st === "store_fault") return STORE_UNAVAILABLE; // a wrong list is worse than none
        if (st.state === "sent" || st.state === "no_send_record") continue;
        const target = check.kind === "verified" ? (check.entry.targetSystem as TargetSystem) : undefined;
        rows.push({
          card: toUiSafeApproval(card, target),
          refused: st.state === "refused",
          updatedAt: check.kind === "verified" ? check.entry.updatedAt : "",
        });
      }
      // ORDER: integrity-refused cards FIRST (the owner most needs to see a card whose saved write no longer matches
      // what they approved), then the rest by their saved entry's last update, newest first. ⚠ "Last update" is not
      // "newest card": where the proof-spine drain runs, a skipped entry's timestamp moves too. The cap is SILENT —
      // the contract carries no truncation flag — so more than 100 unsent cards shows only the first 100.
      rows.sort((a, b) =>
        a.refused !== b.refused ? (a.refused ? -1 : 1) : a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
      );
      return ok(rows.slice(0, MAX_UNSENT).map((r) => r.card));
    },

    async sendNow(input): Promise<Result<UiSafeSendNowResult, FailureVariant>> {
      if (deps.sender === undefined) {
        return err(failure("degraded_unavailable", "send now is unavailable here", { cause: { code: "SEND_NOW_UNAVAILABLE" } }));
      }
      const card = await ownCard(deps, input);
      if (card === "store_fault") return STORE_UNAVAILABLE;
      if (card === undefined) return NOT_FOUND;
      if (card.subjectKind === "semantic_mutation") {
        return err(failure("validation_rejected", "not an external action", { cause: { code: "SEND_NOW_NOT_EXTERNAL" } }));
      }
      if (card.status !== "approved") {
        return err(failure("validation_rejected", "the card is not approved", { cause: { code: "SEND_NOW_NOT_APPROVED" } }));
      }
      await deps.sender(card); // total; single-flight with the decide command's dispatch
      // Re-read the state from a fresh check — never map the gateway's result, which a concurrent path may have changed.
      const check = await checkSavedAction(card, deps);
      const st = sendStateOf(card, check, deps.armedFor);
      if (st === "store_fault") return STORE_UNAVAILABLE;
      return ok(toUiSafeSendNowResult({ approvalId: String(card.id), sendState: st.state, ...(st.refusal !== undefined ? { refusal: st.refusal } : {}) }));
    },
  };
}
