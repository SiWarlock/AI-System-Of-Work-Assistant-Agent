// LinkHealer (§6 KN-11 governed auto-link + entity convergence; 13.8b) — the 2nd ARC-4
// living-vault synthesis keystone. The governed port of osb's `heal_links.py`: given a
// source note's Title→slug references + the workspace's existing note candidates, emit a
// corrective forward-link `LinkMutation{op:'add', srcPath, dstSlug}` ONLY on a FAITHFUL /
// unambiguous slug match; a lossy (`C++`→`c`), fuzzy, or 2+-candidate reference is WITHHELD
// to a proposed clarification — never auto-healed, never a fabricated/arbitrary link.
//
// SAFETY:
//  · Rule 1 (one writer / no hidden brain): a heal is KMP-admissible `LinkMutation` DATA
//    the confined planner (13.8c) folds into a `KnowledgeMutationPlan` → KnowledgeWriter.
//    This module NEVER writes Markdown (no fs / no writer dependency).
//  · KN-11 backlinks are NEVER authored here — every heal writes the SOURCE note's forward
//    link only; backlinks are derived READ-ONLY via GBrain `get_backlinks` at consume time.
//  · Rule 4 (WS-8) defense-in-depth: a candidate carrying a foreign `workspaceId` is DROPPED
//    (13.8c passes workspace-scoped candidates; this is belt-and-suspenders, mirrors 13.8a).
//
// Match strictness reuses 13.8a's discipline via the shared `./match-keys` (fold em/en-dashes;
// spaces≠hyphens — a match only under lossy slugification is withheld, Lesson 17: one predicate).
// PURE + deterministic over the PASSED candidates (no I/O port — 13.8c does the GBrain read);
// TOTAL never-throws (malformed input → fail-safe skip/withheld/empty, never a throw — Lesson 11).
import type { LinkMutation, WorkspaceId } from "@sow/contracts";
import type { EntityCandidate } from "./entity-resolver";
import { faithfulKey, entitySlug, identifiers } from "./match-keys";

/** A referenced entity inside a source note that may need healing: its display Title. */
export interface LinkRef {
  readonly title: string;
}

/** Why a reference was WITHHELD from auto-healing (code-only, redaction-safe — rule 7). */
export type LinkWithheldReason =
  | "ambiguous" // 2+ distinct candidates faithfully match — never arbitrary-picks
  | "lossy_match" // matches only under lossy slugification (`C++`→`c`) — never a guess
  | "no_candidate" // no faithful and no lossy candidate — nothing to heal to (incl. fuzzy near-miss)
  | "malformed_ref"; // no usable faithful key (empty/whitespace-only) — never fabricated

/**
 * Per-reference outcome: a corrective forward-link heal (a KMP-admissible `LinkMutation`),
 * or a withheld proposed clarification (distinct from a heal — mirrors 13.8a's withhold shape).
 */
export type LinkHeal =
  | { readonly kind: "healed"; readonly mutation: LinkMutation }
  | { readonly kind: "withheld"; readonly ref: string; readonly reason: LinkWithheldReason };

/** Read a ref's title as a usable string, or `undefined` (structurally malformed ⇒ skip). Never throws. */
function readTitle(r: LinkRef): string | undefined {
  try {
    if (r == null) return undefined;
    const t = r.title;
    return typeof t === "string" ? t : undefined;
  } catch {
    return undefined;
  }
}

/** A shape + WS-8 guard over ONE untrusted candidate row; drops (never throws on) a hostile/foreign row. */
function safeCandidate(c: EntityCandidate, workspaceId: WorkspaceId): EntityCandidate | undefined {
  try {
    if (
      c != null &&
      typeof c.path === "string" &&
      c.path.length > 0 &&
      typeof c.slug === "string" &&
      c.slug.length > 0 &&
      c.workspaceId === workspaceId
    ) {
      return c;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Heal a source note's Title-references to canonical forward links — a `LinkMutation{op:'add'}`
 * per faithful/unambiguous match, a withheld clarification otherwise. Pure over the passed
 * candidates; TOTAL never-throws; backlinks are never authored.
 */
export function healLinks(
  srcPath: string,
  refs: readonly LinkRef[],
  candidates: readonly EntityCandidate[],
  workspaceId: WorkspaceId,
): readonly LinkHeal[] {
  // Fail-safe empty on unusable input (never throws): a non-string/empty srcPath would build a
  // mutation that fails the KMP candidate-data gate (`LinkMutation.srcPath: z.string().min(1)`),
  // so refuse to emit rather than hand the planner an inadmissible heal.
  if (typeof srcPath !== "string" || srcPath.length === 0) return [];
  if (!Array.isArray(refs) || !Array.isArray(candidates)) return [];

  const out: LinkHeal[] = [];
  try {
    // WS-8 re-gate + shape guard — drop foreign-workspace or malformed candidate rows (Lesson 11).
    const valid = candidates
      .map((c) => safeCandidate(c, workspaceId))
      .filter((c): c is EntityCandidate => c !== undefined);

    // Heals dedupe by dstSlug (srcPath is constant per call); WITHHELD entries do NOT dedupe — each
    // ref occurrence is a distinct unresolved reference the 13.8c planner may surface separately.
    const emittedSlugs = new Set<string>();

    for (const r of refs) {
      try {
        const title = readTitle(r);
        if (title === undefined) continue; // structurally malformed ref ⇒ skip (can't even name it)

        const key = faithfulKey(title);
        if (key === "") {
          out.push({ kind: "withheld", ref: title, reason: "malformed_ref" });
          continue;
        }

        // Faithful match — heal iff exactly ONE DISTINCT target matches. Counted by dst SLUG (not by
        // path as 13.8a's resolver does): the heal's output IS a slug, so two notes sharing a slug are
        // one unambiguous heal target, whereas the resolver returns a PATH and must treat them as ambiguous.
        const matches = valid.filter((c) => identifiers(c).some((id) => faithfulKey(id) === key));
        const matchedSlugs = new Set(matches.map((c) => c.slug));
        if (matchedSlugs.size === 1) {
          const dstSlug = matches[0]!.slug;
          if (!emittedSlugs.has(dstSlug)) {
            emittedSlugs.add(dstSlug);
            out.push({ kind: "healed", mutation: { op: "add", srcPath, dstSlug } });
          }
          continue;
        }
        if (matchedSlugs.size >= 2) {
          out.push({ kind: "withheld", ref: title, reason: "ambiguous" });
          continue;
        }

        // No faithful match — a lossy collision with an existing note ⇒ withhold (never a guess);
        // else nothing to heal to (no candidate / fuzzy near-miss).
        const refSlug = entitySlug(title);
        const collides = refSlug !== "" && valid.some((c) => identifiers(c).some((id) => entitySlug(id) === refSlug));
        out.push({ kind: "withheld", ref: title, reason: collides ? "lossy_match" : "no_candidate" });
      } catch {
        // A single hostile ref/candidate interaction never aborts the batch — skip it.
        continue;
      }
    }
  } catch {
    // Fail-safe: return whatever heals were already collected (never throws).
  }
  return out;
}
