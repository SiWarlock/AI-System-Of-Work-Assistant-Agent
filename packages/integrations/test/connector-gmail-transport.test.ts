// spec(§8) spec(§5) — Gmail messages LIST-ONLY read transport: a thin GMAIL_HTTP_SPEC over the connector
// template (GET body-cursor, like Drive/Calendar). Gmail's users.messages.list returns id-level refs
// ({id, threadId} + nextPageToken) — NOT content (content ⇒ a separate messages.get; the hydration deferral).
// Pins: the absent-messages (empty inbox) ⇒ empty page (NOT a failure) distinction; STRICT nextPageToken
// pagination; gmail.readonly scope-only; SSRF + rule-7 inherited. Fakes only: real HttpTransport +
// SecretsAccessor + OAuth token stay UNBOUND.
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
import { createGmailHttpTransport, createGmailConnector } from "../src/connectors/adapters/gmail";
import type { TransportRequest } from "../src/connectors/transport";

const TOKEN = "ya29.GMAIL-OAUTH-readonly-secret";
const TOKEN_REF = "keychain:gmail-oauth";
const REQ: TransportRequest = { readScope: "gmail.readonly" };

function fakeTransport(
  behavior: { response?: HttpTransportResponse; throw?: unknown } = {},
): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  return {
    calls,
    async send(req) {
      calls.push(req);
      if (behavior.throw !== undefined) throw behavior.throw;
      return behavior.response ?? { status: 200, body: JSON.stringify({ resultSizeEstimate: 0 }) };
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

const MESSAGES = [
  { id: "msg_1", threadId: "thr_1" },
  { id: "msg_2", threadId: "thr_2" },
];
const gm = (transport: HttpTransport, req: TransportRequest = REQ) =>
  createGmailHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(req);

// ── 1. Candidate messages.list ⇒ TransportPage (arch_gap) ───────────────────────
describe("createGmailHttpTransport — messages.list maps to a page (arch_gap)", () => {
  it("messages + nextPageToken ⇒ items (id→recordId, distinct payloadHash({id,threadId}), raw=msg), nextCursor, done=false", async () => {
    const body = JSON.stringify({ messages: MESSAGES, nextPageToken: "t1", resultSizeEstimate: 2 });
    const res = await gm(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items.map((i) => i.id)).toEqual(["msg_1", "msg_2"]);
      expect(res.items[0]!.hash).toBeTruthy();
      expect(res.items[0]!.hash).not.toBe(res.items[1]!.hash);
      expect(res.items[0]!.raw).toEqual(MESSAGES[0]);
      expect(res.nextCursor).toBe("t1");
      expect(res.done).toBe(false);
    }
  });

  it("messages + NO nextPageToken ⇒ done=true, no nextCursor", async () => {
    const body = JSON.stringify({ messages: MESSAGES, resultSizeEstimate: 2 });
    const res = await gm(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.done).toBe(true);
      expect(res.nextCursor).toBeUndefined();
    }
  });

  it.each([
    ['{"messages":[{"id":"msg_x"}]}', "threadId absent"],
    ['{"messages":[{"id":"msg_x","threadId":123}]}', "threadId non-string"],
  ])("contentHash falls back to payloadHash({id}) when %s (%s) (still stable)", async (body) => {
    const a = await gm(fakeTransport({ response: { status: 200, body } }));
    const b = await gm(fakeTransport({ response: { status: 200, body } }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.items[0]!.hash).toBeTruthy();
      expect(a.items[0]!.hash).toBe(b.items[0]!.hash);
    }
  });
});

// ── 2. STRICT nextPageToken pagination (mirrors Drive/Granola) ──────────────────
describe("createGmailHttpTransport — STRICT nextPageToken pagination (fail-closed)", () => {
  it.each([
    ['{"messages":[{"id":"m","threadId":"t"}],"nextPageToken":""}', "empty token"],
    ['{"messages":[{"id":"m","threadId":"t"}],"nextPageToken":123}', "non-string token"],
    ['{"messages":[{"id":"m","threadId":"t"}]}', "absent token"],
  ])("a non-usable nextPageToken %s (%s) ⇒ done=true, no cursor", async (body) => {
    const res = await gm(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.done).toBe(true);
      expect(res.nextCursor).toBeUndefined();
    }
  });
});

// ── 3. Empty inbox: ABSENT `messages` ⇒ empty page (NOT a failure) ──────────────
describe("createGmailHttpTransport — absent `messages` (empty inbox) is an empty page, not a failure", () => {
  it("a body with NO messages key ⇒ ok, items:[], done=true (distinct from a present non-array)", async () => {
    const res = await gm(fakeTransport({ response: { status: 200, body: '{"resultSizeEstimate":0}' } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items).toHaveLength(0);
      expect(res.done).toBe(true);
    }
  });

  it.each([
    ['{"nextPageToken":"t2"}', "absent messages"],
    ['{"messages":[],"nextPageToken":"t2"}', "present-empty messages array"],
  ])("%s (%s) + a nextPageToken ⇒ empty page but done=false (paginates — done is cursor-driven, not items.length)", async (body) => {
    const res = await gm(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items).toHaveLength(0);
      expect(res.done).toBe(false);
      expect(res.nextCursor).toBe("t2");
    }
  });
});

// ── 4. buildQuery: maxResults + pageToken encoding ──────────────────────────────
describe("createGmailHttpTransport — buildQuery (maxResults, cursor encoded, first page tokenless)", () => {
  it("first page: maxResults=100, no pageToken", async () => {
    const transport = fakeTransport({ response: { status: 200, body: "{}" } });
    await gm(transport);
    const url = transport.calls[0]!.url;
    expect(url).toContain("maxResults=100");
    expect(url).not.toContain("&pageToken=");
  });

  it("a crafted cursor is percent-encoded into pageToken and cannot alter the resolved host", async () => {
    const transport = fakeTransport({ response: { status: 200, body: "{}" } });
    const crafted = "tok@evil.com&x=1?y=/../";
    const res = await gm(transport, { readScope: "gmail.readonly", cursor: crafted });
    expect(res.ok).toBe(true);
    const url = transport.calls[0]!.url;
    expect(url).toContain(`pageToken=${encodeURIComponent(crafted)}`);
    expect(url).not.toContain("pageToken=tok@evil.com");
  });
});

// ── 5. Malformed (PRESENT non-array / bad message) fail-closed ──────────────────
describe("createGmailHttpTransport — present-but-malformed fail-closed", () => {
  it.each([
    ['{"messages":"nope"}', "messages present but a string"],
    ['{"messages":42}', "messages present but a number"],
    ['{"messages":{"id":"x"}}', "messages present but an object"],
    ['{"messages":[42]}', "message entry non-object"],
    ['{"messages":[{"threadId":"t"}]}', "message missing id"],
    ["null", "top-level null"],
    ["[]", "top-level array (not the envelope object)"],
  ])("fail-closed on %s (%s) ⇒ TransportFailure, never a false page", async (body) => {
    const res = await gm(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(false);
  });
});

// ── 6. SSRF + rule-7 inherited ──────────────────────────────────────────────────
describe("createGmailHttpTransport — SSRF admit + rule-7 + fault map", () => {
  it("admits gmail.googleapis.com; GET with the token in Authorization only", async () => {
    const transport = fakeTransport({ response: { status: 200, body: "{}" } });
    await gm(transport);
    const call = transport.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages")).toBe(true);
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.url).not.toContain(TOKEN);
    for (const [k, v] of Object.entries(call.headers)) {
      if (k.toLowerCase() !== "authorization") expect(v).not.toContain(TOKEN);
    }
  });

  it("a 401 ⇒ TransportFailure(auth_locked) with safe status only; token never leaked", async () => {
    const transport = fakeTransport({ response: { status: 401, body: JSON.stringify({ error: "BODY_LEAK" }) } });
    const res = await gm(transport);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("auth_locked");
      expect(res.message).toContain("401");
      expect(res.message).not.toContain("BODY_LEAK");
    }
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });
});

// ── 7. End-to-end through createGmailConnector (gmail.readonly scope handed to the transport) ────────
describe("createGmailHttpTransport — drives the ConnectorPort.fetch chain via createGmailConnector", () => {
  it("raw→records through createGmailConnector (recordId/contentHash/payload; done/nextCursor threaded; readScope=gmail.readonly)", async () => {
    let seenScope: string | undefined;
    const transport: HttpTransport & { calls: HttpTransportRequest[] } = {
      calls: [],
      async send(req) {
        this.calls.push(req);
        return { status: 200, body: JSON.stringify({ messages: MESSAGES, nextPageToken: "t9" }) };
      },
    };
    // wrap the transport to capture the readScope handed down (gmail.readonly ONLY — never a write scope)
    const scopeCapturing = createGmailHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF });
    const port = createGmailConnector(async (request) => {
      seenScope = request.readScope;
      return scopeCapturing(request);
    });
    const page = await port.fetch();
    expect(seenScope).toBe("gmail.readonly");
    expect(isErr(page)).toBe(false);
    if (!isErr(page)) {
      expect(page.value.records.map((r) => r.recordId)).toEqual(["msg_1", "msg_2"]);
      expect(page.value.records[0]!.contentHash).toBeTruthy();
      expect(page.value.records[0]!.payload).toEqual(MESSAGES[0]);
      expect(page.value.nextCursor).toBe("t9");
      expect(page.value.done).toBe(false);
    }
    expect(transport.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});
