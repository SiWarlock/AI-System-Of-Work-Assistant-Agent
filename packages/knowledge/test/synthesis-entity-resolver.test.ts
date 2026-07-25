// spec(§6 KN-10, §5 WS-8) — 13.8a EntityResolver, the ⭐ start of the ARC-4 living-vault
// synthesis keystone. Grounds a referenced entity (person/project/concept) to an EXISTING
// canonical vault note path via a WS-8-scoped GBrain read — resolving to a real path,
// deciding a create-stub, or WITHHOLDING (ambiguous/lossy) — and NEVER fabricating a path
// (osb's ground-before-write rule, governed). Pure over an injected read port; TOTAL
// never-throws; fail-closed to withheld. Safety rule 4: never resolves across workspaces.
import { describe, it, expect } from "vitest";
import { ok, err } from "@sow/contracts";
import type { Result, WorkspaceId } from "@sow/contracts";
import {
  resolveEntity,
  type EntityCandidate,
  type EntityGbrainReadPort,
  type EntityReadFault,
  type EntityResolution,
} from "../src/synthesis/entity-resolver";

const WS_A = "ws-a" as WorkspaceId;
const WS_B = "ws-b" as WorkspaceId;

const cand = (o: Partial<EntityCandidate> & Pick<EntityCandidate, "path" | "slug">): EntityCandidate => ({
  workspaceId: WS_A,
  ...o,
});

function fakePort(
  workspaceId: WorkspaceId,
  impl: () => Result<readonly EntityCandidate[], EntityReadFault>,
): EntityGbrainReadPort {
  return { workspaceId, findCandidates: async () => impl() };
}

// ── 1. resolves an EXISTING note (faithful slug / title / alias) ──────────────────

describe("resolveEntity — grounds a referenced entity to an EXISTING note (KN-10)", () => {
  it("resolves_exact_slug_alias_hit_to_real_path — a faithful title match ⇒ the existing note path", async () => {
    const port = fakePort(WS_A, () => ok([cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe" })]));
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "resolved", path: "people/jane-doe.md" });
  });

  it("resolves on an alias match too", async () => {
    const port = fakePort(WS_A, () =>
      ok([cand({ path: "projects/acme-api.md", slug: "acme-api", title: "Acme API", aliases: ["acme"] })]),
    );
    const r = await resolveEntity({ name: "acme", kind: "project" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "resolved", path: "projects/acme-api.md" });
  });

  it("a slug-form ref matches the candidate slug even when the title differs", async () => {
    const port = fakePort(WS_A, () =>
      ok([cand({ path: "projects/acme-api.md", slug: "acme-api", title: "The Acme API Project" })]),
    );
    const r = await resolveEntity({ name: "acme-api", kind: "project" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "resolved", path: "projects/acme-api.md" });
  });

  it("duplicate candidate ROWS for the same note resolve (not a false ambiguous)", async () => {
    // a read adapter that unions slug + title/alias hits can return the same note twice
    const port = fakePort(WS_A, () =>
      ok([
        cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe" }),
        cand({ path: "people/jane-doe.md", slug: "jane-doe", aliases: ["Jane Doe"] }),
      ]),
    );
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "resolved", path: "people/jane-doe.md" });
  });
});

// ── 2. no existing note ⇒ create-stub (distinct from unresolved) ──────────────────

describe("resolveEntity — no existing note ⇒ create-stub decision", () => {
  it("no_note_yields_create_stub_decision — carries the proposed slug for the planner", async () => {
    const port = fakePort(WS_A, () => ok([]));
    const r = await resolveEntity({ name: "New Project X", kind: "project" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "create_stub", proposedSlug: "new-project-x" });
  });
});

// ── 3. ambiguous / lossy ⇒ WITHHELD (never fabricates, never arbitrary-picks) ─────

describe("resolveEntity — withholds, never fabricates or arbitrary-picks (ground-before-write)", () => {
  it("ambiguous_or_lossy_withholds_never_fabricates — 2+ faithful candidates ⇒ withheld(ambiguous)", async () => {
    const port = fakePort(WS_A, () =>
      ok([
        cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe" }),
        cand({ path: "people/jane-doe-2.md", slug: "jane-doe-2", title: "Jane Doe" }),
      ]),
    );
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "ambiguous" });
  });

  it("a lossy collision (C++ vs an existing 'c' note) withholds — never resolved, never stubbed-into-collision", async () => {
    const port = fakePort(WS_A, () => ok([cand({ path: "concepts/c.md", slug: "c", title: "C" })]));
    const r = await resolveEntity({ name: "C++", kind: "concept" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "lossy_match" });
  });

  it("a space↔hyphen-only diff against a slug-only candidate withholds (Q1 safe ruling)", async () => {
    // 'Acme API' would slugify to the existing 'acme-api' but faithfully matches no title/alias
    const port = fakePort(WS_A, () => ok([cand({ path: "projects/acme-api.md", slug: "acme-api" })]));
    const r = await resolveEntity({ name: "Acme API", kind: "project" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "lossy_match" });
  });

  it("a name with no usable slug anchor ⇒ withheld(malformed_entity), no read issued", async () => {
    let called = false;
    const port: EntityGbrainReadPort = {
      workspaceId: WS_A,
      findCandidates: async () => {
        called = true;
        return ok([]);
      },
    };
    const r = await resolveEntity({ name: "   ", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "malformed_entity" });
    expect(called).toBe(false);
  });
});

// ── 4. WS-8 isolation (safety rule 4) — never resolves across workspaces ──────────

describe("resolveEntity — WS-8 isolation: never resolves across workspaces (rule 4)", () => {
  it("ws8_never_resolves_across_workspaces — a port bound to a different ws ⇒ withheld, NO read", async () => {
    let called = false;
    const port: EntityGbrainReadPort = {
      workspaceId: WS_B,
      findCandidates: async () => {
        called = true;
        return ok([cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe", workspaceId: WS_B })]);
      },
    };
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "ws_scope_mismatch" });
    expect(called).toBe(false);
  });

  it("a foreign-workspace candidate is DROPPED, never returned as resolved", async () => {
    // ws-a-scoped port but a hit carries ws-b (a leaked foreign row) → dropped → not resolved
    const port = fakePort(WS_A, () =>
      ok([cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe", workspaceId: WS_B })]),
    );
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r.kind).not.toBe("resolved"); // the foreign path is NEVER resolved
    expect(r).toEqual({ kind: "create_stub", proposedSlug: "jane-doe" }); // dropped ⇒ treated as no note
  });
});

// ── 5. fail-closed to unresolved on any GBrain fault (Lesson 11 TOTAL) ────────────

describe("resolveEntity — fail-closed to withheld on any read fault (Lesson 11 TOTAL)", () => {
  it("gbrain_fault_fails_closed_to_unresolved — a read err ⇒ withheld(gbrain_unavailable)", async () => {
    const port = fakePort(WS_A, () => err({ code: "read_fault" }));
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "gbrain_unavailable" });
  });

  it("a throwing read port never escapes — folds to withheld", async () => {
    const port: EntityGbrainReadPort = {
      workspaceId: WS_A,
      findCandidates: async () => {
        throw new Error("socket hang up");
      },
    };
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "gbrain_unavailable" });
  });

  it("a malformed (non-array) read payload fails closed", async () => {
    const port: EntityGbrainReadPort = {
      workspaceId: WS_A,
      findCandidates: async () => ok("nope" as unknown as readonly EntityCandidate[]),
    };
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "gbrain_unavailable" });
  });

  it("an element whose property access throws folds to withheld (Lesson 11 element-level TOTAL)", async () => {
    // a hostile candidate row whose `slug` getter throws must not escape the resolver
    const hostile = new Proxy({ path: "x.md", slug: "x", workspaceId: WS_A } as EntityCandidate, {
      get(target, prop, recv) {
        if (prop === "slug") throw new Error("boom");
        return Reflect.get(target, prop, recv);
      },
    });
    const port = fakePort(WS_A, () => ok([hostile]));
    const r = await resolveEntity({ name: "Jane Doe", kind: "person" }, WS_A, { gbrain: port });
    expect(r).toEqual({ kind: "withheld", reason: "gbrain_unavailable" });
  });
});
