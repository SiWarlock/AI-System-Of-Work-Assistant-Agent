// Skill-B (§13.10d) — skill self-introspection: `list_skills` / `get_skill` over the STATIC Copilot read
// catalog. This is the C6 skill-catalog-over-MCP pattern (the agent discovering which read-skills it can
// invoke + reading one skill's metadata). It reads ONLY the frozen `COPILOT_READ_TOOLS` from @sow/policy —
// no brain query, no vault read, no workspace data of any kind — which is exactly why the two tools are
// classified `workspace-agnostic` (there is nothing to scope and no cross-workspace leak is possible).
//
// TWO invariants beyond "returns the catalog":
//  (1) It NEVER enumerates or reveals the write-PROPOSING tool. `list` projects only `COPILOT_READ_TOOLS`
//      (the propose tool lives in `COPILOT_PROPOSE_TOOL`, a separate export, so it is excluded by
//      construction); `get` searches only `COPILOT_READ_TOOLS`, so a request for `copilot.propose_action`
//      returns `{skill:null}`. An untrusted agent is not even told the propose capability exists — this
//      minimizes prompt-injection steering toward it (the actual grant is still gated by ING-7 + the job
//      policy regardless, so this is defense-in-depth on the INFORMATION surface, not the capability).
//  (2) It NEVER throws + fails closed. Any unexpected op / malformed args / internal fault degrades to a
//      SAFE result (an empty skill list, or a null skill) — an honest "I can see no skills" rather than an
//      error the agent might act on. §16 no-throw.
import { COPILOT_READ_TOOLS, copilotToolScopingClass } from "@sow/policy";
import type { CopilotToolScopingClass } from "@sow/policy";

/** One text block of a tool result (structurally compatible with the SDK's CallToolResult content). */
export interface CopilotSkillIntrospectTextBlock {
  readonly type: "text";
  readonly text: string;
}
/** The handler result — a single JSON text block (the MCP `{content:[{type:"text",text}]}` envelope). */
export interface CopilotSkillIntrospectResult {
  readonly content: ReadonlyArray<CopilotSkillIntrospectTextBlock>;
}

/** The public projection of one read-skill (id + human description + non-mutating flag + scoping class). */
export interface CopilotSkillDescriptor {
  readonly id: string;
  readonly description: string;
  readonly mutating: false;
  readonly scoping: CopilotToolScopingClass;
}

/** A stable, leak-safe envelope over an arbitrary JSON-able payload. */
function envelope(payload: unknown): CopilotSkillIntrospectResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** The fail-closed fallbacks: an empty list for `list`/unknown ops, a null skill for `get`. */
const SAFE_LIST = (): CopilotSkillIntrospectResult => envelope({ skills: [] });
const SAFE_GET = (): CopilotSkillIntrospectResult => envelope({ skill: null });

/** Project a frozen read-catalog spec to its public descriptor. `mutating` is pinned `false` (read catalog). */
function describeSkill(spec: (typeof COPILOT_READ_TOOLS)[number]): CopilotSkillDescriptor {
  return {
    id: String(spec.id),
    description: spec.description,
    mutating: false,
    scoping: copilotToolScopingClass(spec.id),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Handle one skill-introspection call. `op` is supplied by the MCP server (one op per tool), NOT by the model,
 * so it is trusted to be "list"|"get"; any other value fails closed to a safe empty list. `args` is the raw,
 * untrusted model input — only `get` reads it (the `id` string), and any malformed shape yields `{skill:null}`.
 * Pure + async only for signature parity with the other in-process handlers; never throws.
 */
export async function handleCopilotSkillIntrospect(
  op: string,
  args: unknown,
): Promise<CopilotSkillIntrospectResult> {
  try {
    if (op === "list") {
      return envelope({ skills: COPILOT_READ_TOOLS.map(describeSkill) });
    }
    if (op === "get") {
      if (!isRecord(args)) return SAFE_GET();
      const id = args["id"];
      if (typeof id !== "string" || id.length === 0) return SAFE_GET();
      // Search ONLY the read catalog — a request for the propose tool (or any uncataloged id) returns null,
      // never revealing a capability outside the read surface.
      const spec = COPILOT_READ_TOOLS.find((s) => String(s.id) === id);
      return envelope({ skill: spec === undefined ? null : describeSkill(spec) });
    }
    // Unknown op — fail closed to the most neutral safe result.
    return SAFE_LIST();
  } catch {
    // Defense-in-depth: the body is pure (no I/O), but keep the no-throw contract absolute. A `get`-shaped
    // fault would still round-trip safely as {skill:null}; default to the list-empty for an unknown op.
    return op === "get" ? SAFE_GET() : SAFE_LIST();
  }
}
