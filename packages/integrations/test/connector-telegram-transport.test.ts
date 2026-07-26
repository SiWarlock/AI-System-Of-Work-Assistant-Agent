// Task 21.3 (telegram-read leg) — the DORMANT read-only Telegram-capture HTTP transport
// (`createTelegramCaptureHttpTransport` + `TELEGRAM_HTTP_SPEC`) over the connector-HTTP
// template, specialized to the Telegram Bot API `getUpdates` wire shape (Context7-grounded
// candidate, arch_gap): `GET https://api.telegram.org/bot<TOKEN>/getUpdates?offset=&limit=`,
// envelope `{ ok:true, result: Update[] }`, `Update{ update_id, message? }`, offset = last
// update_id + 1 (client-computed). ⚠ TOKEN-IN-PATH (not a Bearer header) via the template's
// `pathAuth` mode — the token must NEVER reach a fault/log (rule 7). The read CONNECTOR
// (`createTelegramCaptureConnector`, messages:read) already exists (slice 6.3) — this adds the
// transport half. Real transport + token stay UNBOUND (§ARM-23); tests inject fakes.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { ok } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import {
  createConnectorHttpTransport,
  type ConnectorHttpSpec,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type SecretsAccessor,
  type SecretUnavailable,
} from "../src/connectors/adapters/http-transport";
import type { TransportRequest } from "../src/connectors/transport";
import {
  createTelegramCaptureHttpTransport,
  createTelegramCaptureConnector,
} from "../src/connectors/adapters/telegram-capture";

const TOKEN = "123456789:AA-Real_Telegram_Bot_Token123";
const TOKEN_REF = "keychain:telegram-bot";
const REQ: TransportRequest = { readScope: "messages:read" };

function fakeTransport(
  behavior: { response?: HttpTransportResponse; throw?: unknown } = {},
): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  return {
    calls,
    async send(req) {
      calls.push(req);
      if (behavior.throw !== undefined) throw behavior.throw;
      return behavior.response ?? { status: 200, body: JSON.stringify({ ok: true, result: [] }) };
    },
  };
}

function fakeSecrets(
  result: Result<string, SecretUnavailable> = ok(TOKEN),
  opts: { throw?: unknown } = {},
): SecretsAccessor {
  return {
    async getSecret() {
      if (opts.throw !== undefined) throw opts.throw;
      return result;
    },
  };
}

const UPDATES = [
  { update_id: 100, message: { message_id: 1, text: "hi", chat: { id: 5 } } },
  { update_id: 101, message: { message_id: 2, text: "there", chat: { id: 5 } } },
];
const page = (result: unknown[] = UPDATES): string => JSON.stringify({ ok: true, result });

const run = (
  transport: HttpTransport,
  req: TransportRequest = REQ,
  secrets: SecretsAccessor = fakeSecrets(),
) => createTelegramCaptureHttpTransport({ transport, secrets, tokenRef: TOKEN_REF })(req);

// ── 1. Candidate getUpdates page maps ⇒ TransportPage (arch_gap) ──────────────
describe("createTelegramCaptureHttpTransport — getUpdates {ok,result} page maps (arch_gap)", () => {
  it("result[] ⇒ items (id=update_id, distinct payloadHash({update_id}), raw=update), offset=max+1, done=false", async () => {
    const res = await run(fakeTransport({ response: { status: 200, body: page() } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items.map((i) => i.id)).toEqual(["100", "101"]);
      expect(res.items[0]!.hash).not.toBe(res.items[1]!.hash);
      expect(res.items[0]!.raw).toEqual(UPDATES[0]);
      expect(res.nextCursor).toBe("102"); // max(update_id) + 1
      expect(res.done).toBe(false);
    }
  });

  it("empty result[] ⇒ ok, 0 items, done=true (drain complete)", async () => {
    const res = await run(fakeTransport({ response: { status: 200, body: page([]) } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items.length).toBe(0);
      expect(res.done).toBe(true);
      expect(res.nextCursor).toBeUndefined();
    }
  });

  it("contentHash is deterministic/replay-stable per update_id", async () => {
    const a = await run(fakeTransport({ response: { status: 200, body: page([UPDATES[0]]) } }));
    const b = await run(fakeTransport({ response: { status: 200, body: page([UPDATES[0]]) } }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.items[0]!.hash).toBe(b.items[0]!.hash);
  });
});

// ── 2. Fail-closed candidate mapping (L21) ────────────────────────────────────
describe("createTelegramCaptureHttpTransport — fail-closed on a malformed envelope", () => {
  it.each([
    ["not an object", "42"],
    ["ok not true", JSON.stringify({ ok: false, result: [] })],
    ["missing result[]", JSON.stringify({ ok: true })],
    ["result not an array", JSON.stringify({ ok: true, result: {} })],
    ["malformed update entry", JSON.stringify({ ok: true, result: [null] })],
    ["update missing update_id", JSON.stringify({ ok: true, result: [{ message: {} }] })],
    ["update non-number update_id", JSON.stringify({ ok: true, result: [{ update_id: "100" }] })],
  ])("%s ⇒ a TransportFailure, never a false page", async (_label, body) => {
    const res = await run(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(false);
  });
});

// ── 3. TOKEN-IN-PATH (rule 7) + allowlist fail-closed + SSRF ──────────────────
describe("createTelegramCaptureHttpTransport — token-in-path, never logged (rule 7)", () => {
  it("the token rides the URL PATH (/bot<token>/getUpdates), with NO Authorization header", async () => {
    const t = fakeTransport({ response: { status: 200, body: page([]) } });
    await run(t);
    const sent = t.calls[0]!;
    expect(sent.url.startsWith(`https://api.telegram.org/bot${TOKEN}/getUpdates`)).toBe(true);
    expect(sent.headers.Authorization).toBeUndefined(); // path-auth ⇒ no Bearer header
  });

  it.each([
    ["transport throw", fakeTransport({ throw: new Error("net down") })],
    ["HTTP 500", fakeTransport({ response: { status: 500, body: "err" } })],
    ["NaN status", fakeTransport({ response: { status: NaN, body: page() } })],
    ["malformed body", fakeTransport({ response: { status: 200, body: "<<not json>>" } })],
  ])("the path token NEVER appears in ANY fault message (%s) — host-only refs, rule 7", async (_label, transport) => {
    // A valid-but-marked token: it rides the request url PATH but must be absent from every fault path.
    const MARKER = "999:MARKER_secret_token_XYZ";
    const res = await run(transport, REQ, fakeSecrets(ok(MARKER)));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message.includes(MARKER)).toBe(false);
      expect(res.message.includes("MARKER")).toBe(false);
    }
  });

  it("a pathAuth spec without a {token} placeholder fails closed (no tokenless dispatch)", async () => {
    // Shared-template robustness: a misconfigured future pathAuth connector must NOT silently drop the token.
    const badSpec: ConnectorHttpSpec = {
      baseUrl: "https://api.telegram.org",
      allowedHosts: ["api.telegram.org"],
      resourcePath: "/getUpdates", // ⚠ no {token}
      buildQuery: () => "?limit=1",
      mapPage: () => ({ ok: true, items: [], done: true }),
      pathAuth: true,
    };
    const t = fakeTransport({ response: { status: 200, body: page([]) } });
    const res = await createConnectorHttpTransport(badSpec, { transport: t, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    expect(res.ok).toBe(false);
    expect(t.calls.length).toBe(0); // fail-closed before dispatch
  });

  it.each([
    ["backslash (authority-spoof)", "123\\456"],
    ["slash (path break)", "123/456"],
    ["at (authority delimiter)", "123@evil.com"],
    ["question mark", "123?x=y"],
    ["hash", "123#frag"],
    ["space", "123 456"],
  ])("a token failing the safe-path allowlist (%s) ⇒ auth_locked, no dispatch, token not echoed", async (_label, badToken) => {
    const t = fakeTransport({ response: { status: 200, body: page([]) } });
    const res = await run(t, REQ, fakeSecrets(ok(badToken)));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("auth_locked");
      expect(res.message.includes(badToken)).toBe(false); // token never in the fault
    }
    expect(t.calls.length).toBe(0); // fail-closed BEFORE dispatch
  });

  it.each([
    ["typed-unavailable", fakeSecrets({ ok: false, error: { reason: "locked" } } as Result<string, SecretUnavailable>)],
    ["THROWING", fakeSecrets(ok(TOKEN), { throw: new Error("keychain TCC denied") })],
  ])("an unavailable/%s accessor ⇒ auth_locked with ZERO dispatch", async (_label, secrets) => {
    const t = fakeTransport({ response: { status: 200, body: page([]) } });
    const res = await run(t, REQ, secrets);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("auth_locked");
    expect(t.calls.length).toBe(0);
  });

  it("a tampered/persisted offset cursor is encoded — can't smuggle an authority into the url", async () => {
    const t = fakeTransport({ response: { status: 200, body: page([]) } });
    const nasty = "@evil.example/x";
    await run(t, { readScope: "messages:read", cursor: nasty });
    const sent = t.calls[0]!;
    expect(sent.url.startsWith(`https://api.telegram.org/bot${TOKEN}/getUpdates`)).toBe(true);
    expect(sent.url.includes("@evil.example")).toBe(false);
    expect(sent.url.includes(`offset=${encodeURIComponent(nasty)}`)).toBe(true);
  });
});

// ── 4. TOTAL never-throws (L11 + NaN-gate) ────────────────────────────────────
describe("createTelegramCaptureHttpTransport — TOTAL never-throws (redacted typed faults)", () => {
  it.each([
    ["throwing transport", fakeTransport({ throw: new Error("SECRET boom") })],
    ["HTTP 500", fakeTransport({ response: { status: 500, body: "<secret>err</secret>" } })],
    ["NaN status", fakeTransport({ response: { status: NaN, body: page() } })],
    ["malformed body", fakeTransport({ response: { status: 200, body: "<<x>>" } })],
  ])("%s ⇒ a typed fault (never throws), no untrusted content echoed", async (_label, transport) => {
    const res = await run(transport);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message.includes("SECRET")).toBe(false);
      expect(res.message.includes("<secret>")).toBe(false);
    }
  });
});

// ── 5. pathAuth byte-equivalence — a Bearer spec is UNCHANGED ─────────────────
describe("createConnectorHttpTransport — pathAuth byte-equivalence (Bearer branch untouched)", () => {
  const bearerSpec: ConnectorHttpSpec = {
    baseUrl: "https://api.example.com",
    allowedHosts: ["api.example.com"],
    resourcePath: "/things",
    buildQuery: () => "?limit=1",
    mapPage: () => ({ ok: true, items: [], done: true }),
    // pathAuth ABSENT ⇒ Bearer-header auth
  };
  it("a Bearer spec (no pathAuth) sets Authorization: Bearer and carries NO token in the url path", async () => {
    const t = fakeTransport({ response: { status: 200, body: "{}" } });
    await createConnectorHttpTransport(bearerSpec, { transport: t, secrets: fakeSecrets(ok("bearer_tok")), tokenRef: "r" })(REQ);
    const sent = t.calls[0]!;
    expect(sent.headers.Authorization).toBe("Bearer bearer_tok");
    expect(sent.url).toBe("https://api.example.com/things?limit=1"); // token NOT in the path
    expect(sent.url.includes("bearer_tok")).toBe(false);
  });
});

// ── 6. connector wiring + emit-only + dormant ────────────────────────────────
describe("telegram-capture read connector — wiring + emit-only (rule 1) + dormant (§ARM-23)", () => {
  it("createTelegramCaptureConnector over the transport yields the read ConnectorPort (already exists)", () => {
    const port = createTelegramCaptureConnector(
      createTelegramCaptureHttpTransport({ transport: fakeTransport(), secrets: fakeSecrets(), tokenRef: TOKEN_REF }),
    );
    expect(port.connectorId).toBe("telegram-capture");
    expect(typeof port.fetch).toBe("function");
  });

  const src = readFileSync(
    fileURLToPath(new URL("../src/connectors/adapters/telegram-capture.ts", import.meta.url)),
    "utf8",
  );
  it("emit-only — no @sow/knowledge / fs-write import (L12 write-surface scan, import-anchored)", () => {
    for (const forbidden of ['from "@sow/knowledge"', 'from "node:fs"', 'from "fs"', "writeFile(", "createFsVault(", "copyFile("]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });

  it("dormant — no production caller CONSTRUCTS the real transport (unbound seam; real bind = §ARM-23)", () => {
    const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
    const files = readdirSync(srcRoot, { recursive: true, encoding: "utf8" }).filter(
      (f): f is string => typeof f === "string" && f.endsWith(".ts") && !f.endsWith("telegram-capture.ts"),
    );
    const callers = files.filter((f) => readFileSync(join(srcRoot, f), "utf8").includes("createTelegramCaptureHttpTransport("));
    expect(callers).toEqual([]);
  });
});
