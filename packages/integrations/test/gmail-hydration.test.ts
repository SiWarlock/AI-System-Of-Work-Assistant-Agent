// spec(§8) spec(§5) — Gmail messages.get HYDRATION fan-out (LEG 1, PKG-INT-5 · 23.4). SEPARATE from the
// ConnectorHttpSpec template (http-transport.ts drives ONE request per page) — createGmailHydrator fans out
// N bounded-concurrency GETs to /gmail/v1/users/me/messages/{id}, with per-id PARTIAL-FAILURE outcomes (one
// bad id never fails the batch), a single bounded 429 backoff retry (nextDelayMs, injected sleep — never a
// real timer), and a CONTENT-DERIVED hash that supersedes the list-only {id,threadId} hash. ING-7: a
// hydrated body is UNTRUSTED external content — the hydrator itself is read-only-by-construction (one
// method, GET only). Fakes only: real HttpTransport + SecretsAccessor + OAuth token stay UNBOUND.
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
import { createGmailHydrator } from "../src/connectors/adapters/gmail";
import { nextDelayMs, type BackoffConfig } from "../src/connectors/backoff";

const TOKEN = "ya29.GMAIL-OAUTH-readonly-secret";
const TOKEN_REF = "keychain:gmail-oauth";
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

/** A queue-driven fake transport: id → an ordered list of responses (each call to that id consumes the
 *  next queued response — supports "429 then 200" sequences, capped at the last entry once exhausted).
 *  Tracks max concurrent in-flight sends via a microtask-yield barrier — deterministic under the Promise
 *  microtask queue, no real timers (sibling lanes launched in the same fan-out get a chance to also
 *  register their `send` before this one completes, so real overlap is observable). */
function fakeHydrationTransport(
  responsesById: Record<string, QueueEntry[]>,
): HttpTransport & { calls: HttpTransportRequest[]; maxConcurrent: () => number } {
  const calls: HttpTransportRequest[] = [];
  const cursors: Record<string, number> = {};
  let active = 0;
  let max = 0;
  return {
    calls,
    maxConcurrent: () => max,
    async send(req) {
      calls.push(req);
      active += 1;
      if (active > max) max = active;
      await Promise.resolve();
      await Promise.resolve();
      active -= 1;
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

// ── 1. N ids ⇒ N GETs, percent-encoded, bounded concurrency ─────────────────────
describe("createGmailHydrator — fan-out shape", () => {
  it("N ids ⇒ N GETs to /gmail/v1/users/me/messages/{id}, each id percent-encoded", async () => {
    const ids = ["m1", "m 2", "m/3"];
    const transport = fakeHydrationTransport({
      m1: [okBody({ id: "m1", snippet: "a" })],
      "m 2": [okBody({ id: "m 2", snippet: "b" })],
      "m/3": [okBody({ id: "m/3", snippet: "c" })],
    });
    const hydrator = createGmailHydrator(deps(transport, { maxConcurrent: 3 }));
    const res = await hydrator.hydrate(ids);
    expect(transport.calls).toHaveLength(3);
    expect(res.succeeded).toHaveLength(3);
    for (const id of ids) {
      expect(transport.calls.some((c) => c.url === `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`)).toBe(true);
    }
  });

  it("never runs more than maxConcurrent GETs in flight at once (and real overlap happens — positive control)", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const responses: Record<string, QueueEntry[]> = {};
    for (const id of ids) responses[id] = [okBody({ id })];
    const transport = fakeHydrationTransport(responses);
    const hydrator = createGmailHydrator(deps(transport, { maxConcurrent: 2 }));
    const res = await hydrator.hydrate(ids);
    expect(res.succeeded).toHaveLength(5);
    expect(transport.maxConcurrent()).toBeLessThanOrEqual(2);
    // positive control: the bound is only meaningful if real concurrent overlap was observed — a
    // trivially-serial implementation would also satisfy "<=2" without proving the fan-out is bounded
    // CONCURRENCY (rather than accidentally sequential).
    expect(transport.maxConcurrent()).toBeGreaterThan(1);
  });
});

// ── 2. PARTIAL FAILURE SEMANTICS (load-bearing) ──────────────────────────────────
describe("createGmailHydrator — partial-failure semantics (load-bearing, commit body)", () => {
  it("one failing get among N does not fail the batch — succeeded + per-id faults both returned", async () => {
    const ids = ["ok1", "bad", "ok2"];
    const transport = fakeHydrationTransport({
      ok1: [okBody({ id: "ok1", snippet: "x" })],
      bad: [{ status: 500, body: "server exploded" }],
      ok2: [okBody({ id: "ok2", snippet: "y" })],
    });
    const hydrator = createGmailHydrator(deps(transport, { maxConcurrent: 3 }));
    const res = await hydrator.hydrate(ids);
    expect(res.succeeded.map((s) => s.id).sort()).toEqual(["ok1", "ok2"]);
    expect(res.faults).toHaveLength(1);
    expect(res.faults[0]!.id).toBe("bad");
    expect(res.faults[0]!.code).toBe("unreachable");
  });
});

// ── 3. RATE LIMIT: one bounded backoff retry ─────────────────────────────────────
describe("createGmailHydrator — 429 rate-limit: one bounded backoff retry, then a typed fault", () => {
  it("a 429 then a 200 ⇒ exactly one sleep (argument from nextDelayMs) then success", async () => {
    const sleep = fakeSleep();
    const transport = fakeHydrationTransport({
      m1: [{ status: 429, body: "" }, okBody({ id: "m1", snippet: "hydrated" })],
    });
    const hydrator = createGmailHydrator(deps(transport, { maxConcurrent: 1, sleep }));
    const res = await hydrator.hydrate(["m1"]);
    expect(res.succeeded).toHaveLength(1);
    expect(res.faults).toHaveLength(0);
    expect(sleep.calls).toEqual([nextDelayMs(1, BACKOFF)]);
    expect(transport.calls).toHaveLength(2);
  });

  it("a 429 then a second 429 ⇒ a typed rate_limited fault and stops (no third attempt, one sleep total)", async () => {
    const sleep = fakeSleep();
    const transport = fakeHydrationTransport({
      m1: [{ status: 429, body: "" }, { status: 429, body: "" }],
    });
    const hydrator = createGmailHydrator(deps(transport, { maxConcurrent: 1, sleep }));
    const res = await hydrator.hydrate(["m1"]);
    expect(res.faults).toHaveLength(1);
    expect(res.faults[0]!.code).toBe("rate_limited");
    expect(transport.calls).toHaveLength(2);
    expect(sleep.calls).toHaveLength(1);
  });

  it("a 429 on one id does not trigger a retry or sleep for the others", async () => {
    const sleep = fakeSleep();
    const transport = fakeHydrationTransport({
      bad: [{ status: 429, body: "" }, { status: 429, body: "" }],
      good: [okBody({ id: "good" })],
    });
    const hydrator = createGmailHydrator(deps(transport, { maxConcurrent: 2, sleep }));
    const res = await hydrator.hydrate(["bad", "good"]);
    expect(res.succeeded.map((s) => s.id)).toEqual(["good"]);
    expect(res.faults.map((f) => f.id)).toEqual(["bad"]);
    expect(sleep.calls).toHaveLength(1); // only bad's single retry produced a sleep call
    const goodCalls = transport.calls.filter((c) => c.url.includes("good"));
    expect(goodCalls).toHaveLength(1); // good was fetched exactly once, never retried
  });
});

// ── 4. CONTENT HASH — supersedes the list-only {id,threadId} hash ───────────────
describe("createGmailHydrator — content-derived hash supersedes the list-only {id,threadId} hash", () => {
  it("two hydrations of the same id with different bodies produce different hashes", async () => {
    const t1 = fakeHydrationTransport({ m1: [okBody({ id: "m1", snippet: "first version" })] });
    const t2 = fakeHydrationTransport({ m1: [okBody({ id: "m1", snippet: "second version" })] });
    const r1 = await createGmailHydrator(deps(t1, { maxConcurrent: 1 })).hydrate(["m1"]);
    const r2 = await createGmailHydrator(deps(t2, { maxConcurrent: 1 })).hydrate(["m1"]);
    expect(r1.succeeded[0]!.hash).not.toBe(r2.succeeded[0]!.hash);
  });

  it("identical bodies produce identical hashes", async () => {
    const body = okBody({ id: "m1", snippet: "same content" });
    const t1 = fakeHydrationTransport({ m1: [body] });
    const t2 = fakeHydrationTransport({ m1: [body] });
    const r1 = await createGmailHydrator(deps(t1, { maxConcurrent: 1 })).hydrate(["m1"]);
    const r2 = await createGmailHydrator(deps(t2, { maxConcurrent: 1 })).hydrate(["m1"]);
    expect(r1.succeeded[0]!.hash).toBeTruthy();
    expect(r1.succeeded[0]!.hash).toBe(r2.succeeded[0]!.hash);
  });
});

// ── 5. RULE 7 / SSRF ─────────────────────────────────────────────────────────────
describe("createGmailHydrator — SSRF guard + rule-7 (never leak body or token in a fault)", () => {
  it("a crafted id cannot smuggle a host or path traversal into the url (percent-encoded)", async () => {
    const crafted = "evil@attacker.com/../../x";
    const transport = fakeHydrationTransport({ [crafted]: [okBody({ id: crafted })] });
    const hydrator = createGmailHydrator(deps(transport, { maxConcurrent: 1 }));
    await hydrator.hydrate([crafted]);
    const url = transport.calls[0]!.url;
    expect(url).toBe(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(crafted)}`);
    expect(url).not.toContain("evil@attacker.com/");
  });

  it("the dispatched per-id url satisfies isAllowedRemoteEndpoint against the gmail.googleapis.com allowlist", async () => {
    const transport = fakeHydrationTransport({ m1: [okBody({ id: "m1" })] });
    const hydrator = createGmailHydrator(deps(transport, { maxConcurrent: 1 }));
    await hydrator.hydrate(["m1"]);
    expect(isAllowedRemoteEndpoint(transport.calls[0]!.url, ["gmail.googleapis.com"])).toBe(true);
  });

  it("no fault message contains the response body, even under a 500 with a leaking body", async () => {
    const transport = fakeHydrationTransport({
      m1: [{ status: 500, body: JSON.stringify({ secret_leak: "BODY_LEAK_MARKER" }) }],
    });
    const hydrator = createGmailHydrator(deps(transport, { maxConcurrent: 1 }));
    const res = await hydrator.hydrate(["m1"]);
    expect(res.faults).toHaveLength(1);
    expect(JSON.stringify(res.faults[0])).not.toContain("BODY_LEAK_MARKER");
  });

  it("no fault message ever contains the bearer token, across success, 401, and 429 paths", async () => {
    const transport = fakeHydrationTransport({
      m1: [{ status: 401, body: "unauthorized" }],
      m2: [{ status: 429, body: "" }, { status: 429, body: "" }],
    });
    const hydrator = createGmailHydrator(deps(transport, { maxConcurrent: 2 }));
    const res = await hydrator.hydrate(["m1", "m2"]);
    expect(res.faults).toHaveLength(2);
    const serialized = JSON.stringify(res.faults);
    expect(serialized).not.toContain(TOKEN);
  });
});

// ── 6. ING-7 HARD — read-only by construction ────────────────────────────────────
describe("createGmailHydrator — ING-7: the hydrator exposes no mutating method, issues only GET", () => {
  it("the hydrator exposes exactly one method (hydrate) — no mutating surface", async () => {
    const transport = fakeHydrationTransport({ m1: [okBody({ id: "m1" })] });
    const hydrator = createGmailHydrator(deps(transport, { maxConcurrent: 1 }));
    expect(Object.keys(hydrator)).toEqual(["hydrate"]);
  });

  it("every dispatched request is a GET — never a mutating verb", async () => {
    const ids = ["m1", "m2"];
    const transport = fakeHydrationTransport({
      m1: [okBody({ id: "m1" })],
      m2: [okBody({ id: "m2" })],
    });
    const hydrator = createGmailHydrator(deps(transport, { maxConcurrent: 2 }));
    await hydrator.hydrate(ids);
    for (const call of transport.calls) expect(call.method).toBe("GET");
  });
});
