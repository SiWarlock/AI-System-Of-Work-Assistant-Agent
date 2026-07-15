// spec(§8) spec(§5) — Linear issues read-only GraphQL transport: a thin LINEAR_HTTP_SPEC over the template's
// slice-1 POST+body path. The FIRST GraphQL-over-POST connector. Pins the load-bearing GraphQL invariants:
//   • READ-ONLY / query-only — LINEAR_ISSUES_QUERY is a fixed `query` (never a `mutation`) — the ING-7 pin at
//     the spec level (the transport can't inspect an opaque body);
//   • GraphQL-injection — the cursor rides `variables.after` (JSON.stringify-escaped), NEVER interpolated;
//   • GraphQL-200-errors — Linear returns HTTP 200 even on a query error (`{errors:[…]}`) ⇒ linearMapPage
//     fail-closes (the positive-2xx gate alone is not the error signal);
//   • SSRF-on-POST + rule-7 (token Authorization-only, never in the body) — inherited from the template.
// Fakes only: the real HttpTransport + SecretsAccessor + Linear token stay UNBOUND.
import { describe, it, expect } from "vitest";
import { ok, isErr } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type {
  HttpTransport,
  HttpTransportRequest,
  HttpTransportResponse,
  SecretsAccessor,
  SecretUnavailable,
} from "../src/connectors/adapters/http-transport";
import { createLinearHttpTransport, createLinearConnector } from "../src/connectors/adapters/linear";
import type { TransportRequest } from "../src/connectors/transport";

const TOKEN = "lin_oauth2_access_token_secret";
const TOKEN_REF = "keychain:linear-oauth";
const REQ: TransportRequest = { readScope: "read" };

function fakeTransport(
  behavior: { response?: HttpTransportResponse; throw?: unknown } = {},
): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  return {
    calls,
    async send(req) {
      calls.push(req);
      if (behavior.throw !== undefined) throw behavior.throw;
      return behavior.response ?? { status: 200, body: JSON.stringify({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } }) };
    },
  };
}

function fakeSecrets(
  result: Result<string, SecretUnavailable> = ok(TOKEN),
): SecretsAccessor & { refs: string[] } {
  const refs: string[] = [];
  return {
    refs,
    async getSecret(ref) {
      refs.push(ref);
      return result;
    },
  };
}

const NODES = [
  { id: "iss_1", title: "A", updatedAt: "2026-01-27T15:30:00.000Z" },
  { id: "iss_2", title: "B", updatedAt: "2026-01-27T16:30:00.000Z" },
];
const page = (pageInfo: Record<string, unknown>, nodes: unknown[] = NODES): string =>
  JSON.stringify({ data: { issues: { nodes, pageInfo } } });

const lin = (transport: HttpTransport, req: TransportRequest = REQ) =>
  createLinearHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(req);

// ── 1. Candidate GraphQL page maps ⇒ TransportPage (arch_gap) ───────────────────
describe("createLinearHttpTransport — GraphQL issues page maps (arch_gap)", () => {
  it("hasNextPage:true + endCursor ⇒ items (id→recordId, distinct payloadHash({id,updatedAt}), raw=node), nextCursor, done=false", async () => {
    const res = await lin(fakeTransport({ response: { status: 200, body: page({ hasNextPage: true, endCursor: "c1" }) } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items.map((i) => i.id)).toEqual(["iss_1", "iss_2"]);
      expect(res.items[0]!.hash).toBeTruthy();
      expect(res.items[0]!.hash).not.toBe(res.items[1]!.hash);
      expect(res.items[0]!.raw).toEqual(NODES[0]);
      expect(res.nextCursor).toBe("c1");
      expect(res.done).toBe(false);
    }
  });

  it("hasNextPage:false ⇒ done=true, no nextCursor", async () => {
    const res = await lin(fakeTransport({ response: { status: 200, body: page({ hasNextPage: false }) } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.done).toBe(true);
      expect(res.nextCursor).toBeUndefined();
    }
  });

  it("contentHash falls back to hashing the raw node when updatedAt absent (still stable)", async () => {
    const body = page({ hasNextPage: false }, [{ id: "iss_x", title: "T" }]);
    const a = await lin(fakeTransport({ response: { status: 200, body } }));
    const b = await lin(fakeTransport({ response: { status: 200, body } }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.items[0]!.hash).toBeTruthy();
      expect(a.items[0]!.hash).toBe(b.items[0]!.hash);
    }
  });

  it("a benign errors:null alongside a valid data page ⇒ ok (a null errors field is NOT a fault)", async () => {
    const body = JSON.stringify({ data: { issues: { nodes: NODES, pageInfo: { hasNextPage: false } } }, errors: null });
    const res = await lin(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.items.map((i) => i.id)).toEqual(["iss_1", "iss_2"]);
  });

  it("an empty nodes[] page ⇒ ok, 0 items, done=true (a valid empty page, not a failure)", async () => {
    const res = await lin(fakeTransport({ response: { status: 200, body: page({ hasNextPage: false }, []) } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items).toHaveLength(0);
      expect(res.done).toBe(true);
    }
  });
});

// ── 2. STRICT hasNextPage pagination (mirrors Granola) ──────────────────────────
describe("createLinearHttpTransport — STRICT hasNextPage pagination (fail-closed, no loop)", () => {
  it.each([
    [page({ hasNextPage: "true", endCursor: "c1" }), 'hasNextPage string "true"'],
    [page({ hasNextPage: 1, endCursor: "c1" }), "hasNextPage number 1"],
    [page({ endCursor: "c1" }), "hasNextPage absent"],
    [page({ hasNextPage: false, endCursor: "c1" }), "hasNextPage false"],
    [page({ hasNextPage: true, endCursor: null }), "endCursor null"],
    [page({ hasNextPage: true }), "endCursor absent"],
    [page({ hasNextPage: true, endCursor: "" }), "endCursor empty"],
  ])("%s (%s) ⇒ done=true, no nextCursor", async (body) => {
    const res = await lin(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.done).toBe(true);
      expect(res.nextCursor).toBeUndefined();
    }
  });
});

// ── 3. READ-ONLY (query-only) + GraphQL-injection (variables, not interpolation) ─
describe("createLinearHttpTransport — query-only body + variables paging (no mutation, no injection)", () => {
  it("body is {query (query-only, NO mutation), variables:{first, after}}; a nasty cursor rides variables (JSON-escaped), never the query", async () => {
    const transport = fakeTransport({ response: { status: 200, body: page({ hasNextPage: false }) } });
    // a cursor that WOULD break/inject a string-interpolated GraphQL query
    const nastyCursor = 'c1"} injection { mutation { deleteIssue(id:"x") } } #';
    await createLinearHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })({ readScope: "read", cursor: nastyCursor });
    const raw = transport.calls[0]!.body!;
    const body = JSON.parse(raw) as { query: string; variables: { first: number; after: string | null } }; // parses ⇒ escaped
    expect(body.query).toContain("query");
    expect(body.query).not.toContain("mutation"); // ING-7 read-only: query-only, never a mutation
    expect(body.query).not.toContain("subscription");
    expect(body.variables.first).toBe(50);
    expect(body.variables.after).toBe(nastyCursor); // cursor rides variables.after verbatim (JSON.stringify-escaped)
    expect(body.query).not.toContain("deleteIssue"); // NOT interpolated into the query text
  });

  it("first page ⇒ variables.after is null (no cursor)", async () => {
    const transport = fakeTransport({ response: { status: 200, body: page({ hasNextPage: false }) } });
    await lin(transport);
    const body = JSON.parse(transport.calls[0]!.body!) as { variables: { after: string | null } };
    expect(body.variables.after).toBeNull();
  });
});

// ── 4. GraphQL-200-errors + malformed shapes fail-closed ────────────────────────
describe("createLinearHttpTransport — GraphQL-200-errors + malformed fail-closed", () => {
  it.each([
    ['{"errors":[{"message":"bad"}]}', "graphql 200-errors present (no data)"],
    ['{"errors":[{"message":"bad"}],"data":{"issues":{"nodes":[],"pageInfo":{}}}}', "errors present alongside partial data"],
    ['{"data":{}}', "missing data.issues"],
    ['{"data":{"issues":{"nodes":"nope","pageInfo":{}}}}', "nodes not an array"],
    ['{"data":{"issues":{"nodes":[{"title":"no id"}],"pageInfo":{}}}}', "node missing id"],
    ['{"data":{"issues":{"nodes":[42],"pageInfo":{}}}}', "node non-object"],
    ["null", "top-level null"],
    ["[]", "top-level array (not the envelope object)"],
  ])("fail-closed on %s (%s) ⇒ TransportFailure, never a false page", async (body) => {
    const res = await lin(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(false);
  });
});

// ── 5. SSRF-on-POST admission + rule-7 body-token-free + fault map ──────────────
describe("createLinearHttpTransport — POST admission + rule-7 (token never in body) + fault map", () => {
  it("admits api.linear.app over POST; token in Authorization only, NOWHERE in the body", async () => {
    const MARKER = "LINEAR-TOKEN-MARKER-not-in-body";
    const transport = fakeTransport({ response: { status: 200, body: page({ hasNextPage: false }) } });
    await createLinearHttpTransport({ transport, secrets: fakeSecrets(ok(MARKER)), tokenRef: TOKEN_REF })(REQ);
    const call = transport.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.startsWith("https://api.linear.app/graphql")).toBe(true);
    expect(call.headers.Authorization).toBe(`Bearer ${MARKER}`);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).not.toContain(MARKER); // token NEVER in the GraphQL body
    expect(call.url).not.toContain(MARKER);
  });

  it("a 401 ⇒ TransportFailure(auth_locked), safe status only, token never leaked", async () => {
    const transport = fakeTransport({ response: { status: 401, body: JSON.stringify({ message: "BODY_LEAK" }) } });
    const res = await lin(transport);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("auth_locked");
      expect(res.message).toContain("401");
      expect(res.message).not.toContain("BODY_LEAK");
    }
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });
});

// ── 6. End-to-end through createLinearConnector (POST transport) ────────────────
describe("createLinearHttpTransport — drives the whole ConnectorPort.fetch chain via createLinearConnector", () => {
  it("raw→records over the POST transport (recordId/contentHash/payload; done/nextCursor threaded)", async () => {
    const transport = fakeTransport({ response: { status: 200, body: page({ hasNextPage: true, endCursor: "c9" }) } });
    const port = createLinearConnector(createLinearHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF }));
    const fetched = await port.fetch();
    expect(isErr(fetched)).toBe(false);
    if (!isErr(fetched)) {
      expect(fetched.value.records.map((r) => r.recordId)).toEqual(["iss_1", "iss_2"]);
      expect(fetched.value.records[0]!.contentHash).toBeTruthy();
      expect(fetched.value.records[0]!.payload).toEqual(NODES[0]);
      expect(fetched.value.nextCursor).toBe("c9");
      expect(fetched.value.done).toBe(false);
    }
    expect(transport.calls[0]!.method).toBe("POST");
    expect(transport.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});
