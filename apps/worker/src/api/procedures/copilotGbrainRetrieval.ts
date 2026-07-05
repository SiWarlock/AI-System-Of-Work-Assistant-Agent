// §9.6-real P3.1 — the GBrain-backed Copilot retrieval adapter (worker side).
//
// Implements `CopilotRetrievalPort` (./copilot) over the workspace-scoped, read-only `GbrainReadAdapter`
// (@sow/knowledge, task 4.7 — the typed proof that no write/generative capability reaches the brain).
// It replaces the interim `createFixtureRetrieval` once the live gbrain read transport + per-workspace
// grants are provisioned. This module is the DETERMINISTIC half — scoping + mapping + fail-closed — TDD'd
// with a fake adapter; the concrete `GbrainReadClient` transport (real gbrain HTTP serving I/O) and grant
// provisioning are the separate live-wiring seam.
//
// WS-8 (safety rule 4): retrieval is workspace-scoped by construction — the caller's `workspaceId` selects
// exactly ONE bound adapter (each adapter is federation-scoped `workspace_only` to one brain), and a
// mis-keyed / foreign adapter fails CLOSED. No cross-brain read. Fail-closed on unknown workspace,
// transport fault, or a malformed response — never fabricate context.
import { err, ok, isOk, failure } from "@sow/contracts";
import type { FailureVariant, Result } from "@sow/contracts";
import type { GbrainReadAdapter } from "@sow/knowledge";
import { unknownWorkspace } from "./copilot";
import type { CopilotRetrievalPort, RetrievedContext, RetrievedSource } from "./copilot";

/**
 * Default max passages per Copilot retrieval — bounds BOTH the request AND the accepted response, so an
 * over-returning adapter can't inflate the synthesis prompt. 8 is a small grounded context (a handful of
 * cited passages) that stays well within the model window; tune once the live brain + transport land.
 */
export const DEFAULT_GBRAIN_RETRIEVAL_LIMIT = 8;

export interface GbrainCopilotRetrievalDeps {
  /** Per-workspace read adapters (one bound brain each). A miss fails closed (WS-8, unprovisioned). */
  readonly adapters: ReadonlyMap<string, GbrainReadAdapter>;
  /** Max passages per query; defaults to DEFAULT_GBRAIN_RETRIEVAL_LIMIT. */
  readonly limit?: number;
}

/** First non-empty string among the candidate keys of `obj`, else undefined. Pure. */
function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

// The gbrain search hit shape is `unknown` at the read boundary; these are the tolerant field aliases we
// map from (the request `{query,limit}` shape below is equally provisional — adjust both against the live
// gbrain result once the brain is populated + the transport is wired).
const CONTENT_KEYS = ["content", "text", "chunk", "body", "snippet"] as const;
// OPAQUE id fields only — deliberately NO `path`: a filesystem path is not a safe citationId (it would be
// rejected by the downstream UI-safe `uiSafeOpaqueRef` gate, dropping the whole answer, and could leak a
// vault path). A hit whose only identifier is a path is skipped (fail-closed) until a live-wiring slice
// opaque-hashes path-derived ids.
const ID_KEYS = ["source_id", "sourceId", "page_id", "pageId", "id"] as const;
const TITLE_KEYS = ["title", "name", "heading", "source"] as const;
const DEFAULT_TITLE = "Untitled note";

/**
 * PURE: map a gbrain search result (a top-level array of hits) to a `RetrievedContext` with ALIGNED
 * block↔source pairs (one block per citable source — fixes the P2.3 pairing gap). A hit missing usable
 * content OR a source id is SKIPPED (it can't be grounded/cited); a non-array response fails CLOSED
 * (never fabricate context). citationIds are namespaced `gbrain:<id>` so they stay opaque (the downstream
 * UI-safe gate additionally rejects a path/URL-shaped id).
 */
export function parseGbrainSearchResult(
  workspaceId: string,
  raw: unknown,
  limit: number = DEFAULT_GBRAIN_RETRIEVAL_LIMIT,
): Result<RetrievedContext, FailureVariant> {
  if (!Array.isArray(raw)) {
    // A deterministic shape fault (not transient) — a retry yields the same shape, so retryable stays false.
    return err(
      failure("degraded_unavailable", "gbrain search returned an unexpected shape", {
        cause: { code: "GBRAIN_RESULT_MALFORMED" },
      }),
    );
  }
  const blocks: string[] = [];
  const sources: RetrievedSource[] = [];
  for (const item of raw) {
    if (blocks.length >= limit) break; // cap the ACCEPTED response too — never inflate the prompt
    if (typeof item !== "object" || item === null) continue; // skip a non-object hit
    const obj = item as Record<string, unknown>;
    const content = firstString(obj, CONTENT_KEYS);
    const id = firstString(obj, ID_KEYS);
    if (content === undefined || id === undefined) continue; // can't ground/cite without both
    blocks.push(content);
    sources.push({ citationId: `gbrain:${id}`, title: firstString(obj, TITLE_KEYS) ?? DEFAULT_TITLE });
  }
  return ok({ workspaceId, blocks, sources });
}

/**
 * Build a `CopilotRetrievalPort` over per-workspace gbrain read adapters. Selects the bound adapter for
 * the requested workspace (WS-8: unknown ⇒ WORKSPACE_NOT_FOUND; a mis-keyed/foreign adapter ⇒ scope
 * mismatch — both fail closed), runs the read-only `search`, and maps the result. A transport fault folds
 * to a degraded failure; a malformed shape fails closed. Never throws (§16).
 */
export function createGbrainCopilotRetrieval(deps: GbrainCopilotRetrievalDeps): CopilotRetrievalPort {
  const limit = deps.limit ?? DEFAULT_GBRAIN_RETRIEVAL_LIMIT;
  return {
    retrieve: async (workspaceId, question): Promise<Result<RetrievedContext, FailureVariant>> => {
      const adapter = deps.adapters.get(workspaceId);
      if (adapter === undefined) return err(unknownWorkspace()); // unprovisioned ⇒ fail closed
      // Defense-in-depth over provisioning: the bound adapter MUST be for the requested workspace — a
      // mis-keyed map entry or a smuggled foreign brain fails closed, never serving another brain (WS-8).
      if (adapter.workspaceId !== workspaceId) {
        return err(
          failure("validation_rejected", "gbrain adapter workspace mismatch", {
            cause: { code: "RETRIEVAL_SCOPE_MISMATCH" },
          }),
        );
      }
      const result = await adapter.search({ query: question, limit });
      if (!isOk(result)) {
        // A transport/network fault is transient — retryable so the ask can be re-driven (10.2 route).
        return err(
          failure("degraded_unavailable", "gbrain read failed", {
            retryable: true,
            cause: { code: "GBRAIN_READ_FAULT" },
          }),
        );
      }
      return parseGbrainSearchResult(workspaceId, result.value, limit);
    },
  };
}
