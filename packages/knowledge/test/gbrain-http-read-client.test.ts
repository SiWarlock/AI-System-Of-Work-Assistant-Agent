// spec(§6) spec(§7) — the GbrainReadClient HTTP transport over `gbrain serve --http` (read-only, loopback+allowlist,
// bearer token resolved from the grant's tokenRef via an injected SecretsAccessor). Dormant arming-prep Item 2a:
// tested ENTIRELY with a FAKE HttpTransport + FAKE SecretsAccessor — zero real network / process / Keychain.
// The transport `invoke` throws a REDACTED typed fault on any failure; the adapter maps it to `transport_fault`.
import { describe, it, expect } from "vitest";
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type { GbrainAllowedOp } from "../src/gbrain/mcp-read-adapter";
import {
  createGbrainHttpReadClient,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type SecretsAccessor,
  type SecretUnavailable,
  type GbrainHttpReadClientDeps,
} from "../src/gbrain/gbrain-http-read-client";

const TOKEN = "gb-secret-token-XYZ";
const TOKEN_REF = "keychain:gbrain-token";
const LOOPBACK = "http://127.0.0.1:8899";

function fakeTransport(
  behavior: { response?: HttpTransportResponse; throw?: unknown } = {},
): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  return {
    calls,
    async send(req) {
      calls.push(req);
      if (behavior.throw !== undefined) throw behavior.throw;
      return behavior.response ?? { status: 200, body: JSON.stringify({ ok: true }) };
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

function makeDeps(overrides: Partial<GbrainHttpReadClientDeps> = {}): GbrainHttpReadClientDeps {
  return {
    transport: fakeTransport(),
    secrets: fakeSecrets(),
    tokenRef: TOKEN_REF,
    endpoint: LOOPBACK,
    allowedEndpoints: [LOOPBACK],
    ...overrides,
  };
}

/** Serialize EVERYTHING reachable on a thrown value (message, stack, own props incl. `code`/`cause`) so a
 *  "never leaks" assertion cannot pass just because the token hid in a non-enumerable field. */
function dumpError(e: unknown): string {
  const own = typeof e === "object" && e !== null ? JSON.stringify(e, Object.getOwnPropertyNames(e)) : "";
  const stack = typeof e === "object" && e !== null && "stack" in e ? String((e as { stack: unknown }).stack) : "";
  return `${String(e)} ${own} ${stack}`;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  // Capture the rejection reason + let the caller assert UNCONDITIONALLY (a `.catch(cb)` passes vacuously if the
  // code ever RESOLVES — the exact fail-closed property these tests pin, LESSONS.md §15).
  return p.then(
    () => {
      throw new Error("expected invoke to REJECT, but it resolved");
    },
    (e: unknown) => e,
  );
}

describe("createGbrainHttpReadClient — injected-transport dispatch (spec §7)", () => {
  it("invoke('graph', payload) dispatches ONE request with the mapped URL, POST, and a bearer header", async () => {
    const transport = fakeTransport({ response: { status: 200, body: JSON.stringify({ nodes: [] }) } });
    const secrets = fakeSecrets(ok(TOKEN));
    const client = createGbrainHttpReadClient(makeDeps({ transport, secrets }));
    await client.invoke("graph", { q: "x" });
    expect(transport.calls).toHaveLength(1);
    const req = transport.calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${LOOPBACK}/read/graph`);
    expect(req.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(req.body).toContain('"q"'); // the payload is serialized into the body
  });

  it("carries the JSON payload, and context when present, in the request body", async () => {
    const transport = fakeTransport({ response: { status: 200, body: "{}" } });
    const client = createGbrainHttpReadClient(makeDeps({ transport }));
    await client.invoke("contained_synthesis", { q: "z" }, [{ ctx: 1 }]);
    const body = JSON.parse(transport.calls[0]!.body) as { payload: unknown; context?: unknown };
    expect(body.payload).toEqual({ q: "z" });
    expect(body.context).toEqual([{ ctx: 1 }]);
  });

  it("omits the context key from the body when no context is passed", async () => {
    const transport = fakeTransport({ response: { status: 200, body: "{}" } });
    const client = createGbrainHttpReadClient(makeDeps({ transport }));
    await client.invoke("search", { q: 1 });
    const body = JSON.parse(transport.calls[0]!.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("context");
  });

  it("a trailing-slash endpoint (on the allowlist) dispatches to a single-slash URL", async () => {
    const ep = "http://127.0.0.1:8899/";
    const transport = fakeTransport({ response: { status: 200, body: "{}" } });
    const client = createGbrainHttpReadClient(makeDeps({ transport, endpoint: ep, allowedEndpoints: [ep] }));
    await client.invoke("search", {});
    expect(transport.calls[0]!.url).toBe("http://127.0.0.1:8899/read/search"); // trimTrailingSlash — no doubled slash
  });
});

describe("createGbrainHttpReadClient — 2xx body (spec §6)", () => {
  it("resolves a 2xx JSON body as the parsed object (the adapter/piece B interpret its shape)", async () => {
    const transport = fakeTransport({ response: { status: 200, body: JSON.stringify({ hits: [1, 2] }) } });
    const client = createGbrainHttpReadClient(makeDeps({ transport }));
    const out = await client.invoke("search", { q: "x" });
    expect(out).toEqual({ hits: [1, 2] });
  });
});

describe("createGbrainHttpReadClient — token via SecretsAccessor, fail-closed (REQ-S-003 / rule 7)", () => {
  it("resolves the token from tokenRef; it rides ONLY the header and never appears in a thrown fault", async () => {
    const secrets = fakeSecrets(ok(TOKEN));
    // a malformed body forces a fault AFTER the token was resolved + attached — proving the fault carries no token
    const transport = fakeTransport({ response: { status: 200, body: "not-json{" } });
    const client = createGbrainHttpReadClient(makeDeps({ transport, secrets }));
    const thrown = await rejection(client.invoke("search", { q: "x" }));
    expect(secrets.refs).toEqual([TOKEN_REF]); // resolved from the grant's tokenRef
    expect(transport.calls[0]!.headers["Authorization"]).toBe(`Bearer ${TOKEN}`); // token on the header only
    expect(dumpError(thrown)).not.toContain(TOKEN); // never in the fault
  });

  it("a locked/missing/denied token fails CLOSED — invoke rejects (redacted) and the transport is NEVER called", async () => {
    const transport = fakeTransport();
    const secrets = fakeSecrets(err({ reason: "locked" }));
    const client = createGbrainHttpReadClient(makeDeps({ transport, secrets }));
    const thrown = await rejection(client.invoke("search", { q: "x" }));
    expect(transport.calls).toHaveLength(0); // NO dispatch — the token gate is BEFORE the send
    expect(dumpError(thrown)).not.toContain(TOKEN);
    expect(String(thrown)).toMatch(/token|unavailable|locked/i); // a redaction-safe reason, not the raw secret
  });

  it("a SecretsAccessor that THROWS (real-Keychain boundary) fails CLOSED — mapped to token_unavailable, NO dispatch, raw detail not leaked", async () => {
    // The seam contract is Result-returning, but the real Keychain adapter can THROW (TCC denial / spawn / native
    // error). A raw throw must NOT escape the redacted envelope into the adapter's transport_fault.cause.
    const transport = fakeTransport();
    const secrets: SecretsAccessor = {
      async getSecret() {
        throw new Error("KEYCHAIN_RAW_DETAIL_SECURITY");
      },
    };
    const client = createGbrainHttpReadClient(makeDeps({ transport, secrets }));
    const thrown = await rejection(client.invoke("search", {}));
    expect(transport.calls).toHaveLength(0); // no dispatch
    expect(String(thrown)).toContain("token_unavailable"); // mapped to the redacted typed fault
    expect(dumpError(thrown)).not.toContain("KEYCHAIN_RAW_DETAIL_SECURITY"); // the raw Keychain detail is discarded
  });
});

describe("createGbrainHttpReadClient — loopback + allowlist SSRF/egress guard (Lesson 4)", () => {
  it("refuses a non-loopback endpoint with NO dispatch", async () => {
    const transport = fakeTransport();
    const client = createGbrainHttpReadClient(
      makeDeps({ transport, endpoint: "http://evil.example.com", allowedEndpoints: ["http://evil.example.com"] }),
    );
    await rejection(client.invoke("search", {}));
    expect(transport.calls).toHaveLength(0);
  });

  it("refuses a loopback endpoint that is OFF the allowlist with NO dispatch", async () => {
    const transport = fakeTransport();
    const client = createGbrainHttpReadClient(
      makeDeps({ transport, endpoint: LOOPBACK, allowedEndpoints: ["http://127.0.0.1:1234"] }),
    );
    await rejection(client.invoke("search", {}));
    expect(transport.calls).toHaveLength(0);
  });

  it("refuses a loopback-SPOOF endpoint even when allowlisted (authority-isolated, not a substring host match)", async () => {
    const spoof = "http://evil.com/@127.0.0.1";
    const transport = fakeTransport();
    const client = createGbrainHttpReadClient(
      makeDeps({ transport, endpoint: spoof, allowedEndpoints: [spoof] }),
    );
    await rejection(client.invoke("search", {}));
    expect(transport.calls).toHaveLength(0); // isLoopbackEndpoint isolates the authority BEFORE the host check
  });

  it("dispatches when the endpoint is loopback AND on the allowlist", async () => {
    const transport = fakeTransport({ response: { status: 200, body: "{}" } });
    const client = createGbrainHttpReadClient(makeDeps({ transport, endpoint: LOOPBACK, allowedEndpoints: [LOOPBACK] }));
    await client.invoke("search", {});
    expect(transport.calls).toHaveLength(1);
  });

  it("an EMPTY allowlist refuses every endpoint (fail-closed) with NO dispatch", async () => {
    const transport = fakeTransport();
    const client = createGbrainHttpReadClient(makeDeps({ transport, endpoint: LOOPBACK, allowedEndpoints: [] }));
    await rejection(client.invoke("search", {}));
    expect(transport.calls).toHaveLength(0);
  });
});

describe("createGbrainHttpReadClient — redacted fault mapping (fail-closed, never leaks)", () => {
  it("a non-2xx status ⇒ a redacted typed failure; the raw body + token never surface", async () => {
    const transport = fakeTransport({ response: { status: 503, body: JSON.stringify({ secret_body: "RAW-DB-DUMP" }) } });
    const secrets = fakeSecrets(ok(TOKEN));
    const client = createGbrainHttpReadClient(makeDeps({ transport, secrets }));
    const thrown = await rejection(client.invoke("search", {}));
    const dump = dumpError(thrown);
    expect(dump).not.toContain("RAW-DB-DUMP");
    expect(dump).not.toContain(TOKEN);
    expect(String(thrown)).toMatch(/503|status/i); // the safe status is surfaced
  });

  it("a transport reject ⇒ a redacted failure; the raw cause/token never surface (Lesson 15)", async () => {
    const transport = fakeTransport({ throw: new Error(`ECONNREFUSED ${LOOPBACK} ${TOKEN}`) });
    const client = createGbrainHttpReadClient(makeDeps({ transport }));
    const thrown = await rejection(client.invoke("search", {}));
    const dump = dumpError(thrown);
    expect(dump).not.toContain(TOKEN); // the token never rides a transport-fault message
    expect(dump).not.toContain("ECONNREFUSED"); // the raw cause message is not echoed
  });

  it("a malformed (non-JSON) 2xx body ⇒ a redacted failure; the raw body is not echoed", async () => {
    const transport = fakeTransport({ response: { status: 200, body: "<<not json>>" } });
    const client = createGbrainHttpReadClient(makeDeps({ transport }));
    const thrown = await rejection(client.invoke("search", {}));
    expect(dumpError(thrown)).not.toContain("<<not json>>");
  });

  it("a non-numeric HTTP status fails CLOSED (status_error) — never treated as a 2xx success", async () => {
    // A misbehaving transport returning a non-numeric status must NOT slip through the 2xx range check.
    const transport = fakeTransport({ response: { status: Number.NaN, body: JSON.stringify({ hijacked: true }) } });
    const client = createGbrainHttpReadClient(makeDeps({ transport }));
    const thrown = await rejection(client.invoke("search", {}));
    expect(String(thrown)).toMatch(/status/i); // rejected as a status fault, not resolved as a body
  });

  it("an empty-string 2xx body ⇒ malformed_body (fail-closed parse)", async () => {
    const transport = fakeTransport({ response: { status: 200, body: "" } });
    const client = createGbrainHttpReadClient(makeDeps({ transport }));
    const thrown = await rejection(client.invoke("search", {}));
    expect(String(thrown)).toMatch(/malformed/i);
  });
});

describe("createGbrainHttpReadClient — op→path map over the read surface (spec §6)", () => {
  it("each read op maps to its documented gbrain serve --http path + POST method", async () => {
    const cases: Array<[GbrainAllowedOp, string]> = [
      ["search", "/read/search"],
      ["graph", "/read/graph"],
      ["timeline", "/read/timeline"],
      ["schema_read", "/read/schema"],
      ["health", "/read/health"],
      ["contained_synthesis", "/read/contained-synthesis"],
    ];
    for (const [op, path] of cases) {
      const transport = fakeTransport({ response: { status: 200, body: "{}" } });
      const client = createGbrainHttpReadClient(makeDeps({ transport }));
      await client.invoke(op, {});
      expect(transport.calls[0]!.url).toBe(`${LOOPBACK}${path}`);
      expect(transport.calls[0]!.method).toBe("POST");
    }
  });
});
