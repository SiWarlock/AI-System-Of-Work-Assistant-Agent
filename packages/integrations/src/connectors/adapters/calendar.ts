// @sow/integrations — Google Calendar read connector + its real read-only HTTP transport (slice 6.3 · §13.12).
//
// Read-only calendar-event ingestion. Auth is scoped to the least-privilege READ scope `calendar.readonly` —
// the connector never requests write/mutate access. Mapping + fail-closed behavior come from the shared
// `makeConnector` base (§16 — never throws across the boundary).
//
// `createCalendarHttpTransport` is the 3rd instance of the reusable `createConnectorHttpTransport` template
// (Asana + Drive were 1st/2nd) — the SSRF-guard→token→GET→2xx-gate→map flow specialized with the Calendar
// spec. DORMANT: the real HttpTransport + OAuth-backed SecretsAccessor + `calendar.readonly` token stay UNBOUND
// (a fake in tests); binding a real transport + provisioning a real Google OAuth token is the owner's arming
// crossing (real external network I/O = HARD LINE). No real network / clock here.
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

/** Build the Calendar read connector over an injected transport. */
export function createCalendarConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "calendar", readScope: "calendar.readonly" }, transport);
}

// ── Google Calendar real read-only HTTP transport (candidate wire shape — arch_gap, Lesson 21) ───────────────
// The Calendar events.list envelope is a DOCUMENTED CANDIDATE — confirmed + corrected at the owner arming
// binding (we cannot RUN the real API now):
//   { kind, updated, nextPageToken?: string, nextSyncToken?: string, items: Event[] },  Event = { id, updated?, status?, … }
// Parsed FAIL-CLOSED: a missing / renamed field ⇒ a `TransportFailure`, never a false page.
// PAGING vs SYNC (candidate): paging uses `nextPageToken` ONLY — it is OMITTED on the LAST page, where
// `nextSyncToken` is present instead (mutually exclusive). `nextSyncToken` is the INCREMENTAL-SYNC token — an
// ARMING-era concern (a future incremental pass resumes from it), NOT the paging cursor; this read pass ignores
// it (done when `nextPageToken` is absent).
// `calendarId` = `primary` is a CANDIDATE default (in the resource path); a configurable calendarId is an
// arming-era refinement.
//
// OAuthTokenSource contract (DOCUMENTATION — the template is token-agnostic, NO code change): `tokenRef`
// resolves a Google OAuth ACCESS token (a bearer string). Refresh / expiry / rotation is ARMING-era behind the
// SecretsAccessor (an access token EXPIRES — never a static secret); a 401 → `auth_locked` is the dormant
// refresh signal. The OAuth app MUST be provisioned with ONLY `calendar.readonly` — a WRITE scope is FORBIDDEN
// (read-only-connector invariant).

const CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";
const CALENDAR_ALLOWED_HOSTS: readonly string[] = ["www.googleapis.com"];
// maxResults default 250, MAX 2500 (Calendar API) — a candidate page size well within the cap.
const CALENDAR_MAX_RESULTS = 250;

/**
 * Cursor→query (per-connector paging): `?maxResults=<n>&singleEvents=true` on the first page (expand recurring
 * events), `&pageToken=<cursor>` when resuming. The cursor is percent-encoded so tampered / persisted cursor
 * state can never inject a query param or smuggle an authority into the url (defense-in-depth — the template
 * also SSRF-guards the final url).
 */
function calendarBuildQuery(request: TransportRequest): string {
  const base = `?maxResults=${CALENDAR_MAX_RESULTS}&singleEvents=true`;
  return request.cursor !== undefined ? `${base}&pageToken=${encodeURIComponent(request.cursor)}` : base;
}

/**
 * The stable dedupe key (the 6.1 `contentHash`). Candidate (arch_gap): Calendar's `updated` (RFC3339) is the
 * change token — hash `{ id, updated }` so an edit advances the hash ⇒ re-emit; if `updated` is absent in the
 * real shape, fall back to hashing the raw event. Reuses the canonical replay-stable `payloadHash`.
 */
function calendarContentHash(event: Record<string, unknown>, id: string): string {
  const updated = event.updated;
  if (typeof updated === "string" && updated.length > 0) {
    return payloadHash({ id, updated });
  }
  return payloadHash(event);
}

/** Extract the candidate `nextPageToken` paging cursor (a well-formed non-empty string) or undefined. */
function calendarNextCursor(nextPageToken: unknown): string | undefined {
  return typeof nextPageToken === "string" && nextPageToken.length > 0 ? nextPageToken : undefined;
}

/** Map the candidate Calendar events.list envelope → a `TransportPage`, fail-closed on any malformed field. */
function calendarMapPage(json: unknown): ConnectorTransportResult {
  if (typeof json !== "object" || json === null) {
    return transportFailure("unknown", "calendar: response is not an envelope object");
  }
  const events = (json as { items?: unknown }).items;
  if (!Array.isArray(events)) {
    return transportFailure("unknown", "calendar: missing items[]");
  }
  const items: TransportItem[] = [];
  for (const entry of events) {
    if (typeof entry !== "object" || entry === null) {
      return transportFailure("unknown", "calendar: malformed event entry");
    }
    const event = entry as Record<string, unknown>;
    const id = event.id;
    if (typeof id !== "string" || id.length === 0) {
      return transportFailure("unknown", "calendar: event missing id");
    }
    items.push({ id, hash: calendarContentHash(event, id), raw: entry });
  }
  // Paging uses `nextPageToken` ONLY — `nextSyncToken` (present on the last page) is the arming-era incremental
  // sync token, NOT the paging cursor, so it is intentionally NOT consulted here.
  const nextCursor = calendarNextCursor((json as { nextPageToken?: unknown }).nextPageToken);
  return {
    ok: true,
    items,
    done: nextCursor === undefined,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

/** The Google Calendar connector-HTTP spec (candidate wire shape — arch_gap). */
const CALENDAR_HTTP_SPEC: ConnectorHttpSpec = {
  baseUrl: CALENDAR_BASE_URL,
  allowedHosts: CALENDAR_ALLOWED_HOSTS,
  resourcePath: "/calendars/primary/events",
  buildQuery: calendarBuildQuery,
  mapPage: calendarMapPage,
};

/**
 * Build the Calendar read-only HTTP transport. DORMANT — the real HttpTransport + OAuth-backed SecretsAccessor
 * + `calendar.readonly` token stay UNBOUND (a fake in tests); binding a real transport + provisioning a real
 * Google OAuth token is the owner's arming crossing (HARD LINE). See the OAuthTokenSource note above.
 */
export function createCalendarHttpTransport(deps: ConnectorHttpTransportDeps): ConnectorTransport {
  return createConnectorHttpTransport(CALENDAR_HTTP_SPEC, deps);
}
