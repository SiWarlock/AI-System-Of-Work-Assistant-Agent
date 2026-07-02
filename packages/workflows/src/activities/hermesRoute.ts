// @sow/workflows — slice 7.18 ACTIVITY: route a Hermes-initiated automation to a
// workspace/target (inv-1 / REQ-F-002 / WS-2).
//
// This is an ACTIVITY, NOT workflow code — it runs worker-side and MAY use adapters
// (the automation-definition resolver + the workspace router over the automation's
// declared target + trigger evidence), but takes ALL its effects INJECTED so it is
// Vitest-unit-testable with fakes and never touches a real network in the module. It
// implements {@link HermesRoutePort}.
//
// SAFETY (inv-1 / RT-7): Hermes MAY initiate an automation, but it NEVER guesses a
// workspace to write into. Only a signal set whose confidence CLEARS the injected
// threshold AND carries a concrete resolved workspace binds it (a `high`
// HermesRouteOutcome — WS-2: the workspace is bound before any durable write).
// ANYTHING sub-threshold, OR at/above threshold but with NO resolved workspace, fails
// closed to a `low` outcome (routingReview:true, no bound workspace at all — the
// driver folds it to routing_failed). A router/source FAILURE is a distinct typed
// HermesRouteError. There is NO Hermes-direct write here — this activity only routes.
//
// §16: returns a typed Result — never throws across the activity boundary.
import { ok, err } from "@sow/contracts";
import type { Result, WorkspaceId } from "@sow/contracts";
import type {
  HermesRoutePort,
  HermesRouteError,
  HermesRouteOutcome,
  HermesAutomationContext,
} from "../workflows/hermesAutomation";

/**
 * The raw routing signals the injected resolver produces from the automation's
 * declared target + trigger evidence. `confidence` is a 0..1 score; `workspaceId` /
 * `projectId` are the BEST-GUESS bindings — they are only ADOPTED when confidence
 * clears the threshold (else discarded; never guessed).
 */
export interface HermesRouteSignals {
  readonly confidence: number;
  readonly workspaceId?: WorkspaceId;
  readonly projectId?: string;
  /** Optional human-facing reason attached to a low-confidence fail-closed route. */
  readonly reason?: string;
}

/**
 * Injected deps for the Hermes-route activity: the resolver SOURCE (returns a typed
 * Result, never throws) and the confidence THRESHOLD a binding must clear (inv-1).
 * The default threshold is a conservative 0.7.
 */
export interface HermesRouteActivityDeps {
  readonly resolve: (
    ctx: HermesAutomationContext,
  ) => Promise<Result<HermesRouteSignals, HermesRouteError>>;
  readonly threshold?: number;
}

const DEFAULT_THRESHOLD = 0.7;

/**
 * Build a {@link HermesRoutePort} over the injected resolver (inv-1 / WS-2). A binding
 * is adopted ONLY when confidence clears the threshold AND a concrete workspace was
 * resolved; otherwise the outcome is a low-confidence fail-closed route with NO bound
 * workspace (the driver folds it to routing_failed — never auto-routes). Never throws.
 */
export function createHermesRouteActivity(
  deps: HermesRouteActivityDeps,
): HermesRoutePort {
  const threshold = deps.threshold ?? DEFAULT_THRESHOLD;
  return {
    async route(
      ctx: HermesAutomationContext,
    ): Promise<Result<HermesRouteOutcome, HermesRouteError>> {
      const resolved = await deps.resolve(ctx);
      if (!resolved.ok) {
        return err(resolved.error);
      }
      const signals = resolved.value;
      // HIGH: threshold cleared AND a concrete workspace was resolved (WS-2 bind).
      if (signals.confidence >= threshold && signals.workspaceId !== undefined) {
        const outcome: HermesRouteOutcome = {
          confidence: "high",
          workspaceId: signals.workspaceId,
          ...(signals.projectId !== undefined ? { projectId: signals.projectId } : {}),
        };
        return ok(outcome);
      }
      // LOW (inv-1): sub-threshold OR no resolved workspace → fail closed. NO
      // workspaceId is carried at all — the union forbids reading one.
      const outcome: HermesRouteOutcome = {
        confidence: "low",
        routingReview: true,
        ...(signals.reason !== undefined ? { reason: signals.reason } : {}),
      };
      return ok(outcome);
    },
  };
}
