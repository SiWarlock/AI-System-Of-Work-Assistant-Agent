// Shared note-filename sanitizer for the projection activities (meeting-closeout + projectSync). SECURITY-
// CRITICAL: the vault does `join(root, note.path)` VERBATIM and the KnowledgeWriter commit gate does NOT check
// that note.path lies inside the plan's workspace tree — so the projection is the SOLE enforcer of path safety.
// `safeNoteSlug` collapses every non-alphanumeric run (INCLUDING "/" and ".") to a single hyphen, so the result
// contains NO separator and NO `..` and can never inject path structure or escape the bound workspace folder.
// A value that slugs to empty (all-punctuation, e.g. "../..") has NO safe anchor → the caller MUST fail closed
// (never a note written to an unintended path). Extracted so meeting-closeout + projectSync share ONE
// adversarially-verified implementation rather than each duplicating (and risking drift on) this gate.
import type { WorkspaceId } from "@sow/contracts";
// #54 — the region-marker neutralizer is a SAFETY predicate (it is what stops content-embedded
// `kw:region` / `@generated` / `@user` strings from forging or breaking a region boundary in the
// KnowledgeWriter's `applyRegionPatch` `indexOf` or in `parseSections`/`MARKER_RE`), so it must exist
// EXACTLY ONCE. The canonical definition is `@sow/knowledge`'s `markdown-vault/sections.ts` (#51),
// CO-LOCATED with `MARKER_RE` — the grammar it defends — so the neutralizer ⊇ parser invariant, the
// ReDoS-safe matcher, and the single-pass nesting collapse are hardened in ONE place. This module
// previously carried a second, independently-maintained copy: two copies of a forgery defense drift
// silently (a hardening lands on one, the other stays exploitable, and no type error notices).
// It is RE-EXPORTED here so every existing projection call site keeps its import path unchanged.
//
// The DEEP SUBPATH is load-bearing, not incidental — do NOT "tidy" it to the `@sow/knowledge` barrel.
// `markdown-vault/sections` is PURE (it imports only `@sow/contracts`), whereas the barrel re-exports
// KnowledgeWriter + the fs vault watcher + the GBrain adapter and transitively pulls `@sow/db`/`node:fs`.
// This module is imported by the projection activities AND by the worker composition root
// (`apps/worker/src/composition/buildActivities.ts`), so widening to the barrel would drag the whole
// knowledge/db layer into those graphs for one pure string function.
import { neutralizeRegionMarkers } from "@sow/knowledge/markdown-vault/sections";

export { neutralizeRegionMarkers };

/**
 * Neutralize a MODEL-DERIVED frontmatter value before it is serialized: a `kw:region` marker in a
 * frontmatter value would (once YAML-quoted / JSON-stringified by `serializeScalar`, neither of which
 * strips `<!--`) inject a spurious region into `parseSections`, which `checkOwnership` scans over the
 * WHOLE note (frontmatter included) — a fail-closed `malformed_marker` write rejection.
 *
 * A thin DISPATCHER over the single authority `neutralizeRegionMarkers` (NOT a second neutralizer):
 * neutralizes a string, and RECURSES over an array's elements (so a `string[]` — decisions/attendees —
 * and even a nested array are covered, not relying on the extraction schema's flat-`string[]` shape);
 * any other value (a TBD sentinel, a number, `undefined`) passes through untouched. Idempotent; a clean
 * value is returned byte-identical (the common path is unchanged); never throws.
 */
export function neutralizeFrontmatterValue(value: unknown): unknown {
  if (typeof value === "string") return neutralizeRegionMarkers(value);
  if (Array.isArray(value)) return value.map((el) => neutralizeFrontmatterValue(el));
  return value;
}

export function safeNoteSlug(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
}

/**
 * WS-8 canonical project-status note path: `projects/<workspaceId>/<safeLeaf>.md`. The workspace-folder
 * segment is the SERVER-BOUND workspaceId (never a model/slug value) and the leaf is the projectId run
 * through `safeNoteSlug` (no separators / no `..` — cannot inject path structure or escape the workspace
 * folder after the vault's `join(root, note.path)`). Returns null when the projectId sanitizes to empty
 * (no safe anchor) → callers MUST fail closed. This is the SINGLE path authority shared by the projection's
 * committed mutation AND the create-vs-patch note-exists probe, so the two can never disagree on WHICH note
 * a given (workspace, project) maps to (WS-8). Stable per project (good for re-runs / the patch path).
 *
 * Defense-in-depth (LESSONS §4/§5): although the workspaceId is server-bound + registry-validated on the real
 * path, this shared authority does NOT rely on the caller alone — a workspace SEGMENT carrying a path separator
 * or `..` would let the note escape `projects/<ws>/` after the vault's `join(root, note.path)`. The `WorkspaceId`
 * brand rejects only empty/whitespace, NOT `/` or `..`, so an unsafe segment is REJECTED here → fail closed
 * (null). The segment must match the real workspace folder verbatim, so we reject (never slug/transform) it.
 */
export function projectNotePath(workspaceId: WorkspaceId, projectId: string): string | null {
  const ws = String(workspaceId);
  if (ws.length === 0 || ws.includes("/") || ws.includes("\\") || ws.includes("..")) return null;
  const leaf = safeNoteSlug(projectId);
  if (leaf.length === 0) return null;
  return `projects/${ws}/${leaf}.md`;
}

/**
 * The KN-7 assistant-region id wrapping ALL sync-mutable content of a project-status note. The SINGLE source of
 * this id: every writer of a project note (projectSync AND the §13.10a Copilot semantic-write bridge) MUST use
 * the SAME id so they all target the SAME region of the SAME file — a re-sync / re-proposal region-PATCHes it in
 * place. A drift between two writers' region ids would silently fork the note into two regions.
 */
export const PROJECT_STATUS_REGION = "project-status";

/**
 * Compose a FULL project-status note body: the `# <title> — Status` H1 human scaffold + the
 * `kw:region:project-status` assistant region wrapping `regionBody`. The marker framing
 * (`open\n${regionBody}\n${close}`) matches the KnowledgeWriter's `applyRegionPatch`, so a first-write note's
 * region and a subsequent region NotePatch (whose `newBody` is the SAME `regionBody`) are byte-identical — a
 * create-then-patch produces no region drift. Shared by projectSync + the Copilot propose bridge so the H1 +
 * marker framing stay in lockstep by CONSTRUCTION (not copy-paste).
 */
export function composeProjectStatusNote(title: string, regionBody: string): string {
  return (
    // The H1 is human scaffold OUTSIDE (before) the region — a `kw:region` marker embedded in the
    // title would be the FIRST marker `applyRegionPatch.indexOf(open)` finds, hijacking the boundary,
    // so it is neutralized too. `regionBody` arrives already neutralized from its inner-body builder.
    `# ${neutralizeRegionMarkers(title)} — Status\n\n` +
    `<!-- kw:region:${PROJECT_STATUS_REGION} -->\n` +
    regionBody +
    `\n<!-- /kw:region:${PROJECT_STATUS_REGION} -->\n`
  );
}

/**
 * WS-8 canonical meeting-note path: `meetings/<workspaceId>/<safeLeaf>.md`. The workspace-folder segment is the
 * SERVER-BOUND workspaceId (never a model value) and the leaf is the meeting title run through `safeNoteSlug`
 * (no separators / no `..` — cannot inject path structure or escape the workspace folder after the vault's
 * `join(root, note.path)`). Returns null when the title sanitizes to empty (no safe anchor) OR the workspace
 * SEGMENT is unsafe (`/`,`\`,`..`) → callers MUST fail closed. This is the SINGLE meeting path authority shared
 * by the projection's committed mutation AND the create-vs-patch note-exists probe, so the two can never check a
 * different note than they write (mirrors `projectNotePath`).
 */
export function meetingNotePath(workspaceId: WorkspaceId, rawTitle: string): string | null {
  const ws = String(workspaceId);
  if (ws.length === 0 || ws.includes("/") || ws.includes("\\") || ws.includes("..")) return null;
  const leaf = safeNoteSlug(rawTitle);
  if (leaf.length === 0) return null;
  return `meetings/${ws}/${leaf}.md`;
}

/**
 * The KN-7 assistant-region id wrapping the meeting note's committed body. A first-close NoteCreate writes this
 * region; a re-close region-PATCHes it in place (leaving frontmatter + any human content OUTSIDE the markers
 * byte-stable). The SINGLE source of the id so the create + the patch always target the SAME region.
 */
export const MEETING_OUTPUTS_REGION = "meeting-outputs";

/**
 * Compose a meeting note body: the assistant `kw:region:meeting-outputs` region wrapping `regionBody` (the full
 * meeting-closeout render — H1 + Attendees + Decisions). The marker framing (`open\n${regionBody}\n${close}`)
 * matches the KnowledgeWriter's `applyRegionPatch`, so a first-write note's region and a subsequent region
 * NotePatch (whose `newBody` is the SAME `regionBody`) are byte-identical — a create-then-re-close produces no
 * region drift. Content OUTSIDE the markers (frontmatter + any human addition) is preserved on re-close (§6/KN-7).
 */
export function composeMeetingNote(regionBody: string): string {
  return (
    `<!-- kw:region:${MEETING_OUTPUTS_REGION} -->\n` +
    regionBody +
    `\n<!-- /kw:region:${MEETING_OUTPUTS_REGION} -->\n`
  );
}
