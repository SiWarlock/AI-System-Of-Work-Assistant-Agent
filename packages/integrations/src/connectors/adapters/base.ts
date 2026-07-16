// @sow/integrations — the shared read-adapter base (slice 6.3).
//
// `makeConnector({ connectorId, readScope }, transport)` builds a `ConnectorPort`
// from an injected `ConnectorTransport`. It is the SINGLE place that enforces the
// three cross-adapter rules, so every concrete adapter (calendar / todoist / …) is
// a one-liner that just declares its id + least-privilege read scope:
//
//   1. LEAST-PRIVILEGE READ — the adapter's declared read-only `readScope` is what
//      the transport is handed (never a write/mutate scope).
//   2. RAW → ConnectorRecord — a transport page's `TransportItem[]` maps 1:1 to
//      `ConnectorRecord[]` (id/hash/raw preserved; `raw` is candidate data carried
//      verbatim on `payload`, redacted downstream, never here).
//   3. NEVER THROW across the 6.1 boundary (§16) — BOTH a typed transport failure
//      AND a thrown transport rejection collapse to `ConnectorError`
//      { code:'unreachable' } (fail-closed: a remote read that could not complete
//      is never a silent success). MCP/vendor connectors (linear/asana/granola)
//      are remote services, so this is their unreachable path too.
//
// PURE: no clock, no randomness, no real network — all effects are injected.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type { ConnectorFetchPage, ConnectorPort, ConnectorRecord, ConnectorError } from "../port";
import type { ConnectorTransport } from "../transport";

/** Static identity of a concrete adapter: its connector id + read-only scope. */
export interface ConnectorSpec {
  readonly connectorId: string;
  /** Least-privilege READ scope handed to the transport (never a write scope). */
  readonly readScope: string;
}

/** Map one raw transport item to a `ConnectorRecord` (raw carried verbatim on payload). */
function toRecord(item: { readonly id: string; readonly hash: string; readonly raw: unknown }): ConnectorRecord {
  return { recordId: item.id, contentHash: item.hash, payload: item.raw };
}

// A typed unreachable error (fail-closed default for every transport fault).
function unreachable(message: string): ConnectorError {
  return { code: "unreachable", message };
}

/**
 * Build a `ConnectorPort` from a spec + an injected transport. The returned
 * `fetch(cursor?)` hands the transport the spec's read scope, maps a success page
 * to `ConnectorRecord[]`, and fail-closes any transport failure/throw to
 * `unreachable` — never rejecting across the boundary.
 */
export function makeConnector(spec: ConnectorSpec, transport: ConnectorTransport): ConnectorPort {
  return {
    connectorId: spec.connectorId,
    async fetch(cursor?: string): Promise<Result<ConnectorFetchPage, ConnectorError>> {
      let result;
      try {
        result = await transport({ cursor, readScope: spec.readScope });
      } catch (e) {
        // A thrown transport rejection (a real network client can throw) is caught
        // here — the boundary stays typed (§16), never a propagated exception.
        return err(unreachable(e instanceof Error ? e.message : "transport threw"));
      }
      if (!result.ok) {
        // A typed transport failure → the 6.1 unreachable branch (fail-closed).
        return err(unreachable(`${result.code}: ${result.message}`));
      }
      const page: ConnectorFetchPage = {
        records: result.items.map(toRecord),
        ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
        done: result.done,
        // Thread the coverage-degrade flag through unchanged (16.4) — a partial page's
        // records are still mapped + kept; the gateway raises the health signal.
        ...(result.incompleteCoverage ? { incompleteCoverage: true } : {}),
      };
      return ok(page);
    },
  };
}
