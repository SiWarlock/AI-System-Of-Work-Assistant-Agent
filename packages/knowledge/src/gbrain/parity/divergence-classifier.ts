// DivergenceClassifier (task 4.16, §6/§12; write-through amendment invariants
// (iv)/(vii)). Classifies a SINGLE content-independent `factIdentity`'s
// disagreement between the SoW-owned gbrain-INDEPENDENT canonical set (the
// CanonicalFactDeriver, 4.14 — the sole trusted REFERENCE side) and the read-only
// DB projection (a `GbrainReadGrant` HTTP read; NEVER a byte source) into the
// CLOSED action lattice:
//
//   db_only      — a non-edge fact present in the DB but NOT derivable from
//                  committed Markdown. HARD floor → quarantine (safety rule 1: a
//                  DB-only semantic fact is a hidden-brain parity defect). Remediation
//                  is `review` — RemediationRouter (4.18) adjudicates materialize-or-
//                  purge; auto-purge requires POSITIVE proof of non-derivability.
//   unstamped    — a fact present in BOTH sides but the DB row carries no signed
//                  provenance stamp. HARD floor, NEVER auto-downgraded/backfilled on
//                  a gbrain-supplied hash (an unstamped row is not KnowledgeWriter-
//                  attributed even if its bytes happen to match). Remediation `review`.
//   content_mismatch — present in both, stamped, but the DB content hash differs
//                  from the current canonical `mdContentSha` AND the DB row claims
//                  the CURRENT revision. Markdown wins → resync FROM Markdown ONLY.
//   stale_revision — same as content_mismatch but the DB row claims an OLDER
//                  revision: the index simply hasn't caught up (benign). Resync.
//   md_only      — a non-edge fact in the canonical set but not yet in the DB
//                  (index behind). Benign → resync/re-index.
//   edge_db_only / edge_md_only — the link/edge analogues of db_only / md_only,
//                  split out because gbrain's edge derivation legitimately differs
//                  from the parser's, so an edge disagreement must NOT flood the
//                  HARD-floor path. SOFT — serving is default-deny regardless (an
//                  edge with no Markdown backing has no bytes to rehydrate, 4.17).
//
// `db_only` and `unstamped` are the ONLY HARD-floor classes (matching the frozen
// `Divergence` refine). The gbrain import-rebuild oracle is a corroborating cross-
// check consumed by the reconciler, NEVER by this classifier — it is not a
// calibration target the parser is tuned toward (invariant (ii)).
//
// PURE + deterministic: no clock, no network, no filesystem, no gbrain. Returns a
// typed outcome — never throws across the boundary (§16). Every emitted Divergence
// is validated through the frozen `DivergenceSchema` before it is surfaced.
import { DivergenceSchema } from "@sow/contracts";
import type {
  Divergence,
  DivergenceClass,
  FactKind,
  Remediation,
  SeverityFloor,
} from "@sow/contracts";
import type { DerivedFact } from "../derive/canonical-fact-deriver";

/**
 * One semantic fact as projected from the read-only DB (the `GbrainReadGrant`
 * HTTP read surface). This is a POINTER/metadata view — never a byte source
 * (bytes are rehydrated from Markdown at serve time by 4.17). `dbContentHash` is
 * an OPEN string (gbrain's `content_hash`; its algorithm is unspecified upstream);
 * when the DB is honestly indexed via 4.8 it carries the SoW `mdContentSha`.
 */
export interface DbFact {
  readonly factIdentity: string;
  readonly factKind: FactKind;
  /** gbrain-side content hash (compared against the canonical `mdContentSha`). */
  readonly dbContentHash: string;
  /** Whether the DB row carries a signed provenance stamp (KW-attributed). */
  readonly stamped: boolean;
  /** The revision the DB row claims to reflect. */
  readonly revisionId: string;
}

/** The per-identity comparison the classifier decides on. */
export type FactComparison =
  | { readonly present: "both"; readonly canonical: DerivedFact; readonly db: DbFact }
  | { readonly present: "canonical_only"; readonly canonical: DerivedFact }
  | { readonly present: "db_only"; readonly db: DbFact };

/**
 * Outcome of classifying one identity. `clean` ⇒ no disagreement; `divergent`
 * carries a contract-valid `Divergence`; `invalid` ⇒ the drafted divergence
 * failed the frozen schema (structurally unreachable given the closed lattice
 * below, but surfaced rather than thrown — §16).
 */
export type ClassifyOutcome =
  | { readonly kind: "clean" }
  | { readonly kind: "divergent"; readonly divergence: Divergence }
  | { readonly kind: "invalid"; readonly factIdentity: string; readonly detail: string };

/** Draft (plain strings) → validated through `DivergenceSchema`. */
interface DivergenceDraft {
  readonly factIdentity: string;
  readonly divergenceClass: DivergenceClass;
  readonly severityFloor: SeverityFloor;
  readonly mdContentSha?: string;
  readonly dbContentHash?: string;
  readonly remediation: Remediation;
}

function build(draft: DivergenceDraft): ClassifyOutcome {
  const parsed = DivergenceSchema.safeParse(draft);
  if (!parsed.success) {
    return { kind: "invalid", factIdentity: draft.factIdentity, detail: parsed.error.message };
  }
  return { kind: "divergent", divergence: parsed.data };
}

/**
 * Classify one factIdentity's canonical-vs-DB comparison into the closed lattice.
 * `canonicalRevision` is the revision the canonical set was derived at — used to
 * distinguish a stale (index-behind) content difference from a real mismatch.
 */
export function classifyDivergence(
  cmp: FactComparison,
  canonicalRevision: string,
): ClassifyOutcome {
  // ── present in the DB ONLY: not derivable from committed Markdown ────────────
  if (cmp.present === "db_only") {
    const isEdge = cmp.db.factKind === "link";
    return build({
      factIdentity: cmp.db.factIdentity,
      // Edges split out (soft) to avoid a divergence flood; a non-edge DB-only
      // fact is a HARD hidden-brain defect (safety rule 1).
      divergenceClass: isEdge ? "edge_db_only" : "db_only",
      severityFloor: isEdge ? "soft" : "hard",
      dbContentHash: cmp.db.dbContentHash,
      remediation: "review",
    });
  }

  // ── present in the canonical set ONLY: index simply behind (benign) ──────────
  if (cmp.present === "canonical_only") {
    const isEdge = cmp.canonical.fact.factKind === "link";
    return build({
      factIdentity: cmp.canonical.fact.factIdentity as string,
      divergenceClass: isEdge ? "edge_md_only" : "md_only",
      severityFloor: "soft",
      mdContentSha: cmp.canonical.fact.mdContentSha as string,
      remediation: "resync",
    });
  }

  // ── present in BOTH sides ────────────────────────────────────────────────────
  const canonicalSha = cmp.canonical.fact.mdContentSha as string;
  const identity = cmp.canonical.fact.factIdentity as string;

  // HARD floor: an unstamped DB row is never KW-attributed. This is checked BEFORE
  // the hash compare so a matching hash can NEVER backfill a stamp (invariant vii).
  if (!cmp.db.stamped) {
    return build({
      factIdentity: identity,
      divergenceClass: "unstamped",
      severityFloor: "hard",
      mdContentSha: canonicalSha,
      dbContentHash: cmp.db.dbContentHash,
      remediation: "review",
    });
  }

  if (cmp.db.dbContentHash !== canonicalSha) {
    // The DB claims THIS revision → a real content mismatch (Markdown wins);
    // the DB claims an OLDER revision → the index merely hasn't caught up.
    const stale = cmp.db.revisionId !== canonicalRevision;
    return build({
      factIdentity: identity,
      divergenceClass: stale ? "stale_revision" : "content_mismatch",
      severityFloor: "soft",
      mdContentSha: canonicalSha,
      dbContentHash: cmp.db.dbContentHash,
      remediation: "resync",
    });
  }

  // stamped + hash-equal + (this or older revision, hash already matches) → clean.
  return { kind: "clean" };
}
