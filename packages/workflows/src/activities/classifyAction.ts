// @sow/workflows — task 25.4 (PKG-W3) ACTIVITY: implement {@link
// ClassifyActionPort} by delegating to @sow/policy `requiresApproval` (REQ-F-012).
//
// This is an ACTIVITY, NOT workflow code — it MAY use the real @sow/policy
// predicate. The activity's own job is narrow: resolve the organizer workspace's
// policy (an injected, synchronous lookup — mirrors gclProjectionGate.ts's
// WorkspaceLookup; workspace posture is boot-resolved, not per-call I/O) and fold
// `requiresApproval`'s verdict onto the closed {@link SchedulingRoute} the driver
// reads. `auto_create` is emitted ONLY when the REAL predicate says
// `requiresApproval: false` — a private, policy-allowed personal calendar action
// (the SOLE Flow-3 auto-create path); every other verdict (shared/invite/
// external/ambiguous/unresolvable-workspace) folds to `route_to_approval` or a
// typed `classify_failed` (which the driver ALSO routes to approval — fail-closed
// under uncertainty, never auto-apply).
//
// §16: never throws. Never returns `auto_create` on anything but a genuine
// ALLOW({requiresApproval:false}) from the real predicate.
import { ok, err } from "@sow/contracts";
import type { ProposedAction, Result, WorkspaceId } from "@sow/contracts";
import { requiresApproval, isDeny } from "@sow/policy";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import type {
  ClassifyActionPort,
  ClassifyActionError,
  SchedulingRoute,
} from "../ports/crossCalendarScheduling";

/** Resolve the organizer workspace's flat policy view (boot-resolved, sync). */
export interface WorkspacePolicyLookup {
  (workspaceId: WorkspaceId): ResolvedWorkspacePolicy | undefined;
}

/** Injected deps for the classify-action activity. */
export interface ClassifyActionActivityDeps {
  readonly resolvePolicy: WorkspacePolicyLookup;
}

/**
 * Build a {@link ClassifyActionPort} over the real @sow/policy `requiresApproval`
 * predicate. An unresolvable organizer workspace, or a malformed-action DENY from
 * the predicate, folds to `classify_failed` — the driver treats BOTH a
 * `classify_failed` err AND an `ok("route_to_approval")` identically: fail-closed
 * to the Approval Inbox, never auto-create. Never throws.
 */
export function createClassifyActionActivity(
  deps: ClassifyActionActivityDeps,
): ClassifyActionPort {
  return {
    async classify(
      action: ProposedAction,
      organizerWorkspaceId: WorkspaceId,
    ): Promise<Result<SchedulingRoute, ClassifyActionError>> {
      const resolved = deps.resolvePolicy(organizerWorkspaceId);
      if (resolved === undefined) {
        return err({
          code: "classify_failed",
          message: `no resolved policy for workspace ${String(organizerWorkspaceId)} — fail-closed`,
        });
      }
      const decision = requiresApproval(action, resolved);
      if (isDeny(decision)) {
        return err({ code: "classify_failed", message: decision.message });
      }
      const route: SchedulingRoute = decision.value.requiresApproval
        ? "route_to_approval"
        : "auto_create";
      return ok(route);
    },
  };
}
