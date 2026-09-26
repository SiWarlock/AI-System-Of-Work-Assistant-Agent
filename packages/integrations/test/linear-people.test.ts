// The Linear PEOPLE reader — who an issue is assigned to (Linear slice 5b.2). Owner decision 2026-09-25: "You, or
// who you name". By default the key's OWN user (`viewer`); if the owner names someone, the worker matches that EXACT
// name against the Linear members. No member list goes to the cloud model: the match runs HERE, in the worker.
//
// Grounded on Linear's docs via Context7 (2026-09-25): `viewer { id name }`, and `users(first, after)` with Relay
// pagination. The filter input's field set was not confirmed, so the match does not depend on it — it pages the
// member list (bounded) and compares locally.
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@sow/contracts";
import { createLinearPeopleReader, LINEAR_MEMBERS_PAGE, LINEAR_MEMBERS_MAX_PAGES } from "../src/tools/adapters/linear-people";
import type { HttpTransport, HttpTransportRequest } from "../src/tools/adapters/write-http-transport";
import type { WriteSecretsAccessor } from "../src/tools/adapters/adapter-core";

const WS = "employer-work";
const KEY = "lin_api_PEOPLE_FAKE";

function keychain(): WriteSecretsAccessor {
  return {
    getSecret: vi.fn(async (ref: string) => (ref === `keychain://connector-write.${WS}/linear` ? ok(KEY) : err({ reason: "missing" as const }))),
  };
}
/** A fake Linear: answers `viewer`, and pages `users` from the given member list. */
function linear(members: { id: string; name: string; displayName?: string; email?: string; active?: boolean }[], opts: { viewer?: unknown; reply?: { status: number; body: unknown } } = {}) {
  const calls: HttpTransportRequest[] = [];
  const http: HttpTransport = {
    async send(r) {
      calls.push(r);
      if (opts.reply !== undefined) return { status: opts.reply.status, body: JSON.stringify(opts.reply.body) };
      const doc = JSON.parse(r.body ?? "{}") as { query: string; variables?: { first?: number; after?: string | null } };
      if (doc.query.includes("viewer")) return { status: 200, body: JSON.stringify(opts.viewer ?? { data: { viewer: { id: "u-me", name: "Owner Person" } } }) };
      const start = doc.variables?.after ? Number(doc.variables.after) : 0;
      const first = doc.variables?.first ?? 50;
      const page = members.slice(start, start + first).map((m) => ({ displayName: m.name, email: `${m.id}@x.test`, active: true, ...m }));
      const next = start + first;
      return {
        status: 200,
        body: JSON.stringify({ data: { users: { nodes: page, pageInfo: { hasNextPage: next < members.length, endCursor: next < members.length ? String(next) : null } } } }),
      };
    },
  };
  return { http, calls };
}

describe("viewer — the default assignee is the key's own Linear user", () => {
  it("reads it with ONE query, the key raw in the header", async () => {
    const l = linear([]);
    expect(await createLinearPeopleReader({ http: l.http, secrets: keychain() }).viewer(WS)).toEqual({ ok: true, user: { id: "u-me", name: "Owner Person" } });
    expect(l.calls).toHaveLength(1);
    expect(l.calls[0]?.url).toBe("https://api.linear.app/graphql");
    expect(l.calls[0]?.headers["Authorization"]).toBe(KEY);
    expect(JSON.parse(l.calls[0]?.body ?? "{}").query).toMatch(/^query /);
  });

  it("a failure is typed, never a guessed user", async () => {
    expect(await createLinearPeopleReader({ http: linear([], { reply: { status: 200, body: { errors: [{ message: "x" }] } } }).http, secrets: keychain() }).viewer(WS)).toEqual({
      ok: false,
      reason: "rejected",
    });
    expect(await createLinearPeopleReader({ http: linear([], { viewer: { data: { viewer: null } } }).http, secrets: keychain() }).viewer(WS)).toEqual({ ok: false, reason: "malformed" });
    expect(await createLinearPeopleReader({ http: linear([], { reply: { status: 503, body: {} } }).http, secrets: keychain() }).viewer(WS)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("⛔ rule 4: a workspace with no key is refused with ZERO network calls", async () => {
    const l = linear([]);
    expect(await createLinearPeopleReader({ http: l.http, secrets: keychain() }).viewer("personal-life")).toEqual({ ok: false, reason: "rejected" });
    expect(l.calls).toHaveLength(0);
  });
});

describe("findMember — the EXACT person the owner named (ignoring case and outer spaces)", () => {
  const people = [
    { id: "u-1", name: "Alex Kim", displayName: "alex", email: "alex.kim@corp.test" },
    { id: "u-2", name: "Sam Lee", displayName: "sam", email: "sam@corp.test" },
    { id: "u-3", name: "Old Timer", displayName: "old", email: "old@corp.test", active: false },
  ];

  it("matches the full name, the display name or the email — exactly, ignoring case", async () => {
    const r = createLinearPeopleReader({ http: linear(people).http, secrets: keychain() });
    for (const q of ["Alex Kim", "  alex kim ", "ALEX", "alex.kim@corp.test"]) {
      expect(await r.findMember(WS, q), q).toEqual({ ok: true, user: { id: "u-1", name: "Alex Kim" } });
    }
  });

  it("⛔ never a partial or fuzzy match — 'Alex' is not 'Alex Kim'", async () => {
    const r = createLinearPeopleReader({ http: linear(people).http, secrets: keychain() });
    expect(await r.findMember(WS, "Alex K")).toEqual({ ok: false, reason: "not_found" });
    expect(await r.findMember(WS, "kim")).toEqual({ ok: false, reason: "not_found" });
  });

  it("ignores a deactivated member", async () => {
    expect(await createLinearPeopleReader({ http: linear(people).http, secrets: keychain() }).findMember(WS, "Old Timer")).toEqual({ ok: false, reason: "not_found" });
  });

  it("two members with that name is 'ambiguous' — the owner must be more precise", async () => {
    const twins = [{ id: "u-a", name: "Chris Park" }, { id: "u-b", name: "Chris Park" }];
    expect(await createLinearPeopleReader({ http: linear(twins).http, secrets: keychain() }).findMember(WS, "Chris Park")).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("⛔ two members with the same name on DIFFERENT pages is still 'ambiguous'", async () => {
    const spread = Array.from({ length: LINEAR_MEMBERS_PAGE + 10 }, (_, i) => ({ id: `u${i}`, name: i === 3 || i === LINEAR_MEMBERS_PAGE + 5 ? "Dana Fox" : `Person ${i}` }));
    expect(await createLinearPeopleReader({ http: linear(spread).http, secrets: keychain() }).findMember(WS, "Dana Fox")).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("pages through the members to the END of the list — every page, not just to the first match", async () => {
    const some = Array.from({ length: LINEAR_MEMBERS_PAGE * 2 + 10 }, (_, i) => ({ id: `u${i}`, name: `Person ${i}` }));
    const r1 = linear(some);
    expect(await createLinearPeopleReader({ http: r1.http, secrets: keychain() }).findMember(WS, `Person ${LINEAR_MEMBERS_PAGE + 3}`)).toEqual({
      ok: true,
      user: { id: `u${LINEAR_MEMBERS_PAGE + 3}`, name: `Person ${LINEAR_MEMBERS_PAGE + 3}` },
    });
    // It reads EVERY page, not just to the first match — otherwise a same-named member on a later page could never be
    // seen, and "ambiguous" could not be told apart from a unique match.
    expect(r1.calls).toHaveLength(3);
  });

  it("⛔ a list longer than the cap is 'too_many_members' — even with ONE match, since a same-named person may be unread", async () => {
    // Review 2026-09-25 (measured): the cap is 4 x 250; a second "Dana Fox" past it was never seen, and the first one
    // was returned as if unique. The card shows only a name, so the owner could not tell (REQ-F-017).
    const cap = LINEAR_MEMBERS_PAGE * LINEAR_MEMBERS_MAX_PAGES;
    const many = Array.from({ length: cap + 5 }, (_, i) => ({ id: `u${i}`, name: i === 3 || i === cap + 2 ? "Dana Fox" : `Person ${i}` }));
    const r1 = linear(many);
    expect(await createLinearPeopleReader({ http: r1.http, secrets: keychain() }).findMember(WS, "Dana Fox")).toEqual({ ok: false, reason: "too_many_members" });
    expect(r1.calls).toHaveLength(LINEAR_MEMBERS_MAX_PAGES); // bounded — never an unbounded crawl
    const r2 = linear(many);
    expect(await createLinearPeopleReader({ http: r2.http, secrets: keychain() }).findMember(WS, "Nobody Here")).toEqual({ ok: false, reason: "too_many_members" });
  });

  it("an exact EMAIL match is used even when the list is unfinished — an email is unique in a Linear org", async () => {
    // Critic 2026-09-25 (measured): past the cap, even a unique email was refused, and the refusal told the model to
    // ask for the exact email — a dead end for any org over 1,000 members.
    const cap = LINEAR_MEMBERS_PAGE * LINEAR_MEMBERS_MAX_PAGES;
    const many = Array.from({ length: cap + 5 }, (_, i) => ({ id: `u${i}`, name: i === cap + 2 ? "Dana Fox" : i === 3 ? "Dana Fox" : `Person ${i}` }));
    expect(await createLinearPeopleReader({ http: linear(many).http, secrets: keychain() }).findMember(WS, "U3@x.test")).toEqual({
      ok: true,
      user: { id: "u3", name: "Dana Fox" },
    });
  });

  it("⛔ an email match wins over a member whose NAME is set to that email — the email is the identity", async () => {
    const people = [
      { id: "u-real", name: "Sam Lee", displayName: "sam", email: "sam@corp.test" },
      { id: "u-fake", name: "sam@corp.test", displayName: "sam@corp.test", email: "fake@corp.test" },
    ];
    expect(await createLinearPeopleReader({ http: linear(people).http, secrets: keychain() }).findMember(WS, "sam@corp.test")).toEqual({
      ok: true,
      user: { id: "u-real", name: "Sam Lee" },
    });
  });

  it("⛔ a page that says 'more' but gives no cursor is an INCOMPLETE list — never read as the end", async () => {
    const page = { data: { users: { nodes: [{ id: "u1", name: "Dana Fox", active: true }], pageInfo: { hasNextPage: true, endCursor: null } } } };
    const http: HttpTransport = { send: async () => ({ status: 200, body: JSON.stringify(page) }) };
    const r = createLinearPeopleReader({ http, secrets: keychain() });
    expect(await r.findMember(WS, "Dana Fox")).toEqual({ ok: false, reason: "too_many_members" });
    expect(await r.findMember(WS, "Nobody Here")).toEqual({ ok: false, reason: "too_many_members" });
  });

  it("a blank name matches nobody, with ZERO network calls", async () => {
    const l = linear(people);
    expect(await createLinearPeopleReader({ http: l.http, secrets: keychain() }).findMember(WS, "   ")).toEqual({ ok: false, reason: "not_found" });
    expect(l.calls).toHaveLength(0);
  });

  it("⛔ the name the owner typed is never sent to Linear — the match is local; the query text is constant", async () => {
    const l = linear(people);
    await createLinearPeopleReader({ http: l.http, secrets: keychain() }).findMember(WS, "Alex Kim");
    for (const c of l.calls) expect(c.body ?? "").not.toContain("Alex Kim");
  });

  it("⛔ rule 7: no outcome carries the key; a failed page is a typed failure", async () => {
    const r = await createLinearPeopleReader({ http: linear(people, { reply: { status: 401, body: { message: KEY } } }).http, secrets: keychain() }).findMember(WS, "Alex Kim");
    expect(r).toEqual({ ok: false, reason: "rejected" });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});
