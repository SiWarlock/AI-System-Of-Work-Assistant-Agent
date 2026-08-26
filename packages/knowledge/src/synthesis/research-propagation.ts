// Research propagation (§6 KN-10; 13.14 phase 5) — the "PROPAGATE" step of the vault-first
// governed /research-deep flow. `packages/workflows`'s `runResearchDeep` driver (phases 1-4: scan
// → analyze gaps → fill gaps → synthesize a delta) reaches this module through ONE injected port
// (`PropagateResearchPort`, declared in `packages/workflows/src/ports/researchDeep.ts` — out of
// this package's territory, never imported here: workflows depends on knowledge, not the reverse,
// per this package's own layer-dependency rule). This file is the ENGINE the workflows-side port
// binds to at the worker composition root (cross-territory — see the module-level doc below).
//
// Per recommended update, this composes the SAME two primitives every other synthesis entry point
// in this package composes (never re-implemented):
//   1. `resolveEntity` (13.8a EntityResolver) — grounds `entityName` to an EXISTING vault note path,
//      a create-stub proposal, or WITHHELD. A `withheld` resolution fabricates nothing (L32).
//   2. `planSynthesis` (13.8c planner) — turns ONE deterministically-derived region write (this
//      module's OWN candidate, not model output — see below) into a validated, schema-gated
//      `KnowledgeMutationPlan` via the SAME confinement/no-inference/candidate-data-gate machinery
//      `ingest-rewrite.ts`/`meeting-rewrite.ts` already inherit.
//
// SAFETY:
//  · Rule 1 (one writer): this module NEVER writes Markdown — it emits `KnowledgeMutationPlan`
//    candidate DATA only (`planSynthesis` re-validates through `KnowledgeMutationPlanSchema`; an
//    invalid plan is dropped, never emitted). The driver (workflows territory) routes AUTO plans to
//    the EXISTING `CommitKnowledgePort` and PROPOSE plans to the EXISTING approval port — never a
//    second writer.
//  · Rule 2 (candidate-data gate) / L32 ground-before-write: `entityName` is MODEL-supplied (phase 4
//    synthesis output) — it is NEVER treated as a path. The only notePath a plan ever targets is one
//    `resolveEntity`/`stubNotePathFor` derived (an EXISTING grounded path, or a namespaced stub path)
//    — never the raw model string. Unlike `ingest-rewrite.ts` (whose model REASON port supplies
//    `regions[].notePath` directly, requiring the separate `admitPlanMutations` admission gate,
//    13.8l), THIS module's own internal reason port supplies ONLY a path it just derived itself, so
//    that admission gate does not apply here — there is no model-supplied path to admit.
//  · REQ-F-006: a plan needs ≥1 sourceRef. A recommended update with no admissible citation URL is
//    withheld (`no_source_refs`) rather than reaching `planSynthesis`'s own `unusable_input` — a
//    caller-legible reason beats a generic port-level shape.
//  · TOTAL never-throws (§16): every per-update fault — malformed update, unresolvable entity, an
//    empty citation set, a plan the schema gate rejects — folds to a `withheld` OUTCOME, never a
//    thrown exception and never a dropped array slot. `resolveEntity`/`planSynthesis` are themselves
//    TOTAL; the try/catch here exists for THIS module's own array/field access over the untrusted
//    `RecommendedVaultUpdate` shape.
//
// ⚠ arch_gap (recorded for `crossTerritoryNeeds`, not invented here): `RecommendedVaultUpdate`
// (phase 4's own output, `packages/workflows/src/ports/researchDeep.ts`) carries no entity KIND
// (person | project | concept) — only a free-text `entityName`. `resolveEntity` requires one.
// `entityKind` below is OPTIONAL for exactly that reason; when absent, `DEFAULT_ENTITY_KIND`
// ("concept" — the closest fit for a research-topic entity) applies. A future producer that can
// supply a real kind should; until then this is a deliberate, documented default, never a silent
// guess presented as certainty.
//
// PURE over the injected ports; DORMANT — the workflows-side bind (constructing a
// `PropagateResearchPort` adapter over `propagateResearchUpdates` at the worker composition root,
// tiering by `plan.requiresApproval`) is `packages/workflows`/`apps/worker` territory (§ARM-RESEARCH
// itself gates only the upstream RES-1 provider, phases 2-4 — this module has no provider dependency
// and is not itself arming-gated, but stays unbound until the worker wires the port).
import { ok, err, isOk } from "@sow/contracts";
import type { Result, WorkspaceId, ProvenanceOrigin, KnowledgeMutationPlan } from "@sow/contracts";
import {
  resolveEntity,
  stubNotePathFor,
  type EntityRef,
  type EntityKind,
  type EntityGbrainReadPort,
} from "./entity-resolver";
import {
  planSynthesis,
  type RegionEffect,
  type SynthesisReasonPort,
  type SynthesisSectionPort,
  type SynthesisCandidate,
} from "./planner";

/** One citation backing a recommended update — the SAME shape `packages/workflows`'s own
 *  `ResearchCitation` uses (structurally, not by import — see the module-level layering note). */
export interface ResearchCitationRef {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
}

/**
 * One "Recommended Vault Update" — phase 4's synthesis output, this phase's input.
 * `entityName` is SYNTHESIS-NAMED free text (NEVER treated as a path — L32). `entityKind` is
 * OPTIONAL (see the module-level arch_gap note); absent, {@link DEFAULT_ENTITY_KIND} applies.
 */
export interface RecommendedVaultUpdate {
  readonly entityName: string;
  readonly change: string;
  readonly citations: readonly ResearchCitationRef[];
  readonly entityKind?: EntityKind;
}

/** The default entity kind applied when a `RecommendedVaultUpdate` carries none (documented arch_gap above). */
export const DEFAULT_ENTITY_KIND: EntityKind = "concept";

/** The writer-owned `@generated` region every propagated research update lands in, refreshed (or
 *  freshly appended) in place — so repeated research runs against the SAME entity accumulate onto
 *  ONE region rather than minting an ever-growing set. */
export const RESEARCH_REGION_ID = "research";

/**
 * The per-update outcome: `grounded` carries exactly one validated `KnowledgeMutationPlan` (the
 * caller tiers AUTO-vs-PROPOSE by `plan.requiresApproval` — this module never self-declares a tier
 * beyond what `planSynthesis`'s own deterministic region-effect classification already assigns, and
 * a region write is always AUTO); `withheld` carries a caller-legible free-text reason (NOT the
 * closed `WithheldReason` union — a plan can be withheld for reasons {@link resolveEntity} never
 * produces, e.g. `no_source_refs`).
 */
export type PropagatedUpdateOutcome =
  | { readonly kind: "grounded"; readonly entityName: string; readonly plan: KnowledgeMutationPlan }
  | { readonly kind: "withheld"; readonly entityName: string; readonly reason: string };

export type PropagateResearchFailureCode = "propagation_failed";
export interface PropagateResearchFailure {
  readonly code: PropagateResearchFailureCode;
  readonly message: string;
}

export interface ResearchPropagationDeps {
  readonly gbrain: EntityGbrainReadPort;
  readonly sections: SynthesisSectionPort;
  readonly newPlanId: () => string;
}

export interface ResearchPropagationInput {
  readonly workspaceId: WorkspaceId;
  /** Taken as INPUT (origin-agnostic — mirrors `SynthesisInput`/`IngestRewriteInput`), never guessed
   *  here: `ProvenanceOrigin` has no dedicated "research" member today (arch_gap, contracts territory);
   *  the caller supplies whichever existing enum member fits its own KN-10 wiring. */
  readonly provenanceOrigin: ProvenanceOrigin;
  readonly recommendedUpdates: readonly RecommendedVaultUpdate[];
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Read a note's writer-owned region allowlist defensively — fail closed (no region) on any fault.
 *  Mirrors `planner.ts`'s own `safeDescribe` (not imported — that one is module-private there). */
function safeHasRegion(sections: SynthesisSectionPort, notePath: string, regionId: string): boolean {
  try {
    const d = sections.describe(notePath);
    return Array.isArray(d?.generatedRegionIds) && d.generatedRegionIds.includes(regionId);
  } catch {
    return false;
  }
}

/**
 * Propagate ONE `RecommendedVaultUpdate`: ground its entity (13.8a), derive the ONE region-write
 * candidate this module owns (never model-supplied — see the module-level safety note), and plan it
 * (13.8c).
 *
 * ⚠ KNOWN LIMITATION (documented, not silently papered over): each update is grounded + planned
 * INDEPENDENTLY against the read state at call time. Two updates in the SAME batch that resolve to
 * the SAME target (e.g. two distinct citations both recommending a brand-new "Novel Widget" stub)
 * each independently see "no note exists yet" and each produce their own `new_note`/`new_region`
 * plan for the identical target — this module has no visibility into a sibling update's plan, and
 * (rule 1) it never writes, so it cannot observe the vault state a sibling's plan WOULD produce once
 * committed. A resulting write collision is left to KnowledgeWriter's own commit-time guard
 * (mirroring the external-write envelope's pre-write existence check, rule 3) — the caller's
 * degrade-not-fail per-plan commit handling (researchDeep.ts inv-4) surfaces it without failing the
 * run. Silently forcing a same-batch "refresh" here was tried and rejected: it produces a WRONG
 * effect against the pre-run `describe()` snapshot (the region genuinely does not exist there yet),
 * which `planSynthesis`'s own confinement allowlist then drops — turning a plannable update into a
 * spurious `withheld`, a worse outcome than deferring the reconciliation to commit time.
 */
async function propagateOne(
  update: RecommendedVaultUpdate,
  input: ResearchPropagationInput,
  deps: ResearchPropagationDeps,
): Promise<PropagatedUpdateOutcome> {
  let entityName = "";
  try {
    entityName = isNonEmptyString(update?.entityName) ? update.entityName : "";
    if (entityName.length === 0) {
      return { kind: "withheld", entityName, reason: "malformed_update" };
    }

    const kind = update.entityKind ?? DEFAULT_ENTITY_KIND;
    const entityRef: EntityRef = { name: entityName, kind };
    const resolution = await resolveEntity(entityRef, input.workspaceId, { gbrain: deps.gbrain });
    if (resolution.kind === "withheld") {
      return { kind: "withheld", entityName, reason: resolution.reason };
    }

    const notePath = resolution.kind === "resolved" ? resolution.path : stubNotePathFor(resolution, kind);
    if (notePath === null) {
      return { kind: "withheld", entityName, reason: "malformed_update" };
    }

    const citations = Array.isArray(update.citations) ? update.citations : [];
    const sourceRefs = citations
      .filter((c): c is ResearchCitationRef => c != null && isNonEmptyString(c.url))
      .map((c) => ({ sourceId: c.url }));
    if (sourceRefs.length === 0) {
      // REQ-F-006: an unsourced plan is inadmissible. Withhold with a legible reason rather than
      // letting `planSynthesis` fold this to its generic `unusable_input`.
      return { kind: "withheld", entityName, reason: "no_source_refs" };
    }

    const body = isNonEmptyString(update.change) ? update.change : "";
    const effect: RegionEffect =
      resolution.kind === "create_stub"
        ? "new_note"
        : safeHasRegion(deps.sections, notePath, RESEARCH_REGION_ID)
          ? "refresh"
          : "new_region";

    const candidate: SynthesisCandidate = {
      regions: [{ notePath, regionId: RESEARCH_REGION_ID, body, effect }],
    };
    const reason: SynthesisReasonPort = { reason: async () => candidate };

    const planned = await planSynthesis(
      {
        workspaceId: input.workspaceId,
        provenanceOrigin: input.provenanceOrigin,
        sourceRefs,
      },
      { gbrain: deps.gbrain, reason, sections: deps.sections, newPlanId: deps.newPlanId },
    );

    if (!isOk(planned) || planned.value.plans.length === 0) {
      // A region write always assembles into the AUTO tier — zero plans means the schema gate (or an
      // effect/allowlist mismatch) rejected it. Fail safe to withheld; never fabricate a plan.
      return { kind: "withheld", entityName, reason: "plan_rejected" };
    }
    return { kind: "grounded", entityName, plan: planned.value.plans[0]! };
  } catch {
    return { kind: "withheld", entityName, reason: "malformed_update" };
  }
}

/**
 * Propagate a /research-deep synthesis delta's recommended updates into candidate
 * `KnowledgeMutationPlan`s. Returns ONE outcome per update, in the SAME order, never dropping one
 * silently. The port-LEVEL `propagation_failed` is reserved for the call itself faulting (a malformed
 * top-level input) — a per-update grounding refusal is always `withheld`, never this. TOTAL
 * never-throws; PURE over the injected ports.
 */
export async function propagateResearchUpdates(
  input: ResearchPropagationInput,
  deps: ResearchPropagationDeps,
): Promise<Result<readonly PropagatedUpdateOutcome[], PropagateResearchFailure>> {
  try {
    if (input == null || typeof input !== "object" || !isNonEmptyString(input.workspaceId as unknown as string)) {
      return err({ code: "propagation_failed", message: "malformed propagation input" });
    }
    if (!Array.isArray(input.recommendedUpdates)) {
      return err({ code: "propagation_failed", message: "recommendedUpdates must be an array" });
    }
    const outcomes: PropagatedUpdateOutcome[] = [];
    for (const update of input.recommendedUpdates) {
      outcomes.push(await propagateOne(update, input, deps));
    }
    return ok(outcomes);
  } catch {
    return err({ code: "propagation_failed", message: "propagation run faulted" });
  }
}
