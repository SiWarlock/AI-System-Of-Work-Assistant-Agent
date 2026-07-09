// KnowledgeMutationPlan seam model (task 1.7(WT-amended), §3/§6/§7). The validated
// unit every semantic mutation routes through — the ONLY shape KnowledgeWriter
// accepts as input (safety rule 1: one writer / no hidden brain). It bundles the
// candidate Markdown mutations (creates/patches/links/frontmatter), any external
// side-effect proposals, and the provenance that classifies how the plan entered
// the §6 Knowledge-Mutation state machine. Honors the §3 universal reject-on-empty
// rule (REQ-F-006): a semantic mutation MUST carry a workspaceId AND at least one
// sourceRef — an unsourced mutation is precisely the "invented fact" the
// candidate-data gate (safety rule 2) / no-inference rule (REQ-F-017) forbid.
// Zod is the single source of truth: the TS type is the explicit interface below
// (see TS4023 note), the JSON Schema is generated via `emitJsonSchema`. PURE —
// imports only foundation primitives + shared shapes/enums + sibling seam models.
import { z } from "zod";
import { PlanIdSchema, WorkspaceIdSchema, ProposalIdSchema } from "../primitives/zod-brands";
import {
  SourceRefSchema,
  NoteCreateSchema,
  NotePatchSchema,
  LinkMutationSchema,
  FrontmatterPatchSchema,
} from "./shared-shapes";
import { provenanceOriginSchema } from "./shared-enums";
import { ProposedActionSchema } from "./proposed-action";
import { SignedProvenanceStampSchema } from "./signed-provenance-stamp";
import type { PlanId, WorkspaceId } from "../primitives/ids";
import type { ProposalId } from "../primitives/zod-brands";
import type {
  SourceRef,
  NoteCreate,
  NotePatch,
  LinkMutation,
  FrontmatterPatch,
} from "./shared-shapes";
import type { ProvenanceOrigin } from "./shared-enums";
import type { ProposedAction } from "./proposed-action";
import type { SignedProvenanceStamp } from "./signed-provenance-stamp";

/** Stable JSON-Schema `$id` for the schema registry. */
export const KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID = "sow:knowledge-mutation-plan" as const;

// Explicit output interface + annotation: the inferred type would otherwise force
// the declaration emitter to name `ids.ts`'s module-private `__brand` symbol
// (TS4023) via the branded `PlanId` / `WorkspaceId` / `ProposalId` (and the brands
// nested in `SourceRef` / `ProposedAction` / `SignedProvenanceStamp`). A nameable
// `KnowledgeMutationPlan` type sidesteps that (the same workaround `egress-policy.ts`
// / `gcl-projection.ts` use); `.strict()` rejection of unknown keys and the
// REQ-F-006 `.refine()` are unaffected.
export interface KnowledgeMutationPlan {
  planId: PlanId;
  workspaceId: WorkspaceId;
  // REQ-F-006: non-empty (pinned by the refine) — every plan cites its evidence.
  sourceRefs: SourceRef[];
  // Candidate Markdown mutation primitives. May be empty individually; the plan's
  // only structural non-empty requirement is sourceRefs. The element field-level
  // contracts (NoteCreate/NotePatch/LinkMutation/FrontmatterPatch) are the §6/
  // Phase-4 KnowledgeWriter primitives (foundation arch_gap — sketched in
  // shared-shapes, firmed up there).
  creates: NoteCreate[];
  patches: NotePatch[];
  linkMutations: LinkMutation[];
  frontmatterUpdates: FrontmatterPatch[];
  // External side-effect proposals carried alongside the semantic mutation; each
  // is the REAL §8 ProposedAction (universal external-write rule enforced there).
  externalActionProposals: ProposedAction[];
  // Plan-level confidence ∈ [0,1].
  confidence: number;
  // Human-in-the-loop gate (the §6 Knowledge-Mutation machine reads this; a
  // gbrain_proposal-origin plan defaults this ON upstream).
  requiresApproval: boolean;
  // Discriminates how the plan entered the §6 state machine (one of 5 values).
  provenanceOrigin: ProvenanceOrigin;
  // Back-reference to the originating GBrainProposedFact when provenanceOrigin is
  // gbrain_proposal; absent otherwise. arch_gap: the cross-ref is OPTIONAL and not
  // coupled to provenanceOrigin at the contract surface (the §6/§7 propose-only
  // lifecycle owns that coupling) — modeled OPEN, not refine-pinned here.
  gbrainProposalRef?: ProposalId;
  // LIFECYCLE arch_gap: Appendix A lists signedProvenanceStamp as a KMP field, but
  // KnowledgeWriter WRITES the stamp AT the atomic commit (§6 write-through
  // invariant (iii)) — the plan is KW *input*, so on an inbound plan the stamp is
  // absent. Modeled `.optional()`; whether it should live on the plan at all (vs.
  // only on committed frontmatter) is flagged for §6/Phase-4 confirmation.
  signedProvenanceStamp?: SignedProvenanceStamp;
  // §13.10a go-live gate 1 (slug-collision) — the RAW projectId a `copilot_propose` plan's patches are
  // intended for. VERIFICATION-ONLY: `safeNoteSlug` is lossy, so two projects can slug-collide onto one
  // note; the on-approval executor reads the target note's frontmatter `projectId` and REJECTS a
  // NotePatch whose target does not carry this id (so a proposal for project B can never patch project
  // A's note). Absent on non-propose plans (deterministic producers target a note whose path they just
  // derived). Optional + NOT refine-coupled to provenanceOrigin here — the executor owns the coupling.
  expectedProjectId?: string;
}

// `sourceRefs` element input = the SourceRef input shape (branded sourceId accepts
// a plain string); `gbrainProposalRef` input is a plain string (brand applied on
// parse). The embedded sibling seam schemas' INPUT shapes are derived via
// `z.input` so this interface stays exactly in lockstep with their contracts.
interface KnowledgeMutationPlanInput {
  planId: string;
  workspaceId: string;
  sourceRefs: { sourceId: string; span?: string }[];
  creates: NoteCreate[];
  patches: NotePatch[];
  linkMutations: LinkMutation[];
  frontmatterUpdates: FrontmatterPatch[];
  externalActionProposals: z.input<typeof ProposedActionSchema>[];
  confidence: number;
  requiresApproval: boolean;
  provenanceOrigin: ProvenanceOrigin;
  gbrainProposalRef?: string;
  signedProvenanceStamp?: z.input<typeof SignedProvenanceStampSchema>;
  expectedProjectId?: string;
}

export const KnowledgeMutationPlanSchema: z.ZodType<
  KnowledgeMutationPlan,
  z.ZodTypeDef,
  KnowledgeMutationPlanInput
> = z
  .object({
    planId: PlanIdSchema,
    workspaceId: WorkspaceIdSchema,
    sourceRefs: z.array(SourceRefSchema),
    creates: z.array(NoteCreateSchema),
    patches: z.array(NotePatchSchema),
    linkMutations: z.array(LinkMutationSchema),
    frontmatterUpdates: z.array(FrontmatterPatchSchema),
    externalActionProposals: z.array(ProposedActionSchema),
    confidence: z.number().min(0).max(1),
    requiresApproval: z.boolean(),
    provenanceOrigin: provenanceOriginSchema,
    gbrainProposalRef: ProposalIdSchema.optional(),
    signedProvenanceStamp: SignedProvenanceStampSchema.optional(),
    // §13.10a gate 1 — verification-only raw projectId (the executor enforces the patch-target match).
    expectedProjectId: z.string().min(1).optional(),
  })
  .strict()
  // REQ-F-006 reject-on-empty (§3 universal rule): a semantic mutation MUST carry
  // a workspaceId (structurally required + branded non-empty above) AND at least
  // one sourceRef. An empty sourceRefs list is an unsourced mutation — rejected.
  .refine((p) => p.sourceRefs.length >= 1, {
    message:
      "REQ-F-006: a semantic mutation must carry a non-empty workspaceId AND at least one sourceRef",
    path: ["sourceRefs"],
  });
