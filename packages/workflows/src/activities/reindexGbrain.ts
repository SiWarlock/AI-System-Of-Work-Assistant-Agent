// @sow/workflows — slice 7.6 ACTIVITY: re-index the committed revision into GBrain
// (inv-4 — AFTER the Markdown commit, async + idempotent, never rolls back).
//
// This is an ACTIVITY, NOT workflow code — it runs worker-side and dispatches the
// GBrain re-index behind an INJECTED client (the @sow/knowledge index-sync path at
// the worker-wiring seam), so it is Vitest-unit-testable with a fake and never
// touches a real GBrain in the module. It implements {@link ReindexGbrainPort}.
//
// SAFETY (inv-4): re-index runs strictly AFTER the KnowledgeWriter commit — it is
// KEYED BY `revisionId`, so it structurally CANNOT run before a commit exists: an
// empty/absent revisionId fails closed (`revision_unavailable`) and the client is
// never called. It is IDEMPOTENT — re-indexing the same revision is a no-op
// (`already_indexed`), never a second index job. And it NEVER rolls back the commit:
// a re-index FAILURE is a typed err the caller surfaces (and retries via 7.5), while
// the durable Markdown commit stands.
//
// §16: returns a typed Result — never throws across the activity boundary.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type {
  ReindexGbrainPort,
  ReindexError,
} from "../ports/meetingCloseout";

/** The idempotent GBrain re-index outcome (a fresh index vs. an already-indexed no-op). */
export interface GbrainReindexAck {
  readonly kind: "indexed" | "already_indexed";
  readonly revisionId: string;
}

/**
 * The injected GBrain re-index client (the @sow/knowledge index-sync dispatcher at
 * the worker-wiring seam). Idempotent by revisionId; returns a typed Result, never
 * throws.
 */
export interface GbrainReindexClient {
  reindex(revisionId: string): Promise<Result<GbrainReindexAck, ReindexError>>;
}

/** Injected deps for the reindex activity: the GBrain re-index client. */
export interface ReindexActivityDeps {
  readonly client: GbrainReindexClient;
}

/**
 * SAFETY RULE 7 — redact an injected {@link GbrainReindexClient}'s failure before it
 * crosses the `meetingReindex` activity boundary. `client` wraps the @sow/knowledge
 * index-sync dispatcher (out of this package's territory), so neither `cause` NOR
 * `message` can be established safe: `cause` may be a raw GBrain/HTTP rejection
 * object, and `message` may just as plausibly embed provider-formatted detail (a
 * request URL, an auth header, a response-body fragment) — nothing in
 * {@link GbrainReindexClient}'s contract forbids it. Once `meetingReindex` runs as a
 * real Temporal activity, either would land durably in workflow history. Mirrors
 * `redactConnectorRefreshError` (activities/refreshConnectors.ts): switch on the
 * closed `code`, build a FRESH literal — never read `.cause`, never forward
 * `.message`. The `code` itself crosses byte-identically (every consumer switches
 * on it).
 *
 * `revision_unavailable` HERE is a DIFFERENT state than the pre-flight guard below
 * (`createReindexActivity`'s empty-`revisionId` early return — same `code`, same
 * enum member): this branch fires only when the CLIENT reports `revision_unavailable`
 * — i.e. `reindex` was called with a non-empty revisionId (a commit already
 * happened) and the index client still could not find/act on it. The pre-flight
 * message ("reindex requires a committed revisionId…") is true only for the
 * pre-flight case; reusing it here would tell the operator no commit landed when the
 * opposite is true (the Markdown commit succeeded and the INDEXING is what failed)
 * — worse than a generic message, because it is actively misleading.
 */
function redactReindexError(error: ReindexError): ReindexError {
  switch (error.code) {
    case "reindex_failed":
      return { code: "reindex_failed", message: "gbrain reindex failed" };
    case "revision_unavailable":
      return {
        code: "revision_unavailable",
        message: "gbrain reindex failed: the index client reported the committed revision unavailable",
      };
  }
}

/**
 * Build a {@link ReindexGbrainPort} over the injected client (inv-4). It requires a
 * non-empty revisionId (i.e. a commit already happened) — an empty one fails closed
 * without calling the client. It is idempotent and never rolls back the commit.
 * Never throws.
 */
export function createReindexActivity(deps: ReindexActivityDeps): ReindexGbrainPort {
  return {
    async reindex(revisionId: string): Promise<Result<void, ReindexError>> {
      // inv-4: NEVER before a commit. No revisionId ⇒ no commit ⇒ fail closed, and
      // the client is not called.
      if (revisionId.trim().length === 0) {
        return err({
          code: "revision_unavailable",
          message: "reindex requires a committed revisionId (runs only AFTER the Markdown commit)",
        });
      }
      const result = await deps.client.reindex(revisionId);
      if (!result.ok) {
        // A reindex failure is surfaced typed — it NEVER rolls the commit back.
        // SAFETY RULE 7 — see `redactReindexError` above: neither the client's raw
        // `cause` nor its raw `message` crosses; only the stable `code` + a fixed,
        // safe message do.
        return err(redactReindexError(result.error));
      }
      return ok(undefined);
    },
  };
}
