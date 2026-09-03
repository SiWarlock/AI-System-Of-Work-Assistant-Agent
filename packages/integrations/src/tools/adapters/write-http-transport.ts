// @sow/integrations — 21.6a: the real, dependency-injected write-side HTTP
// AdapterTransport (§8 Tool Gateway seam · §5 SSRF/egress · §16 fail-closed ·
// safety rule 3 external-write envelope / safety rule 7 secrets). Mirrors the
// proven read-side template `createConnectorHttpTransport`
// (connectors/adapters/http-transport.ts) — SSRF guard first, header-only
// token, positive-2xx gate, redacted faults — but drives a per-vendor WRITE
// (query / create / update) instead of a paged read, and resolves its token
// via the 17.4 write-credential seam (`writeSecretRef` / `WriteSecretsAccessor`,
// adapter-core.ts) instead of a raw injected tokenRef.
//
// The flow (fail-closed at every step, §16):
//   (1) Build the per-vendor request (`spec.buildRequest`) to get the FINAL url
//       (base + path — the path MAY carry its own query string), THEN run the
//       vetted `isAllowedRemoteEndpoint` on that FINAL url. An off-guard url
//       (or a smuggled authority in the path) ⇒ `{ ok:false, fault:"rejected",
//       detail: endpointHostRef(finalUrl) }` — ZERO token read, ZERO dispatch.
//   (2) Token — resolved via `deps.secrets.getSecret(writeSecretRef(req.targetSystem))`
//       (the 17.4 ref derivation; never a raw token parameter). A typed-unavailable
//       Err, a THROWING accessor, AND a whitespace-only token (not proof of auth —
//       mirrors `isRealVendorId` / `resolveWriteCredentialFault`) all fail closed to
//       `{ ok:false, fault:"rejected" }` carrying ONLY the closed-set reason token —
//       never the token value, never the `keychain://` ref.
//   (3) BIND the token to the request as `Authorization: Bearer <token>` — header
//       ONLY. Never the url, the body, a fault, or a log. `redirect` is fixed to
//       `"manual"` on every dispatched request (mirrors
//       providers/src/model/real-http-transport.ts's header: a cross-origin 3xx
//       would re-send the Authorization header verbatim), and the headers map is a
//       FRESH object built per call — no injected `http` ever retains/shares the
//       caller's header object across dispatches.
//   (4) Dispatch via `deps.http.send`. A reject/throw ⇒ `{ ok:false,
//       fault:"unreachable" }` with the raw cause DISCARDED — `unreachable` is the
//       outbox-hold signal (see outbox-drain.ts's module header).
//   (5) POSITIVE 2xx gate — a non-integer / <200 / ≥300 status is a fault, NEVER a
//       success. Status `0` ⇒ `"unreachable"` (the client convention for "no
//       response obtained" — the same event as step 4's throw; see
//       `statusToFault`); 409/412 ⇒ `"conflict"` (a stale precondition — NEVER a
//       blind overwrite); 408/425/429 ⇒ `"unreachable"` — the vendor said
//       "later", not "no" (see `RETRYABLE_4XX`); other 4xx ⇒ `"rejected"`
//       (terminal); 5xx ⇒ `"unreachable"`; anything else (1xx/3xx/NaN/
//       out-of-range) ⇒ `"unknown"`. `detail` carries ONLY the safe
//       status number in prose (`"HTTP <n>"`); `httpStatus` carries the SAME
//       number as a structured field (§S) — the one a caller must branch on
//       (adapter-core.ts's `faultToError`, drive.ts's 404 promotion), never
//       `detail`'s string shape. A NON-INTEGER status has no `httpStatus` to
//       carry, so it takes a `faultDetail: "malformed_status"` token instead.
//   (6) Parse the 2xx body; a parse failure (including an EMPTY 204 body) ⇒ a
//       redacted `"unknown"` fault — the raw body is NEVER echoed.
//   (7) Map via the per-vendor CANDIDATE `spec.mapResponse` — wrapped so a throw
//       (which could embed raw response content) becomes a redacted `"unknown"`
//       fault, never propagating.
//
// EVERY statusless fault this template returns (one that carries no usable
// `httpStatus` — either no HTTP response arrived, or its status was not an
// integer) ALSO carries a closed `TransportFaultDetail` token. This template is
// the PRODUCER that makes transport.ts's `faultDetail` field mean something:
// without it the six statusless `rejected` faults below (SSRF-block, four
// credential reasons, a throwing accessor) render byte-identically downstream as
// "request rejected". NINE return sites, ELEVEN tokens — the credential-
// unavailable return fans out over the three `WriteSecretUnavailableReason`s.
//
// DORMANT + UNBOUND: no production call-site. The worker's `WriteTransportGate`
// (backends.ts) stays unset; `selectAdapterTransport` keeps returning the
// deterministic in-memory `createStubAdapterTransport`. Binding a real
// `HttpTransport` (Node `fetch`) + a Keychain-backed `WriteSecretsAccessor` +
// `gate.make: () => createWriteHttpTransport(vendorSpec, { http, secrets })` into
// `WriteTransportGate` is the owner's ARMING crossing (§ARM-21) — NOT this slice.
// Tests inject fakes only — zero real network/secrets here.
import type { Result } from "@sow/contracts";
import { isAllowedRemoteEndpoint, endpointHostRef } from "@sow/policy";
import type {
  AdapterTransport,
  AdapterTransportRequest,
  TransportFault,
  TransportFaultDetail,
  TransportResponse,
} from "./transport";
import {
  writeSecretRef,
  type WriteSecretsAccessor,
  type WriteSecretUnavailable,
  type WriteSecretUnavailableReason,
} from "./adapter-core";

// ── integrations-local injected seams ──────────────────────────────────────────
// Mirror the read-side connector template's re-declared shapes (http-transport.ts
// :46-:61) — `@sow/integrations` does not depend on `@sow/providers` (deps:
// contracts/domain/policy/db), so these tiny structural seams are re-declared
// here rather than imported across a layer. `method` adds `"PATCH"` (a write
// adapter's `update` op) beyond the read-side's GET/POST; `redirect` is fixed to
// `"manual"` on every request this transport builds (see module header point 3).

/** One outbound WRITE request handed to the injected transport. `redirect` is
 *  always `"manual"` — this transport never lets an injected client follow a 3xx
 *  (a cross-origin redirect would re-send the Authorization header verbatim). */
export interface HttpTransportRequest {
  readonly url: string;
  readonly method: "GET" | "POST" | "PATCH";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly redirect: "manual";
}

/** The transport's raw response — an HTTP status + a raw body string (no interpretation here). */
export interface HttpTransportResponse {
  readonly status: number;
  readonly body: string;
}

/** The DEPENDENCY-INJECTED HTTP transport (a real Node adapter in production; a fake in
 *  tests). MAY reject (network fault / abort); this template classifies the throw into a
 *  redacted `"unreachable"` fault. */
export interface HttpTransport {
  send(req: HttpTransportRequest, signal?: AbortSignal): Promise<HttpTransportResponse>;
}

// ── spec + deps ─────────────────────────────────────────────────────────────────

/**
 * The per-vendor, DATA-ONLY configuration. `buildRequest` turns an
 * `AdapterTransportRequest` (op + identity + payload) into the HTTP shape
 * (method/path/body) — the token-free candidate surface every write-adapter
 * specialization supplies. `mapResponse` turns the parsed 2xx body into a
 * `TransportResponse` — the vendor wire-shape candidate mapper (fail-closed
 * inside; a throw is caught by the template, never propagates).
 */
export interface WriteHttpSpec {
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  /**
   * How the resolved credential binds to the `Authorization` header.
   *
   * - `"bearer"` (DEFAULT, and what every already-shipped adapter gets) — `Authorization: Bearer <t>`
   * - `"raw"` — `Authorization: <t>`, no prefix
   *
   * ⛔ WHY THIS EXISTS, grounded on Linear's own docs (2026-08-29) rather than memory: the Linear
   * GraphQL API takes an OAuth2 token as `Bearer <token>` but a **PERSONAL API KEY as a RAW
   * `Authorization: <key>` with no prefix**. This transport hardcoded Bearer, so a personal key was
   * simply not usable — a gap the connector-side `linear.ts` had already recorded as an unresolved
   * auth arch_gap and which would otherwise have surfaced as an opaque 401 at the first real write.
   *
   * ⭐ EXTENDED, NOT FORKED (`integrations L43`): a second bespoke client would fork the SSRF guard,
   * the fail-closed credential read and the redaction discipline. One additive field keeps all three
   * single-sourced, and every existing spec is byte-equivalent because the field is absent.
   *
   * ⚠ NEITHER VALUE IS THE "SAFE" ONE — the wrong scheme fails authentication, and BOTH directions
   * fail CLOSED (the write is rejected; nothing is written, nothing leaks). The default is chosen
   * for byte-equivalence with the shipped adapters, NOT as a safety posture. Stated because a
   * reader who assumes a safe default would pick wrongly for a new vendor.
   */
  readonly authScheme?: "bearer" | "raw";
  readonly buildRequest: (
    req: AdapterTransportRequest,
  ) => { readonly method: "GET" | "POST" | "PATCH"; readonly path: string; readonly body?: string };
  readonly mapResponse: (status: number, json: unknown, req: AdapterTransportRequest) => TransportResponse;
}

/** The injected deps. `secrets` resolves the write-credential via the 17.4
 *  `writeSecretRef` derivation (adapter-core.ts) — never a raw token parameter. */
export interface WriteHttpTransportDeps {
  readonly http: HttpTransport;
  readonly secrets: WriteSecretsAccessor;
}

/** Strip a single trailing slash so `${base}${path}` never doubles it (mirrors the
 *  read-side template's `trimTrailingSlash`). */
function trimTrailingSlash(endpoint: string): string {
  return endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
}

/**
 * The 4xx statuses that mean "later", not "no" — the vendor received and
 * understood the request and is asking to be retried, so they map to
 * `unreachable` (the ONLY retryable fault; gateway.ts routes it to
 * `{status:"held"}` → the outbox backoff) rather than to the terminal
 * `rejected`.
 *
 *   408 Request Timeout — the server closed an idle/slow connection before the
 *       request completed. RFC 9110 §15.5.9: the client MAY repeat the request.
 *   425 Too Early      — the server refuses to risk replaying an early-data
 *       (TLS 0-RTT) request. RFC 8470 §5.2: retry once the handshake completes.
 *       Included for completeness; this template never sends early data itself,
 *       so reaching it requires an injected `HttpTransport` that does.
 *   429 Too Many Requests — a rate limit. RFC 6585 §4 defines it as temporal
 *       ("in a given amount of time"). This is the single most common real-world
 *       external-write failure; terminating on it fails a whole batch closed.
 *
 * DELIBERATELY NOT retryable, decided on their merits:
 *   423 Locked — RFC 4918 §11.3 gives no bound on how long the lock is held, and
 *       several vendors reuse 423 for a permanently locked ACCOUNT. A held outbox
 *       entry never expires (outbox-drain.ts's `computeNextAttemptAt` returns a
 *       bounded `maxMs` even when the backoff is exhausted), so an unbounded
 *       condition on a never-expiring hold is the retry-forever bug this round
 *       exists to avoid. It terminates, and the operator sees "HTTP 423".
 *   401/403 — auth. Retrying cannot fix a credential; retrying forever hides it.
 *   404/400/422 — the request or target is wrong. A retry sends the same bytes.
 */
const RETRYABLE_4XX: ReadonlySet<number> = new Set([408, 425, 429]);

/** Positive-2xx-gate status→fault map (step 5). Status 0 ⇒ unreachable (see
 *  below); 409/412 ⇒ conflict (a stale precondition — NEVER a blind overwrite);
 *  a RETRYABLE_4XX ⇒ unreachable (the vendor said "later"); other 4xx ⇒ rejected
 *  (terminal); 5xx ⇒ unreachable (the outbox-hold signal); anything else
 *  (1xx/3xx/NaN/out-of-range, including a NaN status where every numeric
 *  comparison is false) ⇒ unknown.
 *
 *  WHY STATUS 0 IS UNREACHABLE, NOT UNKNOWN. `0` is the near-universal client
 *  convention for "no HTTP response was obtained" — a DNS/TLS/connection failure,
 *  a timeout, an abort, a blocked cross-origin request. XHR, and the wrappers
 *  layered on `fetch` that catch a rejection and report a synthetic response,
 *  all use it. That is the SAME event the step-5 `catch` arm below already
 *  classifies `unreachable`; the only difference is whether the injected
 *  `HttpTransport` signalled it by throwing or by returning. Classifying the two
 *  encodings differently made the disposition depend on an implementation detail
 *  of the injected client rather than on what happened. The hazard runs both
 *  ways and was checked: `unreachable` is the retryable arm, so a permanent
 *  failure mislabelled `0` would be retried — but `outbox-drain.ts`'s backoff is
 *  bounded, and the opposite error (terminating a transient outage) is the one
 *  that loses a write outright. */
function statusToFault(status: number): TransportFault {
  if (status === 0) return "unreachable";
  if (status === 409 || status === 412) return "conflict";
  if (RETRYABLE_4XX.has(status)) return "unreachable";
  if (status >= 400 && status < 500) return "rejected";
  if (status >= 500 && status < 600) return "unreachable";
  return "unknown";
}

/** Map the closed write-credential failure reason (adapter-core.ts) onto the
 *  closed `TransportFaultDetail` token, so a LOCKED Keychain and a DENIED one do
 *  not render as the same sentence. Total over the reason union by construction:
 *  adding a reason without a token is a compile error, not a silent collapse. */
const CREDENTIAL_FAULT_DETAIL: Readonly<Record<WriteSecretUnavailableReason, TransportFaultDetail>> = {
  missing: "credential_missing",
  locked: "credential_locked",
  denied: "credential_denied",
};

/**
 * Build the real write-side HTTP {@link AdapterTransport}. DORMANT/unbound — the
 * owner's arming crossing supplies a real `HttpTransport` + Keychain-backed
 * `WriteSecretsAccessor` + a per-vendor `WriteHttpSpec`.
 */
export function createWriteHttpTransport(spec: WriteHttpSpec, deps: WriteHttpTransportDeps): AdapterTransport {
  const { http, secrets } = deps;

  return async (req: AdapterTransportRequest): Promise<TransportResponse> => {
    // (1) Build the per-vendor request (token-free candidate). A throwing builder
    //     fails closed BEFORE any host is known — the base url is the only safe
    //     host reference available.
    let built: { method: "GET" | "POST" | "PATCH"; path: string; body?: string };
    try {
      built = spec.buildRequest(req);
    } catch {
      return {
        ok: false,
        fault: "unknown",
        detail: `request build error (${endpointHostRef(spec.baseUrl)})`,
        faultDetail: "request_build_error",
      };
    }
    const fullUrl = `${trimTrailingSlash(spec.baseUrl)}${built.path}`;
    const hostRef = endpointHostRef(fullUrl); // redaction-safe host ref for faults (host only)

    // (2) SSRF/egress guard FIRST — on the FINAL url (base+path), so an authority
    //     smuggled via the path is caught, not just a misconfigured base. Off-guard
    //     ⇒ zero token read, zero dispatch.
    if (!isAllowedRemoteEndpoint(fullUrl, spec.allowedHosts)) {
      return { ok: false, fault: "rejected", detail: hostRef, faultDetail: "ssrf_blocked" };
    }

    // (3) Resolve the write-credential — fail-closed on a typed-unavailable Err, a
    //     THROWING accessor, AND a whitespace-only token (not proof of auth). The
    //     ref itself (`keychain://…`) and the resolved value NEVER reach a fault.
    let secret: Result<string, WriteSecretUnavailable>;
    try {
      secret = await secrets.getSecret(writeSecretRef(req.targetSystem));
    } catch {
      return {
        ok: false,
        fault: "rejected",
        detail: "write credential resolution faulted",
        faultDetail: "credential_fault",
      };
    }
    if (!secret.ok) {
      return {
        ok: false,
        fault: "rejected",
        detail: `write credential unavailable: ${secret.error.reason}`,
        faultDetail: CREDENTIAL_FAULT_DETAIL[secret.error.reason],
      };
    }
    if (secret.value.trim().length === 0) {
      return {
        ok: false,
        fault: "rejected",
        detail: "write credential unavailable: empty",
        faultDetail: "credential_empty",
      };
    }

    // (4) Build the dispatched request. The token rides ONLY the Authorization
    //     header (never the url/body). `headers` is a FRESH object literal per
    //     call — no injected `http` can retain/mutate a shared caller object.
    //     `redirect` is fixed `"manual"` (see module header point 3).
    const headers: Record<string, string> = {
      accept: "application/json",
      // `=== "raw"` is STRICT on purpose: an absent, misspelled or malformed `authScheme` falls to
      // Bearer, which is what every shipped adapter already sends. See the field's own doc for why
      // that default is about byte-equivalence and NOT about one scheme being safer.
      Authorization: spec.authScheme === "raw" ? secret.value : `Bearer ${secret.value}`,
      ...(built.body !== undefined ? { "content-type": "application/json" } : {}),
    };
    const httpRequest: HttpTransportRequest = {
      url: fullUrl,
      method: built.method,
      headers,
      redirect: "manual",
      ...(built.body !== undefined ? { body: built.body } : {}),
    };

    // (5) Dispatch — a transport reject ⇒ a redacted fault (the raw cause is
    //     DISCARDED, never surfaced; `"unreachable"` is the outbox-hold signal).
    let response: HttpTransportResponse;
    try {
      response = await http.send(httpRequest);
    } catch {
      return {
        ok: false,
        fault: "unreachable",
        detail: `transport error (${hostRef})`,
        faultDetail: "transport_error",
      };
    }

    // (6) POSITIVE 2xx gate — a non-integer / <200 / ≥300 status fails closed,
    //     NEVER treated as success. `httpStatus` carries the same status as a
    //     STRUCTURED numeric field (absent for a non-integer status, e.g. NaN) —
    //     a caller branches on this, never on `detail`'s "HTTP <n>" string shape.
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      // A non-integer status has no `httpStatus` to carry, so it is STATUSLESS in
      // the operative sense and needs a `faultDetail` token like every other one:
      // without it, a NaN status and a garbage 1.5 both render as the bare
      // `"unclassified adapter fault"` — the same sentence a malformed body and a
      // throwing `mapResponse` produce.
      const isInteger = Number.isInteger(response.status);
      return {
        ok: false,
        fault: statusToFault(response.status),
        detail: `HTTP ${response.status}`,
        ...(isInteger
          ? { httpStatus: response.status }
          : { faultDetail: "malformed_status" as const }),
      };
    }

    // (7) Parse the 2xx body; a parse failure (including an EMPTY body — e.g. a
    //     204) ⇒ a redacted fault, the raw body NEVER echoed.
    let json: unknown;
    try {
      json = JSON.parse(response.body) as unknown;
    } catch {
      return { ok: false, fault: "unknown", detail: `malformed body (${hostRef})`, faultDetail: "malformed_body" };
    }

    // (8) Map via the per-vendor CANDIDATE wire-mapper — wrapped so a throwing
    //     mapper's content can never escape this template unredacted.
    try {
      return spec.mapResponse(response.status, json, req);
    } catch {
      return { ok: false, fault: "unknown", detail: `map error (${hostRef})`, faultDetail: "map_error" };
    }
  };
}
