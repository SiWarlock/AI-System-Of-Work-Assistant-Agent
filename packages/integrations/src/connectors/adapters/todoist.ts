// @sow/integrations — Todoist read connector + its real read-only HTTP transport (slice 6.3 · §21.3).
//
// Read-only task ingestion. Auth is scoped to the least-privilege READ scope `data:read` — the connector
// never requests Todoist write access. The injected `ConnectorTransport` performs the fetch; no real network /
// clock here. Mapping + fail-closed unreachable behavior come from the shared `makeConnector` base (§16).
//
// `createTodoistHttpTransport` specializes the reusable `createConnectorHttpTransport` template (the
// SSRF-guard → token → GET → Number.isInteger-2xx-gate → JSON → map flow) with the Todoist wire shape. DORMANT:
// the real HttpTransport + Todoist token SecretsAccessor stay UNBOUND (a fake in tests); binding a real
// transport is the owner's §ARM-23 arming crossing (real external network I/O = HARD LINE).
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

/** Build the Todoist read connector over an injected transport. */
export function createTodoistConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "todoist", readScope: "data:read" }, transport);
}

// ── Todoist real read-only HTTP transport (candidate wire shape — arch_gap, Lesson 21) ───────────────────────
// CONTEXT7-GROUNDED (`/websites/developer_todoist_api_v1` — the CURRENT UNIFIED v1 API; the brief's legacy
// `/rest/v2/tasks` bare array is superseded): `GET https://api.todoist.com/api/v1/tasks` (Bearer) is a
// DOCUMENTED CANDIDATE, re-confirmed at the owner arming binding:
//   { results: Task[], next_cursor: string | null },  Task = { id: string, content: string, updated_at?: string, … }
// Cursor-paginated (limit 0..200): `next_cursor` (string) ⇒ another page; null/absent ⇒ done. Parsed
// FAIL-CLOSED: a missing / renamed field or a non-string id ⇒ a `TransportFailure`, never a false page.
const TODOIST_BASE_URL = "https://api.todoist.com/api/v1";
const TODOIST_ALLOWED_HOSTS: readonly string[] = ["api.todoist.com"];
const TODOIST_PAGE_LIMIT = 100; // Context7: limit 0..200 (default 50).

/**
 * Cursor→query: `?limit=<n>` on the first page, `&cursor=<token>` when resuming. The cursor (Todoist's opaque
 * `next_cursor` token) is percent-encoded so a tampered / persisted cursor can never inject a query param or
 * smuggle an authority into the url (defense-in-depth — the template also SSRF-guards the final url).
 */
function todoistBuildQuery(request: TransportRequest): string {
  const base = `?limit=${TODOIST_PAGE_LIMIT}`;
  return request.cursor !== undefined ? `${base}&cursor=${encodeURIComponent(request.cursor)}` : base;
}

/**
 * The stable dedupe key (the 6.1 `contentHash`). Candidate (arch_gap): Todoist's `updated_at` is the change
 * token — hash `{ id, updated_at }` so an edit advances the hash ⇒ re-emit; if `updated_at` is absent in the
 * real shape, fall back to hashing the raw task. Reuses the canonical replay-stable `payloadHash`
 * (key-order-safe SHA-256) — a connector never hand-rolls a hash.
 */
function todoistContentHash(task: Record<string, unknown>, id: string): string {
  const updatedAt = task.updated_at;
  if (typeof updatedAt === "string" && updatedAt.length > 0) {
    return payloadHash({ id, updated_at: updatedAt });
  }
  return payloadHash(task);
}

/** Extract the candidate `next_cursor` (a well-formed non-empty string) or undefined (⇒ done). `null`/absent is
 *  Todoist's genuine last-page signal. */
function extractTodoistCursor(nextCursor: unknown): string | undefined {
  return typeof nextCursor === "string" && nextCursor.length > 0 ? nextCursor : undefined;
}

/** Map the candidate Todoist v1 list envelope → a `TransportPage`, fail-closed on any malformed / renamed field. */
function todoistMapPage(json: unknown): ConnectorTransportResult {
  if (typeof json !== "object" || json === null) {
    return transportFailure("unknown", "todoist: response is not an envelope object");
  }
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return transportFailure("unknown", "todoist: missing results[]");
  }
  const items: TransportItem[] = [];
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null) {
      return transportFailure("unknown", "todoist: malformed task entry");
    }
    const task = entry as Record<string, unknown>;
    const id = task.id;
    if (typeof id !== "string" || id.length === 0) {
      return transportFailure("unknown", "todoist: task missing id");
    }
    items.push({ id, hash: todoistContentHash(task, id), raw: entry });
  }
  const cursor = extractTodoistCursor((json as { next_cursor?: unknown }).next_cursor);
  return {
    ok: true,
    items,
    done: cursor === undefined,
    ...(cursor !== undefined ? { nextCursor: cursor } : {}),
  };
}

/** The Todoist connector-HTTP spec (candidate wire shape — arch_gap). */
const TODOIST_HTTP_SPEC: ConnectorHttpSpec = {
  baseUrl: TODOIST_BASE_URL,
  allowedHosts: TODOIST_ALLOWED_HOSTS,
  resourcePath: "/tasks",
  buildQuery: todoistBuildQuery,
  mapPage: todoistMapPage,
};

/**
 * Build the Todoist read-only HTTP transport. DORMANT — the real HttpTransport + Todoist token SecretsAccessor
 * stay UNBOUND (a fake in tests); binding a real transport is the owner's §ARM-23 arming crossing (HARD LINE).
 */
export function createTodoistHttpTransport(deps: ConnectorHttpTransportDeps): ConnectorTransport {
  return createConnectorHttpTransport(TODOIST_HTTP_SPEC, deps);
}
