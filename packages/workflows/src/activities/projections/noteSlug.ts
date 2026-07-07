// Shared note-filename sanitizer for the projection activities (meeting-closeout + projectSync). SECURITY-
// CRITICAL: the vault does `join(root, note.path)` VERBATIM and the KnowledgeWriter commit gate does NOT check
// that note.path lies inside the plan's workspace tree — so the projection is the SOLE enforcer of path safety.
// `safeNoteSlug` collapses every non-alphanumeric run (INCLUDING "/" and ".") to a single hyphen, so the result
// contains NO separator and NO `..` and can never inject path structure or escape the bound workspace folder.
// A value that slugs to empty (all-punctuation, e.g. "../..") has NO safe anchor → the caller MUST fail closed
// (never a note written to an unintended path). Extracted so meeting-closeout + projectSync share ONE
// adversarially-verified implementation rather than each duplicating (and risking drift on) this gate.
export function safeNoteSlug(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
}
