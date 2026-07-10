// Gate 4 (G1e-2) — the worker-side production ServingContextLoader.
//
// The oracle-core (`createServingGateOracle`, copilotProvenanceStamp.ts) turns a retrieval's context into a
// serving verdict by consulting the knowledge-layer gate over a per-workspace `WorkspaceServingContext`. That
// context — the trusted allow-set, the Markdown rehydrator, the quarantine ledger, the fail-closed coverage
// legs, the signing-key deps, and an injective citation resolver — has to be ASSEMBLED from the committed
// vault at the workspace's head revision. This module is that assembly step: `createServingContextLoader`
// produces a `ServingContextLoader` (the seam `ServingGateOracleDeps.loadContext` expects).
//
// FAIL-CLOSED / DORMANT (safety rules 4/6, ING-7):
//   • `degraded` (a NORMAL state, never a fault) whenever the workspace cannot be GATE-served — never indexed,
//     empty vault, no allow-set, an unresolvable signing key, a malformed vault, or ANY non-green coverage leg.
//     A typed `err` is reserved for an unexpected THROW (the load-fault escape hatch); §16 = never throw.
//   • serving coverage is DERIVED from the real latest ParityReport + the pin-match / rebuild-oracle legs
//     (injected via {@link ServingCoverageReader}) — it is NEVER hardcoded all-green. With corpora absent
//     today every leg fails closed ⇒ the loader degrades on everything (sound + inert), and boot keeps the
//     interim always-degraded oracle the selected default. Wiring a real loader-backed oracle is a
//     security-review-gated go-live event, never a flag flip (see copilotProvenanceStamp.ts GO-LIVE PRECONDITIONS).
//   • the citation resolver returns the PAGE fact identity ONLY (the sole stamped + rehydratable unit) and
//     WITHHOLDS (null) on an unknown / malformed / non-unique slug — it never guesses.
import { ok, err, isOk, failure } from "@sow/contracts";
import type { Result, FailureVariant, RevisionId, ParityReport, QuarantineRecord } from "@sow/contracts";
import {
  deriveCanonicalFacts,
  createVaultRehydrate,
  createQuarantineLedger,
  isDegradedCoverage,
} from "@sow/knowledge";
import type {
  CanonicalVaultSnapshot,
  CanonicalFactSet,
  ServingCoverage,
  SecretsPort,
  SecretRef,
} from "@sow/knowledge";
import { createInterimDegradedServingOracle } from "./copilotProvenanceStamp";
import type {
  CopilotServingOracle,
  ServingContextLoader,
  ServingContextResolution,
  WorkspaceServingContext,
} from "./copilotProvenanceStamp";

/**
 * Reads a workspace's committed vault snapshot at its head revision — the deriver's input (path→committed
 * Markdown + the head `revisionId`). Returns `undefined` for a never-indexed workspace or when the reader is
 * left unbound (⇒ the loader degrades), preserving dormancy.
 */
export type CommittedVaultReader = (workspaceId: string) => CanonicalVaultSnapshot | undefined;

/**
 * The RAW serving-coverage inputs for one workspace @ revision — the loader DERIVES the 4-leg
 * {@link ServingCoverage} from these (it never receives a pre-baked coverage, so no caller can hardcode
 * all-green). `parity` is the latest revision-scoped ParityReport (`undefined` ⇒ never reconciled ⇒ degrade);
 * `pinValid` is the installed-GbrainPin-matches-running-build result and `oracleBuildOk` the rebuild-oracle
 * build status — both resolved where the running version / oracle live (boot); unbound ⇒ `false` ⇒ degrade.
 */
export interface ServingCoverageSources {
  readonly parity: ParityReport | undefined;
  readonly pinValid: boolean;
  readonly oracleBuildOk: boolean;
}

/** Reads the raw serving-coverage inputs for a workspace at a revision. */
export type ServingCoverageReader = (
  workspaceId: string,
  revisionId: RevisionId,
) => ServingCoverageSources;

/** Everything the loader needs to assemble a workspace's serving context. */
export interface ServingContextLoaderDeps {
  readonly readCommittedVault: CommittedVaultReader;
  readonly readServingCoverage: ServingCoverageReader;
  readonly secrets: SecretsPort;
  readonly signingKeyRef: SecretRef;
  /** Seed for the QuarantineLedger — injected operational truth; DEFAULT EMPTY when unseeded (Q4). */
  readonly quarantineSeed?: readonly QuarantineRecord[];
}

/**
 * Derive the 4-leg {@link ServingCoverage} from the raw inputs, FAIL-CLOSED on every leg — a missing parity
 * report yields `false` for both parity legs; `pinValid` / `oracleBuildOk` default to their provided (false-on-
 * unbound) values. NEVER returns a hardcoded all-green: `cleanForServing`/`coverageComplete` are read off the
 * REAL report. `isDegradedCoverage` (ANDs the 4 legs) then decides whether to degrade.
 */
export function deriveServingCoverage(sources: ServingCoverageSources): ServingCoverage {
  const parity = sources.parity;
  return {
    cleanForServing: parity?.cleanForServing === true,
    coverageComplete: parity?.coverageComplete === true,
    pinValid: sources.pinValid === true,
    oracleBuildOk: sources.oracleBuildOk === true,
  };
}

const PAGE_PREFIX = "page:";
const CITATION_PREFIX = "gbrain:";

/**
 * Build the injective `citationId → [page factIdentity]` resolver over a workspace's allow-set. A citation
 * `gbrain:<slug>` resolves to the page fact `page:<slug>` IFF exactly ONE served page fact carries that slug;
 * it WITHHOLDS (returns null) on a malformed citationId (no `gbrain:` prefix / empty slug), an unknown slug,
 * or a slug held by >1 page fact (defense-in-depth — the deriver already rejects cross-page identity
 * collisions, but the resolver must never guess). Only `page`-kind facts are considered — a link/tag/timeline
 * fact would fail the gate's all-or-nothing leg, so it must never be reachable via a citation.
 */
export function buildCitationResolver(
  allowSet: CanonicalFactSet,
): (citationId: string) => readonly string[] | null {
  const bySlug = new Map<string, string[]>();
  for (const df of allowSet.facts) {
    if (df.fact.factKind !== "page") continue;
    const id = String(df.fact.factIdentity);
    if (!id.startsWith(PAGE_PREFIX)) continue;
    const slug = id.slice(PAGE_PREFIX.length);
    const list = bySlug.get(slug);
    if (list === undefined) bySlug.set(slug, [id]);
    else list.push(id);
  }
  return (citationId: string): readonly string[] | null => {
    if (!citationId.startsWith(CITATION_PREFIX)) return null;
    const slug = citationId.slice(CITATION_PREFIX.length);
    if (slug.length === 0) return null;
    const ids = bySlug.get(slug);
    if (ids === undefined || ids.length !== 1) return null; // unknown or non-unique → withhold
    return ids.slice();
  };
}

const degradedResolution = (): Result<ServingContextResolution, FailureVariant> => ok({ mode: "degraded" });

/**
 * Build the per-workspace serving-context loader. Given a workspaceId it assembles a READY
 * {@link WorkspaceServingContext} at the head committed revision, or resolves `degraded` when the workspace
 * cannot be gate-served (all fail-closed, a NORMAL state). Never throws (§16): any unexpected fault folds to a
 * typed `err` (⇒ the oracle strips ⇒ untrusted).
 */
export function createServingContextLoader(deps: ServingContextLoaderDeps): ServingContextLoader {
  return async (workspaceId: string): Promise<Result<ServingContextResolution, FailureVariant>> => {
    try {
      // 1) committed vault snapshot @ head — never indexed / reader unbound ⇒ degraded.
      const snapshot = deps.readCommittedVault(workspaceId);
      if (snapshot === undefined) return degradedResolution();

      // 1a) defense-in-depth (safety rule 4 — workspace isolation): the snapshot MUST describe the REQUESTED
      //     workspace. A mis-bound reader fails closed to `degraded` HERE, localizing the fault instead of
      //     relying solely on the downstream gate's `workspace_mismatch` backstop.
      if (String(snapshot.workspaceId) !== workspaceId) return degradedResolution();

      // 2) trusted allow-set from committed Markdown. A derive DEFECT (malformed vault) ⇒ cannot gate-serve ⇒
      //    degraded (fail-closed) — err is reserved for an unexpected throw, not a known data defect.
      const derived = deriveCanonicalFacts(snapshot);
      if (!isOk(derived)) return degradedResolution();
      const allowSet = derived.value;

      // 3) no allow-set (empty / never-indexed vault) ⇒ degraded (nothing to gate-serve).
      if (allowSet.facts.length === 0) return degradedResolution();

      // 4) the signing key must be resolvable — else no sig can be verified at serve time ⇒ fail-closed degraded.
      const key = await deps.secrets.resolveSigningKey(deps.signingKeyRef);
      if (!isOk(key)) return degradedResolution();

      // 5) serving coverage DERIVED from the real latest ParityReport + pin/oracle legs — any non-green ⇒ degraded.
      //    A ParityReport not scoped to the HEAD revision is STALE — it cannot vouch for the current committed
      //    set, so it is treated as ABSENT (the coverage kill-switch degrades rather than serving under a
      //    stale-but-green report — closes the global-kill-switch staleness gap).
      const covSources = deps.readServingCoverage(workspaceId, snapshot.revisionId);
      const revisionScopedParity =
        covSources.parity !== undefined &&
        String(covSources.parity.reconciledAtRevision) === String(snapshot.revisionId)
          ? covSources.parity
          : undefined;
      const coverage = deriveServingCoverage({ ...covSources, parity: revisionScopedParity });
      if (isDegradedCoverage(coverage)) return degradedResolution();

      // 6) assemble the ready context. The rehydrator reads the SAME committed snapshot; the ledger is the
      //    injected seed (default empty); the resolver is injective over the allow-set.
      const context: WorkspaceServingContext = {
        revisionId: snapshot.revisionId,
        allowSet,
        rehydrate: createVaultRehydrate((p) => snapshot.files.get(p), allowSet),
        quarantine: createQuarantineLedger(deps.quarantineSeed ?? []),
        coverage,
        servingDeps: { secrets: deps.secrets, signingKeyRef: deps.signingKeyRef },
        resolveCitation: buildCitationResolver(allowSet),
      };
      return ok({ mode: "ready", context });
    } catch {
      // §16 — a throwing seam never crosses the boundary; a typed err (⇒ the oracle strips ⇒ untrusted).
      return err(
        failure("degraded_unavailable", "serving context load faulted", {
          cause: { code: "SERVING_CONTEXT_LOAD_FAULT" },
        }),
      );
    }
  };
}

// ── boot seam: DORMANT selection of the serving-oracle factory (gate 4 G1e-2) ────

/** Inputs to {@link selectServingOracleFactory} — boot's provenance-stamping flag + the (dormant) real path. */
export interface ServingOracleSelection {
  /** boot's `config.copilotProvenanceStamping === true` — the decorator sits on the live retrieval path. */
  readonly provenanceStampingEnabled: boolean;
  /**
   * The real loader-backed oracle factory (`() => createServingGateOracle({ admitForServing, loadContext })`),
   * constructed by boot when the seams are bound. Selected ONLY when go-live is armed.
   */
  readonly loaderBacked?: () => CopilotServingOracle;
  /**
   * The internal go-live precondition — a real loader-backed oracle over KnowledgeWriter-authored corpora,
   * a security-review-gated event. NEVER set today (no config flips it), so the interim always-degraded
   * oracle stays the selected default ⇒ nothing is stamped ⇒ propose stays structurally OFF.
   */
  readonly goLiveArmed?: boolean;
}

/**
 * Select boot's serving-oracle factory. DORMANT by design: unless go-live is EXPLICITLY armed AND a real
 * loader-backed factory is supplied, the interim always-degraded oracle is the selected default (⇒ nothing
 * stamped ⇒ untrusted ⇒ propose OFF — the C5.4a honest-interim pattern: a real mechanism kept OFF by its
 * input, never a flag-only override). Returns `undefined` when provenance-stamping is off (no decorator).
 * Wiring a non-interim oracle is a security-review-gated go-live event, never a flag flip.
 */
export function selectServingOracleFactory(
  sel: ServingOracleSelection,
): (() => CopilotServingOracle) | undefined {
  if (!sel.provenanceStampingEnabled) return undefined;
  if (sel.goLiveArmed === true && sel.loaderBacked !== undefined) return sel.loaderBacked;
  return createInterimDegradedServingOracle;
}
