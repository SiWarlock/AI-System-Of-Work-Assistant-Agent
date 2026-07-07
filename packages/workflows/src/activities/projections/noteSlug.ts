// Shared note-filename sanitizer for the projection activities (meeting-closeout + projectSync). SECURITY-
// CRITICAL: the vault does `join(root, note.path)` VERBATIM and the KnowledgeWriter commit gate does NOT check
// that note.path lies inside the plan's workspace tree — so the projection is the SOLE enforcer of path safety.
// `safeNoteSlug` collapses every non-alphanumeric run (INCLUDING "/" and ".") to a single hyphen, so the result
// contains NO separator and NO `..` and can never inject path structure or escape the bound workspace folder.
// A value that slugs to empty (all-punctuation, e.g. "../..") has NO safe anchor → the caller MUST fail closed
// (never a note written to an unintended path). Extracted so meeting-closeout + projectSync share ONE
// adversarially-verified implementation rather than each duplicating (and risking drift on) this gate.
import type { WorkspaceId } from "@sow/contracts";

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
