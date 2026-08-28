// @sow/workflows — task 25.2 (PKG-W3) ACTIVITY: a GENERIC connector-refresh
// activity, reused across dailyBrief + periodReview's RefreshConnectorsPort /
// ReviewRefreshConnectorsPort (structurally identical:
// `refresh(ctx): Promise<Result<{refreshedConnectors: string[]}, {code:
// "connector_unreachable"|"connector_stale", message, cause?}>>`; `ctx` is never
// read by this activity, so one core is generic over it).
//
// This is an ACTIVITY, NOT workflow code. It advances each configured
// connector's cursor through the injected {@link ConnectorRefresher} (the real
// implementation wraps the Connector Gateway's `runConnectorSync`/cursor store —
// out of this package's territory, injected). A SINGLE unreachable/stale
// connector fails the WHOLE refresh closed (fail-fast, matching the daily-brief
// driver's "a stale/unreachable connector folds to connector_stale" contract —
// a partial refresh is never silently treated as fresh). Never throws.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";

export type RefreshConnectorsCode = "connector_unreachable" | "connector_stale";

export interface ConnectorRefreshError {
  readonly code: RefreshConnectorsCode;
  readonly message: string;
  readonly cause?: unknown;
}

/** The injected per-connector refresher (the real Connector Gateway advance). */
export interface ConnectorRefresher {
  refresh(connectorId: string): Promise<Result<void, ConnectorRefreshError>>;
}

/** Injected deps: the bound connector ids to refresh + the refresher. */
export interface RefreshConnectorsActivityDeps {
  readonly connectorIds: readonly string[];
  readonly refresher: ConnectorRefresher;
}

/**
 * SAFETY RULE 7 — redact an injected {@link ConnectorRefresher}'s failure before it crosses the
 * activity boundary. `refresher` wraps the Connector Gateway (out of this package's territory), so
 * neither `cause` nor `message` can be established safe: `cause` may be a raw provider error object,
 * and `message` may embed connector-formatted detail (auth/URL/cursor text). Once this activity is
 * registered as a real Temporal activity (task 25.1), either would land durably in workflow history.
 * Mirrors `commitFailureToVariant` (apps/worker/src/api/procedures/semanticMutationDispatch.ts:203):
 * switch on the closed `code`, build a FRESH literal — never read `.cause`, never forward `.message`.
 * The `code` itself crosses byte-identically (every consumer switches on it).
 *
 * `connectorId` DOES cross, unlike `.cause`/`.message`: it is the caller-supplied,
 * workspace-configured identifier this activity already iterates over (`deps.connectorIds`),
 * never adapter/vendor content. With several connectors configured, a fixed message
 * naming only the failure class (no id) leaves the operator unable to tell WHICH
 * connector needs re-auth/reconnecting — the id is what makes this diagnostic
 * actionable rather than merely safe.
 */
function redactConnectorRefreshError(
  connectorId: string,
  error: ConnectorRefreshError,
): ConnectorRefreshError {
  switch (error.code) {
    case "connector_unreachable":
      return {
        code: "connector_unreachable",
        message: `connector refresh: ${connectorId} unreachable`,
      };
    case "connector_stale":
      return { code: "connector_stale", message: `connector refresh: ${connectorId} stale` };
  }
}

/**
 * Build a generic `{refresh(ctx): Promise<Result<{refreshedConnectors}, ConnectorRefreshError>>}`
 * activity. `ctx` is accepted but never read (both families' contexts already
 * carry the workspace/brain binding the ports operate over; the connector SET is
 * a boot-time configuration, not derived per-call). Never throws.
 */
export function createRefreshConnectorsActivity(deps: RefreshConnectorsActivityDeps): {
  refresh(ctx: unknown): Promise<Result<{ readonly refreshedConnectors: readonly string[] }, ConnectorRefreshError>>;
} {
  return {
    async refresh(_ctx: unknown) {
      for (const id of deps.connectorIds) {
        const result = await deps.refresher.refresh(id);
        if (!result.ok) return err(redactConnectorRefreshError(id, result.error));
      }
      return ok({ refreshedConnectors: deps.connectorIds });
    },
  };
}
