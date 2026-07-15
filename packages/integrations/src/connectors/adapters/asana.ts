// @sow/integrations — Asana read connector + its real read-only HTTP transport (slice 6.3 · §13.12).
//
// Read-only task ingestion via Asana's REMOTE service. Auth is scoped to the least-privilege READ scope
// `tasks:read` — never a write/mutate scope. As a remote service, a transport network failure routes to the
// 6.1 unreachable branch via the shared `makeConnector` base, NOT a local throw.
//
// `createAsanaHttpTransport` is the first instance of the reusable `createConnectorHttpTransport` template —
// the SSRF-guard→token→GET→2xx-gate→map flow specialized with the Asana spec. DORMANT: the real HttpTransport
// + Asana PAT SecretsAccessor stay UNBOUND (a fake in tests); binding a real transport is the owner's arming
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

/** Build the Asana read connector over an injected (remote/HTTP) transport. */
export function createAsanaConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "asana", readScope: "tasks:read" }, transport);
}

// ── Asana real read-only HTTP transport (candidate wire shape — arch_gap, Lesson 21) ─────────────────────────
// The Asana REST list envelope is a DOCUMENTED CANDIDATE — confirmed + corrected at the owner arming binding
// (we cannot RUN the real API now):
//   { data: Task[], next_page?: { offset: string } | null },  Task = { gid: string, modified_at?: string, … }
// Parsed FAIL-CLOSED: a missing / renamed field ⇒ a `TransportFailure`, never a false page. Do NOT treat as
// final; a wrong shape yields a typed failure (degrade), never a silent success.

const ASANA_BASE_URL = "https://app.asana.com/api/1.0";
const ASANA_ALLOWED_HOSTS: readonly string[] = ["app.asana.com"];
const ASANA_PAGE_LIMIT = 100;

/**
 * Cursor→query (per-connector paging): `?limit=<n>` on the first page, `&offset=<cursor>` when resuming. The
 * cursor is percent-encoded so tampered / persisted cursor state can never inject a query param or smuggle an
 * authority into the url (defense-in-depth — the template also SSRF-guards the final url).
 */
function asanaBuildQuery(request: TransportRequest): string {
  const base = `?limit=${ASANA_PAGE_LIMIT}`;
  return request.cursor !== undefined ? `${base}&offset=${encodeURIComponent(request.cursor)}` : base;
}

/**
 * The stable dedupe key (the 6.1 `contentHash`). Candidate (arch_gap): Asana's `modified_at` is the change
 * token — hash `{ gid, modified_at }` so an edit advances the hash ⇒ re-emit; if `modified_at` is absent in
 * the real shape, fall back to hashing the raw task. Reuses the canonical replay-stable `payloadHash`
 * (key-order-safe SHA-256) — a connector never hand-rolls a hash.
 */
function asanaContentHash(task: Record<string, unknown>, gid: string): string {
  const modifiedAt = task.modified_at;
  if (typeof modifiedAt === "string" && modifiedAt.length > 0) {
    return payloadHash({ gid, modified_at: modifiedAt });
  }
  return payloadHash(task);
}

/**
 * Extract the candidate `next_page.offset` cursor (a well-formed non-empty string) or undefined. arch_gap
 * CANDIDATE DECISION (confirmed at arming): a present-but-offsetless `next_page` ({}, `{offset:""}`,
 * `{offset:123}`) is treated as DONE (returns undefined ⇒ `done:true`) rather than a `TransportFailure` — i.e.
 * the cursor axis fails toward STOP-paging, not toward error. The real Asana `next_page` shape is confirmed at
 * the arming binding; if a renamed/mistyped offset must instead surface as a failure (to avoid an under-read),
 * that flips here. `null`/absent `next_page` is Asana's genuine last-page signal ⇒ done.
 */
function extractAsanaOffset(nextPage: unknown): string | undefined {
  if (typeof nextPage !== "object" || nextPage === null) return undefined;
  const offset = (nextPage as { offset?: unknown }).offset;
  return typeof offset === "string" && offset.length > 0 ? offset : undefined;
}

/** Map the candidate Asana list envelope → a `TransportPage`, fail-closed on any malformed / renamed field. */
function asanaMapPage(json: unknown): ConnectorTransportResult {
  if (typeof json !== "object" || json === null) {
    return transportFailure("unknown", "asana: response is not an envelope object");
  }
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return transportFailure("unknown", "asana: missing data[]");
  }
  const items: TransportItem[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) {
      return transportFailure("unknown", "asana: malformed task entry");
    }
    const task = entry as Record<string, unknown>;
    const gid = task.gid;
    if (typeof gid !== "string" || gid.length === 0) {
      return transportFailure("unknown", "asana: task missing gid");
    }
    items.push({ id: gid, hash: asanaContentHash(task, gid), raw: entry });
  }
  const offset = extractAsanaOffset((json as { next_page?: unknown }).next_page);
  return {
    ok: true,
    items,
    done: offset === undefined,
    ...(offset !== undefined ? { nextCursor: offset } : {}),
  };
}

/** The Asana connector-HTTP spec (candidate wire shape — arch_gap). */
const ASANA_HTTP_SPEC: ConnectorHttpSpec = {
  baseUrl: ASANA_BASE_URL,
  allowedHosts: ASANA_ALLOWED_HOSTS,
  resourcePath: "/tasks",
  buildQuery: asanaBuildQuery,
  mapPage: asanaMapPage,
};

/**
 * Build the Asana read-only HTTP transport. DORMANT — the real HttpTransport + Asana PAT SecretsAccessor stay
 * UNBOUND (a fake in tests); binding a real transport is the owner's arming crossing (HARD LINE).
 */
export function createAsanaHttpTransport(deps: ConnectorHttpTransportDeps): ConnectorTransport {
  return createConnectorHttpTransport(ASANA_HTTP_SPEC, deps);
}
