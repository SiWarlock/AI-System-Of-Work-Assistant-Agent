// spec(§6) — the GbrainHttpIndexApplyClient write-side HTTP transport over `gbrain serve --http`'s
// derived-index apply surface (put_page/sync_brain, task 19.3). Dormant/unbound: tested ENTIRELY with a
// FAKE HttpTransport + FAKE SecretsAccessor — zero real network/process/Keychain. Mirrors the read
// client's guard order (SSRF/allowlist BEFORE secret resolution, secret BEFORE dispatch, Lesson 1) and
// NEVER throws across `applyRevision` — every failure folds into a typed `IndexApplyError`.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, workspaceId } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { computeRevisionId } from "../src/knowledge-writer/revision";
import { deriveCanonicalFacts } from "../src/gbrain/derive/canonical-fact-deriver";
import type { CanonicalVaultSnapshot } from "../src/gbrain/derive/canonical-fact-deriver";
import type { IndexApplyRequest, IndexApplyError } from "../src/gbrain/index-sync";
import type {
  HttpTransport,
  HttpTransportRequest,
  HttpTransportResponse,
  SecretsAccessor,
  SecretUnavailable,
} from "../src/gbrain/gbrain-http-read-client";
import {
  createGbrainHttpIndexApplyClient,
  computeApplyIdempotencyKey,
  type GbrainHttpIndexApplyClientDeps,
} from "../src/gbrain/index-apply-http-client";

const TOKEN = "gb-secret-token-XYZ";
const TOKEN_REF = "keychain:gbrain-token";
const LOOPBACK = "http://127.0.0.1:8899";
const WS = "ws-apply";

// ── fixtures ────────────────────────────────────────────────────────────────

function snapshotOf(files: Record<string, string>): CanonicalVaultSnapshot {
  const map = new Map(Object.entries(files));
  return {
    workspaceId: workspaceId(WS),
    revisionId: computeRevisionId(map) as unknown as CanonicalVaultSnapshot["revisionId"],
    files: map,
  };
}

/** Build a real `IndexApplyRequest` (real branded `DerivedFact[]`) by deriving from committed
 *  Markdown — mirrors the project convention of driving fixtures through `deriveCanonicalFacts`
 *  rather than hand-constructing branded fields (gbrain-index-sync.test.ts / gbrain-rebuild.test.ts). */
function applyRequestFor(files: Record<string, string>): IndexApplyRequest {
  const snap = snapshotOf(files);
  const derived = deriveCanonicalFacts(snap);
  if (!derived.ok) throw new Error("fixture derive failed");
  return {
    workspaceId: WS,
    revisionId: snap.revisionId as unknown as string,
    facts: derived.value.facts,
  };
}

const TWO_PAGE_REQUEST = (): IndexApplyRequest =>
  applyRequestFor({
    "acme-api/auth.md": "---\nslug: auth\ntags: security\n---\n# Auth\nSee [[oauth]].\n",
    "acme-api/oauth.md": "---\nslug: oauth\n---\n# OAuth\nDetails here.\n",
  });

// ── fakes ───────────────────────────────────────────────────────────────────

function fakeTransport(
  behavior: { response?: HttpTransportResponse; throw?: unknown } = {},
): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  return {
    calls,
    async send(req) {
      calls.push(req);
      if (behavior.throw !== undefined) throw behavior.throw;
      return behavior.response ?? { status: 200, body: JSON.stringify({ nodeCount: 0, mutated: true }) };
    },
  };
}

/** A minimal, deterministic "server": echoes `nodeCount = facts.length` and reports `mutated:false` the
 *  SECOND time it sees a given Idempotency-Key header — proving the CLIENT sends the same key on a
 *  replay (the client never decides `mutated` itself; it relays the server's decision). */
function fakeIdempotentApplyTransport(): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  const seenKeys = new Set<string>();
  return {
    calls,
    async send(req) {
      calls.push(req);
      const key = req.headers["Idempotency-Key"];
      const body = JSON.parse(req.body) as { facts: unknown[] };
      const alreadyApplied = key !== undefined && seenKeys.has(key);
      if (key !== undefined) seenKeys.add(key);
      return {
        status: 200,
        body: JSON.stringify({ nodeCount: body.facts.length, mutated: !alreadyApplied }),
      };
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

function makeDeps(overrides: Partial<GbrainHttpIndexApplyClientDeps> = {}): GbrainHttpIndexApplyClientDeps {
  return {
    transport: fakeTransport(),
    secrets: fakeSecrets(),
    tokenRef: TOKEN_REF,
    endpoint: LOOPBACK,
    allowedEndpoints: [LOOPBACK],
    ...overrides,
  };
}

/** Serialize EVERYTHING reachable on an `IndexApplyError` (own props incl. `cause`, and the cause's own
 *  props + message + stack) so a "never leaks" assertion cannot pass just because the token hid in a
 *  field this dump doesn't visit (mirrors gbrain-http-read-client.test.ts's `dumpError`). */
function dumpApplyError(e: IndexApplyError): string {
  const own = JSON.stringify(e, Object.getOwnPropertyNames(e));
  const cause = e.cause;
  const causeDump =
    cause instanceof Error
      ? `${cause.message} ${String((cause as { stack?: unknown }).stack ?? "")} ${JSON.stringify(
          cause,
          Object.getOwnPropertyNames(cause),
        )}`
      : cause !== undefined
        ? JSON.stringify(cause)
        : "";
  return `${own} ${causeDump}`;
}

/** Assert the call RESOLVED (never rejected) — `applyRevision` is a total async function returning a
 *  Result, so a rejection here is itself a failing assertion, not merely "did not throw synchronously". */
async function neverRejects<T>(p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    throw new Error(`expected applyRevision to resolve (never reject), but it rejected: ${String(e)}`);
  });
}

// ── (a) SSRF/allowlist guard before secrets before dispatch ──────────────────

describe("createGbrainHttpIndexApplyClient — guard order (Lesson 1 / Lesson 4)", () => {
  it("off_allowlist_endpoint_refuses_before_secret_read", async () => {
    const transport = fakeTransport();
    const secrets = fakeSecrets(ok(TOKEN));
    const client = createGbrainHttpIndexApplyClient(
      makeDeps({ transport, secrets, endpoint: LOOPBACK, allowedEndpoints: ["http://127.0.0.1:1234"] }),
    );
    const result = await neverRejects(client.applyRevision(TWO_PAGE_REQUEST()));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("gbrain_unavailable");
    expect(secrets.refs).toHaveLength(0); // ZERO secret reads
    expect(transport.calls).toHaveLength(0); // ZERO dispatch
  });

  it("token_unavailable_never_dispatches", async () => {
    const transport = fakeTransport();
    const secrets = fakeSecrets(err({ reason: "locked" }));
    const client = createGbrainHttpIndexApplyClient(makeDeps({ transport, secrets }));
    const result = await neverRejects(client.applyRevision(TWO_PAGE_REQUEST()));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("gbrain_unavailable");
    expect(transport.calls).toHaveLength(0); // token gate is BEFORE the send
  });
});

// ── (c)/(d) idempotency ────────────────────────────────────────────────────

describe("createGbrainHttpIndexApplyClient — idempotency key (task 19.3)", () => {
  it("replay_is_idempotent", async () => {
    const transport = fakeIdempotentApplyTransport();
    const client = createGbrainHttpIndexApplyClient(makeDeps({ transport }));
    const request = TWO_PAGE_REQUEST();

    const first = await client.applyRevision(request);
    const second = await client.applyRevision(request);

    expect(transport.calls).toHaveLength(2);
    const key1 = transport.calls[0]!.headers["Idempotency-Key"];
    const key2 = transport.calls[1]!.headers["Idempotency-Key"];
    expect(key1).toBeDefined();
    expect(key2).toBe(key1); // SAME key sent both times

    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (isOk(first)) expect(first.value.mutated).toBe(true); // first apply mutates
    if (isOk(second)) expect(second.value.mutated).toBe(false); // replay reports no-op
  });

  it("reordered_facts_do_not_change_the_key", () => {
    const request = TWO_PAGE_REQUEST();
    const reordered: IndexApplyRequest = { ...request, facts: [...request.facts].reverse() };
    expect(request.facts.length).toBeGreaterThan(1); // non-vacuity: there IS an order to reverse
    expect(computeApplyIdempotencyKey(reordered)).toBe(computeApplyIdempotencyKey(request));
  });
});

// ── (e) non-2xx / malformed body fold to apply_failed, never throw ───────────

describe("createGbrainHttpIndexApplyClient — redacted fold, never throws (§16)", () => {
  it("non_2xx_and_malformed_body_fold_to_apply_failed_never_throw", async () => {
    const nonTwoXx = fakeTransport({ response: { status: 503, body: "{}" } });
    const clientA = createGbrainHttpIndexApplyClient(makeDeps({ transport: nonTwoXx }));
    const resultA = await neverRejects(clientA.applyRevision(TWO_PAGE_REQUEST()));
    expect(isOk(resultA)).toBe(false);
    if (isErr(resultA)) expect(resultA.error.code).toBe("apply_failed");

    const malformed = fakeTransport({ response: { status: 200, body: "<<not json>>" } });
    const clientB = createGbrainHttpIndexApplyClient(makeDeps({ transport: malformed }));
    const resultB = await neverRejects(clientB.applyRevision(TWO_PAGE_REQUEST()));
    expect(isOk(resultB)).toBe(false);
    if (isErr(resultB)) expect(resultB.error.code).toBe("apply_failed");
  });

  it("a_valid_json_2xx_body_missing_the_required_shape_also_folds_to_apply_failed", async () => {
    // Distinct from the JSON-parse-failure case above: valid JSON, wrong SHAPE (no `mutated` field) —
    // proves the response is structurally validated, not merely `JSON.parse`d.
    const wrongShape = fakeTransport({ response: { status: 200, body: JSON.stringify({ nodeCount: 3 }) } });
    const client = createGbrainHttpIndexApplyClient(makeDeps({ transport: wrongShape }));
    const result = await neverRejects(client.applyRevision(TWO_PAGE_REQUEST()));
    expect(isOk(result)).toBe(false);
    if (isErr(result)) expect(result.error.code).toBe("apply_failed");
  });
});

// ── (f) redaction ─────────────────────────────────────────────────────────────

describe("createGbrainHttpIndexApplyClient — redacted fault mapping (rule 7)", () => {
  it("fault_message_carries_no_token_no_url_no_row_content", async () => {
    const sentinel = "SENTINEL-ROW-CONTENT-9f3a2b1c";
    const request = applyRequestFor({ "leak.md": `# Leak\n\n${sentinel}\n` });
    const secrets = fakeSecrets(ok(TOKEN));
    // The transport resolves the token (so it is attached to the header) and THEN throws — its raw
    // message deliberately carries the token, the endpoint, AND the sentinel, mirroring an attacker- or
    // vendor-controlled error string. The fault the client returns must contain none of it.
    const transport: HttpTransport = {
      async send() {
        throw new Error(`ECONNREFUSED ${LOOPBACK} token=${TOKEN} body=${sentinel}`);
      },
    };
    const client = createGbrainHttpIndexApplyClient(makeDeps({ transport, secrets }));
    const result = await neverRejects(client.applyRevision(request));
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    // pin the fault fired for the intended reason (transport throw), not e.g. a redacted
    // apply_failed from a different branch — the union has more than one code.
    expect(result.error.code).toBe("gbrain_unavailable");
    const dump = dumpApplyError(result.error);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(sentinel);
    expect(dump).not.toContain(LOOPBACK);
  });
});

// ── happy path + honesty ──────────────────────────────────────────────────────

describe("createGbrainHttpIndexApplyClient — dispatch + honest relay", () => {
  it("dispatches_and_relays_the_servers_reported_counts_honestly", async () => {
    const request = TWO_PAGE_REQUEST();
    // The fake server reports a count SMALLER than request.facts.length, on purpose — if the client
    // ever synthesized nodeCount from the request instead of relaying the response, this would not
    // discriminate.
    const transport = fakeTransport({
      response: { status: 200, body: JSON.stringify({ nodeCount: 1, mutated: true }) },
    });
    const secrets = fakeSecrets(ok(TOKEN));
    const client = createGbrainHttpIndexApplyClient(makeDeps({ transport, secrets }));

    const result = await client.applyRevision(request);

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.method).toBe("POST");
    expect(transport.calls[0]!.url).toBe(`${LOOPBACK}/write/index-apply`);
    expect(transport.calls[0]!.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.nodeCount).toBe(1); // relayed, not request.facts.length (2)
      expect(result.value.mutated).toBe(true);
      expect(result.value.workspaceId).toBe(WS);
      expect(result.value.revisionId).toBe(request.revisionId);
    }
  });
});
