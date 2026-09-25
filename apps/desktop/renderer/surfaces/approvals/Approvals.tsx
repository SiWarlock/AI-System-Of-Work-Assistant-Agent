// Approvals surface (§9.8, REQ-F-012) — the Approval Inbox that mounts inside the
// AppShell. A GLOBAL inbox of approvals; the user approves / rejects / defers each with a
// single idempotent transition (Mac + Telegram parity is enforced server-side — this is
// the Mac channel). §13.10a: a card is EITHER an external_action write OR a Copilot-proposed
// semantic_mutation (a Markdown/note write) — the card branches on `subjectKind`.
//
// Invariants:
//   - WS-8: the inbox LIST is safe cross-scope by construction — `UiSafeApproval` carries only ids + status +
//     channel + timing + the closed target system + its workspace id (no raw content, no actor/payloadHash), so
//     ONE global inbox leaks nothing. An approval's DETAILS are content, so (Linear slice 3+4, owner decision
//     2026-09-22) they load ON OPEN and are offered ONLY for a card whose workspace is the ACTIVE one; this
//     surface never passes a workspace — the App resolves the active scope's (App.tsx), and the worker re-checks.
//   - State machine (packages/domain approvalMachine): only a PENDING item is actionable
//     (pending -> approved|edited|rejected|deferred). A DEFERRED item can only transition
//     to pending|expired (the snooze-expiry workflow re-surfaces it), so it is DISPLAY-ONLY
//     here — offering approve/reject on it would be an illegal transition the CAS rejects.
//   - The renderer only REQUESTS a decision; the worker owns the exactly-once CAS + the
//     one-writer dispatch. A missing `onDecide` (no live worker) disables the buttons —
//     honest, not a dead control that silently no-ops.
// NEVER import electron, node, or @sow/worker from a renderer file.

import { useEffect, useRef, useState, type ReactElement } from "react";
import type { UiSafeApproval, UiSafeApprovalDetail, ApprovalSendState, ApprovalSendRefusal } from "@sow/contracts/api/ui-safe";
import type { ApprovalDecision } from "../../lib/approval-decision";
import type { ApprovalDetailResult, SendNowResult } from "../../lib/approval-send";
import type { LinearIssueDraft, LinearTeamsResult, ProposeLinearIssueResult } from "../../lib/linear-issue";
import { NewLinearIssue } from "./NewLinearIssue";

/**
 * The client-visible result of a decision request (§9.8). `"already_resolved"` covers BOTH wire
 * shapes that mean the same thing to the user — an ok result with `applied:false` (an idempotent
 * replay / cross-channel no-op) and a `write_conflict` err (the CAS's exactly-once loser) — so the
 * card renders one honest line regardless of which shape the worker returned. `"unavailable"` is
 * everything else (not-found / auth / a malformed result / a transport failure).
 */
export type ApprovalDecisionOutcome = "applied" | "already_resolved" | "unavailable";

export interface ApprovalsProps {
  /** The GLOBAL approval inbox (all statuses; the surface filters to the actionable + snoozed views). */
  readonly approvals: readonly UiSafeApproval[];
  /**
   * Decide a pending approval (§9.8). Absent when there is no live worker → the action
   * buttons render DISABLED (a decision can't be issued offline). Resolves to the outcome so the
   * card can render it: "already_resolved" (a lost CAS race, from either wire shape) is honest
   * feedback, not a silent no-op; "unavailable" covers every other failure. `edit` opens a
   * payload-editing form (below) that reviews the card's known UI-safe fields before confirming —
   * it issues the SAME `onDecide(id, "edit")` call as the other three, no extra payload on the wire.
   */
  readonly onDecide?: (approvalId: string, decision: ApprovalDecision) => Promise<ApprovalDecisionOutcome>;
  /**
   * Task 9.42 — the navigation TARGET a `{ surface: "approvals", approvalId }` route points at
   * (route.ts). Marks the matching card (pending OR snoozed — the target may be deferred)
   * `aria-current="true"` + a focus class and scrolls it into view on mount. Absent (the default
   * list view) or matching no rendered card is inert — never throws, marks nothing. No producer
   * supplies a real id yet (9.42's producer leg is blocked — see route.ts); this only builds the
   * target side so the affordance has somewhere real to land once one does.
   */
  readonly focusedApprovalId?: string;
  /**
   * Linear slice 3+4 — the ACTIVE scope's onboarded workspace id (null in Global). Details are offered only for a
   * card whose own workspace equals it; a change of it resets every open detail.
   */
  readonly activeWorkspaceId?: string | null;
  /** Load one approval's details (the App asks with the ACTIVE workspace). Absent (no live worker) ⇒ not offered. */
  readonly onOpenDetail?: (approvalId: string) => Promise<ApprovalDetailResult>;
  /** The active workspace's approved external cards whose write has not gone out. */
  readonly unsent?: readonly UiSafeApproval[];
  /** The latest load of the list failed. The screen says so; any list shown is from the last good load. */
  readonly unsentLoadFailed?: boolean;
  /** Cards the worker confirmed SENT since the list was last loaded: they read as sent until the next load drops them. */
  readonly sentApprovalIds?: readonly string[];
  /** Re-run the guarded dispatch for one approved card. Absent (no live worker) ⇒ the button is disabled. */
  readonly onSendNow?: (approvalId: string) => Promise<SendNowResult>;
  /**
   * Linear slice 5a — the New Linear issue form. Load the ACTIVE workspace's Linear teams (the App asks for the active
   * scope). The form is offered only when this, `onProposeLinearIssue` and an active workspace are all present.
   */
  readonly onLoadLinearTeams?: () => Promise<LinearTeamsResult>;
  /** Propose one Linear issue in the active workspace, as a PENDING card. */
  readonly onProposeLinearIssue?: (draft: LinearIssueDraft) => Promise<ProposeLinearIssueResult>;
}

/** The four decisions offered on a pending item — each a legal `pending -> …` transition. `edit`
 *  is rendered specially (it opens the payload-editing form instead of deciding immediately). */
const PENDING_DECISIONS: readonly { readonly decision: ApprovalDecision; readonly label: string }[] = [
  { decision: "approve", label: "Approve" },
  { decision: "reject", label: "Reject" },
  { decision: "defer", label: "Defer" },
  { decision: "edit", label: "Edit" },
];

/** The date portion of an ISO timestamp (deterministic; avoids locale/timezone drift). */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * §13.10a Slice H — the card's human subject line, branched on the subject kind. A `semantic_mutation`
 * card is a Copilot-PROPOSED Markdown/note write (it carries a planRef, NOT an actionRef, and the ref is
 * never surfaced), so it gets a fixed descriptive label; an `external_action` card shows its action ref.
 * An absent subjectKind defaults to the external label (the pre-§13.10a card shape).
 */
function cardSubject(a: UiSafeApproval): string {
  return a.subjectKind === "semantic_mutation" ? "Proposed note write (Copilot)" : (a.actionRef ?? "External action");
}

/** 9.42 — the CSS class marking a card as the route's `approvalId` target. */
const FOCUSED_CARD_CLASS = "sow-approval-card--focused";

/**
 * 9.42 — a card ref that scrolls itself into view on mount IFF it is the route's
 * focused target. `scrollIntoView` is guarded (not every DOM implementation
 * provides it — e.g. some jsdom configurations) so a missing method is inert,
 * never a throw; a real browser gets the real scroll.
 */
function useFocusedCardRef(focused: boolean | undefined): React.RefObject<HTMLLIElement> {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused !== true) return;
    const el = ref.current;
    if (el !== null && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center" });
    }
    // Intentionally re-fires only when `focused` flips true→true is a no-op re-render skip via the
    // dep array below — the scroll should happen once when this card BECOMES the target, not on
    // every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);
  return ref;
}

/** Deterministic id for a card's edit-form region — links the `Edit` toggle's `aria-controls`
 *  to the disclosed form (§11 / CF-7: every `aria-expanded` trigger names what it discloses). */
function editFormId(approvalId: string): string {
  return `sow-approval-edit-${approvalId}`;
}

const SYSTEM_NAME: Readonly<Record<string, string>> = {
  linear: "Linear", todoist: "Todoist", calendar: "Calendar", asana: "Asana", drive: "Drive", github: "GitHub", telegram: "Telegram",
};
function systemName(target: string | undefined): string {
  return target === undefined ? "this system" : (SYSTEM_NAME[target] ?? target);
}

/** Linear's priority scale (0 none … 4 low), shown because Linear sends it. */
const PRIORITY_LABEL: readonly string[] = ["No priority", "Urgent", "High", "Medium", "Low"];

const REFUSAL_LABEL: Readonly<Record<ApprovalSendRefusal, string>> = {
  payload_mismatch: "its saved write no longer matches what was approved",
  workspace_mismatch: "its saved write belongs to another workspace",
  not_this_cards_action: "its saved write belongs to another card",
  unknown_workspace: "its workspace is not set up here",
  unassigned_workspace: "it has no workspace",
};

/** The honest, one-line send state of an external card (Linear slice 3+4). */
export function sendStateLabel(state: ApprovalSendState, target?: string, refusal?: ApprovalSendRefusal): string {
  switch (state) {
    case "awaiting_approval":
      return "Waiting for your approval";
    case "not_approved":
      return "Not approved — it will not be sent";
    case "writes_off":
      return `Not sent: writes to ${systemName(target)} are off`;
    case "ready":
      return "Not sent yet — ready to send";
    case "held":
      return "Held: not sent yet";
    case "sent":
      return "Sent";
    case "rejected":
      return "Not sent: the write was refused";
    case "expired":
      return "Not sent: expired";
    case "refused":
      return `Not sent: ${refusal !== undefined ? REFUSAL_LABEL[refusal] : "it failed a safety check"}`;
    case "no_send_record":
      return "No send record here";
    default:
      return "Send state unknown";
  }
}

function detailsId(approvalId: string): string {
  return `sow-approval-details-${approvalId}`;
}

/**
 * Linear slice 3+4 — the "Details" disclosure. Offered ONLY when the card's own workspace is the ACTIVE one (WS-8:
 * the details are the action's own content); otherwise a hint says to switch. Loads on EVERY open, so an
 * "unavailable" answer can be retried and a state is never older than the open. Only the answer to the latest open
 * is shown, only while this card is mounted (the parent re-keys cards by the active workspace), and only if it is
 * about THIS approval. Every line is rendered as TEXT.
 */
function DetailsDisclosure({
  approval,
  activeWorkspaceId,
  onOpenDetail,
}: {
  readonly approval: UiSafeApproval;
  readonly activeWorkspaceId: string | null | undefined;
  readonly onOpenDetail?: (approvalId: string) => Promise<ApprovalDetailResult>;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<UiSafeApprovalDetail | "loading" | "unavailable">("loading");
  const alive = useRef(true);
  const openSeq = useRef(0);
  // Set back to true in the effect BODY: StrictMode (the dev build) mounts, cleans up and mounts again, and a flag
  // set only by the cleanup stays false for the card's whole life (every answer was dropped — step-5 review).
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  if (onOpenDetail === undefined || approval.subjectKind === "semantic_mutation") return null;
  if (approval.workspaceId === undefined || approval.workspaceId !== activeWorkspaceId) {
    return <div className="sow-approval-hint">Switch to its workspace to see details</div>;
  }
  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    const seq = ++openSeq.current;
    if (!next) return;
    setDetail("loading");
    void onOpenDetail(approval.id).then((r) => {
      if (!alive.current || seq !== openSeq.current) return;
      setDetail(r.ok && r.detail.approvalId === approval.id ? r.detail : "unavailable");
    });
  };
  return (
    <>
      <button
        type="button"
        className="sow-approval-btn sow-approval-btn--details"
        aria-expanded={open}
        aria-controls={detailsId(approval.id)}
        onClick={toggle}
      >
        Details
      </button>
      {open ? (
        <div id={detailsId(approval.id)} className="sow-approval-details" role="group" aria-label="Approval details">
          {detail === "loading" ? (
            <div className="sow-approval-details-meta">Loading…</div>
          ) : detail === "unavailable" ? (
            <div className="sow-approval-details-meta">Details unavailable</div>
          ) : (
            <>
              {detail.title !== undefined ? <div className="sow-approval-details-title">{detail.title}</div> : null}
              {/* Linear slice 5a — where the issue goes. The worker serves it only for a card the owner's form proposed. */}
              {detail.teamName !== undefined ? <div className="sow-approval-details-meta">Team: {detail.teamName}</div> : null}
              {detail.priority !== undefined ? (
                <div className="sow-approval-details-meta">Priority: {PRIORITY_LABEL[detail.priority] ?? detail.priority}</div>
              ) : null}
              {(detail.descriptionLines ?? []).map((line, i) => (
                <p key={i} className="sow-approval-details-line">
                  {line}
                </p>
              ))}
              {detail.descriptionTruncated === true ? <div className="sow-approval-details-meta">(more not shown)</div> : null}
              <div className="sow-approval-sendstate">{sendStateLabel(detail.sendState, detail.targetSystem, detail.refusal)}</div>
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

/**
 * Linear slice 3+4 — an APPROVED external card whose write has not gone out. Shows the system, the Details
 * disclosure, and "Send now", which re-runs the SAME guarded dispatch. Send now does nothing while a send is in
 * flight (the button is disabled, and a ref catches a second click that lands before the re-render), when there is
 * no live worker, and once the write is sent. The result line is the worker's re-read state, never a guess, and a
 * send closes an open Details panel so it never shows the state from before the send. A SENT result also comes from
 * the App (`alreadySent`), so it survives a remount. ⚠ The in-flight guard is per mount (leaving the page or a scope
 * switch remounts the card); the rule-3 guard is the worker's single-flight sender.
 */
function UnsentCard({
  approval,
  activeWorkspaceId,
  onOpenDetail,
  onSendNow,
  alreadySent,
}: {
  readonly approval: UiSafeApproval;
  readonly activeWorkspaceId: string | null | undefined;
  readonly onOpenDetail?: (approvalId: string) => Promise<ApprovalDetailResult>;
  readonly onSendNow?: (approvalId: string) => Promise<SendNowResult>;
  readonly alreadySent?: boolean;
}): ReactElement {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ readonly label: string; readonly sent: boolean } | undefined>(undefined);
  const [detailsKey, setDetailsKey] = useState(0);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; // in the BODY — see DetailsDisclosure (StrictMode)
    return () => {
      alive.current = false;
    };
  }, []);
  const sent = alreadySent === true || result?.sent === true;
  const resultLabel = result?.label ?? (alreadySent === true ? sendStateLabel("sent", approval.targetSystem) : undefined);
  const send = (): void => {
    if (onSendNow === undefined || inFlight.current || sent) return;
    inFlight.current = true;
    setSending(true);
    void onSendNow(approval.id).then((r) => {
      inFlight.current = false;
      if (!alive.current) return;
      setSending(false);
      setDetailsKey((k) => k + 1);
      setResult(
        r.ok
          ? { label: sendStateLabel(r.result.sendState, approval.targetSystem, r.result.refusal), sent: r.result.sendState === "sent" }
          : { label: "Couldn't send — try again", sent: false },
      );
    });
  };
  return (
    <li className="sow-approval-card sow-approval-card--notsent" role="listitem" data-approval-id={approval.id}>
      <div className="sow-approval-head">
        <span className="sow-approval-action">{cardSubject(approval)}</span>
        {sent ? (
          <span className="sow-approval-status sow-approval-status--sent">sent</span>
        ) : (
          <span className="sow-approval-status sow-approval-status--notsent">not sent</span>
        )}
      </div>
      <div className="sow-approval-meta">to {systemName(approval.targetSystem)}</div>
      <div className="sow-approval-actions">
        <DetailsDisclosure key={detailsKey} approval={approval} activeWorkspaceId={activeWorkspaceId} onOpenDetail={onOpenDetail} />
        <button
          type="button"
          className="sow-approval-btn sow-approval-btn--send"
          disabled={onSendNow === undefined || sending || sent}
          onClick={send}
          title={onSendNow === undefined ? "Connect the worker to send" : undefined}
        >
          Send now
        </button>
      </div>
      {resultLabel !== undefined ? (
        <div className="sow-approval-sendstate" role="status">
          {resultLabel}
        </div>
      ) : null}
    </li>
  );
}

/**
 * §9.8 — the `edit` payload-editing form. There is no raw action payload on the UI-safe wire
 * (rule 2/7: candidate/action content never crosses to the renderer — only an opaque
 * `payloadHash`), so this reviews the card's known UI-safe fields (`targetSystem` /
 * `workspaceId`, the fields `UiSafeApproval` carries specifically "for the renderer's payload
 * editor") rather than inventing an editable content field. Confirming issues the SAME
 * `onDecide(id, "edit")` call as the other three decisions — no extra payload on the wire.
 */
function EditForm({
  approval,
  onCancel,
  onConfirm,
}: {
  readonly approval: UiSafeApproval;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactElement {
  const hasDetail = approval.targetSystem !== undefined || approval.workspaceId !== undefined;
  return (
    <div id={editFormId(approval.id)} className="sow-approval-edit-form" role="group" aria-label="Edit this approval">
      <div className="sow-approval-edit-summary">
        {approval.targetSystem !== undefined ? <div>Target: {approval.targetSystem}</div> : null}
        {approval.workspaceId !== undefined ? <div>Workspace: {approval.workspaceId}</div> : null}
        {!hasDetail ? <div>No additional details available for this action.</div> : null}
      </div>
      <div className="sow-approval-edit-actions">
        <button type="button" className="sow-approval-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="sow-approval-btn sow-approval-btn--approve" onClick={onConfirm}>
          Confirm edit
        </button>
      </div>
    </div>
  );
}

/** A pending approval card — the action, its metadata, the four decision buttons (`edit` opens
 *  the payload-editing form above instead of deciding immediately), and the last decision outcome
 *  (§9.8: "already resolved" vs "unavailable" — never silent on a failed decision). */
function PendingCard({
  approval,
  onDecide,
  focused,
  activeWorkspaceId,
  onOpenDetail,
}: {
  readonly approval: UiSafeApproval;
  readonly onDecide?: (approvalId: string, decision: ApprovalDecision) => Promise<ApprovalDecisionOutcome>;
  /** 9.42 — true iff the route's `approvalId` names this card. */
  readonly focused?: boolean;
  readonly activeWorkspaceId?: string | null;
  readonly onOpenDetail?: (approvalId: string) => Promise<ApprovalDetailResult>;
}): ReactElement {
  const disabled = onDecide === undefined;
  const cardRef = useFocusedCardRef(focused);
  const semantic = approval.subjectKind === "semantic_mutation";
  // The most recent non-"applied" outcome — a real transition ("applied") clears it and the item
  // drops out of the pending list on the parent's next render, so there is nothing left to show.
  const [outcome, setOutcome] = useState<"already_resolved" | "unavailable" | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const decide = (decision: ApprovalDecision): void => {
    if (onDecide === undefined) return;
    setOutcome(undefined);
    void onDecide(approval.id, decision).then((o) => {
      if (o !== "applied") setOutcome(o);
    });
  };
  return (
    <li
      ref={cardRef}
      className={`sow-approval-card${semantic ? " sow-approval-card--semantic" : ""}${focused === true ? ` ${FOCUSED_CARD_CLASS}` : ""}`}
      role="listitem"
      data-approval-id={approval.id}
      data-subject-kind={approval.subjectKind}
      aria-current={focused === true ? "true" : undefined}
    >
      <div className="sow-approval-head">
        <span className="sow-approval-action">{cardSubject(approval)}</span>
        <span className="sow-approval-status sow-approval-status--pending">pending</span>
      </div>
      <div className="sow-approval-meta">
        via {approval.channel}
        {approval.expiresAt !== undefined ? <> · expires {dayOf(approval.expiresAt)}</> : null}
      </div>
      <div className="sow-approval-actions">
        {PENDING_DECISIONS.map((d) => (
          <button
            key={d.decision}
            type="button"
            className={`sow-approval-btn sow-approval-btn--${d.decision}`}
            disabled={disabled}
            aria-expanded={d.decision === "edit" ? editing : undefined}
            aria-controls={d.decision === "edit" ? editFormId(approval.id) : undefined}
            onClick={() => (d.decision === "edit" ? setEditing((v) => !v) : decide(d.decision))}
            title={disabled ? "Connect the worker to act on approvals" : undefined}
          >
            {d.label}
          </button>
        ))}
        <DetailsDisclosure approval={approval} activeWorkspaceId={activeWorkspaceId} onOpenDetail={onOpenDetail} />
      </div>
      {editing ? (
        <EditForm
          approval={approval}
          onCancel={() => setEditing(false)}
          onConfirm={() => {
            decide("edit");
            setEditing(false);
          }}
        />
      ) : null}
      {outcome === "already_resolved" ? (
        <div className="sow-approval-outcome" role="status">
          already resolved
        </div>
      ) : outcome === "unavailable" ? (
        <div className="sow-approval-outcome sow-approval-outcome--error" role="alert">
          Couldn&apos;t decide — try again
        </div>
      ) : null}
    </li>
  );
}

/** A snoozed (deferred) approval card — DISPLAY-ONLY; it re-surfaces to pending on snooze expiry. */
function SnoozedCard({
  approval,
  focused,
}: {
  readonly approval: UiSafeApproval;
  /** 9.42 — true iff the route's `approvalId` names this card (a deferred item can be the target too). */
  readonly focused?: boolean;
}): ReactElement {
  const semantic = approval.subjectKind === "semantic_mutation";
  const cardRef = useFocusedCardRef(focused);
  return (
    <li
      ref={cardRef}
      className={`sow-approval-card sow-approval-card--snoozed${semantic ? " sow-approval-card--semantic" : ""}${focused === true ? ` ${FOCUSED_CARD_CLASS}` : ""}`}
      role="listitem"
      data-approval-id={approval.id}
      data-subject-kind={approval.subjectKind}
      aria-current={focused === true ? "true" : undefined}
    >
      <div className="sow-approval-head">
        <span className="sow-approval-action">{cardSubject(approval)}</span>
        <span className="sow-approval-status sow-approval-status--deferred">snoozed</span>
      </div>
      <div className="sow-approval-meta">
        via {approval.channel}
        {approval.snoozeUntil !== undefined ? <> · re-surfaces {dayOf(approval.snoozeUntil)}</> : null}
      </div>
    </li>
  );
}

export function Approvals(props: ApprovalsProps): ReactElement {
  const {
    approvals,
    onDecide,
    focusedApprovalId,
    activeWorkspaceId,
    onOpenDetail,
    unsent = [],
    unsentLoadFailed = false,
    sentApprovalIds = [],
    onSendNow,
    onLoadLinearTeams,
    onProposeLinearIssue,
  } = props;
  // Cards are keyed by the ACTIVE workspace too, so a scope change remounts them: every open detail is cleared and
  // a late answer for the old scope is dropped (WS-8 — no employer content lingers under a personal scope).
  const scopeKey = activeWorkspaceId ?? "global";
  // Only pending items are actionable; deferred items are snoozed (display-only). Terminal
  // items (approved/edited/rejected/expired) drop out of the inbox — they're resolved.
  const pending = approvals.filter((a) => a.status === "pending");
  const snoozed = approvals.filter((a) => a.status === "deferred");
  const empty = pending.length === 0 && snoozed.length === 0;

  return (
    <main className="sow-content" aria-label="Approvals">
      <div className="sow-page-head">
        <div>
          <h1>Approvals</h1>
          {pending.length > 0 ? (
            <div className="sow-subtitle">
              {pending.length} pending
            </div>
          ) : null}
        </div>
      </div>

      {/* Linear slice 5a — keyed by the active workspace: a scope switch drops the form's teams and draft (WS-8). */}
      {activeWorkspaceId !== undefined && activeWorkspaceId !== null && onLoadLinearTeams !== undefined && onProposeLinearIssue !== undefined ? (
        <NewLinearIssue key={scopeKey} onLoadTeams={onLoadLinearTeams} onPropose={onProposeLinearIssue} pendingIds={pending.map((a) => a.id)} />
      ) : null}

      {empty ? (
        <div className="sow-empty" role="status">
          No pending approvals
        </div>
      ) : (
        <>
          {pending.length > 0 ? (
            <ul className="sow-approval-list" role="list" aria-label="Pending approvals">
              {pending.map((a) => (
                <PendingCard
                  key={`${a.id}:${scopeKey}`}
                  approval={a}
                  onDecide={onDecide}
                  focused={a.id === focusedApprovalId}
                  activeWorkspaceId={activeWorkspaceId}
                  onOpenDetail={onOpenDetail}
                />
              ))}
            </ul>
          ) : null}
          {snoozed.length > 0 ? (
            <div className="sow-approval-snoozed">
              <div className="sow-approval-section-label">Snoozed</div>
              <ul className="sow-approval-list" role="list" aria-label="Snoozed approvals">
                {snoozed.map((a) => (
                  <SnoozedCard key={a.id} approval={a} focused={a.id === focusedApprovalId} />
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      {unsent.length > 0 || unsentLoadFailed ? (
        <div className="sow-approval-notsent">
          <div className="sow-approval-section-label">Not sent</div>
          {unsentLoadFailed ? (
            <div className="sow-approval-notsent-error" role="status">
              Couldn't load the Not sent list
            </div>
          ) : null}
          <ul className="sow-approval-list" role="list" aria-label="Approved but not sent">
            {unsent.map((a) => (
              <UnsentCard
                key={`${a.id}:${scopeKey}`}
                approval={a}
                activeWorkspaceId={activeWorkspaceId}
                onOpenDetail={onOpenDetail}
                onSendNow={onSendNow}
                alreadySent={sentApprovalIds.includes(a.id)}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </main>
  );
}
