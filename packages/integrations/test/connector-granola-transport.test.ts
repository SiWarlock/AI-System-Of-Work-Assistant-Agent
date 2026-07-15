// spec(§8) spec(§5) — Granola meeting-notes read-only HTTP transport: a thin GRANOLA_HTTP_SPEC over the round-2
// createConnectorHttpTransport template (SSRF/token/2xx-gate/redaction/wrapped-callbacks INHERITED). The
// simplest instance — a static `grn_` Bearer API key (no OAuth). Pins the Granola spec — the candidate
// ListNotesOutput {notes[], hasMore, cursor} wire-map with STRICT `done = hasMore !== true` (a non-`true`
// hasMore fails closed to done, never an infinite page loop) — and verifies inherited SSRF/redaction. Fakes
// only: the real HttpTransport + SecretsAccessor + `grn_` key stay UNBOUND.
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
import { createGranolaHttpTransport, createGranolaConnector } from "../src/connectors/adapters/granola";
import type { TransportRequest } from "../src/connectors/transport";

const TOKEN = "grn_STATIC-API-KEY-secret";
const TOKEN_REF = "keychain:granola-api-key";
const REQ: TransportRequest = { readScope: "meetings:read" };

function fakeTransport(
  behavior: { response?: HttpTransportResponse; throw?: unknown } = {},
): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  return {
    calls,
    async send(req) {
      calls.push(req);
      if (behavior.throw !== undefined) throw behavior.throw;
      return behavior.response ?? { status: 200, body: JSON.stringify({ notes: [], hasMore: false, cursor: null }) };
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

const NOTES = [
  { id: "not_aaaaaaaaaaaaaa", object: "note", title: "Q3 review", owner: { name: "A", email: "a@x.co" }, created_at: "2026-01-27T15:30:00Z", updated_at: "2026-01-27T16:45:00Z" },
  { id: "not_bbbbbbbbbbbbbb", object: "note", title: "Standup", owner: { name: "B", email: "b@x.co" }, created_at: "2026-01-27T17:00:00Z", updated_at: "2026-01-27T18:00:00Z" },
];
const body = (env: Record<string, unknown>): string => JSON.stringify({ notes: NOTES, ...env });

const gran = (transport: HttpTransport, req: TransportRequest = REQ) =>
  createGranolaHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(req);

// ── 1. Candidate ListNotesOutput ⇒ TransportPage (arch_gap) ─────────────────────
describe("createGranolaHttpTransport — candidate ListNotesOutput maps to a page (arch_gap)", () => {
  it("2xx hasMore:true + cursor ⇒ items (not_ id→id, distinct stable hash, raw preserved), nextCursor=cursor, done=false", async () => {
    const res = await gran(fakeTransport({ response: { status: 200, body: body({ hasMore: true, cursor: "CUR-2" }) } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items.map((i) => i.id)).toEqual(["not_aaaaaaaaaaaaaa", "not_bbbbbbbbbbbbbb"]);
      expect(res.items[0]!.hash).toBeTruthy();
      expect(res.items[0]!.hash).not.toBe(res.items[1]!.hash);
      expect(res.items[0]!.raw).toEqual(NOTES[0]);
      expect(res.nextCursor).toBe("CUR-2");
      expect(res.done).toBe(false);
    }
  });

  it("2xx hasMore:false ⇒ done=true, no nextCursor", async () => {
    const res = await gran(fakeTransport({ response: { status: 200, body: body({ hasMore: false, cursor: null }) } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.done).toBe(true);
      expect(res.nextCursor).toBeUndefined();
    }
  });

  it("stable hash: identical id+updated_at ⇒ identical hash across independent fetches (dedupe key)", async () => {
    const a = await gran(fakeTransport({ response: { status: 200, body: body({ hasMore: false, cursor: null }) } }));
    const b = await gran(fakeTransport({ response: { status: 200, body: body({ hasMore: false, cursor: null }) } }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.items[0]!.hash).toBe(b.items[0]!.hash);
  });

  it.each([
    ['{"hasMore":false,"cursor":null}', "missing notes field"],
    ['{"notes":"nope","hasMore":false,"cursor":null}', "notes not an array"],
    ['{"notes":[{"title":"no id"}],"hasMore":false,"cursor":null}', "note missing id"],
    ["[]", "top-level is not the envelope object"],
  ])("fail-closed on a malformed/renamed shape %s (%s) ⇒ TransportFailure, never a false page", async (b) => {
    const res = await gran(fakeTransport({ response: { status: 200, body: b } }));
    expect(res.ok).toBe(false);
  });

  it("contentHash falls back to hashing the raw note when updated_at is absent (still stable)", async () => {
    const noUpdated = '{"notes":[{"id":"not_x","title":"T"}],"hasMore":false,"cursor":null}';
    const a = await gran(fakeTransport({ response: { status: 200, body: noUpdated } }));
    const b = await gran(fakeTransport({ response: { status: 200, body: noUpdated } }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.items[0]!.hash).toBeTruthy();
      expect(a.items[0]!.hash).toBe(b.items[0]!.hash);
    }
  });

  it("a zero-item page with hasMore:true + a valid cursor ⇒ items:[], done=false, nextCursor set (advances)", async () => {
    const res = await gran(fakeTransport({ response: { status: 200, body: '{"notes":[],"hasMore":true,"cursor":"CUR-EMPTY"}' } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items).toHaveLength(0);
      expect(res.done).toBe(false);
      expect(res.nextCursor).toBe("CUR-EMPTY");
    }
  });
});

// ── 2. STRICT hasMore done-gate (the Granola load-bearing case) ─────────────────
describe("createGranolaHttpTransport — done = hasMore !== true (STRICT, fail-closed, no infinite loop)", () => {
  it.each([
    ['{"notes":[{"id":"not_x","updated_at":"t"}],"hasMore":"true","cursor":"C"}', 'string "true"'],
    ['{"notes":[{"id":"not_x","updated_at":"t"}],"hasMore":1,"cursor":"C"}', "number 1"],
    ['{"notes":[{"id":"not_x","updated_at":"t"}],"cursor":"C"}', "absent hasMore"],
    ['{"notes":[{"id":"not_x","updated_at":"t"}],"hasMore":false,"cursor":"C"}', "false"],
  ])("a non-true hasMore %s (%s) ⇒ done=true, no nextCursor (a truthy-check would loop)", async (b) => {
    const res = await gran(fakeTransport({ response: { status: 200, body: b } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.done).toBe(true);
      expect(res.nextCursor).toBeUndefined();
    }
  });

  it.each([
    ['{"notes":[{"id":"not_x","updated_at":"t"}],"hasMore":true,"cursor":null}', "cursor:null"],
    ['{"notes":[{"id":"not_x","updated_at":"t"}],"hasMore":true}', "cursor absent (last-page shape)"],
    ['{"notes":[{"id":"not_x","updated_at":"t"}],"hasMore":true,"cursor":""}', 'cursor:"" (empty string)'],
  ])("hasMore:true but %s (%s) ⇒ done=true (no cursor to advance)", async (b) => {
    const res = await gran(fakeTransport({ response: { status: 200, body: b } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.done).toBe(true);
      expect(res.nextCursor).toBeUndefined();
    }
  });
});

// ── 3. buildQuery: page_size≤30 + cursor encoding ───────────────────────────────
describe("createGranolaHttpTransport — list query (page_size≤30, cursor encoded, first page cursorless)", () => {
  it("first page: page_size present (≤30), no cursor", async () => {
    const transport = fakeTransport({ response: { status: 200, body: body({ hasMore: false, cursor: null }) } });
    await gran(transport);
    const url = transport.calls[0]!.url;
    const m = url.match(/[?&]page_size=(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(30);
    expect(url).not.toContain("&cursor=");
  });

  it("a crafted cursor is percent-encoded into the cursor param and cannot alter the resolved host", async () => {
    const transport = fakeTransport({ response: { status: 200, body: body({ hasMore: false, cursor: null }) } });
    const crafted = "tok@evil.com&x=1?y=/../";
    const res = await gran(transport, { readScope: "meetings:read", cursor: crafted });
    expect(res.ok).toBe(true);
    const url = transport.calls[0]!.url;
    expect(url).toContain(`cursor=${encodeURIComponent(crafted)}`);
    expect(url).not.toContain("cursor=tok@evil.com");
  });
});

// ── 4. SSRF + redaction inherited from the template ─────────────────────────────
describe("createGranolaHttpTransport — SSRF guard admits the Granola host + redaction inherited", () => {
  it("the guard admits public-api.granola.ai on the final url; GET with the grn_ key in Authorization only", async () => {
    const transport = fakeTransport({ response: { status: 200, body: '{"notes":[],"hasMore":false,"cursor":null}' } });
    await gran(transport);
    const call = transport.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url.startsWith("https://public-api.granola.ai/v1/notes")).toBe(true);
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.url).not.toContain(TOKEN);
    for (const [k, v] of Object.entries(call.headers)) {
      if (k.toLowerCase() !== "authorization") expect(v).not.toContain(TOKEN);
    }
  });

  it("a 401 (invalid key) ⇒ TransportFailure(auth_locked) with the safe status only; token never leaked", async () => {
    const transport = fakeTransport({ response: { status: 401, body: JSON.stringify({ error: "BODY_LEAK" }) } });
    const res = await gran(transport);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("auth_locked");
      expect(res.message).toContain("401");
      expect(res.message).not.toContain("BODY_LEAK");
    }
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it("a 429 (rate limit) ⇒ TransportFailure(rate_limited)", async () => {
    const transport = fakeTransport({ response: { status: 429, body: "{}" } });
    const res = await gran(transport);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("rate_limited");
  });
});

// ── 5. End-to-end through createGranolaConnector ────────────────────────────────
describe("createGranolaHttpTransport — drives the whole ConnectorPort.fetch chain via createGranolaConnector", () => {
  it("raw→records through createGranolaConnector (recordId/contentHash/payload/nextCursor/done + Authorization)", async () => {
    const transport = fakeTransport({ response: { status: 200, body: body({ hasMore: true, cursor: "CUR-9" }) } });
    const port = createGranolaConnector(createGranolaHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF }));
    const page = await port.fetch();
    expect(isErr(page)).toBe(false);
    if (!isErr(page)) {
      expect(page.value.records.map((r) => r.recordId)).toEqual(["not_aaaaaaaaaaaaaa", "not_bbbbbbbbbbbbbb"]);
      expect(page.value.records[0]!.contentHash).toBeTruthy();
      expect(page.value.records[0]!.payload).toEqual(NOTES[0]);
      expect(page.value.nextCursor).toBe("CUR-9");
      expect(page.value.done).toBe(false);
    }
    expect(transport.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});
