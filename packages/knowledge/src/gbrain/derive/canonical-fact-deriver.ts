// CanonicalFactDeriver (task 4.14, §6; write-through amendment invariant (ii)).
//
// The SoW-owned, gbrain-INDEPENDENT Markdown→SemanticFact[] parser. It is the sole
// trusted "what SHOULD exist in the brain" set — the REFERENCE side of parity
// (4.16) and the source of the revision-scoped serving allow-set (4.17). It parses
// committed vault Markdown at a pinned revision into a normalized SemanticFact[]
// (+ per-fact FactProvenance): pages, links/edges, timeline entries, and tags,
// each with a content-INDEPENDENT factIdentity (its LOCATION, never a content hash)
// and a SoW-computed mdContentSha (sha256 of the fact's normalized semantic
// content). A content edit keeps the same identity and surfaces as an mdContentSha
// divergence, never as a phantom new/missing fact.
//
// It NEVER asks gbrain what the Markdown contains — gbrain is deliberately OUT of
// its own checker's trust base (invariant (ii)); `gbrain extract --dry-run` is only
// ever a corroborating cross-check ORACLE elsewhere (4.16), never consulted here and
// never a calibration target this parser is tuned toward.
//
// PURE + deterministic: no clock, no network, no filesystem, no gbrain. Re-deriving
// the same revision snapshot yields an identical fact set (same members, same order)
// — the property 4.16/4.17 depend on. It returns a typed Result and NEVER throws
// across the boundary (§16).
//
// Structural note (arch_gap): the four EMITTED fact kinds are `page | link |
// timeline | tag` — the four forms with a defined `FactIdentity` grammar (see
// zod-brands `FACT_IDENTITY_RE`). The `frontmatter_value` FactKind exists in the
// enum but has NO upstream identity form (semantic-fact.ts refine skips it, and
// FactIdentitySchema would reject an arbitrary identity), so this deriver does NOT
// emit standalone frontmatter_value facts. Instead frontmatter contributes through
// the forms that DO exist: `tags:` → tag facts, wikilink-valued keys → link facts
// (gbrainLinkSource='frontmatter'), and remaining scalar frontmatter folds into the
// owning page fact's mdContentSha (so a title/date edit is a real content change).
// Reading the SignedProvenanceStamp out of frontmatter is deliberately NOT done
// here — stamp minting/verification is 4.15/4.17's job; this parser stays a
// gbrain-independent content deriver.
import { createHash } from "node:crypto";
import {
  ok,
  err,
  factIdentity,
  SemanticFactSchema,
  FactProvenanceSchema,
} from "@sow/contracts";
import { KW_STAMP_FRONTMATTER_KEY } from "../../knowledge-writer/frontmatter";
import type {
  Result,
  SemanticFact,
  FactProvenance,
  WorkspaceId,
  RevisionId,
  GbrainLinkSource,
} from "@sow/contracts";

/** Committed vault Markdown at a pinned revision — the deriver's only input. */
export interface CanonicalVaultSnapshot {
  readonly workspaceId: WorkspaceId;
  readonly revisionId: RevisionId;
  /** path → committed Markdown content. Only `.md` paths are treated as pages. */
  readonly files: ReadonlyMap<string, string>;
}

/** A single derived fact paired with its provenance descriptor. */
export interface DerivedFact {
  readonly fact: SemanticFact;
  readonly provenance: FactProvenance;
}

/**
 * The canonical "what SHOULD exist" reference set at a revision. `facts` is a SET
 * (deduplicated by factIdentity) rendered in a deterministic factIdentity order.
 */
export interface CanonicalFactSet {
  readonly workspaceId: WorkspaceId;
  readonly revisionId: RevisionId;
  readonly facts: readonly DerivedFact[];
}

/** Enumerable failure variants — the deriver returns these, never throws. */
export type DeriveError =
  | {
      readonly code: "duplicate_fact_identity";
      readonly factIdentity: string;
      readonly paths: readonly string[];
    }
  | { readonly code: "invalid_page_path"; readonly path: string }
  | {
      readonly code: "schema_invalid";
      readonly factIdentity: string;
      readonly detail: string;
    };

// ── internal candidate (plain strings; branded on schema parse) ────────────────

interface FactCandidate {
  readonly identity: string;
  readonly path: string;
  readonly fact: {
    readonly factIdentity: string;
    readonly factKind: SemanticFact["factKind"];
    readonly workspaceId: string;
    readonly mdContentSha: string;
    readonly revisionId: string;
  };
  readonly provenance: {
    readonly origin: FactProvenance["origin"];
    readonly kwRevision: string;
    readonly originPath: string;
    readonly mdContentSha: string;
    readonly gbrainLinkSource?: GbrainLinkSource;
  };
}

const NUL = String.fromCharCode(0);
const WIKILINK_RE = /\[\[([^[\]]+)\]\]/g;
const TIMELINE_HEADING_RE = /^#{1,6}\s+timeline\b/i;
const HEADING_RE = /^#{1,6}\s/;
const LIST_ITEM_RE = /^\s*[-*]\s+(.*)$/;
const FM_FENCE = "---";

function sha256hex(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

/**
 * Normalize free text so cosmetic whitespace never causes a false content
 * divergence: trim each line's trailing whitespace, then drop leading/trailing
 * blank lines. Interior structure is preserved (a real prose edit still changes).
 */
function normalizeText(text: string): string {
  const lines = text.split("\n").map((l) => l.replace(/[ \t]+$/u, ""));
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === "") start += 1;
  while (end > start && lines[end - 1] === "") end -= 1;
  return lines.slice(start, end).join("\n");
}

interface ParsedNote {
  readonly frontmatter: ReadonlyMap<string, string>;
  readonly body: string;
}

/**
 * Split fenced (`---`) frontmatter from body — mirrors the KnowledgeWriter's own
 * note format (`knowledge-writer/writer.ts`) so the deriver and the writer agree on
 * where frontmatter ends and body begins.
 */
function parseNote(content: string): ParsedNote {
  const frontmatter = new Map<string, string>();
  if (!content.startsWith(`${FM_FENCE}\n`)) {
    return { frontmatter, body: content };
  }
  const closeIdx = content.indexOf(`\n${FM_FENCE}\n`, FM_FENCE.length);
  if (closeIdx === -1) {
    return { frontmatter, body: content };
  }
  const block = content.slice(FM_FENCE.length + 1, closeIdx);
  for (const line of block.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    frontmatter.set(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
  }
  const body = content.slice(closeIdx + FM_FENCE.length + 2);
  return { frontmatter, body };
}

/** Path-derived slug: last path segment with a trailing `.md` stripped. */
function basenameSlug(path: string): string {
  const segs = path.split("/");
  const base = segs[segs.length - 1] ?? "";
  return base.replace(/\.md$/iu, "");
}

/** All distinct wikilink targets in a text, in first-seen order. */
function wikilinkTargets(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const dst = (m[1] ?? "").trim();
    if (dst.length > 0 && !seen.has(dst)) {
      seen.add(dst);
      out.push(dst);
    }
  }
  return out;
}

/** Ordered timeline entry texts under the first `Timeline` heading, if any. */
function timelineEntries(body: string): string[] {
  const lines = body.split("\n");
  const entries: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (TIMELINE_HEADING_RE.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (HEADING_RE.test(line)) break; // next heading closes the section
    const item = LIST_ITEM_RE.exec(line);
    if (item) entries.push((item[1] ?? "").trim());
  }
  return entries;
}

/** Split a frontmatter `tags:` value on commas/whitespace into distinct tags. */
function parseTags(value: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(/[,\s]+/u)) {
    const t = raw.replace(/^#/u, "").trim();
    if (t.length > 0 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Derive the canonical SemanticFact set from committed vault Markdown at a revision.
 * Pure, deterministic, gbrain-independent. Returns a typed Result — never throws.
 */
export function deriveCanonicalFacts(
  snapshot: CanonicalVaultSnapshot,
): Result<CanonicalFactSet, DeriveError> {
  const wsId = snapshot.workspaceId as string;
  const revId = snapshot.revisionId as string;

  const candidates: FactCandidate[] = [];

  // Deterministic file order (final output is sorted by identity regardless).
  const paths = [...snapshot.files.keys()].sort();

  for (const path of paths) {
    if (!/\.md$/iu.test(path)) continue; // only Markdown pages derive facts
    const content = snapshot.files.get(path);
    if (content === undefined) continue;

    const { frontmatter, body } = parseNote(content);

    // ── page slug (identity root) ──────────────────────────────────────────
    const fmSlug = frontmatter.get("slug");
    const slug = fmSlug !== undefined && fmSlug.length > 0 ? fmSlug : basenameSlug(path);
    if (slug.length === 0) {
      return err({ code: "invalid_page_path", path });
    }

    // ── classify frontmatter: tags key, wikilink-valued keys, scalar meta ──
    const tagsRaw = frontmatter.get("tags");
    const frontmatterLinks: Array<{ field: string; dst: string }> = [];
    const scalarMeta: Array<readonly [string, string]> = [];
    for (const [key, value] of frontmatter) {
      // `slug`/`tags` are identity/tag inputs (handled above); `kwStamp` is provenance metadata carved out of
      // the semantic derivation (gate 4 G1b) — it must NOT enter scalarMeta (else it perturbs the page hash the
      // stamp itself signs) NOR be classified as a link (an attacker-forged stamp value must not inject a fact).
      // The check precedes the wikilink classification so a `kwStamp: [[x]]` value derives no link fact.
      if (key === "slug" || key === "tags" || key === KW_STAMP_FRONTMATTER_KEY) continue;
      const dsts = wikilinkTargets(value);
      if (dsts.length > 0) {
        for (const dst of dsts) frontmatterLinks.push({ field: key, dst });
      } else {
        scalarMeta.push([key, value]);
      }
    }

    // ── page fact: body prose + remaining scalar frontmatter metadata ──────
    const metaPreimage = scalarMeta
      .slice()
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const pageSha = sha256hex(
      `page${NUL}${slug}${NUL}${normalizeText(body)}${NUL}${metaPreimage}`,
    );
    const pageIdentity = factIdentity({ kind: "page", slug }) as string;
    candidates.push({
      identity: pageIdentity,
      path,
      fact: {
        factIdentity: pageIdentity,
        factKind: "page",
        workspaceId: wsId,
        mdContentSha: pageSha,
        revisionId: revId,
      },
      provenance: {
        origin: "markdown",
        kwRevision: revId,
        originPath: path,
        mdContentSha: pageSha,
      },
    });

    // ── body wikilinks → link facts (source=markdown, field=body) ──────────
    for (const dst of wikilinkTargets(body)) {
      const id = factIdentity({ kind: "link", src: slug, dst, field: "body" }) as string;
      const sha = sha256hex(`link${NUL}${slug}${NUL}${dst}${NUL}body${NUL}markdown`);
      candidates.push({
        identity: id,
        path,
        fact: {
          factIdentity: id,
          factKind: "link",
          workspaceId: wsId,
          mdContentSha: sha,
          revisionId: revId,
        },
        provenance: {
          origin: "markdown",
          kwRevision: revId,
          originPath: path,
          mdContentSha: sha,
          gbrainLinkSource: "markdown",
        },
      });
    }

    // ── frontmatter wikilinks → link facts (source=frontmatter, field=key) ─
    for (const { field, dst } of frontmatterLinks) {
      const id = factIdentity({ kind: "link", src: slug, dst, field }) as string;
      const sha = sha256hex(`link${NUL}${slug}${NUL}${dst}${NUL}${field}${NUL}frontmatter`);
      candidates.push({
        identity: id,
        path,
        fact: {
          factIdentity: id,
          factKind: "link",
          workspaceId: wsId,
          mdContentSha: sha,
          revisionId: revId,
        },
        provenance: {
          origin: "frontmatter",
          kwRevision: revId,
          originPath: path,
          mdContentSha: sha,
          gbrainLinkSource: "frontmatter",
        },
      });
    }

    // ── frontmatter tags → tag facts (source=frontmatter) ──────────────────
    if (tagsRaw !== undefined) {
      for (const tag of parseTags(tagsRaw)) {
        const id = factIdentity({ kind: "tag", page: slug, tag }) as string;
        const sha = sha256hex(`tag${NUL}${slug}${NUL}${tag}`);
        candidates.push({
          identity: id,
          path,
          fact: {
            factIdentity: id,
            factKind: "tag",
            workspaceId: wsId,
            mdContentSha: sha,
            revisionId: revId,
          },
          provenance: {
            origin: "frontmatter",
            kwRevision: revId,
            originPath: path,
            mdContentSha: sha,
          },
        });
      }
    }

    // ── Timeline section → timeline facts (source=markdown, seq=index) ─────
    const entries = timelineEntries(body);
    for (let seq = 0; seq < entries.length; seq += 1) {
      const id = factIdentity({ kind: "timeline", page: slug, seq }) as string;
      const sha = sha256hex(
        `timeline${NUL}${slug}${NUL}${seq}${NUL}${normalizeText(entries[seq] ?? "")}`,
      );
      candidates.push({
        identity: id,
        path,
        fact: {
          factIdentity: id,
          factKind: "timeline",
          workspaceId: wsId,
          mdContentSha: sha,
          revisionId: revId,
        },
        provenance: {
          origin: "markdown",
          kwRevision: revId,
          originPath: path,
          mdContentSha: sha,
        },
      });
    }
  }

  // ── dedupe within a page; reject cross-page identity collisions ───────────
  const byIdentity = new Map<string, FactCandidate>();
  for (const c of candidates) {
    const existing = byIdentity.get(c.identity);
    if (existing === undefined) {
      byIdentity.set(c.identity, c);
      continue;
    }
    if (existing.path === c.path) continue; // same-page duplicate (e.g. repeated wikilink)
    // Same identity from two different files → a real parity defect, surfaced typed.
    const paths = [existing.path, c.path].sort();
    return err({ code: "duplicate_fact_identity", factIdentity: c.identity, paths });
  }

  // ── deterministic order + validate every emitted fact against the contract ─
  const ordered = [...byIdentity.values()].sort((a, b) =>
    a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0,
  );

  const facts: DerivedFact[] = [];
  for (const c of ordered) {
    const factParsed = SemanticFactSchema.safeParse(c.fact);
    if (!factParsed.success) {
      return err({
        code: "schema_invalid",
        factIdentity: c.identity,
        detail: factParsed.error.message,
      });
    }
    const provParsed = FactProvenanceSchema.safeParse(c.provenance);
    if (!provParsed.success) {
      return err({
        code: "schema_invalid",
        factIdentity: c.identity,
        detail: provParsed.error.message,
      });
    }
    facts.push({ fact: factParsed.data, provenance: provParsed.data });
  }

  return ok({
    workspaceId: snapshot.workspaceId,
    revisionId: snapshot.revisionId,
    facts,
  });
}
