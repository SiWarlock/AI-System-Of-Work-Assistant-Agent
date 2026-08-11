// ConfinedSynthesisPlanner (§6 KN-10 living-vault synthesis; REQ-F-017; 13.8c) — the ⭐ ARC-4
// keystone. A PURE, dormant SENSE→REASON→EFFECT orchestrator that composes the 13.8a EntityResolver
// (`resolveEntity`) + the 13.8b LinkHealer (`healLinks`) + an INJECTED model reason port into 0–2
// validated `KnowledgeMutationPlan`s. It encodes the KN-10 stance revision — "generative =
// propose-only" → TIERED AUTONOMY:
//
//   · AUTO (requiresApproval:false): additive/derived + reversible + confined effects — a NEW synthesis
//     note (NoteCreate), a NEW or REFRESHED `@generated` region (NotePatch), a faithful forward-link heal
//     (LinkMutation), an entity create-stub. These auto-apply (the living-vault payoff).
//   · PROPOSE (requiresApproval:true): human-relevant edits — a `FrontmatterPatch` (owner/status/date).
//
// The tier is classified DETERMINISTICALLY by the planner from (effect kind + target) — NEVER
// self-declared by the model candidate (safety rule 2: deterministic-before-latent). The two tiers land
// in SEPARATE plans so an additive write still auto-applies even when the run also proposes a human edit.
//
// SAFETY:
//  · Rule 1 (one writer): every effect is candidate `KnowledgeMutationPlan` DATA for KnowledgeWriter —
//    this module NEVER writes Markdown (no fs / no writer dep). Each plan is re-parsed through
//    `KnowledgeMutationPlanSchema` (the candidate-data gate); an invalid plan is DROPPED, never emitted.
//  · `@user` confinement (SAFETY): a NotePatch is emitted ONLY under a SYMMETRIC fail-closed ALLOWLIST over
//    the note's writer-owned region ids — `refresh` must hit an id IN `describe().generatedRegionIds`;
//    `new_region` must hit an id NOT in it (a provably fresh append, never an overwrite); `new_note` wraps
//    its body in an `@generated` region by construction. Every region id must be marker-safe + non-`@user`.
//    An effect-relabel, an unknown/unexpected id, or the `@user` sentinel FAILS CLOSED to a drop
//    (L12/L13 allowlist-over-denylist). KW KN-7 marker-namespace isolation is the downstream backstop.
//  · REQ-F-017 no-inference: an un-evidenced owner/date frontmatter value is coerced to `TBD`; any other
//    un-evidenced value is DROPPED — an invented value is NEVER emitted (reuses `@sow/domain`'s oracle).
//  · L32/WS-8 ground-before-write: entity refs resolve through `resolveEntity`; a `withheld` entity
//    fabricates NOTHING; only a `create_stub` may create.
//
// PURE over the injected ports; TOTAL never-throws (a faulted read / mis-shaped candidate → fail-safe
// empty or partial-valid plan set — L11); DORMANT (production wiring is 13.8d/13.8f).
import { ok, err, KnowledgeMutationPlanSchema, EntityRefSchema } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  ProvenanceOrigin,
  KnowledgeMutationPlan,
  NoteCreate,
  NotePatch,
  LinkMutation,
  FrontmatterPatch,
} from "@sow/contracts";
import { checkExtractionField, TBD } from "@sow/domain";
import { renderGeneratedRegion } from "../markdown-vault/sections";
import {
  resolveEntity,
  stubNotePathFor,
  type EntityRef,
  type EntityCandidate,
  type EntityGbrainReadPort,
  type WithheldReason,
} from "./entity-resolver";
import { healLinks, type LinkRef } from "./link-healer";

// ── candidate types (knowledge-local, NOT frozen contracts — mirror EntityRef/LinkRef) ──────────

/** How a proposed region write is realized — the discriminant that keeps confinement an ALLOWLIST. */
export type RegionEffect =
  | "new_note" // a NEW synthesis note (NoteCreate); the planner mints the @generated region by construction
  | "new_region" // a fresh @generated region in an existing note (NotePatch); writer-owned by construction
  | "refresh"; // rewrite an EXISTING @generated region — regionId MUST be in describe().generatedRegionIds

/** A model-proposed region write. Candidate data — the planner deterministically tiers + confines it. */
export interface ProposedRegion {
  readonly notePath: string;
  readonly regionId: string;
  readonly body: string;
  readonly effect: RegionEffect;
}

/** A model-proposed frontmatter claim; no-inference gated by its evidence (REQ-F-017). */
export interface ProposedFrontmatter {
  readonly notePath: string;
  readonly key: string;
  readonly value: unknown;
  readonly evidenceRef?: string;
}

/** Forward links to heal in a source note (faithful-or-withhold via `healLinks`). */
export interface ProposedLinks {
  readonly srcPath: string;
  readonly refs: readonly LinkRef[];
}

/** The model REASON output over one run. Candidate data — NEVER trusted to be well-formed. */
export interface SynthesisCandidate {
  readonly regions?: readonly ProposedRegion[];
  readonly frontmatter?: readonly ProposedFrontmatter[];
  readonly entityRefs?: readonly EntityRef[];
  readonly links?: ProposedLinks;
}

/** A target note's region layout — the SENSE input the ALLOWLIST confinement reads. */
export interface NoteRegionDescriptor {
  /** Writer-owned (@generated/kw:region) region ids currently in the note — the patch allowlist. */
  readonly generatedRegionIds: readonly string[];
}

/** SENSE — supplies each target note's region descriptors (backed by `parseSections`/`listRegionIds` at wire). */
export interface SynthesisSectionPort {
  describe(notePath: string): NoteRegionDescriptor;
}

/** REASON — the injected model port producing the candidate synthesis (faked in unit tests; wired 13.8d/f). */
export interface SynthesisReasonPort {
  reason(input: SynthesisInput): Promise<SynthesisCandidate>;
}

/** The run's inputs. `provenanceOrigin` is taken as INPUT (origin-agnostic; the dedicated synthesis member is 13.8d). */
export interface SynthesisInput {
  readonly workspaceId: WorkspaceId;
  readonly provenanceOrigin: ProvenanceOrigin;
  /** Plan evidence (REQ-F-006 non-empty); an empty set makes any plan inadmissible ⇒ `unusable_input`. */
  readonly sourceRefs: readonly { readonly sourceId: string; readonly span?: string }[];
  readonly confidence?: number;
  /** The workspace's existing notes — SENSE context for `healLinks`. From 13.3 retrieval; faked in tests. */
  readonly linkCandidates?: readonly EntityCandidate[];
}

export interface SynthesisDeps {
  readonly gbrain: EntityGbrainReadPort; // SENSE grounding via resolveEntity
  readonly reason: SynthesisReasonPort; // REASON
  readonly sections: SynthesisSectionPort; // SENSE — target-note region descriptors (confinement allowlist)
  readonly newPlanId: () => string; // deterministic id minting (injected)
}

export interface SynthesisOutcome {
  /** 0–2 plans: at most one AUTO (requiresApproval:false) + at most one PROPOSE (requiresApproval:true). */
  readonly plans: readonly KnowledgeMutationPlan[];
  /**
   * Count of MODEL-supplied `candidate.entityRefs` dropped by the `MAX_MODEL_ENTITY_REFS` cap this run
   * (13.8h). 0 means nothing was truncated — the same "empty means benign" distinction 13.8m-A's
   * `refusals` channel makes on the receipts, expressed as a COUNT rather than a code list (there is
   * exactly one truncation class here: over budget). Never a ref/name/path (rule 7).
   */
  readonly entityRefsTruncated: number;
  /**
   * Count of MODEL-supplied `candidate.entityRefs` REJECTED by `EntityRefSchema` this run
   * (§DEC-CANDGATE leg 2, task 13.19, REQ-S-006) — a bad `kind`, a blank/non-string `name`, or a
   * smuggled extra key (e.g. `path`) never reaches `resolveEntity`/`stubNotePathFor`. 0 means nothing
   * was rejected. Deliberately a SEPARATE count from `entityRefsTruncated`, never merged into it: the
   * cap is a POSITIONAL slice taken BEFORE validation runs (bounds gbrain-read AND schema-parse work to
   * the same constant, and leaves the 13.8h cap byte-identical), so `entityRefsTruncated` counts refs
   * beyond the cap that are never even inspected by the schema, while `entityRefsRejected` counts
   * malformed refs WITHIN the capped set — disjoint populations, so a reader can tell which failure
   * class fired rather than a merged number hiding it (L88's independent-caps discipline, applied to
   * independent counts). Never a ref/name/path (rule 7) — a poisoned-row attack must not be
   * byte-identical to a benign empty run (13.8m).
   */
  readonly entityRefsRejected: number;
  /**
   * Per-code count of `WithheldReason`s `resolveEntity` produced this run (13.23 leg A) — code-ONLY
   * (rule 7: never a ref/name/path/slug). `WithheldReason` is a closed literal union, so the map's KEY
   * TYPE makes carrying a free string structurally impossible (the compile-level pin in
   * synthesis-planner.test.ts). SPARSE, not exhaustive: an absent key means that code never fired this
   * run (0), a present key its fired count — exhaustive-by-construction was considered and rejected
   * because `GroundedPathRefusal` (composed into `WithheldReason`) exports no member list, so building
   * an exhaustive map would mean RE-DECLARING it here, which criterion 3 (composed, never re-declared)
   * forbids; a future refusal member propagates through this map with zero code changes.
   * `ws_scope_mismatch` (the WS-8 signal) is individually distinguishable from every other code, never
   * folded into an aggregate — a single merged count would destroy exactly the distinction this field
   * exists to create (the same argument `entityRefsRejected`'s own doc comment makes).
   *
   * ⛔ SCOPE: only withholds from `collectEntities` (the MODEL-supplied `candidate.entityRefs`) reach
   * this map. `rewriteVaultForMeeting`'s OWN direct `resolveEntity` call over `input.entityRefs` /
   * `identifierOnlyRefs` (the deterministic correlation-step refs) is a SEPARATE call site and does
   * NOT flow through here — pinned by
   * `the_meeting_rewrite_direct_call_site_does_NOT_flow_through_this_channel`. Tracked as leg C.
   *
   * ⛔ DORMANT — leg B (13.23, worker) is the consumer: it surfaces this map (alongside
   * `entityRefsTruncated`/`entityRefsRejected`, both ALSO produced-and-dropped today) to System Health
   * via the driver's `deps.health.surface`, NOT to the audit trail (24.7's scope). Until leg B lands,
   * this field is produced-and-unread by every caller of `planSynthesis` — a NAMED dormant seam, not a
   * silent one (L106).
   */
  readonly entityRefsWithheldByReason: Readonly<Partial<Record<WithheldReason, number>>>;
}

/** The only actionable error: an input that can never source a plan (REQ-F-006). All other faults fail safe. */
export type SynthesisError = { readonly code: "unusable_input" };

// ── internals ───────────────────────────────────────────────────────────────────────────────────

const USER_SENTINEL = "@user";
// arch_gap: the concrete §9 owner/date field set is unspecified (no-inference.ts keys an OPAQUE field
// name). This heuristic errs toward TBD-coercion (never fabrication) — the REQ-F-017-safe direction.
const OWNER_DATE_RE = /(?:owner|assignee|due|date)/i;

/**
 * Fan-out bound on the MODEL-supplied `candidate.entityRefs` (13.8h) — `collectEntities` awaits ONE
 * GBrain read (`resolveEntity`) per element, so an uncapped array drives an unbounded SEQUENTIAL read
 * loop off a single degenerate REASON output. Deliberately INDEPENDENT of meeting-rewrite.ts's
 * `MAX_ENTITY_REFS`: that constant bounds a DETERMINISTIC input the meeting path owns (the correlated
 * attendee/project refs); this one bounds ADVERSARIAL MODEL OUTPUT. Same value today so nothing
 * surprises, but the two must NEVER be single-sourced — retuning one is not a decision about the
 * other's threat model.
 */
export const MAX_MODEL_ENTITY_REFS = 200;

interface Muts {
  creates: NoteCreate[];
  patches: NotePatch[];
  linkMutations: LinkMutation[];
  frontmatterUpdates: FrontmatterPatch[];
}
const emptyMuts = (): Muts => ({ creates: [], patches: [], linkMutations: [], frontmatterUpdates: [] });

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
// A missing / non-finite confidence fails CLOSED to the floor (0) — every other path in this module
// (no-inference, the allowlist, safeDescribe) fails closed, so confidence must not silently fail OPEN.
const clamp01 = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * A marker-SAFE, non-reserved region id: a clean `[^\s>]+` token (the exact id grammar
 * `sections.ts`'s MARKER_RE accepts) that is NOT the `@user` human sentinel. Anything else
 * (whitespace / `>` / marker syntax / `@user`) is a forge/injection vector ⇒ DROP.
 */
const isSafeRegionId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id !== USER_SENTINEL && /^[^\s>]+$/.test(id);

/** Read a note's writer-owned region allowlist defensively — fail closed (EMPTY allowlist) on any fault. */
function safeDescribe(port: SynthesisSectionPort, notePath: string): readonly string[] {
  try {
    const d = port.describe(notePath);
    return Array.isArray(d?.generatedRegionIds) ? d.generatedRegionIds.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Plan a confined living-vault synthesis. Composes SENSE (resolveEntity + section descriptors) → REASON
 * (the injected model candidate) → EFFECT (deterministically tiered + confined mutation primitives) into
 * 0–2 validated `KnowledgeMutationPlan`s. TOTAL never-throws; fail-safe empty/partial on any fault.
 */
export async function planSynthesis(
  input: SynthesisInput,
  deps: SynthesisDeps,
): Promise<Result<SynthesisOutcome, SynthesisError>> {
  // Unusable input — a plan can never be sourced (REQ-F-006) ⇒ typed err (distinct from "nothing to synthesize").
  // Validate each sourceRef carries a non-empty sourceId here (guarded) so `assemble`'s map can never throw.
  try {
    if (input == null || typeof input !== "object") return err({ code: "unusable_input" });
    if (!isNonEmptyString(input.workspaceId as unknown as string)) return err({ code: "unusable_input" });
    if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length === 0) return err({ code: "unusable_input" });
    if (!input.sourceRefs.every((s) => s != null && isNonEmptyString(s.sourceId))) return err({ code: "unusable_input" });
  } catch {
    return err({ code: "unusable_input" });
  }

  const autoM = emptyMuts();
  const proposeM = emptyMuts();
  const plans: KnowledgeMutationPlan[] = [];
  // Hoisted ABOVE the try (mirrors 13.8m-A's `refusals` fix): a fault AFTER `collectEntities` runs (e.g.
  // a throwing `newPlanId` inside `assemble`) must not discard the truncation/rejection/withheld counts
  // already computed — else a run that fan-out-hijacked entityRefs and then tripped a later fault would
  // report the SAME entityRefsTruncated/entityRefsRejected/entityRefsWithheldByReason as a benign run,
  // destroying the distinction these fields exist to create.
  let entityRefsTruncated = 0;
  let entityRefsRejected = 0;
  let entityRefsWithheldByReason: Partial<Record<WithheldReason, number>> = {};

  try {
    const candidate = await deps.reason.reason(input);
    if (candidate != null && typeof candidate === "object") {
      collectRegions(candidate.regions, autoM, deps);
      collectFrontmatter(candidate.frontmatter, proposeM);
      collectLinks(candidate.links, autoM, input);
      const entityStats = await collectEntities(candidate.entityRefs, autoM, input, deps);
      entityRefsTruncated = entityStats.truncated;
      entityRefsRejected = entityStats.rejected;
      entityRefsWithheldByReason = entityStats.withheld;
    }
    // Assembly runs INSIDE the try — a throwing `newPlanId` fails safe to the plans already assembled (L11).
    const autoPlan = assemble(autoM, false, input, deps);
    if (autoPlan) plans.push(autoPlan);
    const proposePlan = assemble(proposeM, true, input, deps);
    if (proposePlan) plans.push(proposePlan);
  } catch {
    // reason port / assembly / any composite fault ⇒ fail-safe: return whatever was assembled (possibly nothing).
  }
  return ok({ plans, entityRefsTruncated, entityRefsRejected, entityRefsWithheldByReason });
}

/**
 * REGIONS → AUTO. Confinement is a SYMMETRIC, fail-closed ALLOWLIST over the note's writer-owned region
 * ids (so an effect-relabel can never bypass it):
 *  · `refresh`    → emit ONLY if regionId ∈ generatedRegionIds (a POSITIVELY writer-owned existing region).
 *  · `new_region` → emit ONLY if regionId ∉ generatedRegionIds — a genuinely FRESH id, so KW's applyRegionPatch
 *                    APPENDS a new @generated region (provably additive, never an overwrite). A colliding id is
 *                    a mislabelled refresh ⇒ DROP.
 *  · `new_note`   → a NoteCreate whose body the planner wraps in an @generated region by construction.
 * All region ids must be marker-SAFE + non-`@user` (isSafeRegionId) or the effect DROPs — a NotePatch thus
 * only ever writes a `kw:region` marker (never `@user`/human bytes; KW KN-7 is the downstream backstop).
 */
function collectRegions(regions: readonly ProposedRegion[] | undefined, autoM: Muts, deps: SynthesisDeps): void {
  if (!Array.isArray(regions)) return;
  for (const r of regions) {
    try {
      if (r == null || !isNonEmptyString(r.notePath) || typeof r.body !== "string") continue;
      if (!isSafeRegionId(r.regionId)) continue; // marker-unsafe / `@user` ⇒ DROP (no injection, no human target)
      if (r.effect === "new_note") {
        autoM.creates.push({ path: r.notePath, body: renderGeneratedRegion(r.regionId, r.body) });
        continue;
      }
      const owned = safeDescribe(deps.sections, r.notePath); // the writer-owned allowlist for this note
      const exists = owned.includes(r.regionId);
      if (r.effect === "refresh" && exists) {
        autoM.patches.push({ path: r.notePath, regionId: r.regionId, newBody: r.body }); // allowlisted refresh
      } else if (r.effect === "new_region" && !exists) {
        autoM.patches.push({ path: r.notePath, regionId: r.regionId, newBody: r.body }); // provably-fresh append
      }
      // any mismatch (refresh-unknown, new_region-collision, unknown effect) ⇒ fail closed, DROP
    } catch {
      continue;
    }
  }
}

/** FRONTMATTER → PROPOSE (human-relevant). No-inference: un-evidenced owner/date ⇒ TBD; other un-evidenced ⇒ DROP. */
function collectFrontmatter(frontmatter: readonly ProposedFrontmatter[] | undefined, proposeM: Muts): void {
  if (!Array.isArray(frontmatter)) return;
  for (const f of frontmatter) {
    try {
      if (f == null || !isNonEmptyString(f.notePath) || !isNonEmptyString(f.key)) continue;
      const check = checkExtractionField(f.key, { value: f.value, evidenceRef: f.evidenceRef });
      if (check.ok) {
        proposeM.frontmatterUpdates.push({ path: f.notePath, key: f.key, value: f.value }); // evidenced value or TBD
      } else if (OWNER_DATE_RE.test(f.key)) {
        proposeM.frontmatterUpdates.push({ path: f.notePath, key: f.key, value: TBD }); // REQ-F-017: coerce, never invent
      }
      // else: un-evidenced non-owner/date field ⇒ DROP
    } catch {
      continue;
    }
  }
}

/** LINKS → AUTO. Faithful heals via `healLinks`; withheld refs emit nothing. */
function collectLinks(links: ProposedLinks | undefined, autoM: Muts, input: SynthesisInput): void {
  if (links == null || !isNonEmptyString(links.srcPath) || !Array.isArray(links.refs)) return;
  try {
    const healed = healLinks(links.srcPath, links.refs, input.linkCandidates ?? [], input.workspaceId);
    for (const h of healed) if (h.kind === "healed") autoM.linkMutations.push(h.mutation);
  } catch {
    // fail safe
  }
}

/** The fan-out/validation/withhold bookkeeping `collectEntities` reports back to `planSynthesis` (13.8h + §DEC-CANDGATE leg 2 + 13.23 leg A). */
interface EntityCollectionStats {
  readonly truncated: number;
  readonly rejected: number;
  readonly withheld: Partial<Record<WithheldReason, number>>;
}

/**
 * ENTITY grounding → AUTO. create_stub MAY create a stub; a `withheld`/`resolved` fabricates nothing.
 *
 * Two gates apply, in this order, deliberately: (1) the MODEL-supplied `entityRefs` array is capped
 * to `MAX_MODEL_ENTITY_REFS` BY POSITION first (13.8h — a degenerate REASON output must not drive an
 * unbounded sequential GBrain read); (2) `EntityRefSchema` (§DEC-CANDGATE leg 2, task 13.19,
 * REQ-S-006) then validates each element of that CAPPED subset, before it ever reaches
 * `resolveEntity`/`stubNotePathFor` — `kind`/`name` are runtime-untrusted candidate data, not a
 * guarantee the `EntityRef` TS type alone provides.
 *
 * CAP-THEN-VALIDATE (not validate-then-cap) is the deliberate choice: it bounds both the GBrain-read
 * work AND the schema-parse work to the same constant, and leaves the 13.8h cap's meaning byte-
 * identical (still "the first `MAX_MODEL_ENTITY_REFS` elements, by position"). ⚠ ACCEPTED TRADE-OFF,
 * recorded so it is never rediscovered as a surprise: because the cap is positional, a degenerate
 * model output FRONT-LOADED with malformed refs can consume the entire cap and starve legitimate refs
 * positioned after it (e.g. 200 malformed refs followed by 50 valid ones ⇒ all 200 are rejected, the
 * 50 valid ones are truncated away and never resolved). This degrades completeness, never
 * correctness — a suppressed ref writes nothing false — and bounding parse+read work to one constant
 * against a hostile input is judged worth more than maximizing useful work extracted from it.
 *
 * Returns the counts of refs dropped by each gate (0 = nothing dropped by that gate) so the caller can
 * surface them — disjoint populations, never merged: a ref beyond the cap is truncated and never
 * inspected by the schema at all; a malformed ref within the cap is rejected and never counted as
 * truncated.
 */
async function collectEntities(
  entityRefs: readonly EntityRef[] | undefined,
  autoM: Muts,
  input: SynthesisInput,
  deps: SynthesisDeps,
): Promise<EntityCollectionStats> {
  if (!Array.isArray(entityRefs)) return { truncated: 0, rejected: 0, withheld: {} };
  const capped = entityRefs.slice(0, MAX_MODEL_ENTITY_REFS); // sliced BEFORE validation — nothing extra allocated/awaited
  const truncated = Math.max(0, entityRefs.length - MAX_MODEL_ENTITY_REFS);
  let rejected = 0;
  // 13.23 leg A: a per-code withhold tally. `res.reason` is produced entirely by this codebase's own
  // `resolveEntity` (never runtime-untrusted candidate data itself — only `res.reason`, not `eRef`,
  // ever indexes this) and every CURRENT `WithheldReason` member is collision-free against
  // `Object.prototype` — but the field's own doc comment commits to a FUTURE `GroundedPathRefusal`
  // member propagating with zero code changes, and nothing pins that a future member can't be named
  // `toString`/`constructor`/`__proto__`. Accumulate in a `Map` (mirroring `ENTITY_NAMESPACES` above,
  // immune to the prototype chain regardless of the key string, L65) and convert to the public
  // plain-object shape ONLY once, via `Object.fromEntries` — which defines OWN properties
  // (`[[DefineOwnProperty]]`), not assignment, so a hypothetical `"__proto__"`-named future member
  // still lands as a harmless own key rather than reassigning the object's prototype.
  const withheldMap = new Map<WithheldReason, number>();
  for (const eRef of capped) {
    try {
      // §DEC-CANDGATE leg 2 (REQ-S-006): `eRef` is MODEL-supplied candidate data — reject a bad
      // `kind`, a blank/non-string `name`, or a smuggled extra key (e.g. `path`) HERE, before
      // `resolveEntity`/`stubNotePathFor` ever see it. Counted, not silently dropped (13.8m: a
      // poisoned-row attack must not be byte-identical to a benign empty run).
      const parsed = EntityRefSchema.safeParse(eRef);
      if (!parsed.success) {
        rejected++;
        continue;
      }
      const validRef = parsed.data;
      const res = await resolveEntity(validRef, input.workspaceId, { gbrain: deps.gbrain });
      if (res.kind === "withheld") {
        // 13.23 leg A: surface the reason as a signal — the withhold itself is unchanged (isolation
        // holds; only detection was missing). Never the ref/name/path (rule 7) — only the closed code.
        withheldMap.set(res.reason, (withheldMap.get(res.reason) ?? 0) + 1);
      }
      // 13.8j: the stub path comes from the ONE shared namespaced derivation — never built inline
      // here, so an untrusted entity name can't mint a root structural surface (index.md / log.md).
      const stubPath = stubNotePathFor(res, validRef.kind);
      if (stubPath !== null) {
        // Skip if a create already targets this path — never let an empty stub clobber a content-bearing create.
        if (!autoM.creates.some((c) => c.path === stubPath)) {
          autoM.creates.push({ path: stubPath, body: renderGeneratedRegion("stub", "") });
        }
      }
      // resolved ⇒ the note exists (no create); withheld ⇒ nothing fabricated (ground-before-write, L32).
    } catch {
      continue;
    }
  }
  return { truncated, rejected, withheld: Object.fromEntries(withheldMap) as Partial<Record<WithheldReason, number>> };
}

/** Assemble one tier's mutations into a validated KMP, or null when there is nothing to synthesize / it fails the gate. */
function assemble(m: Muts, requiresApproval: boolean, input: SynthesisInput, deps: SynthesisDeps): KnowledgeMutationPlan | null {
  const total = m.creates.length + m.patches.length + m.linkMutations.length + m.frontmatterUpdates.length;
  if (total === 0) return null;
  const planInput = {
    planId: deps.newPlanId(),
    workspaceId: input.workspaceId as unknown as string,
    sourceRefs: input.sourceRefs.map((s) => ({ sourceId: s.sourceId, ...(s.span !== undefined ? { span: s.span } : {}) })),
    creates: m.creates,
    patches: m.patches,
    linkMutations: m.linkMutations,
    frontmatterUpdates: m.frontmatterUpdates,
    externalActionProposals: [],
    confidence: clamp01(input.confidence),
    requiresApproval,
    provenanceOrigin: input.provenanceOrigin,
  };
  const parsed = KnowledgeMutationPlanSchema.safeParse(planInput);
  return parsed.success ? parsed.data : null; // fail-safe drop on an invalid plan (candidate-data gate)
}
