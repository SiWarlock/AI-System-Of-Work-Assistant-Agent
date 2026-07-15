// spec(§8) spec(§5) — GitHub issues read-only HTTP transport: a thin GITHUB_HTTP_SPEC over the connector
// template (SSRF/token/2xx-gate/redaction/wrapped-callbacks INHERITED). The FIRST page-number paginator — the
// response is a BARE JSON array (no body cursor), so it paginates by `?page=N` with short-page termination
// (`done = len < per_page`), which needs the widened `mapPage(json, request)` seam (the request carries the
// page cursor). Static Bearer PAT. Fakes only: real HttpTransport + SecretsAccessor + PAT stay UNBOUND.
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
import { createGithubHttpTransport, createGithubConnector } from "../src/connectors/adapters/github";
import type { TransportRequest } from "../src/connectors/transport";

const TOKEN = "ghp_STATIC-PAT-secret";
const TOKEN_REF = "keychain:github-pat";
const REQ: TransportRequest = { readScope: "repo:read" };
const PER_PAGE = 100; // GITHUB_PER_PAGE (vendor max)

function fakeTransport(
  behavior: { response?: HttpTransportResponse; throw?: unknown } = {},
): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  return {
    calls,
    async send(req) {
      calls.push(req);
      if (behavior.throw !== undefined) throw behavior.throw;
      return behavior.response ?? { status: 200, body: "[]" };
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

const issue = (nodeId: string, updatedAt = "2026-01-27T16:45:00Z"): Record<string, unknown> => ({
  id: 100 + nodeId.length,
  node_id: nodeId,
  number: 1,
  state: "open",
  title: `Issue ${nodeId}`,
  updated_at: updatedAt,
});
// A full page of exactly PER_PAGE issues (⇒ hasMore signal via short-page absence).
const fullPage = (): string => JSON.stringify(Array.from({ length: PER_PAGE }, (_, i) => issue(`MD_${i}`)));

const gh = (transport: HttpTransport, req: TransportRequest = REQ) =>
  createGithubHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF })(req);

// ── 1. Candidate bare-array ⇒ TransportPage (arch_gap) ──────────────────────────
describe("createGithubHttpTransport — bare issue array maps to a page (arch_gap)", () => {
  it("2xx short page ⇒ items (node_id→recordId, distinct payloadHash({id:node_id,updated_at}), raw preserved), done=true", async () => {
    const body = JSON.stringify([issue("MD_A", "2026-01-01T00:00:00Z"), issue("MD_B", "2026-01-02T00:00:00Z")]);
    const res = await gh(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items.map((i) => i.id)).toEqual(["MD_A", "MD_B"]);
      expect(res.items[0]!.hash).toBeTruthy();
      expect(res.items[0]!.hash).not.toBe(res.items[1]!.hash);
      expect(res.items[0]!.raw).toEqual(issue("MD_A", "2026-01-01T00:00:00Z"));
      expect(res.done).toBe(true); // 2 < 100 ⇒ short page ⇒ terminal
      expect(res.nextCursor).toBeUndefined();
    }
  });

  it("a PR-tagged entry (pull_request key) is ingested like an issue (candidate scope — NOT filtered)", async () => {
    const body = JSON.stringify([
      { id: 5, node_id: "MD_PR", number: 7, state: "open", title: "A PR", updated_at: "2026-01-01T00:00:00Z", pull_request: { url: "https://api.github.com/repos/x/y/pulls/7" } },
    ]);
    const res = await gh(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items).toHaveLength(1);
      expect(res.items[0]!.id).toBe("MD_PR");
      expect((res.items[0]!.raw as Record<string, unknown>).pull_request).toBeDefined();
    }
  });

  it("contentHash falls back to hashing the raw issue when updated_at absent (still stable)", async () => {
    const noUpdated = JSON.stringify([{ id: 1, node_id: "MD_X", number: 1, state: "open", title: "T" }]);
    const a = await gh(fakeTransport({ response: { status: 200, body: noUpdated } }));
    const b = await gh(fakeTransport({ response: { status: 200, body: noUpdated } }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.items[0]!.hash).toBeTruthy();
      expect(a.items[0]!.hash).toBe(b.items[0]!.hash);
    }
  });
});

// ── 2. Page-number pagination (advances on a FULL page) ─────────────────────────
describe("createGithubHttpTransport — page-number pagination (done = len < per_page)", () => {
  it("full page (len===100), cursor undefined ⇒ done=false, nextCursor='2'; buildQuery emits page=1", async () => {
    const transport = fakeTransport({ response: { status: 200, body: fullPage() } });
    const res = await gh(transport);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.done).toBe(false);
      expect(res.nextCursor).toBe("2");
    }
    expect(transport.calls[0]!.url).toContain("page=1");
    expect(transport.calls[0]!.url).toContain("per_page=100");
  });

  it("full page, cursor='2' ⇒ nextCursor='3'; buildQuery emits page=2", async () => {
    const transport = fakeTransport({ response: { status: 200, body: fullPage() } });
    const res = await gh(transport, { readScope: "repo:read", cursor: "2" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.nextCursor).toBe("3");
    expect(transport.calls[0]!.url).toContain("page=2");
  });
});

// ── 2b. buildQuery fixed params (single-source per_page + load-bearing list params) ─
describe("createGithubHttpTransport — buildQuery pins per_page + the fixed list params", () => {
  it("emits the single-source per_page=100 (matches the mapPage `done = len < per_page` constant) + state=all/sort=updated/direction=desc", async () => {
    const transport = fakeTransport({ response: { status: 200, body: "[]" } });
    await gh(transport);
    const url = transport.calls[0]!.url;
    // per_page MUST equal the mapPage comparison constant — a drift (e.g. server returns 30 < 100) would
    // wedge pagination at page 1 forever.
    expect(url).toContain("per_page=100");
    expect(url).toContain("state=all");
    expect(url).toContain("sort=updated");
    expect(url).toContain("direction=desc");
  });
});

// ── 3. Cursor fail-safe (tampered/invalid ⇒ page 1, never injects, never loops) ─
describe("createGithubHttpTransport — cursor fail-safe (invalid ⇒ page 1)", () => {
  it.each([["abc"], ["0"], ["-1"], [""], ["2.5"], ["1e2"], ["0x10"], [" 2 "], ["01"], ["99999999999999999999"]])(
    "a tampered cursor %j ⇒ buildQuery page=1 AND mapPage nextCursor='2' on a full page (never injects/loops)",
    async (cursor) => {
      const transport = fakeTransport({ response: { status: 200, body: fullPage() } });
      const res = await gh(transport, { readScope: "repo:read", cursor });
      // strict parse ⇒ the emitted page is the fail-safe 1 (the junk cursor never becomes the page value —
      // buildQuery only ever emits `&page=<number>`, so the raw junk can't reach the query at all).
      expect(transport.calls[0]!.url).toContain("&page=1");
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.nextCursor).toBe("2");
    },
  );
});

// ── 4. Fail-closed on a non-array / malformed shape ─────────────────────────────
describe("createGithubHttpTransport — bare-array contract fail-closed", () => {
  it.each([
    ['{"items":[]}', "envelope object, not an array"],
    ["null", "null"],
    ["42", "number"],
    ['"str"', "string"],
    ["[42]", "array entry non-object"],
    ['[{"id":1}]', "entry missing node_id"],
    ['[{"id":1,"node_id":123}]', "entry non-string node_id"],
  ])("fail-closed on %s (%s) ⇒ TransportFailure, never a false page", async (body) => {
    const res = await gh(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(false);
  });
});

// ── 5. SSRF + redaction inherited from the template ─────────────────────────────
describe("createGithubHttpTransport — SSRF guard admits the GitHub host + redaction inherited", () => {
  it("the guard admits api.github.com on the final url; GET with the PAT in Authorization only", async () => {
    const transport = fakeTransport({ response: { status: 200, body: "[]" } });
    await gh(transport);
    const call = transport.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url.startsWith("https://api.github.com/issues")).toBe(true);
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.url).not.toContain(TOKEN);
    for (const [k, v] of Object.entries(call.headers)) {
      if (k.toLowerCase() !== "authorization") expect(v).not.toContain(TOKEN);
    }
  });

  it("a 401 (bad auth) ⇒ TransportFailure(auth_locked) with the safe status only; token never leaked", async () => {
    const transport = fakeTransport({ response: { status: 401, body: JSON.stringify({ message: "BODY_LEAK" }) } });
    const res = await gh(transport);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("auth_locked");
      expect(res.message).toContain("401");
      expect(res.message).not.toContain("BODY_LEAK");
    }
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it("a 403 (rate limit) ⇒ auth_locked; a 429 ⇒ rate_limited (diagnostic-only fault map)", async () => {
    const r403 = await gh(fakeTransport({ response: { status: 403, body: "{}" } }));
    const r429 = await gh(fakeTransport({ response: { status: 429, body: "{}" } }));
    expect(r403.ok).toBe(false);
    expect(r429.ok).toBe(false);
    if (!r403.ok) expect(r403.code).toBe("auth_locked");
    if (!r429.ok) expect(r429.code).toBe("rate_limited");
  });
});

// ── 6. End-to-end through createGithubConnector ─────────────────────────────────
describe("createGithubHttpTransport — drives the whole ConnectorPort.fetch chain via createGithubConnector", () => {
  it("raw→records through createGithubConnector (recordId/contentHash/payload; done/nextCursor threaded)", async () => {
    const transport = fakeTransport({ response: { status: 200, body: fullPage() } });
    const port = createGithubConnector(createGithubHttpTransport({ transport, secrets: fakeSecrets(), tokenRef: TOKEN_REF }));
    const page = await port.fetch();
    expect(isErr(page)).toBe(false);
    if (!isErr(page)) {
      expect(page.value.records).toHaveLength(PER_PAGE);
      expect(page.value.records[0]!.recordId).toBe("MD_0");
      expect(page.value.records[0]!.contentHash).toBeTruthy();
      expect(page.value.nextCursor).toBe("2");
      expect(page.value.done).toBe(false);
    }
    expect(transport.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});
