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
 * The read-only tools — the LIVE-VERIFIED gbrain read surface. Every entry names a real op reachable by a
 * read-scoped client on the `gbrain serve --http` MCP endpoint (verified against gbrain v0.35.1's per-op
 * read/write/admin scope classes), plus a canonical-Markdown vault read. The op-suffix equals the live MCP
 * tool name for every gbrain entry EXCEPT `gbrain.search`, which `copilotToolToMcpName` maps identity →
 * `query` (gbrain's semantic-search tool is named `query`, proven live). NONE mutate, so they are safe for
 * an untrusted Copilot (a read_only job). Cross-workspace/global reads are NOT here — those go through the
 * GCL Visibility Gate, never a direct agent tool.
 *
 * NOTE this catalog is DISTINCT from the frozen Path-1 `GbrainAllowedOp` grant enum (@sow/contracts —
 * search/graph/timeline/schema_read/health/contained_synthesis, enforced only by @sow/knowledge's
 * mcp-read-adapter): that enum predates the live verification and carries names with no live MCP tool;
 * its truth-pass is a flagged FUTURE frozen change (§13.10 go-live gate b), not this catalog's concern.
 */
// Object.freeze each spec + the array: this is a safety-critical classification source, so a mutation like
// `COPILOT_PROPOSE_TOOL.mutating = false` (which would silently downgrade a mutating tool) is prevented at
// runtime, not just by the compile-time `readonly`.
export const COPILOT_READ_TOOLS: readonly CopilotToolSpec[] = Object.freeze([
  Object.freeze({ id: toolId("gbrain.search"), mutating: false, description: "semantic search over the workspace brain" }),
  // §13.10 go-live gate (d) — the one-time phantom cleanup (verified against live gbrain v0.35.1):
  // `graph`/`timeline` were renamed to the REAL MCP tool names below; `schema_read` and
  // `contained_synthesis` had NO live MCP tool and were pruned; `health` was pruned because the real op
  // (`get_health`, like `get_stats`) requires ADMIN scope — the SoW DCR client is registration-pinned to
  // scope=read, so cataloging an admin op would be an admitted-but-unreachable phantom allow-list entry.
  // Servable-under-read-scope is a catalog PRECONDITION, alongside read-purity.
  // Both reads take a MODEL-SUPPLIABLE `slug`, so the ⚠ WS-8 GO-LIVE GATE (below) applies to them too.
  Object.freeze({ id: toolId("gbrain.traverse_graph"), mutating: false, description: "walk the knowledge-graph neighborhood of a note (slug + depth)" }),
  Object.freeze({ id: toolId("gbrain.get_timeline"), mutating: false, description: "read a note's timeline entries (per-page history; slug-keyed)" }),
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
  // Expertise routing + the takes calibration memory. PURE reads (live gbrain MCP: find_experts ranks
  // person/company pages by expertise via SQL; takes_* list/search/score the owner's claims & bets — no
  // take-WRITE tool exists in this set). These read the BRAIN, so the same ⚠ WS-8 GO-LIVE GATE above applies
  // (whole-brain reads against a combined brain leak cross-workspace until per-workspace partitioning lands).
  Object.freeze({ id: toolId("gbrain.find_experts"), mutating: false, description: "route a topic to who-in-the-brain knows it (ranked person/company pages)" }),
  Object.freeze({ id: toolId("gbrain.takes_list"), mutating: false, description: "list the owner's takes (typed/weighted/attributed claims)" }),
  Object.freeze({ id: toolId("gbrain.takes_search"), mutating: false, description: "keyword-search the owner's takes" }),
  Object.freeze({ id: toolId("gbrain.takes_scorecard"), mutating: false, description: "read the calibration scorecard for resolved bets" }),
  Object.freeze({ id: toolId("gbrain.takes_calibration"), mutating: false, description: "read the calibration curve for resolved bets" }),
  // Code intelligence over the indexed code graph. PURE reads (symbol def / refs / callers / callees / flow /
  // blast-radius). code_flow + code_blast populate an internal traversal MEMOIZATION cache — a non-semantic,
  // non-external, non-brain-truth side effect (transparent to callers), so `mutating:false` is correct. Its
  // destructive counterpart `code_traversal_cache_clear` is DELIBERATELY EXCLUDED (a D8-guarded cache wipe;
  // uncataloged ⇒ the fail-safe classifier treats it as mutating).
  // ⚠ THE SAME WS-8 GO-LIVE GATE (above) APPLIES: these are source_id-scoped, but `source_id` is a
  // MODEL-SUPPLIABLE arg and `all_sources` reads across EVERY registered source — so on a combined brain
  // (where one code index spans e.g. an employer repo + a personal repo) source_id ≠ workspace and a model
  // could target/enumerate another workspace's source. Go-live must map source→workspace + enforce scope
  // server-side (same hard blocker + C6 eval item as the brain-reading tools); safe today (dormant + single seed).
  Object.freeze({ id: toolId("gbrain.code_def"), mutating: false, description: "the definition site(s) of a symbol" }),
  Object.freeze({ id: toolId("gbrain.code_refs"), mutating: false, description: "every reference to a symbol across the codebase" }),
  Object.freeze({ id: toolId("gbrain.code_callers"), mutating: false, description: "direct callers of a symbol (call graph)" }),
  Object.freeze({ id: toolId("gbrain.code_callees"), mutating: false, description: "outbound calls from a symbol (call graph)" }),
  Object.freeze({ id: toolId("gbrain.code_flow"), mutating: false, description: "ordered execution chain from an entry point to its sinks" }),
  Object.freeze({ id: toolId("gbrain.code_blast"), mutating: false, description: "transitive callers of a symbol grouped by depth (blast radius)" }),
  // Resume-context recency read ("what's been going on / what's hot"): pages ranked by salience over a window.
  // Whole-brain read ⇒ the same ⚠ WS-8 GO-LIVE GATE (above) applies. NOTE: the sibling `get_recent_transcripts`
  // is DELIBERATELY EXCLUDED — it is LOCAL-ONLY (rejects remote MCP/http callers with permission_denied), so a
  // catalog entry would be a dead allow-list entry for the served (http-transport) agent.
  Object.freeze({ id: toolId("gbrain.get_recent_salience"), mutating: false, description: "recently-salient pages (activity + salience ranked over a window)" }),
  Object.freeze({ id: toolId("vault.read"), mutating: false, description: "read a canonical Markdown note by path" }),
  // §13.10d skill self-introspection — the C6 skill-catalog-over-MCP pattern (the agent enumerating which
  // read-skills it can invoke + reading one skill's metadata). These read the STATIC tool catalog, touching
  // NO workspace data (no brain read, no vault read), so they carry ZERO cross-workspace leak risk and are
  // classified `workspace-agnostic` below (the 4th scoping class). Pure reads, ING-7-safe, zero approval.
  Object.freeze({ id: toolId("skills.list"), mutating: false, description: "list the Copilot's own read-skills (id + description) — skill self-introspection" }),
  Object.freeze({ id: toolId("skills.get"), mutating: false, description: "read one Copilot read-skill's metadata by id" }),
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

/**
 * §13.10a — the SEMANTIC-write proposing tool. Routes a Copilot-proposed KnowledgeMutationPlan to §9.8
 * Approvals (NEVER a direct/auto Markdown write — KnowledgeWriter commits it ONLY on owner approval,
 * safety rules 1+2). Like the external propose tool, an UNTRUSTED agent must not be able to propose writes
 * (a prompt-injected untrusted document could steer a proposal a human rubber-stamps), so it is classified
 * MUTATING — ING-7 refuses it to an untrusted Copilot job; only a TRUSTED (scoped_write) job may hold it.
 */
export const COPILOT_PROPOSE_KNOWLEDGE_TOOL: CopilotToolSpec = Object.freeze({
  id: toolId("copilot.propose_knowledge"),
  mutating: true,
  description: "propose a project-note semantic write for human approval (routes to §9.8 Approvals; never a direct write)",
});

/** The full catalog, keyed by the raw tool id. */
const CATALOG: ReadonlyMap<string, CopilotToolSpec> = new Map(
  [...COPILOT_READ_TOOLS, COPILOT_PROPOSE_TOOL, COPILOT_PROPOSE_KNOWLEDGE_TOOL].map((s) => [s.id as string, s]),
);

/** The read-only tools' ids — the allow-list for a read-only Copilot job. */
export function copilotReadToolIds(): ToolId[] {
  return COPILOT_READ_TOOLS.map((s) => s.id);
}

/** The read tools PLUS the write-proposing tool — a TRUSTED (scoped_write) Copilot job's allow-list. */
export function copilotAgentToolIds(): ToolId[] {
  return [...copilotReadToolIds(), COPILOT_PROPOSE_TOOL.id];
}

// ── §13.10 gate (a) SC4 — the P2 workspace-scoping classification (a SEPARATE additive map) ──────────
//
// This does NOT mutate the frozen COPILOT_READ_TOOLS specs; it is a parallel classification of HOW each
// read tool can be workspace-scoped over the combined gbrain brain, and which are safe on a NON-partitioned
// brain (today's single "default" source):
//   • result-filterable — results carry a per-hit slug, so SC5's `redactGbrainToolResult` drops foreign
//     hits post-hoc (safe on any brain): search, traverse_graph, find_contradictions.
//   • arg-scopable — a per-call arg pins the served workspace's scope (slug seed / slug-prefix), safe on
//     any brain: get_recent_salience (slugPrefix), get_timeline (seed slug), vault.read (path).
//   • unscopable — a WHOLE-BRAIN computation with no per-item workspace scope: the aggregators
//     (find_experts/find_anomalies/find_orphans, takes_*) AND the code-intelligence reads (code_*, whose
//     only scope lever is source_id, inert on a single-source brain — they would leak cross-workspace code
//     structure). These are DENIED on a non-partitioned brain; a per-workspace-partitioned brain (Phase B
//     source_id / Phase C brain-per-workspace) scopes the computation server-side, so they become safe.
//   • workspace-agnostic — the tool touches NO workspace data (reads the STATIC tool catalog, not the brain):
//     skill self-introspection (skills.list/skills.get). No scope to apply, no leak possible ⇒ kept on ANY brain.
// FAIL-SAFE: an unknown ToolId classifies `unscopable` (mirrors `isMutatingCopilotTool`'s unknown⇒mutating).

/**
 * How a Copilot read tool can be workspace-scoped over the combined brain.
 *   • arg-scopable      — a per-call arg pins the served workspace (slug seed / slug-prefix / path).
 *   • result-filterable — results carry a per-hit slug, so SC5 drops foreign hits post-hoc.
 *   • unscopable        — a whole-brain computation with no per-item workspace scope (DENIED non-partitioned).
 *   • workspace-agnostic — the tool touches NO workspace data (it reads the STATIC tool catalog, not the brain
 *     or vault), so there is nothing to scope and no cross-workspace leak is possible: safe on ANY brain,
 *     partitioned or not. This is DISTINCT from `arg-scopable` (which has a real workspace-pinning arg) and
 *     from `unscopable` (a whole-brain read that WOULD leak until partitioning). Only skill self-introspection
 *     (skills.list / skills.get) is in this class today.
 */
export type CopilotToolScopingClass = "arg-scopable" | "result-filterable" | "unscopable" | "workspace-agnostic";

/**
 * The workspace-scoping class per read ToolId. FROZEN at runtime (same bar as COPILOT_READ_TOOLS: this is a
 * safety-critical classification source — a runtime `.code_def = "result-filterable"` would silently un-drop
 * a leak-prone tool, so it is `Object.freeze`'d, not merely `readonly`). Exported so a totality test can pin
 * EXPLICIT coverage (a new read tool with no entry must fail the test, not silently fall through the fail-safe).
 */
export const COPILOT_TOOL_SCOPING: Readonly<Record<string, CopilotToolScopingClass>> = Object.freeze({
  "gbrain.search": "result-filterable",
  "gbrain.traverse_graph": "result-filterable",
  // ⚠ result-filterable is CONDITIONAL on SC5's A3 fail-close: find_contradictions returns two-sided pairs,
  // so SC5 MUST drop a pair when EITHER side's slug is foreign / unattributable — a naive per-primary-hit
  // filter would leak the far side of a cross-workspace contradiction.
  "gbrain.find_contradictions": "result-filterable",
  "gbrain.get_timeline": "arg-scopable",
  "gbrain.get_recent_salience": "arg-scopable",
  "vault.read": "arg-scopable",
  "gbrain.find_experts": "unscopable",
  "gbrain.find_anomalies": "unscopable",
  "gbrain.find_orphans": "unscopable",
  "gbrain.takes_list": "unscopable",
  "gbrain.takes_search": "unscopable",
  "gbrain.takes_scorecard": "unscopable",
  "gbrain.takes_calibration": "unscopable",
  "gbrain.code_def": "unscopable",
  "gbrain.code_refs": "unscopable",
  "gbrain.code_callers": "unscopable",
  "gbrain.code_callees": "unscopable",
  "gbrain.code_flow": "unscopable",
  "gbrain.code_blast": "unscopable",
  // §13.10d skill self-introspection — no workspace data touched ⇒ the 4th class (safe on any brain, kept on a
  // non-partitioned one, since there is nothing to leak). NOT `arg-scopable`: there is no workspace-pinning arg.
  "skills.list": "workspace-agnostic",
  "skills.get": "workspace-agnostic",
});

/** Classify how a read ToolId can be workspace-scoped. FAIL-SAFE: unknown ⇒ `unscopable`. Pure. */
export function copilotToolScopingClass(id: ToolId): CopilotToolScopingClass {
  return COPILOT_TOOL_SCOPING[String(id)] ?? "unscopable";
}

/**
 * The read-tool allow-list narrowed for the served brain's partition state (SC4). On a NON-partitioned
 * brain (`brainPartitioned=false`, today's single "default" source) the whole-brain `unscopable` tools are
 * DROPPED — they cannot be scoped to the served workspace, so an agentic Copilot must not hold them. On a
 * per-workspace-partitioned brain they are restored (the server scopes the computation). The `arg-scopable`
 * / `result-filterable` / `workspace-agnostic` tools are always kept (SC5 pins/filters the first two; the
 * last touches no workspace data). Fail-safe: an unknown/unclassified read tool is `unscopable` ⇒ dropped on
 * a non-partitioned brain. Pure.
 */
export function copilotScopedReadToolIds(brainPartitioned: boolean): ToolId[] {
  return copilotReadToolIds().filter((id) =>
    copilotToolScopingClass(id) === "unscopable" ? brainPartitioned : true,
  );
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
 * §13.10a — a TRUSTED (scoped_write) knowledge-propose job's allow-list: the read tools PLUS the SEMANTIC-write
 * proposing tool. DECOUPLED from `copilotAgentToolIds` (the EXTERNAL-write grant): a knowledge-propose agent
 * does NOT also get `copilot.propose_action`, and vice-versa — a caller that wants a full agent composes both
 * explicitly. Keeping the two grants separate avoids silently widening the existing external-propose runner.
 */
export function copilotKnowledgeAgentToolIds(): ToolId[] {
  return [...copilotReadToolIds(), COPILOT_PROPOSE_KNOWLEDGE_TOOL.id];
}

/** A scoped_write ToolPolicy adding the SEMANTIC-write proposing tool — admissible ONLY for a TRUSTED Copilot job. */
export function copilotKnowledgeProposeToolPolicy(): ToolPolicy {
  return { mode: "scoped_write", allowedTools: copilotKnowledgeAgentToolIds(), deniedTools: [], allowsMutating: true };
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
