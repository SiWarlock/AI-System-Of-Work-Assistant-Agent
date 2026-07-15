// spec(§8) spec(§5) — Google Calendar read-only HTTP transport: a thin CALENDAR_HTTP_SPEC over the round-2
// createConnectorHttpTransport template (SSRF-guard-first / token-header-only / positive-2xx gate / redaction /
// wrapped callbacks INHERITED). Mirrors the Drive slice. Pins the Calendar spec — the candidate
// {items[], nextPageToken, nextSyncToken} wire-map (fail-closed) + pageToken paging (the sync token is NOT the
// paging cursor) — and verifies inherited SSRF/redaction by driving the REAL template. Fakes only: the real
// HttpTransport + SecretsAccessor + OAuth token stay UNBOUND (refresh/expiry arming-era behind the accessor).
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
import { createCalendarHttpTransport, createCalendarConnector } from "../src/connectors/adapters/calendar";
import type { TransportRequest } from "../src/connectors/transport";

const TOKEN = "ya29.CAL-OAUTH-ACCESS-secret";
const TOKEN_REF = "keychain:google-calendar-oauth";
const REQ: TransportRequest = { readScope: "calendar.readonly" };

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

const calendarBody = (opts: { nextPageToken?: string; nextSyncToken?: string } = {}): string =>
  JSON.stringify({
    kind: "calendar#events",
    updated: "2026-07-15T02:00:00.000Z",
    items: [
      { id: "evt-1", status: "confirmed", updated: "2026-07-15T00:00:00.000Z", summary: "Standup" },
      { id: "evt-2", status: "confirmed", updated: "2026-07-15T01:00:00.000Z", summary: "Review" },
    ],
    ...(opts.nextPageToken !== undefined ? { nextPageToken: opts.nextPageToken } : {}),
    ...(opts.nextSyncToken !== undefined ? { nextSyncToken: opts.nextSyncToken } : {}),
  });

const cal = (transport: HttpTransport, req: TransportRequest = REQ) =>
  createCalendarHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(req);

// ── 1. Candidate Calendar events.list envelope ⇒ TransportPage (arch_gap) ────────
describe("createCalendarHttpTransport — candidate events.list envelope maps to a page (arch_gap)", () => {
  it("2xx with nextPageToken ⇒ items (id→id, distinct stable hash, raw preserved), nextCursor=token, done=false", async () => {
    const res = await cal(fakeTransport({ response: { status: 200, body: calendarBody({ nextPageToken: "PAGE-2" }) } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items.map((i) => i.id)).toEqual(["evt-1", "evt-2"]);
      expect(res.items[0]!.hash).toBeTruthy();
      expect(res.items[0]!.hash).not.toBe(res.items[1]!.hash);
      expect(res.items[0]!.raw).toEqual({
        id: "evt-1",
        status: "confirmed",
        updated: "2026-07-15T00:00:00.000Z",
        summary: "Standup",
      });
      expect(res.nextCursor).toBe("PAGE-2");
      expect(res.done).toBe(false);
    }
  });

  it("LAST page: nextSyncToken present + NO nextPageToken ⇒ done=true, no nextCursor (sync token is NOT the paging cursor)", async () => {
    const res = await cal(fakeTransport({ response: { status: 200, body: calendarBody({ nextSyncToken: "SYNC-XYZ" }) } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.done).toBe(true);
      expect(res.nextCursor).toBeUndefined();
    }
  });

  it("stable hash: identical id+updated ⇒ identical hash across independent fetches (dedupe key)", async () => {
    const a = await cal(fakeTransport({ response: { status: 200, body: calendarBody() } }));
    const b = await cal(fakeTransport({ response: { status: 200, body: calendarBody() } }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.items[0]!.hash).toBe(b.items[0]!.hash);
  });

  it.each([
    ['{"items":"not-an-array"}', "items not an array"],
    ['{"notitems":[]}', "missing items field"],
    ['{"items":[{"summary":"no id"}]}', "event missing id"],
    ["[]", "top-level is not the envelope object"],
  ])("fail-closed on a malformed/renamed shape %s (%s) ⇒ TransportFailure, never a false page", async (body) => {
    const res = await cal(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(false);
  });

  it.each([
    ['{"items":[{"id":"e1","updated":"t"}],"nextPageToken":""}', "empty-string token"],
    ['{"items":[{"id":"e1","updated":"t"}],"nextPageToken":123}', "wrong-typed token"],
  ])("a present-but-invalid nextPageToken %s (%s) ⇒ done=true (candidate: cursor axis fails toward stop)", async (body) => {
    const res = await cal(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.done).toBe(true);
      expect(res.nextCursor).toBeUndefined();
    }
  });

  it("both nextPageToken AND nextSyncToken present ⇒ the PAGE token wins (nextCursor=pageToken, done=false)", async () => {
    const res = await cal(fakeTransport({ response: { status: 200, body: calendarBody({ nextPageToken: "PAGE-2", nextSyncToken: "SYNC-XYZ" }) } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.nextCursor).toBe("PAGE-2");
      expect(res.done).toBe(false);
    }
  });

  it("an empty items[] page ⇒ ok, 0 items, done=true", async () => {
    const res = await cal(fakeTransport({ response: { status: 200, body: '{"items":[]}' } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items).toHaveLength(0);
      expect(res.done).toBe(true);
    }
  });
});

// ── 2. buildQuery: pageToken paging + cursor encoding + singleEvents ─────────────
describe("createCalendarHttpTransport — events.list paging (cursor encoded, first page tokenless)", () => {
  it("first page: singleEvents=true + maxResults, no pageToken", async () => {
    const transport = fakeTransport({ response: { status: 200, body: calendarBody() } });
    await cal(transport);
    const url = transport.calls[0]!.url;
    expect(url).toContain("singleEvents=true");
    expect(url).toContain("maxResults=");
    expect(url).not.toContain("&pageToken=");
  });

  it("a crafted cursor is percent-encoded into pageToken and cannot alter the resolved host", async () => {
    const transport = fakeTransport({ response: { status: 200, body: calendarBody() } });
    const crafted = "tok@evil.com&x=1?y=/../";
    const res = await cal(transport, { readScope: "calendar.readonly", cursor: crafted });
    expect(res.ok).toBe(true);
    const url = transport.calls[0]!.url;
    expect(url).toContain(`pageToken=${encodeURIComponent(crafted)}`);
    expect(url).not.toContain("pageToken=tok@evil.com");
  });
});

// ── 3. SSRF + redaction inherited from the template ─────────────────────────────
describe("createCalendarHttpTransport — SSRF guard admits the Calendar host + redaction inherited", () => {
  it("the guard admits www.googleapis.com on the final url; GET with token in Authorization only", async () => {
    const transport = fakeTransport({ response: { status: 200, body: '{"items":[]}' } });
    await cal(transport);
    const call = transport.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")).toBe(true);
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.url).not.toContain(TOKEN);
    for (const [k, v] of Object.entries(call.headers)) {
      if (k.toLowerCase() !== "authorization") expect(v).not.toContain(TOKEN);
    }
  });

  it("a non-2xx ⇒ TransportFailure carrying ONLY the safe status; token never in the failure", async () => {
    const transport = fakeTransport({ response: { status: 401, body: JSON.stringify({ error: "BODY_LEAK" }) } });
    const res = await cal(transport);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("auth_locked");
      expect(res.message).toContain("401");
      expect(res.message).not.toContain("BODY_LEAK");
    }
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });
});

// ── 4. End-to-end through createCalendarConnector ───────────────────────────────
describe("createCalendarHttpTransport — drives the whole ConnectorPort.fetch chain via createCalendarConnector", () => {
  it("raw→records through createCalendarConnector (recordId/contentHash/payload/nextCursor/done + Authorization)", async () => {
    const transport = fakeTransport({ response: { status: 200, body: calendarBody({ nextPageToken: "PAGE-9" }) } });
    const port = createCalendarConnector(createCalendarHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF }));
    const page = await port.fetch();
    expect(isErr(page)).toBe(false);
    if (!isErr(page)) {
      expect(page.value.records.map((r) => r.recordId)).toEqual(["evt-1", "evt-2"]);
      expect(page.value.records[0]!.contentHash).toBeTruthy();
      expect(page.value.records[0]!.payload).toEqual({
        id: "evt-1",
        status: "confirmed",
        updated: "2026-07-15T00:00:00.000Z",
        summary: "Standup",
      });
      expect(page.value.nextCursor).toBe("PAGE-9");
      expect(page.value.done).toBe(false);
    }
    expect(transport.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});
