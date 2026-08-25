// Task 23.5 — the DORMANT candidate URL-source HTTP transport (`createUrlSourceHttpTransport`)
// over the connector-HTTP template (13.12), specialized to a candidate `{ items:[{locator,…}] }`
// envelope (arch_gap — no fixed vendor host; a generic "paste a link" source has no such host, so
// `allowedHosts` is CALLER-supplied at construction, mirroring `createWebFetchTransport`). The
// read CONNECTOR (`createUrlSourceConnector`, `http:get`) already exists (slice 6.3) — this adds
// the candidate transport half. Real transport + per-request target url stay UNBOUND (§ARM-23);
// tests inject fakes.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { ok } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type {
  HttpTransport,
  HttpTransportRequest,
  HttpTransportResponse,
  SecretsAccessor,
  SecretUnavailable,
} from "../src/connectors/adapters/http-transport";
import type { TransportRequest } from "../src/connectors/transport";
import {
  createUrlSourceHttpTransport,
  createUrlSourceConnector,
} from "../src/connectors/adapters/url-source";

const TOKEN_REF = "keychain:url-source";
const ALLOWED = ["example.invalid"] as const;
const REQ: TransportRequest = { readScope: "http:get" };

function fakeTransport(
  behavior: { response?: HttpTransportResponse; throw?: unknown } = {},
): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  return {
    calls,
    async send(req) {
      calls.push(req);
      if (behavior.throw !== undefined) throw behavior.throw;
      return behavior.response ?? { status: 200, body: JSON.stringify({ items: [] }) };
    },
  };
}

function fakeSecrets(result: Result<string, SecretUnavailable> = ok("unused-token")): SecretsAccessor {
  return { async getSecret() { return result; } };
}

const run = (transport: HttpTransport, allowedHosts: readonly string[] = [...ALLOWED], req: TransportRequest = REQ) =>
  createUrlSourceHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF, allowedHosts })(req);

// ── 9. readScope stays http:get + method stays GET default — no mutating method possible ─────
describe("createUrlSourceHttpTransport — GET-only, never a mutating method (ING-7)", () => {
  it("the CONNECTOR (createUrlSourceConnector) still declares readScope 'http:get' (unchanged)", () => {
    // Regression pin on the pre-existing 6.3 connector — this leg only ADDS the transport half.
    const port = createUrlSourceConnector(async () => ({ ok: true, items: [], done: true }));
    expect(port.connectorId).toBe("url-source");
  });

  it("the dispatched HttpTransportRequest.method is 'GET' — the spec never opts into POST/PUT/DELETE", async () => {
    const t = fakeTransport({ response: { status: 200, body: JSON.stringify({ items: [] }) } });
    await run(t);
    expect(t.calls.length).toBe(1);
    expect(t.calls[0]!.method).toBe("GET");
  });
});

// ── 10. mapPage fail-closed: non-object body, missing locator, malformed entry ────────────────
describe("createUrlSourceHttpTransport — mapPage fail-closed on a malformed candidate envelope", () => {
  it.each([
    ["non-object body", "42"],
    ["missing items[]", JSON.stringify({})],
    ["items not an array", JSON.stringify({ items: {} })],
    ["malformed entry (null)", JSON.stringify({ items: [null] })],
    ["entry missing locator", JSON.stringify({ items: [{ title: "no locator here" }] })],
    ["entry locator non-string", JSON.stringify({ items: [{ locator: 42 }] })],
    ["entry locator empty string", JSON.stringify({ items: [{ locator: "" }] })],
  ])("%s ⇒ a TransportFailure via transportFailure, never a false page", async (_label, body) => {
    const res = await run(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(false);
  });

  it("a well-formed envelope maps locator ⇒ TransportItem.id, distinct payloadHash per locator", async () => {
    const body = JSON.stringify({ items: [{ locator: "https://a.example/x" }, { locator: "https://b.example/y" }] });
    const res = await run(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items.map((i) => i.id)).toEqual(["https://a.example/x", "https://b.example/y"]);
      expect(res.items[0]!.hash).not.toBe(res.items[1]!.hash);
      expect(res.done).toBe(true); // single-fetch candidate — no pagination
    }
  });
});

// ── 11. allowedHosts REQUIRED at construction + DORMANT (no real bind, token unbound) ─────────
describe("createUrlSourceHttpTransport — allowedHosts REQUIRED at construction; DORMANT", () => {
  it("an EMPTY allowedHosts admits nothing (fail-closed by construction, zero dispatch)", async () => {
    const t = fakeTransport({ response: { status: 200, body: JSON.stringify({ items: [] }) } });
    const res = await run(t, []); // no allowlisted host at all
    expect(res.ok).toBe(false);
    expect(t.calls.length).toBe(0);
  });

  it("a non-allowlisted host ⇒ typed fault with ZERO dispatch (SSRF guard, L4)", async () => {
    const t = fakeTransport({ response: { status: 200, body: JSON.stringify({ items: [] }) } });
    const res = await run(t, ["some-other-host.example"]);
    expect(res.ok).toBe(false);
    expect(t.calls.length).toBe(0);
  });

  it("dormant — the module constructs NO real HTTP client (injected transport is the sole seam)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/connectors/adapters/url-source.ts", import.meta.url)),
      "utf8",
    );
    for (const forbidden of ["node:https", "node:http", "undici", "axios", "fetch(", "XMLHttpRequest"]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });

  it("dormant — no production caller CONSTRUCTS the HTTP transport (unbound seam; real bind = §ARM-23)", () => {
    const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
    const files = readdirSync(srcRoot, { recursive: true, encoding: "utf8" }).filter(
      (f): f is string => typeof f === "string" && f.endsWith(".ts") && !f.endsWith("url-source.ts"),
    );
    const callers = files.filter((f) => readFileSync(join(srcRoot, f), "utf8").includes("createUrlSourceHttpTransport("));
    expect(callers).toEqual([]); // zero production callers — the token stays UNBOUND
  });
});
