// spec(§8) spec(§5) — Google Drive read-only HTTP transport: a thin DRIVE_HTTP_SPEC over the round-2
// createConnectorHttpTransport template (SSRF-guard-first / token-header-only / positive-2xx gate / redaction /
// wrapped callbacks all INHERITED from the template). This suite pins the Drive-specific spec — the candidate
// files[]/nextPageToken wire-map (fail-closed) + pageToken paging — and verifies the inherited SSRF/redaction
// by driving the REAL template. Fakes only: the real HttpTransport + SecretsAccessor + OAuth token stay UNBOUND
// (a Google OAuth access token is just a bearer string; refresh/expiry is arming-era behind the SecretsAccessor).
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
import { createDriveHttpTransport, createDriveConnector } from "../src/connectors/adapters/drive";
import type { TransportRequest } from "../src/connectors/transport";

const TOKEN = "ya29.OAUTH-ACCESS-TOKEN-secret";
const TOKEN_REF = "keychain:google-drive-oauth";
const REQ: TransportRequest = { readScope: "drive.readonly" };

function fakeTransport(
  behavior: { response?: HttpTransportResponse; throw?: unknown } = {},
): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  return {
    calls,
    async send(req) {
      calls.push(req);
      if (behavior.throw !== undefined) throw behavior.throw;
      return behavior.response ?? { status: 200, body: JSON.stringify({ files: [] }) };
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

const driveBody = (nextPageToken?: string): string =>
  JSON.stringify({
    files: [
      { id: "file-1", name: "Doc A", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-07-15T00:00:00Z" },
      { id: "file-2", name: "Doc B", mimeType: "application/pdf", modifiedTime: "2026-07-15T01:00:00Z" },
    ],
    ...(nextPageToken !== undefined ? { nextPageToken } : {}),
  });

// ── 1. Candidate Drive files.list envelope ⇒ TransportPage (arch_gap) ────────────
describe("createDriveHttpTransport — candidate Drive files.list envelope maps to a page (arch_gap)", () => {
  it("2xx with nextPageToken ⇒ items (id→id, distinct stable hash, raw preserved), nextCursor=token, done=false", async () => {
    const transport = fakeTransport({ response: { status: 200, body: driveBody("TOKEN-PAGE-2") } });
    const res = await createDriveHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items.map((i) => i.id)).toEqual(["file-1", "file-2"]);
      expect(res.items[0]!.hash).toBeTruthy();
      expect(res.items[0]!.hash).not.toBe(res.items[1]!.hash);
      expect(res.items[0]!.raw).toEqual({
        id: "file-1",
        name: "Doc A",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2026-07-15T00:00:00Z",
      });
      expect(res.nextCursor).toBe("TOKEN-PAGE-2");
      expect(res.done).toBe(false);
    }
  });

  it("2xx with NO nextPageToken ⇒ done=true, no nextCursor", async () => {
    const transport = fakeTransport({ response: { status: 200, body: driveBody() } });
    const res = await createDriveHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.done).toBe(true);
      expect(res.nextCursor).toBeUndefined();
    }
  });

  it("stable hash: identical id+modifiedTime ⇒ identical hash across independent fetches (dedupe key)", async () => {
    const a = await createDriveHttpTransport({
      transport: fakeTransport({ response: { status: 200, body: driveBody() } }),
      secrets: fakeSecrets(),
      tokenRef: TOKEN_REF,
    })(REQ);
    const b = await createDriveHttpTransport({
      transport: fakeTransport({ response: { status: 200, body: driveBody() } }),
      secrets: fakeSecrets(),
      tokenRef: TOKEN_REF,
    })(REQ);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.items[0]!.hash).toBe(b.items[0]!.hash);
  });

  it.each([
    ['{"files":"not-an-array"}', "files not an array"],
    ['{"notfiles":[]}', "missing files field"],
    ['{"files":[{"name":"no id"}]}', "file missing id"],
    ["[]", "top-level is not the envelope object"],
  ])("fail-closed on a malformed/renamed shape %s (%s) ⇒ TransportFailure, never a false page", async (body) => {
    const transport = fakeTransport({ response: { status: 200, body } });
    const res = await createDriveHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    expect(res.ok).toBe(false);
  });

  it.each([
    ['{"files":[{"id":"f1","modifiedTime":"t"}],"nextPageToken":""}', "empty-string token"],
    ['{"files":[{"id":"f1","modifiedTime":"t"}],"nextPageToken":123}', "wrong-typed token"],
  ])("a present-but-invalid nextPageToken %s (%s) ⇒ done=true (candidate: cursor axis fails toward stop)", async (body) => {
    const transport = fakeTransport({ response: { status: 200, body } });
    const res = await createDriveHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.done).toBe(true);
      expect(res.nextCursor).toBeUndefined();
    }
  });

  it("incompleteSearch:true maps records as a normal page AND raises the coverage-degrade flag (16.4, was arch_gap)", async () => {
    // Was an arch_gap (incompleteSearch IGNORED); 16.4 now honors it — the records still map
    // as a normal page (fail-VISIBLE, kept) while `incompleteCoverage` is raised. Detailed
    // coverage semantics are pinned in section 5 below.
    const body = JSON.stringify({ files: [{ id: "f1", modifiedTime: "t" }], incompleteSearch: true });
    const transport = fakeTransport({ response: { status: 200, body } });
    const res = await createDriveHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items.map((i) => i.id)).toEqual(["f1"]);
      expect(res.done).toBe(true);
      expect(res.incompleteCoverage).toBe(true);
    }
  });
});

// ── 2. buildQuery: pageToken paging + cursor encoding ───────────────────────────
describe("createDriveHttpTransport — pageToken paging (cursor encoded, first page tokenless)", () => {
  it("no pageToken on the first (cursorless) page", async () => {
    const transport = fakeTransport({ response: { status: 200, body: driveBody() } });
    await createDriveHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    // no pagination cursor param on the first page (the `fields` projection may legitimately name
    // `nextPageToken`, so match the actual `&pageToken=` param prefix, not the bare substring).
    expect(transport.calls[0]!.url).not.toContain("&pageToken=");
  });

  it("a crafted cursor is percent-encoded into pageToken and cannot alter the resolved host", async () => {
    const transport = fakeTransport({ response: { status: 200, body: driveBody() } });
    const crafted = "tok@evil.com&x=1?y=/../";
    const res = await createDriveHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })({
      readScope: "drive.readonly",
      cursor: crafted,
    });
    expect(res.ok).toBe(true); // guard admitted www.googleapis.com on the final url
    const url = transport.calls[0]!.url;
    expect(url).toContain(`pageToken=${encodeURIComponent(crafted)}`);
    expect(url).not.toContain("pageToken=tok@evil.com");
  });
});

// ── 3. SSRF + redaction inherited from the template ─────────────────────────────
describe("createDriveHttpTransport — SSRF guard admits the Drive host + redaction inherited", () => {
  it("the guard admits www.googleapis.com on the final url; GET with token in Authorization only", async () => {
    const transport = fakeTransport({ response: { status: 200, body: '{"files":[]}' } });
    await createDriveHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    const call = transport.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url.startsWith("https://www.googleapis.com/drive/v3/files")).toBe(true);
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.url).not.toContain(TOKEN);
    for (const [k, v] of Object.entries(call.headers)) {
      if (k.toLowerCase() !== "authorization") expect(v).not.toContain(TOKEN);
    }
  });

  it("a non-2xx ⇒ TransportFailure carrying ONLY the safe status; token never in the failure", async () => {
    const transport = fakeTransport({ response: { status: 401, body: JSON.stringify({ error: "BODY_LEAK" }) } });
    const res = await createDriveHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("auth_locked"); // 401 → the dormant OAuth-refresh signal
      expect(res.message).toContain("401");
      expect(res.message).not.toContain("BODY_LEAK");
    }
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });
});

// ── 5. incompleteSearch → coverage-degrade signal (16.4, closes G29) ────────────
// Google Drive's `incompleteSearch: true` means the query did NOT cover all corpora,
// so the ingested page is PARTIAL. It must be surfaced (fail-VISIBLE) as a
// coverage-degrade signal on the page — never silently returned as a complete result.
// Absent / false ⇒ byte-equivalent to today (no coverage flag).
const driveBodyCoverage = (incompleteSearch?: boolean): string =>
  JSON.stringify({
    files: [{ id: "file-1", name: "Doc A", mimeType: "application/pdf", modifiedTime: "2026-07-15T00:00:00Z" }],
    ...(incompleteSearch !== undefined ? { incompleteSearch } : {}),
  });

describe("createDriveHttpTransport — incompleteSearch coverage-degrade (16.4 · §8)", () => {
  it("drive_incomplete_search_true_degrades_coverage: incompleteSearch=true ⇒ page flags incomplete coverage — spec(§8)", async () => {
    const transport = fakeTransport({ response: { status: 200, body: driveBodyCoverage(true) } });
    const res = await createDriveHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The page still carries its records (fail-VISIBLE, NOT fail-closed — the partial
      // set is kept) AND raises the coverage-degrade flag.
      expect(res.items.map((i) => i.id)).toEqual(["file-1"]);
      expect(res.incompleteCoverage).toBe(true);
    }
  });

  it("drive_complete_search_no_degrade: incompleteSearch absent OR false ⇒ NO coverage flag (byte-equivalent) — spec(§8)", async () => {
    const absent = fakeTransport({ response: { status: 200, body: driveBodyCoverage(undefined) } });
    const resAbsent = await createDriveHttpTransport({ transport: absent, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    expect(resAbsent.ok).toBe(true);
    if (resAbsent.ok) expect(resAbsent.incompleteCoverage).toBeUndefined();

    const complete = fakeTransport({ response: { status: 200, body: driveBodyCoverage(false) } });
    const resFalse = await createDriveHttpTransport({ transport: complete, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(REQ);
    expect(resFalse.ok).toBe(true);
    if (resFalse.ok) expect(resFalse.incompleteCoverage).toBeUndefined();
  });

  it("threads incompleteCoverage through createDriveConnector onto the ConnectorFetchPage — spec(§8)", async () => {
    const transport = fakeTransport({ response: { status: 200, body: driveBodyCoverage(true) } });
    const port = createDriveConnector(createDriveHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF }));
    const page = await port.fetch();
    expect(isErr(page)).toBe(false);
    if (!isErr(page)) {
      expect(page.value.records.map((r) => r.recordId)).toEqual(["file-1"]);
      expect(page.value.incompleteCoverage).toBe(true);
    }
  });
});

// ── 4. End-to-end through createDriveConnector ──────────────────────────────────
describe("createDriveHttpTransport — drives the whole ConnectorPort.fetch chain via createDriveConnector", () => {
  it("raw→records through createDriveConnector (recordId/contentHash/payload/nextCursor/done + Authorization)", async () => {
    const transport = fakeTransport({ response: { status: 200, body: driveBody("TOKEN-9") } });
    const port = createDriveConnector(createDriveHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF }));
    const page = await port.fetch();
    expect(isErr(page)).toBe(false);
    if (!isErr(page)) {
      expect(page.value.records.map((r) => r.recordId)).toEqual(["file-1", "file-2"]);
      expect(page.value.records[0]!.contentHash).toBeTruthy();
      expect(page.value.records[0]!.payload).toEqual({
        id: "file-1",
        name: "Doc A",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2026-07-15T00:00:00Z",
      });
      expect(page.value.nextCursor).toBe("TOKEN-9");
      expect(page.value.done).toBe(false);
    }
    expect(transport.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});
