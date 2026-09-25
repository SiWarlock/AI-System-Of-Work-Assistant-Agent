// The Linear TEAMS reader — the form proposer's team picker (Linear slice 5a). Grounded on Linear's docs via
// Context7 (2026-09-25), not memory: `query { teams { nodes { id name } } }` over POST https://api.linear.app/graphql,
// a personal key RAW in `Authorization`, Relay pagination (`first`, `pageInfo.hasNextPage`).
//
// ⭐ ONE GUARDED PIPELINE. The reader rides the SAME exchange as the write sender (`guardedHttpExchange`): the SSRF
// guard on the final url, the workspace-scoped key read that fails closed, the key in the header only, redirects
// never followed, the positive-2xx gate, and a body that is parsed, never echoed. A second HTTP client would fork all
// of that (integrations L43).
//
// ⚠ Owner decision 2026-09-25: the team list is read ONLY when Linear writes are on for the workspace. THIS module
// does not decide that — the worker builds the reader only inside its armed branch. These tests pin the reader.
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@sow/contracts";
import { createLinearTeamsReader, LINEAR_TEAMS_PAGE } from "../src/tools/adapters/linear-teams";
import type { HttpTransport, HttpTransportRequest } from "../src/tools/adapters/write-http-transport";
import type { WriteSecretsAccessor } from "../src/tools/adapters/adapter-core";

const WS = "employer-work";
const KEY = "lin_api_TEAMS_FAKE";

function keychain(): WriteSecretsAccessor & { getSecret: ReturnType<typeof vi.fn> } {
  return {
    getSecret: vi.fn(async (ref: string) =>
      ref === `keychain://connector-write.${WS}/linear` ? ok(KEY) : err({ reason: "missing" as const }),
    ),
  };
}
function http(reply: { status: number; body: unknown } | "throw"): HttpTransport & { calls: HttpTransportRequest[] } {
  const calls: HttpTransportRequest[] = [];
  return {
    calls,
    async send(r) {
      calls.push(r);
      if (reply === "throw") throw new Error(`boom ${KEY}`);
      return { status: reply.status, body: typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body) };
    },
  };
}
const TEAMS = { data: { teams: { nodes: [{ id: "t-1", name: "Core" }, { id: "t-2", name: "Mobile" }], pageInfo: { hasNextPage: false } } } };

describe("createLinearTeamsReader — one query, over the guarded write pipeline", () => {
  it("sends ONE POST to api.linear.app/graphql with the key RAW in the header, the teams query and a bounded page", async () => {
    const h = http({ status: 200, body: TEAMS });
    const out = await createLinearTeamsReader({ http: h, secrets: keychain() })(WS);
    expect(out).toEqual({ ok: true, teams: [{ id: "t-1", name: "Core" }, { id: "t-2", name: "Mobile" }], hasMore: false });
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0] as HttpTransportRequest;
    expect(call.url).toBe("https://api.linear.app/graphql");
    expect(call.method).toBe("POST");
    expect(call.redirect).toBe("manual");
    expect(call.headers["Authorization"]).toBe(KEY); // raw personal key, no Bearer
    const doc = JSON.parse(call.body ?? "{}") as { query: string; variables: { first: number } };
    expect(doc.query).toMatch(/^query /); // a query, never a mutation
    expect(doc.query).toContain("teams(first: $first)");
    expect(doc.query).toContain("hasNextPage");
    expect(doc.variables).toEqual({ first: LINEAR_TEAMS_PAGE });
    expect(LINEAR_TEAMS_PAGE).toBe(100);
  });

  it("says when Linear has MORE teams than one page (never a silent cap)", async () => {
    const more = { data: { teams: { nodes: [{ id: "t-1", name: "Core" }], pageInfo: { hasNextPage: true } } } };
    expect(await createLinearTeamsReader({ http: http({ status: 200, body: more }), secrets: keychain() })(WS)).toEqual({
      ok: true,
      teams: [{ id: "t-1", name: "Core" }],
      hasMore: true,
    });
  });

  it("keeps only nodes with a string id and name (the projector narrows further)", async () => {
    const mixed = { data: { teams: { nodes: [{ id: "t-1", name: "Core" }, { id: 7, name: "x" }, { name: "no id" }, null], pageInfo: { hasNextPage: false } } } };
    const out = await createLinearTeamsReader({ http: http({ status: 200, body: mixed }), secrets: keychain() })(WS);
    expect(out).toEqual({ ok: true, teams: [{ id: "t-1", name: "Core" }], hasMore: false });
  });

  it("⛔ an errors[] body is a FAILURE even on HTTP 200 — never an empty team list", async () => {
    const out = await createLinearTeamsReader({ http: http({ status: 200, body: { errors: [{ message: "nope" }], data: { teams: { nodes: [] } } } }), secrets: keychain() })(WS);
    expect(out).toEqual({ ok: false, reason: "rejected" });
  });

  it("a rate limit (HTTP 400 + RATELIMITED, or on a 200) is 'unreachable' — retry later, not 'no'", async () => {
    const limited = { errors: [{ extensions: { code: "RATELIMITED" } }] };
    expect(await createLinearTeamsReader({ http: http({ status: 400, body: limited }), secrets: keychain() })(WS)).toEqual({ ok: false, reason: "unreachable" });
    expect(await createLinearTeamsReader({ http: http({ status: 200, body: limited }), secrets: keychain() })(WS)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("a malformed answer (no teams.nodes, not JSON) is 'malformed' — never an empty list", async () => {
    expect(await createLinearTeamsReader({ http: http({ status: 200, body: { data: {} } }), secrets: keychain() })(WS)).toEqual({ ok: false, reason: "malformed" });
    // ⛔ TOTAL (slice-5a review): `teams: null`, a null body, or nodes that is not an array must not throw.
    for (const body of [{ data: { teams: null } }, { data: null }, null, { data: { teams: { nodes: null } } }]) {
      expect(await createLinearTeamsReader({ http: http({ status: 200, body }), secrets: keychain() })(WS), JSON.stringify(body)).toEqual({ ok: false, reason: "malformed" });
    }
    expect(await createLinearTeamsReader({ http: http({ status: 200, body: "<html>" }), secrets: keychain() })(WS)).toEqual({ ok: false, reason: "malformed" });
  });

  it("a network fault or a 5xx is 'unreachable'; a 401 is 'rejected'", async () => {
    expect(await createLinearTeamsReader({ http: http("throw"), secrets: keychain() })(WS)).toEqual({ ok: false, reason: "unreachable" });
    expect(await createLinearTeamsReader({ http: http({ status: 503, body: "" }), secrets: keychain() })(WS)).toEqual({ ok: false, reason: "unreachable" });
    expect(await createLinearTeamsReader({ http: http({ status: 401, body: "" }), secrets: keychain() })(WS)).toEqual({ ok: false, reason: "rejected" });
  });

  it("⛔ rule 4: no workspace, or a workspace with no key, is refused with ZERO network calls", async () => {
    const h = http({ status: 200, body: TEAMS });
    const read = createLinearTeamsReader({ http: h, secrets: keychain() });
    expect(await read("")).toEqual({ ok: false, reason: "rejected" });
    expect(await read("personal-life")).toEqual({ ok: false, reason: "rejected" });
    expect(h.calls).toHaveLength(0);
  });

  it("⛔ rule 7: no outcome ever carries the key, even when the transport's error names it", async () => {
    for (const reply of ["throw", { status: 401, body: `bad key ${KEY}` }, { status: 200, body: TEAMS }] as const) {
      const out = await createLinearTeamsReader({ http: http(reply), secrets: keychain() })(WS);
      expect(JSON.stringify(out)).not.toContain(KEY);
    }
  });
});
