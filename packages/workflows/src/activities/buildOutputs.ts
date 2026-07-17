// @sow/workflows — slice 7.6 ACTIVITY: DERIVE the committed outputs (the
// KnowledgeMutationPlan + the external-action proposals) FROM the VALIDATED
// extraction (inv-3 governance seam — closes the no-inference / workspace-isolation
// bypass).
//
// This is an ACTIVITY, NOT workflow code — it runs worker-side and MAY use
// node:crypto (via @sow/domain `buildIdempotencyKey` / `buildCanonicalObjectKey`)
// to compute the plan + envelope keys that drive the driver's idempotent replay
// (inv-5). It implements {@link BuildOutputsPort}.
//
// WHY THIS EXISTS (the fix): the pure driver used to COMMIT a caller-supplied
// KnowledgeMutationPlan that was DECOUPLED from the validated extraction. That made
// the REQ-F-017 no-inference gate theater (an inferred owner/date stuffed into the
// caller's plan frontmatter reached KnowledgeWriter unchecked) and made WS-2/WS-4
// theater (the caller's `plan.workspaceId` targeted whatever workspace it wanted).
// By DERIVING the plan HERE, from the ValidatedExtraction + the correlation-bound
// workspaceId:
//   • an inferred owner/date can NEVER reach the plan — it was hard-rejected at
//     validate, so it is not in `validated.fields`; only evidence-backed /
//     TBD-sentinel fields are projected into the frontmatter (inv-3 / REQ-F-017);
//   • `plan.workspaceId` is stamped from the PASSED (correlation-bound) workspaceId,
//     so a caller cannot redirect the durable write to another workspace (WS-2/WS-4).
//
// §16: returns a typed Result — never throws. A derivation the mapper cannot project
// folds to a typed {@link BuildOutputsFailure} the driver maps to schema_rejected
// with NO partial commit.
import { ok, err, planId, actionId } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  KnowledgeMutationPlan,
  ProposedAction,
  ExternalWriteEnvelope,
  SourceRef,
  TargetSystem,
  ProvenanceOrigin,
} from "@sow/contracts";
import { buildIdempotencyKey, buildCanonicalObjectKey, TBD } from "@sow/domain";
import type { ExtractionField } from "@sow/domain";
import type {
  BuildOutputsPort,
  BuildOutputsFailure,
  MeetingBuiltOutputs,
  MeetingExternalActionInput,
  ValidatedExtraction,
} from "../ports/meetingCloseout";
import { meetingNotePath } from "./projections/noteSlug";
import type { ProjectNoteMutation } from "./deterministicProgress";
import type { NoteExistsReader } from "../ports/projectSync";

/** The meeting field-name convention key the note filename anchors on (must match the projection's TITLE_FIELD). */
const MEETING_TITLE_FIELD = "title";

/**
 * A deterministic descriptor for ONE external action the deriver wants to propose,
 * mapped from the validated extraction. The activity turns each descriptor into a
 * real {@link ProposedAction} + {@link ExternalWriteEnvelope} pair, computing the
 * canonicalObjectKey (pre-write existence check) and idempotencyKey (replay dedupe)
 * via the §8 key builders — so the descriptor carries the logical IDENTITY, never
 * the raw keys. The identity maps are pure caller-controlled labels → values; the
 * keys are derived here (node:crypto), keeping the driver pure.
 */
export interface DerivedActionDescriptor {
  readonly targetSystem: TargetSystem;
  /** Logical object identity (→ canonicalObjectKey; the pre-write existence key). */
  readonly canonicalIdentity: Record<string, string>;
  /** Logical operation identity (→ idempotencyKey; the replay-dedupe key). */
  readonly operation: string;
  readonly idempotencyIdentity: Record<string, string>;
  readonly payload: Record<string, unknown>;
  readonly approvalPolicy: string;
  /** A deterministic payload digest (the envelope's arch_gap-open payloadHash). */
  readonly payloadHash: string;
  /** The envelope's arch_gap-open preconditions list. */
  readonly preconditions: readonly string[];
}

/**
 * The pure projection the activity is configured with. It maps a
 * {@link ValidatedExtraction} + the bound workspaceId onto the meeting-note create
 * + the external-action descriptors. It is PURE (no clock / I/O) and MUST return an
 * error rather than guess when it cannot project the field set (fail-closed). It
 * receives ONLY the validated fields, so it can never surface an inferred value.
 */
export interface OutputsProjection {
  project(
    validated: ValidatedExtraction,
    workspaceId: WorkspaceId,
    /** §9 create-vs-patch: true ⇒ the meeting note already exists ⇒ emit a region NotePatch (re-close); false
     *  ⇒ a full NoteCreate (first close). Supplied by the build activity from a WS-8-scoped
     *  {@link NoteExistsReader} probe of the SAME meetingNotePath. */
    noteExists: boolean,
  ): Result<
    {
      readonly mutation: ProjectNoteMutation;
      readonly actions: readonly DerivedActionDescriptor[];
    },
    BuildOutputsFailure
  >;
}

/**
 * Injected deps for the buildOutputs activity: the pure {@link OutputsProjection},
 * the SourceRef the derived plan cites (REQ-F-006: ≥1 sourceRef — the evidence the
 * closeout was built from), and the plan-identity seed (→ a stable planId, so the
 * derived plan's idempotent-replay key is deterministic across restarts — inv-5).
 * `provenanceOrigin` classifies the plan for the §6 machine (defaults meeting_close).
 */
export interface BuildOutputsActivityDeps {
  readonly projection: OutputsProjection;
  readonly sourceRef: SourceRef;
  /** Identity for the plan's stable id (hashed with the workspace to bind them). */
  readonly planIdentity: Record<string, string>;
  readonly provenanceOrigin?: ProvenanceOrigin;
  readonly confidence?: number;
  /**
   * §9 create-vs-patch: a WS-8-scoped note-exists probe. The activity derives the meeting-note path via the
   * SINGLE `meetingNotePath` authority, probes it, and threads the boolean into the projection so a re-close
   * region-PATCHes (preserving human scaffold) instead of overwriting via a NoteCreate. A probe FAILURE fails the
   * build CLOSED (build_failed, NO commit) — never a guessed create-vs-patch under uncertainty.
   */
  readonly noteExists: NoteExistsReader;
}

/** True IFF a validated field carries a concrete (non-TBD) value worth stamping. */
function isConcrete(field: ExtractionField<unknown> | undefined): boolean {
  return field !== undefined && field.value !== TBD;
}

/**
 * Project a validated field into a frontmatter-safe scalar. Only ever called for
 * fields that already PASSED the no-inference gate, so the value is either
 * evidence-backed or the TBD sentinel. A TBD field is emitted as the TBD sentinel
 * (REQ-F-017: unstated → TBD, never invented). Exposed so a projection can reuse
 * the exact frontmatter treatment.
 */
export function frontmatterValue(field: ExtractionField<unknown> | undefined): unknown {
  if (field === undefined) return TBD;
  return field.value;
}

/** Re-export so projections can test whether a field is concrete before mapping. */
export { isConcrete };

/**
 * Build a {@link BuildOutputsPort} that DERIVES the plan + external actions from the
 * validated extraction (never accepts them from the caller). The plan's workspaceId
 * is stamped from the PASSED workspaceId (WS-2/WS-4); its frontmatter carries only
 * validated (evidence-backed / TBD) field values (inv-3 / REQ-F-017). External
 * actions get their canonicalObjectKey + idempotencyKey computed via the §8 key
 * builders so the driver's idempotent replay holds (inv-5). Never throws.
 */
export function createBuildOutputsActivity(
  deps: BuildOutputsActivityDeps,
): BuildOutputsPort {
  return {
    async build(
      validated: ValidatedExtraction,
      workspaceId: WorkspaceId,
    ): Promise<Result<MeetingBuiltOutputs, BuildOutputsFailure>> {
      // §9 create-vs-patch — derive the meeting-note path via the SINGLE `meetingNotePath` authority (from the
      // SAME concrete title the projection anchors on, so the probe + committed mutation can never diverge) and
      // probe whether the canonical note already exists. The probe path is workspace-rooted (inherently WS-8).
      // A non-concrete title / empty slug ⇒ null ⇒ SKIP the probe: the projection returns the precise
      // unmappable_extraction. A probe ERROR fails the build CLOSED (build_failed, NO commit) — never a guessed
      // create-vs-patch under uncertainty (a wrong NoteCreate clobbers an existing note; a wrong NotePatch writes
      // a markers-only file to a missing one).
      const titleField = validated.fields[MEETING_TITLE_FIELD];
      const notePath = isConcrete(titleField)
        ? meetingNotePath(workspaceId, String(frontmatterValue(titleField)))
        : null;
      let noteExists = false;
      if (notePath !== null) {
        const existsRes = await deps.noteExists.exists(notePath);
        if (!existsRes.ok) {
          return err({
            code: "build_failed",
            message: `meeting note-exists probe failed (fail-closed): ${existsRes.error.code}`,
          });
        }
        noteExists = existsRes.value;
      }

      const projected = deps.projection.project(validated, workspaceId, noteExists);
      if (!projected.ok) {
        return err(projected.error);
      }
      const mutation = projected.value.mutation;

      // Stable planId: derived from the injected identity BOUND to the passed
      // workspace, so the same closeout replays to the same plan id (inv-5) and a
      // different workspace can never share the id.
      const planKey = buildIdempotencyKey({
        operation: "meeting.close.plan",
        identity: { ...deps.planIdentity, workspace: String(workspaceId) },
      });

      // 18.7 — derive the external actions FIRST (from the projection's per-action-item descriptors, the
      // flagship "propose tasks" producer) so the KMP can MIRROR them into `externalActionProposals`. The
      // keys are computed via the §8 builders (traversal-safe by construction). Empty when the projection
      // derives none (fail-closed on missing/TBD owner or title) ⇒ byte-equivalent to pre-18.7.
      const actions: MeetingExternalActionInput[] = projected.value.actions.map(
        (d): MeetingExternalActionInput => {
          const canonicalObjectKey = buildCanonicalObjectKey({
            targetSystem: d.targetSystem,
            identity: d.canonicalIdentity,
          });
          const idempotencyKey = buildIdempotencyKey({
            operation: d.operation,
            identity: d.idempotencyIdentity,
          });
          const act: ProposedAction = {
            actionId: actionId(idempotencyKey),
            targetSystem: d.targetSystem,
            canonicalObjectKey,
            payload: d.payload,
            approvalPolicy: d.approvalPolicy,
            idempotencyKey,
          };
          const envelope: ExternalWriteEnvelope = {
            actionId: act.actionId,
            targetSystem: d.targetSystem,
            canonicalObjectKey,
            idempotencyKey,
            preconditions: [...d.preconditions],
            payloadHash: d.payloadHash,
          };
          return { action: act, envelope };
        },
      );

      const plan: KnowledgeMutationPlan = {
        planId: planId(planKey),
        // WS-2/WS-4: the write targets the CORRELATION-BOUND workspace, not any
        // caller-controlled value — stamped by construction.
        workspaceId,
        // REQ-F-006: the derived plan cites the evidence it was built from.
        sourceRefs: [deps.sourceRef],
        // §9 create-vs-patch: first close → a full NoteCreate; re-close → a region NotePatch (never both).
        creates: mutation.kind === "create" ? [mutation.note] : [],
        patches: mutation.kind === "patch" ? [mutation.patch] : [],
        linkMutations: [],
        frontmatterUpdates: [],
        // 18.7 — the KMP records the SAME PENDING external actions the driver proposes (empty when none
        // derived ⇒ byte-equivalent). The candidate-data gate validates each action's external-write keys.
        externalActionProposals: actions.map((a) => a.action),
        confidence: deps.confidence ?? 1,
        requiresApproval: false,
        provenanceOrigin: deps.provenanceOrigin ?? "meeting_close",
      };

      const outputs: MeetingBuiltOutputs = { plan, actions };
      return ok(outputs);
    },
  };
}
