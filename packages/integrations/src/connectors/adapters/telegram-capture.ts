// @sow/integrations — Telegram capture read connector + its real read-only HTTP transport (slice 6.3 · §21.3).
//
// Read-only inbound-message capture (the ingest side of the Telegram channel; the approval/notify WRITE side is
// the Tool Gateway `telegram` target, a SEPARATE path — untouched). Auth is scoped to the least-privilege READ
// scope `messages:read` — never a send/write scope. The injected `ConnectorTransport` performs the fetch; no
// real network / clock here. Fail-closed behavior from the shared base (§16). Captured message content is
// candidate data — redacted downstream.
//
// `createTelegramCaptureHttpTransport` specializes the reusable `createConnectorHttpTransport` template with the
// Telegram Bot API `getUpdates` wire shape. ⚠ Unlike the Bearer-header connectors, the Telegram token rides the
// URL PATH (`/bot<token>/getUpdates`) — the template's `pathAuth` mode injects it into the path (validated
// against a safe-path allowlist, never logged, rule 7). DORMANT: the real HttpTransport + Telegram token stay
// UNBOUND (a fake in tests); binding a real transport is the owner's §ARM-23 arming crossing (HARD LINE).
import { makeConnector } from "./base";
import {
  createConnectorHttpTransport,
  transportFailure,
  type ConnectorHttpSpec,
  type ConnectorHttpTransportDeps,
} from "./http-transport";
import type { ConnectorPort } from "../port";
import type { ConnectorTransport, ConnectorTransportResult, TransportItem, TransportRequest } from "../transport";
import { payloadHash } from "../../hash/payload-hash";

/** Build the Telegram capture read connector over an injected transport. */
export function createTelegramCaptureConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "telegram-capture", readScope: "messages:read" }, transport);
}

// ── Telegram Bot API getUpdates read-only transport (candidate wire shape — arch_gap, Lesson 21) ─────────────
// CONTEXT7-GROUNDED (`/websites/core_telegram_bots_api` — `getUpdates`): a DOCUMENTED CANDIDATE, re-confirmed at
// the owner arming binding. `GET https://api.telegram.org/bot<TOKEN>/getUpdates?offset=&limit=` (token IN PATH,
// no Bearer header — the template's `pathAuth` mode); envelope:
//   { ok: true, result: Update[] },  Update = { update_id: number, message?: {…}, … }
// Offset long-poll: the client advances `offset = max(update_id) + 1` until an empty batch (Telegram returns NO
// `next_cursor`). Parsed FAIL-CLOSED: `ok !== true` / missing `result` / a non-number `update_id` ⇒ a
// `TransportFailure`, never a false page. Updates are emitted TYPE-AGNOSTIC (one item per Update, raw preserved)
// — the connector never interprets/filters; the downstream extraction filters by type (emit-only, rule 1).
const TELEGRAM_BASE_URL = "https://api.telegram.org";
const TELEGRAM_ALLOWED_HOSTS: readonly string[] = ["api.telegram.org"];
const TELEGRAM_RESOURCE_PATH = "/bot{token}/getUpdates"; // pathAuth: `{token}` substituted by the template
const TELEGRAM_PAGE_LIMIT = 100; // Context7: limit 1..100.

/**
 * Cursor→query: `?limit=<n>` on the first poll, `&offset=<cursor>` when resuming (the client-computed
 * `max(update_id)+1`). The cursor is percent-encoded so a tampered / persisted cursor can never inject a query
 * param or smuggle an authority (defense-in-depth — the template also SSRF-guards the final url).
 */
function telegramBuildQuery(request: TransportRequest): string {
  const base = `?limit=${TELEGRAM_PAGE_LIMIT}`;
  return request.cursor !== undefined ? `${base}&offset=${encodeURIComponent(request.cursor)}` : base;
}

/** Map the candidate `getUpdates` envelope → a `TransportPage`, fail-closed on any malformed / renamed field. */
function telegramMapPage(json: unknown): ConnectorTransportResult {
  if (typeof json !== "object" || json === null) {
    return transportFailure("unknown", "telegram: response is not an envelope object");
  }
  if ((json as { ok?: unknown }).ok !== true) {
    return transportFailure("unknown", "telegram: envelope ok is not true");
  }
  const result = (json as { result?: unknown }).result;
  if (!Array.isArray(result)) {
    return transportFailure("unknown", "telegram: missing result[]");
  }
  const items: TransportItem[] = [];
  let maxUpdateId = -1;
  for (const entry of result) {
    if (typeof entry !== "object" || entry === null) {
      return transportFailure("unknown", "telegram: malformed update entry");
    }
    const updateId = (entry as { update_id?: unknown }).update_id;
    if (typeof updateId !== "number" || !Number.isFinite(updateId)) {
      return transportFailure("unknown", "telegram: update missing update_id");
    }
    if (updateId > maxUpdateId) maxUpdateId = updateId;
    // The change token IS update_id (unique + monotonic per bot; an edit is a distinct update_id).
    items.push({ id: String(updateId), hash: payloadHash({ update_id: updateId }), raw: entry });
  }
  // Telegram returns no `next_cursor`: advance `offset = max(update_id)+1` until an empty batch ⇒ done.
  if (items.length === 0) {
    return { ok: true, items: [], done: true };
  }
  return { ok: true, items, done: false, nextCursor: String(maxUpdateId + 1) };
}

/** The Telegram connector-HTTP spec (candidate wire shape — arch_gap). Token-in-PATH via `pathAuth`. */
const TELEGRAM_HTTP_SPEC: ConnectorHttpSpec = {
  baseUrl: TELEGRAM_BASE_URL,
  allowedHosts: TELEGRAM_ALLOWED_HOSTS,
  resourcePath: TELEGRAM_RESOURCE_PATH,
  buildQuery: telegramBuildQuery,
  mapPage: telegramMapPage,
  pathAuth: true,
};

/**
 * Build the Telegram capture read-only HTTP transport. DORMANT — the real HttpTransport + Telegram token
 * SecretsAccessor stay UNBOUND (a fake in tests); binding a real transport is the owner's §ARM-23 arming
 * crossing (HARD LINE).
 */
export function createTelegramCaptureHttpTransport(deps: ConnectorHttpTransportDeps): ConnectorTransport {
  return createConnectorHttpTransport(TELEGRAM_HTTP_SPEC, deps);
}
