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
