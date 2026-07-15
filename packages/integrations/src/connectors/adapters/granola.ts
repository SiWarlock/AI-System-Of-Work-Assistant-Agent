// @sow/integrations — Granola meeting-notes read connector + its real read-only HTTP transport (§13.12).
//
// Read-only meeting-notes ingestion via Granola's public HTTP API (`public-api.granola.ai`). Auth is a STATIC
// Bearer API key (`grn_…`) — no OAuth, no refresh (the simplest connector). The declared least-privilege READ
// scope `meetings:read` is informational (the granted scope of the provisioned key); the connector never
// requests write access. Mapping + fail-closed behavior come from the shared `makeConnector` base (§16).
//
// `createGranolaHttpTransport` is the 4th instance of the reusable `createConnectorHttpTransport` template
// (Asana/Drive/Calendar) — the SSRF-guard→token→GET→2xx-gate→map flow specialized with the Granola spec.
// DORMANT: the real HttpTransport + SecretsAccessor + `grn_` key stay UNBOUND (a fake in tests); binding a
// real transport + the real key is the owner's arming crossing (real external network I/O = HARD LINE).
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

/** Build the Granola read connector over an injected transport. */
export function createGranolaConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "granola", readScope: "meetings:read" }, transport);
}

// ── Granola real read-only HTTP transport (candidate wire shape — arch_gap, Lesson 21) ───────────────────────
// CONTEXT7-GROUNDED (`/websites/granola_ai`, OpenAPI 3.1 — GET /v1/notes; round-4 re-confirmed CONFORMANT):
//   ListNotesOutput { notes: NoteSummary[], hasMore: boolean, cursor: string | null },
//   NoteSummary { id: `not_[a-zA-Z0-9]{14}`, object: "note", title, owner, created_at, updated_at }.
// Parsed FAIL-CLOSED: a missing / renamed field ⇒ a `TransportFailure`, never a false page.
// PAGINATION (STRICT, load-bearing): advance ONLY on `hasMore === true` (strict — a truthy-non-`true` value
// must NOT drive an infinite page loop; worker Lesson-28 class) AND a non-empty `cursor` string; anything else
// (hasMore false/absent/non-boolean, cursor null/absent/empty) fail-closes to `done` (the changelog's last-page
// shape returns `hasMore:false` with `cursor` OMITTED, so null and absent are handled uniformly).
// AUTH: a STATIC `grn_` Bearer API key (Context7 `ApiKeyAuth {http, bearer, apiKey}`) — the template's
// bearer-string SecretsAccessor verbatim (no OAuth / refresh). RATE LIMITS: 25 burst / 5 rps → 429
// (`rate_limited`); backoff/retry SCHEDULING is arming-era (not built here). 401 (invalid key) → `auth_locked`.
// ARMING residual: provision the `grn_` key with MINIMAL scope; a filter (created_after/updated_after/folder_id)
// is an arming-era refinement.

const GRANOLA_BASE_URL = "https://public-api.granola.ai";
const GRANOLA_ALLOWED_HOSTS: readonly string[] = ["public-api.granola.ai"];
const GRANOLA_PAGE_SIZE = 30; // Context7: page_size is int 1..30 (default 10); 30 is the vendor MAX (>30 ⇒ 400).

/**
 * Cursor→query (per-connector paging): `?page_size=<n≤30>` on the first page, `&cursor=<cursor>` when resuming.
 * The cursor (Granola's opaque continuation token) is percent-encoded so tampered / persisted cursor state can
 * never inject a query param or smuggle an authority into the url (defense-in-depth — the template also
 * SSRF-guards the final url).
 */
function granolaBuildQuery(request: TransportRequest): string {
  const base = `?page_size=${GRANOLA_PAGE_SIZE}`;
  return request.cursor !== undefined ? `${base}&cursor=${encodeURIComponent(request.cursor)}` : base;
}

/**
 * The stable dedupe key (the 6.1 `contentHash`). Candidate (arch_gap): Granola's `updated_at` (date-time) is
 * the change token — hash `{ id, updated_at }` so an edit advances the hash ⇒ re-emit; if `updated_at` is
 * absent in the real shape, fall back to hashing the raw note. Reuses the canonical replay-stable `payloadHash`.
 */
function granolaContentHash(note: Record<string, unknown>, id: string): string {
  const updatedAt = note.updated_at;
  if (typeof updatedAt === "string" && updatedAt.length > 0) {
    return payloadHash({ id, updated_at: updatedAt });
  }
  return payloadHash(note);
}

/**
 * The next paging cursor, or undefined. Advances ONLY on a STRICT `hasMore === true` AND a non-empty `cursor`
 * string — every other state (hasMore non-`true`, cursor null/absent/empty) yields undefined ⇒ `done`. This is
 * fail-safe: it only ever terminates early, never loops on an invalid/ambiguous envelope.
 */
function granolaNextCursor(hasMore: unknown, cursor: unknown): string | undefined {
  if (hasMore !== true) return undefined; // STRICT — a truthy-non-`true` value must not drive a page loop.
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

/** Map the candidate Granola `ListNotesOutput` → a `TransportPage`, fail-closed on any malformed field. */
function granolaMapPage(json: unknown): ConnectorTransportResult {
  if (typeof json !== "object" || json === null) {
    return transportFailure("unknown", "granola: response is not an envelope object");
  }
  const notes = (json as { notes?: unknown }).notes;
  if (!Array.isArray(notes)) {
    return transportFailure("unknown", "granola: missing notes[]");
  }
  const items: TransportItem[] = [];
  for (const entry of notes) {
    if (typeof entry !== "object" || entry === null) {
      return transportFailure("unknown", "granola: malformed note entry");
    }
    const note = entry as Record<string, unknown>;
    const id = note.id;
    if (typeof id !== "string" || id.length === 0) {
      return transportFailure("unknown", "granola: note missing id");
    }
    items.push({ id, hash: granolaContentHash(note, id), raw: entry });
  }
  const env = json as { hasMore?: unknown; cursor?: unknown };
  const nextCursor = granolaNextCursor(env.hasMore, env.cursor);
  return {
    ok: true,
    items,
    done: nextCursor === undefined,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

/** The Granola connector-HTTP spec (candidate wire shape — arch_gap). */
const GRANOLA_HTTP_SPEC: ConnectorHttpSpec = {
  baseUrl: GRANOLA_BASE_URL,
  allowedHosts: GRANOLA_ALLOWED_HOSTS,
  resourcePath: "/v1/notes",
  buildQuery: granolaBuildQuery,
  mapPage: granolaMapPage,
};

/**
 * Build the Granola read-only HTTP transport. DORMANT — the real HttpTransport + SecretsAccessor + `grn_` key
 * stay UNBOUND (a fake in tests); binding a real transport + the real key is the owner's arming crossing
 * (HARD LINE). See the wire-shape / auth / rate-limit notes above.
 */
export function createGranolaHttpTransport(deps: ConnectorHttpTransportDeps): ConnectorTransport {
  return createConnectorHttpTransport(GRANOLA_HTTP_SPEC, deps);
}
