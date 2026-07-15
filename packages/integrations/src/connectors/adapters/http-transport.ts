// @sow/integrations — the reusable read-only connector HTTP transport (§8 Connector Gateway · §5 SSRF/egress ·
// §16 fail-closed). The template every REMOTE connector (Asana now; Granola / Drive / Calendar / Todoist /
// Linear / GitHub, round 3+) specializes with a per-vendor `ConnectorHttpSpec`. It produces a
// `ConnectorTransport` (the 6.3 seam) — mirroring `createGbrainHttpReadClient` (knowledge Lesson 1) but
// RETURNING a typed `TransportFailure` on fault instead of throwing (the connector seam is a closed
// `TransportPage | TransportFailure`, never a throw across the boundary).
//
// The flow (fail-closed at every step, §16):
//   (1) SSRF guard FIRST on the FINAL url (base+path+query) — the vetted `isAllowedRemoteEndpoint` (slice 1):
//       https + allowlisted-remote-host + reject-loopback. An off-guard url triggers ZERO token read + ZERO
//       dispatch. Guarding the final url (not just the base) catches an authority smuggled via path/query.
//   (2) Token — resolved from `tokenRef` via the injected `SecretsAccessor`, fail-closed on a typed-unavailable
//       AND a THROWING accessor (a real Keychain adapter can throw). It rides ONLY the Authorization header
//       and never enters a `TransportFailure` (safety rule 7).
//   (3) Build a read-only GET (ING-7 — the seam's `method` is the literal "GET"; there is no body).
//   (4) Dispatch via the injected `HttpTransport`; a reject ⇒ a redacted failure (raw cause DISCARDED).
//   (5) POSITIVE 2xx gate — a non-integer / <200 / ≥300 status ⇒ a failure carrying ONLY the safe status.
//   (6) Parse the 2xx body; non-JSON ⇒ a redacted failure (the raw body never echoed).
//   (7) Map via the per-connector candidate `spec.mapPage` → a `TransportPage` (fail-closed inside the mapper).
//
// Every fault detail is safe by construction: an HTTP status number, a `SecretUnavailable.reason` enum token,
// or `endpointHostRef` (host-only, credential-stripped) — never the token, the raw body, or the raw cause.
//
// DORMANT + reachability-waivered: no boot wiring. The owner's ARMING bundle binds a real Node HTTP transport
// + a Keychain-backed `SecretsAccessor` + the provisioned vendor token into `createAsanaConnector(
// createAsanaHttpTransport(...))` — real external network I/O is the owner's HARD LINE, NOT this slice. No real
// network/secrets here; tests inject fakes ⇒ the shipped default is byte-equivalent.
import { isErr } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { isAllowedRemoteEndpoint, endpointHostRef } from "@sow/policy";
import type {
  ConnectorTransport,
  ConnectorTransportResult,
  TransportFailure,
  TransportRequest,
} from "../transport";

// ── integrations-local injected seams ──────────────────────────────────────────
// Mirror the @sow/providers transport/secrets shapes but are re-declared HERE — `@sow/integrations` does not
// depend on `@sow/providers` (deps: contracts/domain/policy/db), the same layer reason GbrainReadClient
// re-declared them for knowledge→providers. Two tiny structural seams don't warrant widening the layer graph.

/** One outbound READ request handed to the injected transport. `method` is `"GET"` (default) or `"POST"` (a
 *  GraphQL-over-POST read connector — see the ConnectorHttpSpec.method/buildBody READ-ONLY WARNING); `body` is
 *  present only for POST (a token-free JSON body). `headers` MAY carry the resolved bearer token (never logged). */
export interface HttpTransportRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** The transport's raw response — an HTTP status + a raw body string (no interpretation by the transport). */
export interface HttpTransportResponse {
  readonly status: number;
  readonly body: string;
}

/** The DEPENDENCY-INJECTED HTTP transport (a real Node adapter in production; a fake in tests). MAY reject
 *  (network fault / abort); the template classifies the throw into a redacted `unreachable` failure. */
export interface HttpTransport {
  send(req: HttpTransportRequest, signal?: AbortSignal): Promise<HttpTransportResponse>;
}

/** Why a secret could not be resolved (SecretsPort-shaped). A locked/missing/denied token fails the read
 *  closed (→ a redacted failure), never a throw of the raw reason. */
export const SecretUnavailableReason = ["missing", "locked", "denied"] as const;
export type SecretUnavailableReason = (typeof SecretUnavailableReason)[number];

export interface SecretUnavailable {
  readonly reason: SecretUnavailableReason;
}

/** SecretsPort-shaped accessor: resolves a macOS Keychain REFERENCE handle (never an inline key) to the secret
 *  value as a typed Result — a locked/missing/denied key is an Err, not a throw (but the real adapter CAN
 *  throw, so the template wraps the call). */
export interface SecretsAccessor {
  getSecret(ref: string): Promise<Result<string, SecretUnavailable>>;
}

// ── spec + deps ─────────────────────────────────────────────────────────────────

/**
 * The per-connector configuration. `baseUrl`/`resourcePath` build the request url; `allowedHosts` is the SSRF
 * allowlist (exact whole-host, per slice 1); `buildQuery` owns paging (cursor→query string — it MUST
 * percent-encode any cursor); `mapPage` is the CANDIDATE vendor wire-mapper (arch_gap), parsing the 2xx JSON
 * into a page or a typed failure fail-closed. `readScope` is NOT here — it flows from the adapter's
 * `makeConnector({ readScope })` via `TransportRequest.readScope` (single source, no dual-source drift).
 *
 * `mapPage` receives the (token-free) `TransportRequest` as a 2nd arg (widened R5 for GitHub): a body-only
 * mapper for a page-number / bare-array API (no in-body cursor) needs the request cursor to compute the next
 * page. It is the SAME `{ cursor?, readScope }` request — it carries NO Authorization / token (safety rule 7).
 * The arg is additive: a 1-arg `(json) => …` mapper (the body-cursor connectors) still assigns + runs (the
 * extra arg is a runtime no-op), so existing specializations are byte-unchanged.
 */
export interface ConnectorHttpSpec {
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  readonly resourcePath: string;
  readonly buildQuery: (request: TransportRequest) => string;
  readonly mapPage: (json: unknown, request: TransportRequest) => ConnectorTransportResult;
  /**
   * HTTP method — absent ⇒ `"GET"` (the default; the 5 GET connectors). `"POST"` enables a GraphQL-over-POST
   * read connector (Linear) with a JSON `buildBody`.
   *
   * ⚠️ READ-ONLY WARNING (future POST-connector authors): a POST here carries read QUERIES ONLY. The transport
   * CANNOT inspect an opaque (e.g. GraphQL) body, so a POST connector's read-only-ness is the SPEC's contract —
   * a FIXED query-only `buildBody` (a GraphQL `query`, NEVER a `mutation`/write) + code review — NOT the HTTP
   * method (ING-7's GET-only type guarantee is relaxed here). Do NOT add a POST spec whose `buildBody` can
   * construct a mutation/write. GET stays the default so no existing connector gains a write-method path.
   */
  readonly method?: "GET" | "POST";
  /**
   * Builds the JSON request body from the token-free `TransportRequest` (REQUIRED when `method === "POST"`;
   * ignored for GET). Same seam as `buildQuery`/`mapPage`: it receives `{ cursor?, readScope }` and MUST NOT
   * carry the token (the token rides ONLY the Authorization header — rule 7). Wrapped fail-closed by the
   * template (a throw ⇒ a redacted failure). See the `method` WARNING — the body MUST be a read query only.
   */
  readonly buildBody?: (request: TransportRequest) => string;
}

/** The injected deps. All fakeable; the real bindings (a Node HTTP transport + a Keychain SecretsAccessor +
 *  the provisioned vendor token ref) are OWNER-GATED arming — UNBOUND in the shipped default. */
export interface ConnectorHttpTransportDeps {
  readonly transport: HttpTransport;
  readonly secrets: SecretsAccessor;
  readonly tokenRef: string;
}

/** Build a redaction-safe typed transport failure. `code` is diagnostic-only (the base `makeConnector`
 *  collapses ALL failures to `unreachable`); `message` MUST carry only safe detail (status / reason / host-ref). */
export function transportFailure(code: TransportFailure["code"], message: string): TransportFailure {
  return { ok: false, code, message };
}

/** Strip a single trailing slash so `${base}${path}` never doubles it (mirrors providers `trimTrailingSlash`). */
function trimTrailingSlash(endpoint: string): string {
  return endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
}

/** Diagnostic-only status→code map: 429 → rate_limited; 401/403 → auth_locked; else → unreachable. */
function statusToCode(status: number): TransportFailure["code"] {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth_locked";
  return "unreachable";
}

/**
 * Build the reusable read-only connector HTTP transport. DORMANT/unbound — the caller (owner arming) supplies
 * a real transport + Keychain SecretsAccessor + provisioned token ref.
 */
export function createConnectorHttpTransport(
  spec: ConnectorHttpSpec,
  deps: ConnectorHttpTransportDeps,
): ConnectorTransport {
  const { transport, secrets, tokenRef } = deps;

  return async (request: TransportRequest): Promise<ConnectorTransportResult> => {
    // `spec.buildQuery` / `spec.mapPage` are per-connector CALLBACKS (the candidate surface every
    // specialization supplies). Wrap them so a throwing builder/mapper — which a FUTURE connector could write
    // with raw response content in its message — can NEVER escape this template unredacted into
    // `makeConnector`'s `ConnectorError.message` → log sink (safety rule 7). This template is the reusable
    // safety boundary Granola/Drive/Calendar/GitHub inherit.
    let query: string;
    try {
      query = spec.buildQuery(request);
    } catch {
      return transportFailure("unknown", `query build error (${endpointHostRef(spec.baseUrl)})`);
    }
    const fullUrl = `${trimTrailingSlash(spec.baseUrl)}${spec.resourcePath}${query}`;
    const hostRef = endpointHostRef(fullUrl); // redaction-safe host ref for faults (host only)

    // (1) SSRF/egress guard FIRST — on the FINAL url. Off-guard ⇒ zero token read, zero dispatch.
    if (!isAllowedRemoteEndpoint(fullUrl, spec.allowedHosts)) {
      return transportFailure("unreachable", `endpoint refused (${hostRef})`);
    }
    // (2) Resolve the bearer token — fail-closed on a typed-unavailable AND a THROWING accessor (a real
    //     Keychain adapter can throw on a TCC denial / spawn error; the raw throw NEVER escapes into a failure).
    let secret: Result<string, SecretUnavailable>;
    try {
      secret = await secrets.getSecret(tokenRef);
    } catch {
      return transportFailure("auth_locked", "token unavailable");
    }
    if (isErr(secret)) {
      return transportFailure("auth_locked", `token unavailable (${secret.error.reason})`);
    }
    // (3) Build the request. GET (default) is byte-identical to before (no body, no content-type). POST (a
    //     GraphQL-over-POST read connector — see the ConnectorHttpSpec.method/buildBody READ-ONLY WARNING) adds
    //     a JSON body via the spec's TOKEN-FREE `buildBody`, wrapped fail-closed (a throw / a mis-specified POST
    //     with no buildBody ⇒ a redacted failure, no dispatch). The token rides ONLY the Authorization header
    //     (never the body / url) — rule 7.
    const method = spec.method ?? "GET";
    const headers: Record<string, string> = {
      accept: "application/json",
      Authorization: `Bearer ${secret.value}`,
    };
    let body: string | undefined;
    if (method === "POST") {
      if (spec.buildBody === undefined) {
        return transportFailure("unknown", `body build error (${hostRef})`); // POST spec missing buildBody
      }
      try {
        body = spec.buildBody(request);
      } catch {
        return transportFailure("unknown", `body build error (${hostRef})`);
      }
      headers["content-type"] = "application/json";
    }
    const httpRequest: HttpTransportRequest = {
      url: fullUrl,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    };
    // (4) Dispatch — a transport reject ⇒ a redacted failure (the raw cause is DISCARDED, never surfaced).
    let response: HttpTransportResponse;
    try {
      response = await transport.send(httpRequest);
    } catch {
      return transportFailure("unreachable", `transport error (${hostRef})`);
    }
    // (5) POSITIVE 2xx gate → a failure carrying ONLY the safe status number (never the body). A non-integer
    //     status (NaN/undefined) fails CLOSED — NOT treated as success.
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      return transportFailure(statusToCode(response.status), `HTTP ${response.status}`);
    }
    // (6) Parse the 2xx body; non-JSON ⇒ a redacted failure (the raw body is never echoed).
    let json: unknown;
    try {
      json = JSON.parse(response.body) as unknown;
    } catch {
      return transportFailure("unknown", `malformed body (${hostRef})`);
    }
    // (7) Map via the per-connector CANDIDATE wire-mapper (fail-closed inside — a renamed/missing field ⇒ a
    //     failure, never a false page). `request` is the token-free TransportRequest (rule 7) — a page-number /
    //     bare-array mapper reads its cursor to compute the next page. Wrapped: a THROWING mapper also fails
    //     closed redacted (the thrown content never escapes to the log sink).
    try {
      return spec.mapPage(json, request);
    } catch {
      return transportFailure("unknown", `map error (${hostRef})`);
    }
  };
}
