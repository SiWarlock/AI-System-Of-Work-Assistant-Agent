// SC5a (§13.10 gate a) — the P2 arg policer. The load-bearing WS-8 arg guard for the agentic Copilot's
// gbrain tool calls: deny scope-WIDENING (source_id='__all__' / all_sources), deny a FOREIGN seed slug
// (traverse_graph/get_timeline), force the served workspace's scope where an arg allows it, deny unknown/
// non-read tools + malformed args. Pure; NEVER returns null.
import { describe, it, expect } from "vitest";
import { workspaceId, sourceId } from "@sow/contracts";
import { policeGbrainToolArgs } from "../src/copilot-arg-policy";
import type { CopilotWorkspaceScope, WorkspaceScopeRegistry } from "../src/copilot-workspace-scope";

const BUSINESS = workspaceId("personal-business");
const REGISTRY: WorkspaceScopeRegistry = {
  descriptors: [
    { workspaceId: workspaceId("employer-work"), slugPrefixes: ["employer-work"] },
    { workspaceId: BUSINESS, slugPrefixes: ["personal-business"] },
  ],
};
const scope: CopilotWorkspaceScope = {
  servedWorkspaceId: BUSINESS,
  registry: REGISTRY,
  policy: { mode: "assign", toWorkspaceId: BUSINESS },
};
const denyScope: CopilotWorkspaceScope = { ...scope, policy: { mode: "deny" } };

describe("policeGbrainToolArgs — the P2 WS-8 arg guard (pure; never returns null)", () => {
  it("denies an UNKNOWN / non-gbrain-read / mutating tool", () => {
    expect(policeGbrainToolArgs("mcp__gbrain__put_page", {}, scope)).toMatchObject({ decision: "deny", cause: "UNKNOWN_TOOL_DENIED" });
    expect(policeGbrainToolArgs("mcp__gbrain__delete_page", {}, scope)).toMatchObject({ decision: "deny", cause: "UNKNOWN_TOOL_DENIED" });
    expect(policeGbrainToolArgs("mcp__other__x", {}, scope)).toMatchObject({ decision: "deny", cause: "UNKNOWN_TOOL_DENIED" });
    expect(policeGbrainToolArgs("not-an-mcp-name", {}, scope)).toMatchObject({ decision: "deny", cause: "UNKNOWN_TOOL_DENIED" });
    expect(policeGbrainToolArgs("mcp__gbrain__", {}, scope)).toMatchObject({ decision: "deny", cause: "UNKNOWN_TOOL_DENIED" });
  });

  it("denies malformed (non-object / array / null) input", () => {
    for (const bad of [null, "str", [1, 2], 42, undefined]) {
      expect(policeGbrainToolArgs("mcp__gbrain__query", bad, scope)).toMatchObject({
        decision: "deny",
        cause: "MALFORMED_ARGS_DENIED",
      });
    }
  });

  it("denies source_id scope-WIDENING on a scopable tool — including type/case variants (M1)", () => {
    for (const bad of ["__all__", "__ALL__", " __all__ ", ["__all__"], { any: 1 }, 42]) {
      expect(policeGbrainToolArgs("mcp__gbrain__query", { query: "q", source_id: bad }, scope), `source_id=${JSON.stringify(bad)}`).toMatchObject({
        decision: "deny",
        cause: "SCOPE_WIDENING_DENIED",
      });
    }
  });

  it("denies all_sources scope-WIDENING (truthy variants) — checked on a partitioned brain where code_* is permitted (M1)", () => {
    const pScope: CopilotWorkspaceScope = { ...scope, brainPartitioned: true };
    for (const v of [true, "true", 1, "1", "yes", "on"]) {
      expect(policeGbrainToolArgs("mcp__gbrain__code_def", { symbol: "X", all_sources: v }, pScope), `all_sources=${JSON.stringify(v)}`).toMatchObject({
        decision: "deny",
        cause: "SCOPE_WIDENING_DENIED",
      });
    }
  });

  it("neutralizes a benign-but-scoped-default all_sources=false and a model source_id (deleted when no descriptor source)", () => {
    const r = policeGbrainToolArgs("mcp__gbrain__query", { query: "q", all_sources: false, source_id: "some-other-source" }, scope);
    expect(r.decision).toBe("allow");
    if (r.decision === "allow") {
      expect(r.updatedInput["all_sources"]).toBeUndefined(); // deleted
      expect(r.updatedInput["source_id"]).toBeUndefined(); // model cannot pick a source on a non-partitioned brain
    }
  });

  it("M2: DENIES the unscopable whole-brain tools on a non-partitioned brain, independent of the allow-list", () => {
    for (const name of ["mcp__gbrain__find_experts", "mcp__gbrain__find_anomalies", "mcp__gbrain__find_orphans", "mcp__gbrain__takes_scorecard", "mcp__gbrain__takes_list", "mcp__gbrain__code_def", "mcp__gbrain__code_flow"]) {
      expect(policeGbrainToolArgs(name, {}, scope), name).toMatchObject({ decision: "deny", cause: "UNSCOPABLE_TOOL_DENIED" });
    }
  });

  it("M2: PERMITS the unscopable tools on a partitioned brain (the server scopes the computation)", () => {
    const pScope: CopilotWorkspaceScope = { ...scope, brainPartitioned: true };
    expect(policeGbrainToolArgs("mcp__gbrain__find_experts", { topic: "x" }, pScope).decision).toBe("allow");
    expect(policeGbrainToolArgs("mcp__gbrain__code_def", { symbol: "X" }, pScope).decision).toBe("allow");
  });

  it("traverse_graph/get_timeline: a FOREIGN seed slug is DENIED; a served/legacy seed is allowed", () => {
    expect(policeGbrainToolArgs("mcp__gbrain__traverse_graph", { slug: "employer-work/x", depth: 1 }, scope)).toMatchObject({
      decision: "deny",
      cause: "FOREIGN_SEED_DENIED",
    });
    expect(policeGbrainToolArgs("mcp__gbrain__traverse_graph", { slug: "personal-business/x", depth: 1 }, scope).decision).toBe("allow");
    // a legacy (unprefixed) seed is KEPT under {assign,served}…
    expect(policeGbrainToolArgs("mcp__gbrain__get_timeline", { slug: "sessions/041" }, scope).decision).toBe("allow");
    // …but DENIED under {deny} (fail-closed)
    expect(policeGbrainToolArgs("mcp__gbrain__get_timeline", { slug: "sessions/041" }, denyScope)).toMatchObject({
      decision: "deny",
      cause: "FOREIGN_SEED_DENIED",
    });
    // a missing/malformed seed slug ⇒ indeterminate ⇒ denied (fail-closed)
    expect(policeGbrainToolArgs("mcp__gbrain__traverse_graph", { depth: 1 }, scope)).toMatchObject({
      decision: "deny",
      cause: "FOREIGN_SEED_DENIED",
    });
    expect(policeGbrainToolArgs("mcp__gbrain__traverse_graph", { slug: "../employer-work/x" }, scope)).toMatchObject({
      decision: "deny",
      cause: "FOREIGN_SEED_DENIED",
    });
  });

  it("get_recent_salience: FORCES slugPrefix to the served workspace's prefix (overriding a model value)", () => {
    const r = policeGbrainToolArgs("mcp__gbrain__get_recent_salience", { slugPrefix: "employer-work", days: 7 }, scope);
    expect(r.decision).toBe("allow");
    if (r.decision === "allow") {
      expect(r.updatedInput["slugPrefix"]).toBe("personal-business");
      expect(r.updatedInput["days"]).toBe(7); // other args preserved
    }
  });

  it("query: pins source_id to the served descriptor's sourceId when present (Phase B)", () => {
    const reg: WorkspaceScopeRegistry = {
      descriptors: [{ workspaceId: BUSINESS, slugPrefixes: ["personal-business"], sourceId: sourceId("src-b") }],
    };
    const r = policeGbrainToolArgs("mcp__gbrain__query", { query: "q" }, { servedWorkspaceId: BUSINESS, registry: reg, policy: { mode: "deny" } });
    expect(r.decision).toBe("allow");
    if (r.decision === "allow") expect(r.updatedInput["source_id"]).toBe("src-b");
  });

  it("find_contradictions: best-effort pins its slug substring to the served prefix when the model omits it", () => {
    const r = policeGbrainToolArgs("mcp__gbrain__find_contradictions", { limit: 5 }, scope);
    expect(r.decision).toBe("allow");
    if (r.decision === "allow") expect(r.updatedInput["slug"]).toBe("personal-business");
  });

  it("find_contradictions: a MODEL-supplied slug is left as-is (the redactor's A3 fail-closed far-side is the guarantee)", () => {
    const r = policeGbrainToolArgs("mcp__gbrain__find_contradictions", { slug: "employer-work" }, scope);
    expect(r.decision).toBe("allow");
    if (r.decision === "allow") expect(r.updatedInput["slug"]).toBe("employer-work"); // NOT overridden — redactor drops foreign pairs
  });

  it("get_recent_salience: with an AMBIGUOUS (>1) served prefix, the model slugPrefix is NOT forced (left to the redactor)", () => {
    const reg: WorkspaceScopeRegistry = {
      descriptors: [{ workspaceId: BUSINESS, slugPrefixes: ["personal-business", "pb-alt"] }],
    };
    const r = policeGbrainToolArgs("mcp__gbrain__get_recent_salience", { slugPrefix: "whatever" }, { servedWorkspaceId: BUSINESS, registry: reg, policy: { mode: "deny" } });
    expect(r.decision).toBe("allow");
    if (r.decision === "allow") expect(r.updatedInput["slugPrefix"]).toBe("whatever"); // ambiguous prefix ⇒ unforced
  });

  it("a NON-STRING tool name is denied (never throws)", () => {
    for (const bad of [null, undefined, 42, {}, ["mcp__gbrain__query"]]) {
      expect(policeGbrainToolArgs(bad, {}, scope)).toMatchObject({ decision: "deny", cause: "UNKNOWN_TOOL_DENIED" });
    }
  });

  it("a normal query is allowed, preserves the input, and does NOT mutate the caller's object", () => {
    const input = { query: "hello", limit: 5 };
    const r = policeGbrainToolArgs("mcp__gbrain__query", input, scope);
    expect(r.decision).toBe("allow");
    if (r.decision === "allow") {
      expect(r.updatedInput["query"]).toBe("hello");
      expect(r.updatedInput["limit"]).toBe(5);
    }
    expect(input).toEqual({ query: "hello", limit: 5 }); // caller's object untouched (a copy is returned)
  });

  it("NEVER returns null/undefined — always a typed allow|deny", () => {
    for (const name of ["mcp__gbrain__query", "mcp__gbrain__find_experts", "mcp__gbrain__code_flow", "mcp__gbrain__traverse_graph", "bad-name"]) {
      const r = policeGbrainToolArgs(name, {}, scope);
      expect(r).not.toBeNull();
      expect(["allow", "deny"]).toContain(r.decision);
    }
  });
});
