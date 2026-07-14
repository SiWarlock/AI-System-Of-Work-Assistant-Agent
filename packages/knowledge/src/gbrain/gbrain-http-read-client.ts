// The concrete GbrainReadClient HTTP transport over `gbrain serve --http` (§6 REQ-F-019/KN-2, §7). Dormant
// arming-prep Item 2a — makes the read-only serving transport CONSTRUCTIBLE + fully unit-tested, still UNBOUND.
//
// It implements the single-entry `GbrainReadClient.invoke` the mcp-read-adapter (`createGbrainReadAdapter`)
// consumes: resolve the bearer token from the grant's Keychain `tokenRef` via an injected SecretsAccessor →
// enforce a loopback + allowlist SSRF/egress guard → dispatch one POST to the op's path through an injected
// HttpTransport → resolve the parsed 2xx JSON body as `unknown`. ANY failure (endpoint refused, token
// unavailable, transport throw, non-2xx, malformed body) throws a REDACTED typed `GbrainHttpTransportFault`
// carrying NO token / raw body / raw cause — the adapter's try/catch maps it to `transport_fault`, so piece B
// degrades `complete=false` (fail-closed).
//
// Safety posture:
//   • The token is resolved from `tokenRef` ONLY (never inline), rides ONLY the Authorization header, and never
//     enters a fault message / prop / stack (safety rule 7 / REQ-S-003).
//   • The endpoint guard REUSES the single vetted, authority-isolated `isLoopbackEndpoint` predicate from
//     @sow/policy (worker Lesson 17 — a safety predicate lives ONCE; never re-mirror it) AND requires the
//     endpoint to be on the injected allowlist (defense-in-depth; contracts Lesson 4). The guard runs BEFORE any
//     secret read or dispatch — an off-allowlist/non-loopback/spoofed URL triggers zero Keychain access and zero
//     network I/O.
//   • Every fault detail is safe by construction: the HTTP status number, a `SecretUnavailable.reason` enum
//     token, or `endpointHostRef` (host-only, credential-stripped) — never a redacted-but-free-form blob.
//
// arch_gap (Lesson 21 — real-surface honesty): the real `gbrain serve --http` wire shape (op→path/method +
// request/response envelope) for gbrain 0.35.1.0 is OWNER-GATED (we cannot RUN the real serve now). `OP_PATH`
// below + the `{ payload, context? }` body are a DOCUMENTED CANDIDATE, parsed fail-closed — a wrong path/shape
// yields a non-2xx or a malformed body ⇒ `transport_throw`/`status_error`/`malformed_body` ⇒ degrade, NEVER a
// false success. The real shape is confirmed + this map corrected at the arming binding; do NOT treat as final.
//
// DORMANT + reachability-waivered: no production caller. The owner's ARMING bundle binds a real Node HTTP
// transport + a Keychain-backed SecretsAccessor + the provisioned loopback endpoint into `apps/worker/src/boot.ts`
// `gateReconcile`'s `makeDbAdapter` (currently `() => undefined` — byte-equivalent). No real network/process/
// Keychain here; tests inject fakes.
import { isErr } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { isLoopbackEndpoint, endpointHostRef } from "@sow/policy";
import type { GbrainReadClient, GbrainAllowedOp } from "./mcp-read-adapter";

// ── knowledge-local injected seams (mirror the @sow/providers shapes; NOT imported — knowledge→providers is
//    forbidden by the layer direction, so the small transport/secrets seams are re-declared here) ─────────────

/** One outbound request handed to the injected transport. `body` is a JSON string; `headers` MAY carry the
 *  resolved bearer token (never logged). */
export interface HttpTransportRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** The transport's raw response — an HTTP status + a raw body string (no interpretation by the transport). */
export interface HttpTransportResponse {
  readonly status: number;
  readonly body: string;
}

/** The DEPENDENCY-INJECTED HTTP transport (a real Node adapter in production; a fake in tests). MAY reject
 *  (network fault / abort); the client classifies the throw into a redacted `transport_throw` fault. */
export interface HttpTransport {
  send(req: HttpTransportRequest, signal?: AbortSignal): Promise<HttpTransportResponse>;
}

/** Why a secret could not be resolved (SecretsPort-shaped). A locked/missing/denied token fails the read
 *  closed (→ `transport_fault` → degrade), never a throw of the raw reason. */
export const SecretUnavailableReason = ["missing", "locked", "denied"] as const;
export type SecretUnavailableReason = (typeof SecretUnavailableReason)[number];

export interface SecretUnavailable {
  readonly reason: SecretUnavailableReason;
}

/** SecretsPort-shaped accessor: resolves a macOS Keychain REFERENCE handle (never an inline key) to the secret
 *  value as a typed Result — a locked/missing/denied key is an Err, not a throw. */
export interface SecretsAccessor {
  getSecret(ref: string): Promise<Result<string, SecretUnavailable>>;
}

// ── deps + fault type ─────────────────────────────────────────────────────────

/** The injected deps for the HTTP read transport. All fakeable; the real bindings are owner-gated arming. */
export interface GbrainHttpReadClientDeps {
  readonly transport: HttpTransport;
  readonly secrets: SecretsAccessor;
  /** The grant's Keychain reference handle (`grant.tokenRef`) — resolved via `secrets`, never inline. */
  readonly tokenRef: string;
  /** The loopback `gbrain serve --http` base URL (provisioned at arming; a fake string in tests). */
  readonly endpoint: string;
  /** The explicit endpoint allowlist (defense-in-depth over the loopback predicate). */
  readonly allowedEndpoints: readonly string[];
}

/** The enumerable, redaction-safe transport fault codes. */
export type GbrainHttpTransportFaultCode =
  | "endpoint_refused" // non-loopback / off-allowlist endpoint (no dispatch)
  | "token_unavailable" // SecretsAccessor could not resolve the token (no dispatch)
  | "status_error" // a non-2xx HTTP status
  | "transport_throw" // the injected transport rejected
  | "malformed_body"; // a 2xx body that was not valid JSON

/**
 * A REDACTED transport fault. `code` + `message` carry ONLY safe detail (a status number, a
 * `SecretUnavailable.reason`, or a host-only endpoint ref) — never the token, the raw body, or the raw cause.
 * The adapter (`createGbrainReadAdapter`) catches this into a `transport_fault` GbrainReadError.
 */
export class GbrainHttpTransportFault extends Error {
  readonly code: GbrainHttpTransportFaultCode;
  constructor(code: GbrainHttpTransportFaultCode, safeDetail?: string) {
    super(
      safeDetail === undefined
        ? `gbrain http read transport: ${code}`
        : `gbrain http read transport: ${code} (${safeDetail})`,
    );
    this.name = "GbrainHttpTransportFault";
    this.code = code;
  }
}

// ── candidate wire map (arch_gap — real shape confirmed at arming, Lesson 21) ────

/** The DOCUMENTED CANDIDATE op→path map. Exhaustive over the frozen `GbrainAllowedOp` enum (a new op fails tsc
 *  here until mapped). All ops are POST. arch_gap: the real `gbrain serve --http` paths are confirmed at arming. */
const OP_PATH: Record<GbrainAllowedOp, string> = {
  search: "/read/search",
  graph: "/read/graph",
  timeline: "/read/timeline",
  schema_read: "/read/schema",
  health: "/read/health",
  contained_synthesis: "/read/contained-synthesis",
};

/** Strip a single trailing slash so `${endpoint}${path}` never doubles it (mirrors providers `trimTrailingSlash`). */
function trimTrailingSlash(endpoint: string): string {
  return endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
}

/**
 * Build the concrete read-only HTTP transport. DORMANT/unbound — the caller (owner arming) supplies a real
 * transport + Keychain SecretsAccessor + provisioned loopback endpoint. Structurally satisfies `GbrainReadClient`.
 */
export function createGbrainHttpReadClient(deps: GbrainHttpReadClientDeps): GbrainReadClient {
  const { transport, secrets, tokenRef, endpoint, allowedEndpoints } = deps;
  const hostRef = endpointHostRef(endpoint); // redaction-safe endpoint ref for faults (host only)

  return {
    async invoke(op: GbrainAllowedOp, payload: unknown, context?: readonly unknown[]): Promise<unknown> {
      // (1) SSRF/egress guard FIRST — loopback (authority-isolated) AND on the allowlist. An off-guard endpoint
      //     triggers zero Keychain access and zero dispatch.
      if (!isLoopbackEndpoint(endpoint) || !allowedEndpoints.includes(endpoint)) {
        throw new GbrainHttpTransportFault("endpoint_refused", hostRef);
      }
      // (2) Resolve the bearer token from the Keychain reference — fail-closed, never inline/logged. The seam
      //     contract is Result-returning, but the real Keychain adapter CAN throw (TCC denial / spawn / native
      //     error); wrap it so a raw throw maps to a redacted token_unavailable and NEVER escapes into the
      //     adapter's transport_fault.cause (symmetric with the transport.send wrapping below).
      let secret: Result<string, SecretUnavailable>;
      try {
        secret = await secrets.getSecret(tokenRef);
      } catch {
        throw new GbrainHttpTransportFault("token_unavailable");
      }
      if (isErr(secret)) {
        throw new GbrainHttpTransportFault("token_unavailable", secret.error.reason);
      }
      // (3) Build the request (candidate wire shape — arch_gap).
      const request: HttpTransportRequest = {
        url: `${trimTrailingSlash(endpoint)}${OP_PATH[op]}`,
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${secret.value}` },
        body: JSON.stringify(context === undefined ? { payload } : { payload, context }),
      };
      // (4) Dispatch. A transport reject → a redacted fault (the raw cause is DISCARDED, never surfaced).
      let response: HttpTransportResponse;
      try {
        response = await transport.send(request);
      } catch {
        throw new GbrainHttpTransportFault("transport_throw", hostRef);
      }
      // (5) POSITIVE 2xx gate → a redacted fault carrying ONLY the safe status number (never the body). A
      //     non-integer / out-of-range status fails CLOSED (a `NaN`/`undefined` status is NOT treated as success).
      if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
        throw new GbrainHttpTransportFault("status_error", `HTTP ${response.status}`);
      }
      // (6) Parse the 2xx body; non-JSON → a redacted fault (the raw body is never echoed).
      try {
        return JSON.parse(response.body) as unknown;
      } catch {
        throw new GbrainHttpTransportFault("malformed_body", hostRef);
      }
    },
  };
}
