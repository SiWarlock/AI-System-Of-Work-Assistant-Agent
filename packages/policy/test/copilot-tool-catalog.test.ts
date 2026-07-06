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
    expect(ids).toContain("gbrain.timeline");
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
      "search", "graph", "timeline", "schema_read", "health", "contained_synthesis",
      "find_contradictions", "find_anomalies", "find_orphans",
      // expertise + takes (calibration memory) + code-intelligence — all verified pure reads against the live
      // gbrain MCP schemas. code_traversal_cache_clear is DELIBERATELY absent (destructive cache op, D8-guarded).
      "find_experts",
      "takes_list", "takes_search", "takes_scorecard", "takes_calibration",
      "code_def", "code_refs", "code_callers", "code_callees", "code_flow", "code_blast",
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

  it("EXCLUDES the destructive gbrain.code_traversal_cache_clear (fail-safe ⇒ mutating)", () => {
    // code_traversal_cache_clear wipes the code_blast/code_flow traversal cache (a D8 destructive-guarded op).
    // It is NOT cataloged, so the fail-safe classifier treats it as mutating — a read_only job can never hold it.
    const ids = COPILOT_READ_TOOLS.map((s) => String(s.id));
    expect(ids).not.toContain("gbrain.code_traversal_cache_clear");
    expect(isMutatingCopilotTool(toolId("gbrain.code_traversal_cache_clear"))).toBe(true);
  });
});
