// @sow/integrations — RES-1 free, KEY-LESS source aggregator (§7 / REQ-F-022).
// Retrieves from free public sources (Wikipedia / HackerNews / arXiv / Reddit /
// Semantic-Scholar / DuckDuckGo) with NO API key. `academic` restricts to the
// scholarly subset (the `--research-deep --academic` mode).
//
// SAFETY — GATES IDENTICALLY (rule 5, the load-bearing pin): the query text is
// employer-content-bearing, so sending it to ANY free source is EGRESS of employer
// content. Being key-less is NOT a bypass. Unlike the research PROVIDER (a broker
// run-leg the broker's veto gates), this aggregator is a connector — so it SELF-runs
// the REAL @sow/policy `egressVeto` FIRST, over a synthetic CLOUD-classed route, and
// FAILS CLOSED before any transport when the veto denies (an employer-work ack-OFF
// call ⇒ no fetch, no cloud fallback). The veto is REUSED, never re-implemented.
//
// DORMANT: the transport is dependency-injected (a FAKE in tests; a real key-less
// HTTP client binds ONLY at §ARM-RESEARCH). This module constructs NO real HTTP
// client and holds NO secret. Output is CANDIDATE DATA — the source provenance is
// preserved VERBATIM (never summarized); 13.14 maps it downstream. Never throws (§16).
import { ok, err } from "@sow/contracts";
import type {
  Result,
  AgentJob,
  EgressPolicy,
  ProviderRoute,
  WorkspaceType,
  DataOwner,
} from "@sow/contracts";
import { egressVeto, isDeny } from "@sow/policy";

/** A free key-less source. `academic === true` marks the scholarly subset. */
export interface FreeSource {
  readonly id: string;
  /** arch_gap: candidate base endpoint — the real per-source query params are
   *  confirmed at §ARM-RESEARCH; the aggregator never calls it while dormant. */
  readonly endpoint: string;
  readonly academic: boolean;
}

/** The free key-less source catalog. */
export const FREE_SOURCES: readonly FreeSource[] = [
  { id: "wikipedia", endpoint: "https://en.wikipedia.org/w/api.php", academic: false },
  { id: "hackernews", endpoint: "https://hn.algolia.com/api/v1/search", academic: false },
  { id: "arxiv", endpoint: "https://export.arxiv.org/api/query", academic: true },
  { id: "reddit", endpoint: "https://www.reddit.com/search.json", academic: false },
  { id: "semantic_scholar", endpoint: "https://api.semanticscholar.org/graph/v1/paper/search", academic: true },
  { id: "duckduckgo", endpoint: "https://api.duckduckgo.com/", academic: false },
];

/**
 * The synthetic route the aggregator hands the egress veto. It carries a `runtime`
 * key + `egressClass: "cloud"`, so `processorOfRoute` classifies it as a distinct
 * EGRESS processor (proc !== null) — which is what makes the employer-work veto FIRE
 * (a non-egress route would fall through to ALLOW: a silent rule-5 fail-open). The
 * free sources ARE cloud, so this is honest; the aggregator never routes through the
 * broker (it self-runs the veto), so this route is a pure veto INPUT.
 */
export const FREE_SOURCE_EGRESS_ROUTE: ProviderRoute = {
  runtime: "free-source-web-research",
  model: "free-source-aggregator",
  endpoint: "https://web-research.egress.example",
  egressClass: "cloud",
};

/** One key-less outbound request the aggregator hands the injected transport. */
export interface FreeSourceFetchRequest {
  readonly source: string;
  readonly url: string;
}
/** The transport's raw response (an HTTP status + a raw body string). */
export interface FreeSourceFetchResponse {
  readonly status: number;
  readonly body: string;
}
/** The DEPENDENCY-INJECTED key-less transport (a FAKE in tests; real HTTP at arming). */
export interface FreeSourceTransport {
  send(req: FreeSourceFetchRequest, signal?: AbortSignal): Promise<FreeSourceFetchResponse>;
}

/** A per-source candidate result — source provenance preserved VERBATIM (`raw`). */
export interface FreeSourceResult {
  readonly source: string;
  /** True iff the transport returned a 2xx. A per-source fault is captured, not thrown. */
  readonly ok: boolean;
  /** The vendor body VERBATIM — parsed JSON when possible, else the raw string. */
  readonly raw?: unknown;
}

/** The aggregated candidate research (never applied; the schema gate validates it). */
export interface AggregatedResearch {
  readonly query: string;
  readonly results: readonly FreeSourceResult[];
}

/** The fail-closed fault when the egress veto denies (rule 5). Code-only (rule 7). */
export interface AggregatorEgressDenied {
  readonly code: "egress_denied";
  readonly reason: string;
}

/** The context an aggregation runs under — the veto inputs + the academic flag. */
export interface ResearchContext {
  readonly job: AgentJob;
  readonly egress: EgressPolicy;
  readonly workspace: { readonly type: WorkspaceType; readonly dataOwner: DataOwner };
  readonly academic?: boolean;
}

export interface FreeSourceAggregatorDeps {
  readonly transport: FreeSourceTransport;
  /** The egress veto — INJECTABLE only for testing; production uses the real @sow/policy veto. */
  readonly egressVeto?: typeof egressVeto;
}

export interface FreeSourceAggregator {
  research(query: string, ctx: ResearchContext): Promise<Result<AggregatedResearch, AggregatorEgressDenied>>;
}

// Build the candidate key-less query URL (arch_gap: the real per-source params are
// confirmed at §ARM-RESEARCH). The employer-content-bearing query rides the URL —
// which is EXACTLY why the egress veto must clear before this is ever built/sent.
function buildUrl(source: FreeSource, query: string): string {
  return `${source.endpoint}?q=${encodeURIComponent(query)}`;
}

// Fetch one source under a §16 throw-guard — a per-source fault is CAPTURED (ok:false),
// never thrown. The body is preserved VERBATIM (parsed JSON, else the raw string).
async function safeFetch(
  transport: FreeSourceTransport,
  source: FreeSource,
  query: string,
): Promise<FreeSourceResult> {
  try {
    const resp = await transport.send({ source: source.id, url: buildUrl(source, query) });
    const okStatus = resp.status >= 200 && resp.status < 300;
    let raw: unknown;
    try {
      raw = JSON.parse(resp.body);
    } catch {
      raw = resp.body; // verbatim fallback — never drop the source response
    }
    return { source: source.id, ok: okStatus, raw };
  } catch {
    // A thrown transport (network fault) is captured, not propagated (§16). No raw.
    return { source: source.id, ok: false };
  }
}

/**
 * Construct the free-source aggregator. `research` runs the egress veto FIRST (over
 * {@link FREE_SOURCE_EGRESS_ROUTE}); on DENY it fails closed WITHOUT touching the
 * transport; on ALLOW it fans out over the selected sources (academic ⇒ scholarly
 * only) and returns the aggregated candidate data. TOTAL never-throws.
 */
export function createFreeSourceAggregator(deps: FreeSourceAggregatorDeps): FreeSourceAggregator {
  const veto = deps.egressVeto ?? egressVeto;
  return {
    async research(query: string, ctx: ResearchContext): Promise<Result<AggregatedResearch, AggregatorEgressDenied>> {
      // EGRESS VETO FIRST — before ANY transport call (rule 5). Reuse the real veto.
      const decision = veto(ctx.job, FREE_SOURCE_EGRESS_ROUTE, ctx.egress, ctx.workspace);
      if (isDeny(decision)) {
        return err<AggregatorEgressDenied>({ code: "egress_denied", reason: decision.reason });
      }
      const sources = ctx.academic === true ? FREE_SOURCES.filter((s) => s.academic) : FREE_SOURCES;
      const results: FreeSourceResult[] = [];
      for (const source of sources) {
        results.push(await safeFetch(deps.transport, source, query));
      }
      return ok({ query, results });
    },
  };
}
