// §13.10 gate (a) SC1 — the WS-8 workspace-scope core (the pure, fail-closed foundation).
//
// The served gbrain brain is ONE combined store; TWO read paths cross it — the LIVE retrieval seam
// (P1) and the DORMANT agentic tool path (P2). Neither enforces workspace scope. This module is the
// shared pure core both reuse (SC2 injects it as the P1 raw-hit filter; SC5 reuses it in the P2 arg/
// result cores): it attributes a gbrain hit to a workspace, then decides keep/drop under the served
// workspace + the LegacyContentPolicy.
//
// FAIL-CLOSED IS THE INVARIANT. A mis-attribution is a WS-8 cross-workspace leak (safety rule 4), so
// EVERY ambiguous axis — empty/malformed/traversal slug, a prefix that ties two workspaces, a source_id
// that matches two — resolves to `indeterminate` ⇒ DROP, never keep. Slug attribution is segment-wise
// (boundary-correct: `personal-business` never captures `personal-business-x`).
//
// ⚠ RESIDUAL (documented, NOT solved here — see docs/planning/ws8-workspace-scoping.md A1): this core
// attributes the CONTAINER (slug/source), not the CONTENTS. A page whose slug attributes in-workspace
// but whose body verbatim quotes another workspace's content is KEPT — no runtime post-filter can catch
// that; the real mitigation is ingest-time (KnowledgeWriter classification + per-workspace source
// partitioning). Do NOT represent this module as achieving WS-8's "0 raw foreign content" on its own.
//
// PURE — no clock, no network, no randomness; never throws (§16). Descriptor-carried WorkspaceId /
// SourceId are the branded contract types; this module is policy-internal (NOT a frozen seam model).
import type { WorkspaceId, SourceId } from "@sow/contracts";

// ── the registry descriptor (split-ready: optional sourceId (Phase B) / brainId (Phase C)) ──────────

/**
 * How a workspace's brain content is attributed. `slugPrefixes` is the Phase-A lever (segment-wise
 * prefix over the RAW gbrain slug). The optional `sourceId` (Phase B, post-migration `source_id`) and
 * `brainId` (Phase C, brain-per-workspace) keep the shape forward-compatible with the deferred 3-brain
 * split WITHOUT a redesign — neither is baked in; both are absent on today's single-source brain.
 */
export interface WorkspaceScopeDescriptor {
  readonly workspaceId: WorkspaceId;
  /** Slug prefixes that attribute to this workspace, e.g. `["employer-work"]`. Matched segment-wise. */
  readonly slugPrefixes: readonly string[];
  /** Phase B: the gbrain `source_id` that maps to this workspace (authoritative over slug when present). */
  readonly sourceId?: SourceId;
  /** Phase C: the per-workspace `brainId` for a future brain split (unused by this core). */
  readonly brainId?: string;
}

/** The set of workspace scope descriptors consulted for attribution. */
export interface WorkspaceScopeRegistry {
  readonly descriptors: readonly WorkspaceScopeDescriptor[];
}

// ── attribution outcome ─────────────────────────────────────────────────────────────────────────────

/** Why a slug/hit could not be soundly attributed — always fail-closed (⇒ drop). Stable, redaction-safe. */
export type AttributionCause = "SLUG_EMPTY" | "SLUG_MALFORMED" | "SLUG_AMBIGUOUS" | "SOURCE_AMBIGUOUS";

/** The result of attributing a slug/hit to a workspace. */
export type WorkspaceAttribution =
  | { readonly kind: "workspace"; readonly workspaceId: WorkspaceId; readonly via: "sourceId" | "slugPrefix" }
  | { readonly kind: "legacy" }
  | { readonly kind: "indeterminate"; readonly cause: AttributionCause };

/** A minimal view of a gbrain hit for scoping: its RAW slug + optional RAW source_id (pre-normalize). */
export interface ScopeHit {
  readonly slug: string;
  readonly sourceId?: string;
}

// ── legacy policy + keep/drop decision ───────────────────────────────────────────────────────────────

/**
 * What to do with a hit that attributes to NO registered workspace (legacy/unprefixed content).
 * `deny` (default) drops it — airtight but kills the live path until a migration attributes the pages.
 * `assign` treats legacy as `toWorkspaceId` AND serves it ONLY when that IS the served workspace (so it
 * never crosses to another workspace). `assign` is a transitional bridge, sound only while the brain
 * holds a single workspace's unprefixed content (see the runbook + design doc for the exit criterion).
 */
export type LegacyContentPolicy =
  | { readonly mode: "deny" }
  | { readonly mode: "assign"; readonly toWorkspaceId: WorkspaceId };

/** Why a hit was dropped (stable, redaction-safe cause — never carries slug/body content). */
export type HitDropReason =
  | "FOREIGN_WORKSPACE"
  | "LEGACY_DENIED"
  | "LEGACY_NOT_SERVED"
  | "SLUG_INDETERMINATE";

/** The keep/drop decision for one hit under a served workspace. */
export type HitScopeDecision =
  | { readonly decision: "keep" }
  | { readonly decision: "drop"; readonly reason: HitDropReason };

// ── slug hygiene (fail-closed; charCode Set, NOT a regex — LESSONS §normalizer Unicode-in-regex trap) ──

const CONTROL_MAX = 0x1f;
const DEL = 0x7f;

/** A stable fault for a malformed/empty raw slug, or null when the slug is structurally acceptable. */
function slugFault(slug: string): "SLUG_EMPTY" | "SLUG_MALFORMED" | null {
  if (typeof slug !== "string" || slug.trim().length === 0) return "SLUG_EMPTY";
  if (slug !== slug.trim()) return "SLUG_MALFORMED"; // leading/trailing whitespace
  if (slug.startsWith("/")) return "SLUG_MALFORMED"; // absolute
  if (slug.includes("//")) return "SLUG_MALFORMED"; // empty internal segment
  if (slug.includes("\\")) return "SLUG_MALFORMED"; // backslash (Windows path / escape)
  for (let i = 0; i < slug.length; i++) {
    const c = slug.charCodeAt(i);
    if (c <= CONTROL_MAX || c === DEL) return "SLUG_MALFORMED"; // control chars
  }
  for (const seg of slug.split("/")) {
    if (seg === "." || seg === "..") return "SLUG_MALFORMED"; // path traversal / current-dir
    if (seg !== seg.trim()) return "SLUG_MALFORMED"; // per-segment whitespace
  }
  return null;
}

/** The non-empty path segments of a slug/prefix (drops a benign trailing slash). */
function segmentsOf(s: string): string[] {
  return s.split("/").filter((seg) => seg.length > 0);
}

/**
 * Does `prefixSegs` match the head of `slugSegs` on a SEGMENT boundary? Returns the matched segment
 * count (0 = no match). Segment-wise so `personal-business` (1 seg) matches `personal-business/x` but
 * NOT `personal-business-x/y` (the first segments differ).
 */
function prefixMatchLen(slugSegs: readonly string[], prefixSegs: readonly string[]): number {
  if (prefixSegs.length === 0 || prefixSegs.length > slugSegs.length) return 0;
  for (let i = 0; i < prefixSegs.length; i++) {
    if (slugSegs[i] !== prefixSegs[i]) return 0;
  }
  return prefixSegs.length;
}

// ── attribution ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Attribute a RAW gbrain slug to a workspace by longest registered slug prefix (segment-wise). No match
 * ⇒ `legacy`. Empty/malformed ⇒ `indeterminate` (fail-closed). A tie between DIFFERENT workspaces on the
 * longest match ⇒ `indeterminate` (SLUG_AMBIGUOUS) — a registry misconfig must never silently pick one.
 */
export function attributeSlug(slug: string, registry: WorkspaceScopeRegistry): WorkspaceAttribution {
  const fault = slugFault(slug);
  if (fault !== null) return { kind: "indeterminate", cause: fault };

  const slugSegs = segmentsOf(slug);
  let bestLen = 0;
  let bestWorkspace: WorkspaceId | null = null;
  let tiedAcrossWorkspaces = false;

  for (const d of registry.descriptors) {
    let dLen = 0;
    for (const prefix of d.slugPrefixes) {
      const len = prefixMatchLen(slugSegs, segmentsOf(prefix));
      if (len > dLen) dLen = len;
    }
    if (dLen === 0) continue;
    if (dLen > bestLen) {
      bestLen = dLen;
      bestWorkspace = d.workspaceId;
      tiedAcrossWorkspaces = false;
    } else if (dLen === bestLen && d.workspaceId !== bestWorkspace) {
      tiedAcrossWorkspaces = true;
    }
  }

  if (bestWorkspace === null) return { kind: "legacy" };
  if (tiedAcrossWorkspaces) return { kind: "indeterminate", cause: "SLUG_AMBIGUOUS" };
  return { kind: "workspace", workspaceId: bestWorkspace, via: "slugPrefix" };
}

/**
 * Attribute a hit source_id-FIRST (Phase B, authoritative when a descriptor carries a matching sourceId)
 * then fall back to slug attribution (Phase A). A source_id matching TWO different workspaces ⇒
 * `indeterminate` (SOURCE_AMBIGUOUS, fail-closed). A source_id matching none is not a fault — it just
 * defers to the slug.
 */
export function attributeHit(hit: ScopeHit, registry: WorkspaceScopeRegistry): WorkspaceAttribution {
  const src = hit.sourceId;
  if (typeof src === "string" && src.length > 0) {
    let matched: WorkspaceId | null = null;
    let ambiguous = false;
    for (const d of registry.descriptors) {
      if (d.sourceId !== undefined && String(d.sourceId) === src) {
        if (matched !== null && d.workspaceId !== matched) ambiguous = true;
        matched = d.workspaceId;
      }
    }
    if (ambiguous) return { kind: "indeterminate", cause: "SOURCE_AMBIGUOUS" };
    if (matched !== null) return { kind: "workspace", workspaceId: matched, via: "sourceId" };
  }
  return attributeSlug(hit.slug, registry);
}

// ── the keep/drop decision ────────────────────────────────────────────────────────────────────────────

/**
 * Decide keep/drop for one hit under the served workspace + the LegacyContentPolicy. Keep ONLY when the
 * hit attributes to the served workspace, or it is legacy under `{assign,X}` with `servedWorkspaceId===X`.
 * Everything else drops with a stable reason. Fail-closed on indeterminate. Pure + deterministic.
 */
export function decideHitScope(
  hit: ScopeHit,
  servedWorkspaceId: WorkspaceId,
  registry: WorkspaceScopeRegistry,
  policy: LegacyContentPolicy,
): HitScopeDecision {
  const attribution = attributeHit(hit, registry);

  switch (attribution.kind) {
    case "indeterminate":
      return { decision: "drop", reason: "SLUG_INDETERMINATE" };
    case "workspace":
      return attribution.workspaceId === servedWorkspaceId
        ? { decision: "keep" }
        : { decision: "drop", reason: "FOREIGN_WORKSPACE" };
    case "legacy":
      if (policy.mode === "deny") return { decision: "drop", reason: "LEGACY_DENIED" };
      // assign: rescue legacy ONLY for its own served workspace, so it never crosses to another.
      return policy.toWorkspaceId === servedWorkspaceId
        ? { decision: "keep" }
        : { decision: "drop", reason: "LEGACY_NOT_SERVED" };
  }
}

// ── the shared scope context (threaded through the P1 filter + the P2 arg/result cores) ───────────────

/**
 * The workspace-scope context: the served workspace + the registry + the legacy policy. Bundled so the P1
 * filter (SC2) and the P2 arg-policer/result-redactor (SC5) thread ONE value. `servedWorkspaceId` is always
 * server-bound (never model/client input).
 */
export interface CopilotWorkspaceScope {
  readonly servedWorkspaceId: WorkspaceId;
  readonly registry: WorkspaceScopeRegistry;
  readonly policy: LegacyContentPolicy;
  /**
   * Whether the served brain is per-workspace-partitioned (Phase B source_id / Phase C brain-per-workspace).
   * Absent/false ⇒ the ONE combined brain today: the arg policer independently DENIES the `unscopable`
   * whole-brain tools (defense-in-depth over SC4's allow-list). True ⇒ the server scopes the computation, so
   * they are permitted. Fail-closed default: treat absent as false.
   */
  readonly brainPartitioned?: boolean;
}

/** The registered descriptor for a workspace, or `undefined` if unregistered. Pure. */
export function descriptorFor(
  registry: WorkspaceScopeRegistry,
  ws: WorkspaceId,
): WorkspaceScopeDescriptor | undefined {
  return registry.descriptors.find((d) => d.workspaceId === ws);
}

/**
 * The served workspace's SINGLE slug-prefix, or `null` if it has zero or more-than-one prefix (ambiguous ⇒
 * do not force a scope arg — the result redactor still filters per-hit as defense-in-depth). Pure.
 */
export function singleSlugPrefixOf(scope: CopilotWorkspaceScope): string | null {
  const d = descriptorFor(scope.registry, scope.servedWorkspaceId);
  return d !== undefined && d.slugPrefixes.length === 1 ? d.slugPrefixes[0]! : null;
}
