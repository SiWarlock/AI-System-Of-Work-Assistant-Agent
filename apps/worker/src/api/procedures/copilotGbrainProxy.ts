// §13.10 gate (a) SC7a — the worker-side security composition for the DORMANT agentic gbrain-proxy tool path.
//
// The agentic Copilot (behind copilotAgentMode, OFF) reaches gbrain through an IN-PROCESS proxy MCP server
// (SC7b, providers) that REPLACES the raw `gbrain serve --http` entry in the SDK's `mcpServers` — so the model
// can never reach unscoped gbrain. Every proxied tool call is delegated to THIS handler, which is where the
// two pure WS-8 guards compose over the real gbrain read:
//
//   model args → SC5a policeGbrainToolArgs (deny widening/foreign-seed/unknown/unscopable; scope-correct args)
//              → exec(scope-corrected args)  [the real gbrain MCP read — injected]
//              → SC5b redactGbrainToolResult (drop foreign hits/edges/pairs from the raw MCP result envelope)
//              → the scoped result the model sees.
//
// WS-8 enforcement stays WORKER-OWNED here, exactly as on the P1 retrieval path (copilotGbrainSubprocess's
// createWorkspaceScopeFilter) — providers is a thin registration pipe (SC7b) with no policy knowledge. This
// handler is bound to a server-side {scope, exec} at wiring time (SC8); the scope's servedWorkspaceId is NEVER
// model/client input.
//
// FAIL-CLOSED + LEAK-SAFE: an arg DENY, an exec fault, an exec throw, or a redactor fail-close ALL collapse to
// the SAME empty MCP result — the internal cause (a stable redaction-safe code) is NEVER surfaced to the model
// (it could echo a slug/prefix). Never throws across the boundary (§16). The exec is expected to be
// redaction-safe already (it returns a typed fault, not content), but the throw is caught belt-and-suspenders.
import { isOk } from "@sow/contracts";
import type { Result, FailureVariant } from "@sow/contracts";
import { policeGbrainToolArgs, redactGbrainToolResult } from "@sow/policy";
import type { CopilotWorkspaceScope } from "@sow/policy";

/**
 * The injected generic gbrain MCP read: a FULL mcp tool name (`mcp__gbrain__<op>`) + the SCOPE-CORRECTED args
 * → the RAW gbrain MCP result envelope (`{content:[{type:"text",text:"<JSON>"}]}`) as `unknown`, or a typed
 * transport fault. The redactor parses + scopes the envelope; a fault ⇒ a fail-closed empty result. Boot wires
 * the http-grant transport (the mandated `transport:"http"` path); unit tests inject a canned Result.
 */
export type CopilotGbrainToolExec = (
  mcpToolName: string,
  args: Record<string, unknown>,
) => Promise<Result<unknown, FailureVariant>>;

/** A single text block of a tool result (structurally compatible with the SDK's CallToolResult content). */
export interface CopilotGbrainToolTextBlock {
  readonly type: "text";
  readonly text: string;
}

/** The handler's result — the MCP tool result the proxy hands back to the SDK (readonly; mapped mutable in SC7b). */
export interface CopilotGbrainToolResult {
  readonly content: ReadonlyArray<CopilotGbrainToolTextBlock>;
}

/** Server-bound deps: the served workspace scope (SC5a/SC5b) + the real gbrain read. Both fixed at wiring, not model input. */
export interface CopilotGbrainToolCallDeps {
  readonly scope: CopilotWorkspaceScope;
  readonly exec: CopilotGbrainToolExec;
}

/**
 * The single leak-safe empty result. `"[]"` reads as "no results" for every array-shaped op; for the one
 * object-shaped op (find_contradictions) the model still reads it as "nothing". No slug/prefix/cause leaks.
 */
const SAFE_EMPTY_RESULT: CopilotGbrainToolResult = { content: [{ type: "text", text: "[]" }] };

/** Map a (possibly readonly / possibly empty) MCP envelope to a leak-safe non-empty result. */
function toToolResult(content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>): CopilotGbrainToolResult {
  if (content.length === 0) return SAFE_EMPTY_RESULT; // an empty content list ⇒ the universal empty signal
  return { content: content.map((b) => ({ type: "text", text: b.text })) };
}

/**
 * Handle ONE proxied gbrain tool call: police the model args, run the real read with the scope-corrected args,
 * and redact the raw result. Deny/fault/throw/redacted-empty ⇒ the same fail-closed empty result. Never throws.
 */
export async function handleCopilotGbrainToolCall(
  mcpToolName: string,
  args: unknown,
  deps: CopilotGbrainToolCallDeps,
): Promise<CopilotGbrainToolResult> {
  // STRUCTURAL never-throws: the ENTIRE body is wrapped, so ANY unexpected throw — the exec, or a future
  // regression in either pure guard / the mapper — collapses to the SAME leak-safe empty result. The
  // guarantee at this untrusted-model ↔ worker boundary does not rest on each seam's contract holding forever.
  try {
    // 1. SC5a — police the MODEL-SUPPLIED args. A deny (widening / foreign seed / unknown / unscopable /
    //    malformed) fail-closes BEFORE any gbrain read happens.
    const policed = policeGbrainToolArgs(mcpToolName, args, deps.scope);
    if (policed.decision === "deny") return SAFE_EMPTY_RESULT;

    // 2. Run the real gbrain read with the SCOPE-CORRECTED args (never the raw model args). A typed fault
    //    fail-closes — the fault detail is dropped (redaction-safe); a throw is caught by the outer try.
    const raw: Result<unknown, FailureVariant> = await deps.exec(mcpToolName, policed.updatedInput);
    if (!isOk(raw)) return SAFE_EMPTY_RESULT;

    // 3. SC5b — redact the raw MCP result envelope to the served workspace. A malformed/unparseable envelope
    //    fail-closes to an empty envelope, which maps to the same leak-safe empty result.
    const redacted = redactGbrainToolResult(mcpToolName, raw.value, deps.scope);
    return toToolResult(redacted.output.content);
  } catch {
    return SAFE_EMPTY_RESULT;
  }
}
