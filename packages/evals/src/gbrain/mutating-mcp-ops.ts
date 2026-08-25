// The gbrain MCP tool catalog's write/mutating-op classification (task 12.22).
//
// gbrain 0.35.1.0's real MCP tool catalog has no `read`/`write` TAG in `tools/list` — the
// scope enforcement lives server-side (verified live: a `scope:['read']` token gets
// `{"error":"insufficient_scope","message":"Operation <name> requires 'write' scope"}` from
// the REAL server for every op below). This module is the EVAL-side classification used to
// drive an EXHAUSTIVE per-tool conformance sweep over whatever `tools/list` the pinned build
// actually reports, rather than trusting a hand-maintained list to stay complete as the
// upstream catalog changes.
//
// `KNOWN_WRITE_OPS` is the literal set named in task 12.22's Done-when
// (`put_page`/`add_link`/`add_tag`/`delete_page`/`restore_page`/`purge_deleted_pages`/…) plus
// the sibling ops of the SAME tool families (link/tag remove, timeline, raw-data, facts,
// versions, sources, jobs) — every one independently confirmed present in the REAL 0.35.1.0
// `tools/list` output during this session EXCEPT `purge_deleted_pages`, which the real catalog
// does not expose under that name (see the suite's own finding comment).

/** The literal write-shaped ops named in 12.22's Done-when + their same-family siblings,
 *  confirmed present in the real gbrain 0.35.1.0 MCP `tools/list` catalog. */
export const KNOWN_WRITE_OPS = [
  "put_page",
  "delete_page",
  "restore_page",
  "add_link",
  "remove_link",
  "add_tag",
  "remove_tag",
  "add_timeline_entry",
  "put_raw_data",
  "revert_version",
  "forget_fact",
  "log_ingest",
  "sources_add",
  "sources_remove",
] as const;

/** Named in 12.22's Done-when but ABSENT from the real 0.35.1.0 MCP tool catalog (verified
 *  live via `tools/list` during this session) — there is no `purge_deleted_pages` MCP tool to
 *  call. Kept as a DISTINCT, documented set (not silently folded into `KNOWN_WRITE_OPS`) so a
 *  future gbrain build that adds it is caught by the exhaustive `tools/list` sweep below, and
 *  so the suite's assertion about it stays honest (`unknown_operation`, not
 *  `insufficient_scope`). */
export const NAMED_BUT_ABSENT_WRITE_OPS = ["purge_deleted_pages"] as const;

/** Job-control ops: mutate job/queue state even though they don't touch a page/link/tag. */
export const KNOWN_JOB_MUTATION_OPS = [
  "submit_job",
  "cancel_job",
  "pause_job",
  "resume_job",
  "retry_job",
  "replay_job",
  "send_job_message",
] as const;

/** A representative read-only op per tool family, used as the suite's positive control (the
 *  SAME read-scoped token that rejects every write op above must still succeed on these).
 *  Every entry here was LIVE-VERIFIED this session to return a clean (non-`isError`) result
 *  for a `scope:['read']` token against an EMPTY scratch brain — deliberately excluding two
 *  ops that looked read-shaped but are NOT: `get_stats`/`get_health` came back
 *  `insufficient_scope … requires 'admin' scope` (a THIRD scope tier this suite didn't set out
 *  to find — the real lattice is read/write/admin, not just read/write), and `get_page` on a
 *  nonexistent slug comes back `isError:true` with `page_not_found` — a legitimate not-found
 *  that the production `extractMcpResultEnvelope` maps to the SAME generic
 *  `GBRAIN_HTTP_TOOL_ERROR` code a scope rejection gets, so it can't drive a clean positive
 *  control through that seam. */
export const KNOWN_READ_OPS = ["query", "search", "list_pages", "get_tags", "get_links", "get_timeline", "whoami"] as const;

/** Confirmed `scope:'admin'`-gated (NOT `read`) — a read-scoped `GbrainReadGrant` token cannot
 *  call these either, a stricter posture than 12.22's Done-when names but consistent with it
 *  (a read grant must reject anything beyond read). Recorded as its own set rather than folded
 *  into `KNOWN_WRITE_OPS` because the server's OWN rejection reason names a different scope
 *  tier ('admin', not 'write') — an honest distinction, not a re-classification of convenience. */
export const KNOWN_ADMIN_ONLY_OPS = ["get_stats", "get_health"] as const;

/** Verb prefixes that name a mutating MCP tool by gbrain's own naming convention (observed
 *  across the real 65-tool 0.35.1.0 catalog: every mutating tool name starts with one of
 *  these). Used to sweep the REAL `tools/list` response exhaustively rather than trusting
 *  `KNOWN_WRITE_OPS` to stay complete as the upstream catalog changes. */
const MUTATING_PREFIXES = [
  "put_",
  "delete_",
  "restore_",
  "add_",
  "remove_",
  "revert_",
  "forget_",
  "purge_",
  "log_",
  "submit_",
  "cancel_",
  "pause_",
  "resume_",
  "retry_",
  "replay_",
  "send_",
] as const;

/** `sources_add`/`sources_remove` mutate but don't match a `MUTATING_PREFIXES` prefix (the verb
 *  trails the noun) — named explicitly rather than widening the prefix heuristic to false-positive
 *  on `sources_list`/`sources_status`. */
const MUTATING_EXACT_NAMES = new Set<string>(["sources_add", "sources_remove"]);

/**
 * Classify an MCP tool name as (probably) mutating, by gbrain's OWN naming convention. A
 * FALSE POSITIVE (a read op misclassified as mutating) only makes the live sweep test an
 * op that should already succeed as a read — the sweep would then correctly fail loudly, not
 * silently under-cover. A false negative (a mutating op misclassified as read) is the risk
 * this errs against: the prefix set above was derived from the REAL 65-tool catalog captured
 * live during this session, not guessed.
 */
export function isLikelyMutatingToolName(name: string): boolean {
  if (MUTATING_EXACT_NAMES.has(name)) return true;
  return MUTATING_PREFIXES.some((p) => name.startsWith(p));
}
