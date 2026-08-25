// @sow/workflows — task 13.14 ACTIVITY: DERIVE the /research single-note
// {@link KnowledgeMutationPlan} FROM a VALIDATED {@link ResearchDossier}.
//
// This is an ACTIVITY, NOT workflow code — it MAY use node:crypto (via
// `@sow/domain`'s `buildIdempotencyKey`) to compute the plan's replay-stable key
// (inv-5, mirroring `buildBriefOutputs.ts`'s established derive-from-validated
// pattern). It implements {@link BuildResearchNotePlanPort}.
//
// `plan.workspaceId` is stamped from the PASSED (bound) workspace — never a
// caller/model-controlled field (WS-2/WS-4). The note's path is computed by the
// SINGLE `researchNotePath` authority (noteSlug.ts) — never re-derived here — so
// a fail-closed (null) path never reaches a KnowledgeMutationPlan. Every
// model-derived string (the dossier's summary + each citation's title/url/
// snippet) is run through the ONE canonical `neutralizeRegionMarkers` (L9)
// before it lands in the note body, defending against a `kw:region`/`@user`/
// `@generated` marker forgery riding in candidate research content.
import { ok, err, planId } from "@sow/contracts";
import type { KnowledgeMutationPlan, ProvenanceOrigin, SourceRef, Result } from "@sow/contracts";
import { buildIdempotencyKey } from "@sow/domain";
import type {
  BuildResearchNotePlanPort,
  BuildResearchNoteFailure,
  ResearchDossier,
} from "../ports/research";
import { researchNotePath, neutralizeRegionMarkers } from "./projections/noteSlug";

/** Injected deps for the /research plan-derivation activity. */
export interface BuildResearchNotePlanActivityDeps {
  /** The evidence (REQ-F-006: ≥1 sourceRef) the derived plan cites. */
  readonly sourceRef: SourceRef;
  readonly provenanceOrigin?: ProvenanceOrigin;
}

/** Compose the note body from a validated dossier, neutralizing every model-derived string. */
function composeResearchNoteBody(dossier: ResearchDossier): string {
  const summary = neutralizeRegionMarkers(dossier.summary);
  const citationLines = dossier.citations.map((c) => {
    const title = neutralizeRegionMarkers(c.title ?? c.url);
    const url = neutralizeRegionMarkers(c.url);
    const snippet = c.snippet !== undefined ? ` — ${neutralizeRegionMarkers(c.snippet)}` : "";
    return `- [${title}](${url})${snippet}`;
  });
  return [
    "## Summary",
    "",
    summary,
    "",
    "## Citations",
    "",
    ...citationLines,
    "",
  ].join("\n");
}

/**
 * Build a {@link BuildResearchNotePlanPort} that DERIVES the /research plan FROM
 * the validated dossier + the bound workspaceId. Never throws.
 */
export function createBuildResearchNotePlanActivity(
  deps: BuildResearchNotePlanActivityDeps,
): BuildResearchNotePlanPort {
  return {
    build(
      dossier: ResearchDossier,
      workspaceId,
    ): Promise<Result<KnowledgeMutationPlan, BuildResearchNoteFailure>> {
      const path = researchNotePath(workspaceId, dossier.query);
      if (path === null) {
        return Promise.resolve(
          err<BuildResearchNoteFailure>({
            code: "path_escape",
            message: `research note path could not be derived for query "${dossier.query}" (empty-after-slug or unsafe workspace segment)`,
          }),
        );
      }
      const key = buildIdempotencyKey({
        operation: "research.note.plan",
        identity: { workspace: String(workspaceId), query: dossier.query },
      });
      const plan: KnowledgeMutationPlan = {
        planId: planId(key),
        workspaceId,
        sourceRefs: [deps.sourceRef],
        creates: [
          {
            path,
            title: neutralizeRegionMarkers(dossier.query),
            body: composeResearchNoteBody(dossier),
          },
        ],
        patches: [],
        linkMutations: [],
        frontmatterUpdates: [],
        externalActionProposals: [],
        confidence: 1,
        // A fresh research note is an ADDITIVE, derived write (§6 KN-10) — the
        // SAME AUTO tier `buildBriefOutputs.ts` stamps for a fresh brief note.
        requiresApproval: false,
        // arch_gap (13.14, mirroring 25.2/proposeWindows): no dedicated "research"
        // ProvenanceOrigin member exists yet in @sow/contracts (packages/contracts
        // is out of this package's territory) — defaults to the SAME least-wrong
        // "ingestion" daily-brief + cross-calendar-scheduling already established.
        provenanceOrigin: deps.provenanceOrigin ?? "ingestion",
      };
      return Promise.resolve(ok(plan));
    },
  };
}
