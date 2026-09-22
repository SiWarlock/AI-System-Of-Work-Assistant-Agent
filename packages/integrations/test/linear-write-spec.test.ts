// The Linear WRITE spec — create / update / existence-probe issues over Linear's GraphQL API.
// Linear slice 2 of 6. Grounded on Linear's own docs via Context7 (2026-09-21), not on memory:
//   • POST https://api.linear.app/graphql; a PERSONAL key goes in RAW (`Authorization: <key>`).
//   • issueCreate(input: IssueCreateInput!) — `teamId` is the one required field; `id` accepts a
//     caller-supplied UUID v4; the payload is `{ success issue { id identifier url } }`.
//   • issueUpdate(id, input) — id is a UUID or a shorthand like "ENG-123".
//   • errors arrive in `errors[]`, possibly on HTTP 200; a RATE LIMIT is HTTP 400 + `RATELIMITED`.
//
// ⭐ TWO DESIGN CHOICES THESE TESTS PIN:
// 1. A STABLE issue id derived from (workspace, canonical key). The create call CARRIES our key, so a
//    retry after a crash cannot mint a second issue — there is no window between "create" and
//    "remember what we created". ⚠ UNVERIFIED LIVE: Linear does not document that it honours a
//    caller-chosen id or rejects a duplicate. Slice 6 checks this against a real team before arming.
// 2. The existence probe is a FILTER query (`issues(filter: {id: {eq: $id}})`), which returns an EMPTY
//    list when absent. A direct `issue(id:)` lookup reports absence as an ERROR whose shape Linear does
//    not document — and a probe that cannot tell "absent" from "failed" either blocks every first
//    create (fail closed forever) or risks a duplicate. An empty list is unambiguous.
import { describe, it, expect } from "vitest";
import { ok } from "@sow/contracts";
import { LINEAR_WRITE_SPEC, linearIssueId } from "../src/tools/adapters/linear-write-spec";
import { createWriteHttpTransport, type HttpTransport, type HttpTransportRequest } from "../src/tools/adapters/write-http-transport";
import type { AdapterTransportRequest } from "../src/tools/adapters/transport";

const WS = "employer-work";
const COK = "cok_linear_abc";

function req(op: AdapterTransportRequest["op"], payload?: Record<string, unknown>): AdapterTransportRequest {
  return { op, targetSystem: "linear", canonicalObjectKey: COK, idempotencyKey: "idem", identity: { issueKey: COK }, workspaceId: WS, ...(payload ? { payload } : {}) };
}
const body = (r: AdapterTransportRequest): { query: string; variables: Record<string, unknown> } =>
  JSON.parse(LINEAR_WRITE_SPEC.buildRequest(r).body ?? "{}") as { query: string; variables: Record<string, unknown> };

describe("linearIssueId — a stable, UUID-v4-shaped id from (workspace, canonical key)", () => {
  it("is deterministic and formatted as UUID v4 (version 4, RFC 4122 variant)", () => {
    const a = linearIssueId(WS, COK);
    expect(a).toBe(linearIssueId(WS, COK));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("differs by workspace AND by key — two workspaces never collide on one id (rule 4)", () => {
    expect(linearIssueId("employer-work", COK)).not.toBe(linearIssueId("personal-life", COK));
    expect(linearIssueId(WS, "cok_a")).not.toBe(linearIssueId(WS, "cok_b"));
  });
});

describe("LINEAR_WRITE_SPEC — wire shape", () => {
  it("targets only https://api.linear.app, POST /graphql, with the raw personal-key header", () => {
    expect(LINEAR_WRITE_SPEC.baseUrl).toBe("https://api.linear.app");
    expect(LINEAR_WRITE_SPEC.allowedHosts).toEqual(["api.linear.app"]);
    expect(LINEAR_WRITE_SPEC.authScheme).toBe("raw");
    const built = LINEAR_WRITE_SPEC.buildRequest(req("query"));
    expect(built.method).toBe("POST");
    expect(built.path).toBe("/graphql");
  });

  it("probes existence with a FILTER query keyed on the stable id", () => {
    const b = body(req("query"));
    expect(b.query).toMatch(/issues\s*\(\s*filter\s*:\s*\{\s*id\s*:\s*\{\s*eq\s*:\s*\$id/);
    expect(b.variables).toEqual({ id: linearIssueId(WS, COK) });
  });

  it("creates with the stable id, teamId, title and description — values in VARIABLES, never in the query text", () => {
    const hostile = 'Fix "}) { __typename } mutation Evil { x } #';
    const b = body(req("create", { teamId: "team_1", title: hostile, description: "Details" }));
    expect(b.query).toMatch(/issueCreate\s*\(\s*input\s*:\s*\$input/);
    expect(b.query).not.toContain("Evil"); // the document is constant; input can never become syntax
    expect(b.variables).toEqual({ input: { id: linearIssueId(WS, COK), teamId: "team_1", title: hostile, description: "Details" } });
  });

  it("⛔ passes NO assignee and NO due date — REQ-F-017 (never invent owners or dates) until a validated source exists", () => {
    // A payload field is candidate data. Until slice 5 gives owner/date an explicit, validated
    // origin, the sender drops them rather than risk writing an invented owner into Linear.
    const b = body(req("create", { teamId: "team_1", title: "T", assigneeId: "user_9", dueDate: "2026-10-01" }));
    const input = b.variables["input"] as Record<string, unknown>;
    expect(input).not.toHaveProperty("assigneeId");
    expect(input).not.toHaveProperty("dueDate");
  });

  it("updates the issue by its stable id, sending only the fields present", () => {
    const b = body(req("update", { title: "New title" }));
    expect(b.query).toMatch(/issueUpdate\s*\(\s*id\s*:\s*\$id\s*,\s*input\s*:\s*\$input/);
    expect(b.variables).toEqual({ id: linearIssueId(WS, COK), input: { title: "New title" } });
  });

  it("⛔ a create with no teamId or no title SENDS NOTHING — it fails as a build error, closed", async () => {
    for (const payload of [{ title: "T" }, { teamId: "team_1" }, { teamId: "", title: "T" }, { teamId: "team_1", title: "   " }]) {
      const calls: HttpTransportRequest[] = [];
      const http: HttpTransport = { async send(r) { calls.push(r); return { status: 200, body: "{}" }; } };
      const res = await createWriteHttpTransport(LINEAR_WRITE_SPEC, { http, secrets: { getSecret: async () => ok("k") } })(req("create", payload));
      expect(res.ok, JSON.stringify(payload)).toBe(false);
      if (!res.ok) expect(res.faultDetail).toBe("request_build_error");
      expect(calls).toHaveLength(0);
    }
  });
});

describe("LINEAR_WRITE_SPEC — reading Linear's replies", () => {
  const map = (op: AdapterTransportRequest["op"], json: unknown) => LINEAR_WRITE_SPEC.mapResponse(200, json, req(op));
  const ISSUE = { id: "uuid-1", identifier: "ENG-7", url: "https://linear.app/acme/issue/ENG-7/title" };

  it("probe: an EMPTY list is a clean MISS; a match is a HIT carrying id, url and identifier", () => {
    expect(map("query", { data: { issues: { nodes: [] } } })).toEqual({ ok: true, object: null });
    expect(map("query", { data: { issues: { nodes: [ISSUE] } } })).toEqual({
      ok: true,
      object: { externalObjectId: "uuid-1", externalUrl: ISSUE.url, rawRef: "ENG-7" },
    });
  });

  it("create/update: success:true with an issue is proof of the write", () => {
    expect(map("create", { data: { issueCreate: { success: true, issue: ISSUE } } }).ok).toBe(true);
    expect(map("update", { data: { issueUpdate: { success: true, issue: ISSUE } } }).ok).toBe(true);
  });

  it("⛔ success:false, a missing issue, or a malformed probe is NEVER success", () => {
    expect(map("create", { data: { issueCreate: { success: false, issue: null } } }).ok).toBe(false);
    expect(map("create", { data: { issueCreate: { success: true } } }).ok).toBe(false);
    expect(map("query", { data: {} }).ok).toBe(false);
    expect(map("query", {}).ok).toBe(false);
  });

  it("⛔ an errors[] array on HTTP 200 fails closed; a rate limit there is retryable, auth is terminal", () => {
    const rl = map("create", { errors: [{ message: "x", extensions: { code: "RATELIMITED" } }], data: null });
    expect(!rl.ok && rl.fault).toBe("unreachable");
    const auth = map("create", { errors: [{ message: "x", extensions: { type: "authentication error" } }] });
    expect(!auth.ok && auth.fault).toBe("rejected");
    const partial = map("query", { errors: [{ message: "x" }], data: { issues: { nodes: [] } } });
    expect(partial.ok).toBe(false); // a partial success is not a clean miss
  });

  it("keeps a malformed url OFF the receipt rather than record an invalid one", () => {
    const res = map("create", { data: { issueCreate: { success: true, issue: { ...ISSUE, url: "not a url" } } } });
    expect(res.ok && res.object?.externalUrl).toBeUndefined();
  });

  it("retryableBody: Linear's HTTP-400 rate limit is retryable (both signals); other errors are not", () => {
    const rb = LINEAR_WRITE_SPEC.retryableBody;
    expect(rb).toBeDefined();
    expect(rb?.(400, { errors: [{ extensions: { code: "RATELIMITED" } }] })).toBe(true);
    expect(rb?.(400, { errors: [{ extensions: { type: "ratelimited" } }] })).toBe(true);
    expect(rb?.(400, { errors: [{ extensions: { code: "INVALID_INPUT" } }] })).toBe(false);
    expect(rb?.(400, "garbage")).toBe(false);
  });
});
