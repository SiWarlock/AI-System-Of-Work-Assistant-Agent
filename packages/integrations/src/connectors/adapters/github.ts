// @sow/integrations — GitHub read connector + its real read-only HTTP transport (slice 6.3 · §13.12).
//
// Read-only repo/issue/PR ingestion via the GitHub REST API. Auth is scoped to the least-privilege READ scope
// `repo:read` — the connector never requests write/admin access (the GitHub WRITE path is the Tool Gateway,
// not this read connector). Mapping + fail-closed behavior come from the shared `makeConnector` base (§16).
//
// `createGithubHttpTransport` is the 5th instance of the reusable `createConnectorHttpTransport` template
// (Asana/Drive/Calendar/Granola) — and the FIRST page-number paginator. DORMANT: the real HttpTransport +
// SecretsAccessor + PAT stay UNBOUND (a fake in tests); binding a real transport + the real token is the
// owner's arming crossing (real external network I/O = HARD LINE). No real network / clock here.
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

/** Build the GitHub read connector over an injected transport. */
export function createGithubConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "github", readScope: "repo:read" }, transport);
}

// ── GitHub issues real read-only HTTP transport (candidate wire shape — arch_gap, Lesson 21) ─────────────────
// CONTEXT7-GROUNDED (`/websites/github_en_rest`, GET /issues — round-5 re-confirmed CONFORMANT):
//   response = a BARE JSON array of issue objects (NO envelope, NO in-body cursor);
//   Issue = { id: int, node_id: string, number, state, title, updated_at, [pull_request?] }.
// Parsed FAIL-CLOSED: a non-array body / a malformed entry / a missing `node_id` ⇒ a `TransportFailure`.
// PAGINATION (page-number, load-bearing): GitHub paginates by `?per_page&page` + a Link header — NOT an in-body
// token — so the mapper computes the next page from the request cursor (the widened `mapPage(json, request)`
// seam). `done = json.length < GITHUB_PER_PAGE` (a short page is terminal — mirrors the Link `rel=next`-absent
// signal without needing headers); an exact-full final page costs one extra empty fetch (fail-safe, never a
// false "more"). `per_page` is single-sourced with the `done` comparison (a drift would wedge paging at page 1).
// recordId = `node_id` (the stable, globally-unique STRING id; GitHub `id` is an int). PRs appear in this feed
// (tagged `pull_request`) and are INGESTED (candidate scope is repo/issue/PR); filtering is an arming refinement.
// AUTH: a static Bearer PAT (fine-grained/classic) — the template's bearer-string SecretsAccessor verbatim (no
// OAuth). FAULTS: 401 (bad auth) / 403 (can mean primary rate-limit) → `auth_locked`; 429 → `rate_limited`
// (diagnostic-only — the base collapses all to `unreachable`); `X-RateLimit`/`Retry-After` backoff is arming-era.
// ARMING residuals: provision the PAT with MINIMAL scope; `since`/`labels`/`filter` filters + PR-exclusion.

const GITHUB_BASE_URL = "https://api.github.com";
const GITHUB_ALLOWED_HOSTS: readonly string[] = ["api.github.com"];
const GITHUB_PER_PAGE = 100; // Context7: per_page max 100 (default 30). Single source for buildQuery + `done`.

/**
 * Parse the cursor as a positive page integer. Our own cursors are always `String(n)` (a plain positive
 * decimal), so ONLY a `^[1-9][0-9]*$` string is accepted; anything else — non-numeric, leading zero, sign,
 * decimal/scientific/hex notation (`"1e2"`, `"0x10"`), whitespace, out-of-safe-range — ⇒ **1** (fail-safe: a
 * tampered / corrupt cursor re-reads page 1, never injects a query param, never loops). Strict (not `Number()`
 * coercion) so the accepted set is exactly our own cursor shape. Single source of the page number, shared by
 * `githubBuildQuery` + `githubMapPage`.
 */
function githubPageFromCursor(cursor?: string): number {
  if (typeof cursor !== "string" || !/^[1-9][0-9]*$/.test(cursor)) return 1;
  const n = Number(cursor);
  return Number.isSafeInteger(n) ? n : 1;
}

/**
 * Cursor→query (page-number paging): `?per_page=<max>&state=all&sort=updated&direction=desc&page=<n>`. `page`
 * is a guaranteed positive integer (no injection surface — never a raw cursor string). `filter` stays at its
 * `assigned` default; `since`/`labels` are arming-era refinements.
 */
function githubBuildQuery(request: TransportRequest): string {
  const page = githubPageFromCursor(request.cursor);
  return `?per_page=${GITHUB_PER_PAGE}&state=all&sort=updated&direction=desc&page=${page}`;
}

/**
 * The stable dedupe key (the 6.1 `contentHash`). Candidate (arch_gap): GitHub's `updated_at` (ISO 8601) is the
 * change token — hash `{ id, updated_at }` so an edit advances the hash ⇒ re-emit; if `updated_at` is absent,
 * fall back to hashing the raw issue. Reuses the canonical replay-stable `payloadHash`.
 */
function githubContentHash(issue: Record<string, unknown>, recordId: string): string {
  const updatedAt = issue.updated_at;
  if (typeof updatedAt === "string" && updatedAt.length > 0) {
    return payloadHash({ id: recordId, updated_at: updatedAt });
  }
  return payloadHash(issue);
}

/** Map the candidate GitHub bare issue array → a `TransportPage`, fail-closed on any malformed field. */
function githubMapPage(json: unknown, request: TransportRequest): ConnectorTransportResult {
  if (!Array.isArray(json)) {
    return transportFailure("unknown", "github: response is not a JSON array");
  }
  const items: TransportItem[] = [];
  for (const entry of json) {
    if (typeof entry !== "object" || entry === null) {
      return transportFailure("unknown", "github: malformed issue entry");
    }
    const issue = entry as Record<string, unknown>;
    const nodeId = issue.node_id;
    if (typeof nodeId !== "string" || nodeId.length === 0) {
      return transportFailure("unknown", "github: issue missing node_id");
    }
    items.push({ id: nodeId, hash: githubContentHash(issue, nodeId), raw: entry });
  }
  // Page-number pagination: a short page (< per_page) is terminal; else advance to page+1.
  const page = githubPageFromCursor(request.cursor);
  const done = json.length < GITHUB_PER_PAGE;
  return {
    ok: true,
    items,
    done,
    ...(done ? {} : { nextCursor: String(page + 1) }),
  };
}

/** The GitHub connector-HTTP spec (candidate wire shape — arch_gap). */
const GITHUB_HTTP_SPEC: ConnectorHttpSpec = {
  baseUrl: GITHUB_BASE_URL,
  allowedHosts: GITHUB_ALLOWED_HOSTS,
  resourcePath: "/issues",
  buildQuery: githubBuildQuery,
  mapPage: githubMapPage,
};

/**
 * Build the GitHub read-only HTTP transport. DORMANT — the real HttpTransport + SecretsAccessor + PAT stay
 * UNBOUND (a fake in tests); binding a real transport + the real token is the owner's arming crossing
 * (HARD LINE). See the wire-shape / pagination / auth / fault notes above.
 */
export function createGithubHttpTransport(deps: ConnectorHttpTransportDeps): ConnectorTransport {
  return createConnectorHttpTransport(GITHUB_HTTP_SPEC, deps);
}
