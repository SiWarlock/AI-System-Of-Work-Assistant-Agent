// §9.6-real #2 http-grant transport — the MANDATED transport:"http" GbrainReadGrant read path.
//
// Reads gbrain over its `serve --http` MCP-over-HTTP endpoint (OAuth 2.1) instead of the subprocess CLI —
// so the worker reads WHILE a `gbrain serve` owns the single-connection PGlite DB (the fix for the P3-live
// lock finding), and the SERVE process (not the worker) needs VOYAGE_API_KEY. Behind the SAME
// GbrainQueryExec seam, so `buildCopilotDeps` picks subprocess OR http by config.
//
// This suite pins the DETERMINISTIC surface with a fake fetch + fake token provider: the JSON-RPC request
// builder, the SSE/JSON response parser, the MCP tool-result → hits extraction (which the P3.1 mapper then
// consumes), the reactive 401→refresh→retry, and the DCR/client_credentials request/response mapping. The
// real fetch + real OAuth handshake are integration-tested behind SOW_P3_LIVE=1.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, failure } from "@sow/contracts";
import type { FailureVariant, Result } from "@sow/contracts";
import { parseGbrainSearchResult } from "../../../src/api/procedures/copilotGbrainRetrieval";
import { normalizeGbrainHits } from "../../../src/api/procedures/copilotGbrainSubprocess";
import {
  buildMcpQueryRequest,
  buildMcpToolCallRequest,
  parseMcpSseBody,
  parseMcpToolCallResult,
  extractMcpResultEnvelope,
  createGbrainHttpExec,
  createGbrainMcpToolCallExec,
  createGbrainDcrTokenProvider,
  isLoopbackUrl,
} from "../../../src/api/procedures/copilotGbrainHttp";
import type { FetchLike, GbrainTokenProvider } from "../../../src/api/procedures/copilotGbrainHttp";

/** A canned gbrain hits array (the JSON string gbrain wraps in the MCP tool result). */
const HITS = [
  { slug: "sessions/028", chunk_text: "the egress notice text", title: "Session 028", source_id: "default" },
];
/** The MCP tool-call envelope gbrain returns: hits are a JSON STRING inside result.content[0].text. */
function mcpEnvelope(hits: unknown, id = 2): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(hits) }] } };
}
/** Wrap a JSON object as an SSE `event: message\ndata: {…}` body (how gbrain streams the reply). */
function sse(obj: unknown): string {
  return `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
}
/** A fake token provider that hands out a fixed token (records refresh calls via the getter). */
function fakeToken(token = "tok-1"): GbrainTokenProvider & { readonly refreshes: number } {
  const state = { refreshes: 0 };
  return {
    getToken: async (forceRefresh: boolean): Promise<Result<string, FailureVariant>> => {
      if (forceRefresh) state.refreshes++;
      return ok(forceRefresh ? `${token}-r${state.refreshes}` : token);
    },
    get refreshes(): number {
      return state.refreshes;
    },
  };
}

describe("buildMcpQueryRequest — the JSON-RPC tools/call body", () => {
  it("builds a tools/call for the gbrain `query` tool with {query,limit}", () => {
    expect(buildMcpQueryRequest("what did we decide?", 6, 2)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "query", arguments: { query: "what did we decide?", limit: 6 } },
    });
  });
});

describe("parseMcpSseBody — extract the JSON-RPC object from an SSE (or plain-JSON) body", () => {
  it("parses the `data:` line of an SSE frame", () => {
    const env = mcpEnvelope(HITS);
    expect(parseMcpSseBody(sse(env))).toEqual(env);
  });
  it("parses a plain-JSON body too (no SSE framing)", () => {
    const env = mcpEnvelope(HITS);
    expect(parseMcpSseBody(JSON.stringify(env))).toEqual(env);
  });
  it("returns undefined for an unparseable body (caller fails closed)", () => {
    expect(parseMcpSseBody("event: message\ndata: not json\n\n")).toBeUndefined();
    expect(parseMcpSseBody("")).toBeUndefined();
  });
  it("multi-frame SSE: prefers the JSON-RPC RESULT frame over a preceding progress notification", () => {
    const progress = { jsonrpc: "2.0", method: "notifications/progress", params: { pct: 50 } };
    const env = mcpEnvelope(HITS);
    const body = `${sse(progress)}${sse(env)}`;
    expect(parseMcpSseBody(body)).toEqual(env); // the result frame, not the notification
  });
  it("multi-frame SSE: prefers an ERROR frame too (not an intermediate notification)", () => {
    const note = { jsonrpc: "2.0", method: "notifications/message", params: {} };
    const errFrame = { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "x" } };
    expect(parseMcpSseBody(`${sse(note)}${sse(errFrame)}`)).toEqual(errFrame);
  });
});

describe("parseMcpToolCallResult — MCP envelope → the gbrain hits array (fail-closed)", () => {
  it("extracts and JSON-parses result.content[0].text into the hits array", () => {
    const r = parseMcpToolCallResult(mcpEnvelope(HITS));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toEqual(HITS);
  });
  it("a JSON-RPC error envelope fails closed (MCP_ERROR)", () => {
    const r = parseMcpToolCallResult({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "boom" } });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("GBRAIN_HTTP_MCP_ERROR");
  });
  it("a tool isError result fails closed (the tool itself reported failure)", () => {
    const r = parseMcpToolCallResult({
      jsonrpc: "2.0",
      id: 2,
      result: { isError: true, content: [{ type: "text", text: "tool failed" }] },
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("GBRAIN_HTTP_TOOL_ERROR");
  });
  it("a malformed envelope (no content text) fails closed", () => {
    expect(isErr(parseMcpToolCallResult({ jsonrpc: "2.0", id: 2, result: {} }))).toBe(true);
    expect(isErr(parseMcpToolCallResult({ jsonrpc: "2.0", id: 2, result: { content: [] } }))).toBe(true);
    expect(isErr(parseMcpToolCallResult({ nope: true }))).toBe(true);
  });
  it("content text that is not JSON fails closed", () => {
    const r = parseMcpToolCallResult({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "{" }] } });
    expect(isErr(r)).toBe(true);
  });
});

describe("createGbrainHttpExec — the GbrainQueryExec over MCP-over-HTTP", () => {
  /** A fake fetch that returns a scripted sequence of {status, body} by call index. */
  function fakeFetch(script: Array<{ status: number; body: string }>): {
    readonly fetchFn: FetchLike;
    readonly calls: Array<{ url: string; auth: string | undefined; body: string }>;
  } {
    const calls: Array<{ url: string; auth: string | undefined; body: string }> = [];
    let i = 0;
    const fetchFn: FetchLike = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: headers["Authorization"], body: String(init?.body ?? "") });
      const step = script[Math.min(i, script.length - 1)];
      i++;
      return { status: step!.status, text: async () => step!.body };
    };
    return { fetchFn, calls };
  }

  it("posts tools/call to <baseUrl>/mcp with the Bearer token and maps the hits", async () => {
    const { fetchFn, calls } = fakeFetch([{ status: 200, body: sse(mcpEnvelope(HITS)) }]);
    const exec = createGbrainHttpExec({ baseUrl: "http://127.0.0.1:8899", tokenProvider: fakeToken("abc"), fetchFn });
    const r = await exec("q?", 6);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8899/mcp");
    expect(calls[0]!.auth).toBe("Bearer abc");
    expect(JSON.parse(calls[0]!.body).params).toEqual({ name: "query", arguments: { query: "q?", limit: 6 } });
    expect(isOk(r)).toBe(true);
    // the returned hits feed the P3.1 pipeline unchanged
    if (isOk(r)) {
      const ctx = parseGbrainSearchResult("personal-business", normalizeGbrainHits(r.value), 6);
      expect(isOk(ctx)).toBe(true);
      if (isOk(ctx)) expect(ctx.value.sources[0]!.citationId).toBe("gbrain:sessions:028");
    }
  });

  it("on a 401 refreshes the token ONCE and retries; the retry uses the refreshed token", async () => {
    const { fetchFn, calls } = fakeFetch([
      { status: 401, body: "unauthorized" },
      { status: 200, body: sse(mcpEnvelope(HITS)) },
    ]);
    const tp = fakeToken("t");
    const exec = createGbrainHttpExec({ baseUrl: "http://127.0.0.1:8899", tokenProvider: tp, fetchFn });
    const r = await exec("q", 3);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.auth).toBe("Bearer t"); // first with cached token
    expect(calls[1]!.auth).toBe("Bearer t-r1"); // retry with the refreshed token
    expect(isOk(r)).toBe(true);
  });

  it("a persistent 401 (even after refresh) fails closed, NOT retryable (a re-drive won't self-heal)", async () => {
    const { fetchFn, calls } = fakeFetch([{ status: 401, body: "no" }]);
    const exec = createGbrainHttpExec({ baseUrl: "http://127.0.0.1:8899", tokenProvider: fakeToken(), fetchFn });
    const r = await exec("q", 3);
    expect(calls).toHaveLength(2); // one refresh+retry, then give up
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.cause?.code).toBe("GBRAIN_HTTP_UNAUTHORIZED");
      expect(r.error.retryable ?? false).toBe(false); // deterministic after a fresh token
    }
  });

  it("a non-2xx (e.g. 500) fails closed as a retryable transport fault", async () => {
    const { fetchFn } = fakeFetch([{ status: 500, body: "err" }]);
    const exec = createGbrainHttpExec({ baseUrl: "http://127.0.0.1:8899", tokenProvider: fakeToken(), fetchFn });
    const r = await exec("q", 3);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.retryable).toBe(true);
      expect(r.error.cause?.code).toBe("GBRAIN_HTTP_STATUS");
    }
  });

  it("a NON-LOOPBACK baseUrl fails closed BEFORE any fetch (rule 5 — no off-box question egress)", async () => {
    const { fetchFn, calls } = fakeFetch([{ status: 200, body: sse(mcpEnvelope(HITS)) }]);
    const exec = createGbrainHttpExec({ baseUrl: "http://evil.example.com:8899", tokenProvider: fakeToken(), fetchFn });
    const r = await exec("employer secret?", 3);
    expect(calls).toHaveLength(0);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("GBRAIN_HTTP_NON_LOOPBACK");
  });

  it("a token-provider failure fails closed BEFORE any fetch", async () => {
    const failing: GbrainTokenProvider = {
      getToken: async () => err(failure("degraded_unavailable", "no token", { cause: { code: "X" } })),
    };
    const { fetchFn, calls } = fakeFetch([{ status: 200, body: sse(mcpEnvelope(HITS)) }]);
    const exec = createGbrainHttpExec({ baseUrl: "http://127.0.0.1:8899", tokenProvider: failing, fetchFn });
    const r = await exec("q", 3);
    expect(calls).toHaveLength(0);
    expect(isErr(r)).toBe(true);
  });

  it("a fetch that throws folds to a typed retryable fault (never throws)", async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:8899 secret-in-message");
    };
    const exec = createGbrainHttpExec({ baseUrl: "http://127.0.0.1:8899", tokenProvider: fakeToken(), fetchFn });
    const r = await exec("q", 3);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.cause?.code).toBe("GBRAIN_HTTP_TRANSPORT");
      expect(r.error.message).not.toContain("secret-in-message"); // redaction-safe
    }
  });
});

describe("createGbrainDcrTokenProvider — DCR + client_credentials (deterministic mapping, fake fetch)", () => {
  function scriptFetch(steps: Array<(url: string, body: string) => { status: number; body: string }>): {
    readonly fetchFn: FetchLike;
    readonly calls: string[];
  } {
    const calls: string[] = [];
    let i = 0;
    const fetchFn: FetchLike = async (url, init) => {
      const body = String(init?.body ?? "");
      calls.push(url);
      const step = steps[Math.min(i, steps.length - 1)]!;
      i++;
      const { status, body: b } = step(url, body);
      return { status, text: async () => b };
    };
    return { fetchFn, calls };
  }

  it("registers a client (DCR) then exchanges client_credentials for a bearer token", async () => {
    const { fetchFn, calls } = scriptFetch([
      (url) => {
        expect(url).toContain("/register");
        return { status: 201, body: JSON.stringify({ client_id: "cid", client_secret: "sec" }) };
      },
      (url, body) => {
        expect(url).toContain("/token");
        expect(body).toContain("grant_type=client_credentials");
        expect(body).toContain("client_id=cid");
        return { status: 200, body: JSON.stringify({ access_token: "AT", token_type: "bearer", expires_in: 3600 }) };
      },
    ]);
    const tp = createGbrainDcrTokenProvider({ baseUrl: "http://127.0.0.1:8899", fetchFn });
    const r = await tp.getToken(false);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe("AT");
    // second getToken (no force) reuses the cached client AND token — no re-register, no re-token
    const r2 = await tp.getToken(false);
    expect(isOk(r2) && r2.value).toBe("AT");
    expect(calls).toEqual(["http://127.0.0.1:8899/register", "http://127.0.0.1:8899/token"]);
  });

  it("forceRefresh re-fetches a token (reusing the cached client), not a new registration", async () => {
    let tokenN = 0;
    const { fetchFn, calls } = scriptFetch([
      () => ({ status: 201, body: JSON.stringify({ client_id: "cid", client_secret: "sec" }) }),
      () => ({ status: 200, body: JSON.stringify({ access_token: `AT${++tokenN}`, expires_in: 3600 }) }),
    ]);
    const tp = createGbrainDcrTokenProvider({ baseUrl: "http://127.0.0.1:8899", fetchFn });
    const a = await tp.getToken(false);
    const b = await tp.getToken(true); // force refresh
    expect(isOk(a) && a.value).toBe("AT1");
    expect(isOk(b) && b.value).toBe("AT2");
    // register once, token twice — no second /register
    expect(calls.filter((u) => u.includes("/register"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("/token"))).toHaveLength(2);
  });

  it("a failed registration fails closed (no token)", async () => {
    const { fetchFn } = scriptFetch([() => ({ status: 400, body: '{"error":"invalid_client_metadata"}' })]);
    const tp = createGbrainDcrTokenProvider({ baseUrl: "http://127.0.0.1:8899", fetchFn });
    const r = await tp.getToken(false);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("GBRAIN_DCR_REGISTER_FAILED");
  });

  it("a token endpoint failure fails closed", async () => {
    const { fetchFn } = scriptFetch([
      () => ({ status: 201, body: JSON.stringify({ client_id: "c", client_secret: "s" }) }),
      () => ({ status: 401, body: '{"error":"invalid_client"}' }),
    ]);
    const tp = createGbrainDcrTokenProvider({ baseUrl: "http://127.0.0.1:8899", fetchFn });
    const r = await tp.getToken(false);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("GBRAIN_TOKEN_FAILED");
  });

  it("a THROWN fetch during /register folds to a typed RETRYABLE fault (never throws, §16)", async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error("ECONNREFUSED secret-host");
    };
    const tp = createGbrainDcrTokenProvider({ baseUrl: "http://127.0.0.1:8899", fetchFn });
    const r = await tp.getToken(false);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.cause?.code).toBe("GBRAIN_DCR_REGISTER_FAILED");
      expect(r.error.retryable).toBe(true);
      expect(r.error.message).not.toContain("secret-host");
    }
  });

  it("a THROWN fetch during /token (after a good register) folds to a typed retryable fault", async () => {
    let n = 0;
    const fetchFn: FetchLike = async (url) => {
      n++;
      if (url.includes("/register")) {
        return { status: 201, text: async () => JSON.stringify({ client_id: "c", client_secret: "s" }) };
      }
      throw new Error("socket hang up");
    };
    const tp = createGbrainDcrTokenProvider({ baseUrl: "http://127.0.0.1:8899", fetchFn });
    const r = await tp.getToken(false);
    expect(n).toBe(2);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.cause?.code).toBe("GBRAIN_TOKEN_FAILED");
      expect(r.error.retryable).toBe(true);
    }
  });

  it("a 2xx register with a malformed body (no client_id) fails closed", async () => {
    const { fetchFn } = scriptFetch([() => ({ status: 200, body: '{"unexpected":"shape"}' })]);
    const tp = createGbrainDcrTokenProvider({ baseUrl: "http://127.0.0.1:8899", fetchFn });
    const r = await tp.getToken(false);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("GBRAIN_DCR_REGISTER_FAILED");
  });

  it("a 2xx token with a malformed body (no access_token) fails closed", async () => {
    const { fetchFn } = scriptFetch([
      () => ({ status: 201, body: JSON.stringify({ client_id: "c", client_secret: "s" }) }),
      () => ({ status: 200, body: '{"token_type":"bearer"}' }), // no access_token
    ]);
    const tp = createGbrainDcrTokenProvider({ baseUrl: "http://127.0.0.1:8899", fetchFn });
    const r = await tp.getToken(false);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("GBRAIN_TOKEN_FAILED");
  });

  it("single-flight: concurrent cold getToken(false) share ONE register + ONE token (no duplicate clients)", async () => {
    const { fetchFn, calls } = scriptFetch([
      () => ({ status: 201, body: JSON.stringify({ client_id: "c", client_secret: "s" }) }),
      () => ({ status: 200, body: JSON.stringify({ access_token: "AT", expires_in: 3600 }) }),
    ]);
    const tp = createGbrainDcrTokenProvider({ baseUrl: "http://127.0.0.1:8899", fetchFn });
    const [a, b, c] = await Promise.all([tp.getToken(false), tp.getToken(false), tp.getToken(false)]);
    expect([a, b, c].every((r) => isOk(r) && r.value === "AT")).toBe(true);
    expect(calls.filter((u) => u.includes("/register"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("/token"))).toHaveLength(1);
  });

  it("a NON-LOOPBACK baseUrl fails closed before any register/token (no secret off-box)", async () => {
    const { fetchFn, calls } = scriptFetch([() => ({ status: 201, body: "{}" })]);
    const tp = createGbrainDcrTokenProvider({ baseUrl: "http://gbrain.example.com", fetchFn });
    const r = await tp.getToken(false);
    expect(calls).toHaveLength(0);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("GBRAIN_HTTP_NON_LOOPBACK");
  });
});

describe("isLoopbackUrl — the rule-5 egress guard", () => {
  it("accepts loopback hosts", () => {
    for (const u of ["http://127.0.0.1:8899", "http://localhost:8899", "http://[::1]:8899", "http://127.0.0.2"]) {
      expect(isLoopbackUrl(u)).toBe(true);
    }
  });
  it("rejects non-loopback + userinfo-spoofed + unparseable URLs", () => {
    for (const u of ["http://evil.example.com:8899", "http://evil.com/@127.0.0.1", "https://10.0.0.5", "not a url"]) {
      expect(isLoopbackUrl(u)).toBe(false);
    }
  });
});

// GATED live smoke: the REAL DCR + client_credentials + MCP-over-HTTP flow against a running
// `gbrain serve --http --enable-dcr`. SKIPPED unless SOW_P3_LIVE=1 (needs the server + a populated brain).
// Unlike the subprocess transport, this COEXISTS with the serve (one server owns the PGlite DB).
describe.skipIf(process.env["SOW_P3_LIVE"] !== "1")("LIVE http transport — real gbrain serve --http", () => {
  it("DCR → token → tools/call query → grounded context", async () => {
    const baseUrl = process.env["SOW_GBRAIN_HTTP_URL"] ?? "http://127.0.0.1:8899";
    const exec = createGbrainHttpExec({ baseUrl, tokenProvider: createGbrainDcrTokenProvider({ baseUrl }) });
    const r = await exec("What did we decide about the Employer-Work egress veto in the Copilot?", 4);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const ctx = parseGbrainSearchResult("personal-business", normalizeGbrainHits(r.value), 4);
      expect(isOk(ctx)).toBe(true);
      if (isOk(ctx)) {
        expect(ctx.value.blocks.length).toBeGreaterThan(0);
        expect(ctx.value.sources.every((s) => s.citationId.startsWith("gbrain:"))).toBe(true);
      }
    }
  }, 30_000);
});

// ── SC8a (§13.10 gate a) — the generic MCP-call exec for the SC7 gbrain proxy ────────────────────────────

describe("buildMcpToolCallRequest — a generic JSON-RPC tools/call body", () => {
  it("wraps an arbitrary op + args (query stays a special case)", () => {
    expect(buildMcpToolCallRequest("traverse_graph", { slug: "personal-business/x", depth: 2 }, 1)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "traverse_graph", arguments: { slug: "personal-business/x", depth: 2 } },
    });
    // buildMcpQueryRequest is now this builder specialized to `query`
    expect(buildMcpQueryRequest("q", 3, 1)).toEqual(buildMcpToolCallRequest("query", { query: "q", limit: 3 }, 1));
  });
});

describe("extractMcpResultEnvelope — MCP envelope → the RAW tool result object (fail-closed)", () => {
  it("returns result verbatim (the {content:[…]} envelope SC5b parses), NOT the parsed hits", () => {
    const env = mcpEnvelope(HITS);
    const r = extractMcpResultEnvelope(env);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toEqual({ content: [{ type: "text", text: JSON.stringify(HITS) }] });
  });
  it("fails closed on a JSON-RPC error / isError tool result / missing result / non-object", () => {
    expect(isErr(extractMcpResultEnvelope({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "x" } }))).toBe(true);
    expect(isErr(extractMcpResultEnvelope({ jsonrpc: "2.0", id: 1, result: { content: [], isError: true } }))).toBe(true);
    expect(isErr(extractMcpResultEnvelope({ jsonrpc: "2.0", id: 1 }))).toBe(true);
    expect(isErr(extractMcpResultEnvelope("nope"))).toBe(true);
  });
});

describe("createGbrainMcpToolCallExec — the SC7 proxy's raw-envelope exec over MCP-over-HTTP", () => {
  function fakeFetch(script: Array<{ status: number; body: string }>): {
    readonly fetchFn: FetchLike;
    readonly calls: Array<{ url: string; auth: string | undefined; body: string }>;
  } {
    const calls: Array<{ url: string; auth: string | undefined; body: string }> = [];
    let i = 0;
    const fetchFn: FetchLike = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: headers["Authorization"], body: String(init?.body ?? "") });
      const step = script[Math.min(i, script.length - 1)];
      i++;
      return { status: step!.status, text: async () => step!.body };
    };
    return { fetchFn, calls };
  }

  it("posts tools/call for the op stripped from mcp__gbrain__<op> and returns the RAW result envelope", async () => {
    const nodes = [{ slug: "personal-business/root", links: [] }];
    const { fetchFn, calls } = fakeFetch([{ status: 200, body: sse(mcpEnvelope(nodes)) }]);
    const exec = createGbrainMcpToolCallExec({ baseUrl: "http://127.0.0.1:8899", tokenProvider: fakeToken("abc"), fetchFn });
    const r = await exec("mcp__gbrain__traverse_graph", { slug: "personal-business/root", depth: 1 });
    expect(calls[0]!.url).toBe("http://127.0.0.1:8899/mcp");
    expect(calls[0]!.auth).toBe("Bearer abc");
    // the op is the mcp__gbrain__ suffix; the args are forwarded verbatim
    expect(JSON.parse(calls[0]!.body).params).toEqual({ name: "traverse_graph", arguments: { slug: "personal-business/root", depth: 1 } });
    expect(isOk(r)).toBe(true);
    // the RAW envelope (not parsed hits) — exactly what SC5b's redactGbrainToolResult consumes
    if (isOk(r)) expect(r.value).toEqual({ content: [{ type: "text", text: JSON.stringify(nodes) }] });
  });

  it("a non-gbrain tool name (and a bare mcp__gbrain__ with no op) fails closed BEFORE any fetch", async () => {
    const { fetchFn, calls } = fakeFetch([{ status: 200, body: sse(mcpEnvelope([])) }]);
    const exec = createGbrainMcpToolCallExec({ baseUrl: "http://127.0.0.1:8899", tokenProvider: fakeToken(), fetchFn });
    for (const bad of ["mcp__vault__read", "mcp__gbrain__"]) {
      const r = await exec(bad, { path: "x" });
      expect(isErr(r), bad).toBe(true);
      if (isErr(r)) {
        expect(r.error.cause?.code, bad).toBe("GBRAIN_HTTP_NOT_GBRAIN_TOOL");
        expect(r.error.kind, bad).toBe("validation_rejected"); // a config mismatch, not a transient fault
      }
    }
    expect(calls).toHaveLength(0); // no read happened for either
  });

  it("a NON-LOOPBACK base url fails closed BEFORE any fetch (no off-box egress of tool args)", async () => {
    const { fetchFn, calls } = fakeFetch([{ status: 200, body: sse(mcpEnvelope([])) }]);
    const exec = createGbrainMcpToolCallExec({ baseUrl: "https://gbrain.example.com", tokenProvider: fakeToken(), fetchFn });
    const r = await exec("mcp__gbrain__query", { query: "q" });
    expect(calls).toHaveLength(0);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("GBRAIN_HTTP_NON_LOOPBACK");
  });

  it("shares the 401→refresh→retry plumbing (a rotated token self-heals)", async () => {
    const { fetchFn, calls } = fakeFetch([
      { status: 401, body: "unauthorized" },
      { status: 200, body: sse(mcpEnvelope([{ slug: "personal-business/a" }])) },
    ]);
    const exec = createGbrainMcpToolCallExec({ baseUrl: "http://127.0.0.1:8899", tokenProvider: fakeToken("t"), fetchFn });
    const r = await exec("mcp__gbrain__query", { query: "q" });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.auth).toBe("Bearer t-r1"); // retry with the refreshed token
    expect(isOk(r)).toBe(true);
  });

  it("a JSON-RPC error / tool isError from gbrain fails closed", async () => {
    const { fetchFn } = fakeFetch([{ status: 200, body: sse({ jsonrpc: "2.0", id: 1, result: { content: [], isError: true } }) }]);
    const exec = createGbrainMcpToolCallExec({ baseUrl: "http://127.0.0.1:8899", tokenProvider: fakeToken(), fetchFn });
    const r = await exec("mcp__gbrain__query", { query: "q" });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("GBRAIN_HTTP_TOOL_ERROR");
  });
});
