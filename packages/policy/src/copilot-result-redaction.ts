// §13.10 gate (a) SC5b — the P2 RESULT redactor (the load-bearing WS-8 result guard).
//
// The agentic Copilot (DORMANT behind copilotAgentMode) calls gbrain read tools; their RESULTS carry
// per-hit workspace-attributable slugs. SC5a's arg policer NARROWS a call but cannot GUARANTEE scoped
// results (a slug-substring/prefix arg still returns cross-workspace rows over the one combined brain).
// This pure redactor runs per tool RESULT (wired by SC6/SC7 as a PostToolUse / in-process-proxy step)
// and rewrites the MCP result envelope so only served-workspace content survives, folding the three
// RESULT-LEAKAGE verifier findings (docs/planning/ws8-workspace-scoping.md):
//   • A2 (traverse_graph) — a node-only filter leaks: drop foreign NODES by slug AND, on each kept node,
//     drop edges whose TARGET slug is foreign and strip the edge `context` string (it may quote a foreign body).
//   • A3 (find_contradictions) — drop a pair if EITHER side is foreign OR unattributable (FAIL-CLOSED
//     far-side: a side with only a page_id/title and no in-workspace slug ⇒ treated as foreign ⇒ pair dropped).
//   • A4 (find_contradictions) — strip `resolution_command` and every page/title-naming field; keep only
//     severity / axis / confidence + opaque in-workspace slug refs.
// Everything else (search / get_recent_salience) is a generic per-hit slug filter. get_timeline is an
// in-workspace-seed read (SC5a already denied a foreign seed; entries carry no re-attributable slug).
//   • F2 (field-fidelity) — EVERY kept item (hit, traverse_graph node/edge, timeline entry) is reduced to its
//     own-content strings + scalars via `allowItemFields`; every structural foreign-ref carrier (a nested
//     object, an array of refs, a foreign-slug string under a non-allow-listed key, an edge free-text beyond
//     the scrubbed `context`) is DROPPED. Schema-agnostic, so it needs no pinned per-op gbrain result schema.
// An `unscopable` whole-brain op (find_experts/anomalies/orphans, takes_*, code_*) has no per-item slug, so on
// a NON-partitioned brain the redactor DROPS-ALL independently (mirrors SC5a's M2) — a genuine last-line guard
// that never leans on SC4's allow-list or SC5a's arg deny having kept it out.
//
// FAIL-CLOSED IS THE INVARIANT. An unknown/mutating tool, a malformed envelope, unparseable JSON, or a
// payload of the wrong shape ⇒ DROP-ALL: return an EMPTY envelope (`{content:[]}`), NEVER the raw result.
// Reuses SC1's decideHitScope + CopilotWorkspaceScope. PURE — no clock/network/randomness; never throws
// (JSON.parse is the only throw source and it is caught); never returns null. Cause codes are stable and
// redaction-safe (never carry a slug or body content).
import { toolId } from "@sow/contracts";
import type { ToolId } from "@sow/contracts";
import { isMutatingCopilotTool, copilotToolScopingClass } from "./copilot-tool-catalog";
import { decideHitScope } from "./copilot-workspace-scope";
import type { CopilotWorkspaceScope } from "./copilot-workspace-scope";

/** Why the whole result was dropped fail-closed (stable, redaction-safe — never carries slug/body content). */
export type RedactionCause = "UNKNOWN_TOOL" | "UNSCOPABLE_TOOL" | "MALFORMED_ENVELOPE" | "UNPARSEABLE_JSON" | "MALFORMED_PAYLOAD";

/** The MCP tool-result envelope shape the Copilot forwards to the model (gbrain's live shape). */
export interface McpToolResultEnvelope {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
}

/** The redactor's output: a safe-to-forward envelope + audit counters. `output` NEVER carries foreign content. */
export interface RedactedToolResult {
  /** Always a safe envelope to forward — the re-serialized filtered payload, or `{content:[]}` on fail-close. */
  readonly output: McpToolResultEnvelope;
  /** Top-level items (hits / nodes / pairs) removed by the filter. Best-effort; `failClosed` is authoritative. */
  readonly dropped: number;
  /** True when the whole result was dropped fail-closed (malformed/unparseable/unknown tool/wrong shape). */
  readonly failClosed: boolean;
  /** Present only when `failClosed` — why the drop-all happened. */
  readonly cause?: RedactionCause;
}

const GBRAIN_MCP_PREFIX = "mcp__gbrain__";
/** The canonical fail-closed output: an empty content list (valid MCP; nothing to leak). Double-freeze — `content` too. */
const EMPTY_ENVELOPE: McpToolResultEnvelope = Object.freeze({ content: Object.freeze([]) });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Map a gbrain MCP tool name (`mcp__gbrain__<op>`) to its catalog ToolId + op, or `null` if it is not a known
 * gbrain READ op. `query` is gbrain's semantic-search tool (`gbrain.search` in the catalog). A mutating/unknown
 * op ⇒ `null` (fail-safe — `isMutatingCopilotTool` treats an uncataloged id as mutating). Non-gbrain tools ⇒ `null`.
 */
function gbrainReadToolOf(mcpToolName: string): { readonly op: string; readonly id: ToolId } | null {
  if (!mcpToolName.startsWith(GBRAIN_MCP_PREFIX)) return null;
  const op = mcpToolName.slice(GBRAIN_MCP_PREFIX.length);
  if (op.length === 0) return null;
  const id = toolId(op === "query" ? "gbrain.search" : `gbrain.${op}`);
  return isMutatingCopilotTool(id) ? null : { op, id };
}

function failClosed(cause: RedactionCause, dropped = 0): RedactedToolResult {
  return { output: EMPTY_ENVELOPE, dropped, failClosed: true, cause };
}

/** Wrap a filtered payload back into the MCP text envelope. */
function envelopeOf(payload: unknown): McpToolResultEnvelope {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** Pull the first `type:"text"` content item's string text, or `null` if the envelope shape is wrong. */
function extractPayloadText(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const content = result["content"];
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (isRecord(item) && item["type"] === "text" && typeof item["text"] === "string") return item["text"];
  }
  return null;
}

/** Keep-decision for one hit-like object, attributing by its `slug` (+ optional `source_id`). Fail-closed. */
function keepHit(o: unknown, scope: CopilotWorkspaceScope): boolean {
  const slug = isRecord(o) && typeof o["slug"] === "string" ? o["slug"] : "";
  const sourceId = isRecord(o) && typeof o["source_id"] === "string" ? o["source_id"] : undefined;
  return decideHitScope({ slug, sourceId }, scope.servedWorkspaceId, scope.registry, scope.policy).decision === "keep";
}

/** Keep-decision for a bare slug string (find_contradictions sides, traverse_graph edge targets). Fail-closed. */
function keepSlug(slug: string, scope: CopilotWorkspaceScope): boolean {
  return decideHitScope({ slug }, scope.servedWorkspaceId, scope.registry, scope.policy).decision === "keep";
}

/** A find_contradictions side may be a bare slug string OR an object `{slug,…}`; extract its slug (else ""). */
function sideSlug(side: unknown): string {
  if (typeof side === "string") return side;
  if (isRecord(side) && typeof side["slug"] === "string") return side["slug"];
  return "";
}

// ── F2 field-fidelity — reduce a KEPT item to own-content strings + scalars (gate-(c) closure) ─────────

/** A kept hit/node's own-content STRING fields (identity + body). Any OTHER string is a potential foreign ref. */
const HIT_KEEP_STRINGS: ReadonlySet<string> = new Set(["slug", "title", "chunk_text", "summary", "content", "text"]);
/**
 * A kept EDGE keeps NO raw strings. Its single VALIDATED in-workspace target is re-added canonically under `to`
 * (see `redactNodeLinks`), so every edge string drops: `context`/`snippet` free-text, relationship labels, AND
 * an UNVALIDATED `target`/`to` ALIAS key (`edgeTarget` scope-checks only ONE key, so keeping a raw second alias
 * could forward a foreign slug — the dual-alias-key leak). Scalars still pass (they carry no ref).
 */
const EDGE_KEEP_STRINGS: ReadonlySet<string> = new Set<string>();
/**
 * A get_timeline entry's own-content strings. A container / other-string (a structural foreign ref) drops. These
 * kept strings (`summary`/`detail`/`source`/`title`) are user-authored free-text, so — like a hit's `chunk_text`
 * body — they carry the ACCEPTED A1 residual (own text may NAME another workspace); A1 is an ingest-time fix, not
 * F2's structural-carrier surface. Timeline has NO per-entry slug to attribute, so nothing more can be validated here.
 */
const TIMELINE_KEEP_STRINGS: ReadonlySet<string> = new Set(["date", "summary", "detail", "source", "title"]);

/**
 * F2 FIELD-FIDELITY — reduce a KEPT (already scope-attributed in-workspace) item to a WS-8-safe field set: keep
 * the allow-listed OWN-content STRINGS + EVERY numeric/boolean scalar (a number/boolean cannot encode a
 * followable foreign ref or raw foreign body), and DROP every array, every nested object, and every
 * non-allow-listed string — the structural foreign-ref carriers (a `backlinks`/`related`/`neighbors` array, a
 * nested foreign node, a `related_to` slug string, a foreign-quoting `snippet`/`excerpt` beyond the scrubbed
 * `context`). This closes the F2 residual the module noted (a kept item was forwarded WHOLE).
 *
 * SCHEMA-AGNOSTIC by design: an unknown scalar survives harmlessly, an unknown container/string drops — so it
 * needs NO pinned per-op gbrain result schema (the blocker the carry-forward named), and it is ROBUST to gbrain
 * adding fields (a new ref field drops; a new number survives). Keeping scalars is sound: a bare number/boolean
 * is not raw content and is not a ref the scoped tools can dereference (they take slug/query, and any result is
 * re-scoped). Pure; builds a NEW object (no mutation).
 */
function allowItemFields(item: Record<string, unknown>, keepStrings: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && keepStrings.has(k)) out[k] = v;
    // arrays, nested objects, null/undefined, and non-allow-listed strings ⇒ DROPPED (foreign-ref carriers)
  }
  return out;
}

/**
 * Scope a gbrain tool RESULT to the served workspace, folding A2/A3/A4. Pure; never throws; never returns null.
 * @param mcpToolName the live MCP tool name (e.g. `mcp__gbrain__query`); a non-gbrain/mutating/unknown name fail-closes.
 * @param result the raw MCP result envelope (`{content:[{type:"text",text:"<JSON>"}]}`); any other shape fail-closes.
 * @param scope the server-bound served workspace + registry + legacy policy.
 */
export function redactGbrainToolResult(
  mcpToolName: unknown,
  result: unknown,
  scope: CopilotWorkspaceScope,
): RedactedToolResult {
  if (typeof mcpToolName !== "string") return failClosed("UNKNOWN_TOOL");
  const tool = gbrainReadToolOf(mcpToolName);
  if (tool === null) return failClosed("UNKNOWN_TOOL");

  // Independent last-line guard (mirrors SC5a's M2): an `unscopable` whole-brain op (find_experts/anomalies/
  // orphans, takes_*, code_*) has NO per-item slug to filter on, so on a NON-partitioned brain the redactor
  // DROPS-ALL rather than trust the generic per-hit filter — never depending on SC4's allow-list or SC5a's
  // arg deny to have kept it out. A partitioned brain scopes the computation server-side ⇒ permitted.
  if (copilotToolScopingClass(tool.id) === "unscopable" && scope.brainPartitioned !== true) {
    return failClosed("UNSCOPABLE_TOOL");
  }

  const text = extractPayloadText(result);
  if (text === null) return failClosed("MALFORMED_ENVELOPE");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failClosed("UNPARSEABLE_JSON");
  }

  switch (tool.op) {
    case "traverse_graph":
      return redactTraverseGraph(parsed, scope);
    case "find_contradictions":
      return redactContradictions(parsed, scope);
    case "get_timeline":
      return redactTimeline(parsed);
    default:
      // search / get_recent_salience and any other slug-keyed read: generic per-hit filter + F2 field-fidelity
      // (a kept hit is reduced to own-content + scalars, so a nested foreign ref cannot ride along — the
      // carry-forward the module used to name here is now CLOSED by `allowItemFields`, schema-agnostically).
      return redactHitCollection(parsed, scope);
  }
}

/**
 * Generic per-hit slug filter (search / get_recent_salience): drop foreign hits, and F2-reduce each KEPT hit to
 * its own-content + scalars (a nested foreign ref under a non-allow-listed key cannot ride along). Non-array
 * payload ⇒ fail-closed.
 */
function redactHitCollection(parsed: unknown, scope: CopilotWorkspaceScope): RedactedToolResult {
  if (!Array.isArray(parsed)) return failClosed("MALFORMED_PAYLOAD");
  const kept: unknown[] = [];
  let dropped = 0;
  for (const h of parsed) {
    if (!keepHit(h, scope)) {
      dropped++;
      continue;
    }
    // F2: a kept hit is an in-workspace object (keepHit drops non-objects via an empty slug) — reduce its fields.
    kept.push(isRecord(h) ? allowItemFields(h, HIT_KEEP_STRINGS) : h);
  }
  return { output: envelopeOf(kept), dropped, failClosed: false };
}

/**
 * A2 + F2 — traverse_graph: drop foreign NODES by slug; F2-reduce each kept node to own-content + scalars; on
 * each kept node, drop edges whose TARGET slug is foreign and reduce each survivor to its in-workspace target
 * ref. Non-array payload ⇒ fail-closed.
 */
function redactTraverseGraph(parsed: unknown, scope: CopilotWorkspaceScope): RedactedToolResult {
  if (!Array.isArray(parsed)) return failClosed("MALFORMED_PAYLOAD");
  let dropped = 0;
  const kept: unknown[] = [];
  for (const node of parsed) {
    if (!keepHit(node, scope)) {
      dropped++;
      continue;
    }
    kept.push(redactNodeLinks(node, scope));
  }
  return { output: envelopeOf(kept), dropped, failClosed: false };
}

/**
 * F2 + A2 — reduce a kept node to own-content + scalars (dropping backlinks/neighbors/nested + any non-`links`
 * foreign ref), then re-attach a filtered `links[]`: drop foreign-target edges and F2-reduce each survivor to
 * its in-workspace target ref (`to`/`target`) + scalars — which also drops the edge `context` and any
 * `snippet`/`excerpt` free-text. Copy — no mutation.
 */
function redactNodeLinks(node: unknown, scope: CopilotWorkspaceScope): unknown {
  if (!isRecord(node)) return node;
  const scrubbedNode = allowItemFields(node, HIT_KEEP_STRINGS); // F2: own-content + scalars only (drops `links` too)
  const links = node["links"];
  if (links === undefined) return scrubbedNode; // no edges to filter
  // FAIL-CLOSED: a present-but-non-array `links` is an unrecognized shape that could embed foreign edges/context
  // (e.g. `links:{to:"employer-work/x",context:"…"}`). NEUTRALIZE it to `[]` — keep the in-workspace node, never
  // forward the malformed blob. (Returning the node verbatim here would be a fail-OPEN leak.)
  if (!Array.isArray(links)) return { ...scrubbedNode, links: [] };
  const filtered = links
    .filter((lnk) => keepSlug(edgeTarget(lnk), scope))
    .map((lnk) => {
      // A survivor's target was validated in-workspace by keepSlug(edgeTarget); `lnk` is therefore a record (a
      // non-record's edgeTarget is "" ⇒ dropped above, so `: lnk` is unreachable — kept only for TS narrowing).
      // Re-emit the VALIDATED target canonically under `to` + keep scalars only: this drops context/snippet/
      // link_type AND any UNVALIDATED second alias key (edgeTarget checks only one), closing the dual-key leak.
      const target = edgeTarget(lnk);
      return isRecord(lnk) ? { ...allowItemFields(lnk, EDGE_KEEP_STRINGS), to: target } : lnk;
    });
  return { ...scrubbedNode, links: filtered };
}

/** An edge's target slug lives in `to` (or `target`); missing/non-string ⇒ "" ⇒ dropped (fail-closed). */
function edgeTarget(lnk: unknown): string {
  if (!isRecord(lnk)) return "";
  if (typeof lnk["to"] === "string") return lnk["to"];
  if (typeof lnk["target"] === "string") return lnk["target"];
  return "";
}

/**
 * A3 + A4 — find_contradictions: drop a pair if EITHER side is foreign/unattributable (fail-closed far-side),
 * then strip every naming field, keeping only severity/axis/confidence + opaque in-workspace slug refs.
 * Non-object / missing-array payload ⇒ fail-closed.
 */
function redactContradictions(parsed: unknown, scope: CopilotWorkspaceScope): RedactedToolResult {
  if (!isRecord(parsed) || !Array.isArray(parsed["contradictions"])) return failClosed("MALFORMED_PAYLOAD");
  const pairs = parsed["contradictions"];
  const kept: Array<Record<string, unknown>> = [];
  let dropped = 0;
  for (const pair of pairs) {
    if (!isRecord(pair)) {
      dropped++;
      continue;
    }
    const aSlug = sideSlug(pair["a"]);
    const bSlug = sideSlug(pair["b"]);
    // A3: BOTH sides must attribute to the served workspace — an unattributable side (empty slug) fails closed.
    if (!keepSlug(aSlug, scope) || !keepSlug(bSlug, scope)) {
      dropped++;
      continue;
    }
    kept.push(a4Strip(pair, aSlug, bSlug));
  }
  return { output: envelopeOf({ contradictions: kept }), dropped, failClosed: false };
}

/**
 * A4 — reduce a kept (both-sides-in-workspace) pair to only severity/axis/confidence + opaque in-workspace slug
 * refs. Drops `resolution_command` (embeds page paths) and every side title/path-naming field.
 */
function a4Strip(pair: Record<string, unknown>, aSlug: string, bSlug: string): Record<string, unknown> {
  const out: Record<string, unknown> = { a: aSlug, b: bSlug };
  for (const k of ["severity", "axis", "confidence"] as const) {
    if (pair[k] !== undefined) out[k] = pair[k];
  }
  return out;
}

/**
 * get_timeline: an in-workspace-seed read. SC5a's arg policer already DENIED a foreign seed slug
 * (FOREIGN_SEED_DENIED), so the entries are the served workspace's own page history — and the entries carry no
 * per-row slug to re-attribute. F2 defense-in-depth: reduce each entry to its own-content + scalars, so a
 * structural foreign ref on an entry (a `related_pages` array, a nested `meta` object) cannot ride along.
 * Fail-closed on a non-array shape.
 */
function redactTimeline(parsed: unknown): RedactedToolResult {
  if (!Array.isArray(parsed)) return failClosed("MALFORMED_PAYLOAD");
  // Timeline entries have no per-row slug to attribute, so there is no keep-gate before this reduction (unlike
  // the hit/edge paths). A NON-record entry (a bare string/array that could itself carry a foreign ref) is
  // therefore DROPPED here — never forwarded raw — so EVERY forwarded entry is a field-reduced object.
  const records = parsed.filter(isRecord);
  const scrubbed = records.map((e) => allowItemFields(e, TIMELINE_KEEP_STRINGS));
  return { output: envelopeOf(scrubbed), dropped: parsed.length - records.length, failClosed: false };
}
