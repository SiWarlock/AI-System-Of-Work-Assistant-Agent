// spec(§8) spec(§5) — Granola /v1/notes/{id} second-hop HYDRATION (LEG 2, PKG-INT-5 · 23.4). SAME shape as
// the Gmail messages.get fan-out (gmail.ts) — SEPARATE from the ConnectorHttpSpec template.
// createGranolaNoteHydrator fans out N bounded-concurrency GETs to /v1/notes/{id}: the returned note-detail
// body text (summary_markdown / summary_text) populates the item raw so REAL content — not just the
// list-stage's bare metadata — reaches SourceEnvelope. A missing/empty body FAILS CLOSED to a typed fault
// (never an empty-but-successful hydration). 401 ⇒ auth_locked, 429 ⇒ rate_limited with one bounded retry,
// mirroring leg 1. Static `grn_` key semantics unchanged (no refresh here — PKG-INT-4 owns that). Fakes
// only: real HttpTransport + SecretsAccessor + the `grn_` key stay UNBOUND.
import { describe, it, expect } from "vitest";
import { ok } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { isAllowedRemoteEndpoint } from "@sow/policy";
import type {
  HttpTransport,
  HttpTransportRequest,
  HttpTransportResponse,
  SecretsAccessor,
  SecretUnavailable,
} from "../src/connectors/adapters/http-transport";
import { createGranolaNoteHydrator } from "../src/connectors/adapters/granola";
import { nextDelayMs, type BackoffConfig } from "../src/connectors/backoff";

const TOKEN = "grn_STATIC-API-KEY-secret";
const TOKEN_REF = "keychain:granola-api-key";
const BACKOFF: BackoffConfig = { baseMs: 50, maxMs: 1_000, maxAttempts: 5 };

function fakeSecrets(result: Result<string, SecretUnavailable> = ok(TOKEN)): SecretsAccessor {
  return {
    async getSecret() {
      return result;
    },
  };
}

function fakeSleep(): ((ms: number) => Promise<void>) & { calls: number[] } {
  const calls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    calls.push(ms);
  };
  return Object.assign(sleep, { calls });
}

type QueueEntry = HttpTransportResponse | { throw: unknown };

function fakeHydrationTransport(
  responsesById: Record<string, QueueEntry[]>,
): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  const cursors: Record<string, number> = {};
  return {
    calls,
    async send(req) {
      calls.push(req);
      const id = decodeURIComponent(req.url.split("/").pop() ?? "");
      const queue = responsesById[id];
      if (queue === undefined || queue.length === 0) {
        throw new Error(`fakeHydrationTransport: no response queued for id ${id}`);
      }
      const i = cursors[id] ?? 0;
      cursors[id] = Math.min(i + 1, queue.length - 1);
      const entry = queue[Math.min(i, queue.length - 1)]!;
      if ("throw" in entry) throw entry.throw;
      return entry;
    },
  };
}

function okBody(body: unknown): HttpTransportResponse {
  return { status: 200, body: JSON.stringify(body) };
}

const NOTE_ID = "not_1d3tmYTlCICgjy";

const FULL_NOTE = {
  id: NOTE_ID,
  object: "note",
  title: "Quarterly yoghurt budget review",
  owner: { id: "usr_abc123", object: "user", name: "Alice", email: "alice@granola.ai" },
  created_at: "2026-01-27T15:30:00Z",
  updated_at: "2026-01-27T16:45:00Z",
  summary_text: "The quarterly yoghurt budget review was a success.",
  summary_markdown: "## Quarterly Yoghurt Budget Review\n\nThe review was a success.",
};

function deps(
  transport: HttpTransport,
  overrides: Partial<{ maxConcurrent: number; sleep: (ms: number) => Promise<void> }> = {},
) {
  return {
    transport,
    secrets: fakeSecrets(),
    tokenRef: TOKEN_REF,
    maxConcurrent: overrides.maxConcurrent ?? 3,
    backoff: BACKOFF,
    sleep: overrides.sleep ?? fakeSleep(),
  };
}

// ── 7. A note id maps to one GET; real content (not just metadata) reaches raw ──
describe("createGranolaNoteHydrator — one GET per id; real note content populates raw", () => {
  it("GETs /v1/notes/{id} and the hydrated raw carries body text beyond the list-stage metadata", async () => {
    const transport = fakeHydrationTransport({ [NOTE_ID]: [okBody(FULL_NOTE)] });
    const hydrator = createGranolaNoteHydrator(deps(transport, { maxConcurrent: 1 }));
    const res = await hydrator.hydrate([NOTE_ID]);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.url).toBe(`https://public-api.granola.ai/v1/notes/${encodeURIComponent(NOTE_ID)}`);
    expect(res.succeeded).toHaveLength(1);
    const item = res.succeeded[0]!;
    expect(item.id).toBe(NOTE_ID);
    // the list-stage only ever carries {id,title,owner,created_at,updated_at} — the hydrated raw must carry
    // the note's real BODY TEXT beyond that bare metadata shape.
    const raw = item.raw as Record<string, unknown>;
    expect(raw.summary_markdown).toBe(FULL_NOTE.summary_markdown);
    expect(raw.summary_text).toBe(FULL_NOTE.summary_text);
  });
});

// ── 8. Missing/empty body fails closed — never an empty-but-successful hydration ─
describe("createGranolaNoteHydrator — a missing/empty body fails closed (never a silent empty success)", () => {
  const bodylessCases: Array<[Record<string, unknown>, string]> = [
    [{ ...FULL_NOTE, summary_markdown: null, summary_text: "" }, "both fields empty/null"],
    [{ id: NOTE_ID, title: "no body fields at all" }, "both fields absent"],
    [{ ...FULL_NOTE, summary_markdown: "", summary_text: undefined }, "empty markdown, absent text"],
  ];
  it.each(bodylessCases)("a note with no usable body text (%s) ⇒ a typed fault, not an empty success", async (note) => {
    const transport = fakeHydrationTransport({ [NOTE_ID]: [okBody(note)] });
    const hydrator = createGranolaNoteHydrator(deps(transport, { maxConcurrent: 1 }));
    const res = await hydrator.hydrate([NOTE_ID]);
    expect(res.succeeded).toHaveLength(0);
    expect(res.faults).toHaveLength(1);
    expect(res.faults[0]!.id).toBe(NOTE_ID);
  });

  it("a note where ONLY summary_text is present (no markdown) still hydrates successfully", async () => {
    const note = { ...FULL_NOTE, summary_markdown: null };
    const transport = fakeHydrationTransport({ [NOTE_ID]: [okBody(note)] });
    const hydrator = createGranolaNoteHydrator(deps(transport, { maxConcurrent: 1 }));
    const res = await hydrator.hydrate([NOTE_ID]);
    expect(res.succeeded).toHaveLength(1);
    expect(res.faults).toHaveLength(0);
  });
});

// ── 9. 401 auth_locked / 429 rate_limited with one bounded retry ────────────────
describe("createGranolaNoteHydrator — 401 auth_locked, 429 rate_limited with one bounded retry (mirrors leg 1)", () => {
  it("a 401 ⇒ a typed auth_locked fault", async () => {
    const transport = fakeHydrationTransport({ [NOTE_ID]: [{ status: 401, body: "unauthorized" }] });
    const hydrator = createGranolaNoteHydrator(deps(transport, { maxConcurrent: 1 }));
    const res = await hydrator.hydrate([NOTE_ID]);
    expect(res.faults).toHaveLength(1);
    expect(res.faults[0]!.code).toBe("auth_locked");
  });

  it("a 429 then a 200 ⇒ exactly one sleep (from nextDelayMs) then success", async () => {
    const sleep = fakeSleep();
    const transport = fakeHydrationTransport({
      [NOTE_ID]: [{ status: 429, body: "" }, okBody(FULL_NOTE)],
    });
    const hydrator = createGranolaNoteHydrator(deps(transport, { maxConcurrent: 1, sleep }));
    const res = await hydrator.hydrate([NOTE_ID]);
    expect(res.succeeded).toHaveLength(1);
    expect(sleep.calls).toEqual([nextDelayMs(1, BACKOFF)]);
    expect(transport.calls).toHaveLength(2);
  });

  it("a 429 then a second 429 ⇒ a typed rate_limited fault and stops (no third attempt)", async () => {
    const sleep = fakeSleep();
    const transport = fakeHydrationTransport({
      [NOTE_ID]: [{ status: 429, body: "" }, { status: 429, body: "" }],
    });
    const hydrator = createGranolaNoteHydrator(deps(transport, { maxConcurrent: 1, sleep }));
    const res = await hydrator.hydrate([NOTE_ID]);
    expect(res.faults).toHaveLength(1);
    expect(res.faults[0]!.code).toBe("rate_limited");
    expect(transport.calls).toHaveLength(2);
    expect(sleep.calls).toHaveLength(1);
  });
});

// ── 10. Same rule-7 assertion as leg 1 (SSRF + no body/token leakage) ────────────
describe("createGranolaNoteHydrator — SSRF guard + rule-7 (never leak body or token in a fault)", () => {
  it("the dispatched per-id url satisfies isAllowedRemoteEndpoint against public-api.granola.ai", async () => {
    const transport = fakeHydrationTransport({ [NOTE_ID]: [okBody(FULL_NOTE)] });
    const hydrator = createGranolaNoteHydrator(deps(transport, { maxConcurrent: 1 }));
    await hydrator.hydrate([NOTE_ID]);
    expect(isAllowedRemoteEndpoint(transport.calls[0]!.url, ["public-api.granola.ai"])).toBe(true);
  });

  it("a crafted id cannot smuggle a host or path traversal into the url (percent-encoded)", async () => {
    const crafted = "evil@attacker.com/../../x";
    const transport = fakeHydrationTransport({ [crafted]: [okBody({ ...FULL_NOTE, id: crafted })] });
    const hydrator = createGranolaNoteHydrator(deps(transport, { maxConcurrent: 1 }));
    await hydrator.hydrate([crafted]);
    const url = transport.calls[0]!.url;
    expect(url).toBe(`https://public-api.granola.ai/v1/notes/${encodeURIComponent(crafted)}`);
    expect(url).not.toContain("evil@attacker.com/");
  });

  it("no fault message contains the response body, even under a 500 with a leaking body", async () => {
    const transport = fakeHydrationTransport({
      [NOTE_ID]: [{ status: 500, body: JSON.stringify({ secret_leak: "BODY_LEAK_MARKER" }) }],
    });
    const hydrator = createGranolaNoteHydrator(deps(transport, { maxConcurrent: 1 }));
    const res = await hydrator.hydrate([NOTE_ID]);
    expect(res.faults).toHaveLength(1);
    expect(JSON.stringify(res.faults[0])).not.toContain("BODY_LEAK_MARKER");
  });

  it("no fault message ever contains the bearer token, across 401 and 429-exhausted paths", async () => {
    const transport = fakeHydrationTransport({
      [NOTE_ID]: [{ status: 401, body: "unauthorized" }],
    });
    const hydrator = createGranolaNoteHydrator(deps(transport, { maxConcurrent: 1 }));
    const res = await hydrator.hydrate([NOTE_ID]);
    expect(JSON.stringify(res.faults)).not.toContain(TOKEN);
  });
});
