// Task 13.10 (rebuild-oracle arc, piece A) — the pure worker-side rebuild-oracle STATUS producer. spec(§6) spec(§12) spec(§16)
//
// probeRebuildOracle computes the `oracleBuildOk` serving-coverage signal (the last hardwired-false leg of
// `deriveServingCoverage`) by REBUILDING the GBrain index from committed Markdown alone and corroborating the
// result. It composes two INJECTED collaborators:
//   • a LOCAL CommittedVaultReader (the same seam the serving loader uses) → a `CanonicalVaultSnapshot` @ head;
//   • an owner-gated IndexRebuildClient (the real gbrain scratch-import — the WRITE-side derived-index seam) →
//     driven through the already-built `rebuildIndexFromMarkdown`, which re-derives the fact set via the
//     gbrain-INDEPENDENT deriver and applies a WHOLESALE replace.
// The ONLY path that yields `oracleBuildOk: true` is a wholesale-replace rebuild that recovers EVERY
// Markdown-derivable node (`corroborated`). Every other path fails closed — never a false green:
//   • absent / empty / unmapped vault, OR a WS-8 read-back mismatch ⇒ `absent` (the client is NOT called — no
//     wasted rebuild I/O; the WS-8 re-gate degrades to absent per Lesson 20, not foreclosing a future health signal);
//   • any `rebuildIndexFromMarkdown` err (stale / derive-failed / client-fault / non-replacing / incomplete) ⇒
//     `diverged`, carrying the failure's OWN `rebuild_divergence` HealthItem (surfaced, never synthesized here);
//   • a THROWING/rejecting reader seam ⇒ `faulted` (defense-in-depth over the reader's never-throw contract,
//     Lesson 20 — don't rely on a never-throw contract across an injected boundary).
//
// NO expectedRevisionId PIN (orch20 TWEAK, brief decision #2): the producer hands the FROZEN in-memory
// `snapshot.files` Map straight to `rebuildIndexFromMarkdown`, which derives from THAT Map (no vault re-read) and
// hands the derived FACTS (not a vault path) to the client — so there is no re-read window inside the
// producer→rebuild→client chain for a pin to guard, and it buys nothing here. Worse, pinning to
// `snapshot.revisionId` (a FULL-vault hash: `createCommittedVaultReader` sets it from `readVaultHeadRevision =
// computeRevisionId(readSnapshot(vault))`) would be a guaranteed SPURIOUS `stale_revision` against the rebuild's
// internal `computeRevisionId(snapshot.files)` (the `.md`-SUBSET hash) whenever a non-`.md` file exists — a
// permanent false-red + a latent arming blocker, for zero real TOCTOU protection. Fail-closed is unaffected
// (every genuine fault still degrades). The real revision-consistency dependency for ARMING is the committed-vault
// reader's own go-live TODO (`servingContextBootReaders.ts` L63-66: take ONE atomic snapshot and derive the
// revision from it), not a pin in this producer.
//
// DORMANT + reachability-waivered: no production caller (piece C binds it at boot behind `copilotServingOracleGoLive`,
// caching the boolean into `resolveOracleBuild`), no real gbrain I/O (the owner-gated IndexRebuildClient stays
// UNBOUND — byte-equivalent shipped default). Never throws (§16): a fault degrades, never crosses the boundary.
import type { HealthItem } from "@sow/contracts";
import {
  rebuildIndexFromMarkdown,
  type CanonicalVaultSnapshot,
  type IndexRebuildClient,
  type RebuildOracleSet,
} from "@sow/knowledge";
import type { CommittedVaultReader } from "../api/procedures/servingContextLoader";

/** The injected collaborators for one rebuild-oracle probe — all fakeable; bound to the real seams at piece C. */
export interface RebuildOracleProbeDeps {
  /** LOCAL committed-vault reader (reuse the serving loader's seam — don't re-read fs). Never-throw by contract,
   *  but the producer defends against a throwing seam anyway (Lesson 20). */
  readonly readCommittedVault: CommittedVaultReader;
  /** The owner-gated real gbrain scratch-import (the WRITE-side derived-index seam). UNBOUND in production. */
  readonly rebuildClient: IndexRebuildClient;
  /** Injected clock (ISO-8601) — keeps the rebuild's health-item timestamps deterministic. */
  readonly now: () => string;
  /** Injected System-Health id minter (no ambient random) — passed through to the rebuild. */
  readonly newHealthItemId: () => string;
  /** AuditRecord id the rebuild_divergence health items link back to (§6 / §16). */
  readonly auditRef: string;
}

/**
 * The typed rebuild-oracle status. `oracleBuildOk` is the load-bearing boolean the serving-coverage leg consumes
 * (`resolveOracleBuild`); the `outcome` discriminant + payload are diagnostics for the health surface (piece C+).
 * ABSENCE (benign — nothing to corroborate) / DIVERGENCE-defect (health-worthy) / FAULT (a misbehaving seam) are
 * distinguished so a later caller can route them differently, but the coverage leg reads only the boolean.
 */
export type RebuildOracleStatus =
  | { readonly oracleBuildOk: true; readonly outcome: "corroborated"; readonly oracleSet: RebuildOracleSet }
  | { readonly oracleBuildOk: false; readonly outcome: "absent" }
  | { readonly oracleBuildOk: false; readonly outcome: "diverged"; readonly healthItem: HealthItem }
  | { readonly oracleBuildOk: false; readonly outcome: "faulted" };

/**
 * Probe the rebuild-oracle build status for one workspace: read the LOCAL committed-vault snapshot @ head →
 * rebuild the index from committed Markdown alone → corroborate. Returns a typed {@link RebuildOracleStatus} and
 * NEVER throws (§16). See the module header for the full fail-closed contract + the no-pin rationale.
 */
export async function probeRebuildOracle(
  workspaceId: string,
  deps: RebuildOracleProbeDeps,
): Promise<RebuildOracleStatus> {
  // 1 — read the LOCAL committed-vault snapshot @ head. Wrap the injected reader's CALL (not just its await) so a
  //     SYNC throw and an ASYNC reject BOTH degrade — don't rely on its never-throw contract across the seam (Lesson 20).
  let snapshot: CanonicalVaultSnapshot | undefined;
  try {
    snapshot = await deps.readCommittedVault(workspaceId);
  } catch {
    return { oracleBuildOk: false, outcome: "faulted" };
  }

  // 2 — a benign ABSENCE (never-indexed / empty / unmapped vault ⇒ undefined) ⇒ degrade; short-circuit BEFORE the
  //     rebuild seam (no wasted scratch-import I/O when there is nothing to corroborate).
  if (snapshot === undefined) {
    return { oracleBuildOk: false, outcome: "absent" };
  }

  // 3 — WS-8 read-back re-gate (Lesson 20 / safety rule 4): the returned snapshot MUST belong to the requested
  //     workspace. A contract-abiding reader always matches (fires only on a reader defect); degrade to `absent`
  //     fail-closed without calling the client — never rebuild a foreign-workspace snapshot into this probe.
  //     `String(...)` (not an `as` cast) mirrors the sibling loader's WS-8 idiom (servingContextLoader.ts) so a
  //     DEFECTIVE non-string workspaceId is runtime-coerced before compare — strictly-safer fail-closed.
  if (String(snapshot.workspaceId) !== workspaceId) {
    return { oracleBuildOk: false, outcome: "absent" };
  }

  // 4 — rebuild the index from committed Markdown ALONE (no revision pin — see header). `rebuildIndexFromMarkdown`
  //     is contractually never-throw (it defends against the client throwing), so we RELY on it (Lesson 21 — catch
  //     only the collaborator with a designed rejection channel; the reader in step 1 is that boundary).
  const rebuilt = await rebuildIndexFromMarkdown(snapshot, {
    rebuildClient: deps.rebuildClient,
    now: deps.now,
    newHealthItemId: deps.newHealthItemId,
    auditRef: deps.auditRef,
  });

  // 5 — any rebuild err is a DIVERGENCE-defect: surface the failure's OWN rebuild_divergence health item (§16 —
  //     do NOT synthesize a new one). This covers stale / derive-failed / client-fault / non-replacing / incomplete.
  if (!rebuilt.ok) {
    return { oracleBuildOk: false, outcome: "diverged", healthItem: rebuilt.error.healthItem };
  }

  // 6 — corroborated: a wholesale replace that recovered every Markdown-derivable node. The ONLY path to `true`.
  //     `factIdentities` is the gbrain-independent derived set's identity list (decision #3), in deriver order.
  //     EMPTY-DERIVED intent (code-quality flag): a mapped vault that derives to 0 facts is corroborated `true`
  //     with an empty `oracleSet` — the rebuild DID recover everything derivable (0 of 0). This is deliberate
  //     separation of concerns: `oracleBuildOk` asserts rebuild/disposability corroboration, NOT "there is
  //     content to serve" — the "empty allow-set ⇒ degrade" decision belongs to the loader's allow-set coverage
  //     leg (servingContextLoader.ts), which AND-composes with this signal, so an empty-derived vault still
  //     degrades serving overall (no false green). Overloading this boolean with a content-presence check would
  //     conflate two legs. Revisit at arming (a distinct empty-derived signal is not foreclosed).
  return {
    oracleBuildOk: true,
    outcome: "corroborated",
    oracleSet: {
      factIdentities: rebuilt.value.facts.map((f) => f.fact.factIdentity),
      complete: true,
    },
  };
}
