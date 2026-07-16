// @sow/integrations — the INJECTED connector-transport seam (slice 6.3).
//
// A concrete read adapter (calendar / todoist / linear / … ) NEVER talks to a real
// network. It is constructed with an injected `ConnectorTransport` — an async fn
// the adapter calls with a `TransportRequest` (cursor + the adapter's own
// LEAST-PRIVILEGE READ scope) and which returns a `ConnectorTransportResult`:
// either a raw page of `TransportItem`s or a typed transport failure. Tests inject
// a fake; production wires a real vendor/HTTP/MCP client here.
//
// The adapter's job (see `adapters/base.ts`) is to (a) hand the transport its read
// scope, (b) map a success page's `TransportItem[]` → `ConnectorRecord[]`, and
// (c) convert BOTH a typed transport failure AND a thrown transport rejection into
// a `ConnectorError { code:'unreachable' }` — so nothing throws across the 6.1
// `ConnectorPort` boundary (§16). Pure/clock-free: no `Date.now`, no randomness.

/**
 * One raw item as the transport delivers it. `id` → `ConnectorRecord.recordId`;
 * `hash` → the stable `contentHash` dedupe key; `raw` is the RAW fetched external
 * content, carried verbatim onto `ConnectorRecord.payload` (candidate data — the
 * GATEWAY/consumer redacts before logging, never the adapter).
 */
export interface TransportItem {
  readonly id: string;
  readonly hash: string;
  readonly raw: unknown;
}

/** A transport success: one raw page + the resume cursor + a `done` signal. */
export interface TransportPage {
  readonly ok: true;
  readonly items: readonly TransportItem[];
  readonly nextCursor?: string;
  readonly done: boolean;
  /**
   * COVERAGE-DEGRADE flag (16.4): the page is a SUCCESS but the underlying query did
   * NOT cover the full corpus (e.g. Drive's `incompleteSearch: true`) — the ingested set
   * is PARTIAL. The records are kept (fail-VISIBLE, never fail-closed); the gateway mints
   * a coverage-degrade health signal so a partial ingest is never mistaken for complete.
   * Absent ⇒ full coverage (byte-equivalent to a connector that never reports it).
   */
  readonly incompleteCoverage?: boolean;
}

/**
 * A typed transport failure (vendor/MCP/HTTP fault). `code` is informational for
 * the adapter; the adapter maps ANY transport failure to the 6.1 `unreachable`
 * branch (fail-closed — a remote read that could not complete is never a silent
 * success). `message` is a redaction-safe-by-convention diagnostic.
 */
export interface TransportFailure {
  readonly ok: false;
  readonly code: "unreachable" | "rate_limited" | "auth_locked" | "unknown";
  readonly message: string;
}

/** The transport's closed result: a raw page OR a typed failure (never throws — but the adapter defends anyway). */
export type ConnectorTransportResult = TransportPage | TransportFailure;

/**
 * The request an adapter hands its transport. `cursor` is the persisted resume
 * token (undefined = from the start). `readScope` is the adapter's declared
 * LEAST-PRIVILEGE READ scope — a read-only vendor scope string; the adapter never
 * requests a write/mutate scope (safety: connector reads are read-only).
 */
export interface TransportRequest {
  readonly cursor?: string;
  readonly readScope: string;
}

/**
 * The injected transport fn. Given a `TransportRequest`, returns a raw page or a
 * typed failure. May reject (a real network client can throw) — the adapter base
 * catches that and returns `unreachable`; a transport is NOT required to be
 * total. No clock/randomness in the adapter; those live behind this fn if needed.
 */
export type ConnectorTransport = (
  request: TransportRequest,
) => Promise<ConnectorTransportResult>;
