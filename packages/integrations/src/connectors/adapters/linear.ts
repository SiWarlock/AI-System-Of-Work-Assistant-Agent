// @sow/integrations — Linear read connector + its real read-only GraphQL (POST) transport (§13.12).
//
// Read-only issue ingestion via Linear's GraphQL API. Auth is scoped to the least-privilege READ scope `read`
// — the connector never requests a write/mutate scope, and (load-bearing) sends ONLY a fixed query-only
// GraphQL document (never a mutation). Because the vendor is remote, a transport network failure is NOT a
// local throw: the shared `makeConnector` base collapses it to `ConnectorError{code:'unreachable'}` (§16).
//
// `createLinearHttpTransport` is the 6th instance of the reusable `createConnectorHttpTransport` template and
// the FIRST GraphQL-over-POST connector — it consumes the slice-1 optional POST method + `buildBody`. DORMANT:
// the real HttpTransport + SecretsAccessor + Linear token stay UNBOUND (a fake in tests); binding a real
// transport + the real token is the owner's arming crossing (real external network I/O = HARD LINE).
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

/** Build the Linear read connector over an injected (remote/GraphQL) transport. */
export function createLinearConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "linear", readScope: "read" }, transport);
}

// ── Linear issues real read-only GraphQL (POST) transport (candidate wire shape — arch_gap, Lesson 21) ───────
// CONTEXT7-GROUNDED (`/websites/linear_app_developers`, round-6 re-confirmed CONFORMANT):
//   POST https://api.linear.app/graphql ; body { query, variables } ; Relay pagination
//   issues(first, after) { nodes { id title updatedAt } pageInfo { hasNextPage endCursor } }.
// ⚠ READ-ONLY (ING-7, spec-level — the transport can't inspect an opaque GraphQL body): the connector sends
// ONLY the fixed `LINEAR_ISSUES_QUERY` — a `query`, NEVER a `mutation`/`subscription`. Do NOT change this to a
// body that can carry a mutation. Paging rides GraphQL `variables` (`first`/`after`), JSON.stringify-escaped —
// NEVER string-interpolated into the query (GraphQL-injection defense).
// GraphQL-200-ERRORS (Linear-specific, load-bearing): Linear returns HTTP 200 even on a query error
// (`{ errors: [...] }`), so the template's positive-2xx gate passes it — `linearMapPage` MUST fail-close on an
// `errors`-present / missing-`data` body (a query error is NOT a page; partial data alongside errors is dropped).
// AUTH arch_gap (arming residual — NOT this slice): the template hardcodes `Authorization: Bearer <token>`.
// Linear OAuth2 access tokens ARE Bearer-compatible (the candidate assumes an OAuth2 token). A Linear PERSONAL
// API KEY uses a RAW `Authorization: <key>` (no `Bearer`) — NOT template-compatible; supporting it needs a
// per-spec auth-scheme seam (an arming-era template touch), so a personal-key deployment is deferred to arming.

const LINEAR_BASE_URL = "https://api.linear.app";
const LINEAR_ALLOWED_HOSTS: readonly string[] = ["api.linear.app"];
const LINEAR_PAGE_SIZE = 50; // a conservative page size (Linear's max is higher) — single source for the query.

/**
 * The FIXED, query-only GraphQL document (read-only invariant — a `query`, NEVER a `mutation`/`subscription`).
 * `first`/`after` are GraphQL VARIABLES (not interpolated). Do not template a mutation into this string.
 */
const LINEAR_ISSUES_QUERY =
  "query Issues($first: Int!, $after: String) { issues(first: $first, after: $after) { nodes { id title updatedAt } pageInfo { hasNextPage endCursor } } }";

/**
 * Build the JSON POST body: the fixed query + the cursor as `variables.after` (null on the first page). Uses
 * `JSON.stringify` (NEVER string-interpolation) so a hostile/`"`-bearing cursor is escaped and can't inject
 * into the GraphQL query. Token-free (the secret rides only the Authorization header — rule 7).
 */
function linearBuildBody(request: TransportRequest): string {
  return JSON.stringify({
    query: LINEAR_ISSUES_QUERY,
    variables: { first: LINEAR_PAGE_SIZE, after: request.cursor ?? null },
  });
}

/**
 * The stable dedupe key (the 6.1 `contentHash`). Candidate (arch_gap): Linear's `updatedAt` is the change
 * token — hash `{ id, updatedAt }` so an edit advances the hash ⇒ re-emit; if `updatedAt` is absent, fall back
 * to hashing the raw node. Reuses the canonical replay-stable `payloadHash`.
 */
function linearContentHash(node: Record<string, unknown>, id: string): string {
  const updatedAt = node.updatedAt;
  if (typeof updatedAt === "string" && updatedAt.length > 0) {
    return payloadHash({ id, updatedAt });
  }
  return payloadHash(node);
}

/**
 * The next paging cursor, or undefined. STRICT (mirrors Granola): advance ONLY on `pageInfo.hasNextPage === true`
 * AND a non-empty `endCursor` string; every other state (hasNextPage non-`true`, endCursor null/absent/empty)
 * ⇒ undefined ⇒ `done` (fail-safe — only ever terminates early, never loops).
 */
function linearNextCursor(pageInfo: unknown): string | undefined {
  if (typeof pageInfo !== "object" || pageInfo === null) return undefined;
  const pi = pageInfo as { hasNextPage?: unknown; endCursor?: unknown };
  if (pi.hasNextPage !== true) return undefined;
  return typeof pi.endCursor === "string" && pi.endCursor.length > 0 ? pi.endCursor : undefined;
}

/** Map the candidate Linear GraphQL response → a `TransportPage`, fail-closed (incl. the GraphQL-200-error case). */
function linearMapPage(json: unknown): ConnectorTransportResult {
  if (typeof json !== "object" || json === null) {
    return transportFailure("unknown", "linear: response is not an object");
  }
  const env = json as { errors?: unknown; data?: unknown };
  // GraphQL returns HTTP 200 even on a query error — an `errors` array (even alongside partial data) is a fault.
  if (env.errors !== undefined && env.errors !== null) {
    return transportFailure("unknown", "linear: graphql errors present");
  }
  if (typeof env.data !== "object" || env.data === null) {
    return transportFailure("unknown", "linear: missing data");
  }
  const issues = (env.data as { issues?: unknown }).issues;
  if (typeof issues !== "object" || issues === null) {
    return transportFailure("unknown", "linear: missing data.issues");
  }
  const nodes = (issues as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) {
    return transportFailure("unknown", "linear: data.issues.nodes is not an array");
  }
  const items: TransportItem[] = [];
  for (const entry of nodes) {
    if (typeof entry !== "object" || entry === null) {
      return transportFailure("unknown", "linear: malformed issue node");
    }
    const node = entry as Record<string, unknown>;
    const id = node.id;
    if (typeof id !== "string" || id.length === 0) {
      return transportFailure("unknown", "linear: issue missing id");
    }
    items.push({ id, hash: linearContentHash(node, id), raw: entry });
  }
  const nextCursor = linearNextCursor((issues as { pageInfo?: unknown }).pageInfo);
  return {
    ok: true,
    items,
    done: nextCursor === undefined,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

/** The Linear connector-HTTP spec — a GraphQL-over-POST read (candidate wire shape — arch_gap). */
const LINEAR_HTTP_SPEC: ConnectorHttpSpec = {
  method: "POST",
  baseUrl: LINEAR_BASE_URL,
  allowedHosts: LINEAR_ALLOWED_HOSTS,
  resourcePath: "/graphql",
  buildQuery: () => "", // the query rides the POST body, not the url
  buildBody: linearBuildBody,
  mapPage: linearMapPage,
};

/**
 * Build the Linear read-only GraphQL (POST) transport. DORMANT — the real HttpTransport + SecretsAccessor +
 * Linear token stay UNBOUND (a fake in tests); binding a real transport + the real token is the owner's arming
 * crossing (HARD LINE). See the read-only / injection / GraphQL-200-error / auth notes above.
 */
export function createLinearHttpTransport(deps: ConnectorHttpTransportDeps): ConnectorTransport {
  return createConnectorHttpTransport(LINEAR_HTTP_SPEC, deps);
}
