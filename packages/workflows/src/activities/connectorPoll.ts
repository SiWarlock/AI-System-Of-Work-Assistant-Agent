// @sow/workflows — slice 7.15 ACTIVITY: poll ONE connector through the §8 Connector
// Gateway (`runConnectorSync`) and project its outcome onto the driver-facing
// {@link ConnectorPollResult}.
//
// This is an ACTIVITY, NOT workflow code — it runs worker-side and MAY bind real
// adapters (the concrete ConnectorPort + the P2 ConnectorCursorRepository + a wall
// clock). It implements {@link ConnectorPollPort}. The pure driver
// (src/workflows/connectorSyncHealth.ts) NEVER imports the gateway or a real
// transport; it only RECEIVES the typed poll result from this seam. Tested with
// injected fakes (no real transport).
//
// THE LOAD-BEARING PIN (REQ-I-005 / the bug-class prior verify passes caught): the
// {@link ConnectorPollResult} this activity returns is projected DIRECTLY from the
// ACTUAL `ConnectorSyncResult` the gateway produced — `status`, `cursor`, `processed`
// come straight from the gateway's verdict, and `cursorAdvanced` is derived from the
// gateway `status === 'advanced'` (the ONLY status on which the gateway advanced +
// persisted the cursor). So the driver's degraded/queue branch reads the real
// reachability outcome that actually flowed through the cursor advance — never a decoy
// descriptor field. The activity NEVER fabricates an `advanced` on a held/degraded
// pass, and NEVER advances a cursor the gateway did not advance.
//
// §16: returns a typed Result — never throws. A gateway crash (the async call
// rejecting) is caught and folded to a typed {@link ConnectorPollError}.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { runConnectorSync } from "@sow/integrations";
import type {
  ConnectorPort,
  ConnectorSyncDeps,
  ConnectorSyncResult,
} from "@sow/integrations";
import type {
  ConnectorPollPort,
  ConnectorPollResult,
  ConnectorPollError,
  ConnectorTarget,
} from "../workflows/connectorSyncHealth";

/**
 * Resolve the concrete {@link ConnectorPort} + the per-pass {@link ConnectorSyncDeps}
 * for a given target. Injected so the activity binds the real connector adapter +
 * cursor repo + consumer (`onRecords`) + backoff at the worker edge, while tests pass
 * fakes. `port` is the transport seam; `syncDeps` carries `cursors`/`onRecords`/
 * `backoffCfg`/`clock` — everything `runConnectorSync` needs. `workspaceId` on the
 * `syncDeps` MUST equal the target's workspaceId (WS-2 — the sync is workspace-scoped).
 */
export interface ConnectorPollActivityDeps {
  readonly resolve: (
    connector: ConnectorTarget,
  ) => { readonly port: ConnectorPort; readonly syncDeps: ConnectorSyncDeps };
}

/**
 * Project the gateway's {@link ConnectorSyncResult} onto the driver-facing
 * {@link ConnectorPollResult}. PURE. `cursorAdvanced` is derived from
 * `status === 'advanced'` (REQ-I-005: the only status on which the gateway advanced +
 * persisted the cursor) — never fabricated. `healthReason` is carried ONLY on a
 * held/degraded pass (from the redaction-safe §8 health signal message), so a raw
 * fetched payload never rides along.
 */
export function projectSyncResult(
  connectorId: string,
  result: ConnectorSyncResult,
): ConnectorPollResult {
  const base: ConnectorPollResult = {
    connectorId,
    status: result.status,
    processed: result.processed,
    // The gateway advanced + persisted the cursor ONLY on 'advanced' — mirror that
    // exactly (never claim a cursor advance the gateway did not make).
    cursorAdvanced: result.status === "advanced",
    ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
  };
  if (result.status === "advanced") {
    return base;
  }
  // Held/degraded: carry the redaction-safe reason for the driver's degraded surface.
  const reason = result.healthSignal?.message ?? `connector ${result.status}`;
  return { ...base, healthReason: reason };
}

/**
 * Build a {@link ConnectorPollPort} that drives the §8 Connector Gateway per
 * connector. It resolves the concrete port + sync deps, runs ONE sync pass
 * (`runConnectorSync` — which advances the cursor ONLY after a page's records are
 * successfully processed, REQ-I-005), and projects the outcome. A gateway-level
 * rejection (the async call throwing — the gateway itself never throws by contract,
 * but a real adapter binding might) is folded to a typed `poll_failed`. Never throws.
 */
export function createConnectorPollActivity(
  deps: ConnectorPollActivityDeps,
): ConnectorPollPort {
  return {
    async poll(
      connector: ConnectorTarget,
    ): Promise<Result<ConnectorPollResult, ConnectorPollError>> {
      const { port, syncDeps } = deps.resolve(connector);
      try {
        const result = await runConnectorSync(port, syncDeps);
        return ok(projectSyncResult(connector.connectorId, result));
      } catch (cause) {
        return err<ConnectorPollError>({
          code: "poll_failed",
          message: `connector ${connector.connectorId} sync pass failed`,
          cause,
        });
      }
    },
  };
}
