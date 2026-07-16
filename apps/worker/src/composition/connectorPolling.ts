// Task 16.2 — connectorPoll registration + connectorSyncHealth schedule (worker composition, §19.3/§8/§9).
//
// Binds the poll driver's real `resolve()` seam: a `ConnectorTarget` → the 16.1 ComposedConnectors
// adapter (by connectorId) + the cursor repo + the 15.1 connector→ingestion bridge (`onRecords`) +
// backoff — everything `runConnectorSync` needs. Enumerates the ENABLED 14.2 connector instances as
// poll targets (EMPTY in the shipped default ⇒ a scheduled tick is inert: no fetch, no health). Also
// defines the connector-sync schedule config.
//
// DORMANT / NO hard line: the shipped default composes the INERT transport (16.1 — no real vendor
// call, no tokenRef) and polls ZERO connectors. Fail-closed by construction: an unknown connectorId
// resolves to an `unreachable` port (a loud degrade, never a silent no-op), and a target with no
// resolvable binding gets a fail-closed `onRecords` (holds its page, never a silent accept).
//
// PHASE-23 ARMING (Future TODOs — must land before a firing schedule; see Step-9 flags): (#1) the
// real DB-backed schedule bookkeeping + wakeDrain (the sandbox wrapper uses in-sandbox stubs now);
// (#2) the live `ScheduleClient.createSchedule` START; (#3) the connector-instance BINDING-METADATA
// seam (`ConnectorInstanceRow` lacks origin/type/sensitivity/kind, so `bridgeFor` returns undefined
// until then); (#4) real connector cursor persistence (the shipped default uses a dormant repo).
import { ok, err, type Result } from "@sow/contracts";
import type { ConnectorTarget } from "@sow/workflows";
import type {
  ConnectorPort,
  ConnectorSyncDeps,
  ConnectorError,
  ConnectorFetchPage,
  BackoffConfig,
  ConnectorCursorRepository,
  OnRecordsError,
} from "@sow/integrations";
import type { ConnectorInstanceRow } from "@sow/db";
import type { ComposedConnectors } from "./connectors";
import type { ConnectorIngestionBridge } from "./connectorIngestionBridge";

/** The per-connector-poll bounded-exponential backoff (the §8 gateway retry policy). */
export const CONNECTOR_POLL_BACKOFF: BackoffConfig = { baseMs: 1_000, maxMs: 30_000, maxAttempts: 5 };

/**
 * The connector-sync schedule config (LIFE-2 catch-up). DEFINED here + registered with the workflow;
 * the live `ScheduleClient.createSchedule` START is Phase-23 arming (TODO #2 — dormant until then).
 */
export const CONNECTOR_SYNC_SCHEDULE = {
  scheduleId: "connector-sync-health",
  intervalMs: 300_000, // 5 minutes
  catchUpWindowMs: 3_600_000, // 1 hour
} as const;

/**
 * Enumerate the ENABLED 14.2 connector instances as poll targets (WS-2 scoped). A paused instance is
 * excluded; the shipped default (no enabled instances) yields `[]` ⇒ a scheduled run polls nothing.
 * This is the dormancy-no-spam mechanism: an empty target set drives zero fetch + mints zero health.
 */
export function enumerateEnabledConnectorTargets(
  instances: readonly ConnectorInstanceRow[],
): ConnectorTarget[] {
  return instances
    .filter((row) => row.state === "enabled")
    .map((row) => ({ connectorId: row.connectorId, workspaceId: String(row.workspaceId) }));
}

/**
 * A fail-closed {@link ConnectorPort} — an unknown connectorId (no composed adapter) resolves to this,
 * so a poll DEGRADES loudly (a typed `unreachable`) rather than silently no-op'ing or reaching a real
 * vendor. Never throws (the resolve is called OUTSIDE the poll activity's try — it must be total).
 */
function unreachablePort(connectorId: string): ConnectorPort {
  return {
    connectorId,
    fetch: (): Promise<Result<ConnectorFetchPage, ConnectorError>> =>
      Promise.resolve(err({ code: "unreachable", message: `no composed adapter for connector ${connectorId}` })),
  };
}

/** A fail-closed `onRecords` — a target with no resolvable binding HOLDS its page (never a silent accept). */
function failClosedOnRecords(): Promise<Result<void, OnRecordsError>> {
  return Promise.resolve(err({ code: "downstream_rejected", message: "no connector-ingestion binding for target" }));
}

/** Deps for the poll resolve binding. */
export interface ConnectorPollResolveDeps {
  /** The 16.1 composed connector adapters (keyed by connectorId). */
  readonly connectors: ComposedConnectors;
  /** The connector sync-cursor repo (resume position; REQ-I-005). */
  readonly cursors: ConnectorCursorRepository;
  /** The bounded-exponential backoff policy. */
  readonly backoffCfg: BackoffConfig;
  /** The wall-clock reader (persisted-cursor `updatedAt`). */
  readonly clock: () => string;
  /** Build the 15.1 ingestion bridge (`onRecords`) for a target's instance binding; undefined ⇒ fail-closed. */
  readonly bridgeFor: (target: ConnectorTarget) => ConnectorIngestionBridge | undefined;
}

/**
 * Build the poll activity's `resolve()` — given a {@link ConnectorTarget}, return the concrete
 * {@link ConnectorPort} (from the 16.1 ComposedConnectors) + the per-pass {@link ConnectorSyncDeps}
 * (cursors + the 15.1 bridge's `onRecords` + backoff + clock, workspace-scoped WS-2). An unknown
 * connectorId ⇒ a fail-closed `unreachable` port; a target with no binding ⇒ fail-closed `onRecords`.
 *
 * TOTAL given TOTAL injected deps — `Map.get` never throws, and the shipped `dormantBridgeFor` is
 * total. `resolve` is called OUTSIDE the poll activity's try (`connectorPoll.ts`), so Phase-23's real
 * `bridgeFor` MUST also stay total (a throw would escape as an unhandled rejection, not a typed err).
 */
export function createConnectorPollResolve(
  deps: ConnectorPollResolveDeps,
): (target: ConnectorTarget) => { readonly port: ConnectorPort; readonly syncDeps: ConnectorSyncDeps } {
  return (target) => {
    const port = deps.connectors.ports.get(target.connectorId) ?? unreachablePort(target.connectorId);
    const bridge = deps.bridgeFor(target);
    // The bridge's `onRecords` is a standalone closure (no `this`) — pass it through directly as the
    // gateway's consumer seam (identity preserved; a target with no binding fails closed).
    const onRecords = bridge ? bridge.onRecords : failClosedOnRecords;
    const syncDeps: ConnectorSyncDeps = {
      cursors: deps.cursors,
      workspaceId: target.workspaceId,
      onRecords,
      backoffCfg: deps.backoffCfg,
      clock: deps.clock,
    };
    return { port, syncDeps };
  };
}

/**
 * A DORMANT connector cursor repo — the shipped-default binding (the poll set is empty, so it is never
 * exercised). Fail-closed both directions: a `get` reports no persisted cursor (a fresh sync) and an
 * `upsert` REJECTS (a dormant substrate must not claim a durable cursor write — Phase-23 TODO #4 binds
 * the REAL persistence; a false-durable stub must not survive into a firing schedule).
 */
export function createDormantConnectorCursorRepo(): ConnectorCursorRepository {
  // The `as unknown as` is DELIBERATE: this dormant repo implements only the two methods the poll
  // driver (`runConnectorSync`) calls — `get` (resume position) + `upsert` (advance) — both fail-closed.
  // The real 3-method repo (incl. `listByConnector`) is bound at Phase-23 (TODO #4); the driver never
  // calls `listByConnector`, so the omission is unreachable while dormant.
  return {
    get: () => Promise.resolve(err({ code: "not_found", message: "connector cursor persistence not bound (Phase 23)" })),
    upsert: () => Promise.resolve(err({ code: "unavailable", message: "connector cursor persistence not bound (Phase 23)" })),
  } as unknown as ConnectorCursorRepository;
}

/** The dormant-default `bridgeFor`: no binding-metadata seam yet (Phase-23 TODO #3) ⇒ always undefined ⇒ fail-closed. */
export function dormantBridgeFor(): undefined {
  return undefined;
}
