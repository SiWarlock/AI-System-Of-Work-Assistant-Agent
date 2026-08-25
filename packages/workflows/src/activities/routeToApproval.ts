// @sow/workflows — task 25.4 (PKG-W3) ACTIVITY: implement {@link
// RouteToApprovalPort} — record a shared/invite/external scheduling change in
// the 7.9 Approval Inbox INSTEAD of auto-applying it. NEVER performs the write
// itself (fail-closed): the external write happens only later, after human
// approval, on the 7.9 approval-flow.
//
// This is an ACTIVITY, NOT workflow code — it dispatches through an injected
// pending-record gateway (the same 7.9 seam `approvalTransition.ts`'s
// `RecordPendingGateway` targets; kept narrow/local here rather than pulling the
// full RecordPendingActivityDeps bundle, since this port's inputs are just
// action+envelope — no ApprovalFlowContext to build). IDEMPOTENT by the
// envelope's idempotencyKey: a re-drive returns `created:false`, never a second
// card. Never throws.
import { ok, err } from "@sow/contracts";
import type { ExternalWriteEnvelope, ProposedAction, Result } from "@sow/contracts";
import type {
  RouteToApprovalPort,
  RouteToApprovalResult,
  RouteToApprovalError,
} from "../ports/crossCalendarScheduling";

/**
 * The injected pending-record gateway: reserves the action+envelope as a pending
 * Approval card. Idempotent by the envelope's `idempotencyKey` (a re-drive
 * returns `created:false`, no second card/audit). Returns a typed failure —
 * NEVER performs the actual external write (that happens only after approval).
 */
export interface PendingApprovalGateway {
  reservePending(
    action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<{ approvalRef: string; created: boolean }, RouteToApprovalError>>;
}

/** Injected deps for the route-to-approval activity. */
export interface RouteToApprovalActivityDeps {
  readonly gateway: PendingApprovalGateway;
}

/**
 * Build a {@link RouteToApprovalPort} over the injected pending-approval
 * gateway. Never dispatches the external write itself. Never throws.
 */
export function createRouteToApprovalActivity(
  deps: RouteToApprovalActivityDeps,
): RouteToApprovalPort {
  return {
    async route(
      action: ProposedAction,
      env: ExternalWriteEnvelope,
    ): Promise<Result<RouteToApprovalResult, RouteToApprovalError>> {
      const reserved = await deps.gateway.reservePending(action, env);
      if (!reserved.ok) return err(reserved.error);
      return ok(reserved.value);
    },
  };
}
