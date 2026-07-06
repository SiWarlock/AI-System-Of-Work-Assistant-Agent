// §13.10 gate (a) SC5a — the P2 arg policer (the load-bearing WS-8 arg guard).
//
// The agentic Copilot (DORMANT behind copilotAgentMode) calls gbrain read tools with MODEL-SUPPLIED args.
// This pure guard runs per tool call (wired by SC6 into the transport's `canUseTool` arg-rewrite) and,
// before the call reaches gbrain, either DENIES it or returns a scope-corrected `updatedInput`:
//   • deny scope-WIDENING — `source_id="__all__"` or `all_sources=true` (a model widening past its
//     workspace is the sharpest attack; never allowed);
//   • deny a FOREIGN seed — `traverse_graph`/`get_timeline` walk/read from a seed `slug`, so the seed MUST
//     attribute to the served workspace (else a walk hops into another workspace's subgraph);
//   • force the served scope where an arg allows it — `get_recent_salience.slugPrefix` is pinned to the
//     served prefix (a model override is discarded); `query`/`code_*` pin `source_id` to the served
//     descriptor's Phase-B source when present; `find_contradictions` best-effort pins its `slug` substring;
//   • deny an UNKNOWN / non-read / mutating tool, and MALFORMED (non-object) args.
// FAIL-CLOSED + never returns null. Result-content leakage (A2/A3/A4) is the REDACTOR's job (SC5b), not
// this arg guard — a scoped arg reduces but does not guarantee scoped RESULTS.
import { toolId } from "@sow/contracts";
import type { ToolId } from "@sow/contracts";
import { isMutatingCopilotTool, copilotToolScopingClass } from "./copilot-tool-catalog";
import { decideHitScope, descriptorFor, singleSlugPrefixOf } from "./copilot-workspace-scope";
import type { CopilotWorkspaceScope } from "./copilot-workspace-scope";

/** Why an arg-policed call was denied (stable, redaction-safe — never carries slug/body content). */
export type ArgPolicyCause =
  | "SCOPE_WIDENING_DENIED"
  | "FOREIGN_SEED_DENIED"
  | "UNSCOPABLE_TOOL_DENIED"
  | "UNKNOWN_TOOL_DENIED"
  | "MALFORMED_ARGS_DENIED";

/** The policer's decision: allow with a scope-corrected input, or a fail-closed deny. */
export type ArgPolicyResult =
  | { readonly decision: "allow"; readonly updatedInput: Record<string, unknown> }
  | { readonly decision: "deny"; readonly cause: ArgPolicyCause };

const GBRAIN_MCP_PREFIX = "mcp__gbrain__";

/**
 * Map a gbrain MCP tool name (`mcp__gbrain__<op>`) to its catalog ToolId + op, or `null` if it is not a known
 * gbrain READ op. `query` maps back to `gbrain.search` (the one non-identity catalog id). A mutating/unknown
 * op ⇒ `null` (fail-safe — `isMutatingCopilotTool` treats an uncataloged id as mutating).
 */
function gbrainReadToolOf(mcpToolName: string): { readonly op: string; readonly id: ToolId } | null {
  if (!mcpToolName.startsWith(GBRAIN_MCP_PREFIX)) return null;
  const op = mcpToolName.slice(GBRAIN_MCP_PREFIX.length);
  if (op.length === 0) return null;
  const id = toolId(op === "query" ? "gbrain.search" : `gbrain.${op}`);
  return isMutatingCopilotTool(id) ? null : { op, id };
}

/**
 * Police a single gbrain tool call's MODEL-SUPPLIED args against the served workspace scope. Returns a
 * scope-corrected `updatedInput` (a COPY — the caller's object is never mutated) or a fail-closed deny.
 * Pure; never throws; never returns null.
 */
export function policeGbrainToolArgs(
  mcpToolName: unknown,
  input: unknown,
  scope: CopilotWorkspaceScope,
): ArgPolicyResult {
  if (typeof mcpToolName !== "string") return { decision: "deny", cause: "UNKNOWN_TOOL_DENIED" };
  const tool = gbrainReadToolOf(mcpToolName);
  if (tool === null) return { decision: "deny", cause: "UNKNOWN_TOOL_DENIED" };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { decision: "deny", cause: "MALFORMED_ARGS_DENIED" };
  }
  // M2 defense-in-depth: an `unscopable` whole-brain tool cannot be arg-scoped, so on a NON-partitioned brain
  // the policer DENIES it independently of SC4's allow-list (no SPOF on a wiring slip). A partitioned brain
  // scopes the computation server-side, so it is permitted.
  if (copilotToolScopingClass(tool.id) === "unscopable" && scope.brainPartitioned !== true) {
    return { decision: "deny", cause: "UNSCOPABLE_TOOL_DENIED" };
  }
  const args: Record<string, unknown> = { ...(input as Record<string, unknown>) };

  // M1 universal scope-widening guard (query + code_* accept source_id / all_sources). Robust to type/case
  // variants a strict-equal check misses, and NEUTRALIZE the flag so a slipped value can never be forwarded:
  //  • deny ANY truthy all_sources; then delete it (false/absent is the scoped default).
  //  • deny a `__all__` source_id (case-insensitive) or a non-string source_id (array/object); the served
  //    source is force-pinned (or deleted) below, so the model never picks the source.
  if (isTruthy(args["all_sources"])) return { decision: "deny", cause: "SCOPE_WIDENING_DENIED" };
  delete args["all_sources"];
  const rawSource = args["source_id"];
  if (rawSource !== undefined) {
    if (typeof rawSource !== "string" || rawSource.trim().toLowerCase() === "__all__") {
      return { decision: "deny", cause: "SCOPE_WIDENING_DENIED" };
    }
  }

  switch (tool.op) {
    case "traverse_graph":
    case "get_timeline": {
      // The seed slug must attribute to the served workspace — else a walk/read hops into another workspace.
      const slug = typeof args["slug"] === "string" ? args["slug"] : "";
      if (decideHitScope({ slug }, scope.servedWorkspaceId, scope.registry, scope.policy).decision !== "keep") {
        return { decision: "deny", cause: "FOREIGN_SEED_DENIED" };
      }
      return { decision: "allow", updatedInput: args };
    }
    case "get_recent_salience": {
      // Force slugPrefix to the served workspace's prefix, discarding any model override (defense-in-depth;
      // the redactor still filters per-row). Ambiguous prefix (0/>1) ⇒ leave it to the redactor.
      const prefix = singleSlugPrefixOf(scope);
      if (prefix !== null) args["slugPrefix"] = prefix;
      return { decision: "allow", updatedInput: args };
    }
    default: {
      // query / code_* / find_contradictions (the result-filterable/arg-scopable ops that take source_id):
      // FORCE source_id to the served descriptor's Phase-B source when present, else DELETE any model-supplied
      // source_id — the model must never pick the source on a non-partitioned brain.
      const d = descriptorFor(scope.registry, scope.servedWorkspaceId);
      if (d?.sourceId !== undefined) args["source_id"] = String(d.sourceId);
      else delete args["source_id"];
      // find_contradictions: best-effort pin its optional slug substring to the served prefix (the redactor's
      // A3 fail-closed far-side is the real guarantee; this only narrows the query — a model-supplied slug is
      // left as-is, since the redactor drops any foreign pair regardless).
      if (tool.op === "find_contradictions" && args["slug"] === undefined) {
        const prefix = singleSlugPrefixOf(scope);
        if (prefix !== null) args["slug"] = prefix;
      }
      return { decision: "allow", updatedInput: args };
    }
  }
}

/** Any truthy scalar (true / "true" / 1 / "1" / non-empty). Used to catch a coerced `all_sources` flag. */
function isTruthy(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes" || s === "on";
  }
  return false;
}
