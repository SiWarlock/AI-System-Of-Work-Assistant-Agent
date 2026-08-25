// spec(§8) spec(§5) spec(§16) — 21.6a: the real write-side HTTP AdapterTransport
// (createWriteHttpTransport), DORMANT + UNBOUND. Mirrors the proven read-side
// createConnectorHttpTransport template (connector-http-transport.test.ts): SSRF
// guard FIRST on the FINAL url (zero token read, zero dispatch) · the token
// resolved via the injected WriteSecretsAccessor + writeSecretRef (header-only,
// fail-closed even on a THROWING accessor and on a whitespace-only "token") · a
// redacted typed TransportFault behind a positive-2xx gate · a "drive" vendor
// spec as the worked example (test-only — no vendor spec ships in src). Tested
// ENTIRELY over fakes — zero real network/secrets. Also proves DORMANCY: no
// production call-site references createWriteHttpTransport, and the worker's
// selectAdapterTransport still defaults to the in-memory stub for an unset gate.
import { describe, it, expect } from "vitest";
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { endpointHostRef } from "@sow/policy";
import {
  createWriteHttpTransport,
  type WriteHttpSpec,
  type WriteHttpTransportDeps,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse,
} from "../src/tools/adapters/write-http-transport";
import { writeSecretRef, type WriteSecretsAccessor, type WriteSecretUnavailable } from "../src/tools/adapters/adapter-core";
import type { AdapterTransportRequest } from "../src/tools/adapters/transport";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const TOKEN = "vendor-write-token-XYZ";

function fakeHttp(
  behavior: { response?: HttpTransportResponse; throw?: unknown } = {},
): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  return {
    calls,
    async send(req) {
      calls.push(req);
      if (behavior.throw !== undefined) throw behavior.throw;
      return behavior.response ?? { status: 200, body: JSON.stringify({ id: "vendor-obj-1" }) };
    },
  };
}

function fakeSecrets(
  result: Result<string, WriteSecretUnavailable> = ok(TOKEN),
): WriteSecretsAccessor & { refs: string[] } {
  const refs: string[] = [];
  return {
    refs,
    async getSecret(ref) {
      refs.push(ref);
      return result;
    },
  };
}

// A vendor-agnostic spec for the transport-core tests (SSRF / token / 2xx / redaction).
const CORE_SPEC: WriteHttpSpec = {
  baseUrl: "https://api.vendor.com",
  allowedHosts: ["api.vendor.com"],
  buildRequest: (req) => ({
    method: req.op === "query" ? "GET" : req.op === "create" ? "POST" : "PATCH",
    path: `/objects/${req.canonicalObjectKey}`,
    ...(req.op !== "query" ? { body: JSON.stringify(req.payload ?? {}) } : {}),
  }),
  mapResponse: (_status, json) => {
    const obj = json as { id?: string };
    if (typeof obj?.id !== "string") return { ok: false, fault: "unknown", detail: "missing id" };
    return { ok: true, object: { externalObjectId: obj.id } };
  },
};

function depsWith(overrides: Partial<WriteHttpTransportDeps> = {}): WriteHttpTransportDeps {
  return { http: fakeHttp(), secrets: fakeSecrets(), ...overrides };
}

const CREATE_REQ: AdapterTransportRequest = {
  op: "create",
  targetSystem: "drive",
  canonicalObjectKey: "drive:doc:123",
  idempotencyKey: "idem-1",
  identity: { docKey: "123" },
  payload: { title: "Doc" },
};

// ── 1. SSRF guard runs FIRST (before token + dispatch) ─────────────────────────
describe("createWriteHttpTransport — SSRF guard runs FIRST (zero token read, zero dispatch)", () => {
  it("SSRF guard runs FIRST — an off-allowlist final url returns a rejected fault with zero getSecret calls and zero http.send calls", async () => {
    const http = fakeHttp();
    const secrets = fakeSecrets();
    const spec: WriteHttpSpec = { ...CORE_SPEC, baseUrl: "https://evil.com" };
    const transport = createWriteHttpTransport(spec, { http, secrets });
    const res = await transport(CREATE_REQ);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fault).toBe("rejected");
    expect(http.calls).toHaveLength(0);
    expect(secrets.refs).toHaveLength(0); // guard is first — token never read
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it.each([
    ["http://api.vendor.com", "non-https (TLS required)"],
    ["https://127.0.0.1", "loopback (SSRF-to-local)"],
  ])("rejects a %s base URL (%s) before any token/dispatch", async (baseUrl) => {
    const http = fakeHttp();
    const secrets = fakeSecrets();
    const spec: WriteHttpSpec = { ...CORE_SPEC, baseUrl, allowedHosts: [baseUrl.replace(/^https?:\/\//, "")] };
    const transport = createWriteHttpTransport(spec, { http, secrets });
    const res = await transport(CREATE_REQ);
    expect(res.ok).toBe(false);
    expect(http.calls).toHaveLength(0);
    expect(secrets.refs).toHaveLength(0);
  });

  it("the rejected detail is the endpointHostRef of the final url — nothing more", async () => {
    const spec: WriteHttpSpec = { ...CORE_SPEC, baseUrl: "https://evil.com" };
    const transport = createWriteHttpTransport(spec, depsWith());
    const res = await transport(CREATE_REQ);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toBe(endpointHostRef(`https://evil.com/objects/${CREATE_REQ.canonicalObjectKey}`));
  });

  it("guards the FINAL url, not just the base — an authority smuggled via the path is rejected", async () => {
    // base host is allowlisted, but buildRequest's path smuggles `@evil.com` so the
    // RESOLVED host is evil.com — a base-only guard would pass; the final-url guard rejects.
    const http = fakeHttp();
    const secrets = fakeSecrets();
    const spec: WriteHttpSpec = {
      ...CORE_SPEC,
      buildRequest: () => ({ method: "POST", path: "@evil.com/objects", body: "{}" }),
    };
    const transport = createWriteHttpTransport(spec, { http, secrets });
    const res = await transport(CREATE_REQ);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fault).toBe("rejected");
    expect(http.calls).toHaveLength(0);
    expect(secrets.refs).toHaveLength(0);
  });
});

// ── 2. Credential fail-closed (typed-unavailable, THROWING accessor, whitespace) ─
describe("createWriteHttpTransport — write credential fail-closed, redaction-safe", () => {
  it.each([["locked"], ["missing"], ["denied"]] as const)(
    "a %s accessor fails closed to a rejected fault, and the fault contains neither the token nor 'keychain://'",
    async (reason) => {
      const http = fakeHttp();
      const secrets = fakeSecrets(err({ reason } as WriteSecretUnavailable));
      const transport = createWriteHttpTransport(CORE_SPEC, { http, secrets });
      const res = await transport(CREATE_REQ);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.fault).toBe("rejected");
        expect(res.detail).toContain(reason);
      }
      expect(http.calls).toHaveLength(0);
      expect(JSON.stringify(res)).not.toContain(TOKEN);
      expect(JSON.stringify(res)).not.toContain("keychain://");
    },
  );

  it("a THROWING accessor fails closed, no dispatch, never leaks the thrown cause", async () => {
    const http = fakeHttp();
    const secrets: WriteSecretsAccessor = {
      async getSecret() {
        throw new Error("keychain TCC denied SECRET_CAUSE_LEAK");
      },
    };
    const transport = createWriteHttpTransport(CORE_SPEC, { http, secrets });
    const res = await transport(CREATE_REQ);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fault).toBe("rejected");
    expect(http.calls).toHaveLength(0);
    expect(JSON.stringify(res)).not.toContain("SECRET_CAUSE_LEAK");
    expect(JSON.stringify(res)).not.toContain("keychain://");
  });

  it("a whitespace-only token is NOT proof of auth — fails closed, no dispatch", async () => {
    const http = fakeHttp();
    const secrets = fakeSecrets(ok("   "));
    const transport = createWriteHttpTransport(CORE_SPEC, { http, secrets });
    const res = await transport(CREATE_REQ);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fault).toBe("rejected");
    expect(http.calls).toHaveLength(0);
  });

  it("resolves the token via writeSecretRef(targetSystem) — the 17.4 keychain ref, not a raw token param", async () => {
    const http = fakeHttp();
    const secrets = fakeSecrets();
    const transport = createWriteHttpTransport(CORE_SPEC, { http, secrets });
    await transport(CREATE_REQ);
    expect(secrets.refs).toEqual([writeSecretRef(CREATE_REQ.targetSystem)]);
  });
});

// ── 3. Token binding: Authorization header ONLY ─────────────────────────────────
describe("createWriteHttpTransport — token rides ONLY the Authorization header", () => {
  it("a resolved token appears in headers.Authorization as `Bearer <tok>` and in NO other field of the captured request", async () => {
    const http = fakeHttp();
    const secrets = fakeSecrets();
    const transport = createWriteHttpTransport(CORE_SPEC, { http, secrets });
    const res = await transport(CREATE_REQ);
    expect(res.ok).toBe(true);
    const captured = http.calls[0]!;
    expect(captured.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const { Authorization: _Authorization, ...otherHeaders } = captured.headers;
    expect(JSON.stringify(otherHeaders)).not.toContain(TOKEN);
    expect(captured.url).not.toContain(TOKEN);
    expect(captured.body ?? "").not.toContain(TOKEN);
  });

  it("fixes redirect:'manual' on every dispatched request (SSRF-guards the redirect vector)", async () => {
    const http = fakeHttp();
    const transport = createWriteHttpTransport(CORE_SPEC, depsWith({ http }));
    await transport(CREATE_REQ);
    expect(http.calls[0]!.redirect).toBe("manual");
  });

  it("copies the headers map per call — two dispatches never share the same headers object reference", async () => {
    const http = fakeHttp();
    const transport = createWriteHttpTransport(CORE_SPEC, depsWith({ http }));
    await transport(CREATE_REQ);
    await transport(CREATE_REQ);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0]!.headers).not.toBe(http.calls[1]!.headers);
  });
});

// ── 4. Positive-2xx gate: non-2xx + transport-throw redacted ───────────────────
describe("createWriteHttpTransport — positive-2xx gate, redacted faults", () => {
  it.each([
    [204, "unknown"], // in-range status but an empty body fails the JSON parse ⇒ unknown, never ok:true
    [301, "unknown"],
    [500, "unreachable"],
    [Number.NaN, "unknown"],
  ])("HTTP status %s never yields ok:true — maps to fault %s", async (status, code) => {
    const http = fakeHttp({ response: { status, body: "" } });
    const transport = createWriteHttpTransport(CORE_SPEC, depsWith({ http }));
    const res = await transport(CREATE_REQ);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fault).toBe(code);
  });

  it.each([
    [409, "conflict"],
    [412, "conflict"],
  ])("HTTP %s (precondition clash) ⇒ conflict, NEVER a blind overwrite", async (status, code) => {
    const http = fakeHttp({ response: { status, body: JSON.stringify({ secret_body: "BODY_LEAK" }) } });
    const transport = createWriteHttpTransport(CORE_SPEC, depsWith({ http }));
    const res = await transport(CREATE_REQ);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.fault).toBe(code);
      expect(res.detail).not.toContain("BODY_LEAK");
    }
  });

  it("a non-409/412 4xx (401) ⇒ rejected, carrying only the safe status, never the body", async () => {
    const http = fakeHttp({ response: { status: 401, body: JSON.stringify({ secret_body: "BODY_LEAK" }) } });
    const transport = createWriteHttpTransport(CORE_SPEC, depsWith({ http }));
    const res = await transport(CREATE_REQ);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.fault).toBe("rejected");
      expect(res.detail).toContain("401");
      expect(res.detail).not.toContain("BODY_LEAK");
    }
  });

  it("a rejecting/throwing http.send ⇒ unreachable, the raw cause discarded", async () => {
    const http = fakeHttp({ throw: new Error("ECONNREFUSED RAW_CAUSE_LEAK") });
    const transport = createWriteHttpTransport(CORE_SPEC, depsWith({ http }));
    const res = await transport(CREATE_REQ);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fault).toBe("unreachable");
    expect(JSON.stringify(res)).not.toContain("RAW_CAUSE_LEAK");
  });
});

// ── 5. Malformed 2xx body + throwing mapResponse fail closed ───────────────────
describe("createWriteHttpTransport — malformed body + throwing mapResponse fail closed", () => {
  it("a 2xx non-JSON body ⇒ an unknown fault, the raw body never echoed", async () => {
    const http = fakeHttp({ response: { status: 200, body: "<html>NOT_JSON_LEAK</html>" } });
    const transport = createWriteHttpTransport(CORE_SPEC, depsWith({ http }));
    const res = await transport(CREATE_REQ);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fault).toBe("unknown");
    expect(JSON.stringify(res)).not.toContain("NOT_JSON_LEAK");
  });

  it("a THROWING mapResponse ⇒ unknown, and the thrown content never propagates/escapes", async () => {
    const http = fakeHttp({ response: { status: 200, body: '{"id":"x"}' } });
    const spec: WriteHttpSpec = {
      ...CORE_SPEC,
      mapResponse: () => {
        throw new Error("mapper blew up MAP_CAUSE_LEAK");
      },
    };
    const transport = createWriteHttpTransport(spec, depsWith({ http }));
    const res = await transport(CREATE_REQ);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fault).toBe("unknown");
    expect(JSON.stringify(res)).not.toContain("MAP_CAUSE_LEAK");
  });
});

// ── 6. "drive" worked example — end-to-end over the real pipeline ──────────────
describe("createWriteHttpTransport — worked example (drive vendor spec, test-only)", () => {
  const driveSpec: WriteHttpSpec = {
    baseUrl: "https://www.googleapis.com/drive/v3",
    allowedHosts: ["www.googleapis.com"],
    buildRequest: (req) => {
      if (req.op === "query") return { method: "GET", path: `/files/${req.identity.docKey}` };
      if (req.op === "create") return { method: "POST", path: "/files", body: JSON.stringify(req.payload ?? {}) };
      return { method: "PATCH", path: `/files/${req.identity.docKey}`, body: JSON.stringify(req.payload ?? {}) };
    },
    mapResponse: (_status, json) => {
      const obj = json as { id?: string; webViewLink?: string };
      if (typeof obj.id !== "string") return { ok: false, fault: "unknown", detail: "missing id" };
      return {
        ok: true,
        object: {
          externalObjectId: obj.id,
          ...(obj.webViewLink !== undefined ? { externalUrl: obj.webViewLink } : {}),
        },
      };
    },
  };

  it("a create dispatches a POST /files with the token bound, and maps a successful vendor object to a receipt-shaped TransportObject", async () => {
    const http = fakeHttp({
      response: { status: 200, body: JSON.stringify({ id: "drive-doc-9", webViewLink: "https://drive/9" }) },
    });
    const secrets = fakeSecrets();
    const transport = createWriteHttpTransport(driveSpec, { http, secrets });
    const res = await transport(CREATE_REQ);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.object).toEqual({ externalObjectId: "drive-doc-9", externalUrl: "https://drive/9" });
    }
    expect(http.calls[0]!.method).toBe("POST");
    expect(http.calls[0]!.url).toBe("https://www.googleapis.com/drive/v3/files");
    expect(http.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("a query op dispatches a GET with no body", async () => {
    const http = fakeHttp({ response: { status: 200, body: JSON.stringify({ id: "drive-doc-9" }) } });
    const transport = createWriteHttpTransport(driveSpec, depsWith({ http }));
    const queryReq: AdapterTransportRequest = { ...CREATE_REQ, op: "query" };
    await transport(queryReq);
    expect(http.calls[0]!.method).toBe("GET");
    expect(http.calls[0]!.body).toBeUndefined();
  });
});

// ── 7. Dormancy — no production call-site, arming stays closed ─────────────────
describe("dormant — no production call-site", () => {
  const backendsSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "worker", "src", "composition", "backends.ts"),
    "utf8",
  );

  it("apps/worker/src/composition/backends.ts does not reference createWriteHttpTransport", () => {
    expect(backendsSrc.includes("createWriteHttpTransport")).toBe(false);
  });

  it("selectAdapterTransport still falls back to createStubAdapterTransport() on an unset/off gate — proven from source, not by importing apps/worker (cross-territory) into this package's test", () => {
    // packages/integrations may not depend on apps/worker (layering + this package's
    // territory boundary), so dormancy is proven textually against backends.ts's OWN
    // source, mirroring the credential-seam.test.ts source-scan idiom — not by
    // executing/importing the worker's composition module (which is another track's
    // concurrently-edited territory).
    const fnStart = backendsSrc.indexOf("export function selectAdapterTransport");
    expect(fnStart).toBeGreaterThan(-1); // positive control: the function still exists
    const fnEnd = backendsSrc.indexOf("\nexport function", fnStart + 1);
    const fnBody = backendsSrc.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    // strict `=== true` gate is still the ONLY path off the stub …
    expect(fnBody).toContain("gate?.enabled === true");
    expect(fnBody).toContain('typeof gate.make === "function"');
    // … and the unconditional fallback for every other input is still the stub.
    expect(fnBody).toContain("return createStubAdapterTransport();");
    expect(fnBody.includes("createWriteHttpTransport")).toBe(false);
  });

  it("apps/worker/src/composition/backends.ts's WriteTransportGate.make stays unbound in the shipped BackendsConfig — no default factory is wired", () => {
    // positive control: the gate type itself is still present (a bad/empty search
    // would mean the source moved and this test would be checking nothing)
    expect(backendsSrc.includes("interface WriteTransportGate")).toBe(true);
    // the default export path never constructs a real transport factory inline
    expect(backendsSrc.includes("make: () => createWriteHttpTransport")).toBe(false);
  });
});

// ── 8. Redaction hygiene — this module never shells out ────────────────────────
describe("write-http-transport.ts — no shell-out, no credential-exec backend", () => {
  it("the module source contains no child_process / execFile / execSync / security find-generic-password", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/tools/adapters/write-http-transport.ts", import.meta.url)),
      "utf8",
    );
    for (const forbidden of ["child_process", "execFile", "execSync", "security find-generic-password"]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });
});
