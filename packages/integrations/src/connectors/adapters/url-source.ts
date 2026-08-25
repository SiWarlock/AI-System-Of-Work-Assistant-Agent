// @sow/integrations — generic URL-source read connector (slice 6.3, V1 set) + task 23.5's
// DORMANT candidate HTTP-transport specialization.
//
// Read-only fetch of an arbitrary source URL (the Flow-4 "paste a link" ingest —
// YouTube/article/podcast pages). Auth is scoped to the least-privilege READ verb
// `http:get` — a GET-only fetch, never a mutating HTTP method. Transport-mocked:
// the injected `ConnectorTransport` performs the GET; no real network / clock here.
// Fetched page content is UNTRUSTED candidate data — redacted downstream, never
// logged raw here (safety rule 5). Fail-closed behavior from the shared base (§16).
import { makeConnector } from "./base";
import {
  createConnectorHttpTransport,
  transportFailure,
  type ConnectorHttpSpec,
  type ConnectorHttpTransportDeps,
} from "./http-transport";
import type { ConnectorPort } from "../port";
import type { ConnectorTransport, ConnectorTransportResult, TransportItem } from "../transport";
import { payloadHash } from "../../hash/payload-hash";

/** Build the generic URL-source read connector over an injected transport. */
export function createUrlSourceConnector(transport: ConnectorTransport): ConnectorPort {
  return makeConnector({ connectorId: "url-source", readScope: "http:get" }, transport);
}

// ── §23.5 candidate HTTP-transport specialization (DORMANT — arch_gap) ────────────────────────
// `createConnectorHttpTransport` (13.12) is built for a FIXED-baseUrl vendor API (Asana/Telegram/…)
// paginated JSON envelope — a "paste a link" source has no such fixed vendor host, so this
// specialization is a CANDIDATE wiring proof only (never bound to a real per-request target url in
// this slice — that per-request-url binding is an owner arming decision, §ARM-23). `allowedHosts`
// is therefore CALLER-supplied at construction (mirrors 13.2a's `createWebFetchTransport`), never a
// module-fixed vendor host list. The candidate envelope is `{ items: [{ locator, … }] }` — each
// entry's `locator` is its stable id (⇒ `TransportItem.id`/dedupe key); a non-object body, a missing
// `items[]`, a malformed entry, or an entry with no `locator` all fail CLOSED via `transportFailure`
// — never a false page (mirrors telegram-capture.ts's `mapPage`, L21).
const URL_SOURCE_BASE_URL = "https://example.invalid"; // candidate placeholder (arch_gap, §ARM-23)
const URL_SOURCE_RESOURCE_PATH = "/candidate-url-source";

function urlSourceBuildQuery(): string {
  return ""; // a single-fetch candidate — no vendor pagination/cursor concept yet (arch_gap).
}

/** Fail-closed candidate `{ items: [{ locator, … }] }` envelope mapper (arch_gap). */
function urlSourceMapPage(json: unknown): ConnectorTransportResult {
  if (typeof json !== "object" || json === null) {
    return transportFailure("unknown", "url-source: response is not an envelope object");
  }
  const items = (json as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return transportFailure("unknown", "url-source: missing items[]");
  }
  const mapped: TransportItem[] = [];
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) {
      return transportFailure("unknown", "url-source: malformed entry");
    }
    const locator = (entry as { locator?: unknown }).locator;
    if (typeof locator !== "string" || locator.length === 0) {
      return transportFailure("unknown", "url-source: entry missing locator");
    }
    mapped.push({ id: locator, hash: payloadHash({ locator }), raw: entry });
  }
  return { ok: true, items: mapped, done: true };
}

/** Deps for the candidate URL-source HTTP transport: the base `ConnectorHttpTransportDeps` plus a
 *  REQUIRED caller-supplied `allowedHosts` (no fixed vendor host — a generic URL source is
 *  allowlist-GOVERNED per caller policy, mirrors `createWebFetchTransport`'s `allowedHosts`). */
export interface UrlSourceHttpTransportDeps extends ConnectorHttpTransportDeps {
  readonly allowedHosts: readonly string[];
}

/**
 * Build the candidate URL-source HTTP transport. `allowedHosts` is REQUIRED at construction (no
 * module-fixed default) — an empty/absent allowlist admits nothing (fail-closed by construction).
 * DORMANT — no production caller binds a real `HttpTransport`; the real per-request target-url
 * binding + token stay UNBOUND (§ARM-23 HARD LINE). Tests inject fakes.
 */
export function createUrlSourceHttpTransport(deps: UrlSourceHttpTransportDeps): ConnectorTransport {
  const spec: ConnectorHttpSpec = {
    baseUrl: URL_SOURCE_BASE_URL,
    allowedHosts: deps.allowedHosts,
    resourcePath: URL_SOURCE_RESOURCE_PATH,
    buildQuery: urlSourceBuildQuery,
    mapPage: urlSourceMapPage,
    // `method` OMITTED ⇒ GET default (ING-7 read-only). This spec never opts into POST — a
    // mutating method is impossible through this spec (the template itself also admission-gates
    // to {GET,POST} only — defense-in-depth, see http-transport.ts step (0)).
  };
  return createConnectorHttpTransport(spec, deps);
}
