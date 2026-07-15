// @sow/integrations — Google Drive read connector + its real read-only HTTP transport (slice 6.3 · §13.12).
//
// Read-only Drive file/metadata ingestion. Auth is scoped to the least-privilege READ scope `drive.readonly`
// — the connector never requests write access (the Drive WRITE path is the Tool Gateway / NotebookPort, not
// this read connector). Mapping + fail-closed behavior from the shared base (§16).
//
// `createDriveHttpTransport` is the 2nd instance of the reusable `createConnectorHttpTransport` template
// (Asana was the 1st) — the SSRF-guard→token→GET→2xx-gate→map flow specialized with the Drive spec. DORMANT:
// the real HttpTransport + OAuth-backed SecretsAccessor + `drive.readonly` token stay UNBOUND (a fake in
// tests); binding a real transport + provisioning a real Google OAuth token is the owner's arming crossing
// (real external network I/O = HARD LINE). No real network / clock here.
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

/** Build the Drive read connector over an injected transport. */
export function createDriveConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "drive", readScope: "drive.readonly" }, transport);
}

// ── Google Drive real read-only HTTP transport (candidate wire shape — arch_gap, Lesson 21) ──────────────────
// The Drive files.list envelope is a DOCUMENTED CANDIDATE — confirmed + corrected at the owner arming binding
// (we cannot RUN the real API now):
//   { files: File[], nextPageToken?: string, incompleteSearch?: boolean },  File = { id: string, modifiedTime?: string, … }
// Parsed FAIL-CLOSED: a missing / renamed field ⇒ a `TransportFailure`, never a false page.
// arch_gap (confirm at arming): Drive also returns `incompleteSearch?: boolean` (a partial-corpora-coverage
// signal). Currently IGNORED (candidate) — confirm at arming whether `incompleteSearch: true` should DEGRADE
// coverage (mirror the reconciler's completeness flag), rather than silently returning a partial page as done.
//
// OAuthTokenSource contract (DOCUMENTATION — the template is token-agnostic, NO code change): `tokenRef`
// resolves a Google OAuth ACCESS token (a bearer string, exactly like a PAT). Refresh / expiry / rotation is
// ARMING-era behind the SecretsAccessor (an access token EXPIRES — never a static secret); a 401 →
// `auth_locked` is the dormant refresh signal. The OAuth app MUST be provisioned with ONLY `drive.readonly` —
// a WRITE scope is FORBIDDEN (read-only-connector invariant; the Drive write path is the Tool Gateway /
// NotebookPort, never this read connector).

const DRIVE_BASE_URL = "https://www.googleapis.com/drive/v3";
const DRIVE_ALLOWED_HOSTS: readonly string[] = ["www.googleapis.com"];
const DRIVE_PAGE_SIZE = 100;
// Candidate least-fields projection (arch_gap): the pagination token + coverage signal + id + change token +
// light metadata.
const DRIVE_FIELDS = "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime)";

/**
 * Cursor→query (per-connector paging): `?pageSize=<n>&fields=<…>` on the first page, `&pageToken=<cursor>` when
 * resuming. The cursor is percent-encoded so tampered / persisted cursor state can never inject a query param
 * or smuggle an authority into the url (defense-in-depth — the template also SSRF-guards the final url).
 */
function driveBuildQuery(request: TransportRequest): string {
  const base = `?pageSize=${DRIVE_PAGE_SIZE}&fields=${encodeURIComponent(DRIVE_FIELDS)}`;
  return request.cursor !== undefined ? `${base}&pageToken=${encodeURIComponent(request.cursor)}` : base;
}

/**
 * The stable dedupe key (the 6.1 `contentHash`). Candidate (arch_gap): Drive's `modifiedTime` is the change
 * token — hash `{ id, modifiedTime }` so an edit advances the hash ⇒ re-emit; if `modifiedTime` is absent in
 * the real shape, fall back to hashing the raw file. Reuses the canonical replay-stable `payloadHash`
 * (key-order-safe SHA-256) — a connector never hand-rolls a hash.
 */
function driveContentHash(file: Record<string, unknown>, id: string): string {
  const modifiedTime = file.modifiedTime;
  if (typeof modifiedTime === "string" && modifiedTime.length > 0) {
    return payloadHash({ id, modifiedTime });
  }
  return payloadHash(file);
}

/** Extract the candidate `nextPageToken` cursor (a well-formed non-empty string) or undefined. */
function driveNextCursor(nextPageToken: unknown): string | undefined {
  return typeof nextPageToken === "string" && nextPageToken.length > 0 ? nextPageToken : undefined;
}

/** Map the candidate Drive files.list envelope → a `TransportPage`, fail-closed on any malformed / renamed field. */
function driveMapPage(json: unknown): ConnectorTransportResult {
  if (typeof json !== "object" || json === null) {
    return transportFailure("unknown", "drive: response is not an envelope object");
  }
  const files = (json as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    return transportFailure("unknown", "drive: missing files[]");
  }
  const items: TransportItem[] = [];
  for (const entry of files) {
    if (typeof entry !== "object" || entry === null) {
      return transportFailure("unknown", "drive: malformed file entry");
    }
    const file = entry as Record<string, unknown>;
    const id = file.id;
    if (typeof id !== "string" || id.length === 0) {
      return transportFailure("unknown", "drive: file missing id");
    }
    items.push({ id, hash: driveContentHash(file, id), raw: entry });
  }
  const nextCursor = driveNextCursor((json as { nextPageToken?: unknown }).nextPageToken);
  return {
    ok: true,
    items,
    done: nextCursor === undefined,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

/** The Google Drive connector-HTTP spec (candidate wire shape — arch_gap). */
const DRIVE_HTTP_SPEC: ConnectorHttpSpec = {
  baseUrl: DRIVE_BASE_URL,
  allowedHosts: DRIVE_ALLOWED_HOSTS,
  resourcePath: "/files",
  buildQuery: driveBuildQuery,
  mapPage: driveMapPage,
};

/**
 * Build the Drive read-only HTTP transport. DORMANT — the real HttpTransport + OAuth-backed SecretsAccessor +
 * `drive.readonly` token stay UNBOUND (a fake in tests); binding a real transport + provisioning a real Google
 * OAuth token is the owner's arming crossing (HARD LINE). See the OAuthTokenSource contract note above.
 */
export function createDriveHttpTransport(deps: ConnectorHttpTransportDeps): ConnectorTransport {
  return createConnectorHttpTransport(DRIVE_HTTP_SPEC, deps);
}
