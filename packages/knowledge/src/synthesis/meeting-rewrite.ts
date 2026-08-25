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
import { resolveEntity, mintEntityStub, type EntityRef, type EntityCandidate, type EntityGbrainReadPort, type WithheldReason } from "./entity-resolver";
import { planSynthesis, type SynthesisReasonPort, type SynthesisSectionPort } from "./planner";
import { admitGroundedPath, rebuildPlanWithMutations, type GroundedPathRefusal } from "./grounded-path";

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
   * The DETERMINISTIC entity refs from the correlate step (project / decision / attendee). Grounded
   * resolve-OR-STUB: an unresolved ref here may mint a create-stub, because it carries a real name.
   */
  readonly entityRefs?: readonly EntityRef[];
  /**
   * Refs that may RESOLVE to an existing note but must NEVER mint a create-stub (13.8g-A rule 2).
   * An IDENTIFIER — a bare email — is evidence of a person but not of a NAME, so stubbing it would
   * create a machine-named page (`jane-acme-com.md`) duplicating the real `jane-doe.md` for the same
   * human, corroding KN-11 entity convergence. Passed verbatim they can still match an existing note
   * by alias (the case that matters); matching nothing, they produce silence rather than a note.
   * Suppression must be EXPLICIT: `resolveEntity` returns `create_stub`, not `withheld`, on a
   * no-match. Omit/empty ⇒ this leg is inert and `entityRefs` behavior is byte-identical.
   */
  readonly identifierOnlyRefs?: readonly EntityRef[];
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
   * downstream schema gate and emit nothing. See `refusals` for this decision's REJECTED complement
   * (13.8m-C).
   */
  readonly groundedPaths: readonly string[];
  /**
   * 13.8m-C — code-only refusal audit (§6 KN-7 "rejected AND audited"), the MEETING-path analog of
   * `IngestRewriteReceipt.refusals` (13.8m-A). Reason codes ONLY: a channel that carried the refused
   * path would BECOME the exfiltration route it exists to report (rule 7). An empty array means
   * "nothing was refused" — the distinction that makes a poisoned run observably different from a
   * benign one.
   *
   * ⛔ DORMANT, PRODUCER-ONLY: this field is populated on the real meeting path, but there is
   * currently NO CONSUMER — the meeting-path worker binding (the 13.8m-B analogue) does not exist
   * yet. Do not read this as "refusals now reach the operator" — only the SOURCE path's refusals do
   * today, via 13.8m-B.
   *
   * Unlike its sibling (`IngestRewriteReceipt.refusals`, capped by its own `MAX_REFUSALS`), this array
   * has no separate cap: its only two push sites (the single seed check, and the per-ref grounding
   * loop) are already transitively bounded by `MAX_ENTITY_REFS` — length can never exceed 1 + 200.
   */
  readonly refusals: readonly GroundedPathRefusal[];
  /**
   * Per-code count of EVERY `WithheldReason` this run's own DIRECT `resolveEntity` call site produced
   * (13.23-C — this channel's analog of `planner.ts`'s `entityRefsWithheldByReason`, tracked there as
   * "leg C"). Code-ONLY (rule 7: never a ref/name/path/slug). SPARSE, not exhaustive: an absent key
   * means that code never fired this run; a present key its fired count. Built via a `Map` and
   * converted to the plain-object shape ONLY once via `Object.fromEntries` (mirrors
   * `planner.ts`'s `collectEntities` — `Object.fromEntries` defines OWN properties, so a
   * `WithheldReason` member spelled `"__proto__"`/`"constructor"`/`"toString"` still lands as a
   * harmless own key rather than touching the object's prototype).
   *
   * ⛔ DELIBERATELY NAMED DIFFERENTLY FROM `planner.ts`'s `entityRefsWithheldByReason` — a
   * `MeetingRewriteReceipt` structurally carries no field of THAT name
   * (`the_meeting_rewrite_direct_call_site_does_NOT_flow_through_this_channel`,
   * synthesis-planner.test.ts). That pin asserts a DIFFERENT channel (the MODEL-supplied
   * `candidate.entityRefs` `collectEntities` sees) never reaches this receipt; reusing its field name
   * here for a field that DOES exist would have made that assertion pass for the wrong reason (name
   * collision, not absence) the moment this field landed.
   *
   * ⛔ SCOPE: covers ONLY the direct loop over `input.entityRefs`/`identifierOnlyRefs` — the
   * counterpart gap `planner.ts`'s own doc comment names. `ws_scope_mismatch` is embedded in the type
   * for exhaustiveness but is STRUCTURALLY UNREACHABLE via a well-behaved port on this call site: the
   * outer WS-8 gate above already requires `deps.gbrain.workspaceId === input.workspaceId` before this
   * loop is ever entered, so `resolveEntity`'s OWN internal re-gate can only fire here via a hostile
   * double-read `workspaceId` getter (pinned, not merely asserted unreachable).
   *
   * ⛔ DORMANT, PRODUCER-ONLY — same as `refusals` immediately above: no meeting-path worker consumer
   * exists yet.
   */
  readonly directEntityRefsWithheldByReason: Readonly<Partial<Record<WithheldReason, number>>>;
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
  // Hoisted ABOVE the try (mirrors 13.8m-A's `ingest-rewrite.ts` fix): a fault AFTER admission must
  // not discard what was already refused, or a run that refuses a resolved candidate and then trips a
  // throwing port becomes byte-identical to a benign empty one — destroying exactly the distinction
  // this channel exists to create.
  const refusals: GroundedPathRefusal[] = [];
  // 13.23-C: hoisted alongside `refusals`, for the SAME reason (see above) — a fault after some
  // withholds have already tallied must not discard what was already observed.
  const directWithheldByReason = new Map<WithheldReason, number>();
  const empty = (): MeetingRewriteReceipt => ({
    runId,
    plans: [],
    planIds: [],
    autoCount: 0,
    proposeCount: 0,
    meetingNoteLinkMutations: [],
    groundedPaths: [],
    refusals,
    directEntityRefsWithheldByReason: Object.fromEntries(directWithheldByReason) as Readonly<
      Partial<Record<WithheldReason, number>>
    >,
  });
  try {
    // Every guard lives INSIDE the try so the total-function claim holds even for a null/hostile
    // `deps` or `input` (the sibling `rewriteVaultForSource` is total the same way).
    if (input == null || typeof input !== "object") return empty();
    // 13.8k: validate the subject path ONCE and use the captured value everywhere below. Re-reading
    // `input.meetingNotePath` per use would be a TOCTOU seam — a hostile getter/Proxy could return a
    // benign path to the guard and `index.md` to the seed.
    const seedVerdict = admitGroundedPath(input.meetingNotePath);
    if (!seedVerdict.ok) {
      refusals.push(seedVerdict.reason); // 13.8m-C: the CALLER-SUPPLIED SEED route, observed not discarded
      return empty();
    }
    const meetingNotePath = seedVerdict.path;
    // WS-8 (safety rule 4): a read port bound to another workspace never reads — fail closed BEFORE any
    // query is issued, so no cross-brain read is even attempted (defense-in-depth over resolveEntity's).
    if (deps == null || deps.gbrain?.workspaceId !== input.workspaceId) return empty();

    // 1. GROUND (deterministic). TWO legs, differing ONLY in whether a no-match may mint a note:
    //    · `entityRefs`          — resolve-OR-STUB (the ref carries a real name).
    //    · `identifierOnlyRefs`  — resolve-ONLY (13.8g-A rule 2; a no-match produces silence).
    //    One combined slice keeps the single `MAX_ENTITY_REFS` bound, and with `identifierOnlyRefs`
    //    omitted this list is exactly `entityRefs.slice(0, MAX_ENTITY_REFS)` — byte-identical.
    //    Named refs are concatenated FIRST, so they win the shared budget: if `entityRefs` alone
    //    fills the cap, identifier-only refs are the first sacrificed (more evidence outranks less).
    //    Each source is sliced BEFORE mapping so an oversized input allocates nothing extra.
    const namedRefs = Array.isArray(input.entityRefs) ? input.entityRefs.slice(0, MAX_ENTITY_REFS) : [];
    const identifierRefs = Array.isArray(input.identifierOnlyRefs)
      ? input.identifierOnlyRefs.slice(0, MAX_ENTITY_REFS)
      : [];
    const refs: readonly { readonly ref: EntityRef; readonly allowStub: boolean }[] = [
      ...namedRefs.map((ref) => ({ ref, allowStub: true })),
      ...identifierRefs.map((ref) => ({ ref, allowStub: false })),
    ].slice(0, MAX_ENTITY_REFS);
    // 13.8k: the run's OWN subject seeds the set through the SAME single admission point — a meeting
    // note "at" index.md would otherwise let the model patch the navigation catalog by the one route
    // that isn't a GBrain row. `audit:false` — groundedPaths documents ENTITY decisions, not the subject.
    const grounded = new Set<string>();
    const groundedPaths: string[] = [];
    admitInto(meetingNotePath, grounded, groundedPaths, false);
    const stubCreates: NoteCreate[] = [];
    for (const { ref, allowStub } of refs) {
      // PER-ELEMENT fail-safe (mirrors planner.ts `collectEntities`): `resolveEntity` reads
      // `entityRef.name` before its own try opens, so ONE malformed ref would otherwise abort the
      // whole run and discard every already-grounded entity. Blast radius = the bad element only.
      try {
        const resolution = await resolveEntity(ref, input.workspaceId, { gbrain: deps.gbrain });
        if (resolution.kind === "resolved" && isNonEmptyString(resolution.path)) {
          admitInto(resolution.path, grounded, groundedPaths);
        } else if (resolution.kind === "withheld") {
          // 13.8m-C: `resolveEntity` ALREADY ran `admitGroundedPath` internally on a resolved
          // candidate's path (13.8k) and withheld on failure — the reason is embedded in the broader
          // `WithheldReason` union. Surface it here iff it's actually a GroundedPathRefusal (route 2,
          // RESOLVED CANDIDATE, from grounded-path.ts's own header); the other withheld reasons
          // (ambiguous/lossy_match/gbrain_unavailable/malformed_entity/ws_scope_mismatch) are not this
          // channel's concern and are left alone, exactly as before.
          const { reason } = resolution;
          // 13.23-C: EVERY withheld reason on this DIRECT call site is tallied here — unlike
          // `refusals` immediately below, which only ever carries the two GroundedPathRefusal codes.
          directWithheldByReason.set(reason, (directWithheldByReason.get(reason) ?? 0) + 1);
          if (reason === "structural_surface" || reason === "unsafe_shape") refusals.push(reason);
        } else if (allowStub) {
          // 13.8j/13-residual-1: namespaced by the ONE shared derivation (never built inline), so an
          // untrusted attendee name can't mint a root structural surface. `null` ⇒ not mintable.
          const stub = mintEntityStub(resolution, ref?.kind);
          if (stub !== null && admitInto(stub.path, grounded, groundedPaths)) {
            stubCreates.push(stub);
          }
        }
        // a stub-suppressed no-match ⇒ nothing grounded, nothing to report — a create_stub with
        // `allowStub` false is silence by design (13.8g-A rule 2), not a refusal of this channel's kind.
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
        if (l.srcPath === meetingNotePath && plan.requiresApproval === false) meetingNoteLinkMutations.push(l);
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
      refusals,
      directEntityRefsWithheldByReason: Object.fromEntries(directWithheldByReason) as Readonly<
        Partial<Record<WithheldReason, number>>
      >,
    };
  } catch {
    return empty(); // keeps any refusals accumulated before the fault
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
  // Delegates to the ONE shared rebuild (13.8l) — the meeting gate and the source gate filter by
  // different predicates but must reassemble identically, and two copies would drift.
  return rebuildPlanWithMutations(original, m);
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

/**
 * THE SINGLE ENTRY POINT to the grounded set (13.8k). Every path — resolved candidate, minted stub,
 * or a future producer's — is admitted here or not at all, so the shape invariant holds regardless of
 * who produced it. A structural pin fails if a second `grounded.add` / `groundedPaths.push` appears
 * anywhere else. Returns whether the path is now grounded (already-present counts as admitted).
 *
 * NOTE the meeting note itself is admitted at the top of the run but deliberately NOT audited here —
 * `groundedPaths` documents the ENTITY grounding decisions, not the run's own subject.
 */
function admitInto(path: string, grounded: Set<string>, groundedPaths: string[], audit = true): boolean {
  const verdict = admitGroundedPath(path);
  if (!verdict.ok) return false;
  // ALREADY grounded ⇒ nothing NEW was admitted. Returning true here would let a stub be minted over
  // a note the resolver already confirmed EXISTS (a second ref slugging to an already-resolved path),
  // which is what the pre-13.8k `!grounded.has(...)` guard prevented. Callers key creates off this.
  if (grounded.has(verdict.path)) return false;
  grounded.add(verdict.path);
  if (audit) groundedPaths.push(verdict.path);
  return true;
}

function safeRunId(deps: MeetingRewriteDeps): string {
  try {
    const id = deps.newRunId();
    return typeof id === "string" && id.length > 0 ? id : "run";
  } catch {
    return "run";
  }
}
