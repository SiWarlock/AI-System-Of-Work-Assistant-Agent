// §9.6 — the vault-backed Copilot passage retrieval adapter (worker side, UNGATED).
//
// `copilot.ts`'s header names the real gap: "the real adapter is GBrain/GCL retrieval (deferred —
// the app runs over stubs; a passage-serving read-model does not exist yet)". This module IS that
// missing "somewhere to read passages from" — but built over ALREADY-COMMITTED vault Markdown, not
// gbrain. It reuses the EXISTING `CommittedVaultReader` seam (servingContextLoader.ts /
// servingContextBootReaders.ts, C5.4b's `createCommittedVaultReader`) rather than inventing a new
// vault-access port: the same fs-backed reader that assembles the serving-context's allow-set can
// hand this retrieval a `CanonicalVaultSnapshot` too.
//
// UNGATED by design: this is a pure LOCAL read of content KnowledgeWriter already committed (safety
// rule 1 — read-only, never writes; nothing egresses, no secret, no external process), so — unlike
// the live gbrain HTTP transport (copilotGbrainRetrieval.ts, an owner crossing) — there is no arming
// decision here. What keeps it dormant today is composition-only: `CopilotDepsOptions.readCommittedVault`
// (copilotClaudeSynthesis.ts) is OPTIONAL and boot does not yet construct a real
// `createCommittedVaultReader({resolveVault})` to pass it (the workspaceId→VaultFs mapping is boot's,
// outside this package's api/ territory) — a composition-root wiring task, not a permission gate.
//
// One passage per committed `.md` page (title + body, length-capped) reordered by the deterministic,
// zero-egress `rerank` (@sow/knowledge, 13.17) then capped to `limit` — mirrors
// `createGbrainCopilotRetrieval`'s reorder-before-cap discipline (worker Lesson 6: rebuild the
// blocks/sources pair POSITIONALLY from the SAME reordered identity, never a second independently
// re-sorted array).
//
// WS-8 (safety rule 4): scoped to exactly the requested workspace — a reader returning a
// foreign-workspace snapshot fails CLOSED (defense-in-depth, mirrors `createGbrainCopilotRetrieval`'s
// adapter-workspace check and `servingContextLoader`'s own re-check of the same seam). Never egresses
// (a local fs read only) — the Employer-Work veto still gates SYNTHESIS upstream, unchanged by this file.
import { createHash } from "node:crypto";
import { err, ok, failure } from "@sow/contracts";
import type { FailureVariant, Result } from "@sow/contracts";
import type { CanonicalVaultSnapshot } from "@sow/knowledge";
import { rerank, type Passage } from "@sow/knowledge";
import { unknownWorkspace } from "./copilot";
import type { CopilotRetrievalPort, RetrievedContext, RetrievedSource } from "./copilot";
import type { CommittedVaultReader } from "./servingContextLoader";

/** Default max passages returned per ask — bounds the FINAL accepted response (post-rerank). */
export const DEFAULT_VAULT_PASSAGE_LIMIT = 8;

/** Max characters kept per page passage — bounds the synthesis prompt against an unusually large note. */
const MAX_PASSAGE_CHARS = 4000;

const FM_FENCE = "---";

/**
 * Opaque, path-INDEPENDENT citation id — deliberately never embeds the raw path (a filesystem path is
 * not a safe citationId: it would be rejected by the downstream UI-safe `uiSafeOpaqueRef` gate and
 * could leak a vault path, mirroring the sibling gbrain adapter's own `citationId` discipline).
 * Deterministic (same path ⇒ same id across calls) — a stable content-independent identity, like the
 * `page:<slug>` fact identity elsewhere, but hashed here since a passage has no such grammar to reuse.
 */
function opaquePageId(path: string): string {
  return `vault:${createHash("sha256").update(path, "utf8").digest("hex").slice(0, 16)}`;
}

/** Last path segment with a trailing `.md` stripped — the title fallback when no frontmatter title exists. */
function basenameTitle(path: string): string {
  const segs = path.split("/");
  const base = segs[segs.length - 1] ?? path;
  return base.replace(/\.md$/iu, "");
}

/**
 * PURE: split fenced (`---`) frontmatter from body and read an optional `title:` value. Deliberately
 * NOT the hashing/identity authority (`packages/knowledge`'s `computePageProvenance` owns that) —
 * this is extraction-only, tolerant of a malformed/absent fence (falls back to treating the whole
 * content as body, same as the canonical-fact-deriver's own `parseNote`).
 */
function extractTitleAndBody(content: string): { readonly title: string | undefined; readonly body: string } {
  if (!content.startsWith(`${FM_FENCE}\n`)) return { title: undefined, body: content };
  const closeIdx = content.indexOf(`\n${FM_FENCE}\n`, FM_FENCE.length);
  if (closeIdx === -1) return { title: undefined, body: content };
  const fm = content.slice(FM_FENCE.length + 1, closeIdx);
  let title: string | undefined;
  for (const line of fm.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    if (line.slice(0, sep).trim() === "title") {
      const v = line.slice(sep + 1).trim();
      if (v.length > 0) title = v;
    }
  }
  return { title, body: content.slice(closeIdx + FM_FENCE.length + 2) };
}

/**
 * PURE: derive one passage per `.md` page in the snapshot. A page whose body is empty after stripping
 * frontmatter is SKIPPED (nothing to ground/cite — mirrors the gbrain adapter skipping a contentless
 * hit). Body is capped at {@link MAX_PASSAGE_CHARS}; citationId is opaque (never the raw path).
 */
export function deriveVaultPassages(
  snapshot: CanonicalVaultSnapshot,
): { readonly blocks: readonly string[]; readonly sources: readonly RetrievedSource[] } {
  const blocks: string[] = [];
  const sources: RetrievedSource[] = [];
  const paths = [...snapshot.files.keys()].sort(); // deterministic pre-rerank order
  for (const path of paths) {
    if (!/\.md$/iu.test(path)) continue; // only Markdown pages are passages
    const content = snapshot.files.get(path);
    if (content === undefined) continue;
    const { title, body } = extractTitleAndBody(content);
    const trimmed = body.trim();
    if (trimmed.length === 0) continue; // nothing to ground/cite
    const capped = trimmed.length > MAX_PASSAGE_CHARS ? trimmed.slice(0, MAX_PASSAGE_CHARS) : trimmed;
    blocks.push(capped);
    sources.push({ citationId: opaquePageId(path), title: title ?? basenameTitle(path) });
  }
  return { blocks, sources };
}

/**
 * Reorder an ALIGNED blocks/sources pair by query relevance via {@link rerank}, then slice to
 * `limit` (13.17 reorder-before-cap). Rebuilds blocks/sources POSITIONALLY from the reranked id order
 * (worker Lesson 6 — never trust a second, independently re-sorted array). `rerank` is
 * content-preserving + total never-throws, so this function inherits both.
 */
function rerankAndCap(
  question: string,
  blocks: readonly string[],
  sources: readonly RetrievedSource[],
  limit: number,
): { readonly blocks: readonly string[]; readonly sources: readonly RetrievedSource[] } {
  if (blocks.length === 0) return { blocks, sources };
  const passages: Passage[] = blocks.map((text, i) => ({ id: sources[i]!.citationId, text }));
  const reordered = rerank(question, passages);
  const byId = new Map<string, { readonly block: string; readonly source: RetrievedSource }>(
    blocks.map((block, i) => [sources[i]!.citationId, { block, source: sources[i]! }]),
  );
  const outBlocks: string[] = [];
  const outSources: RetrievedSource[] = [];
  for (const p of reordered) {
    if (outBlocks.length >= limit) break;
    const pair = byId.get(p.id);
    if (pair === undefined) continue; // defensive: rerank's own contract guarantees this never fires
    outBlocks.push(pair.block);
    outSources.push(pair.source);
  }
  return { blocks: outBlocks, sources: outSources };
}

export interface VaultPassageRetrievalDeps {
  /** Reads a workspace's committed vault @ head — the existing C5.4b seam (servingContextLoader.ts). */
  readonly readCommittedVault: CommittedVaultReader;
  /** Max passages per query; defaults to DEFAULT_VAULT_PASSAGE_LIMIT. */
  readonly limit?: number;
}

/**
 * Build a `CopilotRetrievalPort` over ALREADY-COMMITTED vault Markdown. `undefined` from the reader
 * (never-indexed workspace, or the reader left unbound) fails closed as an unknown workspace —
 * mirroring `createFixtureRetrieval`/`createGbrainCopilotRetrieval`'s "unprovisioned ⇒ fail closed"
 * convention; a BOUND reader over a genuinely empty vault (zero readable `.md`) is a legitimate
 * ok-empty answer, not an error. Defense-in-depth re-checks the returned snapshot's own workspaceId
 * (WS-8). Never egresses (a local fs read only); never throws (§16 — a throwing reader folds to a
 * typed, retryable degraded failure, mirroring the gbrain adapter's transport-fault handling).
 */
export function createVaultPassageRetrieval(deps: VaultPassageRetrievalDeps): CopilotRetrievalPort {
  const limit = deps.limit ?? DEFAULT_VAULT_PASSAGE_LIMIT;
  return {
    retrieve: async (workspaceId, question): Promise<Result<RetrievedContext, FailureVariant>> => {
      let snapshot: CanonicalVaultSnapshot | undefined;
      try {
        snapshot = await deps.readCommittedVault(workspaceId);
      } catch {
        return err(
          failure("degraded_unavailable", "committed vault read failed", {
            retryable: true,
            cause: { code: "VAULT_READ_FAULT" },
          }),
        );
      }
      if (snapshot === undefined) return err(unknownWorkspace()); // never-indexed / unbound ⇒ fail closed
      // Defense-in-depth (WS-8): the snapshot MUST describe the REQUESTED workspace.
      if (String(snapshot.workspaceId) !== workspaceId) {
        return err(
          failure("validation_rejected", "vault snapshot workspace mismatch", {
            cause: { code: "RETRIEVAL_SCOPE_MISMATCH" },
          }),
        );
      }
      const derived = deriveVaultPassages(snapshot);
      const { blocks, sources } = rerankAndCap(question, derived.blocks, derived.sources, limit);
      return ok({ workspaceId, blocks, sources });
    },
  };
}
