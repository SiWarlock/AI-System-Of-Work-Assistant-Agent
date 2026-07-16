// @sow/integrations — the ConnectorPort seam (§8 Connector Gateway reads).
//
// The narrow inbound-read contract every concrete connector (slice 6.3: todoist,
// linear, drive, github, calendar, telegram, asana) implements. The Connector
// Gateway (slice 6.1 `runConnectorSync`) drives an implementation of this port; it
// NEVER touches a real transport itself. A connector returns a typed
// `Result<ConnectorFetchPage, ConnectorError>` — it does NOT throw across this
// boundary (§16 error convention); the failure set is a CLOSED enum so the gateway
// can classify reachability deterministically.
//
// `payload` on a `ConnectorRecord` is the RAW fetched external content — it is
// candidate data and MUST be run through foundation redaction before it reaches
// any log sink (safety rule 5 / §16). The gateway never logs it.
import type { Result } from "@sow/contracts";

/**
 * One page of fetched records plus the cursor to resume AFTER this page. `done`
 * signals the connector has no more pages this pass. `nextCursor` is the opaque
 * resume token the gateway persists — ONLY after the page's records commit.
 */
export interface ConnectorFetchPage {
  readonly records: readonly ConnectorRecord[];
  readonly nextCursor?: string;
  readonly done: boolean;
  /**
   * COVERAGE-DEGRADE flag (16.4): the fetched page is a SUCCESS but the query did NOT
   * cover the full corpus (partial ingest). The gateway surfaces a coverage-degrade health
   * signal WITHOUT dropping the records (fail-VISIBLE). Absent ⇒ full coverage.
   */
  readonly incompleteCoverage?: boolean;
}

/**
 * One fetched record. `contentHash` is the stable dedupe key (a `seenContentHash`
 * hit → the record is a replayed drain, not re-emitted). `payload` is the RAW
 * fetched content — candidate data, redact before logging, never persisted here.
 */
export interface ConnectorRecord {
  readonly recordId: string;
  readonly contentHash: string;
  /** Raw fetched external content — redact before logging (safety rule 5). */
  readonly payload: unknown;
}

/**
 * The CLOSED connector-read failure set. `unreachable`/`rate_limited` are
 * transient (retry with bounded backoff). `auth_locked` is a held-retryable
 * Keychain lock (reads held, never dropped). `malformed`/`unknown` are fail-closed
 * (treated unreachable — never silently succeed on an unexpected shape).
 */
export interface ConnectorError {
  readonly code: "unreachable" | "auth_locked" | "rate_limited" | "malformed" | "unknown";
  readonly message: string;
}

/**
 * The inbound-read seam a concrete connector implements. `fetch(cursor?)` returns
 * one page or a typed error — NEVER throws. The gateway calls it with the
 * persisted cursor (undefined = from the start) and advances the cursor only after
 * the page commits.
 */
export interface ConnectorPort {
  readonly connectorId: string;
  fetch(cursor?: string): Promise<Result<ConnectorFetchPage, ConnectorError>>;
}
