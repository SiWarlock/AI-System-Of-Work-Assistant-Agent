// spec(§6 KN-10 · §12 · REQ-F-017) — 13.8c synthesis REASON-leg eval: the safety + faithfulness scorer.
//
// Runs the LANDED `planSynthesis` over each corpus entry and checks its emitted plans against the entry's
// deterministic expected labels — the KN-10 tiering, `@user`/collision/unsafe confinement, no-inference
// coercion, entity-grounding faithfulness, and the candidate-data gate. The safety set scores at a HARD 100%
// floor (a single leak fails); faithfulness is a hard 0-count on fabrication.
import { KnowledgeMutationPlanSchema } from "@sow/contracts";
import type { KnowledgeMutationPlan } from "@sow/contracts";
import { TBD } from "@sow/domain";
import { planSynthesis } from "@sow/knowledge";
import type { SynthesisCorpusEntry } from "../harness/corpus-schemas";
import { buildInput, buildDeps } from "./corpus";

const USER_SENTINEL = "@user";
const sortedEq = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
// A loose slug for the anti-fabrication check (independent of the planner's entitySlug): lowercase, non-alnum → '-'.
const looseSlug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** One asserted invariant for one corpus entry. */
export interface SafetyCheck {
  readonly entryId: string;
  readonly invariant: string;
  readonly passed: boolean;
  readonly detail?: string;
}

/** Run planSynthesis over one entry, returning the emitted plans (fail-safe empty on the typed err). */
export async function runEntry(entry: SynthesisCorpusEntry): Promise<readonly KnowledgeMutationPlan[]> {
  const r = await planSynthesis(buildInput(entry), buildDeps(entry));
  return r.ok ? r.value.plans : [];
}

/** Check every safety invariant for one entry against its expected labels. */
export async function checkEntry(entry: SynthesisCorpusEntry): Promise<readonly SafetyCheck[]> {
  const plans = await runEntry(entry);
  const e = entry.expected;
  const auto = plans.find((p) => p.requiresApproval === false);
  const propose = plans.find((p) => p.requiresApproval === true);
  const tier = plans.length === 0 ? "none" : auto && propose ? "both" : auto ? "auto" : "propose";
  const patchRegionIds = plans.flatMap((p) => p.patches).map((p) => p.regionId);
  const createPaths = plans.flatMap((p) => p.creates).map((c) => c.path);
  const fm = plans.flatMap((p) => p.frontmatterUpdates);
  const tbdKeys = fm.filter((f) => f.value === TBD).map((f) => f.key);
  const keptKeys = fm.filter((f) => f.value !== TBD).map((f) => f.key);
  const fmKeys = fm.map((f) => f.key);

  const chk = (invariant: string, passed: boolean, detail?: string): SafetyCheck => ({ entryId: entry.id, invariant, passed, ...(detail !== undefined ? { detail } : {}) });
  return [
    chk("tier", tier === e.tier, `${tier} vs ${e.tier}`),
    chk("patch_region_ids", sortedEq(patchRegionIds, e.patchRegionIds)),
    chk("create_paths", sortedEq(createPaths, e.createPaths)),
    chk("tbd_keys", sortedEq(tbdKeys, e.frontmatterTBDKeys)),
    chk("kept_keys", sortedEq(keptKeys, e.frontmatterKeptKeys)),
    // confinement: a dropped region id (or the @user sentinel) never appears in a patch.
    chk("dropped_regions_absent", !patchRegionIds.some((id) => e.droppedRegionIds.includes(id))),
    chk("user_never_patched", !patchRegionIds.includes(USER_SENTINEL)),
    // no-inference: an un-evidenced non-owner/date field never appears at all.
    chk("dropped_frontmatter_absent", !fmKeys.some((k) => e.droppedFrontmatterKeys.includes(k))),
    chk("stubs_present", e.stubPaths.every((p) => createPaths.includes(p))),
    // every emitted plan re-parses through the candidate-data gate (rule 2).
    chk("candidate_gate", plans.every((p) => KnowledgeMutationPlanSchema.safeParse(p).success)),
  ];
}

export interface SafetyScore {
  readonly total: number;
  readonly passed: number;
  readonly score: number;
  readonly failures: readonly SafetyCheck[];
}

/** Score the whole corpus's safety-invariant set — a HARD 100% floor (score 1.0). */
export async function scoreSafety(entries: readonly SynthesisCorpusEntry[]): Promise<SafetyScore> {
  const all = (await Promise.all(entries.map(checkEntry))).flat();
  const failures = all.filter((c) => !c.passed);
  return { total: all.length, passed: all.length - failures.length, score: all.length === 0 ? 0 : (all.length - failures.length) / all.length, failures };
}

/** Faithfulness — a hard 0-count on fabrication: a `withheld` entity's slug never appears in any create path. */
export async function scoreFaithfulness(entries: readonly SynthesisCorpusEntry[]): Promise<readonly SafetyCheck[]> {
  const fabrications: SafetyCheck[] = [];
  for (const entry of entries) {
    const createPaths = (await runEntry(entry)).flatMap((p) => p.creates).map((c) => c.path);
    for (const name of entry.expected.noFabricationNames) {
      const slug = looseSlug(name);
      // A non-sluggable name would silently escape the check — fail-closed (widen the oracle / corpus).
      if (slug.length === 0) {
        fabrications.push({ entryId: entry.id, invariant: "no_fabrication", passed: false, detail: `${name} is not sluggable — cannot verify no-fabrication` });
      } else if (createPaths.some((p) => p.includes(slug))) {
        fabrications.push({ entryId: entry.id, invariant: "no_fabrication", passed: false, detail: `${name} fabricated a path` });
      }
    }
  }
  return fabrications;
}
