// @sow/integrations — Connector Gateway core read engine (§8, slice 6.1).
//
// `runConnectorSync(port, deps)` drives ONE sync pass over a `ConnectorPort` and
// enforces the Phase-6 load-bearing read invariant:
//
//   REQ-I-005 — NO SILENT DROP. The persisted cursor is advanced ONLY after the
//   consumer (`onRecords`) has SUCCESSFULLY handled that page's records. A
//   mid-stream consumer failure leaves the cursor at the last committed page
//   boundary, so the unprocessed page is re-fetched next pass — never skipped.
//
// Other rules (all fail-closed, never a silent success):
//   • Transient fetch errors ('unreachable'/'rate_limited') retry with bounded
//     backoff (`nextDelayMs`); on 'exhausted' the connector is marked DEGRADED and
//     an OBS-2 `GatewayHealthSignal` (connector_unreachable) is emitted.
//   • 'auth_locked' (Keychain locked) → DEGRADED, reads HELD retryable (cursor
//     unchanged, not retried in-pass — Keychain won't unlock synchronously).
//   • Reconnect drain is idempotent: a record whose `contentHash` is already
//     `seenContentHash` is dropped from the emit set (no double-emit).
//   • Every diagnostic is routed through foundation redaction
//     (`buildSafeConnectorLog`) — raw fetched payloads never reach a log sink.
//
// PURE-ADAPTER posture: no real transport, no `Date.now`, no `Math.random`. All
// effects are INJECTED (`port`, `cursors`, `onRecords`, `clock`, `logSink`,
// `seenContentHash`). Returns a typed `ConnectorSyncResult` — never throws (§16).
import type { Result } from "@sow/contracts";
import { isErr } from "@sow/contracts";
import type { ConnectorCursorRepository } from "../ports/persistence";
import { buildSafeConnectorLog } from "../redaction/gateway-log-redaction";
import type { SafeConnectorLog } from "../redaction/gateway-log-redaction";
import type { GatewayHealthSignal } from "../health/health-signal";
import { nextDelayMs, EXHAUSTED, type BackoffConfig } from "./backoff";
import { classifyConnectorError, type ConnectorHealth } from "./health";
import type { ConnectorPort, ConnectorRecord } from "./port";

/** The CLOSED consumer-side failure set `onRecords` may report (never thrown). */
export interface OnRecordsError {
  readonly code: "downstream_rejected" | "validation_failed" | "unknown";
  readonly message: string;
}

/**
 * Injected dependencies for one sync pass. `onRecords` is the downstream consumer
 * (e.g. the SourceEnvelope minter) — it returns a typed Result; a failure HOLDS
 * the cursor. `seenContentHash` (optional) makes reconnect drains idempotent.
 * `clock` supplies `updatedAt` for the persisted cursor. `logSink` (optional)
 * receives ONLY redaction-safe records.
 */
export interface ConnectorSyncDeps {
  readonly cursors: ConnectorCursorRepository;
  readonly workspaceId: string;
  readonly onRecords: (
    records: readonly ConnectorRecord[],
  ) => Promise<Result<void, OnRecordsError>>;
  readonly backoffCfg: BackoffConfig;
  readonly clock: () => string;
  readonly logSink?: (log: SafeConnectorLog) => void;
  readonly seenContentHash?: (contentHash: string) => Promise<boolean>;
}

/**
 * The typed outcome of a sync pass.
 *   • 'advanced' — every fetched page committed; cursor moved forward.
 *   • 'held'     — a consumer failure (or auth_locked) stopped the pass; cursor
 *                  unchanged past the last committed page (reads retried later).
 *   • 'degraded' — transient fetch errors exhausted retries; cursor unchanged, a
 *                  health signal emitted.
 * `cursor` is the persisted resume token after the pass (undefined if none).
 * `processed` counts records the consumer accepted. `health` is the reachability
 * verdict; `healthSignal` is present on a degraded outcome.
 */
export interface ConnectorSyncResult {
  readonly status: "advanced" | "held" | "degraded";
  readonly cursor?: string;
  readonly processed: number;
  readonly health: ConnectorHealth;
  readonly healthSignal?: GatewayHealthSignal;
}

// Codes that are transient (retry with bounded backoff).
const TRANSIENT: ReadonlySet<string> = new Set(["unreachable", "rate_limited"]);

export async function runConnectorSync(
  port: ConnectorPort,
  deps: ConnectorSyncDeps,
): Promise<ConnectorSyncResult> {
  const { cursors, workspaceId, onRecords, backoffCfg, clock, logSink } = deps;

  const emit = (log: SafeConnectorLog): void => {
    if (logSink) logSink(log);
  };

  // Resume from the persisted cursor (a miss is a fresh sync, not an error).
  const existing = await cursors.get(port.connectorId, workspaceId);
  let cursor: string | undefined = isErr(existing) ? undefined : existing.value.cursor;

  let processed = 0;

  // Drive pages until `done`, a hold, or a degrade.
  for (;;) {
    // --- fetch this page, retrying transient failures with bounded backoff ---
    let page: Awaited<ReturnType<ConnectorPort["fetch"]>> | undefined;
    for (let attempt = 1; ; attempt += 1) {
      const fetched = await port.fetch(cursor);
      if (!isErr(fetched)) {
        page = fetched;
        break;
      }
      const { health, signal } = classifyConnectorError(fetched.error, {
        connectorId: port.connectorId,
        workspaceId,
      });

      // auth_locked → held retryable: do NOT retry in-pass, do NOT advance.
      if (fetched.error.code === "auth_locked") {
        emit(
          buildSafeConnectorLog({
            connectorId: port.connectorId,
            workspaceId,
            status: "held_auth_locked",
            cursor,
            diagnostic: `${fetched.error.code}: ${fetched.error.message}`,
          }),
        );
        return { status: "held", cursor, processed, health };
      }

      // Transient → back off if attempts remain; else degrade (fail-closed).
      if (TRANSIENT.has(fetched.error.code)) {
        const delay = nextDelayMs(attempt, backoffCfg);
        if (delay !== EXHAUSTED) continue; // retry the same cursor
      }

      // Non-transient (malformed/unknown) OR exhausted transient → degraded.
      emit(
        buildSafeConnectorLog({
          connectorId: port.connectorId,
          workspaceId,
          status: "degraded",
          cursor,
          diagnostic: `${fetched.error.code}: ${fetched.error.message}`,
        }),
      );
      return {
        status: "degraded",
        cursor,
        processed,
        health,
        healthSignal: signal,
      };
    }

    // page is defined here (the loop only breaks on success).
    const current = page as NonNullable<typeof page> & { ok: true };
    const { records, nextCursor, done } = current.value;

    // --- dedupe reconnect-drain replays by contentHash ---
    const fresh: ConnectorRecord[] = [];
    for (const r of records) {
      const already = deps.seenContentHash ? await deps.seenContentHash(r.contentHash) : false;
      if (!already) fresh.push(r);
    }

    // --- hand the fresh records to the consumer; a failure HOLDS the cursor ---
    if (fresh.length > 0) {
      const handled = await onRecords(fresh);
      if (isErr(handled)) {
        emit(
          buildSafeConnectorLog({
            connectorId: port.connectorId,
            workspaceId,
            status: "held",
            cursor,
            diagnostic: `onRecords ${handled.error.code}: ${handled.error.message}`,
          }),
        );
        // NO SILENT DROP: cursor stays at the last committed boundary.
        return { status: "held", cursor, processed, health: "reachable" };
      }
      processed += fresh.length;
    }

    // --- commit succeeded → advance + persist the cursor for THIS page ---
    if (nextCursor !== undefined) {
      cursor = nextCursor;
      await cursors.upsert({
        connectorId: port.connectorId,
        workspaceId,
        cursor,
        status: done ? "idle" : "syncing",
        lastSyncAt: clock(),
        updatedAt: clock(),
      });
    }

    if (done) break;
  }

  return { status: "advanced", cursor, processed, health: "reachable" };
}
