// §5/§7 Phase-C C1 — the Copilot tool catalog + the mutating-tool classifier (the MECHANISM for the ING-7
// arch_gap; the ENFORCEMENT wiring is a follow-on slice — see the wiring note below).
//
// `admitJob` / `admitsMutating` (./admission, ./tool-policy) accept an INJECTED `isMutatingTool` predicate,
// but nothing supplied one — `ToolId` is an open branded string with no catalog (arch_gap recorded on the
// contract + both policy predicates). This module IS that catalog for the Copilot's tools: the read-only op
// surface (safe for an untrusted Copilot) + the write-PROPOSING tool (classified MUTATING, so ING-7 refuses
// it to an untrusted job). It ALSO provides `copilotReadOnlyPolicyIsPure` for the contract's DEFERRED clause
// ("read_only ⇒ allowedTools contains no mutating tool") — a check `admitsMutating`'s read_only early-return
// structurally cannot make. PURE — no clock/network/randomness; never throws.
//
// ⚠ WIRING (this module is INERT until wired — it changes NO runtime behavior on its own):
//   • the Copilot's ING-7 enforcement lands in Phase-C C4, where the Copilot's AgentJob admission calls
//     `admitJob(job, isMutatingCopilotTool)` — until then the injected-predicate hook stays unused;
//   • closing the read_only-smuggle vector (a read_only policy that LISTS a mutating tool — which
//     `admitsMutating` early-returns `false` on and thus admits) requires a caller to ALSO invoke
//     `copilotReadOnlyPolicyIsPure` at admission; wiring the classifier alone does NOT close it.
//   Do NOT record the ING-7 deferred clause as "closed" on the strength of THIS slice — only the mechanism
//   ships here. (The general broker/runAgentJob admit seam is unary `(job) => decision` and would need
//   widening to carry a per-tool predicate for those paths too — tracked separately.)
import { toolId } from "@sow/contracts";
import type { ToolId, ToolPolicy } from "@sow/contracts";
import { effectiveAllowedTools } from "@sow/contracts";

/** One Copilot tool: its opaque id, whether it can MUTATE (ING-7 gate input), and a one-line description. */
export interface CopilotToolSpec {
  readonly id: ToolId;
  /** ING-7: an untrusted-content Copilot may hold ONLY non-mutating tools. */
  readonly mutating: boolean;
  readonly description: string;
}

/**
 * The read-only tools — the closed GbrainAllowedOp read surface (@sow/knowledge: search/graph/timeline/
 * schema_read/health/contained_synthesis) plus a canonical-Markdown vault read. NONE mutate, so they are
 * safe for an untrusted Copilot (a read_only job). Cross-workspace/global reads are NOT here — those go
 * through the GCL Visibility Gate, never a direct agent tool.
 */
// Object.freeze each spec + the array: this is a safety-critical classification source, so a mutation like
// `COPILOT_PROPOSE_TOOL.mutating = false` (which would silently downgrade a mutating tool) is prevented at
// runtime, not just by the compile-time `readonly`.
export const COPILOT_READ_TOOLS: readonly CopilotToolSpec[] = Object.freeze([
  Object.freeze({ id: toolId("gbrain.search"), mutating: false, description: "semantic search over the workspace brain" }),
  Object.freeze({ id: toolId("gbrain.graph"), mutating: false, description: "read the knowledge-graph neighborhood of a note" }),
  Object.freeze({ id: toolId("gbrain.timeline"), mutating: false, description: "read the workspace timeline" }),
  Object.freeze({ id: toolId("gbrain.schema_read"), mutating: false, description: "read the brain's index schema" }),
  Object.freeze({ id: toolId("gbrain.health"), mutating: false, description: "read brain health / coverage" }),
  // gbrain.contained_synthesis is read-only BY ARCHITECTURE (one-writer rule + generativeCycleEnabled=false);
  // the authority is the serve policy's GbrainReadGrant.allowedOps — cross-check when C4 wires the tool.
  Object.freeze({ id: toolId("gbrain.contained_synthesis"), mutating: false, description: "brain-contained synthesis (read-only)" }),
  // Tier-1 §13.10 — the conflict/gap-detection analysis reads (led by find_contradictions). PURE reads
  // (verified against the live gbrain MCP: find_contradictions reads the cached run row + never triggers a
  // probe; find_anomalies is statistical; find_orphans is a graph read). Op-suffix == the live gbrain MCP
  // tool name EXACTLY, so `copilotToolToMcpName` maps them identity → mcp__gbrain__<op>. Surfacing conflicts
  // BEFORE answering feeds the no-inference posture (REQ-F-017): route to clarification instead of guessing.
  //
  // ⚠ WS-8 GO-LIVE GATE (do NOT flip copilotAgentMode against a MULTI-workspace brain until fixed): these
  // three ENUMERATE THE WHOLE BRAIN with no workspace-scope arg — strictly broader than the query-scoped
  // search tool. Cross-BRAIN isolation holds by construction (one served endpoint, no brain-selector arg,
  // deny-all for non-served workspaces), but cross-WORKSPACE isolation rests on the served brain holding ONE
  // workspace's content. The real local gbrain is a single COMBINED brain (slug/tag-partitioned across all 3
  // workspaces), so activating these against it would surface every workspace's findings. Go-live requires
  // per-workspace brain partitioning / server-enforced scope (NOT find_contradictions' optional `slug` arg,
  // which a model can equally use to TARGET another workspace). Safe today: dormant (copilotAgentMode OFF) +
  // a single seeded served workspace. Tracked as a hard go-live blocker + a C6 governance-eval item.
  Object.freeze({ id: toolId("gbrain.find_contradictions"), mutating: false, description: "read cached suspected-contradiction findings for the workspace brain" }),
  Object.freeze({ id: toolId("gbrain.find_anomalies"), mutating: false, description: "read statistical anomalies in the workspace brain" }),
  Object.freeze({ id: toolId("gbrain.find_orphans"), mutating: false, description: "read orphaned / unlinked notes in the workspace brain" }),
  Object.freeze({ id: toolId("vault.read"), mutating: false, description: "read a canonical Markdown note by path" }),
]);

/**
 * The write-PROPOSING tool. It routes an action to §9.8 Approvals (NEVER a direct write), but an UNTRUSTED
 * agent must not be able to propose writes at all — a prompt-injected untrusted document could steer a
 * proposal a human might rubber-stamp — so it is classified MUTATING. ING-7 therefore refuses it to an
 * untrusted Copilot job; only a TRUSTED (scoped_write) Copilot job may hold it.
 */
export const COPILOT_PROPOSE_TOOL: CopilotToolSpec = Object.freeze({
  id: toolId("copilot.propose_action"),
  mutating: true,
  description: "propose an external write for human approval (routes to §9.8 Approvals; never a direct write)",
});

/** The full catalog, keyed by the raw tool id. */
const CATALOG: ReadonlyMap<string, CopilotToolSpec> = new Map(
  [...COPILOT_READ_TOOLS, COPILOT_PROPOSE_TOOL].map((s) => [s.id as string, s]),
);

/** The read-only tools' ids — the allow-list for a read-only Copilot job. */
export function copilotReadToolIds(): ToolId[] {
  return COPILOT_READ_TOOLS.map((s) => s.id);
}

/** The read tools PLUS the write-proposing tool — a TRUSTED (scoped_write) Copilot job's allow-list. */
export function copilotAgentToolIds(): ToolId[] {
  return [...copilotReadToolIds(), COPILOT_PROPOSE_TOOL.id];
}

/**
 * The mutating-tool classifier that closes the ING-7 arch_gap. FAIL-SAFE: an UNKNOWN ToolId (not in the
 * catalog) is treated as MUTATING — so an untrusted job carrying an unrecognized tool is REFUSED by
 * `admitJob`, never silently admitted. Feed this to `admitJob(job, isMutatingCopilotTool)`. Pure.
 */
export function isMutatingCopilotTool(t: ToolId): boolean {
  const spec = CATALOG.get(t as string);
  return spec === undefined ? true : spec.mutating;
}

/** A read_only ToolPolicy over the Copilot's read tools (safe for ANY Copilot job — trusted or untrusted). */
export function copilotReadToolPolicy(): ToolPolicy {
  return { mode: "read_only", allowedTools: copilotReadToolIds(), deniedTools: [], allowsMutating: false };
}

/** A scoped_write ToolPolicy adding the write-proposing tool — admissible ONLY for a TRUSTED Copilot job. */
export function copilotAgentToolPolicy(): ToolPolicy {
  return { mode: "scoped_write", allowedTools: copilotAgentToolIds(), deniedTools: [], allowsMutating: true };
}

/**
 * The predicate for the contract's DEFERRED clause ("read_only ⇒ allowedTools contains no mutating tool" —
 * unenforceable without a catalog). A read_only Copilot policy is PURE iff none of its EFFECTIVE allowed
 * tools (allow minus deny — deny wins) is mutating per the catalog. This catches a read_only policy that
 * SECRETLY lists a mutating tool, which `admitsMutating`'s read_only early-return structurally cannot see.
 * A scoped_write policy is vacuously pure at this level (it is allowed to hold mutating tools). Pure.
 *
 * NOTE: this only CLOSES the clause once a gate CALLS it — it is not auto-composed into `admitJob`. The
 * Copilot admission path (C4) must invoke it IN ADDITION to `admitJob(job, isMutatingCopilotTool)`.
 */
export function copilotReadOnlyPolicyIsPure(p: ToolPolicy): boolean {
  if (p.mode !== "read_only") return true;
  return !effectiveAllowedTools(p).some((t) => isMutatingCopilotTool(t));
}
