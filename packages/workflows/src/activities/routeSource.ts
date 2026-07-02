// @sow/workflows — slice 7.7 ACTIVITY: classify + route a registered source to a
// workspace/project (inv-1 / REQ-F-002 / WS-2).
//
// This is an ACTIVITY, NOT workflow code — it runs worker-side and MAY use adapters
// (the router / classifier over the source's routingHints + workspace/history
// evidence), but takes ALL its effects INJECTED so it is Vitest-unit-testable with
// fakes and never touches a real network in the module. It implements
// {@link RouteSourcePort}.
//
// SAFETY (inv-1): the router NEVER auto-routes / guesses a workspace. Only a signal
// set whose confidence CLEARS the injected threshold AND carries a concrete resolved
// workspace binds it (a `high` RouteOutcome — WS-2: the workspace is bound before any
// durable write). ANYTHING sub-threshold, OR at/above threshold but with NO resolved
// workspace, parks in the Ingestion Inbox (a `low` outcome carrying
// `queuedForReview:true`, no bound workspace at all). A router/source FAILURE is a
// distinct typed RouteError.
//
// §16: returns a typed Result — never throws across the activity boundary.
import { ok, err } from "@sow/contracts";
import type { Result, WorkspaceId } from "@sow/contracts";
import type {
  RouteSourcePort,
  RouteError,
  RouteOutcome,
  SourceIngestionContext,
} from "../ports/sourceIngestion";

/**
 * The raw routing signals the injected classifier resolves from the source's
 * routingHints + workspace/history evidence. `confidence` is a 0..1 score;
 * `workspaceId` / `projectId` / `disposition` are the BEST-GUESS bindings — they are
 * only ADOPTED when confidence clears the threshold (else discarded; never guessed).
 */
export interface RouteSignals {
  readonly confidence: number;
  readonly workspaceId?: WorkspaceId;
  readonly projectId?: string;
  readonly disposition?: string;
  /** Optional human-facing reason attached to a low-confidence Ingestion-Inbox park. */
  readonly reason?: string;
}

/**
 * Injected deps for the route activity: the classifier SOURCE (returns a typed
 * Result, never throws) and the confidence THRESHOLD a binding must clear (inv-1).
 * Default threshold is a conservative 0.7.
 */
export interface RouteSourceActivityDeps {
  readonly classify: (
    ctx: SourceIngestionContext,
  ) => Promise<Result<RouteSignals, RouteError>>;
  readonly threshold?: number;
}

const DEFAULT_THRESHOLD = 0.7;

/**
 * Build a {@link RouteSourcePort} over the injected classifier (inv-1 / WS-2). A
 * binding is adopted ONLY when confidence clears the threshold AND a concrete
 * workspace was resolved; otherwise the outcome is a low-confidence Ingestion-Inbox
 * park with NO bound workspace (never auto-routes). Never throws.
 */
export function createRouteSourceActivity(
  deps: RouteSourceActivityDeps,
): RouteSourcePort {
  const threshold = deps.threshold ?? DEFAULT_THRESHOLD;
  return {
    async route(
      ctx: SourceIngestionContext,
    ): Promise<Result<RouteOutcome, RouteError>> {
      const resolved = await deps.classify(ctx);
      if (!resolved.ok) {
        return err(resolved.error);
      }
      const signals = resolved.value;
      // HIGH: threshold cleared AND a concrete workspace was resolved (WS-2 bind).
      if (signals.confidence >= threshold && signals.workspaceId !== undefined) {
        const outcome: RouteOutcome = {
          confidence: "high",
          workspaceId: signals.workspaceId,
          ...(signals.projectId !== undefined ? { projectId: signals.projectId } : {}),
          ...(signals.disposition !== undefined ? { disposition: signals.disposition } : {}),
        };
        return ok(outcome);
      }
      // LOW (inv-1): sub-threshold OR no resolved workspace → park in the Ingestion
      // Inbox. NO workspaceId is carried at all — the union forbids reading one.
      const outcome: RouteOutcome = {
        confidence: "low",
        queuedForReview: true,
        ...(signals.reason !== undefined ? { reason: signals.reason } : {}),
      };
      return ok(outcome);
    },
  };
}
