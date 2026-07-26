// Assistant-region marker model + stable IDs (§6, KN-8 / task 4.2). Pure,
// deterministic Markdown structure over the canonical vault: a document is an
// ordered interleaving of HUMAN-owned text spans and marker-bounded ASSISTANT
// regions. Assistant regions are the ONLY bytes KnowledgeWriter may rewrite; a
// region carries a STABLE ID inside explicit HTML-comment markers so the same
// logical region keeps its id across successive rewrites (KN-8). Everything
// outside a marker pair is human-owned (KN-7).
//
// Marker format is fixed and matches the writer's projection convention:
//   <!-- kw:region:<id> -->\n<body>\n<!-- /kw:region:<id> -->
//
// PURE: no fs, no clock, no network. Malformed marker structure is NEVER
// silently accepted — it is returned as a typed `SectionParseError` (§16, no
// throw across a boundary) so the ownership check can reject the write.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";

/** Opening marker for an assistant region with the given stable id. */
export function regionOpenMarker(id: string): string {
  return `<!-- kw:region:${id} -->`;
}
/** Closing marker for an assistant region with the given stable id. */
export function regionCloseMarker(id: string): string {
  return `<!-- /kw:region:${id} -->`;
}
/**
 * Render a full assistant region (open marker, body on its own lines, close
 * marker). Inverse of the body extraction in `parseSections` — a rendered
 * region round-trips its body verbatim.
 */
export function renderRegion(id: string, body: string): string {
  return `${regionOpenMarker(id)}\n${body}\n${regionCloseMarker(id)}`;
}

// ── §13 osb-vault interop sentinel markers (ADDITIVE to `kw:region`) ─────────────
// `@generated` is an EXPLICIT opt-into-WRITER-ownership marker (osb-vault interop):
// a `@generated` region is writer-owned / refreshable, semantically == `kw:region`.
// Only an EXPLICITLY `@generated`-marked span is writer-owned — unmarked text stays
// human (the unmarked-complement-is-human default is unchanged), so recognizing
// `@generated` never reclassifies existing human content.
/** Opening marker for a `@generated` writer-owned region (osb interop; == `kw:region`). */
export function generatedOpenMarker(id: string): string {
  return `<!-- @generated:${id} -->`;
}
/** Closing marker for a `@generated` writer-owned region. */
export function generatedCloseMarker(id: string): string {
  return `<!-- /@generated:${id} -->`;
}
/** Render a `@generated` writer-owned region (parses == a `kw:region` AssistantSection). */
export function renderGeneratedRegion(id: string, body: string): string {
  return `${generatedOpenMarker(id)}\n${body}\n${generatedCloseMarker(id)}`;
}

/** Opening marker for an EXPLICIT `@user` human-owned region (osb interop). */
export function userOpenMarker(): string {
  return `<!-- @user -->`;
}
/** Closing marker for a `@user` human-owned region. */
export function userCloseMarker(): string {
  return `<!-- /@user -->`;
}
/**
 * Render an EXPLICIT `@user` human-owned region. It parses to a HumanSection whose text is the
 * FULL marked span (markers + body), so the ownership `humanSignature` protects BOTH its content
 * AND its explicit boundary — a write that edits the body OR strips the markers to seize the span
 * diverges the signature and is rejected. ADDITIVE: an explicit human span in addition to the
 * (unchanged) unmarked-complement-is-human default; human-owned = unmarked ∪ `@user`, never less.
 */
export function renderUserRegion(body: string): string {
  return `${userOpenMarker()}\n${body}\n${userCloseMarker()}`;
}

// Matches an open or close region marker of ANY recognized family:
//   assistant (writer-owned) : `<!-- kw:region:ID -->` / `<!-- @generated:ID -->`
//   human     (user-owned)   : `<!-- @user -->`
// Group 1 is "/" for a close (empty for an open). For an assistant marker, group 2 is the family
// prefix (`kw:region`|`@generated`) and group 3 is the id (ids exclude whitespace + `>` so the
// terminator can never be absorbed). For a `@user` marker, group 4 is `@user` (no id). This is a
// pure ADDITIVE widening: a `kw:region` marker matches exactly as before (group 3 = its id).
const MARKER_RE = /<!-- (\/?)(?:(kw:region|@generated):([^\s>]+)|(@user)) -->/gu;

// A SUPERSET of every region-marker matcher the note is served through: KnowledgeWriter's
// `applyRegionPatch` exact `<!-- kw:region:<id> -->` `indexOf` target AND `MARKER_RE` above (the
// `parseSections` matcher, whose vocabulary is `kw:region` + the §13 osb-interop `@generated:<id>` /
// `@user` families). Case-insensitive, whitespace-tolerant, open OR close, any id — so anything ANY
// consumer could read as a boundary is caught. BROADER than the parser on purpose (case-insensitive +
// `[^\s>]*` zero-or-more id vs the parser's `+`): neutralizer ⊇ parser, the correct safety direction.
// The leading `[\s/]*` is ONE char class (whitespace OR the close `/`), NOT `\s*\/?\s*` — two unbounded
// `\s*` straddling an optional backtrack is QUADRATIC (ReDoS) on a long non-completing whitespace run
// after `<!--`; a single class is linear and still covers ` ` (open) and ` /` (close). Each alternation
// branch starts with a REQUIRED literal so the nullable `[\s/]*` can't overlap; remaining quantifiers
// act on DISJOINT classes — linear for the full vocabulary. This is the ONE canonical neutralizer (L9):
// co-located here with `MARKER_RE`, the grammar it defends (the `@sow/workflows` copy re-points here).
const REGION_MARKER_RE = /<!--[\s/]*(?:kw:region:[^\s>]*|@generated:[^\s>]*|@user)\s*-->/giu;

/**
 * Neutralize any `kw:region` / `@generated` / `@user` boundary-marker string embedded in CONTENT so it
 * can NEVER forge or break a region boundary. Escapes each marker's leading `<!--` to `<\!--` — the
 * human still reads the text (visible, content-preserving; nothing deleted) but neither
 * `applyRegionPatch`'s exact `indexOf` NOR `parseSections`/`MARKER_RE` can match it. Runs to a FIXPOINT
 * (escaping only REMOVES `<!--`, never creates one ⇒ the `<!--` count is monotone-decreasing ⇒
 * terminates). The callback escapes EVERY `<!--` in each matched span (a greedy `[^\s>]*` id merges
 * nested markers into ONE match), so nesting collapses in a SINGLE pass — LINEAR in body length even on
 * a deeply-nested untrusted body (Lesson 9: keep every marker-scan on the untrusted path linear; the
 * old first-`<!--`-only escape was O(depth) passes — a soft-DoS on the ING-7 create path). Idempotent;
 * never throws. PURE.
 */
export function neutralizeRegionMarkers(content: string): string {
  let out = content;
  let prev: string;
  do {
    prev = out;
    out = out.replace(REGION_MARKER_RE, (marker) => marker.replaceAll("<!--", "<\\!--"));
  } while (out !== prev);
  return out;
}

export interface HumanSection {
  readonly kind: "human";
  readonly text: string;
  readonly start: number;
  readonly end: number;
}
export interface AssistantSection {
  readonly kind: "assistant";
  readonly regionId: string;
  /** Body between the markers, with the render convention's framing newlines stripped. */
  readonly body: string;
  /** Exact marker-to-marker byte slice (open marker … close marker inclusive). */
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}
export type Section = HumanSection | AssistantSection;

export type SectionParseReason =
  | "unclosed_region"
  | "unexpected_close"
  | "nested_region"
  | "mismatched_close"
  | "duplicate_region_id";

export interface SectionParseError {
  readonly code: "section_parse_error";
  readonly reason: SectionParseReason;
  readonly regionId?: string;
  readonly offset?: number;
}

function parseError(
  reason: SectionParseReason,
  regionId: string,
  offset: number,
): SectionParseError {
  return { code: "section_parse_error", reason, regionId, offset };
}

/**
 * Parse a document into its ordered human/assistant sections. Rejects every
 * malformed marker structure (unclosed, orphan close, nested, mismatched close
 * id, duplicate region id) so a corrupt region layout can never be mistaken for
 * a clean rewrite surface.
 */
export function parseSections(
  content: string,
): Result<readonly Section[], SectionParseError> {
  const sections: Section[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  let open: { family: "assistant" | "user"; id: string; markerStart: number; innerStart: number } | null = null;

  for (const m of content.matchAll(MARKER_RE)) {
    const isClose = m[1] === "/";
    // family: `@user` (group 4) is a HUMAN region carrying no id; `kw:region`/`@generated`
    // (group 3 = id) are ASSISTANT (writer-owned) regions. Additive — a `kw:region` still
    // classifies exactly as before.
    const isUser = m[4] !== undefined;
    const family: "assistant" | "user" = isUser ? "user" : "assistant";
    // `@user` has no id; a fixed sentinel keys its open/close matching. It never enters `seen`.
    const id = isUser ? "@user" : (m[3] as string);
    const mStart = m.index as number;
    const mEnd = mStart + m[0].length;

    if (!isClose) {
      if (open !== null) {
        return err(parseError("nested_region", id, mStart));
      }
      // Duplicate-id is an ASSISTANT concern (real, unique ids). `kw:region` + `@generated`
      // share ONE id space, so a same-id collision across the two fails closed here.
      if (family === "assistant" && seen.has(id)) {
        return err(parseError("duplicate_region_id", id, mStart));
      }
      if (mStart > cursor) {
        sections.push({
          kind: "human",
          text: content.slice(cursor, mStart),
          start: cursor,
          end: mStart,
        });
      }
      open = { family, id, markerStart: mStart, innerStart: mEnd };
    } else {
      if (open === null) {
        return err(parseError("unexpected_close", id, mStart));
      }
      // The close must match the open's FAMILY and id — a `@user` open closed by a
      // `kw:region`/`@generated` close (or vice-versa) is a mismatched_close.
      if (open.family !== family || open.id !== id) {
        return err(parseError("mismatched_close", id, mStart));
      }
      if (family === "user") {
        // A `@user` region is HUMAN-owned: the FULL marked span (markers + inner) becomes the
        // human section, so `humanSignature` protects both its content AND its explicit boundary
        // (editing the body OR stripping the markers to seize the span diverges the signature).
        sections.push({
          kind: "human",
          text: content.slice(open.markerStart, mEnd),
          start: open.markerStart,
          end: mEnd,
        });
      } else {
        const inner = content.slice(open.innerStart, mStart);
        const body = inner.replace(/^\n/u, "").replace(/\n$/u, "");
        sections.push({
          kind: "assistant",
          regionId: id,
          body,
          raw: content.slice(open.markerStart, mEnd),
          start: open.markerStart,
          end: mEnd,
        });
        seen.add(id);
      }
      open = null;
      cursor = mEnd;
    }
  }

  if (open !== null) {
    return err(parseError("unclosed_region", open.id, open.markerStart));
  }
  if (content.length > cursor) {
    sections.push({
      kind: "human",
      text: content.slice(cursor),
      start: cursor,
      end: content.length,
    });
  }
  return ok(sections);
}

/** Region ids in document order, or the parse error if the layout is malformed. */
export function listRegionIds(
  content: string,
): Result<readonly string[], SectionParseError> {
  const parsed = parseSections(content);
  if (!parsed.ok) {
    return parsed;
  }
  return ok(
    parsed.value
      .filter((s): s is AssistantSection => s.kind === "assistant")
      .map((s) => s.regionId),
  );
}

/** Fetch a single assistant region by id; undefined if absent or the doc is malformed. */
export function getRegion(content: string, id: string): AssistantSection | undefined {
  const parsed = parseSections(content);
  if (!parsed.ok) {
    return undefined;
  }
  return parsed.value.find(
    (s): s is AssistantSection => s.kind === "assistant" && s.regionId === id,
  );
}

/** Concatenation of the human-owned segments only (assistant region bytes excluded). */
export function humanOwnedText(sections: readonly Section[]): string {
  return sections
    .filter((s): s is HumanSection => s.kind === "human")
    .map((s) => s.text)
    .join("");
}

/**
 * Upsert an assistant region body by stable id: rewrite the existing region in
 * place (id + position preserved across the rewrite, KN-8) or, when the id is
 * absent, append a fresh region leaving all prior content byte-stable. Refuses a
 * malformed document rather than writing over corrupt structure.
 */
export function upsertRegionBody(
  content: string,
  id: string,
  newBody: string,
): Result<string, SectionParseError> {
  const parsed = parseSections(content);
  if (!parsed.ok) {
    return parsed;
  }
  const existing = parsed.value.find(
    (s): s is AssistantSection => s.kind === "assistant" && s.regionId === id,
  );
  const rendered = renderRegion(id, newBody);
  if (existing !== undefined) {
    return ok(content.slice(0, existing.start) + rendered + content.slice(existing.end));
  }
  const sep = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return ok(`${content}${sep}${rendered}`);
}

/**
 * Neutralize a whole NOTE body for a create, region-AWARE (KW `renderCreate` uses this). A create body
 * may already carry a LEGIT assistant region (the synthesis planner's `new_note` wraps content via
 * `renderGeneratedRegion`) — blanket-neutralizing would escape those legit markers and destroy the
 * region. So: parse the body; PRESERVE each legit assistant region's markers + family (kw:region vs
 * @generated) while neutralizing its INNER body; neutralize every human-span's text (so an embedded
 * `@user`/`kw:region`/`@generated` marker can never forge a boundary — incl. planting a fake `@user`
 * human region). A body whose marker structure is MALFORMED (no clean regions to preserve) is
 * blanket-neutralized. Idempotent; never throws (parse failure ⇒ blanket). PURE.
 */
export function neutralizeNoteBody(body: string): string {
  const parsed = parseSections(body);
  if (!parsed.ok) {
    return neutralizeRegionMarkers(body);
  }
  return parsed.value
    .map((s) => {
      if (s.kind !== "assistant") {
        return neutralizeRegionMarkers(s.text);
      }
      // Preserve the ORIGINAL family so a @generated region isn't silently reclassified to kw:region.
      const isGenerated = s.raw.startsWith(generatedOpenMarker(s.regionId));
      const safeInner = neutralizeRegionMarkers(s.body);
      return isGenerated ? renderGeneratedRegion(s.regionId, safeInner) : renderRegion(s.regionId, safeInner);
    })
    .join("");
}
