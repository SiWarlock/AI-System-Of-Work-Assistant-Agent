// Task 21.3 (todoist-read leg) — the DORMANT read-only Todoist HTTP transport
// (`createTodoistHttpTransport` + `TODOIST_HTTP_SPEC`), a direct mirror of the asana
// read transport specialized to the Todoist UNIFIED v1 wire shape (Context7-grounded
// candidate, arch_gap): `GET https://api.todoist.com/api/v1/tasks` (Bearer), cursor-
// paginated `{ results: Task[], next_cursor: string|null }`, Task `{ id, content,
// updated_at? }`. The read CONNECTOR (`createTodoistConnector`, data:read) already
// exists (slice 6.3) — this adds the transport half. Real HttpTransport + token stay
// UNBOUND (§ARM-23); tests inject fakes. Emit-only, TOTAL never-throws, fail-closed.
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
import { createTodoistHttpTransport, createTodoistConnector } from "../src/connectors/adapters/todoist";

const TOKEN = "todoist_data_read_token_secret";
const TOKEN_REF = "keychain:todoist-token";
const REQ: TransportRequest = { readScope: "data:read" };

function fakeTransport(
  behavior: { response?: HttpTransportResponse; throw?: unknown } = {},
): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  return {
    calls,
    async send(req) {
      calls.push(req);
      if (behavior.throw !== undefined) throw behavior.throw;
      return behavior.response ?? { status: 200, body: JSON.stringify({ results: [], next_cursor: null }) };
    },
  };
}

function fakeSecrets(
  result: Result<string, SecretUnavailable> = ok(TOKEN),
  opts: { throw?: unknown } = {},
): SecretsAccessor & { refs: string[] } {
  const refs: string[] = [];
  return {
    refs,
    async getSecret(ref) {
      refs.push(ref);
      if (opts.throw !== undefined) throw opts.throw;
      return result;
    },
  };
}

const TASKS = [
  { id: "task_1", content: "Buy milk", updated_at: "2026-01-17T10:30:00Z" },
  { id: "task_2", content: "Call Bob", updated_at: "2026-01-18T10:30:00Z" },
];
const page = (nextCursor: string | null, results: unknown[] = TASKS): string =>
  JSON.stringify({ results, next_cursor: nextCursor });

const run = (
  transport: HttpTransport,
  req: TransportRequest = REQ,
  secrets: SecretsAccessor = fakeSecrets(),
) => createTodoistHttpTransport({ transport, secrets, tokenRef: TOKEN_REF })(req);

// ── 1. Candidate v1 page maps ⇒ TransportPage (arch_gap) ──────────────────────
describe("createTodoistHttpTransport — v1 {results,next_cursor} page maps (arch_gap)", () => {
  it("results + next_cursor ⇒ items (id, distinct payloadHash({id,updated_at}), raw=task), nextCursor, done=false", async () => {
    const res = await run(fakeTransport({ response: { status: 200, body: page("c1") } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items.map((i) => i.id)).toEqual(["task_1", "task_2"]);
      expect(res.items[0]!.hash).toBeTruthy();
      expect(res.items[0]!.hash).not.toBe(res.items[1]!.hash);
      expect(res.items[0]!.raw).toEqual(TASKS[0]);
      expect(res.nextCursor).toBe("c1");
      expect(res.done).toBe(false);
    }
  });

  it("next_cursor null ⇒ done=true, no nextCursor", async () => {
    const res = await run(fakeTransport({ response: { status: 200, body: page(null) } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.done).toBe(true);
      expect(res.nextCursor).toBeUndefined();
    }
  });

  it("an empty results[] with next_cursor null ⇒ ok, 0 items, done=true (valid empty page ≠ failure)", async () => {
    const res = await run(fakeTransport({ response: { status: 200, body: page(null, []) } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items.length).toBe(0);
      expect(res.done).toBe(true);
    }
  });

  it("contentHash falls back to hashing the raw task when updated_at absent (still stable)", async () => {
    const body = page(null, [{ id: "task_x", content: "T" }]);
    const a = await run(fakeTransport({ response: { status: 200, body } }));
    const b = await run(fakeTransport({ response: { status: 200, body } }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.items[0]!.hash).toBeTruthy();
      expect(a.items[0]!.hash).toBe(b.items[0]!.hash); // deterministic / replay-stable
    }
  });

  it("an edit (changed updated_at) advances the contentHash ⇒ re-emit", async () => {
    const v1 = await run(fakeTransport({ response: { status: 200, body: page(null, [TASKS[0]]) } }));
    const v2 = await run(fakeTransport({ response: { status: 200, body: page(null, [{ ...TASKS[0], updated_at: "2026-02-01T00:00:00Z" }]) } }));
    expect(v1.ok && v2.ok).toBe(true);
    if (v1.ok && v2.ok) expect(v1.items[0]!.hash).not.toBe(v2.items[0]!.hash);
  });
});

// ── 2. Fail-closed candidate mapping (L21) ────────────────────────────────────
describe("createTodoistHttpTransport — fail-closed on a malformed candidate envelope", () => {
  it.each([
    ["not an object", "42"],
    ["missing results[]", JSON.stringify({ next_cursor: null })],
    ["results not an array", JSON.stringify({ results: {}, next_cursor: null })],
    ["malformed task entry", JSON.stringify({ results: [null], next_cursor: null })],
    ["task missing id", JSON.stringify({ results: [{ content: "x" }], next_cursor: null })],
    ["task non-string id", JSON.stringify({ results: [{ id: 123, content: "x" }], next_cursor: null })],
    ["task empty-string id", JSON.stringify({ results: [{ id: "", content: "x" }], next_cursor: null })],
  ])("%s ⇒ a TransportFailure, never a false page", async (_label, body) => {
    const res = await run(fakeTransport({ response: { status: 200, body } }));
    expect(res.ok).toBe(false); // a TransportFailure, never a false/partial page
  });
});

// ── 3. SSRF/token — Bearer fail-closed + tampered-cursor stays on the allowlisted host
describe("createTodoistHttpTransport — Bearer token fail-closed + SSRF defense-in-depth", () => {
  it("the resolved token rides the Authorization header (never the url/body) — rule 7", async () => {
    const MARKER = "todoist_MARKER_token";
    const t = fakeTransport({ response: { status: 200, body: page(null) } });
    await run(t, REQ, fakeSecrets(ok(MARKER)));
    const sent = t.calls[0]!;
    expect(sent.headers.Authorization).toBe(`Bearer ${MARKER}`);
    expect(sent.url.includes(MARKER)).toBe(false); // token never in the url
    expect(sent.url.startsWith("https://api.todoist.com/api/v1/tasks")).toBe(true);
  });

  it.each([
    ["typed-unavailable secrets", fakeSecrets({ ok: false, error: { reason: "locked" } } as Result<string, SecretUnavailable>)],
    ["THROWING secrets", fakeSecrets(ok(TOKEN), { throw: new Error("keychain TCC denied") })],
  ])("%s ⇒ auth_locked with ZERO dispatch (fail-closed before the fetch)", async (_label, secrets) => {
    const t = fakeTransport({ response: { status: 200, body: page(null) } });
    const res = await run(t, REQ, secrets);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("auth_locked");
    expect(t.calls.length).toBe(0); // no dispatch on an unavailable/throwing token
  });

  it("a tampered/persisted cursor is encoded — it can't smuggle a non-allowlisted authority into the url", async () => {
    const t = fakeTransport({ response: { status: 200, body: page(null) } });
    const nasty = "@evil.example/x?a=b#frag";
    await run(t, { readScope: "data:read", cursor: nasty });
    const sent = t.calls[0]!;
    expect(sent.url.startsWith("https://api.todoist.com/api/v1/tasks")).toBe(true);
    // The authority delimiters are ENCODED — no raw `@host` / `/` breaks out of the query param.
    expect(sent.url.includes("@evil.example")).toBe(false);
    expect(sent.url.includes("evil.example/")).toBe(false);
    expect(sent.url.includes(`cursor=${encodeURIComponent(nasty)}`)).toBe(true);
  });
});

// ── 4. TOTAL never-throws over a hostile transport (L11 + 13.2a NaN-gate) ──────
describe("createTodoistHttpTransport — TOTAL never-throws (redacted typed faults)", () => {
  it.each([
    ["throwing transport", fakeTransport({ throw: new Error("SECRET-in-cause boom") }), "unreachable"],
    ["HTTP 500", fakeTransport({ response: { status: 500, body: "<secret>err</secret>" } }), "unreachable"],
    ["NaN status", fakeTransport({ response: { status: NaN, body: page(null) } }), "unreachable"],
    ["malformed (non-JSON) body", fakeTransport({ response: { status: 200, body: "<<not json>>" } }), "unknown"],
  ])("%s ⇒ a typed fault (never throws), raw cause/body not echoed", async (_label, transport, _code) => {
    const res = await run(transport);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(typeof res.code).toBe("string");
      expect(res.message.includes("SECRET")).toBe(false);
      expect(res.message.includes("<secret>")).toBe(false);
    }
  });
});

// ── 5. connector wiring + emit-only + dormant ────────────────────────────────
describe("todoist read connector — wiring + emit-only (rule 1) + dormant (§ARM-23)", () => {
  it("createTodoistConnector over the transport yields the todoist read ConnectorPort (already exists)", () => {
    const port = createTodoistConnector(createTodoistHttpTransport({ transport: fakeTransport(), secrets: fakeSecrets(), tokenRef: TOKEN_REF }));
    expect(port.connectorId).toBe("todoist");
    expect(typeof port.fetch).toBe("function");
  });

  const src = readFileSync(
    fileURLToPath(new URL("../src/connectors/adapters/todoist.ts", import.meta.url)),
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
      (f): f is string => typeof f === "string" && f.endsWith(".ts") && !f.endsWith("todoist.ts"),
    );
    const callers = files.filter((f) => readFileSync(join(srcRoot, f), "utf8").includes("createTodoistHttpTransport("));
    expect(callers).toEqual([]); // barrel re-exports the NAME, never calls it
  });
});
