// §9.6-real P3-live — the subprocess GBrain retrieval transport (worker side).
//
// Connects the DETERMINISTIC P3.1 mapper (`parseGbrainSearchResult`, ./copilotGbrainRetrieval) to a REAL
// gbrain read by shelling the local `gbrain call query` CLI. This is the interim TEST transport — it is
// NOT the architecture's mandated GbrainReadGrant `transport:"http"` MCP path (`gbrain serve --http`), and
// it reads ONE local brain that (in this seeded setup) holds a SINGLE workspace's content.
//
// WS-8 (safety rule 4) holds here BY CONSTRUCTION, not by adapter scoping: exactly ONE workspace
// (`servedWorkspaceId`, whose content the brain IS) ever triggers a gbrain read; every OTHER workspace is
// routed to the fixture `fallback` (empty for a known workspace, fail-closed for unknown) and NEVER reads
// the brain — so a single-brain deployment cannot leak across workspaces through this transport. NOTE: the
// http-grant transport (copilotGbrainHttp.ts) adds no per-workspace scoping of its own either — it too
// rests on the served brain holding ONLY that workspace's content. TRUE per-workspace isolation needs a
// brain/source PER workspace (a grant + serve per workspace); see the session doc.
//
// Split for TDD: `normalizeGbrainHits` (PURE) + `createGbrainSubprocessRetrieval` (PURE composite over an
// injected `exec` + `fallback`) are unit-tested; `createGbrainCliExec` (child_process) is the imperative
// seam, integration-tested behind a gate (never in the default suite).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { err, isOk, failure } from "@sow/contracts";
import type { FailureVariant, Result } from "@sow/contracts";
import type { CopilotRetrievalPort, RetrievedContext } from "./copilot";
import { parseGbrainSearchResult, DEFAULT_GBRAIN_RETRIEVAL_LIMIT } from "./copilotGbrainRetrieval";

/**
 * The workspace whose content the seeded local brain holds — the SoW build docs, a personal-business
 * side project (per the gbrain-workspaces convention "my own project → personal-business"). ONLY this
 * workspace reads the brain; every other is fixture-fallback, so WS-8 holds for the single-brain seed.
 */
export const DEFAULT_GBRAIN_COPILOT_WORKSPACE = "personal-business";

/**
 * The injected gbrain read: a question + a passage limit → the PARSED gbrain response (a top-level array
 * of hits) as `unknown`, or a typed transport fault. Unit tests inject a canned Result; boot injects the
 * real `createGbrainCliExec()`. Keeping the seam a plain function (not the CLI) makes the mapping + the
 * WS-8 routing deterministically testable without spawning a subprocess.
 */
export type GbrainQueryExec = (
  question: string,
  limit: number,
) => Promise<Result<unknown, FailureVariant>>;

/** The gbrain `call query` hit fields we map from — all optional/unknown at the untrusted read boundary. */
interface GbrainHit {
  readonly chunk_text?: unknown;
  readonly slug?: unknown;
  readonly title?: unknown;
}

/**
 * PURE: normalize a gbrain `call query` response (a top-level array of hits) into the `{content, id,
 * title}` shape `parseGbrainSearchResult` maps from. gbrain's own field names don't match that mapper's
 * key aliases, so a raw pass-through would be WRONG on two counts:
 *   - its content lives in `chunk_text` (not a CONTENT_KEY → every hit would be dropped for lack of content);
 *   - its only per-hit identifier is the path-like `slug` (NOT in the mapper's ID_KEYS), while `source_id`
 *     IS an ID_KEY but is the gbrain SOURCE ("default" for every hit) — so a pass-through would collapse
 *     every citation to `gbrain:default`.
 * So we map `chunk_text→content` and derive the id from `slug` with `/`→`:` (a path is rejected by the
 * downstream `uiSafeOpaqueRef` gate; `:` keeps it an opaque scheme-style token). A NON-array input is
 * returned UNCHANGED so the mapper fails closed on it; a hit missing `chunk_text` or `slug` yields an
 * object lacking `content`/`id`, which the mapper then SKIPS (can't ground/cite) — fail-closed per hit.
 *
 * CITATION GRANULARITY IS PER-PAGE, BY DESIGN. gbrain returns one hit PER CHUNK, so several chunks of the
 * SAME note share a `slug` → the same `gbrain:<slug>` citationId (with distinct `content` blocks). That is
 * intentional: the synthesis prompt shows every excerpt under that one cite (all grounded in that note),
 * and the downstream reconciliation dedupes to ONE page-level citation — cleaner than citing the same note
 * once per chunk. (Per-chunk ids `gbrain:<slug>:<chunk_index>` are the alternative if per-passage citations
 * are ever wanted; page-level is the better UX for the Copilot answer.)
 */
export function normalizeGbrainHits(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((item) => {
    if (typeof item !== "object" || item === null) return item; // parse skips non-objects too
    const hit = item as GbrainHit;
    const out: { content?: string; id?: string; title?: string } = {};
    // Symmetric non-empty guards on both id AND content: an empty string can't ground or cite (the mapper
    // re-checks this too, but guarding here keeps the two fields consistent and the intent explicit).
    if (typeof hit.chunk_text === "string" && hit.chunk_text.length > 0) out.content = hit.chunk_text;
    if (typeof hit.slug === "string" && hit.slug.length > 0) out.id = hit.slug.replace(/\//g, ":");
    if (typeof hit.title === "string") out.title = hit.title;
    return out;
  });
}

/** Deps for the composite subprocess retrieval. */
export interface GbrainSubprocessRetrievalDeps {
  /** The gbrain read seam (canned in tests; the real CLI at boot). */
  readonly exec: GbrainQueryExec;
  /** The ONE workspace served from the brain — every other request goes to `fallback` (WS-8). */
  readonly servedWorkspaceId: string;
  /** Handles every non-served workspace (fixture: empty for known, fail-closed for unknown). */
  readonly fallback: CopilotRetrievalPort;
  /** Max passages per query; defaults to DEFAULT_GBRAIN_RETRIEVAL_LIMIT. */
  readonly limit?: number;
}

/**
 * Build a `CopilotRetrievalPort` that reads the local gbrain for ONE served workspace and delegates every
 * other workspace to `fallback`. Only the served workspace triggers a brain read (WS-8 by construction:
 * no other workspace can reach the single brain through this port). The served read runs `exec`, normalizes
 * the hits, and maps them through the reviewed `parseGbrainSearchResult` (aligned block↔source pairs,
 * `gbrain:<id>` opaque citations, cap, fail-closed on a malformed shape). Never throws (§16 — `exec`
 * returns a typed Result; the mapper is total).
 */
export function createGbrainSubprocessRetrieval(
  deps: GbrainSubprocessRetrievalDeps,
): CopilotRetrievalPort {
  const limit = deps.limit ?? DEFAULT_GBRAIN_RETRIEVAL_LIMIT;
  return {
    retrieve: async (workspaceId, question): Promise<Result<RetrievedContext, FailureVariant>> => {
      // WS-8 by construction: only the served workspace reads the brain. Every other workspace — known or
      // unknown — is handled by the fixture fallback (empty context / fail-closed), never a gbrain read.
      if (workspaceId !== deps.servedWorkspaceId) {
        return deps.fallback.retrieve(workspaceId, question);
      }
      const execResult = await deps.exec(question, limit);
      if (!isOk(execResult)) return execResult; // the exec builds the typed transport fault
      return parseGbrainSearchResult(workspaceId, normalizeGbrainHits(execResult.value), limit);
    },
  };
}

// ── the real CLI transport (imperative seam — integration-tested, never unit-tested) ─────────────

const execFileAsync = promisify(execFile);

/** Knobs for the real `gbrain call query` CLI transport. */
export interface GbrainCliExecOptions {
  /** The gbrain binary (name on PATH or absolute path). Defaults to "gbrain". */
  readonly binary?: string;
  /** Per-query timeout (ms). Defaults to 60_000 (a cold embed + query can take a few seconds). */
  readonly timeoutMs?: number;
  /** Max child stdout buffer (bytes). Defaults to 8 MiB. */
  readonly maxBuffer?: number;
}

/**
 * The REAL gbrain read: shells `gbrain call query '{"query":Q,"limit":N}'` (the raw tool JSON — NOT the
 * human `gbrain query` format), parses stdout, and returns the hits array as `unknown`. Redaction-safe:
 * on ANY failure (spawn error, non-zero exit, missing array, JSON parse) it returns ONLY a stable typed
 * fault code — the child's stderr/message (which may echo the query) is DROPPED, never surfaced (§16 /
 * safety 7). A transport fault is `retryable` (transient); a valid-JSON-but-not-an-array payload is left
 * for `parseGbrainSearchResult` to reject as a non-retryable malformed shape.
 *
 * NOTE: the child needs VOYAGE_API_KEY in its env (gbrain embeds the query for semantic search) and the
 * `gbrain` binary on PATH — a missing key/binary surfaces as GBRAIN_CLI_FAULT, never a throw. We DELETE
 * any inherited `GBRAIN_EMBEDDING_MODEL` so a stale override can't fight the brain's own embedding config.
 *
 * SINGLE-CONNECTION CONSTRAINT (why this is test-only): the local brain is a PGlite (embedded Postgres)
 * file — ONE process may hold it at a time. A concurrently-running `gbrain serve` (e.g. the gbrain MCP
 * server) holds that lock, so this CLI read BLOCKS and eventually times out (→ GBRAIN_CLI_FAULT). This is
 * precisely why the architecture mandates the `transport:"http"` GbrainReadGrant path (one server owns the
 * DB; readers go over HTTP). This subprocess transport is a retrieval TEST seam, not the production path.
 */
export function createGbrainCliExec(options?: GbrainCliExecOptions): GbrainQueryExec {
  const binary = options?.binary ?? "gbrain";
  const timeout = options?.timeoutMs ?? 60_000;
  const maxBuffer = options?.maxBuffer ?? 8 * 1024 * 1024;
  return async (question, limit) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env["GBRAIN_EMBEDDING_MODEL"];
    const payload = JSON.stringify({ query: question, limit });
    try {
      const { stdout } = await execFileAsync(binary, ["call", "query", payload], {
        encoding: "utf8",
        env,
        timeout,
        maxBuffer,
      });
      // gbrain writes gateway warnings to stderr, so stdout is clean JSON — but defensively locate the
      // opening bracket in case a warning ever lands on stdout. No bracket ⇒ not a hits array ⇒ fault.
      const start = stdout.indexOf("[");
      if (start < 0) {
        // A DETERMINISTIC shape fault (no top-level array — e.g. a gbrain error object or a version-mismatch
        // shape): the same query reproduces it, so it is NOT retryable (a retry loop would keep failing).
        // This mirrors the sibling `parseGbrainSearchResult`'s non-retryable GBRAIN_RESULT_MALFORMED. Only
        // the transient transport faults below (spawn error / timeout) stay retryable.
        return err(
          failure("degraded_unavailable", "gbrain returned no result array", {
            retryable: false,
            cause: { code: "GBRAIN_CLI_EMPTY" },
          }),
        );
      }
      return { ok: true, value: JSON.parse(stdout.slice(start)) as unknown };
    } catch {
      // Drop the SDK/child error entirely — return only the stable code (no content ever reaches a sink).
      return err(
        failure("degraded_unavailable", "gbrain read failed", {
          retryable: true,
          cause: { code: "GBRAIN_CLI_FAULT" },
        }),
      );
    }
  };
}
