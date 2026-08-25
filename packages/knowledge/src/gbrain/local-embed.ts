// Local-zero-egress semantic retrieval primitive (§6 GBrain local retrieval path;
// §5 egress veto; 13.3a). A PURE primitive over an INJECTED EmbeddingBackend seam
// with RRF hybrid fusion (dense cosine + sparse lexical), ported from osb
// `semantic_search.py` (Reciprocal Rank Fusion, K=60, 0-indexed rank).
//
// Why a knowledge-local `EmbeddingBackend` seam and NOT `ModelProviderPort`:
// ModelProviderPort is COMPLETION-only (`complete()` — no embed op). Embeddings are
// a distinct request/response, so they ride this local injected seam; the real
// Ollama `/api/embeddings` + LM Studio adapters bind it downstream (providers track),
// dormant. This unit takes fakes in tests — NO real process/network here.
//
// Safety rule 5 (the load-bearing invariant): raw Employer-Work content may embed
// ONLY on a genuine non-egress (local) backend. A cloud (egress) backend for
// unacknowledged Employer-Work raw content FAILS CLOSED with a typed err and the
// backend is NEVER called — there is NO cloud fallback. This "select a local backend
// or fail closed" floor is safe-by-construction (keyed on the backend's own declared
// egressClass, mirroring the egressVeto condition — NOT a re-derivation of the
// processor allowlist) but it is NOT proof: `egressClass` is self-declared by the
// caller. The proof is a REQUIRED injected `egressGate`, which carries the reuse of
// the real §5 `egressVeto` (the endpoint-check authority) — omitting it is a type
// error, so a caller cannot retrieve on a self-declared class alone (24.9). A deny or
// a throw from the gate fails closed the same way the floor does.
//
// Rule 1 posture: the embedding index is a REBUILDABLE sidecar OUTSIDE the canonical
// Markdown tree — never a 2nd canonical-truth store (`resolveLocalEmbedIndexPath` +
// `isPathOutsideVaultTree`).
//
// TOTAL never-throws (§16 / knowledge Lesson 11): the whole post-egress map runs
// under ONE try because the injected backend can THROW or resolve `ok` with a
// pathological body; every fault is a typed Result err, never an escape.
import { ok, err, isErr } from "@sow/contracts";
import { dirname, resolve, relative, join, isAbsolute, sep } from "node:path";
import type { Result, ProviderId, EgressClass, WorkspaceType } from "@sow/contracts";

// ── public types ────────────────────────────────────────────────────────────────

/** A candidate passage to rank. */
export interface Passage {
  /** Stable identity carried through fusion. MUST be unique — duplicate ids collapse to the best rank. */
  readonly id: string;
  readonly text: string;
}

/** A fused/ranked passage id + its RRF score (descending; deterministic tie-break). */
export interface RankedPassage {
  readonly id: string;
  readonly score: number;
}

/**
 * A typed embedding-backend fault (§16, enumerable, never thrown across the boundary).
 * `cause` is the RAW backend value (may embed query/passage text) — a consumer MUST
 * redact it before any log sink (rule 7), mirroring mcp-read-adapter's `transport_fault`.
 */
export interface EmbedFault {
  readonly code: "embed_backend_fault";
  readonly cause: unknown;
}

/**
 * The injected local embedding backend (Ollama / LM Studio downstream). Serves one
 * `providerId`; declares its `egressClass` so the rule-5 floor can refuse a cloud
 * backend for Employer-Work raw content. `embed` returns one vector per input text,
 * in order, as a typed Result — it must NEVER be trusted to be well-formed.
 */
export interface EmbeddingBackend {
  readonly providerId: ProviderId;
  readonly egressClass: EgressClass;
  embed(texts: readonly string[]): Promise<Result<readonly number[][], EmbedFault>>;
}

/** The §5-veto-relevant workspace posture for a retrieval (mirrors egressVeto inputs). */
export interface RetrievalWorkspaceContext {
  readonly type: WorkspaceType;
  readonly carriesRawContent: boolean;
  readonly employerRawEgressAcknowledged: boolean;
}

/** A typed egress denial (fail-closed; carries a redaction-safe code-only reason). */
export interface EgressDenied {
  readonly code: "egress_denied";
  readonly reason: string;
}

/**
 * The injected egress gate — the reuse hook for the real §5 `egressVeto`. Its
 * production binding (downstream, knowledge → policy) wraps `egressVeto`; here it is
 * REQUIRED (24.9) and faked in tests — a self-declared `EmbeddingBackend.egressClass`
 * is not proof, so `retrieveLocalEmbed` cannot be called without it. PURE + synchronous
 * like the veto; a deny is returned, never thrown (the primitive additionally
 * fail-closes a throwing gate).
 */
export interface RetrievalEgressGate {
  check(
    backend: { readonly providerId: ProviderId; readonly egressClass: EgressClass },
    ctx: RetrievalWorkspaceContext,
  ): Result<void, EgressDenied>;
}

export type RetrievalFault = EgressDenied | EmbedFault;

export interface RetrieveLocalEmbedInput {
  readonly query: string;
  readonly passages: readonly Passage[];
  readonly workspace: RetrievalWorkspaceContext;
}

export interface RetrieveLocalEmbedDeps {
  readonly backend: EmbeddingBackend;
  /**
   * REQUIRED reuse of the real §5 `egressVeto` (24.9). A self-declared
   * `backend.egressClass` alone is not proof of a genuine non-egress endpoint — the
   * gate is the only path that can invoke the real endpoint-check authority, so the
   * unproven (gate-omitted) path is made unrepresentable rather than left optional.
   */
  readonly egressGate: RetrievalEgressGate;
  /** Cap on the fused result count (default: all). */
  readonly limit?: number;
}

/** RRF constant (osb semantic_search.py: `K = 60`). */
export const DEFAULT_RRF_K = 60 as const;

/** Sidecar directory name for the rebuildable embedding index (outside the vault). */
const EMBED_INDEX_SIDECAR = join(".sow", "embed-index");

// ── RRF fusion (osb port: K=60, 0-indexed rank; id-asc deterministic tie-break) ───

/**
 * Reciprocal Rank Fusion over two ranked id lists (dense + sparse legs). Score =
 * Σ 1/(K + rank) over each list the id appears in, rank 0-indexed (osb convention).
 * RRF needs no score calibration between the legs — only their rank orders. Sorted
 * by score DESC, ties broken by id ASC so the ordering is deterministic across JS
 * engines (the ranking contract 13.17 re-ranking + 13.8c SENSE build on). Pure.
 */
export function fuseRrf(
  denseRankedIds: readonly string[],
  sparseRankedIds: readonly string[],
  opts?: { readonly k?: number; readonly limit?: number },
): readonly RankedPassage[] {
  const k = opts?.k ?? DEFAULT_RRF_K;
  const rankMap = (ids: readonly string[]): Map<string, number> => {
    const m = new Map<string, number>();
    ids.forEach((id, i) => {
      if (!m.has(id)) m.set(id, i); // first occurrence wins (0-indexed)
    });
    return m;
  };
  const dense = rankMap(denseRankedIds);
  const sparse = rankMap(sparseRankedIds);
  const scored: RankedPassage[] = [];
  for (const id of new Set<string>([...dense.keys(), ...sparse.keys()])) {
    let score = 0;
    const dr = dense.get(id);
    if (dr !== undefined) score += 1 / (k + dr);
    const sr = sparse.get(id);
    if (sr !== undefined) score += 1 / (k + sr);
    scored.push({ id, score });
  }
  scored.sort(byScoreDescThenIdAsc);
  return opts?.limit !== undefined ? scored.slice(0, opts.limit) : scored;
}

function byScoreDescThenIdAsc(a: RankedPassage, b: RankedPassage): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ── cosine similarity (osb semantic_search.py:237) ───────────────────────────────

/** Cosine similarity in [-1,1]; 0 on empty / dimension-mismatch / zero-norm. Pure. */
function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Lexical (sparse) overlap: count of query tokens present in the passage. Pure. */
function lexicalOverlap(query: string, text: string): number {
  const qs = tokenize(query);
  const ts = tokenize(text);
  let n = 0;
  for (const t of qs) if (ts.has(t)) n++;
  return n;
}

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0));
}

/**
 * Rank passages by lexical (sparse) relevance to the query: ONLY passages with an
 * actual lexical hit (osb `lexical_results` holds matches only), ordered by overlap
 * DESC then id ASC. Exported so the 13.17 re-ranker fuses this with the retrieval
 * order — the sparse leg of `retrieveLocalEmbed` is this exact ranking. Pure.
 */
export function lexicalRelevanceRank(query: string, passages: readonly Passage[]): readonly string[] {
  return passages
    .map((p) => ({ id: p.id, score: lexicalOverlap(query, p.text) }))
    .filter((r) => r.score > 0)
    .sort(byScoreDescThenIdAsc)
    .map((r) => r.id);
}

// ── the retrieval primitive ──────────────────────────────────────────────────────

/**
 * Rank candidate passages against a query via RRF hybrid fusion (dense embedding
 * cosine + sparse lexical overlap). Fail-closed on the §5 egress veto and TOTAL
 * never-throws over the injected backend. Never reads/writes the on-disk index —
 * that binding lands with a downstream consumer (13.17 / 13.8c).
 */
export async function retrieveLocalEmbed(
  input: RetrieveLocalEmbedInput,
  deps: RetrieveLocalEmbedDeps,
): Promise<Result<readonly RankedPassage[], RetrievalFault>> {
  const { query, passages, workspace } = input;
  const { backend, egressGate, limit } = deps;

  // ── 1. Rule-5 floor (safe-by-construction): raw Employer-Work content may embed
  //      ONLY on a genuine non-egress backend. Any cloud backend ⇒ fail closed,
  //      the backend is never invoked (no cloud egress, no fallback).
  //      TRUST NOTE: this keys on the backend's DECLARED egressClass — the seam has
  //      no endpoint to prove genuineness the way egressVeto does (its loopback-
  //      endpoint proof). This floor alone is NOT proof; it is defense-in-depth
  //      alongside step 2, which is where the real endpoint-check authority runs. ─
  const employerRawUnacked =
    workspace.type === "employer_work" &&
    workspace.carriesRawContent === true &&
    workspace.employerRawEgressAcknowledged === false;
  if (employerRawUnacked && backend.egressClass !== "local") {
    return err({
      code: "egress_denied",
      reason: "employer_raw_content_requires_local_backend",
    });
  }

  // ── 2. Egress gate (REQUIRED, 24.9): the reuse of the real §5 veto — the only
  //      path that can invoke the endpoint-check authority (`egressVeto`) to catch a
  //      backend whose declared `egressClass` is wrong. A deny OR a throw fails
  //      closed. Runs BEFORE any embed so a denied job never reaches the backend. ─
  let decision: Result<void, EgressDenied>;
  try {
    decision = egressGate.check(
      { providerId: backend.providerId, egressClass: backend.egressClass },
      workspace,
    );
  } catch {
    return err({ code: "egress_denied", reason: "egress_gate_faulted" });
  }
  if (isErr(decision)) return decision;

  // ── 3. Nothing to rank ⇒ no embedding, no egress, empty result. ───────────────
  if (passages.length === 0) return ok([]);

  // ── 4. Embed + fuse — the WHOLE untrusted-backend interaction under ONE try
  //      (it can throw OR resolve ok with a pathological body). ──────────────────
  try {
    const texts: readonly string[] = [query, ...passages.map((p) => p.text)];
    const embedded = await backend.embed(texts);
    if (isErr(embedded)) return embedded;

    const vectors = embedded.value;
    if (!isWellFormedEmbeddings(vectors, texts.length)) {
      return err({ code: "embed_backend_fault", cause: "malformed_embeddings" });
    }
    const qvec = vectors[0]!;

    // Dense leg — cosine(query, passage) over the FULL caller-supplied candidate set
    // (this primitive ranks a provided set, not a live index, so no pre-truncation).
    const dense = passages
      .map((p, i) => ({ id: p.id, score: cosine(qvec, vectors[i + 1]!) }))
      .sort(byScoreDescThenIdAsc)
      .map((r) => r.id);
    // Sparse leg — ONLY passages with an actual lexical hit (osb `lexical_results`
    // holds matches only); a zero-overlap passage is ABSENT from this leg (it can
    // still rank via the dense leg). Shared with the 13.17 re-ranker.
    const sparse = lexicalRelevanceRank(query, passages);

    return ok(fuseRrf(dense, sparse, { limit }));
  } catch (cause) {
    return err({ code: "embed_backend_fault", cause });
  }
}

/** A well-formed embedding response: one numeric vector per input text. */
function isWellFormedEmbeddings(vectors: unknown, expectedLength: number): vectors is readonly number[][] {
  return (
    Array.isArray(vectors) &&
    vectors.length === expectedLength &&
    vectors.every((v) => Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isFinite(n)))
  );
}

// ── index location — a rebuildable sidecar OUTSIDE the canonical Markdown tree ─────

/**
 * Resolve the embedding index location for a vault: a rebuildable/read-only sidecar
 * OUTSIDE the canonical Markdown tree (a `.sow/embed-index` sibling of the vault),
 * so the index is never a 2nd canonical-truth store (safety rule 1). Pure.
 */
export function resolveLocalEmbedIndexPath(vaultMarkdownRoot: string): string {
  return join(dirname(resolve(vaultMarkdownRoot)), EMBED_INDEX_SIDECAR);
}

/**
 * Lexical containment check: is `candidate` OUTSIDE the vault Markdown tree? A trusted
 * config-derived path pair (the vault root + our own constructed sidecar), so this is
 * a lexical `relative`-based check — DISTINCT from integrations' realpath-based
 * `isContainedUnder` (that guards untrusted traversal input; different trust model,
 * and it is not a knowledge dependency). The root itself is NOT "outside". Pure.
 */
export function isPathOutsideVaultTree(vaultMarkdownRoot: string, candidate: string): boolean {
  const rel = relative(resolve(vaultMarkdownRoot), resolve(candidate));
  return rel !== "" && (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel));
}
