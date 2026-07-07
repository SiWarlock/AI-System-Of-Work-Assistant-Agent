// spec(§5/§7) — Phase-C C1: the Copilot tool catalog + `isMutatingCopilotTool` classifier that closes the
// ING-7 arch_gap. `admitJob`/`admitsMutating` accept an INJECTED `isMutatingTool` predicate but nothing
// supplied one (ToolId is an open branded string, no catalog). This suite pins the catalog, the fail-safe
// classifier, the two Copilot tool policies, the read_only-purity check (the deferred "read_only ⇒ no
// mutating tool" clause), and the ING-7 admission payoff (untrusted + a write-proposing tool → HARD REJECT).
import { describe, it, expect } from "vitest";
import { AgentJobSchema, toolId } from "@sow/contracts";
import type { AgentJob, ToolPolicy } from "@sow/contracts";
import { admitJob } from "../src/admission";
import { admitsMutating } from "../src/tool-policy";
import { isAllow, isDeny } from "../src/decision";
import {
  COPILOT_READ_TOOLS,
  COPILOT_PROPOSE_TOOL,
  isMutatingCopilotTool,
  copilotReadToolPolicy,
  copilotAgentToolPolicy,
  copilotReadOnlyPolicyIsPure,
  copilotReadToolIds,
  copilotToolScopingClass,
  copilotScopedReadToolIds,
  COPILOT_TOOL_SCOPING,
} from "../src/copilot-tool-catalog";

/** A Copilot AgentJob with the given tool policy + trust level (reuses the proven admission.test shape). */
function job(toolPolicy: ToolPolicy, trustLevel: "trusted" | "untrusted"): AgentJob {
  return AgentJobSchema.parse({
    id: "job-1",
    workflowRunId: "wf-1",
    workspaceId: "ws-employer",
    capability: "meeting_closeout",
    contextRefs: [{ refKind: "source_envelope", ref: "src-1" }],
    outputSchemaId: "sow:knowledge-mutation-plan",
    toolPolicy,
    providerRoute: {
      provider: "claude",
      model: "claude-sonnet-5",
      endpoint: "https://api.anthropic.com",
      egressClass: "cloud",
    },
    trustLevel,
    carriesRawContent: false,
    maxRuntimeSeconds: 180,
    maxCostUsd: 2.5,
    idempotencyKey: "job-1-key",
  });
}

describe("isMutatingCopilotTool — the fail-safe classifier", () => {
  it("classifies every read tool as NON-mutating", () => {
    for (const spec of COPILOT_READ_TOOLS) {
      expect(spec.mutating).toBe(false);
      expect(isMutatingCopilotTool(spec.id)).toBe(false);
    }
  });
  it("classifies the write-proposing tool as mutating", () => {
    expect(COPILOT_PROPOSE_TOOL.mutating).toBe(true);
    expect(isMutatingCopilotTool(COPILOT_PROPOSE_TOOL.id)).toBe(true);
  });
  it("FAIL-SAFE: an UNKNOWN tool is treated as mutating (an untrusted job holding it is refused)", () => {
    expect(isMutatingCopilotTool(toolId("something.unknown"))).toBe(true);
    expect(isMutatingCopilotTool(toolId("filesystem.write"))).toBe(true);
  });
  it("includes the gbrain read surface + a vault read", () => {
    const ids = COPILOT_READ_TOOLS.map((s) => String(s.id));
    expect(ids).toContain("gbrain.search");
    expect(ids).toContain("gbrain.traverse_graph");
    expect(ids).toContain("vault.read");
  });
  it("the specs are FROZEN — a mutating tool can't be silently downgraded at runtime", () => {
    expect(Object.isFrozen(COPILOT_PROPOSE_TOOL)).toBe(true);
    expect(Object.isFrozen(COPILOT_READ_TOOLS)).toBe(true);
    expect(COPILOT_READ_TOOLS.every((s) => Object.isFrozen(s))).toBe(true);
    // a downgrade attempt is a no-op (frozen); the classifier still reports mutating
    try {
      (COPILOT_PROPOSE_TOOL as { mutating: boolean }).mutating = false;
    } catch {
      /* strict mode may throw; either way the value is unchanged */
    }
    expect(isMutatingCopilotTool(COPILOT_PROPOSE_TOOL.id)).toBe(true);
  });
});

describe("copilotReadToolPolicy / copilotAgentToolPolicy", () => {
  it("the read policy is read_only, non-mutating, over the read tools", () => {
    const p = copilotReadToolPolicy();
    expect(p.mode).toBe("read_only");
    expect(p.allowsMutating).toBe(false);
    expect(p.allowedTools.map(String)).toEqual(COPILOT_READ_TOOLS.map((s) => String(s.id)));
    // admitsMutating (with the catalog) agrees it admits no mutation
    expect(admitsMutating(p, isMutatingCopilotTool)).toBe(false);
  });
  it("the agent policy is scoped_write and includes the write-proposing tool", () => {
    const p = copilotAgentToolPolicy();
    expect(p.mode).toBe("scoped_write");
    expect(p.allowsMutating).toBe(true);
    expect(p.allowedTools.map(String)).toContain(String(COPILOT_PROPOSE_TOOL.id));
    expect(admitsMutating(p, isMutatingCopilotTool)).toBe(true);
  });
});

describe("copilotReadOnlyPolicyIsPure — closes the deferred 'read_only ⇒ no mutating tool' clause", () => {
  it("the read policy is pure (no mutating tool listed)", () => {
    expect(copilotReadOnlyPolicyIsPure(copilotReadToolPolicy())).toBe(true);
  });
  it("catches a read_only policy that SECRETLY lists a mutating tool (admitsMutating can't see it)", () => {
    // read_only + allowsMutating:false is construction-consistent, yet it lists the write-proposing tool.
    const smuggled: ToolPolicy = {
      mode: "read_only",
      allowedTools: [COPILOT_PROPOSE_TOOL.id],
      deniedTools: [],
      allowsMutating: false,
    };
    expect(admitsMutating(smuggled, isMutatingCopilotTool)).toBe(false); // read_only early-return blinds it
    expect(copilotReadOnlyPolicyIsPure(smuggled)).toBe(false); // the classifier catches it
  });
  it("deny wins: a mutating tool that is also DENIED does not make a read_only policy impure", () => {
    const p: ToolPolicy = {
      mode: "read_only",
      allowedTools: [COPILOT_PROPOSE_TOOL.id],
      deniedTools: [COPILOT_PROPOSE_TOOL.id],
      allowsMutating: false,
    };
    expect(copilotReadOnlyPolicyIsPure(p)).toBe(true);
  });
  it("a scoped_write policy is vacuously pure at this level (allowed to hold mutating tools)", () => {
    expect(copilotReadOnlyPolicyIsPure(copilotAgentToolPolicy())).toBe(true);
  });
});

describe("ING-7 payoff — admitJob(job, isMutatingCopilotTool) gates the Copilot's tools", () => {
  it("UNTRUSTED Copilot + read policy → ADMITTED (read-only, no mutation)", () => {
    const d = admitJob(job(copilotReadToolPolicy(), "untrusted"), isMutatingCopilotTool);
    expect(isAllow(d)).toBe(true);
  });
  it("UNTRUSTED Copilot + agent policy (write-proposing) → HARD REJECT (ING-7)", () => {
    const d = admitJob(job(copilotAgentToolPolicy(), "untrusted"), isMutatingCopilotTool);
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("UNTRUSTED_CONTENT_MUTATING_TOOL");
  });
  it("TRUSTED Copilot + agent policy → ADMITTED (trusted content may propose writes)", () => {
    const d = admitJob(job(copilotAgentToolPolicy(), "trusted"), isMutatingCopilotTool);
    expect(isAllow(d)).toBe(true);
  });
});

describe("Tier-1 §13.10 — the gbrain conflict/gap-detection analysis read tools", () => {
  const ANALYSIS_IDS = ["gbrain.find_contradictions", "gbrain.find_anomalies", "gbrain.find_orphans"];

  it("catalogs the 3 tools as NON-mutating, FROZEN read tools that ride into the read policy", () => {
    const ids = COPILOT_READ_TOOLS.map((s) => String(s.id));
    for (const id of ANALYSIS_IDS) {
      expect(ids).toContain(id);
      const spec = COPILOT_READ_TOOLS.find((s) => String(s.id) === id);
      expect(spec?.mutating).toBe(false);
      expect(isMutatingCopilotTool(toolId(id))).toBe(false); // catalog-known, not fail-safe-mutating
      expect(Object.isFrozen(spec)).toBe(true);
    }
    // they ride into the read_only policy — so a read_only Copilot job may hold them, and the surface stays pure.
    expect(copilotReadToolPolicy().allowedTools.map(String)).toEqual(expect.arrayContaining(ANALYSIS_IDS));
    expect(copilotReadOnlyPolicyIsPure(copilotReadToolPolicy())).toBe(true);
  });

  it("DRIFT-LOCK: every gbrain.* read tool maps to a known-READ op (fail-CLOSED allowlist)", () => {
    // The fail-safe classifier only catches UNKNOWN ids; this guards a future KNOWN-but-mislabeled entry
    // (mutating:false accidentally set on a genuinely mutating gbrain op — e.g. `think` which can `save`,
    // or `sync_brain`) from silently entering the read surface. An ALLOWLIST (not a denylist of mutating ops)
    // is fail-closed: an unrecognized/renamed gbrain op fails this test and FORCES a human read-vs-write
    // review before it can be cataloged as a read. Source of truth for read-ness: the live gbrain MCP tool
    // surface + memory `sow-copilot-skill-catalog` — adding a gbrain.* read tool MUST add its op here.
    const KNOWN_GBRAIN_READ_OPS = new Set([
      // search (→ the live `query` tool) + the two live graph/history reads. The one-time phantom cleanup
      // (§13.10 go-live gate d, verified against gbrain v0.35.1's per-op scope classes): graph/timeline were
      // renamed to the REAL MCP tool names traverse_graph/get_timeline; schema_read + contained_synthesis
      // had NO live MCP tool; health maps to get_health which requires ADMIN scope (unreachable for the
      // read-scoped DCR client) — all three pruned. ADMIN-scoped ops do NOT belong here even though they
      // don't mutate: a catalog entry the served client can never invoke is a phantom allow-list entry.
      "search", "traverse_graph", "get_timeline",
      "find_contradictions", "find_anomalies", "find_orphans",
      // expertise + takes (calibration memory) + code-intelligence — all verified pure reads against the live
      // gbrain MCP schemas. code_traversal_cache_clear is DELIBERATELY absent (destructive cache op, D8-guarded).
      "find_experts",
      "takes_list", "takes_search", "takes_scorecard", "takes_calibration",
      "code_def", "code_refs", "code_callers", "code_callees", "code_flow", "code_blast",
      "get_recent_salience", // resume-context recency read (get_recent_transcripts is EXCLUDED — local-only)
    ]);
    for (const spec of COPILOT_READ_TOOLS) {
      const raw = String(spec.id);
      if (!raw.startsWith("gbrain.")) continue;
      const op = raw.slice("gbrain.".length);
      expect(KNOWN_GBRAIN_READ_OPS.has(op)).toBe(true); // unknown gbrain op ⇒ RED ⇒ forced review
    }
  });
});

describe("Tier-1 §13.10 — the expertise / calibration / code-intelligence read tools", () => {
  const READ_IDS = [
    "gbrain.find_experts",
    "gbrain.takes_list", "gbrain.takes_search", "gbrain.takes_scorecard", "gbrain.takes_calibration",
    "gbrain.code_def", "gbrain.code_refs", "gbrain.code_callers", "gbrain.code_callees", "gbrain.code_flow", "gbrain.code_blast",
  ];

  it("catalogs all 11 as NON-mutating, FROZEN read tools that ride into the read policy", () => {
    const ids = COPILOT_READ_TOOLS.map((s) => String(s.id));
    for (const id of READ_IDS) {
      expect(ids).toContain(id);
      const spec = COPILOT_READ_TOOLS.find((s) => String(s.id) === id);
      expect(spec?.mutating).toBe(false);
      expect(isMutatingCopilotTool(toolId(id))).toBe(false);
      expect(Object.isFrozen(spec)).toBe(true);
    }
    expect(copilotReadToolPolicy().allowedTools.map(String)).toEqual(expect.arrayContaining(READ_IDS));
    expect(copilotReadOnlyPolicyIsPure(copilotReadToolPolicy())).toBe(true);
  });

  it("catalogs gbrain.get_recent_salience (recency read) but EXCLUDES local-only get_recent_transcripts", () => {
    const ids = COPILOT_READ_TOOLS.map((s) => String(s.id));
    // salience is a servable read (works over the http MCP transport).
    expect(ids).toContain("gbrain.get_recent_salience");
    expect(isMutatingCopilotTool(toolId("gbrain.get_recent_salience"))).toBe(false);
    // get_recent_transcripts is LOCAL-ONLY (rejects remote MCP/http callers with permission_denied) — cataloging
    // it would be a dead allow-list entry for the served (http) agent; deliberately excluded.
    expect(ids).not.toContain("gbrain.get_recent_transcripts");
  });

  it("EXCLUDES the destructive gbrain.code_traversal_cache_clear (fail-safe ⇒ mutating)", () => {
    // code_traversal_cache_clear wipes the code_blast/code_flow traversal cache (a D8 destructive-guarded op).
    // It is NOT cataloged, so the fail-safe classifier treats it as mutating — a read_only job can never hold it.
    const ids = COPILOT_READ_TOOLS.map((s) => String(s.id));
    expect(ids).not.toContain("gbrain.code_traversal_cache_clear");
    expect(isMutatingCopilotTool(toolId("gbrain.code_traversal_cache_clear"))).toBe(true);
  });
});

describe("§13.10 go-live gate (d) — phantom-name cleanup (verified against gbrain v0.35.1)", () => {
  const PRUNED_PHANTOMS = [
    "gbrain.graph", // renamed → gbrain.traverse_graph (the real MCP tool name)
    "gbrain.timeline", // renamed → gbrain.get_timeline (the real MCP tool name)
    "gbrain.schema_read", // NO such live MCP tool
    "gbrain.contained_synthesis", // NO such live MCP tool
    "gbrain.health", // the real op get_health requires ADMIN scope — unreachable for the read-scoped client
  ];

  it("the 5 phantom ids are GONE from the catalog and fall back to fail-safe-mutating", () => {
    const ids = COPILOT_READ_TOOLS.map((s) => String(s.id));
    for (const phantom of PRUNED_PHANTOMS) {
      expect(ids).not.toContain(phantom);
      expect(isMutatingCopilotTool(toolId(phantom))).toBe(true); // uncataloged ⇒ fail-safe mutating
      expect(copilotReadToolPolicy().allowedTools.map(String)).not.toContain(phantom);
    }
  });

  it("catalogs the two REAL renames as NON-mutating, FROZEN read tools in the read policy", () => {
    const ids = COPILOT_READ_TOOLS.map((s) => String(s.id));
    for (const id of ["gbrain.traverse_graph", "gbrain.get_timeline"]) {
      expect(ids).toContain(id);
      const spec = COPILOT_READ_TOOLS.find((s) => String(s.id) === id);
      expect(spec?.mutating).toBe(false);
      expect(isMutatingCopilotTool(toolId(id))).toBe(false);
      expect(Object.isFrozen(spec)).toBe(true);
    }
    expect(copilotReadOnlyPolicyIsPure(copilotReadToolPolicy())).toBe(true);
  });

  it("EXCLUDES the ADMIN-scoped ops (get_health/get_stats) — servable-by-scope is a catalog precondition", () => {
    // gbrain v0.35.1 classes every op read/write/admin and enforces at invocation; the SoW DCR client is
    // registration-pinned to scope=read. An admin-scoped op in the catalog would be admitted-but-unreachable.
    const ids = COPILOT_READ_TOOLS.map((s) => String(s.id));
    expect(ids).not.toContain("gbrain.get_health");
    expect(ids).not.toContain("gbrain.get_stats");
    expect(isMutatingCopilotTool(toolId("gbrain.get_health"))).toBe(true);
    expect(isMutatingCopilotTool(toolId("gbrain.get_stats"))).toBe(true);
  });
});

// ── SC4 (§13.10 gate a) — the P2 workspace-scoping classification + non-partitioned-brain narrowing ──
describe("copilotToolScopingClass — every read tool is classified (totality; unknown ⇒ unscopable fail-safe)", () => {
  it("assigns an EXPLICIT class to EVERY cataloged read tool (a missing entry fails loudly, not via fail-safe)", () => {
    for (const id of copilotReadToolIds()) {
      // pin EXPLICIT map coverage — a new read tool with no entry must fail here, not silently degrade to
      // the fail-safe `unscopable` (which would hide a missing-classification bug behind over-denial).
      expect(Object.prototype.hasOwnProperty.call(COPILOT_TOOL_SCOPING, String(id)), `unclassified: ${String(id)}`).toBe(true);
      expect(["arg-scopable", "result-filterable", "unscopable", "workspace-agnostic"]).toContain(copilotToolScopingClass(id));
    }
  });
  it("has NO stale scoping entry (every classified id is a real read tool)", () => {
    const readIds = new Set(copilotReadToolIds().map(String));
    for (const id of Object.keys(COPILOT_TOOL_SCOPING)) expect(readIds.has(id), `stale entry: ${id}`).toBe(true);
  });
  it("the scoping record is frozen at runtime (a reclassification cannot silently un-drop a leak-prone tool)", () => {
    expect(Object.isFrozen(COPILOT_TOOL_SCOPING)).toBe(true);
  });
  it("an UNKNOWN tool id classifies unscopable (fail-safe — mirrors isMutatingCopilotTool's unknown⇒mutating)", () => {
    expect(copilotToolScopingClass(toolId("gbrain.some_new_tool"))).toBe("unscopable");
    expect(copilotToolScopingClass(toolId("totally.unknown"))).toBe("unscopable");
  });
  it("the whole-brain AGGREGATORS are unscopable (no per-item workspace scope)", () => {
    for (const id of [
      "gbrain.find_experts",
      "gbrain.find_anomalies",
      "gbrain.find_orphans",
      "gbrain.takes_list",
      "gbrain.takes_search",
      "gbrain.takes_scorecard",
      "gbrain.takes_calibration",
    ]) {
      expect(copilotToolScopingClass(toolId(id))).toBe("unscopable");
    }
  });
  it("the code-intelligence reads are unscopable on a combined brain (source-pinning is inert on one 'default' source)", () => {
    for (const id of ["gbrain.code_def", "gbrain.code_refs", "gbrain.code_callers", "gbrain.code_callees", "gbrain.code_flow", "gbrain.code_blast"]) {
      expect(copilotToolScopingClass(toolId(id))).toBe("unscopable");
    }
  });
  it("the per-hit-slug reads are result-filterable / arg-scopable (SC5 scopes them, safe on any brain)", () => {
    expect(copilotToolScopingClass(toolId("gbrain.search"))).toBe("result-filterable");
    expect(copilotToolScopingClass(toolId("gbrain.traverse_graph"))).toBe("result-filterable");
    expect(copilotToolScopingClass(toolId("gbrain.find_contradictions"))).toBe("result-filterable");
    expect(copilotToolScopingClass(toolId("gbrain.get_recent_salience"))).toBe("arg-scopable");
    expect(copilotToolScopingClass(toolId("gbrain.get_timeline"))).toBe("arg-scopable");
  });
});

describe("copilotScopedReadToolIds — deny the unscopable aggregators on a NON-partitioned brain (fail-safe)", () => {
  it("brainPartitioned=false EXCLUDES every unscopable id, KEEPS the arg-scopable/result-filterable ones", () => {
    const ids = copilotScopedReadToolIds(false).map(String);
    // kept — per-hit / arg-scopable, SC5 enforces
    expect(ids).toContain("gbrain.search");
    expect(ids).toContain("gbrain.traverse_graph");
    expect(ids).toContain("gbrain.find_contradictions");
    expect(ids).toContain("gbrain.get_recent_salience");
    // dropped — unscopable aggregators + combined-brain code intel
    for (const denied of [
      "gbrain.find_experts",
      "gbrain.find_anomalies",
      "gbrain.find_orphans",
      "gbrain.takes_scorecard",
      "gbrain.takes_calibration",
      "gbrain.code_def",
      "gbrain.code_flow",
    ]) {
      expect(ids).not.toContain(denied);
    }
  });
  it("brainPartitioned=true RESTORES the server-scopable set (a per-workspace brain scopes the aggregate)", () => {
    const partitioned = copilotScopedReadToolIds(true).map(String);
    const nonPartitioned = copilotScopedReadToolIds(false).map(String);
    expect(partitioned.length).toBeGreaterThan(nonPartitioned.length);
    expect(partitioned).toContain("gbrain.find_experts");
    expect(partitioned).toContain("gbrain.code_def");
    // non-partitioned is a strict subset of partitioned
    expect(nonPartitioned.every((id) => partitioned.includes(id))).toBe(true);
  });
  it("the returned ids are a subset of the read catalog (never invents a tool)", () => {
    const readIds = copilotReadToolIds().map(String);
    for (const id of copilotScopedReadToolIds(true).map(String)) expect(readIds).toContain(id);
  });
});

// ── §13.10d — skill self-introspection (list_skills / get_skill): the C6 skill-catalog-over-MCP pattern ──
// The agent enumerating which read-skills it can invoke + reading one skill's metadata. This touches NO
// workspace data (it reads the STATIC tool catalog), so it is the genuine case for the FOURTH scoping class
// `workspace-agnostic` — NOT `arg-scopable` (there is no arg to scope) nor `unscopable` (which would wrongly
// DENY it on today's non-partitioned brain). Zero write risk; ING-7-safe; identical regardless of workspace.
describe("§13.10d skill self-introspection — skills.list / skills.get catalog entries", () => {
  const SKILL_IDS = ["skills.list", "skills.get"];

  it("catalogs skills.list + skills.get as NON-mutating, FROZEN read tools that ride into the read policy", () => {
    const ids = COPILOT_READ_TOOLS.map((s) => String(s.id));
    for (const id of SKILL_IDS) {
      expect(ids).toContain(id);
      const spec = COPILOT_READ_TOOLS.find((s) => String(s.id) === id);
      expect(spec?.mutating).toBe(false);
      expect(isMutatingCopilotTool(toolId(id))).toBe(false); // catalog-known, not fail-safe-mutating
      expect(Object.isFrozen(spec)).toBe(true);
    }
    // they ride into the read_only policy — a read_only Copilot job may hold them, and the surface stays pure.
    expect(copilotReadToolPolicy().allowedTools.map(String)).toEqual(expect.arrayContaining(SKILL_IDS));
    expect(copilotReadOnlyPolicyIsPure(copilotReadToolPolicy())).toBe(true);
  });

  it("classifies both as the NEW workspace-agnostic scoping class (they touch no workspace data)", () => {
    for (const id of SKILL_IDS) {
      expect(copilotToolScopingClass(toolId(id))).toBe("workspace-agnostic");
    }
  });

  it("workspace-agnostic tools are KEPT on a NON-partitioned brain (unlike the unscopable aggregators)", () => {
    // The distinguishing property: workspace-agnostic reads carry no cross-workspace leak risk, so — like the
    // arg-scopable / result-filterable reads and UNLIKE the unscopable aggregators — they survive the
    // non-partitioned-brain narrowing. A regression that reclassified them `unscopable` would drop them here.
    const nonPartitioned = copilotScopedReadToolIds(false).map(String);
    const partitioned = copilotScopedReadToolIds(true).map(String);
    for (const id of SKILL_IDS) {
      expect(nonPartitioned).toContain(id); // kept even on today's single 'default' source
      expect(partitioned).toContain(id);
    }
  });
});
