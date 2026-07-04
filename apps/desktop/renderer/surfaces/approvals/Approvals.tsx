// Approvals surface (§9.8, REQ-F-012) — the Approval Inbox that mounts inside the
// AppShell. A GLOBAL inbox of external-action approvals; the user approves / rejects /
// defers each with a single idempotent transition (Mac + Telegram parity is enforced
// server-side — this is the Mac channel).
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

import { type ReactElement } from "react";
import type { UiSafeApproval } from "@sow/contracts/api/ui-safe";
import type { ApprovalDecision } from "../../lib/approval-decision";

export interface ApprovalsProps {
  /** The GLOBAL approval inbox (all statuses; the surface filters to the actionable + snoozed views). */
  readonly approvals: readonly UiSafeApproval[];
  /**
   * Decide a pending approval (§9.8). Absent when there is no live worker → the action
   * buttons render DISABLED (a decision can't be issued offline). `edit` (with a payload
   * editor) is a deliberate follow-up — the three offered map to legal pending transitions.
   */
  readonly onDecide?: (approvalId: string, decision: ApprovalDecision) => void;
}

/** The three decisions offered on a pending item — each a legal `pending -> …` transition. */
const PENDING_DECISIONS: readonly { readonly decision: ApprovalDecision; readonly label: string }[] = [
  { decision: "approve", label: "Approve" },
  { decision: "reject", label: "Reject" },
  { decision: "defer", label: "Defer" },
];

/** The date portion of an ISO timestamp (deterministic; avoids locale/timezone drift). */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** A pending approval card — the action, its metadata, and the three decision buttons. */
function PendingCard({
  approval,
  onDecide,
}: {
  readonly approval: UiSafeApproval;
  readonly onDecide?: (approvalId: string, decision: ApprovalDecision) => void;
}): ReactElement {
  const disabled = onDecide === undefined;
  return (
    <li className="sow-approval-card" role="listitem" data-approval-id={approval.id}>
      <div className="sow-approval-head">
        <span className="sow-approval-action">{approval.actionRef}</span>
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
            onClick={() => onDecide?.(approval.id, d.decision)}
            title={disabled ? "Connect the worker to act on approvals" : undefined}
          >
            {d.label}
          </button>
        ))}
      </div>
    </li>
  );
}

/** A snoozed (deferred) approval card — DISPLAY-ONLY; it re-surfaces to pending on snooze expiry. */
function SnoozedCard({ approval }: { readonly approval: UiSafeApproval }): ReactElement {
  return (
    <li className="sow-approval-card sow-approval-card--snoozed" role="listitem" data-approval-id={approval.id}>
      <div className="sow-approval-head">
        <span className="sow-approval-action">{approval.actionRef}</span>
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
