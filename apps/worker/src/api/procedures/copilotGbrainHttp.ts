// §9.6-real #2 http-grant transport — the MANDATED transport:"http" GbrainReadGrant read path.
//
// Reads gbrain over its `serve --http` MCP-over-HTTP endpoint (OAuth 2.1) instead of the subprocess CLI.
// This is the production-shaped transport (one `gbrain serve` OWNS the single-connection PGlite DB; the
// worker reads over HTTP), so it FIXES the P3-live PGlite-lock finding — the worker can read while a serve
// runs — and it moves the VOYAGE_API_KEY requirement to the SERVE process (the worker no longer embeds).
//
// It plugs into the SAME `GbrainQueryExec` seam as the subprocess transport, so `buildCopilotDeps` selects
// subprocess OR http by config with no other change. AUTH is a pluggable `GbrainTokenProvider` seam — the
// "how does the worker authenticate to gbrain" decision is a wiring choice (DCR self-registration here as
// the batteries-included default for a local self-hosted brain; a SecretsPort-preprovisioned token — the
// `GbrainReadGrant.tokenRef` model — is a drop-in alternative), NOT baked into the transport.
//
// LOOPBACK-ONLY: the `question` (which for an employer-work ask can carry employer context) rides in the
// POST body, so this transport reads ONLY a loopback `gbrain serve` (rule 5 — an off-box gbrain read is an
// un-vetoed egress). A non-loopback baseUrl fails closed. DETERMINISTIC (TDD'd with a fake fetch/token):
// the JSON-RPC request builder, the SSE/JSON response parser, the MCP tool-result → hits extraction, the
// reactive 401→refresh→retry, and the DCR/token mapping. The real fetch + OAuth handshake are gated.
import { err, isOk, failure } from "@sow/contracts";
import type { FailureVariant, Result } from "@sow/contracts";
import type { GbrainQueryExec } from "./copilotGbrainSubprocess";

/** A minimal fetch-like seam (a subset of the global `fetch` — Node 22's Response satisfies it). */
export type FetchLike = (
  url: string,
  init?: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string },
) => Promise<{ readonly status: number; readonly text: () => Promise<string> }>;

/**
 * The auth seam: hand out a bearer token for the gbrain MCP endpoint. `forceRefresh` bypasses any cached
 * token (used after a 401). Fail-closed (a typed err) when a token can't be obtained. The transport is
 * agnostic to HOW the token is produced (DCR self-registration, a SecretsPort-preprovisioned token, …).
 */
export interface GbrainTokenProvider {
  readonly getToken: (forceRefresh: boolean) => Promise<Result<string, FailureVariant>>;
}

/** The default local `gbrain serve --http` base URL (the port gbrain's http MCP server binds by default). */
export const DEFAULT_GBRAIN_HTTP_URL = "http://127.0.0.1:8899";

/**
 * PURE: is `baseUrl` a loopback URL? Parses via the URL API (which isolates the authority correctly — a
 * userinfo-spoof like `http://evil.com/@127.0.0.1` is NOT loopback, LESSONS contracts §4) and checks the
 * hostname against the loopback set. Anything unparseable / non-loopback → false (the caller fails closed).
 */
export function isLoopbackUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  // `new URL("http://[::1]:8899").hostname` === "::1"; strip any lingering brackets defensively.
  const h = host.replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h.startsWith("127.");
}

/** PURE: the JSON-RPC `tools/call` body for the gbrain `query` tool. */
export function buildMcpQueryRequest(
  question: string,
  limit: number,
  id: number,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "query", arguments: { query: question, limit } },
  };
}

/**
 * PURE: extract the JSON-RPC RESPONSE object from an HTTP response body. gbrain streams the reply as SSE
 * frames (`event: message\ndata: {…}`), and a single response may carry MULTIPLE frames (e.g. a progress
 * notification BEFORE the result), so we collect every parseable `data:` payload and PREFER the JSON-RPC
 * response frame (one carrying `result` or `error`) over an intermediate notification; else the last
 * parseable frame; else — no SSE framing — the whole body as JSON. Returns `undefined` when nothing parses
 * (the caller then fails closed) — never throws.
 */
export function parseMcpSseBody(body: string): unknown {
  const frames: unknown[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("data:")) {
      try {
        frames.push(JSON.parse(trimmed.slice("data:".length).trim()));
      } catch {
        // skip an unparseable data: line; a later frame may parse
      }
    }
  }
  if (frames.length === 0) {
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  const response = frames.find(
    (f) => typeof f === "object" && f !== null && ("result" in f || "error" in f),
  );
  return response ?? frames[frames.length - 1];
}

/** Fail-closed err for a DETERMINISTIC bad MCP result — NOT retryable (a retry reproduces the same shape). */
function mcpFault(code: string, message: string): FailureVariant {
  return failure("degraded_unavailable", message, { cause: { code } });
}

/**
 * PURE: an MCP `tools/call` envelope → the gbrain hits array (as `unknown`, for `normalizeGbrainHits` +
 * `parseGbrainSearchResult`). gbrain returns the hits as a JSON STRING inside `result.content[0].text`.
 * Fail-closed on a JSON-RPC error, an `isError` tool result, a missing/!text content, or non-JSON text —
 * never fabricates context. Never throws.
 */
export function parseMcpToolCallResult(envelope: unknown): Result<unknown, FailureVariant> {
  if (typeof envelope !== "object" || envelope === null) {
    return err(mcpFault("GBRAIN_HTTP_MALFORMED", "gbrain http reply was not an object"));
  }
  const obj = envelope as Record<string, unknown>;
  if ("error" in obj && obj["error"] !== undefined && obj["error"] !== null) {
    return err(mcpFault("GBRAIN_HTTP_MCP_ERROR", "gbrain http returned a JSON-RPC error"));
  }
  const result = obj["result"];
  if (typeof result !== "object" || result === null) {
    return err(mcpFault("GBRAIN_HTTP_MALFORMED", "gbrain http reply has no result"));
  }
  const res = result as Record<string, unknown>;
  if (res["isError"] === true) {
    return err(mcpFault("GBRAIN_HTTP_TOOL_ERROR", "gbrain query tool reported an error"));
  }
  const content = res["content"];
  if (!Array.isArray(content) || content.length === 0) {
    return err(mcpFault("GBRAIN_HTTP_MALFORMED", "gbrain http reply has no content"));
  }
  const first: unknown = content[0];
  const text = typeof first === "object" && first !== null ? (first as Record<string, unknown>)["text"] : undefined;
  if (typeof text !== "string") {
    return err(mcpFault("GBRAIN_HTTP_MALFORMED", "gbrain http content had no text"));
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return err(mcpFault("GBRAIN_HTTP_MALFORMED", "gbrain http content text was not JSON"));
  }
}

/** Deps for the http transport. */
export interface GbrainHttpExecDeps {
  /** The gbrain serve base URL (no trailing slash), e.g. "http://127.0.0.1:8899". MUST be loopback. */
  readonly baseUrl: string;
  /** The bearer-token seam (DCR / SecretsPort / …). */
  readonly tokenProvider: GbrainTokenProvider;
  /** Injectable fetch (defaults to a timeout-wrapped global fetch). */
  readonly fetchFn?: FetchLike;
  /** Per-request timeout (ms). Defaults to 60_000. */
  readonly timeoutMs?: number;
}

/** The default fetch: global fetch with an AbortSignal timeout. Redaction happens at the call site. */
function defaultFetch(timeoutMs: number): FetchLike {
  return async (url, init) =>
    fetch(url, {
      ...(init?.method !== undefined ? { method: init.method } : {}),
      ...(init?.headers !== undefined ? { headers: init.headers } : {}),
      ...(init?.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
}

/**
 * Build a `GbrainQueryExec` over the gbrain MCP-over-HTTP endpoint. Sends a `tools/call query` with the
 * bearer token; on a 401 it refreshes the token ONCE and retries (a rotated/expired token self-heals);
 * a persistent 401, a non-2xx status, a thrown fetch, a malformed body, or a NON-LOOPBACK baseUrl all fail
 * closed with a typed, redaction-safe fault (the fetch/SDK error is dropped — only a stable code crosses,
 * §16 / safety 7). Never throws. The returned hits feed `normalizeGbrainHits` + `parseGbrainSearchResult`.
 */
export function createGbrainHttpExec(deps: GbrainHttpExecDeps): GbrainQueryExec {
  const timeout = deps.timeoutMs ?? 60_000;
  const doFetch = deps.fetchFn ?? defaultFetch(timeout);
  const loopback = isLoopbackUrl(deps.baseUrl);
  const mcpUrl = `${deps.baseUrl}/mcp`;
  const post = async (
    token: string,
    question: string,
    limit: number,
  ): Promise<{ readonly status: number; readonly body: string }> => {
    const res = await doFetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(buildMcpQueryRequest(question, limit, 1)),
    });
    return { status: res.status, body: await res.text() };
  };
  return async (question, limit): Promise<Result<unknown, FailureVariant>> => {
    // Rule 5: the question can carry employer context — refuse to send it off-box (a non-loopback serve
    // read is an un-vetoed egress). Fail closed BEFORE any fetch or token request.
    if (!loopback) {
      return err(
        failure("validation_rejected", "gbrain http base url is not loopback", {
          cause: { code: "GBRAIN_HTTP_NON_LOOPBACK" },
        }),
      );
    }
    // Whole body in a try so NOTHING throws across the boundary (§16) — incl. a token-provider or a
    // mid-body `res.text()` rejection. The redaction-safe catch returns only a stable transport code.
    try {
      const first = await deps.tokenProvider.getToken(false);
      if (!isOk(first)) return first; // fail closed (typed) before any fetch
      let resp = await post(first.value, question, limit);
      if (resp.status === 401) {
        // Token likely expired/rotated — refresh once and retry. A second 401 is a real auth failure.
        const refreshed = await deps.tokenProvider.getToken(true);
        if (!isOk(refreshed)) return refreshed;
        resp = await post(refreshed.value, question, limit);
        if (resp.status === 401) {
          // Deterministic after a fresh token (an immediate re-drive won't self-heal) → NOT retryable.
          return err(
            failure("provider_failed", "gbrain http unauthorized after refresh", {
              cause: { code: "GBRAIN_HTTP_UNAUTHORIZED" },
            }),
          );
        }
      }
      if (resp.status < 200 || resp.status >= 300) {
        return err(
          failure("degraded_unavailable", "gbrain http non-2xx", {
            retryable: true,
            cause: { code: "GBRAIN_HTTP_STATUS" },
          }),
        );
      }
      const envelope = parseMcpSseBody(resp.body);
      if (envelope === undefined) {
        return err(mcpFault("GBRAIN_HTTP_MALFORMED", "gbrain http body did not parse"));
      }
      return parseMcpToolCallResult(envelope);
    } catch {
      // Redaction-safe: drop the fetch/abort/body-read error (may carry the URL/host) — only a stable code.
      return err(
        failure("degraded_unavailable", "gbrain http read failed", {
          retryable: true,
          cause: { code: "GBRAIN_HTTP_TRANSPORT" },
        }),
      );
    }
  };
}

// ── the DCR token provider (batteries-included default; OAuth 2.1 client_credentials) ────────────

/** Knobs for the DCR token provider. */
export interface GbrainDcrTokenProviderDeps {
  /** The gbrain serve base URL (no trailing slash). MUST be loopback (secrets travel to /token). */
  readonly baseUrl: string;
  /** Injectable fetch (defaults to a timeout-wrapped global fetch). */
  readonly fetchFn?: FetchLike;
  /** OAuth client name registered via DCR. Defaults to "sow-worker-copilot". */
  readonly clientName?: string;
  /** Requested scope. Defaults to "read" (the gbrain read scope). */
  readonly scope?: string;
  /** Per-request timeout (ms). Defaults to 30_000. */
  readonly timeoutMs?: number;
}

interface DcrClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** PURE: parse a DCR /register reply → the client id/secret, or null if malformed. */
function parseDcrRegister(text: string): DcrClient | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const clientId = j["client_id"];
    const clientSecret = j["client_secret"];
    if (typeof clientId === "string" && typeof clientSecret === "string") {
      return { clientId, clientSecret };
    }
    return null;
  } catch {
    return null;
  }
}

/** PURE: parse a /token reply → the access token, or null if malformed. */
function parseAccessToken(text: string): string | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const at = j["access_token"];
    return typeof at === "string" && at.length > 0 ? at : null;
  } catch {
    return null;
  }
}

/**
 * The batteries-included token provider for a LOCAL self-hosted gbrain: Dynamic Client Registration (RFC
 * 7591) once, then OAuth 2.1 `client_credentials` to mint a bearer token, cached and re-minted on
 * `forceRefresh`. Requires `gbrain serve --http --enable-dcr` on a LOOPBACK URL (the client_secret travels
 * to /token). Fail-closed + redaction-safe (only stable codes cross; no client_secret / token / error body
 * is surfaced). Never throws. Acquisition is SINGLE-FLIGHT — concurrent Copilot asks on a cold provider
 * share one in-flight register+mint (no duplicate DCR clients).
 *
 * (For a hardened deployment, swap this for a `GbrainTokenProvider` that resolves a pre-provisioned token
 * via SecretsPort — the `GbrainReadGrant.tokenRef` model — with no change to the transport.)
 */
export function createGbrainDcrTokenProvider(deps: GbrainDcrTokenProviderDeps): GbrainTokenProvider {
  const timeout = deps.timeoutMs ?? 30_000;
  const doFetch = deps.fetchFn ?? defaultFetch(timeout);
  const clientName = deps.clientName ?? "sow-worker-copilot";
  const scope = deps.scope ?? "read";
  const loopback = isLoopbackUrl(deps.baseUrl);
  let client: DcrClient | null = null;
  let cachedToken: string | null = null;
  let acquiring: Promise<Result<string, FailureVariant>> | null = null;

  const register = async (): Promise<Result<DcrClient, FailureVariant>> => {
    try {
      const res = await doFetch(`${deps.baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // redirect_uris is required by gbrain's DCR even for a client_credentials-only client.
        body: JSON.stringify({
          client_name: clientName,
          redirect_uris: ["http://127.0.0.1/callback"],
          grant_types: ["client_credentials"],
          token_endpoint_auth_method: "client_secret_post",
          scope,
        }),
      });
      const text = await res.text(); // inside the try — a mid-body reject must not throw the boundary (§16)
      const parsed = res.status >= 200 && res.status < 300 ? parseDcrRegister(text) : null;
      if (parsed === null) {
        return err(mcpFault("GBRAIN_DCR_REGISTER_FAILED", "gbrain DCR registration failed"));
      }
      return { ok: true, value: parsed };
    } catch {
      return err(
        failure("degraded_unavailable", "gbrain DCR registration failed", {
          retryable: true,
          cause: { code: "GBRAIN_DCR_REGISTER_FAILED" },
        }),
      );
    }
  };

  const fetchToken = async (c: DcrClient): Promise<Result<string, FailureVariant>> => {
    try {
      const form = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: c.clientId,
        client_secret: c.clientSecret,
        scope,
      });
      const res = await doFetch(`${deps.baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const text = await res.text(); // inside the try (§16)
      const token = res.status >= 200 && res.status < 300 ? parseAccessToken(text) : null;
      if (token === null) {
        return err(mcpFault("GBRAIN_TOKEN_FAILED", "gbrain token request failed"));
      }
      return { ok: true, value: token };
    } catch {
      return err(
        failure("degraded_unavailable", "gbrain token request failed", {
          retryable: true,
          cause: { code: "GBRAIN_TOKEN_FAILED" },
        }),
      );
    }
  };

  /** Register (once) + mint a token, caching both. Called only via the single-flight `acquiring` guard. */
  const acquire = async (): Promise<Result<string, FailureVariant>> => {
    if (client === null) {
      const reg = await register();
      if (!isOk(reg)) return reg;
      client = reg.value;
    }
    const tok = await fetchToken(client);
    if (isOk(tok)) cachedToken = tok.value;
    return tok;
  };

  return {
    getToken: async (forceRefresh): Promise<Result<string, FailureVariant>> => {
      if (!loopback) {
        return err(
          failure("validation_rejected", "gbrain http base url is not loopback", {
            cause: { code: "GBRAIN_HTTP_NON_LOOPBACK" },
          }),
        );
      }
      if (!forceRefresh && cachedToken !== null) return { ok: true, value: cachedToken };
      if (forceRefresh) cachedToken = null;
      // Single-flight: concurrent cold getToken calls share ONE register+mint (no duplicate DCR clients).
      if (acquiring === null) {
        acquiring = acquire().finally(() => {
          acquiring = null;
        });
      }
      return acquiring;
    },
  };
}
