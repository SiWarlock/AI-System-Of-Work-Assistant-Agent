// SC5b (§13.10 gate a) — the P2 RESULT redactor. The load-bearing WS-8 result guard for the agentic
// Copilot's gbrain tool RESULTS: parse the MCP `{content:[{type:"text",text:"<JSON>"}]}` envelope, drop
// every foreign hit by per-hit slug (reuse SC1 decideHitScope), fold A2 (traverse_graph node+edge filter +
// strip link context), A3 (find_contradictions fail-closed far-side), A4 (strip resolution_command +
// page/title-naming fields; keep severity/axis/confidence). Malformed/unparseable ⇒ drop-all (fail-closed).
// Pure; NEVER throws; NEVER returns null.
import { describe, it, expect } from "vitest";
import { workspaceId } from "@sow/contracts";
import { redactGbrainToolResult } from "../src/copilot-result-redaction";
import type { CopilotWorkspaceScope, WorkspaceScopeRegistry } from "../src/copilot-workspace-scope";

const BUSINESS = workspaceId("personal-business");
const EMPLOYER = workspaceId("employer-work");
const REGISTRY: WorkspaceScopeRegistry = {
  descriptors: [
    { workspaceId: EMPLOYER, slugPrefixes: ["employer-work"] },
    { workspaceId: BUSINESS, slugPrefixes: ["personal-business"] },
  ],
};
// {assign, personal-business}: legacy/unprefixed content is rescued for the served workspace only (the LIVE
// posture on today's single-workspace brain). {deny}: legacy is dropped (fail-closed).
const scope: CopilotWorkspaceScope = { servedWorkspaceId: BUSINESS, registry: REGISTRY, policy: { mode: "assign", toWorkspaceId: BUSINESS } };
const denyScope: CopilotWorkspaceScope = { ...scope, policy: { mode: "deny" } };

/** Build a gbrain MCP result envelope carrying a JSON payload (mirrors the live shape). */
const env = (payload: unknown): unknown => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
/** Parse the redacted output's text payload back to JSON (undefined when the output is an empty envelope). */
function parseOut(out: { readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }> }): unknown {
  const item = out.content.find((c) => c.type === "text" && typeof c.text === "string");
  return item !== undefined ? JSON.parse(item.text as string) : undefined;
}

describe("redactGbrainToolResult — the P2 WS-8 result guard (pure; never returns null/throws)", () => {
  it("fail-closes an UNKNOWN / non-gbrain-read / mutating tool to an empty envelope", () => {
    for (const name of ["mcp__gbrain__put_page", "mcp__gbrain__delete_page", "mcp__vault__read", "not-an-mcp-name", "mcp__gbrain__"]) {
      const r = redactGbrainToolResult(name, env([{ slug: "personal-business/a" }]), scope);
      expect(r.failClosed, name).toBe(true);
      expect(r.cause, name).toBe("UNKNOWN_TOOL");
      expect(r.output.content).toEqual([]); // empty envelope — nothing forwarded
    }
  });

  it("fail-closes a NON-STRING tool name (never throws)", () => {
    for (const bad of [null, undefined, 42, {}, ["mcp__gbrain__query"]]) {
      const r = redactGbrainToolResult(bad, env([]), scope);
      expect(r.failClosed).toBe(true);
      expect(r.cause).toBe("UNKNOWN_TOOL");
    }
  });

  it("fail-closes a MALFORMED envelope (non-object / content not array / no text item)", () => {
    for (const bad of [null, "str", 42, [1, 2], {}, { content: "x" }, { content: [] }, { content: [{ type: "image" }] }, { content: [{ type: "text", text: 5 }] }]) {
      const r = redactGbrainToolResult("mcp__gbrain__query", bad, scope);
      expect(r.failClosed, JSON.stringify(bad)).toBe(true);
      expect(r.cause, JSON.stringify(bad)).toBe("MALFORMED_ENVELOPE");
      expect(r.output.content).toEqual([]);
    }
  });

  it("fail-closes an UNPARSEABLE JSON text payload", () => {
    const r = redactGbrainToolResult("mcp__gbrain__query", { content: [{ type: "text", text: "{not json" }] }, scope);
    expect(r.failClosed).toBe(true);
    expect(r.cause).toBe("UNPARSEABLE_JSON");
    expect(r.output.content).toEqual([]);
  });

  it("fail-closes a search payload that is not a JSON array", () => {
    const r = redactGbrainToolResult("mcp__gbrain__query", env({ not: "an array" }), scope);
    expect(r.failClosed).toBe(true);
    expect(r.cause).toBe("MALFORMED_PAYLOAD");
  });

  // ── F3: independent unscopable-op drop-all (mirrors SC5a M2) ──────────────────────────────────────────
  it("DROPS-ALL an unscopable whole-brain op on a NON-partitioned brain, independent of SC4/SC5a", () => {
    for (const name of ["mcp__gbrain__find_experts", "mcp__gbrain__find_anomalies", "mcp__gbrain__find_orphans", "mcp__gbrain__takes_list", "mcp__gbrain__takes_scorecard", "mcp__gbrain__code_def", "mcp__gbrain__code_flow"]) {
      const r = redactGbrainToolResult(name, env([{ slug: "personal-business/a" }, { slug: "employer-work/x" }]), scope);
      expect(r.failClosed, name).toBe(true);
      expect(r.cause, name).toBe("UNSCOPABLE_TOOL"); // never trusts the generic filter for a whole-brain read
      expect(r.output.content, name).toEqual([]);
    }
  });

  it("PERMITS (server-scoped) an unscopable op on a partitioned brain — the generic per-hit filter then applies", () => {
    const pScope: CopilotWorkspaceScope = { ...scope, brainPartitioned: true };
    const r = redactGbrainToolResult("mcp__gbrain__find_experts", env([{ slug: "personal-business/a" }, { slug: "employer-work/x" }]), pScope);
    expect(r.failClosed).toBe(false);
    expect((parseOut(r.output) as Array<{ slug?: string }>).map((h) => h.slug)).toEqual(["personal-business/a"]);
  });

  // ── search / get_recent_salience — generic per-hit slug filter ──────────────────────────────────────
  const HITS = [
    { slug: "personal-business/a", title: "A", source_id: "default", score: 0.9 },
    { slug: "employer-work/secret", title: "S", source_id: "default", score: 0.8 },
    { slug: "sessions/041", title: "legacy note", source_id: "default", score: 0.5 },
    { title: "no-slug hit", score: 0.4 }, // no slug ⇒ indeterminate ⇒ dropped (fail-closed per-hit)
  ];

  it("search: keeps in-workspace + (under {assign}) legacy hits, drops foreign + slug-less hits", () => {
    const r = redactGbrainToolResult("mcp__gbrain__query", env(HITS), scope);
    expect(r.failClosed).toBe(false);
    const kept = parseOut(r.output) as Array<{ slug?: string }>;
    expect(kept.map((h) => h.slug)).toEqual(["personal-business/a", "sessions/041"]);
    expect(r.dropped).toBe(2);
  });

  it("search under {deny}: legacy is ALSO dropped (fail-closed) — only the attributed in-workspace hit survives", () => {
    const r = redactGbrainToolResult("mcp__gbrain__query", env(HITS), denyScope);
    const kept = parseOut(r.output) as Array<{ slug?: string }>;
    expect(kept.map((h) => h.slug)).toEqual(["personal-business/a"]);
  });

  it("search all-in-workspace: inert — every hit kept, nothing dropped", () => {
    const allIn = [{ slug: "personal-business/a" }, { slug: "personal-business/b" }];
    const r = redactGbrainToolResult("mcp__gbrain__query", env(allIn), scope);
    expect(r.dropped).toBe(0);
    expect(parseOut(r.output)).toEqual(allIn);
  });

  it("get_recent_salience: same generic per-hit filter (defense-in-depth over the pinned slugPrefix arg)", () => {
    const r = redactGbrainToolResult("mcp__gbrain__get_recent_salience", env(HITS), scope);
    const kept = parseOut(r.output) as Array<{ slug?: string }>;
    expect(kept.map((h) => h.slug)).toEqual(["personal-business/a", "sessions/041"]);
  });

  // ── traverse_graph — A2 node + edge filter ──────────────────────────────────────────────────────────
  it("traverse_graph (A2): drops foreign NODES by slug AND filters each kept node's edges + strips link context", () => {
    const nodes = [
      {
        slug: "personal-business/root",
        title: "root",
        depth: 0,
        links: [
          { to: "personal-business/child", link_type: "ref", context: "in-workspace context" },
          { to: "employer-work/leak", link_type: "ref", context: "SECRET foreign context string" },
          { target: "personal-business/via-target", link_type: "ref", context: "keep node, strip context" }, // `target` field variant
        ],
      },
      { slug: "employer-work/foreign-node", title: "foreign", depth: 1, links: [] },
    ];
    const r = redactGbrainToolResult("mcp__gbrain__traverse_graph", env(nodes), scope);
    expect(r.failClosed).toBe(false);
    const kept = parseOut(r.output) as Array<{ slug: string; links: Array<Record<string, unknown>> }>;
    expect(kept.length).toBe(1); // foreign node dropped
    expect(kept[0]!.slug).toBe("personal-business/root");
    expect(r.dropped).toBe(1);
    // foreign-target edge dropped; both in-workspace edges kept (via `to` and `target`); context stripped on ALL kept edges
    expect(kept[0]!.links.map((l) => l["to"] ?? l["target"])).toEqual(["personal-business/child", "personal-business/via-target"]);
    for (const l of kept[0]!.links) expect(l["context"]).toBeUndefined();
  });

  it("traverse_graph: fail-closes a non-array payload", () => {
    expect(redactGbrainToolResult("mcp__gbrain__traverse_graph", env({ nodes: [] }), scope).failClosed).toBe(true);
  });

  it("traverse_graph (F1 fail-OPEN fix): a kept node whose `links` is present-but-NON-array is neutralized to []", () => {
    // links as an OBJECT (not the expected array) that itself embeds a foreign edge + context must NOT pass through.
    const nodes = [{ slug: "personal-business/root", title: "root", links: { to: "employer-work/leak", context: "SECRET foreign body" } }];
    const r = redactGbrainToolResult("mcp__gbrain__traverse_graph", env(nodes), scope);
    const kept = parseOut(r.output) as Array<{ slug: string; links: unknown }>;
    expect(kept.length).toBe(1); // in-workspace node kept…
    expect(kept[0]!.links).toEqual([]); // …but the malformed links blob is dropped, never forwarded
    expect(JSON.stringify(r.output)).not.toContain("employer-work"); // no foreign content anywhere in the output
  });

  it("traverse_graph: a non-object link item is dropped (edgeTarget → '' ⇒ fail-closed)", () => {
    const nodes = [{ slug: "personal-business/root", links: [42, "str", { to: "personal-business/ok" }] }];
    const r = redactGbrainToolResult("mcp__gbrain__traverse_graph", env(nodes), scope);
    const kept = parseOut(r.output) as Array<{ links: Array<Record<string, unknown>> }>;
    expect(kept[0]!.links.length).toBe(1); // only the well-formed in-workspace edge survives
    expect(kept[0]!.links[0]!["to"]).toBe("personal-business/ok");
  });

  // ── find_contradictions — A3 (fail-closed far-side) + A4 (strip naming fields) ───────────────────────
  it("find_contradictions (A3+A4): drops a pair if EITHER side is foreign/unattributable; strips resolution_command + title", () => {
    const payload = {
      contradictions: [
        { a: { slug: "personal-business/x", title: "X" }, b: { slug: "personal-business/y", title: "Y" }, severity: "high", axis: "time", confidence: 0.7, resolution_command: "gbrain resolve personal-business/x" },
        { a: { slug: "personal-business/x" }, b: { slug: "employer-work/z" }, severity: "low", axis: "fact", confidence: 0.2, resolution_command: "gbrain resolve employer-work/z" }, // far side FOREIGN ⇒ drop
        { a: { slug: "personal-business/x" }, b: { page_id: "123", title: "no slug far side" }, severity: "med", axis: "belief", confidence: 0.4 }, // far side UNATTRIBUTABLE ⇒ drop (fail-closed)
      ],
    };
    const r = redactGbrainToolResult("mcp__gbrain__find_contradictions", env(payload), scope);
    expect(r.failClosed).toBe(false);
    const out = parseOut(r.output) as { contradictions: Array<Record<string, unknown>> };
    expect(out.contradictions.length).toBe(1);
    expect(r.dropped).toBe(2);
    const p = out.contradictions[0]!;
    expect(p["severity"]).toBe("high");
    expect(p["axis"]).toBe("time");
    expect(p["confidence"]).toBe(0.7);
    expect(p["resolution_command"]).toBeUndefined(); // A4 stripped
    // sides reduced to opaque in-workspace slug refs (no title / no resolution_command leak)
    expect(p["a"]).toBe("personal-business/x");
    expect(p["b"]).toBe("personal-business/y");
    expect(p["title"]).toBeUndefined();
  });

  it("find_contradictions: sides given as bare slug STRINGS are handled the same way", () => {
    const payload = { contradictions: [{ a: "personal-business/x", b: "personal-business/y", severity: "low", axis: "time", confidence: 0.1 }] };
    const r = redactGbrainToolResult("mcp__gbrain__find_contradictions", env(payload), scope);
    const out = parseOut(r.output) as { contradictions: Array<Record<string, unknown>> };
    expect(out.contradictions.length).toBe(1);
    expect(out.contradictions[0]!["a"]).toBe("personal-business/x");
  });

  it("find_contradictions: fail-closes when contradictions is missing/not an array (incl. a top-level array payload)", () => {
    expect(redactGbrainToolResult("mcp__gbrain__find_contradictions", env({}), scope).failClosed).toBe(true);
    expect(redactGbrainToolResult("mcp__gbrain__find_contradictions", env({ contradictions: "x" }), scope).failClosed).toBe(true);
    expect(redactGbrainToolResult("mcp__gbrain__find_contradictions", env([{ a: "x", b: "y" }]), scope).failClosed).toBe(true);
  });

  it("find_contradictions: a non-object item inside contradictions[] is dropped (fail-closed)", () => {
    const payload = { contradictions: [42, null, "str", { a: "personal-business/x", b: "personal-business/y", severity: "low" }] };
    const r = redactGbrainToolResult("mcp__gbrain__find_contradictions", env(payload), scope);
    const out = parseOut(r.output) as { contradictions: unknown[] };
    expect(out.contradictions.length).toBe(1);
    expect(r.dropped).toBe(3);
  });

  // ── get_timeline — in-workspace seed passthrough (SC5a validated the seed slug); fail-closed on shape ──
  it("get_timeline: passes an array of the in-workspace seed page's entries through; fail-closes a non-array", () => {
    const entries = [{ date: "2026-01-01", summary: "s", detail: "d", source: "note" }];
    const r = redactGbrainToolResult("mcp__gbrain__get_timeline", env(entries), scope);
    expect(r.failClosed).toBe(false);
    expect(parseOut(r.output)).toEqual(entries);
    expect(redactGbrainToolResult("mcp__gbrain__get_timeline", env({ entries }), scope).failClosed).toBe(true);
  });

  // ── purity / invariants ──────────────────────────────────────────────────────────────────────────────
  it("does NOT mutate the caller's result object", () => {
    const nodes = [{ slug: "personal-business/root", links: [{ to: "employer-work/leak", context: "secret" }] }];
    const input = env(nodes);
    const snapshot = JSON.stringify(input);
    redactGbrainToolResult("mcp__gbrain__traverse_graph", input, scope);
    expect(JSON.stringify(input)).toBe(snapshot); // untouched (a copy is produced)
  });

  it("NEVER returns null/undefined and ALWAYS yields a {content:[…]} envelope", () => {
    for (const name of ["mcp__gbrain__query", "mcp__gbrain__traverse_graph", "mcp__gbrain__find_contradictions", "mcp__gbrain__get_timeline", "bad-name"]) {
      const r = redactGbrainToolResult(name, env([]), scope);
      expect(r).not.toBeNull();
      expect(Array.isArray(r.output.content)).toBe(true);
    }
  });
});

// ── F2 FIELD-FIDELITY (gate-(c) closure) — a KEPT in-workspace item is reduced to its OWN-content strings +
//    scalars; every structural foreign-ref carrier (a nested object, an array of refs, a foreign-slug string
//    under a non-allow-listed key, a free-text field beyond the scrubbed `context`) is DROPPED. Schema-agnostic:
//    unknown scalars survive harmlessly, unknown containers/strings drop — so it needs NO pinned gbrain schema.
describe("redactGbrainToolResult — F2 field-fidelity (kept items reduced to own-content + scalars)", () => {
  it("search: a kept hit's foreign-ref CONTAINERS (backlinks array, nested neighbor, related_to string) are STRIPPED; own-content + scalars survive", () => {
    const hit = {
      slug: "personal-business/a",
      title: "A",
      chunk_text: "my in-workspace content",
      score: 0.9, // scalar — kept
      stale: false, // scalar — kept
      backlinks: ["employer-work/secret1", "employer-work/secret2"], // foreign-ref ARRAY → strip
      neighbor: { slug: "employer-work/near", title: "foreign neighbour" }, // nested OBJECT → strip
      related_to: "employer-work/x", // non-allow-listed foreign-ref STRING → strip
      source_id: "default", // non-allow-listed string → strip (not needed downstream)
    };
    const r = redactGbrainToolResult("mcp__gbrain__query", env([hit]), scope);
    expect(r.failClosed).toBe(false);
    const kept = parseOut(r.output) as Array<Record<string, unknown>>;
    expect(kept.length).toBe(1);
    const h = kept[0]!;
    expect(h["slug"]).toBe("personal-business/a");
    expect(h["title"]).toBe("A");
    expect(h["chunk_text"]).toBe("my in-workspace content");
    expect(h["score"]).toBe(0.9);
    expect(h["stale"]).toBe(false);
    // every structural foreign-ref carrier stripped
    expect(h["backlinks"]).toBeUndefined();
    expect(h["neighbor"]).toBeUndefined();
    expect(h["related_to"]).toBeUndefined();
    expect(h["source_id"]).toBeUndefined();
    // no foreign content anywhere in the serialized output
    expect(JSON.stringify(r.output)).not.toContain("employer-work");
  });

  it("get_recent_salience: same field-fidelity reduction (a nested foreign ref cannot ride along on a kept hit)", () => {
    const hit = { slug: "personal-business/a", title: "A", emotional_weight: 0.7, refs: [{ slug: "employer-work/leak" }] };
    const r = redactGbrainToolResult("mcp__gbrain__get_recent_salience", env([hit]), scope);
    const h = (parseOut(r.output) as Array<Record<string, unknown>>)[0]!;
    expect(h["slug"]).toBe("personal-business/a");
    expect(h["emotional_weight"]).toBe(0.7); // scalar kept
    expect(h["refs"]).toBeUndefined(); // foreign-ref array stripped
    expect(JSON.stringify(r.output)).not.toContain("employer-work");
  });

  it("traverse_graph: a kept node's NON-`links` container (backlinks) is stripped; a kept edge's NON-`context` foreign string (snippet) is stripped", () => {
    const nodes = [
      {
        slug: "personal-business/root",
        title: "root",
        depth: 0, // scalar kept
        backlinks: ["employer-work/foreign-backlink"], // node-level foreign ARRAY beyond `links` → strip
        neighbors: [{ slug: "employer-work/n" }], // node-level foreign array of objects → strip
        links: [
          { to: "personal-business/child", link_type: "ref", context: "ctx", snippet: "SECRET quote from employer-work/leak" },
        ],
      },
    ];
    const r = redactGbrainToolResult("mcp__gbrain__traverse_graph", env(nodes), scope);
    expect(r.failClosed).toBe(false);
    const node = (parseOut(r.output) as Array<Record<string, unknown>>)[0]!;
    expect(node["slug"]).toBe("personal-business/root");
    expect(node["depth"]).toBe(0);
    expect(node["backlinks"]).toBeUndefined(); // node-level foreign array stripped (F2)
    expect(node["neighbors"]).toBeUndefined();
    const links = node["links"] as Array<Record<string, unknown>>;
    expect(links.length).toBe(1);
    expect(links[0]!["to"]).toBe("personal-business/child"); // in-workspace target ref kept (canonical `to`)
    expect(links[0]!["context"]).toBeUndefined(); // A2 (already)
    expect(links[0]!["snippet"]).toBeUndefined(); // F2 — non-allow-listed edge free-text stripped
    expect(links[0]!["link_type"]).toBeUndefined(); // F2 — relationship label dropped (safety over fidelity)
    expect(JSON.stringify(r.output)).not.toContain("employer-work");
  });

  it("traverse_graph: an edge with BOTH `to` (in-workspace) and a foreign `target` ALIAS forwards ONLY the validated target (no alias leak)", () => {
    // edgeTarget validates the FIRST target key (`to`); keeping a raw second alias `target` would forward a
    // foreign slug. The canonical re-emit under `to` drops the unvalidated alias.
    const nodes = [
      { slug: "personal-business/root", links: [{ to: "personal-business/child", target: "employer-work/secret-project" }] },
    ];
    const r = redactGbrainToolResult("mcp__gbrain__traverse_graph", env(nodes), scope);
    expect(r.failClosed).toBe(false);
    const node = (parseOut(r.output) as Array<Record<string, unknown>>)[0]!;
    const links = node["links"] as Array<Record<string, unknown>>;
    expect(links.length).toBe(1);
    expect(links[0]!["to"]).toBe("personal-business/child"); // the validated target, canonicalized
    expect(links[0]!["target"]).toBeUndefined(); // the UNVALIDATED foreign alias key is dropped
    expect(JSON.stringify(r.output)).not.toContain("employer-work");
  });

  it("get_timeline: a NON-record entry (bare string / array that could carry a foreign ref) is DROPPED, never forwarded raw", () => {
    const entries = ["employer-work/leak-string", { date: "2026-01-01", summary: "ok" }, ["employer-work/arr"]];
    const r = redactGbrainToolResult("mcp__gbrain__get_timeline", env(entries), scope);
    expect(r.failClosed).toBe(false);
    expect(r.dropped).toBe(2); // the bare string + the array are dropped (non-records)
    const kept = parseOut(r.output) as Array<Record<string, unknown>>;
    expect(kept.length).toBe(1);
    expect(kept[0]!["summary"]).toBe("ok");
    expect(JSON.stringify(r.output)).not.toContain("employer-work");
  });

  it("get_timeline: an entry's foreign-ref CONTAINERS are stripped; own-content (date/summary/detail/source) survives", () => {
    const entries = [
      {
        date: "2026-01-01",
        summary: "s",
        detail: "d",
        source: "note",
        related_pages: ["employer-work/x"], // foreign-ref array → strip
        meta: { ref: "employer-work/y" }, // nested object → strip
      },
    ];
    const r = redactGbrainToolResult("mcp__gbrain__get_timeline", env(entries), scope);
    expect(r.failClosed).toBe(false);
    const e = (parseOut(r.output) as Array<Record<string, unknown>>)[0]!;
    expect(e["date"]).toBe("2026-01-01");
    expect(e["summary"]).toBe("s");
    expect(e["detail"]).toBe("d");
    expect(e["source"]).toBe("note");
    expect(e["related_pages"]).toBeUndefined();
    expect(e["meta"]).toBeUndefined();
    expect(JSON.stringify(r.output)).not.toContain("employer-work");
  });

  it("does not over-strip: an all-scalar-and-own-content hit passes through with all its safe fields", () => {
    const hit = { slug: "personal-business/a", title: "A", chunk_text: "body", summary: "sum", score: 0.5, page_id: 7, chunk_index: 2 };
    const r = redactGbrainToolResult("mcp__gbrain__query", env([hit]), scope);
    const h = (parseOut(r.output) as Array<Record<string, unknown>>)[0]!;
    // own-content strings + all numeric scalars survive (nothing structural to drop)
    expect(h).toEqual({ slug: "personal-business/a", title: "A", chunk_text: "body", summary: "sum", score: 0.5, page_id: 7, chunk_index: 2 });
  });
});
