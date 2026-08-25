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
  type HttpTransport,
  type SecretsAccessor,
  type SecretUnavailable,
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

// ── Granola /v1/notes/{id} second-hop HYDRATION (LEG 2 — PKG-INT-5 · 23.4) ─────────────────────────────────
// SAME shape as the Gmail `messages.get` fan-out (see gmail.ts's hydration section) — SEPARATE from the
// `ConnectorHttpSpec`/template above. GET `/v1/notes/{id}` against `GRANOLA_ALLOWED_HOSTS`.
// CONTEXT7-GROUNDED (`/websites/granola_ai`, `GET /v1/notes/{note_id}`, round-1 confirmed): the note-detail
// envelope carries the note's REAL content — `summary_markdown` (nullable)/`summary_text`, `transcript`,
// `attendees`, … — well beyond the list-stage's bare metadata ({id, title, owner, created_at, updated_at}).
// A body-less note (both `summary_markdown` and `summary_text` missing/empty) FAILS CLOSED to a typed
// fault — never an empty-but-successful hydration (an empty note is indistinguishable from a fetch that
// silently dropped its content, so it must never look like a success).
// AUTH: the SAME static `grn_` key (no refresh here — PKG-INT-4 owns key rotation).
// ⚠ ING-7 HARD: a hydrated note body is UNTRUSTED external content (attendee-authored transcript/summary) —
// any agent consuming it MUST be admitted read-only, no mutating tools. The returned `Hydrator` enforces
// this BY CONSTRUCTION: it exposes exactly one method (`hydrate`) and every dispatched request is a GET.
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

/** One hydrated note. `hash` is CONTENT-DERIVED (`payloadHash` of the fetched note-detail body). */
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
 *  fault on one id never drops or blocks the others (partial-failure semantics, mirrors leg 1). */
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

/** The note-detail BODY TEXT, or `undefined` when the note is genuinely body-less (the fail-closed
 *  trigger). Prefers `summary_markdown` (richer); falls back to `summary_text`. */
function granolaNoteBodyText(json: Record<string, unknown>): string | undefined {
  const markdown = json.summary_markdown;
  if (typeof markdown === "string" && markdown.length > 0) return markdown;
  const text = json.summary_text;
  if (typeof text === "string" && text.length > 0) return text;
  return undefined;
}

/**
 * Build the Granola `/v1/notes/{id}` note hydration fan-out. DORMANT — the same real-transport/secrets/key
 * arming gate as `createGranolaHttpTransport` (real external network I/O = HARD LINE); tests inject fakes.
 */
export function createGranolaNoteHydrator(deps: HydratorDeps): Hydrator {
  const { transport, secrets, tokenRef, maxConcurrent, backoff, sleep } = deps;

  async function hydrateOne(id: string): Promise<HydrationOutcome> {
    const url = `${GRANOLA_BASE_URL}/v1/notes/${encodeURIComponent(id)}`;
    const hostRef = endpointHostRef(url);
    // (1) SSRF guard FIRST — off-guard ⇒ zero token read, zero dispatch (mirrors http-transport / leg 1).
    if (!isAllowedRemoteEndpoint(url, GRANOLA_ALLOWED_HOSTS)) {
      return { ok: false, id, code: "unreachable", message: `endpoint refused (${hostRef})` };
    }
    // (2) Resolve the bearer token ONCE per id — fail-closed on a typed-unavailable AND a throwing accessor.
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
      const record = json as Record<string, unknown>;
      // FAIL CLOSED on a body-less note — never an empty-but-successful hydration.
      if (granolaNoteBodyText(record) === undefined) {
        return { ok: false, id, code: "unknown", message: `note body missing (${hostRef})` };
      }
      return { ok: true, id, hash: payloadHash(record), raw: record };
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
