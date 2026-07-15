// Rebuild-from-Markdown (§6, task 4.9; REQ-D-001, safety rule 1). A full re-index
// reconstructs the GBrain semantic node set from committed Markdown ALONE, via the
// gbrain-INDEPENDENT CanonicalFactDeriver (task 4.14). This is the executable proof
// that GBrain is DISPOSABLE / DERIVED: the rebuilt brain recovers exactly the nodes
// recoverable from canonical Markdown — no more, no less — so the DB never holds a
// semantic fact that Markdown cannot reproduce.
//
// The rebuild is a WHOLESALE REPLACE of the derived store (not an incremental merge
// like the 4.8 index-sync apply). That is load-bearing for safety rule 1: because a
// rebuild derives only from Markdown, a quarantined DB-only fact (task 4.9 parity)
// has no Markdown bytes and is therefore STRUCTURALLY ABSENT from the rebuilt set —
// it cannot silently re-enter retrieval as authoritative. A rebuild client that
// merely MERGES (does not replace) could leave that stale fact behind, so a
// non-replacing rebuild is rejected fail-closed.
//
// Fail-closed (§12/§16): a stale snapshot (when an expected revision is supplied), a
// derive failure, a rebuild-client fault, a non-replacing rebuild, or an incomplete
// recovery (rebuilt node count != derivable node count) each yield a typed error +
// a distinct `rebuild_divergence` System-Health item. The function does REAL I/O
// through the injected rebuild client, so it returns a typed `Result` and NEVER
// throws across the boundary — it also defends against the client itself throwing.
import { HealthItemSchema, ok, err } from "@sow/contracts";
import type { HealthItem, Result, WorkspaceId } from "@sow/contracts";
import { computeRevisionId } from "../knowledge-writer/revision";
import { deriveCanonicalFacts } from "./derive/canonical-fact-deriver";
import type {
  CanonicalVaultSnapshot,
  DerivedFact,
} from "./derive/canonical-fact-deriver";

// ── injected: full-replace re-index client (sole-issuer worker path) ──────────

/** The full derived fact set to REBUILD (wholesale replace) for one revision. */
export interface IndexRebuildRequest {
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly facts: readonly DerivedFact[];
}

/** Proof of a rebuild. `replaced=true` asserts a WHOLESALE replace of the derived
 *  store (no prior DB-only fact survives); a `false` here is rejected fail-closed. */
export interface IndexRebuildReceipt {
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly nodeCount: number;
  readonly replaced: boolean;
}

/** Enumerable failures of the rebuild apply. */
export type IndexRebuildError =
  | { readonly code: "gbrain_unavailable"; readonly message: string; readonly cause?: unknown }
  | { readonly code: "rebuild_failed"; readonly message: string; readonly cause?: unknown };

/**
 * Write-side seam to the single-owner gbrain's DERIVED index (§13), performing a
 * WHOLESALE re-index from committed Markdown — the sanctioned derivation path, never
 * a hidden-brain Markdown write. Distinct from the 4.8 incremental `IndexApplyClient`:
 * a rebuild replaces the store rather than merging into it. Never throws — the caller
 * also defends against it throwing.
 */
export interface IndexRebuildClient {
  rebuildFromMarkdown(
    request: IndexRebuildRequest,
  ): Promise<Result<IndexRebuildReceipt, IndexRebuildError>>;
}

// ── deps / outcome ────────────────────────────────────────────────────────────

export interface RebuildDeps {
  readonly rebuildClient: IndexRebuildClient;
  /** Injected clock (ISO-8601) — keeps health-item timestamps deterministic. */
  readonly now: () => string;
  /** Injected System-Health id minter (no ambient random). */
  readonly newHealthItemId: () => string;
  /** AuditRecord id the rebuild_divergence health items link back to (§6 / §16). */
  readonly auditRef: string;
  /** Optional guard: the snapshot must hash to this committed revision id (LIFE-6).
   *  When supplied and mismatched, the rebuild fails closed BEFORE any client call. */
  readonly expectedRevisionId?: string;
}

export interface RebuildSuccess {
  readonly workspaceId: WorkspaceId;
  readonly revisionId: string;
  /** Count of semantic nodes recovered from committed Markdown (== derived facts). */
  readonly recoveredNodeCount: number;
  /** The gbrain-independent derived fact set the rebuild reconstructed. */
  readonly facts: readonly DerivedFact[];
  readonly receipt: IndexRebuildReceipt;
}

export type RebuildFailure =
  | { readonly code: "stale_revision"; readonly expected: string; readonly actual: string; readonly healthItem: HealthItem }
  | { readonly code: "derive_failed"; readonly detail: string; readonly healthItem: HealthItem }
  | { readonly code: "rebuild_client_failed"; readonly message: string; readonly cause?: unknown; readonly healthItem: HealthItem }
  | { readonly code: "non_replacing_rebuild"; readonly healthItem: HealthItem }
  | { readonly code: "incomplete_recovery"; readonly expected: number; readonly recovered: number; readonly healthItem: HealthItem };

/**
 * Rebuild the GBrain index from committed Markdown alone. See the module header for
 * the disposable-brain / wholesale-replace / fail-closed contract. Returns a typed
 * `Result` and NEVER throws across the boundary (§16).
 */
export async function rebuildIndexFromMarkdown(
  snapshot: CanonicalVaultSnapshot,
  deps: RebuildDeps,
): Promise<Result<RebuildSuccess, RebuildFailure>> {
  // 1 — no stale-revision rebuild (LIFE-6): if the caller pins an expected revision,
  //     the snapshot must hash to it before we touch the derived store.
  const actualRevision = computeRevisionId(snapshot.files) as string;
  if (
    deps.expectedRevisionId !== undefined &&
    actualRevision !== deps.expectedRevisionId
  ) {
    return err({
      code: "stale_revision",
      expected: deps.expectedRevisionId,
      actual: actualRevision,
      healthItem: buildRebuildDivergenceHealthItem(
        deps,
        `rebuild snapshot hashes to ${actualRevision}, expected revision ${deps.expectedRevisionId}`,
      ),
    });
  }

  // 2 — re-derive the semantic node set from committed Markdown (gbrain-independent).
  const derived = deriveCanonicalFacts(snapshot);
  if (!derived.ok) {
    return err({
      code: "derive_failed",
      detail: derived.error.code,
      healthItem: buildRebuildDivergenceHealthItem(
        deps,
        `canonical derive failed during rebuild: ${derived.error.code}`,
      ),
    });
  }
  const facts = derived.value.facts;

  // 3 — apply the WHOLESALE rebuild (defend against the client throwing).
  const applied = await runRebuild(deps.rebuildClient, {
    workspaceId: snapshot.workspaceId as string,
    revisionId: actualRevision,
    facts,
  });
  if (!applied.ok) {
    return err({
      code: "rebuild_client_failed",
      message: applied.error.message,
      cause: applied.error.cause,
      healthItem: buildRebuildDivergenceHealthItem(
        deps,
        `rebuild client failed: ${applied.error.message}`,
      ),
    });
  }
  const receipt = applied.value;

  // 4 — a non-replacing rebuild could leave a quarantined DB-only fact behind → reject.
  //     STRICT `=== true` (not truthy `!receipt.replaced`): `replaced` arrives from the
  //     INJECTED client across a real I/O boundary where TS types are NOT runtime-enforced,
  //     so a truthy-non-`true` value (1, "false", {}, []) must read as NOT a wholesale
  //     replace — never a false-green into the serve-time trust gate (safety rule 1;
  //     mirrors the propose guard 392e7db / worker Lesson 28).
  if (receipt.replaced !== true) {
    return err({
      code: "non_replacing_rebuild",
      healthItem: buildRebuildDivergenceHealthItem(
        deps,
        `rebuild client did not confirm a wholesale replace (replaced flag not strictly true); ` +
          `a merge could leave a quarantined DB-only fact in retrieval.`,
      ),
    });
  }

  // 5 — recovery completeness (REQ-D-001): the rebuilt node count must equal the
  //     derivable node count — the brain recovered every Markdown-recoverable node.
  if (receipt.nodeCount !== facts.length) {
    return err({
      code: "incomplete_recovery",
      expected: facts.length,
      recovered: receipt.nodeCount,
      healthItem: buildRebuildDivergenceHealthItem(
        deps,
        `rebuild recovered ${receipt.nodeCount} nodes but ${facts.length} are derivable ` +
          `from committed Markdown (REQ-D-001 recovery incomplete).`,
      ),
    });
  }

  return ok({
    workspaceId: snapshot.workspaceId,
    revisionId: actualRevision,
    recoveredNodeCount: facts.length,
    facts,
    receipt,
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Await the injected rebuild client, converting a THROWN error into a typed err. */
async function runRebuild(
  client: IndexRebuildClient,
  request: IndexRebuildRequest,
): Promise<Result<IndexRebuildReceipt, IndexRebuildError>> {
  try {
    return await client.rebuildFromMarkdown(request);
  } catch (cause) {
    return err({
      code: "rebuild_failed",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
}

/**
 * Build the distinct `rebuild_divergence` System-Health item (§16), validated
 * through the frozen `HealthItemSchema`. On the (unreachable) parse-fail path we
 * still return a type-correct item — the rebuild must never throw and must always
 * surface the divergence rather than fail silently.
 */
function buildRebuildDivergenceHealthItem(deps: RebuildDeps, reason: string): HealthItem {
  const candidate = {
    id: deps.newHealthItemId(),
    failureClass: "rebuild_divergence" as const,
    // severity is an OPEN string upstream (no closed enum) — see HealthItem model.
    severity: "error",
    message: `GBrain rebuild-from-Markdown diverged: ${reason}`,
    auditRef: deps.auditRef,
    openedAt: deps.now(),
    state: "open" as const,
  };
  const parsed = HealthItemSchema.safeParse(candidate);
  return parsed.success ? parsed.data : (candidate as unknown as HealthItem);
}
