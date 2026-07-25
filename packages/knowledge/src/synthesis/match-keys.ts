// Shared faithful-match discipline for ARC-4 §13.8 living-vault synthesis — the ONE
// source of the key-derivation rules the EntityResolver (13.8a) and the LinkHealer
// (13.8b) both ground on (Lesson 17: a match predicate lives ONCE, reused not mirrored,
// so the two can never drift). Pure string→string; no I/O, no throws.

/**
 * A FAITHFUL match key: NFC-compose, fold em/en-dashes to a hyphen, trim, lowercase.
 * Spaces are NOT flattened to hyphens (Q1 stricter-than-osb ruling) — so a name-form ref
 * matches a title/alias and a slug-form ref matches a slug, but a space↔hyphen-only
 * difference does NOT match (it falls through to the lossy check → withheld). Pure.
 */
export function faithfulKey(raw: string): string {
  return raw.normalize("NFC").replace(/[–—]/g, "-").trim().toLowerCase();
}

/**
 * A LOSSY filesystem slug (lowercase-hyphenated). Both consumers use it for lossy-collision
 * detection (the resolver ALSO uses it to shape a create-stub proposal): a distinct entity that
 * collapses to the SAME lossy slug as an existing note (`C++`→`c`) is a collision that must never
 * be resolved (13.8a) or auto-healed over (13.8b). Replicates workflows' `safeNoteSlug` shape
 * (unreachable across the layer boundary), lowercased for the entity-name convention. Pure.
 */
export function entitySlug(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 120)
    .replace(/-+$/g, "");
}

/** The structural shape whose comparable identifiers are matched — a candidate note's slug/title/aliases. */
export interface Identifiable {
  readonly slug: string;
  readonly title?: string;
  readonly aliases?: readonly string[];
}

/**
 * A candidate's comparable identifiers: its slug, its title, and any aliases — the THIRD leg of the
 * faithful-match discipline (which fields count), shared so the resolver + healer can never drift
 * (Lesson 17). Defensive over a possibly-hostile row (non-string title/alias entries are skipped).
 */
export function identifiers(c: Identifiable): readonly string[] {
  const out: string[] = [c.slug];
  if (typeof c.title === "string") out.push(c.title);
  if (Array.isArray(c.aliases)) {
    for (const a of c.aliases) if (typeof a === "string") out.push(a);
  }
  return out;
}
