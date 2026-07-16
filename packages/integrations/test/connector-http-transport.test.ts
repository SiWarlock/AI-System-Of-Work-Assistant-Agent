// spec(§8) spec(§5) spec(§16) — the reusable read-only connector HTTP transport
// template (createConnectorHttpTransport) + its first instance (Asana). Mirrors the
// GbrainReadClient / knowledge Lesson 1 pattern but produces a ConnectorTransport:
// SSRF-guard (the vetted isAllowedRemoteEndpoint) BEFORE token + dispatch · token
// from an injected SecretsAccessor (header-only, fail-closed even on a THROWING
// accessor) · a redacted typed TransportFailure behind a positive-2xx gate · the
// Asana wire shape a documented candidate (arch_gap) · ING-7 read-only (GET).
// Tested ENTIRELY over fakes — zero real network / secrets (the real HttpTransport +
// SecretsAccessor stay UNBOUND at boot; binding them is the owner's arming crossing).
import { describe, it, expect } from "vitest";
import { ok, err, isErr } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import {
  createConnectorHttpTransport,
  type ConnectorHttpSpec,
  type ConnectorHttpTransportDeps,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type SecretsAccessor,
  type SecretUnavailable,
} from "../src/connectors/adapters/http-transport";
import { createAsanaHttpTransport, createAsanaConnector } from "../src/connectors/adapters/asana";
import type { TransportRequest } from "../src/connectors/transport";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const TOKEN = "asana-PAT-secret-XYZ";
const TOKEN_REF = "keychain:asana-token";
const REQ: TransportRequest = { readScope: "tasks:read" };

function fakeTransport(
  behavior: { response?: HttpTransportResponse; throw?: unknown } = {},
): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  return {
    calls,
    async send(req) {
      calls.push(req);
      if (behavior.throw !== undefined) throw behavior.throw;
      return behavior.response ?? { status: 200, body: JSON.stringify({ data: [] }) };
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

// A vendor-agnostic spec used for the transport-core tests (SSRF / token / 2xx /
// malformed). mapPage is trivial here; the Asana wire-map is exercised via
// createAsanaHttpTransport below.
const CORE_SPEC: ConnectorHttpSpec = {
  baseUrl: "https://app.asana.com/api/1.0",
  allowedHosts: ["app.asana.com"],
  resourcePath: "/tasks",
  buildQuery: (req) => (req.cursor !== undefined ? `?limit=100&offset=${req.cursor}` : "?limit=100"),
  mapPage: () => ({ ok: true, items: [], done: true }),
};

function depsWith(overrides: Partial<ConnectorHttpTransportDeps> = {}): ConnectorHttpTransportDeps {
  return { transport: fakeTransport(), secrets: fakeSecrets(), tokenRef: TOKEN_REF, ...overrides };
}

const asanaBody = (nextPage?: { offset: string }): string =>
  JSON.stringify({
    data: [
      { gid: "1111", modified_at: "2026-07-15T00:00:00Z", name: "task A" },
      { gid: "2222", modified_at: "2026-07-15T01:00:00Z", name: "task B" },
    ],
    ...(nextPage !== undefined ? { next_page: nextPage } : {}),
  });

// ── 1. SSRF guard FIRST (before token + dispatch) ──────────────────────────────
describe("createConnectorHttpTransport — SSRF guard runs FIRST (zero token read, zero dispatch)", () => {
  it.each([
    ["https://evil.com/api", "off-allowlist host"],
    ["http://app.asana.com/api/1.0", "non-https (TLS required)"],
    ["https://127.0.0.1", "loopback (SSRF-to-local)"],
  ])("rejects a %s base URL (%s) before any token/dispatch", async (baseUrl) => {
    const transport = fakeTransport();
    const secrets = fakeSecrets();
    const t = createConnectorHttpTransport({ ...CORE_SPEC, baseUrl }, { transport, secrets, tokenRef: TOKEN_REF });
    const res = await t(REQ);
    expect(res.ok).toBe(false);
    expect(transport.calls).toHaveLength(0);
    expect(secrets.refs).toHaveLength(0); // guard is first — token never read
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it("guards the FINAL url, not just the base — a resourcePath smuggling a userinfo-@ authority is rejected", async () => {
    // base host is allowlisted, but the path smuggles `@evil.com` so the RESOLVED
    // host is evil.com — a base-only guard would pass; the final-url guard rejects.
    const transport = fakeTransport();
    const secrets = fakeSecrets();
    const t = createConnectorHttpTransport(
      { ...CORE_SPEC, baseUrl: "https://app.asana.com", resourcePath: "@evil.com/tasks" },
      { transport, secrets, tokenRef: TOKEN_REF },
    );
    const res = await t(REQ);
    expect(res.ok).toBe(false);
    expect(transport.calls).toHaveLength(0);
    expect(secrets.refs).toHaveLength(0);
  });

  it("percent-encodes the cursor so tampered/persisted cursor state cannot inject query params or an authority", async () => {
    const transport = fakeTransport({ response: { status: 200, body: '{"data":[]}' } });
    const crafted = "evil@host&admin=true?x=/../";
    const t = createAsanaHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF });
    const res = await t({ readScope: "tasks:read", cursor: crafted });
    expect(res.ok).toBe(true); // guard admitted app.asana.com on the final url
    const url = transport.calls[0]!.url;
    expect(url).toContain(`offset=${encodeURIComponent(crafted)}`); // encoded, not raw
    expect(url).not.toContain("offset=evil@host"); // no raw @/&/? structure survives
  });
});

// ── 2. Token fail-closed (typed-unavailable AND a THROWING accessor) ───────────
describe("createConnectorHttpTransport — token fail-closed, redaction-safe", () => {
  it("a typed-unavailable secret ⇒ TransportFailure (safe reason), no dispatch, token absent", async () => {
    const transport = fakeTransport();
    const secrets = fakeSecrets(err({ reason: "locked" } as SecretUnavailable));
    const t = createConnectorHttpTransport(CORE_SPEC, { transport, secrets, tokenRef: TOKEN_REF });
    const res = await t(REQ);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("locked"); // safe enum reason only
    expect(transport.calls).toHaveLength(0);
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it("a THROWING accessor ⇒ TransportFailure, no dispatch, never leaks the thrown cause", async () => {
    const transport = fakeTransport();
    const secrets: SecretsAccessor = {
      async getSecret() {
        throw new Error("keychain TCC denied SECRET_CAUSE_LEAK");
      },
    };
    const t = createConnectorHttpTransport(CORE_SPEC, { transport, secrets, tokenRef: TOKEN_REF });
    const res = await t(REQ);
    expect(res.ok).toBe(false);
    expect(transport.calls).toHaveLength(0);
    expect(JSON.stringify(res)).not.toContain("SECRET_CAUSE_LEAK");
  });
});

// ── 3. Positive-2xx gate: non-2xx + transport-throw redacted ───────────────────
describe("createConnectorHttpTransport — positive-2xx gate, redacted faults", () => {
  it.each([
    [500, "unreachable"],
    [401, "auth_locked"],
    [403, "auth_locked"],
    [429, "rate_limited"],
  ])("HTTP %s ⇒ TransportFailure(code %s) carrying ONLY the safe status, never the body", async (status, code) => {
    const transport = fakeTransport({ response: { status, body: JSON.stringify({ secret_body: "BODY_LEAK" }) } });
    const t = createConnectorHttpTransport(CORE_SPEC, depsWith({ transport }));
    const res = await t(REQ);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(code);
      expect(res.message).toContain(String(status));
      expect(res.message).not.toContain("BODY_LEAK");
    }
  });

  it("a rejecting transport ⇒ TransportFailure(unreachable), the raw cause discarded", async () => {
    const transport = fakeTransport({ throw: new Error("ECONNREFUSED RAW_CAUSE_LEAK") });
    const t = createConnectorHttpTransport(CORE_SPEC, depsWith({ transport }));
    const res = await t(REQ);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("unreachable");
    expect(JSON.stringify(res)).not.toContain("RAW_CAUSE_LEAK");
  });

  it("a non-integer status fails closed (NaN not treated as success)", async () => {
    const transport = fakeTransport({ response: { status: Number.NaN, body: "{}" } });
    const t = createConnectorHttpTransport(CORE_SPEC, depsWith({ transport }));
    const res = await t(REQ);
    expect(res.ok).toBe(false);
  });
});

// ── 4. Malformed 2xx body fails closed ─────────────────────────────────────────
describe("createConnectorHttpTransport — malformed body fails closed", () => {
  it("a 2xx non-JSON body ⇒ TransportFailure, body never echoed", async () => {
    const transport = fakeTransport({ response: { status: 200, body: "<html>NOT_JSON_LEAK</html>" } });
    const t = createConnectorHttpTransport(CORE_SPEC, depsWith({ transport }));
    const res = await t(REQ);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain("NOT_JSON_LEAK");
  });
});

// ── 4b. Template hardening: throwing spec callbacks fail closed; base-trim + status map ─
describe("createConnectorHttpTransport — spec callbacks fail closed (redaction boundary for every connector)", () => {
  it("a THROWING buildQuery fails closed before any dispatch; the thrown content never escapes", async () => {
    const transport = fakeTransport();
    const secrets = fakeSecrets();
    const spec: ConnectorHttpSpec = {
      ...CORE_SPEC,
      buildQuery: () => {
        throw new Error("query blew up QUERY_CAUSE_LEAK");
      },
    };
    const res = await createConnectorHttpTransport(spec, { transport, secrets, tokenRef: TOKEN_REF })(REQ);
    expect(res.ok).toBe(false);
    expect(transport.calls).toHaveLength(0);
    expect(secrets.refs).toHaveLength(0);
    expect(JSON.stringify(res)).not.toContain("QUERY_CAUSE_LEAK");
  });

  it("a THROWING mapPage fails closed redacted; the thrown content never escapes to the failure", async () => {
    const transport = fakeTransport({ response: { status: 200, body: '{"data":[]}' } });
    const spec: ConnectorHttpSpec = {
      ...CORE_SPEC,
      mapPage: () => {
        throw new Error("mapper blew up MAP_CAUSE_LEAK");
      },
    };
    const res = await createConnectorHttpTransport(spec, depsWith({ transport }))(REQ);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain("MAP_CAUSE_LEAK");
  });

  it("trims a trailing slash on the base url (no doubled slash before the path)", async () => {
    const transport = fakeTransport({ response: { status: 200, body: '{"data":[]}' } });
    const spec: ConnectorHttpSpec = { ...CORE_SPEC, baseUrl: "https://app.asana.com/api/1.0/" };
    const res = await createConnectorHttpTransport(spec, depsWith({ transport }))(REQ);
    expect(res.ok).toBe(true);
    expect(transport.calls[0]!.url).toContain("/api/1.0/tasks");
    expect(transport.calls[0]!.url).not.toContain("/api/1.0//tasks");
  });

  it("a 404 (non-auth 4xx) ⇒ TransportFailure(unreachable) carrying the safe status", async () => {
    const transport = fakeTransport({ response: { status: 404, body: "{}" } });
    const res = await createConnectorHttpTransport(CORE_SPEC, depsWith({ transport }))(REQ);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("unreachable");
      expect(res.message).toContain("404");
    }
  });
});

// ── 5. Asana candidate wire-map ⇒ TransportPage (arch_gap) + end-to-end ─────────
describe("createAsanaHttpTransport — candidate Asana envelope maps to a page (arch_gap)", () => {
  it("2xx with next_page ⇒ items (gid→id, distinct stable hash, raw preserved), nextCursor=offset, done=false", async () => {
    const transport = fakeTransport({ response: { status: 200, body: asanaBody({ offset: "OFF-2" }) } });
    const t = createAsanaHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF });
    const res = await t(REQ);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items.map((i) => i.id)).toEqual(["1111", "2222"]);
      expect(res.items[0]!.hash).toBeTruthy();
      expect(res.items[0]!.hash).not.toBe(res.items[1]!.hash);
      expect(res.items[0]!.raw).toEqual({ gid: "1111", modified_at: "2026-07-15T00:00:00Z", name: "task A" });
      expect(res.nextCursor).toBe("OFF-2");
      expect(res.done).toBe(false);
    }
  });

  it("2xx with NO next_page ⇒ done=true, no nextCursor", async () => {
    const transport = fakeTransport({ response: { status: 200, body: asanaBody() } });
    const t = createAsanaHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF });
    const res = await t(REQ);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.done).toBe(true);
      expect(res.nextCursor).toBeUndefined();
    }
  });

  it("a present-but-offsetless next_page ⇒ done=true (candidate decision: cursor axis fails toward stop)", async () => {
    const body = JSON.stringify({ data: [{ gid: "1", modified_at: "t" }], next_page: {} });
    const transport = fakeTransport({ response: { status: 200, body } });
    const res = await createAsanaHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.done).toBe(true);
      expect(res.nextCursor).toBeUndefined();
    }
  });

  it("stable hash: identical gid+modified_at ⇒ identical hash across independent fetches (dedupe key)", async () => {
    const a = await createAsanaHttpTransport({
      transport: fakeTransport({ response: { status: 200, body: asanaBody() } }),
      secrets: fakeSecrets(),
      tokenRef: TOKEN_REF,
    })(REQ);
    const b = await createAsanaHttpTransport({
      transport: fakeTransport({ response: { status: 200, body: asanaBody() } }),
      secrets: fakeSecrets(),
      tokenRef: TOKEN_REF,
    })(REQ);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.items[0]!.hash).toBe(b.items[0]!.hash);
  });

  it.each([
    ['{"data":"not-an-array"}', "data not an array"],
    ['{"notdata":[]}', "missing data field"],
    ['{"data":[{"name":"no gid"}]}', "task missing gid"],
    ["[]", "top-level is not the envelope object"],
  ])("fail-closed on a malformed/renamed shape %s (%s) ⇒ TransportFailure, never a false page", async (body) => {
    const transport = fakeTransport({ response: { status: 200, body } });
    const t = createAsanaHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF });
    const res = await t(REQ);
    expect(res.ok).toBe(false);
  });

  it("drives the whole ConnectorPort.fetch chain end-to-end via createAsanaConnector (raw→records)", async () => {
    const transport = fakeTransport({ response: { status: 200, body: asanaBody({ offset: "OFF-9" }) } });
    const port = createAsanaConnector(createAsanaHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF }));
    const page = await port.fetch();
    expect(isErr(page)).toBe(false);
    if (!isErr(page)) {
      expect(page.value.records.map((r) => r.recordId)).toEqual(["1111", "2222"]);
      expect(page.value.records[0]!.contentHash).toBeTruthy();
      expect(page.value.records[0]!.payload).toEqual({ gid: "1111", modified_at: "2026-07-15T00:00:00Z", name: "task A" });
      expect(page.value.nextCursor).toBe("OFF-9");
      expect(page.value.done).toBe(false);
    }
    // the adapter's least-privilege read scope reached the transport; token in Authorization only.
    expect(transport.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

// ── 6. Token rides ONLY Authorization, never a failure ─────────────────────────
describe("createConnectorHttpTransport — token rides ONLY Authorization, never a failure", () => {
  it("GET (read-only, ING-7); token in the Authorization header only, not the url / other headers", async () => {
    const transport = fakeTransport({ response: { status: 200, body: '{"data":[]}' } });
    const t = createAsanaHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF });
    await t(REQ);
    const call = transport.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.url).not.toContain(TOKEN);
    for (const [k, v] of Object.entries(call.headers)) {
      if (k.toLowerCase() !== "authorization") expect(v).not.toContain(TOKEN);
    }
  });

  it("the token never appears in a TransportFailure (non-2xx path)", async () => {
    const transport = fakeTransport({ response: { status: 500, body: "{}" } });
    const t = createAsanaHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF });
    const res = await t(REQ);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });
});

// ── 7. Context7 correctness-verify (round-3 slice 3) — the list query requests the change token ─────
// Context7 (/websites/developers_asana, GET /tasks + opt_fields): the list returns COMPACT records (gid +
// name) by default — `modified_at` (the change token asanaContentHash relies on) is returned ONLY when named
// in `opt_fields`. Without it, the contentHash silently degrades to hashing the compact record. The corrected
// candidate query requests `opt_fields=name,modified_at` so the dedupe change-token is actually present.
describe("createAsanaHttpTransport — Context7-grounded list query requests the change token (opt_fields)", () => {
  it("first page requests opt_fields including modified_at + limit≤100, no offset", async () => {
    const transport = fakeTransport({ response: { status: 200, body: '{"data":[]}' } });
    await createAsanaHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    const url = transport.calls[0]!.url;
    expect(url).toContain(`opt_fields=${encodeURIComponent("name,modified_at")}`);
    expect(url).toContain("limit=100"); // Context7: limit must be 1..100
    expect(url).not.toContain("&offset=");
  });

  it("resuming still carries the opaque offset token (encoded) alongside opt_fields", async () => {
    const transport = fakeTransport({ response: { status: 200, body: '{"data":[]}' } });
    await createAsanaHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })({
      readScope: "tasks:read",
      cursor: "eyJ0eXAiOiJKV1QiLC",
    });
    const url = transport.calls[0]!.url;
    expect(url).toContain("offset=eyJ0eXAiOiJKV1QiLC");
    expect(url).toContain(`opt_fields=${encodeURIComponent("name,modified_at")}`);
  });
});

// ── 8. Template mapPage(json, request) widening — the two guardrails (R5 GitHub) ─
// GitHub returns a bare array with page-number pagination, so the body-only mapper needs the request cursor.
// mapPage is widened (json) → (json, request). These pin the two safety guardrails of that widening.
describe("createConnectorHttpTransport — mapPage(json, request) widening guardrails", () => {
  it("GUARDRAIL 2 (rule 7): mapPage receives the token-free TransportRequest — no Authorization/token", async () => {
    const MARKER = "SECRET-MARKER-do-not-leak-to-mapper";
    let captured: unknown;
    const spec: ConnectorHttpSpec = {
      ...CORE_SPEC,
      mapPage: (_json, request) => {
        captured = request;
        return { ok: true, items: [], done: true };
      },
    };
    const transport = fakeTransport({ response: { status: 200, body: "{}" } });
    const secrets = fakeSecrets(ok(MARKER));
    await createConnectorHttpTransport(spec, { transport, secrets, tokenRef: TOKEN_REF })({
      readScope: "tasks:read",
      cursor: "CURSOR-1",
    });
    expect(captured).toBeDefined();
    const req = captured as Record<string, unknown>;
    // keys ⊆ {cursor, readScope}; NO Authorization / headers; the token appears NOWHERE.
    expect(Object.keys(req).every((k) => k === "cursor" || k === "readScope")).toBe(true);
    expect("Authorization" in req).toBe(false);
    expect("headers" in req).toBe(false);
    expect(JSON.stringify(req)).not.toContain(MARKER);
    expect(req).toEqual({ readScope: "tasks:read", cursor: "CURSOR-1" });
  });

  it("GUARDRAIL 1 (backward-compat): a 1-arg (json)=>page mapPage type-checks + runs through the widened template", async () => {
    // A pre-widening single-arg mapper (the shape of the 4 existing vendor mappers) still assigns to the 2-arg
    // type and runs correctly; the extra request arg is a runtime no-op.
    const spec: ConnectorHttpSpec = {
      ...CORE_SPEC,
      mapPage: (json) => ({ ok: true, items: [], done: json !== undefined }),
    };
    const res = await createConnectorHttpTransport(
      spec,
      depsWith({ transport: fakeTransport({ response: { status: 200, body: "[]" } }) }),
    )({ readScope: "tasks:read" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.done).toBe(true);
  });
});

// ── 9. Template POST + body extension (R6 slice 1) ──────────────────────────────
// Additive: `spec.method?: "GET"|"POST"` (default GET) + `spec.buildBody?` for a GraphQL-over-POST connector
// (Linear, slice 2). The 5 existing GET connectors stay byte-exact; POST keeps every GET safety property
// (SSRF-on-final-url method-agnostic · token Authorization-only, never in body · wrapped body-builder).
describe("createConnectorHttpTransport — POST + body extension (R6 slice 1)", () => {
  it("a POST spec sends method POST + the built body + content-type application/json; 2xx maps", async () => {
    const transport = fakeTransport({ response: { status: 200, body: '{"data":{"ok":true}}' } });
    const spec: ConnectorHttpSpec = {
      ...CORE_SPEC,
      method: "POST",
      buildBody: () => '{"query":"query { viewer { id } }"}',
      mapPage: () => ({ ok: true, items: [], done: true }),
    };
    const res = await createConnectorHttpTransport(spec, depsWith({ transport }))(REQ);
    expect(res.ok).toBe(true);
    const call = transport.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.body).toBe('{"query":"query { viewer { id } }"}');
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("a GET spec (no method) ⇒ method GET, NO body key, NO content-type (byte-exact)", async () => {
    const transport = fakeTransport({ response: { status: 200, body: "[]" } });
    const spec: ConnectorHttpSpec = { ...CORE_SPEC, mapPage: () => ({ ok: true, items: [], done: true }) };
    await createConnectorHttpTransport(spec, depsWith({ transport }))(REQ);
    const call = transport.calls[0]!;
    expect(call.method).toBe("GET");
    expect("body" in call).toBe(false);
    expect(call.headers["content-type"]).toBeUndefined();
    expect(call.headers).toEqual({ accept: "application/json", Authorization: `Bearer ${TOKEN}` });
  });

  it("SSRF guard is method-agnostic: a POST spec with an off-allowlist base ⇒ refused, ZERO token/dispatch/buildBody", async () => {
    const transport = fakeTransport();
    const secrets = fakeSecrets();
    let buildBodyCalls = 0;
    const spec: ConnectorHttpSpec = {
      ...CORE_SPEC,
      baseUrl: "https://evil.com",
      method: "POST",
      buildBody: () => {
        buildBodyCalls += 1;
        return "{}";
      },
    };
    const res = await createConnectorHttpTransport(spec, { transport, secrets, tokenRef: TOKEN_REF })(REQ);
    expect(res.ok).toBe(false);
    expect(transport.calls).toHaveLength(0);
    expect(secrets.refs).toHaveLength(0); // guard fires before token read
    expect(buildBodyCalls).toBe(0); // and before the body is built
  });

  it("a THROWING buildBody ⇒ redacted TransportFailure (no raw content, no dispatch); absent buildBody while POST ⇒ fail-closed", async () => {
    const transport = fakeTransport();
    const throwSpec: ConnectorHttpSpec = {
      ...CORE_SPEC,
      method: "POST",
      buildBody: () => {
        throw new Error("body blew up BODY_CAUSE_LEAK");
      },
    };
    const r1 = await createConnectorHttpTransport(throwSpec, { transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    expect(r1.ok).toBe(false);
    expect(transport.calls).toHaveLength(0); // body built before dispatch ⇒ a throw means no dispatch
    expect(JSON.stringify(r1)).not.toContain("BODY_CAUSE_LEAK");

    const absentTransport = fakeTransport();
    const absentSpec: ConnectorHttpSpec = { ...CORE_SPEC, method: "POST" }; // no buildBody — mis-specified
    const r2 = await createConnectorHttpTransport(absentSpec, {
      transport: absentTransport,
      secrets: fakeSecrets(),
      tokenRef: TOKEN_REF,
    })(REQ);
    expect(r2.ok).toBe(false);
    expect(absentTransport.calls).toHaveLength(0); // mis-specified POST fails closed BEFORE dispatch
  });

  it("POST buildBody returning '' sends body:'' + content-type; a GET spec's stray buildBody is ignored (not called)", async () => {
    // an empty-string body is still a POST body ("" !== undefined) ⇒ body:"" + content-type present.
    const t1 = fakeTransport({ response: { status: 200, body: "{}" } });
    const emptySpec: ConnectorHttpSpec = {
      ...CORE_SPEC,
      method: "POST",
      buildBody: () => "",
      mapPage: () => ({ ok: true, items: [], done: true }),
    };
    await createConnectorHttpTransport(emptySpec, { transport: t1, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    expect(t1.calls[0]!.body).toBe("");
    expect(t1.calls[0]!.headers["content-type"]).toBe("application/json");

    // a GET spec that (wrongly) sets buildBody ⇒ ignored: GET path, no body / no content-type, buildBody uncalled.
    const t2 = fakeTransport({ response: { status: 200, body: "[]" } });
    let strayCalls = 0;
    const strayGet: ConnectorHttpSpec = {
      ...CORE_SPEC,
      buildBody: () => {
        strayCalls += 1;
        return "{}";
      },
      mapPage: () => ({ ok: true, items: [], done: true }),
    };
    await createConnectorHttpTransport(strayGet, { transport: t2, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    expect("body" in t2.calls[0]!).toBe(false);
    expect(t2.calls[0]!.headers["content-type"]).toBeUndefined();
    expect(strayCalls).toBe(0);
  });

  it("GUARDRAIL rule 7: the POST body never carries the token; buildBody gets a token-free request; token only in Authorization", async () => {
    const MARKER = "TOKEN-MARKER-must-not-reach-body";
    let capturedReq: unknown;
    const transport = fakeTransport({ response: { status: 200, body: "{}" } });
    const spec: ConnectorHttpSpec = {
      ...CORE_SPEC,
      method: "POST",
      buildBody: (request) => {
        capturedReq = request;
        return `{"query":"query { x }","cursor":"${request.cursor ?? ""}"}`;
      },
      mapPage: () => ({ ok: true, items: [], done: true }),
    };
    await createConnectorHttpTransport(spec, { transport, secrets: fakeSecrets(ok(MARKER)), tokenRef: TOKEN_REF })({
      readScope: "tasks:read",
      cursor: "C1",
    });
    const call = transport.calls[0]!;
    expect(call.body).not.toContain(MARKER); // token NEVER in the body
    expect(call.headers.Authorization).toBe(`Bearer ${MARKER}`); // only in Authorization
    const req = capturedReq as Record<string, unknown>;
    expect(Object.keys(req).every((k) => k === "cursor" || k === "readScope")).toBe(true);
    expect("Authorization" in req).toBe(false);
    expect(JSON.stringify(req)).not.toContain(MARKER);
  });
});

// ── 16.3 — ING-7 runtime method admission ───────────────────────────────────────
// The `method` type is already GET|POST, but ING-7 read-only-ness must be a RUNTIME
// admission gate too (defense-in-depth): a mutating verb smuggled past the type (a cast, a
// future widening) is REJECTED at admission — before ANY token read or dispatch.
describe("createConnectorHttpTransport — ING-7 read-only method admission", () => {
  it.each([["DELETE"], ["PUT"], ["PATCH"], ["OPTIONS"], ["HEAD"]])(
    "ing7_admission_rejects_a_mutating_verb: %s is refused at admission (no token read, no dispatch)",
    async (verb) => {
      const transport = fakeTransport();
      const secrets = fakeSecrets();
      const spec = { ...CORE_SPEC, method: verb as unknown as "GET" | "POST" };
      const res = await createConnectorHttpTransport(spec, { transport, secrets, tokenRef: TOKEN_REF })(REQ);
      expect(res.ok).toBe(false);
      expect(transport.calls).toHaveLength(0); // zero dispatch
      expect(secrets.refs).toHaveLength(0); // admission BEFORE token read
      expect(JSON.stringify(res)).not.toContain(TOKEN); // redaction-safe fault
    },
  );

  it("admits GET (default) and POST (the read-only exceptions)", async () => {
    const tGet = fakeTransport();
    const rGet = await createConnectorHttpTransport(CORE_SPEC, depsWith({ transport: tGet }))(REQ);
    expect(rGet.ok).toBe(true);
    expect(tGet.calls[0]!.method).toBe("GET");

    const tPost = fakeTransport();
    const postSpec: ConnectorHttpSpec = { ...CORE_SPEC, method: "POST", buildBody: () => JSON.stringify({ query: "{ me }" }) };
    const rPost = await createConnectorHttpTransport(postSpec, depsWith({ transport: tPost }))(REQ);
    expect(rPost.ok).toBe(true);
    expect(tPost.calls[0]!.method).toBe("POST");
  });
});

// ── 16.3 — SSRF internal-target coverage + denylist-beats-allowlist (transport level) ─
describe("createConnectorHttpTransport — SSRF blocks internal targets before token read", () => {
  it.each([
    ["https://169.254.169.254", "cloud metadata IP"],
    ["https://10.0.0.5", "RFC-1918"],
    ["https://192.168.0.1", "RFC-1918"],
    ["https://127.0.0.1", "loopback"],
    ["https://[::1]", "IPv6 loopback"],
    ["https://vault.internal", ".internal host"],
  ])(
    "ssrf_guard_blocks_internal_targets_before_token_read: %s (%s) refused, token never read",
    async (baseUrl) => {
      const transport = fakeTransport();
      const secrets = fakeSecrets();
      const t = createConnectorHttpTransport({ ...CORE_SPEC, baseUrl }, { transport, secrets, tokenRef: TOKEN_REF });
      const res = await t(REQ);
      expect(res.ok).toBe(false);
      expect(transport.calls).toHaveLength(0);
      expect(secrets.refs).toHaveLength(0);
      expect(JSON.stringify(res)).not.toContain(TOKEN);
    },
  );

  it("ssrf_guard_blocks_a_MISCONFIGURED_allowlisted_metadata_host (denylist beats allowlist)", async () => {
    // Even if a spec mistakenly allowlists the metadata IP, the private-range denylist refuses it.
    const transport = fakeTransport();
    const secrets = fakeSecrets();
    const t = createConnectorHttpTransport(
      { ...CORE_SPEC, baseUrl: "https://169.254.169.254", allowedHosts: ["169.254.169.254"] },
      { transport, secrets, tokenRef: TOKEN_REF },
    );
    const res = await t(REQ);
    expect(res.ok).toBe(false);
    expect(transport.calls).toHaveLength(0);
    expect(secrets.refs).toHaveLength(0); // token NEVER read for an internal endpoint
  });

  it("ssrf_guard_allows_a_public_allowlisted_host (send IS invoked)", async () => {
    const transport = fakeTransport();
    const res = await createConnectorHttpTransport(CORE_SPEC, depsWith({ transport }))(REQ);
    expect(res.ok).toBe(true);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.url.startsWith("https://app.asana.com")).toBe(true);
  });
});

// ── 16.3 — send-seam dormancy (no real network egress in the shipped default) ────
describe("createConnectorHttpTransport — send seam is UNBOUND (dormant, no real network)", () => {
  it("send_seam_is_unbound: construction + a guard-rejected request invoke the injected send ZERO times", async () => {
    const transport = fakeTransport();
    const secrets = fakeSecrets();
    // Construction alone must not dispatch.
    const t = createConnectorHttpTransport(
      { ...CORE_SPEC, baseUrl: "https://169.254.169.254", allowedHosts: ["app.asana.com"] },
      { transport, secrets, tokenRef: TOKEN_REF },
    );
    expect(transport.calls).toHaveLength(0);
    const res = await t(REQ);
    expect(res.ok).toBe(false);
    expect(transport.calls).toHaveLength(0); // guard-reject ⇒ zero real send
    expect(secrets.refs).toHaveLength(0);
  });

  it("send_seam_is_unbound: the connector source tree binds NO real network transport (grep-pin)", () => {
    const dir = fileURLToPath(new URL("../src/connectors", import.meta.url));
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts")) files.push(p);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(0);
    // Real outbound-network bindings that must NOT appear in the dormant connector tree.
    const NETWORK_BIND =
      /(?:import[^;\n]*from\s*|require\(\s*)['"](?:undici|node:https?|https?)['"]|\bhttps?\.request\s*\(|\bnew\s+XMLHttpRequest\b/;
    const offenders = files.filter((f) => NETWORK_BIND.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
