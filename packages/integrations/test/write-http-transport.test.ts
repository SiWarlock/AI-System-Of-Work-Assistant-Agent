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
import {
  writeSecretRef,
  makeTargetWriteAdapter,
  type WriteSecretsAccessor,
  type WriteSecretUnavailable,
} from "../src/tools/adapters/adapter-core";
import type { AdapterTransport, AdapterTransportRequest } from "../src/tools/adapters/transport";
// Value import: `TransportFaultDetail` is a const array AND the type derived from
// it (declaration-merged), so this one binding serves both uses.
import { TransportFaultDetail } from "../src/tools/adapters/transport";
import type { TargetWriteAdapter } from "../src/tools/adapter-port";
import { dispatchExternalWrite, type ExternalWriteDeps } from "../src/tools/gateway";
import { buildEnvelopeFromAction } from "../src/tools/envelope";
import { makeEnvelope, InMemoryReceiptStore, makeProposedAction } from "./support/fakes";
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

// ── 6.5 §S — the full pipeline still yields FIVE DISTINCT operator-facing
//     messages, now built from {fault, httpStatus} instead of forwarded prose ──
describe("createWriteHttpTransport + makeTargetWriteAdapter — 401 / 403 / 429 / outage / SSRF-block stay distinguishable (§S)", () => {
  const testClock = (): string => "2026-07-01T00:00:00.000Z";

  function adapterOver(transport: AdapterTransport): TargetWriteAdapter {
    return makeTargetWriteAdapter(
      { targetSystem: "drive", deriveIdentity: () => ({}) },
      { transport, clock: testClock },
    );
  }

  it("401 / 403 / 429 / a transport outage / an SSRF-block produce FIVE DISTINCT AdapterError.message strings", async () => {
    const env = makeEnvelope({ targetSystem: "drive", canonicalObjectKey: CREATE_REQ.canonicalObjectKey });
    const messages: string[] = [];

    for (const status of [401, 403, 429]) {
      const http = fakeHttp({ response: { status, body: "{}" } });
      const transport = createWriteHttpTransport(CORE_SPEC, depsWith({ http }));
      const res = await adapterOver(transport).create(env, { title: "x" });
      expect(res.ok).toBe(false);
      if (!res.ok) messages.push(res.error.message);
    }

    // Outage: the injected http.send rejects — no HTTP response is EVER received,
    // so there is no httpStatus to report.
    {
      const http = fakeHttp({ throw: new Error("ECONNRESET") });
      const transport = createWriteHttpTransport(CORE_SPEC, depsWith({ http }));
      const res = await adapterOver(transport).create(env, { title: "x" });
      expect(res.ok).toBe(false);
      if (!res.ok) messages.push(res.error.message);
    }

    // SSRF-block: an off-allowlist host is rejected before any dispatch — also no
    // httpStatus, but a DIFFERENT fault code (`rejected`, not `unreachable`) from
    // the outage above.
    {
      const spec: WriteHttpSpec = { ...CORE_SPEC, baseUrl: "https://evil.com" };
      const transport = createWriteHttpTransport(spec, depsWith());
      const res = await adapterOver(transport).create(env, { title: "x" });
      expect(res.ok).toBe(false);
      if (!res.ok) messages.push(res.error.message);
    }

    expect(messages).toHaveLength(5);
    expect(new Set(messages).size).toBe(5);
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


// ── 8. W1a/W1c — the faultDetail PRODUCER. transport.ts's `TransportFaultDetail`
//     and AdapterError.faultDetail only de-collapse anything if a transport SETS
//     them; before this round no producing site did, so the "distinction is
//     restored" doc comments were false. These pin the wiring at the ONE real
//     producer: every statusless fault return of createWriteHttpTransport.
//     NINE return sites ⇒ ELEVEN tokens (the credential-unavailable return fans
//     out over its three reasons) ⇒ ELEVEN distinct operator-facing
//     AdapterError.message strings. ──
describe("createWriteHttpTransport — every statusless fault SETS a closed faultDetail (the producer)", () => {
  const testClock = (): string => "2026-07-01T00:00:00.000Z";

  function adapterOver(transport: AdapterTransport): TargetWriteAdapter {
    return makeTargetWriteAdapter(
      { targetSystem: "drive", deriveIdentity: () => ({}) },
      { transport, clock: testClock },
    );
  }

  const throwingSecrets: WriteSecretsAccessor = {
    async getSecret(): Promise<Result<string, WriteSecretUnavailable>> {
      throw new Error("keychain accessor blew up ACCESSOR_CAUSE_LEAK");
    },
  };

  interface Case {
    readonly name: string;
    readonly token: TransportFaultDetail;
    readonly code: string;
    readonly message: string;
    readonly transport: () => AdapterTransport;
  }

  const CASES: readonly Case[] = [
    {
      name: "a throwing buildRequest",
      token: "request_build_error",
      code: "unknown",
      message: "unclassified adapter fault (request_build_error)",
      transport: () =>
        createWriteHttpTransport(
          {
            ...CORE_SPEC,
            buildRequest: () => {
              throw new Error("builder blew up BUILD_CAUSE_LEAK");
            },
          },
          depsWith(),
        ),
    },
    {
      name: "an SSRF/allowlist block",
      token: "ssrf_blocked",
      code: "rejected",
      message: "request rejected (ssrf_blocked)",
      transport: () => createWriteHttpTransport({ ...CORE_SPEC, baseUrl: "https://evil.com" }, depsWith()),
    },
    {
      name: "a THROWING credential accessor",
      token: "credential_fault",
      code: "rejected",
      message: "request rejected (credential_fault)",
      transport: () => createWriteHttpTransport(CORE_SPEC, depsWith({ secrets: throwingSecrets })),
    },
    {
      name: "a MISSING write credential",
      token: "credential_missing",
      code: "rejected",
      message: "request rejected (credential_missing)",
      transport: () =>
        createWriteHttpTransport(CORE_SPEC, depsWith({ secrets: fakeSecrets(err({ reason: "missing" })) })),
    },
    {
      name: "a LOCKED Keychain",
      token: "credential_locked",
      code: "rejected",
      message: "request rejected (credential_locked)",
      transport: () =>
        createWriteHttpTransport(CORE_SPEC, depsWith({ secrets: fakeSecrets(err({ reason: "locked" })) })),
    },
    {
      name: "a DENIED write credential",
      token: "credential_denied",
      code: "rejected",
      message: "request rejected (credential_denied)",
      transport: () =>
        createWriteHttpTransport(CORE_SPEC, depsWith({ secrets: fakeSecrets(err({ reason: "denied" })) })),
    },
    {
      name: "a whitespace-only (EMPTY) write credential",
      token: "credential_empty",
      code: "rejected",
      message: "request rejected (credential_empty)",
      transport: () => createWriteHttpTransport(CORE_SPEC, depsWith({ secrets: fakeSecrets(ok("   ")) })),
    },
    {
      name: "a network-level outage (http.send rejects)",
      token: "transport_error",
      code: "unreachable",
      message: "target system unreachable (transport_error)",
      transport: () =>
        createWriteHttpTransport(CORE_SPEC, depsWith({ http: fakeHttp({ throw: new Error("ECONNRESET") }) })),
    },
    {
      // A response DID arrive, but its status is not an integer — so there is no
      // `httpStatus` to carry, and without a token this reads exactly like a
      // malformed body or a throwing mapResponse.
      name: "a non-integer HTTP status",
      token: "malformed_status",
      code: "unknown",
      message: "unclassified adapter fault (malformed_status)",
      transport: () =>
        createWriteHttpTransport(
          CORE_SPEC,
          depsWith({ http: fakeHttp({ response: { status: Number.NaN, body: '{"id":"x"}' } }) }),
        ),
    },
    {
      name: "a malformed 2xx body",
      token: "malformed_body",
      code: "unknown",
      message: "unclassified adapter fault (malformed_body)",
      transport: () =>
        createWriteHttpTransport(
          CORE_SPEC,
          depsWith({ http: fakeHttp({ response: { status: 200, body: "<html>NOT_JSON_LEAK</html>" } }) }),
        ),
    },
    {
      name: "a throwing mapResponse",
      token: "map_error",
      code: "unknown",
      message: "unclassified adapter fault (map_error)",
      transport: () =>
        createWriteHttpTransport(
          {
            ...CORE_SPEC,
            mapResponse: () => {
              throw new Error("mapper blew up MAP_CAUSE_LEAK");
            },
          },
          depsWith({ http: fakeHttp({ response: { status: 200, body: '{"id":"x"}' } }) }),
        ),
    },
  ];

  it.each(CASES.map((c) => [c.name, c] as const))(
    "%s sets faultDetail on the TransportResponse — no statusless fault is left unwired",
    async (_name, c) => {
      const res = await c.transport()(CREATE_REQ);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected a fault");
      // The statusless invariant: no usable HTTP status exists (no response
      // arrived, or its status was not an integer), so there is no httpStatus —
      // faultDetail is the ONLY thing that can separate these.
      expect(res.httpStatus).toBeUndefined();
      expect(res.faultDetail).toBe(c.token);
    },
  );

  it.each(CASES.map((c) => [c.name, c] as const))(
    "%s reaches AdapterError with the token on its own typed field AND folded into message",
    async (_name, c) => {
      const env = makeEnvelope({ targetSystem: "drive", canonicalObjectKey: CREATE_REQ.canonicalObjectKey });
      const res = await adapterOver(c.transport()).create(env, { title: "x" });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected a fault");
      expect(res.error.code).toBe(c.code);
      expect(res.error.faultDetail).toBe(c.token);
      expect(res.error.message).toBe(c.message);
      // Still redaction-safe: the closed token is the ONLY new byte in `message`.
      expect(JSON.stringify(res.error)).not.toContain("LEAK");
    },
  );

  it("all ELEVEN statusless faults produce ELEVEN DISTINCT AdapterError.message strings", async () => {
    const env = makeEnvelope({ targetSystem: "drive", canonicalObjectKey: CREATE_REQ.canonicalObjectKey });
    const messages: string[] = [];
    for (const c of CASES) {
      const res = await adapterOver(c.transport()).create(env, { title: "x" });
      expect(res.ok).toBe(false);
      if (!res.ok) messages.push(res.error.message);
    }
    expect(messages).toHaveLength(11);
    expect(new Set(messages).size).toBe(11);
  });

  it("the CASES set covers EVERY member of the closed TransportFaultDetail union — a new token cannot be added unwired", () => {
    // The union is the contract; this list is the proof the producer honours it.
    // Without this, adding a token to transport.ts and forgetting the producing
    // site would leave the suite green — the exact shape of the original
    // built-but-unwired defect.
    expect(new Set(CASES.map((c) => c.token))).toEqual(new Set(TransportFaultDetail));
  });

  it("a LOCKED Keychain does not read the same as an SSRF-BLOCKED host (the named regression)", async () => {
    const env = makeEnvelope({ targetSystem: "drive", canonicalObjectKey: CREATE_REQ.canonicalObjectKey });
    const locked = await adapterOver(
      createWriteHttpTransport(CORE_SPEC, depsWith({ secrets: fakeSecrets(err({ reason: "locked" })) })),
    ).create(env, { title: "x" });
    const ssrf = await adapterOver(
      createWriteHttpTransport({ ...CORE_SPEC, baseUrl: "https://evil.com" }, depsWith()),
    ).create(env, { title: "x" });
    if (locked.ok || ssrf.ok) throw new Error("expected two faults");
    // Same code, same (absent) httpStatus — the ONLY separator is faultDetail.
    expect(locked.error.code).toBe(ssrf.error.code);
    expect(locked.error.httpStatus).toBeUndefined();
    expect(ssrf.error.httpStatus).toBeUndefined();
    expect(locked.error.message).not.toBe(ssrf.error.message);
    expect(locked.error.message).toBe("request rejected (credential_locked)");
    expect(ssrf.error.message).toBe("request rejected (ssrf_blocked)");
  });

  it("W1c — a malformed 2xx body, a throwing buildRequest, a non-integer status and a throwing mapResponse no longer all read 'unclassified adapter fault'", async () => {
    const env = makeEnvelope({ targetSystem: "drive", canonicalObjectKey: CREATE_REQ.canonicalObjectKey });
    const unknowns = CASES.filter((c) => c.code === "unknown");
    expect(unknowns).toHaveLength(4);
    const messages: string[] = [];
    for (const c of unknowns) {
      const res = await adapterOver(c.transport()).create(env, { title: "x" });
      if (res.ok) throw new Error("expected a fault");
      expect(res.error.code).toBe("unknown");
      messages.push(res.error.message);
    }
    expect(new Set(messages).size).toBe(4);
  });
});

// ── 9. W1b — RETRYABLE 4xx must stay retryable. `rejected` routes TERMINAL at the
//     gateway, so mapping every 4xx to `rejected` made a 429 (rate limit) and a
//     408 (request timeout) permanent failures. The classification of the STATUS
//     is what is fixed — `rejected` itself stays terminal. ────────────────────
describe("createWriteHttpTransport — status classification: retryable vs terminal", () => {
  async function faultFor(status: number): Promise<string> {
    const http = fakeHttp({ response: { status, body: JSON.stringify({ secret_body: "BODY_LEAK" }) } });
    const res = await createWriteHttpTransport(CORE_SPEC, depsWith({ http }))(CREATE_REQ);
    if (res.ok) throw new Error(`expected a fault for ${status}`);
    expect(JSON.stringify(res)).not.toContain("BODY_LEAK");
    return res.fault;
  }

  it.each([
    [408, "unreachable"], // RFC 9110 §15.5.9 — the client MAY repeat the request
    [425, "unreachable"], // RFC 8470 §5.2 — retry once the handshake completes
    [429, "unreachable"], // RFC 6585 §4 — a rate limit is temporal, by definition
  ])("HTTP %s is RETRYABLE ⇒ unreachable (the outbox-hold signal), never terminal", async (status, expected) => {
    expect(await faultFor(status)).toBe(expected);
  });

  it.each([
    [400, "rejected"],
    [401, "rejected"], // auth: retrying cannot fix a credential, and must not hide it
    [403, "rejected"],
    [404, "rejected"], // drive.ts promotes this one to `not_found` — still terminal
    [422, "rejected"],
    [423, "rejected"], // Locked: unbounded duration + a never-expiring hold ⇒ terminal
    [451, "rejected"],
  ])("HTTP %s is TERMINAL ⇒ rejected — a retry sends the same bytes", async (status, expected) => {
    expect(await faultFor(status)).toBe(expected);
  });

  it.each([
    [409, "conflict"],
    [412, "conflict"],
  ])("HTTP %s stays a conflict (NEVER a blind overwrite)", async (status, expected) => {
    expect(await faultFor(status)).toBe(expected);
  });

  it.each([
    [500, "unreachable"],
    [502, "unreachable"],
    [503, "unreachable"],
  ])("HTTP %s stays retryable ⇒ unreachable", async (status, expected) => {
    expect(await faultFor(status)).toBe(expected);
  });

  it.each([
    [100, "unknown"],
    [301, "unknown"],
    [600, "unknown"],
  ])("HTTP %s (out of every classified range) ⇒ unknown, which is TERMINAL", async (status, expected) => {
    expect(await faultFor(status)).toBe(expected);
  });

  it("status 0 ⇒ unreachable — the client convention for 'no response obtained', not an unknown code", async () => {
    expect(await faultFor(0)).toBe("unreachable");
  });

  it("status 0 and a THROWN send are the SAME event, so they get the SAME disposition", async () => {
    // This is the whole argument for the special case: 0 is what an injected
    // client that CATCHES a network failure reports instead of throwing. If the
    // two encodings classified differently, the write's fate would depend on how
    // the injected HttpTransport was written rather than on what happened.
    const returned = await createWriteHttpTransport(
      CORE_SPEC,
      depsWith({ http: fakeHttp({ response: { status: 0, body: "" } }) }),
    )(CREATE_REQ);
    const thrown = await createWriteHttpTransport(
      CORE_SPEC,
      depsWith({ http: fakeHttp({ throw: new Error("ECONNRESET") }) }),
    )(CREATE_REQ);
    if (returned.ok || thrown.ok) throw new Error("expected two faults");
    expect(returned.fault).toBe(thrown.fault);
    expect(returned.fault).toBe("unreachable");
    // They stay TELLABLE APART: the returned one carries the vendor-reported
    // status, the thrown one carries the closed transport_error token.
    expect(returned.httpStatus).toBe(0);
    expect(thrown.httpStatus).toBeUndefined();
    expect(thrown.faultDetail).toBe("transport_error");
  });

  it("only 0 is carved out below 200 — 1/99/199 stay unknown/terminal", async () => {
    for (const status of [1, 99, 199]) {
      expect(await faultFor(status)).toBe("unknown");
    }
  });

  it("the retryable set is exactly {408, 425, 429} — every OTHER 4xx terminates", async () => {
    const retryable: number[] = [];
    for (let status = 400; status < 500; status += 1) {
      if (status === 409 || status === 412) continue; // conflict, its own disposition
      if ((await faultFor(status)) === "unreachable") retryable.push(status);
    }
    expect(retryable).toEqual([408, 425, 429]);
  });
});

// ── 10. W1b end-to-end — the disposition that actually matters. A 429 must reach
//      the outbox as `held`; a 401 must terminate as `rejected`. Driven through
//      the REAL transport + the REAL adapter core + the REAL Tool Gateway. ────
describe("W1b end-to-end — dispatchExternalWrite over the real write transport", () => {
  const FIXED_CLOCK = (): string => "2026-07-01T00:00:00.000Z";

  // A query MISS on the probe so the pipeline proceeds to the create; the create
  // then meets the status under test.
  const GATEWAY_SPEC: WriteHttpSpec = {
    ...CORE_SPEC,
    mapResponse: (_status, json, req) => {
      if (req.op === "query") return { ok: true, object: null };
      const obj = json as { id?: string };
      if (typeof obj?.id !== "string") return { ok: false, fault: "unknown", detail: "missing id" };
      return { ok: true, object: { externalObjectId: obj.id } };
    },
  };

  function sequencedHttp(responses: readonly HttpTransportResponse[]): HttpTransport {
    let i = 0;
    return {
      async send() {
        const r = responses[Math.min(i, responses.length - 1)]!;
        i += 1;
        return r;
      },
    };
  }

  function depsFor(responses: readonly HttpTransportResponse[]): ExternalWriteDeps {
    const transport = createWriteHttpTransport(
      GATEWAY_SPEC,
      { http: sequencedHttp(responses), secrets: fakeSecrets() },
    );
    return {
      adapter: makeTargetWriteAdapter(
        { targetSystem: "drive", deriveIdentity: () => ({}) },
        { transport, clock: FIXED_CLOCK },
      ),
      receiptStore: new InMemoryReceiptStore(),
      requireApproval: () => ({ requiresApproval: false }),
      recordPendingApproval: async () => ok(undefined),
      isApproved: async () => false,
      audit: async () => {},
      clock: FIXED_CLOCK,
    };
  }

  function envAndAction() {
    const action = makeProposedAction({ idempotencyKey: "idem_w1b", canonicalObjectKey: "cok_w1b" });
    const built = buildEnvelopeFromAction(action, { preconditions: ["exists_check"] });
    if (!built.ok) throw new Error("test envelope failed to build");
    return { action, env: built.value };
  }

  const PROBE_MISS: HttpTransportResponse = { status: 200, body: "{}" };

  it("a CREATE that meets HTTP 429 is HELD for retry — a rate limit does not fail the write closed", async () => {
    const { action, env } = envAndAction();
    const res = await dispatchExternalWrite(env, action, depsFor([PROBE_MISS, { status: 429, body: "{}" }]));
    expect(res.status).toBe("held");
    if (res.status !== "held") throw new Error("unreachable");
    expect(res.adapterCode).toBe("unreachable");
    expect(res.reason).toContain("HTTP 429");
  });

  it("a CREATE that meets HTTP 408 is HELD for retry", async () => {
    const { action, env } = envAndAction();
    const res = await dispatchExternalWrite(env, action, depsFor([PROBE_MISS, { status: 408, body: "{}" }]));
    expect(res.status).toBe("held");
  });

  it("a CREATE that meets HTTP 401 still TERMINATES as rejected — the cc26027c fix is not undone", async () => {
    const { action, env } = envAndAction();
    const res = await dispatchExternalWrite(env, action, depsFor([PROBE_MISS, { status: 401, body: "{}" }]));
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") throw new Error("unreachable");
    expect(res.adapterCode).toBe("rejected");
    expect(res.reason).toContain("HTTP 401");
  });

  it("an EXISTENCE PROBE that meets HTTP 429 is HELD too — both gateway fault arms agree", async () => {
    const { action, env } = envAndAction();
    const res = await dispatchExternalWrite(env, action, depsFor([{ status: 429, body: "{}" }]));
    expect(res.status).toBe("held");
    if (res.status !== "held") throw new Error("unreachable");
    expect(res.adapterCode).toBe("unreachable");
    expect(res.reason).toContain("existence-check");
  });

  it("an EXISTENCE PROBE that meets HTTP 403 still terminates as rejected", async () => {
    const { action, env } = envAndAction();
    const res = await dispatchExternalWrite(env, action, depsFor([{ status: 403, body: "{}" }]));
    expect(res.status).toBe("rejected");
  });

  it("a LOCKED Keychain terminates as rejected AND names itself in the operator-facing reason", async () => {
    const { action, env } = envAndAction();
    const transport = createWriteHttpTransport(GATEWAY_SPEC, {
      http: sequencedHttp([PROBE_MISS]),
      secrets: fakeSecrets(err({ reason: "locked" })),
    });
    const deps: ExternalWriteDeps = {
      ...depsFor([PROBE_MISS]),
      adapter: makeTargetWriteAdapter(
        { targetSystem: "drive", deriveIdentity: () => ({}) },
        { transport, clock: FIXED_CLOCK },
      ),
    };
    const res = await dispatchExternalWrite(env, action, deps);
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") throw new Error("unreachable");
    // The end-to-end payoff of W1a: this string used to be "request rejected",
    // identical to an SSRF block.
    expect(res.reason).toContain("credential_locked");
  });
});
