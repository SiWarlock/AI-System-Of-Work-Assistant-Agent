// GenerativeProposalIntake (task 4.18, §6/§7; write-through amendment invariant
// (vi)). The ONLY path a generative output reaches canonical state — PROPOSE-ONLY
// and NON-CIRCULAR. Generation is a SoW worker `ModelProviderPort`/AgentJob call
// over read-only, ServingGate-filtered ("contained") context — NEVER gbrain
// in-engine `synthesize`/`dream`/`autopilot`. Its output is candidate data:
//
//   RawGenerativeCandidate → JSON-Schema gate (GBrainProposedFact) + no-inference
//   (REQ-F-017) + non-circular-evidence check → KnowledgeMutationPlan
//   (provenanceOrigin='gbrain_proposal', requiresApproval FORCED true) → (later)
//   KnowledgeWriter → Markdown → commit → import/sync.
//
// Three hard guards (safety rules 1 + 2):
//   1. CONTAINED context — a generation over uncontained (store-wide / raw PGLite)
//      context is rejected; only ServingGate-filtered context is admissible.
//   2. NON-CIRCULAR evidence — every evidenceRef MUST cite already-canonical Markdown
//      / a genuinely-ingested SourceEnvelope span (`isEvidenceAdmissible`). The
//      proposal's OWN scratch origin is recorded for audit but is INADMISSIBLE as
//      support — it is never mapped into the plan's sourceRefs.
//   3. auto-write-and-serve HARD-DISABLED — the intake NEVER writes and NEVER serves;
//      it only emits a candidate plan whose `requiresApproval` is forced TRUE
//      regardless of what the proposal claimed.
//
// P5 DEPENDENCY INVERSION: the minimal `ModelProviderPort`-shaped interface needed
// here is defined IN-PACKAGE (never imports @sow/providers, which builds
// concurrently); Phase 5/7 wires the concrete adapter. PURE relative to its injected
// deps; returns a typed Result — NEVER throws across the boundary (§16).
import {
  KnowledgeMutationPlanSchema,
  GBrainProposedFactSchema,
  GBRAIN_PROPOSED_FACT_SCHEMA_ID,
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
} from "@sow/contracts";
import type {
  Result,
  KnowledgeMutationPlan,
  GBrainProposedFact,
  CanonicalSourceRef,
  NoteCreate,
  NotePatch,
  LinkMutation,
  FrontmatterPatch,
} from "@sow/contracts";
import { ruleSchemaValid, validateNoInference } from "@sow/domain";
import type { SchemaRegistry } from "@sow/contracts/schema/registry";
import { buildRefusalSignal, type IssueCarryingRefusal, type RefusalIssue } from "../../audit/validation-refusal";
import type { AuditSignal } from "@sow/policy";

// ── P5 in-package ModelProviderPort inversion ──────────────────────────────────────

/** A generation request over ServingGate-filtered ("contained") context. */
export interface GenerativeRequest {
  readonly workspaceId: string;
  /** e.g. "gbrain.synthesis" — the capability the broker routes (Phase 5/7). */
  readonly capability: string;
  /** The ONLY context the generator may read: ServingGate-filtered canonical refs. */
  readonly containedContext: readonly CanonicalSourceRef[];
}

/** The raw (unvalidated) output of a generative call. */
export interface RawGenerativeOutput {
  /** Candidate GBrainProposedFact-shaped object (validated by the gate below). */
  readonly proposal: unknown;
  /** The generation's OWN scratch-brain origin — audited, INADMISSIBLE as evidence. */
  readonly scratchOrigin: string;
}

/**
 * Minimal `ModelProviderPort`-shaped interface — defined in-package (do NOT import
 * @sow/providers). The concrete Claude/OpenAI/Ollama adapter is wired in Phase 5/7.
 */
export interface ModelProviderPort {
  generate(req: GenerativeRequest): Promise<RawGenerativeOutput>;
}

// ── intake input / output / error ────────────────────────────────────────────────

export interface RawGenerativeCandidate {
  readonly proposal: unknown;
  /** The proposal's own scratch origin — recorded for audit, never admitted as evidence. */
  readonly scratchOrigin: string;
  /** TRUE iff the generation ran over ServingGate-filtered (contained) context. */
  readonly containedContext: boolean;
}

export interface GenerativeIntakeDeps {
  /**
   * TRUE iff the ref points at already-canonical Markdown / a genuinely-ingested
   * SourceEnvelope span (NOT a scratch / unmaterialized origin). Injected: the
   * canonical-store + ingest-log lookup is wired by the Synthesis stage.
   */
  readonly isEvidenceAdmissible: (ref: CanonicalSourceRef) => boolean;
  readonly newPlanId: () => string;
  /** Schema-registry override (tests); defaults to the process registry. */
  readonly registry?: SchemaRegistry;
}

export interface GenerativeIntakeOutcome {
  readonly plan: KnowledgeMutationPlan;
  readonly proposal: GBrainProposedFact;
  /** The scratch origin, surfaced for the audit trail — never used as evidence. */
  readonly scratchOriginAudited: string;
}

export type IntakeError =
  | { readonly code: "uncontained_generation" }
  // `### 24.103`'s ORIGINALLY NAMED TARGET. ⚠ The census found this channel is the DORMANT one
  // (zero production callers) and that the LIVE risk was `writer.ts`, which the entry never
  // mentioned — recorded here so the asymmetry is not re-discovered.
  // ⚠ `### 24.109` DISPOSITIONED: this channel refuses ROW CANDIDATE data too, but from TWO
  // DIFFERENT schemas depending on `code` (see the second echoing member below) — the model's own
  // `GBrainProposedFact` proposal (`schema_rejected`, here) or the `KnowledgeMutationPlan` this
  // module derives from it (`plan_invalid`, below). Signal is produced and gated; NO ADAPTER
  // PERSISTS IT. A future consumer would key by whichever candidate's own identity — the proposal's
  // scratch origin, or the derived plan's `planId` — produced THIS rejection. Distinct from
  // `router.ts`/`writer.ts` (a single schema each) and from `provenance-stamp.ts`'s internally-minted
  // `stamp_invalid` (never a row).
  | ({
      readonly code: "schema_rejected";
      readonly stage: "ajv" | "zod";
    } & IssueCarryingRefusal)
  | { readonly code: "inadmissible_evidence"; readonly refs: readonly string[] }
  | { readonly code: "no_inference"; readonly fields: readonly string[] }
  | { readonly code: "proposed_content_incomplete"; readonly factKind: string; readonly missing: readonly string[] }
  // ⛔ THE SECOND ECHOING MEMBER `### 24.103`'s ENTRY NEVER NAMED. It validates a DIFFERENT candidate
  // type from the two above (the derived `KnowledgeMutationPlan`, not the proposal) — which is why
  // the region cut is keyed by SCHEMA ID rather than by channel: one channel, two schemas.
  | ({ readonly code: "plan_invalid" } & IssueCarryingRefusal);

// `### 24.103` — this gate's refusal signals. Structural material only; `issues[].message` excluded
// categorically (predicate in `src/audit/validation-refusal.ts`).
const INTAKE_ACTOR = "knowledge:generative-intake" as const;
const INTAKE_REJECTED_PAYLOAD_MARKER = "knowledge:intake-proposal-rejection" as const;
const INTAKE_PLAN_INVALID_PAYLOAD_MARKER = "knowledge:intake-plan-rejection" as const;

function proposalRejectedSignal(stage: "ajv" | "zod", issues: readonly RefusalIssue[]): AuditSignal {
  return buildRefusalSignal({
    actor: INTAKE_ACTOR,
    event: `knowledge.intake.schema_rejected.${stage}`,
    refPrefix: "intake-issue-path",
    payloadHash: INTAKE_REJECTED_PAYLOAD_MARKER,
    beforeSummary: `generative proposal candidate refused at the ${stage} schema stage`,
    // ⛔ THE PROPOSAL'S OWN SCHEMA — its free-form-key region is `proposedContent`, which shares no
    // token with the plan's regions or with `### 24.98`'s `sanitizedPayload`.
    schemaId: GBRAIN_PROPOSED_FACT_SCHEMA_ID,
    issues,
  });
}

// ── the intake ─────────────────────────────────────────────────────────────────────

/**
 * Gate one generative candidate into a candidate `KnowledgeMutationPlan`. Total
 * function: returns a typed outcome or a typed error; never throws.
 */
export function intakeGenerativeProposal(
  candidate: RawGenerativeCandidate,
  deps: GenerativeIntakeDeps,
): Result<GenerativeIntakeOutcome, IntakeError> {
  // 1 — contained-context admission: uncontained generation is inadmissible.
  if (candidate.containedContext !== true) {
    return { ok: false, error: { code: "uncontained_generation" } };
  }

  // 2 — JSON-Schema gate (REQ-S-006): ajv structural gate + the model's Zod parse.
  const ajv = ruleSchemaValid(candidate.proposal, GBRAIN_PROPOSED_FACT_SCHEMA_ID, deps.registry);
  if (!ajv.ok) {
    const issues: readonly RefusalIssue[] = (ajv.error.errors ?? []).map((e) => ({ path: e.path, message: e.message }));
    return { ok: false, error: { code: "schema_rejected", stage: "ajv", issues, audit: proposalRejectedSignal("ajv", issues) } };
  }
  const parsed = GBrainProposedFactSchema.safeParse(candidate.proposal);
  if (!parsed.success) {
    const issues: readonly RefusalIssue[] = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return { ok: false, error: { code: "schema_rejected", stage: "zod", issues, audit: proposalRejectedSignal("zod", issues) } };
  }
  const proposal = parsed.data;

  // 3 — NON-CIRCULAR evidence: every evidenceRef must be already-canonical Markdown /
  // an ingested SourceEnvelope span. The scratch origin is never in this set (it is
  // carried separately) so it can never launder itself in as support.
  const inadmissible = proposal.evidenceRefs.filter((r) => !deps.isEvidenceAdmissible(r));
  if (inadmissible.length > 0) {
    return { ok: false, error: { code: "inadmissible_evidence", refs: inadmissible.map((r) => r.ref) } };
  }

  // 4 — no-inference (REQ-F-017): the proposed fact is a concrete claim; it must be
  // backed by admissible canonical evidence, not invented. Composed with the schema
  // gate above (Lesson §3 — the gate is a composition, never ajv alone).
  const backing = proposal.evidenceRefs[0]?.ref;
  const noInf = validateNoInference({ proposedFact: { value: proposal.proposedContent, evidenceRef: backing } });
  if (!noInf.ok) {
    return { ok: false, error: { code: "no_inference", fields: noInf.error.map((e) => e.field) } };
  }

  // 5 — map the proposed content into candidate mutation primitives (never inventing;
  // the values come from proposedContent, whose backing is the cited evidence).
  const mapped = mapProposedContent(proposal);
  if (!mapped.ok) {
    return mapped;
  }

  // 6 — assemble the plan: evidenceRefs → sourceRefs; provenanceOrigin='gbrain_proposal';
  // requiresApproval FORCED true (auto-write-and-serve hard-disabled); proposalId linked.
  const planInput = {
    planId: deps.newPlanId(),
    workspaceId: proposal.workspaceId as string,
    sourceRefs: proposal.evidenceRefs.map((r) => ({ sourceId: r.ref, ...(r.span !== undefined ? { span: r.span } : {}) })),
    creates: mapped.value.creates,
    patches: mapped.value.patches,
    linkMutations: mapped.value.linkMutations,
    frontmatterUpdates: mapped.value.frontmatterUpdates,
    externalActionProposals: [],
    confidence: proposal.confidence,
    requiresApproval: true,
    provenanceOrigin: "gbrain_proposal" as const,
    gbrainProposalRef: proposal.proposalId as string,
  };
  const parsedPlan = KnowledgeMutationPlanSchema.safeParse(planInput);
  if (!parsedPlan.success) {
    const issues: readonly RefusalIssue[] = parsedPlan.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    // ⛔ NOTE THE SCHEMA ID — this site validates the derived PLAN, so it cuts at the plan's regions,
    // NOT the proposal's. A per-channel cut would have used the wrong region set here.
    return {
      ok: false,
      error: {
        code: "plan_invalid",
        issues,
        audit: buildRefusalSignal({
          actor: INTAKE_ACTOR,
          event: "knowledge.intake.plan_invalid",
          refPrefix: "intake-issue-path",
          payloadHash: INTAKE_PLAN_INVALID_PAYLOAD_MARKER,
          beforeSummary: "derived knowledge mutation plan refused at the zod schema stage",
          schemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
          issues,
        }),
      },
    };
  }

  return { ok: true, value: { plan: parsedPlan.data, proposal, scratchOriginAudited: candidate.scratchOrigin } };
}

/**
 * Convenience wrapper: run a `ModelProviderPort` generation over CONTAINED context,
 * then intake its output. The `containedContext` flag is derived structurally — the
 * generator was handed ServingGate-filtered refs, so the resulting candidate is
 * contained by construction. Phase 5/7 supplies the concrete port.
 */
export async function runGenerativeProposal(
  port: ModelProviderPort,
  req: GenerativeRequest,
  deps: GenerativeIntakeDeps,
): Promise<Result<GenerativeIntakeOutcome, IntakeError>> {
  const raw = await port.generate(req);
  return intakeGenerativeProposal(
    { proposal: raw.proposal, scratchOrigin: raw.scratchOrigin, containedContext: true },
    deps,
  );
}

// ── proposedContent → mutation primitives ────────────────────────────────────────

interface MappedMutations {
  readonly creates: NoteCreate[];
  readonly patches: NotePatch[];
  readonly linkMutations: LinkMutation[];
  readonly frontmatterUpdates: FrontmatterPatch[];
}

const EMPTY: MappedMutations = { creates: [], patches: [], linkMutations: [], frontmatterUpdates: [] };

/**
 * Map a proposal's `proposedContent` into the KnowledgeWriter mutation primitives by
 * factKind. Rejects `proposed_content_incomplete` when a required field is missing —
 * the no-inference posture (REQ-F-017): reject, never fabricate a missing value.
 *
 * arch_gap: `proposedContent`'s shape is UNSPECIFIED upstream (GBrainProposedFact
 * models it as an open record; the precise per-factKind payload firms up with the
 * §6/Phase-4 KnowledgeWriter primitives). This is the documented interim mapping.
 */
function mapProposedContent(proposal: GBrainProposedFact): Result<MappedMutations, IntakeError> {
  const c = proposal.proposedContent;
  const str = (k: string): string | undefined => (typeof c[k] === "string" && (c[k] as string).length > 0 ? (c[k] as string) : undefined);

  switch (proposal.factKind) {
    case "page": {
      const path = str("path");
      const body = typeof c["body"] === "string" ? (c["body"] as string) : undefined;
      const missing: string[] = [];
      if (path === undefined) missing.push("path");
      if (body === undefined) missing.push("body");
      if (missing.length > 0) return incomplete("page", missing);
      const create: NoteCreate = {
        path: path as string,
        body: body as string,
        ...(str("title") !== undefined ? { title: str("title") } : {}),
        ...(isRecord(c["frontmatter"]) ? { frontmatter: c["frontmatter"] as Record<string, unknown> } : {}),
      };
      return { ok: true, value: { ...EMPTY, creates: [create] } };
    }
    case "link": {
      const srcPath = str("srcPath");
      const dstSlug = str("dstSlug");
      const missing: string[] = [];
      if (srcPath === undefined) missing.push("srcPath");
      if (dstSlug === undefined) missing.push("dstSlug");
      if (missing.length > 0) return incomplete("link", missing);
      const link: LinkMutation = {
        op: "add",
        srcPath: srcPath as string,
        dstSlug: dstSlug as string,
        ...(str("field") !== undefined ? { field: str("field") } : {}),
      };
      return { ok: true, value: { ...EMPTY, linkMutations: [link] } };
    }
    case "tag": {
      const path = str("path");
      const tag = str("tag");
      const missing: string[] = [];
      if (path === undefined) missing.push("path");
      if (tag === undefined) missing.push("tag");
      if (missing.length > 0) return incomplete("tag", missing);
      const fm: FrontmatterPatch = { path: path as string, key: "tags", value: tag };
      return { ok: true, value: { ...EMPTY, frontmatterUpdates: [fm] } };
    }
    case "timeline": {
      const path = str("path");
      const entry = str("entry");
      const missing: string[] = [];
      if (path === undefined) missing.push("path");
      if (entry === undefined) missing.push("entry");
      if (missing.length > 0) return incomplete("timeline", missing);
      const fm: FrontmatterPatch = { path: path as string, key: "timeline", value: entry };
      return { ok: true, value: { ...EMPTY, frontmatterUpdates: [fm] } };
    }
    case "frontmatter_value": {
      const path = str("path");
      const key = str("key");
      const missing: string[] = [];
      if (path === undefined) missing.push("path");
      if (key === undefined) missing.push("key");
      if (!("value" in c)) missing.push("value");
      if (missing.length > 0) return incomplete("frontmatter_value", missing);
      const fm: FrontmatterPatch = { path: path as string, key: key as string, value: c["value"] };
      return { ok: true, value: { ...EMPTY, frontmatterUpdates: [fm] } };
    }
  }
}

function incomplete(factKind: string, missing: string[]): Result<MappedMutations, IntakeError> {
  return { ok: false, error: { code: "proposed_content_incomplete", factKind, missing } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
