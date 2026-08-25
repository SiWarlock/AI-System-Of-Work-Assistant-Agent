// Approvals surface (§9.8, REQ-F-012) — the Approval Inbox that mounts inside the
// AppShell. A GLOBAL inbox of approvals; the user approves / rejects / defers each with a
// single idempotent transition (Mac + Telegram parity is enforced server-side — this is
// the Mac channel). §13.10a: a card is EITHER an external_action write OR a Copilot-proposed
// semantic_mutation (a Markdown/note write) — the card branches on `subjectKind`.
//
// Invariants:
//   - WS-8: the inbox is safe cross-scope by construction — `UiSafeApproval` carries
//     only ids + status + channel + timing (no raw workspace content, no actor/payloadHash),
//     so ONE global inbox leaks nothing. (No scope prop: approvals carry no workspaceId to
//     scope by — a workspace-labelled/filtered inbox is the contract-enrichment follow-up.)
//   - State machine (packages/domain approvalMachine): only a PENDING item is actionable
//     (pending -> approved|edited|rejected|deferred). A DEFERRED item can only transition
//     to pending|expired (the snooze-expiry workflow re-surfaces it), so it is DISPLAY-ONLY
//     here — offering approve/reject on it would be an illegal transition the CAS rejects.
//   - The renderer only REQUESTS a decision; the worker owns the exactly-once CAS + the
//     one-writer dispatch. A missing `onDecide` (no live worker) disables the buttons —
//     honest, not a dead control that silently no-ops.
// NEVER import electron, node, or @sow/worker from a renderer file.

import { useState, type ReactElement } from "react";
import type { UiSafeApproval } from "@sow/contracts/api/ui-safe";
import type { ApprovalDecision } from "../../lib/approval-decision";

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

/** Deterministic id for a card's edit-form region — links the `Edit` toggle's `aria-controls`
 *  to the disclosed form (§11 / CF-7: every `aria-expanded` trigger names what it discloses). */
function editFormId(approvalId: string): string {
  return `sow-approval-edit-${approvalId}`;
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
}: {
  readonly approval: UiSafeApproval;
  readonly onDecide?: (approvalId: string, decision: ApprovalDecision) => Promise<ApprovalDecisionOutcome>;
}): ReactElement {
  const disabled = onDecide === undefined;
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
      className={`sow-approval-card${semantic ? " sow-approval-card--semantic" : ""}`}
      role="listitem"
      data-approval-id={approval.id}
      data-subject-kind={approval.subjectKind}
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
function SnoozedCard({ approval }: { readonly approval: UiSafeApproval }): ReactElement {
  const semantic = approval.subjectKind === "semantic_mutation";
  return (
    <li
      className={`sow-approval-card sow-approval-card--snoozed${semantic ? " sow-approval-card--semantic" : ""}`}
      role="listitem"
      data-approval-id={approval.id}
      data-subject-kind={approval.subjectKind}
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
  const { approvals, onDecide } = props;
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

      {empty ? (
        <div className="sow-empty" role="status">
          No pending approvals
        </div>
      ) : (
        <>
          {pending.length > 0 ? (
            <ul className="sow-approval-list" role="list" aria-label="Pending approvals">
              {pending.map((a) => (
                <PendingCard key={a.id} approval={a} onDecide={onDecide} />
              ))}
            </ul>
          ) : null}
          {snoozed.length > 0 ? (
            <div className="sow-approval-snoozed">
              <div className="sow-approval-section-label">Snoozed</div>
              <ul className="sow-approval-list" role="list" aria-label="Snoozed approvals">
                {snoozed.map((a) => (
                  <SnoozedCard key={a.id} approval={a} />
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}
