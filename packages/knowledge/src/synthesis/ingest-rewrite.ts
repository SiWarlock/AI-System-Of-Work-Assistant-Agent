// Living-vault ingest-rewrite (§6 KN-10/KN-11/KN-12; REQ-F-021; 13.8d) — the "vault rewrites itself"
// LOGIC. A PURE, dormant multi-entity orchestrator: for one ingested source it makes a SINGLE
// `planSynthesis` (13.8c) call per run → the ≤2 semantic `KnowledgeMutationPlan`s (AUTO/PROPOSE), then
// derives + merges STRUCTURAL-FILE parity mutations (index.md per-section regen + op-log) — all routed
// THROUGH KnowledgeWriter (sole writer, rule 1: this module emits only KMP DATA, never writes Markdown).
// An ingest UPDATES ≥1 EXISTING note (a region refresh / frontmatter flip via the planner), not just
// creates. Returns a per-run digest `IngestRewriteReceipt` whose ordered `planIds` are the enumerable
// one-action batch-undo unit (the worker binding maps each planId → its committed revision post-commit).
//
// INHERITS from planSynthesis (composed, not re-implemented): @user confinement (symmetric fail-closed
// allowlist), no-inference (REQ-F-017 owner/date→TBD), the tiered-autonomy split, per-array flood bounds
// (13.8d security-item iv is added below at the ingest fan-out). PURE over injected ports; TOTAL
// never-throws; DORMANT (production wiring into `runSourceIngestion` is a separate worker binding, L24).
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
import type { EntityCandidate, EntityGbrainReadPort } from "./entity-resolver";
import { planSynthesis, type SynthesisReasonPort, type SynthesisSectionPort } from "./planner";

// Per-array flood bound (13.8d security-item iv, L31) — the ingest fan-out caps the run's candidate
// context so a pathological source can't drive an unbounded KMP. planSynthesis bounds its own effects.
const MAX_LINK_CANDIDATES = 2000;

/** SENSE context for one ingest run's touched notes — passed to the structural-file writer. */
export interface StructuralContext {
  readonly workspaceId: WorkspaceId;
  /** The notePaths the semantic plans touched this run (deduped, stable order) — drives index regen. */
  readonly touchedPaths: readonly string[];
  readonly runId: string;
  readonly date?: string;
}

/** KW mutation primitives the structural-file writer emits (index.md regen + op-log). All optional. */
export interface StructuralMutations {
  readonly creates?: readonly NoteCreate[];
  readonly patches?: readonly NotePatch[];
  readonly linkMutations?: readonly LinkMutation[];
  readonly frontmatterUpdates?: readonly FrontmatterPatch[];
}

/**
 * The structural-file writer port (Q1): builds the KN-12 index/op-log mutations for a run. Injected so
 * `rewriteVaultForSource` stays PURE + testable; boot composes it from `markdown-vault/structural-files`.
 */
export interface StructuralFileWriterPort {
  build(ctx: StructuralContext): StructuralMutations;
}

export interface IngestRewriteInput {
  readonly workspaceId: WorkspaceId;
  readonly provenanceOrigin: ProvenanceOrigin;
  readonly sourceRefs: readonly { readonly sourceId: string; readonly span?: string }[];
  readonly confidence?: number;
  readonly linkCandidates?: readonly EntityCandidate[];
  /** Op-log date (YYYY-MM-DD) — INJECTED (pure; no clock). */
  readonly date?: string;
}

export interface IngestRewriteDeps {
  readonly gbrain: EntityGbrainReadPort;
  readonly reason: SynthesisReasonPort;
  readonly sections: SynthesisSectionPort;
  readonly structural: StructuralFileWriterPort;
  readonly newPlanId: () => string;
  readonly newRunId: () => string;
}

/** The per-run digest: the ≤2 plans + the enumerable `planIds` batch-undo unit + auto/propose counts. */
export interface IngestRewriteReceipt {
  readonly runId: string;
  readonly plans: readonly KnowledgeMutationPlan[];
  /** Ordered plan handles = the one-action batch-undo unit; the worker binding maps each → its CommittedRevision. */
  readonly planIds: readonly string[];
  readonly autoCount: number;
  readonly proposeCount: number;
}

const clamp01 = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Rewrite the vault for one ingested source: SINGLE planSynthesis → ≤2 semantic KMPs, then merge the
 * derived structural-file parity mutations into the AUTO plan. PURE; TOTAL never-throws (fail-safe empty
 * receipt on any fault). Returns the run's digest.
 */
export async function rewriteVaultForSource(
  input: IngestRewriteInput,
  deps: IngestRewriteDeps,
): Promise<IngestRewriteReceipt> {
  const runId = safeRunId(deps);
  const empty: IngestRewriteReceipt = { runId, plans: [], planIds: [], autoCount: 0, proposeCount: 0 };
  if (input == null || typeof input !== "object") return empty;

  try {
    // 1. SINGLE planSynthesis per run → the ≤2 semantic KMPs. Flood-bound the injected candidate context.
    const linkCandidates = Array.isArray(input.linkCandidates) ? input.linkCandidates.slice(0, MAX_LINK_CANDIDATES) : undefined;
    const res = await planSynthesis(
      {
        workspaceId: input.workspaceId,
        provenanceOrigin: input.provenanceOrigin,
        sourceRefs: input.sourceRefs,
        confidence: input.confidence,
        linkCandidates,
      },
      { gbrain: deps.gbrain, reason: deps.reason, sections: deps.sections, newPlanId: deps.newPlanId },
    );
    const semantic = res.ok ? [...res.value.plans] : [];

    // 2. Structural-file parity — derive the touched notePaths from the plans, build index + op-log muts.
    const touchedPaths = touchedNotePaths(semantic);
    const structural = safeStructural(deps.structural, { workspaceId: input.workspaceId, touchedPaths, runId, date: input.date });

    // 3. Merge the (additive) structural mutations into the AUTO plan — still ≤2 plans, one digest.
    const plans = mergeStructural(semantic, structural, input, deps);

    return {
      runId,
      plans,
      planIds: plans.map((p) => p.planId),
      autoCount: plans.filter((p) => p.requiresApproval === false).length,
      proposeCount: plans.filter((p) => p.requiresApproval === true).length,
    };
  } catch {
    return empty;
  }
}

/** The distinct notePaths every mutation in the plans touches — deduped, stable source order. */
function touchedNotePaths(plans: readonly KnowledgeMutationPlan[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (path: unknown): void => {
    if (typeof path === "string" && path.length > 0 && !seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  };
  for (const p of plans) {
    for (const c of p.creates) add(c.path);
    for (const patch of p.patches) add(patch.path);
    for (const l of p.linkMutations) add(l.srcPath);
    for (const f of p.frontmatterUpdates) add(f.path);
  }
  return out;
}

interface Muts {
  creates: NoteCreate[];
  patches: NotePatch[];
  linkMutations: LinkMutation[];
  frontmatterUpdates: FrontmatterPatch[];
}
function normalizeStructural(sm: StructuralMutations): Muts {
  return {
    creates: Array.isArray(sm?.creates) ? [...sm.creates] : [],
    patches: Array.isArray(sm?.patches) ? [...sm.patches] : [],
    linkMutations: Array.isArray(sm?.linkMutations) ? [...sm.linkMutations] : [],
    frontmatterUpdates: Array.isArray(sm?.frontmatterUpdates) ? [...sm.frontmatterUpdates] : [],
  };
}
const mutCount = (m: Muts): number => m.creates.length + m.patches.length + m.linkMutations.length + m.frontmatterUpdates.length;

/** Merge the structural (additive) mutations into the run's AUTO plan (or a fresh auto plan) — keeps ≤2 plans. */
function mergeStructural(
  semantic: readonly KnowledgeMutationPlan[],
  structural: StructuralMutations,
  input: IngestRewriteInput,
  deps: IngestRewriteDeps,
): KnowledgeMutationPlan[] {
  const sm = normalizeStructural(structural);
  if (mutCount(sm) === 0) return [...semantic];

  const autoIdx = semantic.findIndex((p) => p.requiresApproval === false);
  if (autoIdx >= 0) {
    const a = semantic[autoIdx]!;
    const parsed = KnowledgeMutationPlanSchema.safeParse({
      planId: a.planId as unknown as string,
      workspaceId: a.workspaceId as unknown as string,
      sourceRefs: a.sourceRefs.map((s) => ({ sourceId: s.sourceId as unknown as string, ...(s.span !== undefined ? { span: s.span } : {}) })),
      creates: [...a.creates, ...sm.creates],
      patches: [...a.patches, ...sm.patches],
      linkMutations: [...a.linkMutations, ...sm.linkMutations],
      frontmatterUpdates: [...a.frontmatterUpdates, ...sm.frontmatterUpdates],
      externalActionProposals: [],
      confidence: a.confidence,
      requiresApproval: false,
      provenanceOrigin: a.provenanceOrigin,
    });
    const out = [...semantic];
    if (parsed.success) out[autoIdx] = parsed.data; // else fail-safe: keep the un-merged semantic plans
    return out;
  }

  // No auto plan yet — assemble one carrying only the structural mutations.
  const parsed = KnowledgeMutationPlanSchema.safeParse({
    planId: deps.newPlanId(),
    workspaceId: input.workspaceId as unknown as string,
    sourceRefs: input.sourceRefs.map((s) => ({ sourceId: s.sourceId, ...(s.span !== undefined ? { span: s.span } : {}) })),
    creates: sm.creates,
    patches: sm.patches,
    linkMutations: sm.linkMutations,
    frontmatterUpdates: sm.frontmatterUpdates,
    externalActionProposals: [],
    confidence: clamp01(input.confidence),
    requiresApproval: false,
    provenanceOrigin: input.provenanceOrigin,
  });
  return parsed.success ? [parsed.data, ...semantic] : [...semantic];
}

function safeRunId(deps: IngestRewriteDeps): string {
  try {
    const id = deps.newRunId();
    return typeof id === "string" && id.length > 0 ? id : "run";
  } catch {
    return "run";
  }
}
function safeStructural(port: StructuralFileWriterPort, ctx: StructuralContext): StructuralMutations {
  try {
    return port.build(ctx) ?? {};
  } catch {
    return {};
  }
}
