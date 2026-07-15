// @sow/integrations — Gmail messages LIST-ONLY read connector + its real read-only HTTP transport (§13.12).
//
// Read-only email-message ingestion via Gmail's users.messages.list. Auth is scoped to the least-privilege
// READ scope `gmail.readonly` — the connector NEVER requests a send/modify/compose scope. Mapping + fail-closed
// behavior come from the shared `makeConnector` base (§16).
//
// `createGmailHttpTransport` is the 7th instance of the reusable `createConnectorHttpTransport` template — a GET
// body-cursor connector (like Drive/Calendar; the `nextPageToken` rides the response body). DORMANT: the real
// HttpTransport + OAuth-backed SecretsAccessor + `gmail.readonly` token stay UNBOUND (a fake in tests); binding
// a real transport + a real token is the owner's arming crossing (real external network I/O = HARD LINE).
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

/** Build the Gmail read connector over an injected transport. `gmail.readonly` scope ONLY. */
export function createGmailConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "gmail", readScope: "gmail.readonly" }, transport);
}

// ── Gmail messages LIST-ONLY read transport (candidate wire shape — arch_gap, Lesson 21) ─────────────────────
// CONTEXT7-GROUNDED (`/websites/developers_google_workspace_gmail_api`, round-7 re-confirmed CONFORMANT):
//   GET /gmail/v1/users/me/messages ; response { messages?: [{ id, threadId }], nextPageToken?, resultSizeEstimate }.
// Parsed FAIL-CLOSED: a non-object body / a PRESENT non-array `messages` / a malformed message / a missing `id`
// ⇒ a `TransportFailure`. The empty-inbox / empty-page shape OMITS `messages` entirely — an ABSENT `messages` is
// an EMPTY page (`items: []`), NOT a failure (distinct from a present non-array). `done` is driven by the
// `nextPageToken` cursor, NOT `items.length` (an empty filtered page WITH a token keeps paginating).
//
// ⚠ LIST-ONLY (lead ruling — a NAMED deferral, NOT a silent drop): `messages.list` returns id-level refs
// (`{id, threadId}`) ONLY — message content requires a `messages.get` per id (a FAN-OUT with real design
// questions: batching, rate-limit backoff across N gets, partial-failure semantics), so detail-HYDRATION is an
// arming residual + a candidate FUTURE round (likely reusable beyond Gmail). ⚠ ING-7: when hydration lands,
// email content is UNTRUSTED external content ⇒ ING-7 tool-stripping applies HARD (any agent consuming it runs
// read-only, no mutating tools). Do NOT let a future hydration step forget this.
// AUTH: an OAuth2 access token (Bearer) — the template's bearer-string SecretsAccessor verbatim; refresh/expiry
// is an arming residual (like Drive/Calendar). ARMING residuals: minimal-scope `gmail.readonly` token; the
// `q`/`labelIds`/`includeSpamTrash` filters + the legacy `www.googleapis.com/gmail/v1` host alt.

const GMAIL_BASE_URL = "https://gmail.googleapis.com";
const GMAIL_ALLOWED_HOSTS: readonly string[] = ["gmail.googleapis.com"];
const GMAIL_PAGE_SIZE = 100; // Context7: maxResults default 100, max 500 — a conservative page size.

/**
 * Cursor→query (per-connector paging): `?maxResults=<n>` on the first page, `&pageToken=<cursor>` when resuming.
 * The cursor is percent-encoded so tampered / persisted cursor state can never inject a query param or smuggle
 * an authority into the url (defense-in-depth — the template also SSRF-guards the final url).
 */
function gmailBuildQuery(request: TransportRequest): string {
  const base = `?maxResults=${GMAIL_PAGE_SIZE}`;
  return request.cursor !== undefined ? `${base}&pageToken=${encodeURIComponent(request.cursor)}` : base;
}

/**
 * The stable dedupe key (the 6.1 `contentHash`). LIST-ONLY: `messages.list` returns immutable id-refs (no
 * content, no updated-timestamp), so hash `{ id, threadId }` (both immutable) — a message dedupes to a single
 * emission. A content-derived change token arrives with the detail-hydration step (arming). Reuses the
 * canonical replay-stable `payloadHash`.
 */
function gmailContentHash(msg: Record<string, unknown>, id: string): string {
  const threadId = msg.threadId;
  if (typeof threadId === "string" && threadId.length > 0) {
    return payloadHash({ id, threadId });
  }
  return payloadHash({ id });
}

/** Extract the candidate `nextPageToken` body cursor (a well-formed non-empty string) or undefined. */
function gmailNextCursor(nextPageToken: unknown): string | undefined {
  return typeof nextPageToken === "string" && nextPageToken.length > 0 ? nextPageToken : undefined;
}

/** Map the candidate Gmail messages.list envelope → a `TransportPage`, fail-closed (absent `messages` = empty). */
function gmailMapPage(json: unknown): ConnectorTransportResult {
  // The envelope must be a plain object — reject null / non-object / a bare array (a top-level array is NOT the
  // messages.list envelope, and must not be misread as an object with an absent `messages`).
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return transportFailure("unknown", "gmail: response is not an envelope object");
  }
  const env = json as { messages?: unknown; nextPageToken?: unknown };
  const messages = env.messages;
  // ABSENT `messages` (empty inbox / empty page) ⇒ an empty page; a PRESENT non-array ⇒ fail-closed.
  if (messages !== undefined && !Array.isArray(messages)) {
    return transportFailure("unknown", "gmail: messages is not an array");
  }
  const list: readonly unknown[] = Array.isArray(messages) ? messages : [];
  const items: TransportItem[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) {
      return transportFailure("unknown", "gmail: malformed message entry");
    }
    const msg = entry as Record<string, unknown>;
    const id = msg.id;
    if (typeof id !== "string" || id.length === 0) {
      return transportFailure("unknown", "gmail: message missing id");
    }
    items.push({ id, hash: gmailContentHash(msg, id), raw: entry });
  }
  // `done` is driven by the cursor, NOT items.length — an empty filtered page WITH a token keeps paginating.
  const nextCursor = gmailNextCursor(env.nextPageToken);
  return {
    ok: true,
    items,
    done: nextCursor === undefined,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

/** The Gmail connector-HTTP spec (candidate wire shape — arch_gap; method defaults GET). */
const GMAIL_HTTP_SPEC: ConnectorHttpSpec = {
  baseUrl: GMAIL_BASE_URL,
  allowedHosts: GMAIL_ALLOWED_HOSTS,
  resourcePath: "/gmail/v1/users/me/messages",
  buildQuery: gmailBuildQuery,
  mapPage: gmailMapPage,
};

/**
 * Build the Gmail read-only HTTP transport. DORMANT — the real HttpTransport + OAuth-backed SecretsAccessor +
 * `gmail.readonly` token stay UNBOUND (a fake in tests); binding a real transport + a real token is the owner's
 * arming crossing (HARD LINE). See the LIST-ONLY / ING-7 / auth notes above.
 */
export function createGmailHttpTransport(deps: ConnectorHttpTransportDeps): ConnectorTransport {
  return createConnectorHttpTransport(GMAIL_HTTP_SPEC, deps);
}
