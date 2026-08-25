// @sow/integrations — Gmail messages LIST-ONLY read connector + its real read-only HTTP transport (§13.12).
//
// Read-only email-message ingestion via Gmail's users.messages.list. Auth is scoped to the least-privilege
// READ scope `gmail.readonly` — the connector NEVER requests a send/modify/compose scope. Mapping + fail-closed
// behavior come from the shared `makeConnector` base (§16).
//
// `createGmailHttpTransport` is the 7th instance of the reusable `createConnectorHttpTransport` template — a GET
// body-cursor connector (like Drive/Calendar; the `nextPageToken` rides the response body). DORMANT: the real
// HttpTransport + OAuth-backed SecretsAccessor + `gmail.readonly` token stay UNBOUND (a fake in tests); binding
// a real transport + a real token is the owner's arming crossing (real external network I/O = HARD LINE).
import { makeConnector } from "./base";
import {
  createConnectorHttpTransport,
  transportFailure,
  type ConnectorHttpSpec,
  type ConnectorHttpTransportDeps,
  type HttpTransport,
  type SecretsAccessor,
  type SecretUnavailable,
} from "./http-transport";
import type { ConnectorPort } from "../port";
import type { ConnectorTransport, ConnectorTransportResult, TransportItem, TransportRequest } from "../transport";
import { payloadHash } from "../../hash/payload-hash";

/** Build the Gmail read connector over an injected transport. `gmail.readonly` scope ONLY. */
export function createGmailConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "gmail", readScope: "gmail.readonly" }, transport);
}

// ── Gmail messages LIST-ONLY read transport (candidate wire shape — arch_gap, Lesson 21) ─────────────────────
// CONTEXT7-GROUNDED (`/websites/developers_google_workspace_gmail_api`, round-7 re-confirmed CONFORMANT):
//   GET /gmail/v1/users/me/messages ; response { messages?: [{ id, threadId }], nextPageToken?, resultSizeEstimate }.
// Parsed FAIL-CLOSED: a non-object body / a PRESENT non-array `messages` / a malformed message / a missing `id`
// ⇒ a `TransportFailure`. The empty-inbox / empty-page shape OMITS `messages` entirely — an ABSENT `messages` is
// an EMPTY page (`items: []`), NOT a failure (distinct from a present non-array). `done` is driven by the
// `nextPageToken` cursor, NOT `items.length` (an empty filtered page WITH a token keeps paginating).
//
// ⚠ LIST-ONLY messages.list (lead ruling — a NAMED deferral, NOT a silent drop, now PARTIALLY CLOSED):
// `messages.list` still returns id-level refs (`{id, threadId}`) ONLY. Detail-HYDRATION (the `messages.get`
// fan-out) is now BUILT — `createGmailHydrator`, below — with bounded concurrency, per-id partial-failure
// outcomes, and a single bounded 429 backoff retry. The real HttpTransport/OAuth-token BINDING stays the
// same arming residual as the list-only transport (DORMANT — a fake in tests). ⚠ ING-7 HARD (no longer a
// future concern): a hydrated message body IS untrusted external content — any agent consuming it MUST be
// admitted read-only (no mutating tools). `createGmailHydrator`'s returned hydrator enforces this BY
// CONSTRUCTION: it exposes exactly one method (`hydrate`) and issues only GET.
// AUTH: an OAuth2 access token (Bearer) — the template's bearer-string SecretsAccessor verbatim; refresh/expiry
// is an arming residual (like Drive/Calendar). ARMING residuals: minimal-scope `gmail.readonly` token; the
// `q`/`labelIds`/`includeSpamTrash` filters + the legacy `www.googleapis.com/gmail/v1` host alt.

const GMAIL_BASE_URL = "https://gmail.googleapis.com";
const GMAIL_ALLOWED_HOSTS: readonly string[] = ["gmail.googleapis.com"];
const GMAIL_PAGE_SIZE = 100; // Context7: maxResults default 100, max 500 — a conservative page size.

/**
 * Cursor→query (per-connector paging): `?maxResults=<n>` on the first page, `&pageToken=<cursor>` when resuming.
 * The cursor is percent-encoded so tampered / persisted cursor state can never inject a query param or smuggle
 * an authority into the url (defense-in-depth — the template also SSRF-guards the final url).
 */
function gmailBuildQuery(request: TransportRequest): string {
  const base = `?maxResults=${GMAIL_PAGE_SIZE}`;
  return request.cursor !== undefined ? `${base}&pageToken=${encodeURIComponent(request.cursor)}` : base;
}

/**
 * The stable dedupe key for the LIST-stage page (the 6.1 `contentHash`). LIST-ONLY: `messages.list` returns
 * immutable id-refs (no content, no updated-timestamp), so hash `{ id, threadId }` (both immutable) — a
 * message dedupes to a single emission at the list stage. SUPERSEDED for a HYDRATED item: once a body is
 * fetched via `createGmailHydrator` (below), the dedupe key is the CONTENT-DERIVED `payloadHash` of the
 * hydrated body — a body edit advances that hash, this id-only hash does not. Reuses the canonical
 * replay-stable `payloadHash`.
 */
function gmailContentHash(msg: Record<string, unknown>, id: string): string {
  const threadId = msg.threadId;
  if (typeof threadId === "string" && threadId.length > 0) {
    return payloadHash({ id, threadId });
  }
  return payloadHash({ id });
}

/** Extract the candidate `nextPageToken` body cursor (a well-formed non-empty string) or undefined. */
function gmailNextCursor(nextPageToken: unknown): string | undefined {
  return typeof nextPageToken === "string" && nextPageToken.length > 0 ? nextPageToken : undefined;
}

/** Map the candidate Gmail messages.list envelope → a `TransportPage`, fail-closed (absent `messages` = empty). */
function gmailMapPage(json: unknown): ConnectorTransportResult {
  // The envelope must be a plain object — reject null / non-object / a bare array (a top-level array is NOT the
  // messages.list envelope, and must not be misread as an object with an absent `messages`).
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return transportFailure("unknown", "gmail: response is not an envelope object");
  }
  const env = json as { messages?: unknown; nextPageToken?: unknown };
  const messages = env.messages;
  // ABSENT `messages` (empty inbox / empty page) ⇒ an empty page; a PRESENT non-array ⇒ fail-closed.
  if (messages !== undefined && !Array.isArray(messages)) {
    return transportFailure("unknown", "gmail: messages is not an array");
  }
  const list: readonly unknown[] = Array.isArray(messages) ? messages : [];
  const items: TransportItem[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) {
      return transportFailure("unknown", "gmail: malformed message entry");
    }
    const msg = entry as Record<string, unknown>;
    const id = msg.id;
    if (typeof id !== "string" || id.length === 0) {
      return transportFailure("unknown", "gmail: message missing id");
    }
    items.push({ id, hash: gmailContentHash(msg, id), raw: entry });
  }
  // `done` is driven by the cursor, NOT items.length — an empty filtered page WITH a token keeps paginating.
  const nextCursor = gmailNextCursor(env.nextPageToken);
  return {
    ok: true,
    items,
    done: nextCursor === undefined,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

/** The Gmail connector-HTTP spec (candidate wire shape — arch_gap; method defaults GET). */
const GMAIL_HTTP_SPEC: ConnectorHttpSpec = {
  baseUrl: GMAIL_BASE_URL,
  allowedHosts: GMAIL_ALLOWED_HOSTS,
  resourcePath: "/gmail/v1/users/me/messages",
  buildQuery: gmailBuildQuery,
  mapPage: gmailMapPage,
};

/**
 * Build the Gmail read-only HTTP transport. DORMANT — the real HttpTransport + OAuth-backed SecretsAccessor +
 * `gmail.readonly` token stay UNBOUND (a fake in tests); binding a real transport + a real token is the owner's
 * arming crossing (HARD LINE). See the LIST-ONLY / ING-7 / auth notes above.
 */
export function createGmailHttpTransport(deps: ConnectorHttpTransportDeps): ConnectorTransport {
  return createConnectorHttpTransport(GMAIL_HTTP_SPEC, deps);
}

// ── Gmail messages.get HYDRATION fan-out (LEG 1 — PKG-INT-5 · 23.4) ────────────────────────────────────────
// SEPARATE from the `ConnectorHttpSpec`/template above (http-transport.ts's template drives ONE request per
// page; hydration is a bounded-concurrency FAN-OUT of N gets with its own retry/partial-failure semantics
// that don't fit the template's single-request shape). Reuses the SSRF guard (`isAllowedRemoteEndpoint`) +
// the injected `SecretsAccessor`/token seam + the pure `nextDelayMs` backoff — `sleep` is INJECTED, never a
// real timer literal, so retry timing stays deterministic/testable.
//
// PARTIAL-FAILURE SEMANTICS (load-bearing — see the commit body): one failing `get` among N MUST NOT fail
// the whole batch. `hydrate` returns a closed per-id outcome list split into `succeeded` (hydrated bodies)
// and `faults` (typed per-id faults), so a caller can persist the N-1 successes and retry/report the 1
// fault independently, instead of losing an entire page's hydration to one bad id.
//
// RATE LIMIT: a 429 triggers exactly ONE bounded backoff sleep (`nextDelayMs(1, backoff)`) before ONE retry;
// a second 429 yields a typed `rate_limited` fault and stops — a 429 on one id never retries or delays the
// others (each id's retry state is fully isolated inside its own `hydrateOne` call).
//
// ⚠ ING-7 HARD: a hydrated message body is UNTRUSTED external content (the sender fully controls
// subject/body/headers) — any agent consuming a hydrated body MUST be admitted read-only (no mutating
// tools). The returned `Hydrator` enforces this BY CONSTRUCTION: it exposes exactly one method (`hydrate`)
// and every dispatched request is a GET.
import { isAllowedRemoteEndpoint, endpointHostRef } from "@sow/policy";
import { isErr } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { nextDelayMs, type BackoffConfig } from "../backoff";

/** Hydrator deps — DI-injected (mirrors `ConnectorHttpTransportDeps` + the pure backoff seam). `sleep` and
 *  `backoff` are injected so retry timing stays deterministic/testable — never a real timer literal. */
export interface HydratorDeps {
  readonly transport: HttpTransport;
  readonly secrets: SecretsAccessor;
  readonly tokenRef: string;
  readonly maxConcurrent: number;
  readonly backoff: BackoffConfig;
  readonly sleep: (ms: number) => Promise<void>;
}

/** One hydrated message body. `hash` is CONTENT-DERIVED (`payloadHash` of the fetched body) — supersedes
 *  the list-only `gmailContentHash({id,threadId})`: two hydrations of the same id with different bodies
 *  produce different hashes; identical bodies produce identical hashes. */
export interface HydrationSuccess {
  readonly ok: true;
  readonly id: string;
  readonly hash: string;
  readonly raw: unknown;
}

/** A typed per-id hydration fault — redaction-safe BY CONSTRUCTION (status/reason/host-ref only; never the
 *  body or the token, safety rule 7). */
export interface HydrationFault {
  readonly ok: false;
  readonly id: string;
  readonly code: "unreachable" | "rate_limited" | "auth_locked" | "unknown";
  readonly message: string;
}

export type HydrationOutcome = HydrationSuccess | HydrationFault;

/** The closed batch result: EVERY id resolves to exactly one outcome, split into `succeeded`/`faults` — a
 *  fault on one id never drops or blocks the others (partial-failure semantics, load-bearing). */
export interface HydrationBatchResult {
  readonly succeeded: readonly HydrationSuccess[];
  readonly faults: readonly HydrationFault[];
}

/** The hydrator surface — ING-7 HARD: exactly one method, no mutating surface to misuse. */
export interface Hydrator {
  hydrate(ids: readonly string[]): Promise<HydrationBatchResult>;
}

/** Bounded-concurrency pool runner: at most `limit` `worker` calls in flight at once (fixed lanes, each
 *  pulling the next unclaimed index as it frees up). Pure scheduling — no timers, no retries (those live in
 *  `worker`). */
async function runPool(size: number, limit: number, worker: (index: number) => Promise<void>): Promise<void> {
  const bounded = Math.max(1, Math.floor(limit));
  let next = 0;
  async function lane(): Promise<void> {
    while (next < size) {
      const i = next;
      next += 1;
      await worker(i);
    }
  }
  const lanes = Array.from({ length: Math.min(bounded, size) }, () => lane());
  await Promise.all(lanes);
}

/**
 * Build the Gmail `messages.get` hydration fan-out. DORMANT — the same real-transport/secrets/token arming
 * gate as `createGmailHttpTransport` (real external network I/O = HARD LINE); tests inject fakes.
 */
export function createGmailHydrator(deps: HydratorDeps): Hydrator {
  const { transport, secrets, tokenRef, maxConcurrent, backoff, sleep } = deps;

  async function hydrateOne(id: string): Promise<HydrationOutcome> {
    const url = `${GMAIL_BASE_URL}/gmail/v1/users/me/messages/${encodeURIComponent(id)}`;
    const hostRef = endpointHostRef(url);
    // (1) SSRF guard FIRST — off-guard ⇒ zero token read, zero dispatch (mirrors http-transport).
    if (!isAllowedRemoteEndpoint(url, GMAIL_ALLOWED_HOSTS)) {
      return { ok: false, id, code: "unreachable", message: `endpoint refused (${hostRef})` };
    }
    // (2) Resolve the bearer token ONCE per id — fail-closed on a typed-unavailable AND a throwing accessor
    //     (a real Keychain adapter can throw). Reused across the (at most 2) attempts below.
    let secret: Result<string, SecretUnavailable>;
    try {
      secret = await secrets.getSecret(tokenRef);
    } catch {
      return { ok: false, id, code: "auth_locked", message: "token unavailable" };
    }
    if (isErr(secret)) {
      return { ok: false, id, code: "auth_locked", message: `token unavailable (${secret.error.reason})` };
    }
    const authHeader = `Bearer ${secret.value}`;
    // (3) At most 2 attempts: the 2nd is the ONE bounded 429 retry — a second 429 stops here (rate_limited).
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let response;
      try {
        response = await transport.send({
          url,
          method: "GET",
          headers: { accept: "application/json", Authorization: authHeader },
        });
      } catch {
        return { ok: false, id, code: "unreachable", message: `transport error (${hostRef})` };
      }
      if (response.status === 429) {
        if (attempt === 1) {
          const delay = nextDelayMs(1, backoff);
          if (delay === "exhausted") {
            return { ok: false, id, code: "rate_limited", message: `HTTP 429 (${hostRef})` };
          }
          await sleep(delay);
          continue; // exactly one bounded retry
        }
        return { ok: false, id, code: "rate_limited", message: `HTTP 429 (${hostRef})` };
      }
      if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
        const code = response.status === 401 || response.status === 403 ? "auth_locked" : "unreachable";
        return { ok: false, id, code, message: `HTTP ${response.status} (${hostRef})` };
      }
      let json: unknown;
      try {
        json = JSON.parse(response.body) as unknown;
      } catch {
        return { ok: false, id, code: "unknown", message: `malformed body (${hostRef})` };
      }
      if (typeof json !== "object" || json === null) {
        return { ok: false, id, code: "unknown", message: `malformed body (${hostRef})` };
      }
      // CONTENT-DERIVED hash (supersedes the list-only {id,threadId} hash — see gmailContentHash above).
      return { ok: true, id, hash: payloadHash(json as Record<string, unknown>), raw: json };
    }
    // Unreachable in practice (the loop above always returns) — a terminal fallback for TS exhaustiveness.
    return { ok: false, id, code: "unknown", message: `retry loop exhausted (${hostRef})` };
  }

  return {
    async hydrate(ids: readonly string[]): Promise<HydrationBatchResult> {
      const outcomes: HydrationOutcome[] = new Array(ids.length);
      await runPool(ids.length, maxConcurrent, async (i) => {
        outcomes[i] = await hydrateOne(ids[i]!);
      });
      const succeeded: HydrationSuccess[] = [];
      const faults: HydrationFault[] = [];
      for (const outcome of outcomes) {
        if (outcome.ok) succeeded.push(outcome);
        else faults.push(outcome);
      }
      return { succeeded, faults };
    },
  };
}
