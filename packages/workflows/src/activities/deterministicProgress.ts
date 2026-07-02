// @sow/workflows — task 7.13 ACTIVITIES: the DETERMINISTIC progress parser
// (ParseProgressPort) + the DERIVE-FROM-VALIDATED commit deriver
// (BuildSyncOutputsPort).
//
// These are ACTIVITIES, NOT workflow code — they run worker-side and MAY use
// node:crypto (via @sow/domain `buildIdempotencyKey` / `buildCanonicalObjectKey`) to
// compute the plan + envelope keys that drive the driver's idempotent replay
// (inv-5). They are tested with injected pure functions (no real connector / DB).
//
// ★★ THE DETERMINISTIC-PROGRESS INVARIANT (REQ-F-011 / PRJ-3/4) is the whole point
// of this file:
//   • `createDeterministicProgressActivity` counts checkboxes/status DETERMINISTICALLY
//     (a pure function over the raw plan/provider text) and computes percentComplete
//     as an integer function of the counts — NO model is involved. It fails closed
//     (typed error, no guessed number) on a parse failure / stale connector /
//     ambiguous status.
//   • `createBuildSyncOutputsActivity` DERIVES the committed plan's numeric progress
//     from the DETERMINISTIC {@link DeterministicProgress} it is passed — NEVER from
//     the (validated) narrative. Even if the narrative carried a "percent" field, the
//     deriver ignores it: the committed number is `progress.percentComplete`. The
//     prose comes from the validated narrative; `plan.workspaceId` is stamped from the
//     PASSED (registry-bound) workspaceId (WS-2/WS-4).
//
// §16: both return a typed Result — never throw. A derivation the mapper cannot
// project folds to a typed {@link BuildSyncOutputsFailure} the driver maps to
// schema_rejected with NO partial commit.
import { ok, err, planId, actionId } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  KnowledgeMutationPlan,
  ProposedAction,
  ExternalWriteEnvelope,
  SourceRef,
  NoteCreate,
  TargetSystem,
  ProvenanceOrigin,
} from "@sow/contracts";
import { buildIdempotencyKey, buildCanonicalObjectKey } from "@sow/domain";
import type {
  ParseProgressPort,
  ParseProgressError,
  DeterministicProgress,
  ProgressProviderCount,
  ProjectSyncContext,
  BuildSyncOutputsPort,
  BuildSyncOutputsFailure,
  ProjectSyncOutputs,
  ProjectSyncExternalAction,
  ValidatedNarrative,
} from "../ports/projectSync";

// ===========================================================================
// (A) The DETERMINISTIC progress parser
// ===========================================================================

/**
 * One raw status source the deterministic parser reads. `source` is 'plan' for the
 * IMPLEMENTATION_PLAN doc or a connectorId for an external PM provider; `text` is
 * the raw checkbox/status content the parser counts DETERMINISTICALLY. `stale` marks
 * a source whose connector cursor is stale beyond the freshness bound (LIFE-2) — the
 * parser fails closed rather than count stale status.
 */
export interface RawProgressSource {
  readonly source: string;
  readonly text: string;
  readonly stale?: boolean;
}

/**
 * The injected raw-source reader for the deterministic parser. It gathers the raw
 * plan/provider status text for a project (real impl: reads the plan file + the
 * Connector Gateway read models) and returns a typed error rather than guess when a
 * source is unreadable/stale. It is PURE from the activity's perspective (all I/O is
 * behind it), so the parser's counting logic stays deterministic + unit-testable.
 */
export interface RawProgressReader {
  read(
    ctx: ProjectSyncContext,
  ): Promise<Result<readonly RawProgressSource[], ParseProgressError>>;
}

/**
 * A single deterministic checkbox tally: `[x]`/`[X]` (any case) → completed; `[ ]` →
 * open; a marker that is neither open nor closed (e.g. `[?]`, `[-]`, `[/]`) is
 * AMBIGUOUS — the parser refuses to guess (PRJ-4). Exported so a test can pin the
 * exact counting contract independent of the port.
 */
export interface CheckboxTally {
  readonly completed: number;
  readonly total: number;
  /** True IFF at least one ambiguous marker was seen (the parser fails closed). */
  readonly ambiguous: boolean;
}

// A GitHub-flavored-markdown task-list checkbox: leading list bullet, then `[<c>]`.
const CHECKBOX_RE = /^[ \t]*[-*+][ \t]+\[(.)\][ \t]+/gm;

/**
 * DETERMINISTICALLY count checkboxes in raw markdown/status text (REQ-F-011). A
 * completed box is `[x]` or `[X]`; an open box is `[ ]`; anything else inside the
 * brackets is an AMBIGUOUS status marker (the tally flags it so the caller fails
 * closed — PRJ-4). PURE — no clock/network/random; identical input ⇒ identical tally.
 */
export function countCheckboxes(text: string): CheckboxTally {
  let completed = 0;
  let total = 0;
  let ambiguous = false;
  // Reset lastIndex (the regex is /g and module-scoped) so calls are independent.
  CHECKBOX_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHECKBOX_RE.exec(text)) !== null) {
    const mark = m[1];
    if (mark === "x" || mark === "X") {
      completed += 1;
      total += 1;
    } else if (mark === " ") {
      total += 1;
    } else {
      // A non-empty, non-x marker (e.g. `[?]`, `[-]`, `[/]`): ambiguous status.
      ambiguous = true;
    }
  }
  return { completed, total, ambiguous };
}

/**
 * Compute the integer percent-complete from counts. A pure function of the counts —
 * NEVER synthesized. Returns 0 when `total === 0` (an empty project is 0%, not NaN),
 * and rounds to the nearest integer ∈ [0,100].
 */
export function computePercent(completed: number, total: number): number {
  if (total <= 0) return 0;
  const pct = Math.round((completed / total) * 100);
  return Math.max(0, Math.min(100, pct));
}

/** Deps for the deterministic-progress activity: just the injected raw-source reader. */
export interface DeterministicProgressActivityDeps {
  readonly reader: RawProgressReader;
}

/**
 * Build a {@link ParseProgressPort} that parses the DETERMINISTIC progress of a
 * project from its raw plan/provider status (REQ-F-011 / PRJ-3/4). This is the SOLE
 * producer of the numeric progress — no model is involved:
 *   • a stale source → `connector_stale` (fail-closed, no stale count);
 *   • an ambiguous status marker → `ambiguous_status` (refuses to guess — PRJ-4);
 *   • otherwise it counts checkboxes deterministically and computes the integer
 *     percent from the counts.
 * Never throws.
 */
export function createDeterministicProgressActivity(
  deps: DeterministicProgressActivityDeps,
): ParseProgressPort {
  return {
    async parse(
      ctx: ProjectSyncContext,
    ): Promise<Result<DeterministicProgress, ParseProgressError>> {
      const read = await deps.reader.read(ctx);
      if (!read.ok) return err(read.error);

      const sources = read.value;
      // A stale source is a hard fail — do not count stale status (LIFE-2).
      const staleSource = sources.find((s) => s.stale === true);
      if (staleSource !== undefined) {
        return err({
          code: "connector_stale",
          message: `progress source stale: ${staleSource.source}`,
        });
      }

      const perProvider: ProgressProviderCount[] = [];
      let completedCount = 0;
      let totalCount = 0;
      for (const src of sources) {
        const tally = countCheckboxes(src.text);
        if (tally.ambiguous) {
          // Refuse to guess an ambiguous status (PRJ-4) — fail closed.
          return err({
            code: "ambiguous_status",
            message: `ambiguous status marker in source: ${src.source}`,
          });
        }
        perProvider.push({
          source: src.source,
          completedCount: tally.completed,
          totalCount: tally.total,
        });
        completedCount += tally.completed;
        totalCount += tally.total;
      }

      const progress: DeterministicProgress = {
        completedCount,
        totalCount,
        percentComplete: computePercent(completedCount, totalCount),
        perProvider,
      };
      return ok(progress);
    },
  };
}

// ===========================================================================
// (B) The DERIVE-FROM-VALIDATED commit deriver
// ===========================================================================

/**
 * A deterministic descriptor for ONE external action the deriver wants to propose
 * (e.g. a Telegram status ping), mapped from the validated narrative + facts. The
 * activity turns each descriptor into a real {@link ProposedAction} +
 * {@link ExternalWriteEnvelope} pair, computing the canonicalObjectKey + idempotencyKey
 * via the §8 key builders — so the descriptor carries the logical IDENTITY, never the
 * raw keys (which are derived here via node:crypto, keeping the driver pure).
 */
export interface DerivedSyncActionDescriptor {
  readonly targetSystem: TargetSystem;
  readonly canonicalIdentity: Record<string, string>;
  readonly operation: string;
  readonly idempotencyIdentity: Record<string, string>;
  readonly payload: Record<string, unknown>;
  readonly approvalPolicy: string;
  readonly payloadHash: string;
  readonly preconditions: readonly string[];
}

/**
 * The pure projection the deriver is configured with. It maps a
 * {@link ValidatedNarrative} + the DETERMINISTIC facts + the bound workspaceId onto
 * the project-status note create + the dashboard payload + the external-action
 * descriptors. It is PURE (no clock/I/O) and MUST return an error rather than guess
 * when it cannot project (fail-closed).
 *
 * ★ CRITICAL (REQ-F-011): the projection is handed the DETERMINISTIC `progress` as
 * the numeric source. The committed number MUST come from `progress`, not from the
 * narrative fields — a conforming projection reads `progress.percentComplete` for the
 * number and only ever reads PROSE off `validated.fields`.
 */
export interface SyncOutputsProjection {
  project(
    validated: ValidatedNarrative,
    progress: DeterministicProgress,
    workspaceId: WorkspaceId,
  ): Result<
    {
      readonly note: NoteCreate;
      readonly dashboard: Record<string, unknown>;
      readonly actions: readonly DerivedSyncActionDescriptor[];
    },
    BuildSyncOutputsFailure
  >;
}

/**
 * Injected deps for the buildSyncOutputs activity: the pure {@link SyncOutputsProjection},
 * the SourceRef the derived plan cites (REQ-F-006: ≥1 sourceRef — the evidence the
 * status was built from), and the plan-identity seed (→ a stable planId, so the
 * derived plan's idempotent-replay key is deterministic across restarts — inv-5).
 * `provenanceOrigin` classifies the plan for the §6 machine (defaults `ingestion`,
 * since project-sync status is derived from ingested/parsed plan facts — arch_gap:
 * ProvenanceOrigin has no dedicated `project_sync` member).
 */
export interface BuildSyncOutputsActivityDeps {
  readonly projection: SyncOutputsProjection;
  readonly sourceRef: SourceRef;
  readonly planIdentity: Record<string, string>;
  readonly provenanceOrigin?: ProvenanceOrigin;
}

/**
 * Build a {@link BuildSyncOutputsPort} that DERIVES the plan + dashboard + external
 * actions from the validated narrative + the DETERMINISTIC facts (never accepts them
 * from the caller). The plan's workspaceId is stamped from the PASSED workspaceId
 * (WS-2/WS-4); its committed numeric progress comes from the DETERMINISTIC facts
 * (REQ-F-011). External actions get their keys computed via the §8 key builders so
 * the driver's idempotent replay holds (inv-5). Never throws.
 */
export function createBuildSyncOutputsActivity(
  deps: BuildSyncOutputsActivityDeps,
): BuildSyncOutputsPort {
  return {
    build(
      validated: ValidatedNarrative,
      progress: DeterministicProgress,
      workspaceId: WorkspaceId,
    ): Promise<Result<ProjectSyncOutputs, BuildSyncOutputsFailure>> {
      const projected = deps.projection.project(validated, progress, workspaceId);
      if (!projected.ok) {
        return Promise.resolve(err(projected.error));
      }

      // Stable planId: derived from the injected identity BOUND to the passed
      // workspace, so the same sync replays to the same plan id (inv-5) and a
      // different workspace can never share the id.
      const planKey = buildIdempotencyKey({
        operation: "project.sync.plan",
        identity: { ...deps.planIdentity, workspace: String(workspaceId) },
      });

      const plan: KnowledgeMutationPlan = {
        planId: planId(planKey),
        // WS-2/WS-4: the write targets the REGISTRY-BOUND workspace, stamped by
        // construction — not any caller-controlled value.
        workspaceId,
        // REQ-F-006: the derived plan cites the evidence it was built from.
        sourceRefs: [deps.sourceRef],
        creates: [projected.value.note],
        patches: [],
        linkMutations: [],
        frontmatterUpdates: [],
        externalActionProposals: [],
        // Plan-level confidence is 1: the numeric progress is a DETERMINISTIC fact,
        // not a model estimate (REQ-F-011).
        confidence: 1,
        requiresApproval: false,
        provenanceOrigin: deps.provenanceOrigin ?? "ingestion",
      };

      const actions: ProjectSyncExternalAction[] = projected.value.actions.map(
        (d): ProjectSyncExternalAction => {
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

      const outputs: ProjectSyncOutputs = {
        plan,
        dashboard: projected.value.dashboard,
        actions,
      };
      return Promise.resolve(ok(outputs));
    },
  };
}
