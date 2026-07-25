// spec(§6 · §13.1c · §12) — task 13.3b retrieval eval harness: the recorded corpus.
//
// A recorded-embedding fixture corpus (deterministic / CI-able — no live model, no
// network): a fixed pool of documents each carrying a recorded embedding vector, and
// a set of labeled queries (query text + recorded query vector + gold relevant doc
// ids). The harness ranks each query's docs through knowledge's REAL exported
// retrieval (`retrieveLocalEmbed`, 13.3a) + re-ranker (`rerank`, 13.17) and scores
// recall@10 against the §13.1c bar. An OPTIONAL live-Ollama mode is a separate
// env-gated path — this recorded corpus is the deterministic default.
//
// Zero-egress by construction: the backend is a pure in-memory text→vector lookup
// declaring egressClass "local"; nothing here reaches a network/model.
import type { RetrievalWorkspaceContext, EmbeddingBackend } from "@sow/knowledge";
import { ok } from "@sow/contracts";
import type { ProviderId, EgressClass } from "@sow/contracts";

/** A candidate document: stable id, text (drives the sparse lexical leg), recorded embedding. */
export interface RetrievalDoc {
  readonly id: string;
  readonly text: string;
  readonly embedding: readonly number[];
}

/** A labeled retrieval query: text, recorded query vector, the gold relevant doc ids, workspace posture. */
export interface RetrievalCase {
  readonly id: string;
  readonly query: string;
  readonly queryEmbedding: readonly number[];
  readonly goldDocIds: readonly string[];
  readonly workspace: RetrievalWorkspaceContext;
}

export interface RetrievalCorpus {
  readonly docs: readonly RetrievalDoc[];
  readonly cases: readonly RetrievalCase[];
}

/** The §13.1c recorded bar: hybrid (fused) recall@10 ≥ 0.91 (osb retrieval_eval hybrid figure). */
export const RECALL_AT_10_BAR = 0.91 as const;

/** The recall cutoff rank. */
export const RECALL_K = 10 as const;

/**
 * Build a recorded, zero-egress EmbeddingBackend over the corpus: a pure in-memory
 * text→vector lookup (doc texts + query texts). Declares egressClass "local" by
 * default (a genuine non-egress backend); pass `egressClass: "cloud"` to exercise
 * the rule-5 fail-closed floor. Never touches a network/model.
 */
export function recordedBackend(
  corpus: RetrievalCorpus,
  opts?: { readonly egressClass?: EgressClass },
): EmbeddingBackend {
  const byText = new Map<string, readonly number[]>();
  for (const d of corpus.docs) byText.set(d.text, d.embedding);
  for (const c of corpus.cases) byText.set(c.query, c.queryEmbedding);
  return {
    providerId: "ollama" as ProviderId,
    egressClass: opts?.egressClass ?? "local",
    embed(texts) {
      // Recorded lookup; an unknown text yields a zero vector (cosine → 0), never a throw.
      // Fresh mutable copies to satisfy the backend's `number[][]` contract.
      const vectors: number[][] = texts.map((t) => [...(byText.get(t) ?? [])]);
      return Promise.resolve(ok(vectors));
    },
  };
}

// ── recorded fixture generation (deterministic; no clock/random) ──────────────────
// A 5-topic embedding basis (unit vectors e0..e4). A topic doc's embedding is its
// topic basis; a query's is its topic basis. So dense cosine ranks same-topic docs
// top and orthogonal-topic docs at 0 — a controllable, recorded ranking.
// 10 topics — a query set ≥30 (the §20.1/A7 retrieval floor, evals CLAUDE.md
// forbidden-pattern #5): 10 topics × 3 clean queries = 30 + 3 lexical-rescue = 33.
const TOPICS = [
  "auth",
  "billing",
  "calendar",
  "search",
  "deploy",
  "notes",
  "tasks",
  "people",
  "projects",
  "ingest",
] as const;
const EMBED_DIM = TOPICS.length;
function basis(i: number): readonly number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  v[i] = 1;
  return v;
}

// Per-topic keyword text — distinct tokens, no cross-topic overlap, no rescue keywords.
const TOPIC_TEXT: Record<(typeof TOPICS)[number], string> = {
  auth: "auth token session login credential",
  billing: "billing invoice payment subscription charge",
  calendar: "calendar meeting schedule event availability",
  search: "search retrieval ranking embedding index",
  deploy: "deploy release rollout pipeline canary",
  notes: "notes markdown vault frontmatter linkage",
  tasks: "task priority owner duedate backlog",
  people: "person contact relationship dossier profile",
  projects: "project milestone roadmap status progress",
  ingest: "ingest connector poll cursor dedupe",
};

const WS: RetrievalWorkspaceContext = {
  type: "personal_business",
  carriesRawContent: false,
  employerRawEgressAcknowledged: false,
};

// A rescue case: gold dense-buried (orthogonal topic + a late "zz-" id) but sharing a
// UNIQUE nonsense keyword with the query, so only the sparse lexical leg surfaces it.
const RESCUES = [
  { docId: "zz-rescue-a", keyword: "quibbleflux", docText: "quibbleflux protocol memo", queryTopic: 0, docTopic: 9 },
  { docId: "zz-rescue-b", keyword: "zephyron", docText: "zephyron ledger note", queryTopic: 1, docTopic: 8 },
  { docId: "zz-rescue-c", keyword: "wobblenaut", docText: "wobblenaut cipher tag", queryTopic: 2, docTopic: 7 },
] as const;

function buildRetrievalCorpus(): RetrievalCorpus {
  const docs: RetrievalDoc[] = [];
  TOPICS.forEach((t, ti) => {
    for (let n = 0; n < 4; n++) docs.push({ id: `d-${t}-${n}`, text: TOPIC_TEXT[t], embedding: basis(ti) });
  });
  for (const r of RESCUES) docs.push({ id: r.docId, text: r.docText, embedding: basis(r.docTopic) });

  const cases: RetrievalCase[] = [];
  // 30 clean cases (3 per topic): dense finds the gold in the top-4 same-topic docs.
  TOPICS.forEach((t, ti) => {
    for (let q = 0; q < 3; q++) {
      cases.push({
        id: `q-${t}-${q}`,
        query: TOPIC_TEXT[t],
        queryEmbedding: basis(ti),
        goldDocIds: [`d-${t}-${q}`],
        workspace: WS,
      });
    }
  });
  // 3 rescue cases: the gold is dense-buried (orthogonal + late id) but shares a
  // unique keyword with the query — the sparse lexical leg pulls it into the top-10.
  for (const r of RESCUES) {
    cases.push({
      id: `q-rescue-${r.docId.slice(-1)}`,
      query: r.keyword,
      queryEmbedding: basis(r.queryTopic),
      goldDocIds: [r.docId],
      workspace: WS,
    });
  }

  return { docs, cases };
}

function buildDegradedCorpus(): RetrievalCorpus {
  // 15 docs all on one basis; each query is orthogonal (dense cosine 0 for all) AND
  // shares no token with any doc (sparse empty) — so a gold ranked past 10 by the
  // id tie-break is missed by BOTH legs ⇒ fused recall@10 = 0, below the bar.
  const docs: RetrievalDoc[] = [];
  for (let n = 0; n < 15; n++) {
    docs.push({ id: `dx-${String(n).padStart(2, "0")}`, text: "filler alpha content", embedding: basis(0) });
  }
  const cases: RetrievalCase[] = [];
  for (let q = 0; q < 5; q++) {
    cases.push({
      id: `qx-${q}`,
      query: "probe beta signal",
      queryEmbedding: basis(1),
      goldDocIds: [`dx-${String(10 + q).padStart(2, "0")}`], // ranks 11..15 by id tie-break
      workspace: WS,
    });
  }
  return { docs, cases };
}

/** The retrieval query floor (§20.1/A7; evals CLAUDE.md forbidden-pattern #5): ≥30. */
export const RETRIEVAL_QUERY_FLOOR = 30 as const;

/**
 * The recorded corpus: 43 docs (10 topics × 4 + 3 rescue), 33 labeled queries (30
 * clean + 3 lexical-rescue — clears the ≥30 retrieval floor). Engineered so the
 * fused (hybrid) recall@10 clears the §13.1c bar while the embedding-only baseline
 * misses the rescue cases (fusion demonstrably helps).
 */
export const RETRIEVAL_CORPUS: RetrievalCorpus = buildRetrievalCorpus();

/**
 * A deliberately-DEGRADED corpus (gold missed by BOTH the dense and sparse legs),
 * proving the bar is a REAL gate: its fused recall@10 falls below the bar, so
 * `below_bar_fails_suite` is non-vacuous.
 */
export const DEGRADED_CORPUS: RetrievalCorpus = buildDegradedCorpus();
