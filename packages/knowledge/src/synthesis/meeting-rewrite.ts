// Meeting-path living-vault synthesis (§9 workflow-1 L297; §6 KN-10/KN-11; §5 WS-8; REQ-F-017; 13.8f-A)
// — the MEETING analog of `rewriteVaultForSource`. ARCH §9 W1 names project/person/decision/daily as
// KnowledgeWriter targets, but the meeting producer emits a single meeting note with empty
// `linkMutations`/`frontmatterUpdates`; this module supplies the entity-grounded mutations that fill
// that gap. It emits only KMP DATA for KnowledgeWriter — never a Markdown write (safety rule 1).
//
// ── THE ONE DELIBERATE DIFFERENCE FROM THE SOURCE PATH ─────────────────────────────────────────────
// `planSynthesis` (13.8c) does NOT ground the notePaths a model proposes for regions/frontmatter — it
// confines them (allowlisted region ids) but takes the PATH on trust. On the source path that is
// acceptable: the ingest is already scoped to a note it just wrote. On the MEETING path it is not —
// a meeting mentions arbitrary people and projects, so a hallucinated "people/ghost.md" would become a
// fabricated file reference. So this layer adds GROUND-BEFORE-WRITE as a post-plan gate:
//
//     a mutation survives iff its target path ∈ (paths the 13.8a EntityResolver actually grounded)
//                                              ∪ {the meeting note itself}
//
// Grounding is deterministic — it runs over `input.entityRefs` (the correlation step's project /
// decision / attendee refs), NOT over anything the model invented. Consequence, accepted deliberately:
// a stub `planSynthesis` mints from its own `candidate.entityRefs` is DROPPED unless that entity was
// also grounded here. Fail-closed is the correct direction for an autonomous writer (13.8f Done-when:
// "a synthesis-named non-existent path never fabricates a file").
//
// ── THE 13.8f-B MERGE CONTRACT (what the worker does with the return value) ────────────────────────
// The receipt is PARTITIONED so the worker can never double-write:
//   · `meetingNoteLinkMutations` — additive links whose srcPath IS the meeting note. The worker folds
//     these into the meeting note's OWN `KnowledgeMutationPlan` in `buildOutputs.ts` (the currently
//     hardcoded `linkMutations: []`). They are REMOVED from `plans`.
//   · `plans` — the entity-page plans (person/project), already tiered AUTO/PROPOSE, committed as
//     their own KMPs alongside the meeting KMP.
// There is no `meetingNoteFrontmatter` counterpart BY CONSTRUCTION: frontmatter is a human-relevant
// claim edit, so KN-10 tiers it PROPOSE — it can never fold into the meeting note's additive plan. The
// worker leaves `frontmatterUpdates: []` there; the propose plan carries them.
//
// PURE over injected ports; TOTAL never-throws (any fault ⇒ fail-safe empty receipt); DORMANT — the
// production binding is 13.8f-B (worker). Attendee PARSING is 13.8g; attendees ride `entityRefs` here.
import { KnowledgeMutationPlanSchema } from "@sow/contracts";
import type {
  WorkspaceId,
  ProvenanceOrigin,
  KnowledgeMutationPlan,
  NoteCreate,
  NotePatch,
  LinkMutation,
  FrontmatterPatch,
} from "@sow/contracts";
import { renderGeneratedRegion } from "../markdown-vault/sections";
import { resolveEntity, type EntityRef, type EntityCandidate, type EntityGbrainReadPort } from "./entity-resolver";
import { planSynthesis, type SynthesisReasonPort, type SynthesisSectionPort } from "./planner";

// Per-array flood bounds (L31 — bounded blast radius for an autonomous writer). These cap the
// DETERMINISTIC inputs this module owns: the correlated entity refs and the link-candidate context.
// NOT covered: `planSynthesis` separately resolves the MODEL-supplied `candidate.entityRefs`
// (planner.ts `collectEntities`) with no cap of its own, so a degenerate REASON output can still drive
// an unbounded read loop one layer down — that cap belongs in 13.8c and is flagged, not fixed here.
export const MAX_ENTITY_REFS = 200;
export const MAX_LINK_CANDIDATES = 2000;

export interface MeetingRewriteInput {
  readonly workspaceId: WorkspaceId;
  readonly provenanceOrigin: ProvenanceOrigin;
  /** The meeting note the closeout writes — always a permitted target (it is the run's own subject). */
  readonly meetingNotePath: string;
  readonly sourceRefs: readonly { readonly sourceId: string; readonly span?: string }[];
  readonly confidence?: number;
  /**
   * The DETERMINISTIC entity refs from the correlate step (project / decision / attendee). These and
   * only these are grounded — attendees ride here as opaque refs until 13.8g parses them.
   */
  readonly entityRefs?: readonly EntityRef[];
  /** Existing workspace notes — SENSE context for `healLinks` (13.3 retrieval; faked in tests). */
  readonly linkCandidates?: readonly EntityCandidate[];
}

/** Narrower than `IngestRewriteDeps` BY DESIGN: no `structural` port — a meeting must not be able to
 *  rewrite index.md / log.md as a side effect (KN-12 parity is the source path's concern). */
export interface MeetingRewriteDeps {
  readonly gbrain: EntityGbrainReadPort;
  readonly reason: SynthesisReasonPort;
  readonly sections: SynthesisSectionPort;
  readonly newPlanId: () => string;
  readonly newRunId: () => string;
}

export interface MeetingRewriteReceipt {
  readonly runId: string;
  /** Entity-page plans (meeting-note additive links REMOVED — see the merge contract). */
  readonly plans: readonly KnowledgeMutationPlan[];
  /** Ordered plan handles = the one-action batch-undo unit. */
  readonly planIds: readonly string[];
  readonly autoCount: number;
  readonly proposeCount: number;
  /** The additive links 13.8f-B folds into the meeting note's own KMP. */
  readonly meetingNoteLinkMutations: readonly LinkMutation[];
  /**
   * Audit surface: the ENTITY paths grounding admitted this run (resolved notes + create-stubs), in
   * resolution order. It is the grounding decision, NOT a record of what was written — the meeting
   * note itself is omitted (it is always permitted), and a stub listed here can still fail the
   * downstream schema gate and emit nothing.
   */
  readonly groundedPaths: readonly string[];
}

interface Muts {
  creates: NoteCreate[];
  patches: NotePatch[];
  linkMutations: LinkMutation[];
  frontmatterUpdates: FrontmatterPatch[];
}
const emptyMuts = (): Muts => ({ creates: [], patches: [], linkMutations: [], frontmatterUpdates: [] });
const mutCount = (m: Muts): number =>
  m.creates.length + m.patches.length + m.linkMutations.length + m.frontmatterUpdates.length;

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const clamp01 = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Rewrite the vault for one meeting closeout: GROUND the correlated entities → plan a confined
 * synthesis → gate every effect to a grounded target → partition the meeting note's own additive links
 * out for the 13.8f-B fold. PURE; TOTAL never-throws.
 */
export async function rewriteVaultForMeeting(
  input: MeetingRewriteInput,
  deps: MeetingRewriteDeps,
): Promise<MeetingRewriteReceipt> {
  const runId = safeRunId(deps);
  const empty: MeetingRewriteReceipt = {
    runId,
    plans: [],
    planIds: [],
    autoCount: 0,
    proposeCount: 0,
    meetingNoteLinkMutations: [],
    groundedPaths: [],
  };
  try {
    // Every guard lives INSIDE the try so the total-function claim holds even for a null/hostile
    // `deps` or `input` (the sibling `rewriteVaultForSource` is total the same way).
    if (input == null || typeof input !== "object") return empty;
    if (!isNonEmptyString(input.meetingNotePath)) return empty;
    // WS-8 (safety rule 4): a read port bound to another workspace never reads — fail closed BEFORE any
    // query is issued, so no cross-brain read is even attempted (defense-in-depth over resolveEntity's).
    if (deps == null || deps.gbrain?.workspaceId !== input.workspaceId) return empty;

    // 1. GROUND (deterministic) — resolve-or-stub each correlated entity. Never fabricates a path.
    const refs = Array.isArray(input.entityRefs) ? input.entityRefs.slice(0, MAX_ENTITY_REFS) : [];
    const grounded = new Set<string>([input.meetingNotePath]);
    const groundedPaths: string[] = [];
    const stubCreates: NoteCreate[] = [];
    for (const ref of refs) {
      // PER-ELEMENT fail-safe (mirrors planner.ts `collectEntities`): `resolveEntity` reads
      // `entityRef.name` before its own try opens, so ONE malformed ref would otherwise abort the
      // whole run and discard every already-grounded entity. Blast radius = the bad element only.
      try {
        const resolution = await resolveEntity(ref, input.workspaceId, { gbrain: deps.gbrain });
        if (resolution.kind === "resolved" && isNonEmptyString(resolution.path)) {
          if (!grounded.has(resolution.path)) {
            grounded.add(resolution.path);
            groundedPaths.push(resolution.path);
          }
        } else if (resolution.kind === "create_stub" && isNonEmptyString(resolution.proposedSlug)) {
          const stubPath = `${resolution.proposedSlug}.md`;
          if (!grounded.has(stubPath)) {
            grounded.add(stubPath);
            groundedPaths.push(stubPath);
            stubCreates.push({ path: stubPath, body: renderGeneratedRegion("stub", "") });
          }
        }
        // withheld ⇒ nothing grounded, nothing may target it (ground-before-write, L32)
      } catch {
        continue;
      }
    }

    // 2. WS-8 pre-filter + flood-bound the link candidates (a foreign candidate never even competes).
    const linkCandidates = Array.isArray(input.linkCandidates)
      ? input.linkCandidates.filter((c) => c != null && c.workspaceId === input.workspaceId).slice(0, MAX_LINK_CANDIDATES)
      : undefined;

    // 3. PLAN the confined synthesis (13.8c does REASON + confinement + tiering + no-inference).
    const planned = await planSynthesis(
      {
        workspaceId: input.workspaceId,
        provenanceOrigin: input.provenanceOrigin,
        sourceRefs: input.sourceRefs,
        confidence: input.confidence,
        linkCandidates,
      },
      { gbrain: deps.gbrain, reason: deps.reason, sections: deps.sections, newPlanId: deps.newPlanId },
    );
    const semantic = planned.ok ? planned.value.plans : [];

    // 4. GATE every effect to a grounded target, and PARTITION the meeting note's additive links out.
    const meetingNoteLinkMutations: LinkMutation[] = [];
    const rebuilt: KnowledgeMutationPlan[] = [];
    for (const plan of semantic) {
      const kept = emptyMuts();
      for (const c of plan.creates) if (grounded.has(c.path)) kept.creates.push(c);
      for (const p of plan.patches) if (grounded.has(p.path)) kept.patches.push(p);
      for (const f of plan.frontmatterUpdates) if (grounded.has(f.path)) kept.frontmatterUpdates.push(f);
      for (const l of plan.linkMutations) {
        if (!grounded.has(l.srcPath)) continue;
        // The meeting note's own additive links leave the plan set and become the 13.8f-B fold surface
        // — kept in exactly ONE place so the worker's merge can never write them twice.
        if (l.srcPath === input.meetingNotePath && plan.requiresApproval === false) meetingNoteLinkMutations.push(l);
        else kept.linkMutations.push(l);
      }
      // The entity create-stubs are grounded by construction — they ride the AUTO plan.
      if (plan.requiresApproval === false && stubCreates.length > 0) {
        for (const s of stubCreates) if (!kept.creates.some((c) => c.path === s.path)) kept.creates.push(s);
      }
      if (mutCount(kept) === 0) continue;
      const reassembled = assemble(kept, plan);
      if (reassembled) rebuilt.push(reassembled);
    }

    // 5. A run that grounded stubs but produced no semantic AUTO plan still creates the stubs.
    if (stubCreates.length > 0 && !rebuilt.some((p) => p.requiresApproval === false)) {
      const stubOnly = emptyMuts();
      stubOnly.creates.push(...stubCreates);
      const plan = assembleFresh(stubOnly, false, input, deps);
      if (plan) rebuilt.unshift(plan);
    }

    return {
      runId,
      plans: rebuilt,
      planIds: rebuilt.map((p) => p.planId),
      autoCount: rebuilt.filter((p) => p.requiresApproval === false).length,
      proposeCount: rebuilt.filter((p) => p.requiresApproval === true).length,
      meetingNoteLinkMutations,
      groundedPaths,
    };
  } catch {
    return empty;
  }
}

/**
 * Re-validate a gated plan through the candidate-data gate. The gate only ever REMOVES mutations, so
 * every non-mutation field must survive verbatim — the three optionals (`gbrainProposalRef`,
 * `signedProvenanceStamp`, `expectedProjectId`) and `externalActionProposals` included. Dropping an
 * optional here would silently strip a provenance stamp or a §13.10a `expectedProjectId` verification
 * field from a plan that carried one. Spread conditionally: the schema is `.strict()`.
 */
function assemble(m: Muts, original: KnowledgeMutationPlan): KnowledgeMutationPlan | null {
  const parsed = KnowledgeMutationPlanSchema.safeParse({
    planId: original.planId,
    workspaceId: original.workspaceId,
    sourceRefs: original.sourceRefs.map((s) => ({
      sourceId: s.sourceId,
      ...(s.span !== undefined ? { span: s.span } : {}),
    })),
    creates: m.creates,
    patches: m.patches,
    linkMutations: m.linkMutations,
    frontmatterUpdates: m.frontmatterUpdates,
    externalActionProposals: original.externalActionProposals,
    confidence: original.confidence,
    requiresApproval: original.requiresApproval,
    provenanceOrigin: original.provenanceOrigin,
    ...(original.gbrainProposalRef !== undefined ? { gbrainProposalRef: original.gbrainProposalRef } : {}),
    ...(original.signedProvenanceStamp !== undefined ? { signedProvenanceStamp: original.signedProvenanceStamp } : {}),
    ...(original.expectedProjectId !== undefined ? { expectedProjectId: original.expectedProjectId } : {}),
  });
  return parsed.success ? parsed.data : null; // fail-safe drop (candidate-data gate)
}

/** Assemble a fresh plan for effects that have no semantic plan to ride (the stub-only run). */
function assembleFresh(
  m: Muts,
  requiresApproval: boolean,
  input: MeetingRewriteInput,
  deps: MeetingRewriteDeps,
): KnowledgeMutationPlan | null {
  const parsed = KnowledgeMutationPlanSchema.safeParse({
    planId: deps.newPlanId(),
    workspaceId: input.workspaceId,
    sourceRefs: input.sourceRefs.map((s) => ({ sourceId: s.sourceId, ...(s.span !== undefined ? { span: s.span } : {}) })),
    creates: m.creates,
    patches: m.patches,
    linkMutations: m.linkMutations,
    frontmatterUpdates: m.frontmatterUpdates,
    externalActionProposals: [],
    confidence: clamp01(input.confidence),
    requiresApproval,
    provenanceOrigin: input.provenanceOrigin,
  });
  return parsed.success ? parsed.data : null;
}

function safeRunId(deps: MeetingRewriteDeps): string {
  try {
    const id = deps.newRunId();
    return typeof id === "string" && id.length > 0 ? id : "run";
  } catch {
    return "run";
  }
}
