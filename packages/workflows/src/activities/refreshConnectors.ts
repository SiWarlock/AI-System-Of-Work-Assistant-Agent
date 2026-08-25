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
        if (!result.ok) return err(result.error);
      }
      return ok({ refreshedConnectors: deps.connectorIds });
    },
  };
}
