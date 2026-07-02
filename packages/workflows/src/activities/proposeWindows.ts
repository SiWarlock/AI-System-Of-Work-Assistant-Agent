// @sow/workflows — slice 7.12 ACTIVITY: DERIVE the scheduling outputs (the §8
// calendar-event ProposedAction + its ExternalWriteEnvelope + an OPTIONAL
// KnowledgeMutationPlan noting the decision) FROM the VALIDATED proposal (inv-4
// governance seam — closes the no-inference / workspace-isolation / Flow-3 leakage
// bypass).
//
// This is an ACTIVITY, NOT workflow code — it runs worker-side and MAY use
// node:crypto (via @sow/domain `buildIdempotencyKey` / `buildCanonicalObjectKey`) to
// compute the envelope keys that drive the driver's idempotent replay (inv-5). It
// implements {@link BuildSchedulingOutputsPort}.
//
// WHY THIS EXISTS (the 7.6 lesson applied): the pipeline must NEVER commit / dispatch
// a caller-supplied action. By DERIVING the calendar action HERE, from the
// ValidatedProposal + the organizer's BOUND workspaceId:
//   • an inferred value can NEVER reach the action — it was hard-rejected at validate,
//     so it is not in `validated.fields`; only evidence-backed / chosen-window data is
//     projected (inv-3 / REQ-F-017);
//   • the action targets the BOUND workspace (`plan.workspaceId` + the action's
//     workspace identity are stamped from the PASSED workspaceId), so a caller cannot
//     redirect the durable write to another workspace (WS-2/WS-4);
//   • the action payload carries ONLY the chosen window + a GENERIC explanation —
//     never raw cross-workspace event detail (Flow 3 leakage rule). The activity runs
//     the KEY-NAME-INDEPENDENT raw-content detector over the ACTUALLY-DISPATCHED
//     `action.payload` (the object that reaches the Tool Gateway) and fail-closed
//     rejects anything raw-content-shaped; the short-single-line check on the
//     `genericExplanation` descriptor field is a secondary backstop only.
//
// §16: returns a typed Result — never throws. A derivation the mapper cannot project
// folds to a typed {@link BuildSchedulingFailure} the driver maps to schema_rejected
// with NO side effect.
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
  BuildSchedulingOutputsPort,
  BuildSchedulingFailure,
  SchedulingBuiltOutputs,
  ValidatedProposal,
  ProposedWindow,
} from "../ports/crossCalendarScheduling";

/** The generic-explanation length cap (mirrors the GCL projection summary cap). A
 * longer or multi-line string is treated as potential raw content and rejected. */
const MAX_GENERIC_EXPLANATION_LEN = 1024;

/**
 * True IFF a string is a SAFE generic explanation: short + single-line. A multi-line
 * or over-length string is raw-content-shaped (a leaked title/body) and must NOT ride
 * a cross-workspace proposal (Flow 3 / mirrors the GCL projection leakage gate).
 */
export function isGenericExplanation(s: string | undefined): boolean {
  if (s === undefined) return true;
  return s.length <= MAX_GENERIC_EXPLANATION_LEN && !/[\r\n]/.test(s);
}

/**
 * Key names that name a raw-content-shaped slot (a verbatim workspace title/body/etc.)
 * regardless of the value shape — mirrors the GCL projection gate's `RAW_CONTENT_SHAPED_KEYS`.
 * The gate is primarily VALUE-shape based (below); this catches an emptied/short raw slot
 * whose KEY still declares raw intent.
 */
const RAW_CONTENT_SHAPED_KEYS: ReadonlySet<string> = new Set([
  "body",
  "content",
  "rawcontent",
  "raw",
  "transcript",
  "notebody",
]);

/**
 * KEY-NAME-INDEPENDENT recursive raw-content shape detector — the SAME check the
 * Phase-4 GCL projection gate uses (`isRawContentShaped`): a value is raw-content-shaped
 * if its KEY names a raw slot, OR (recursively, through objects + arrays) any string
 * value is multi-line OR exceeds the summary length cap. This is intentionally
 * independent of key name for the string-value case so a leaked title/body under ANY
 * key (`conflictDetail`, `title`, `summary`, …) is caught. Fail-closed backstop for the
 * Flow-3 leakage rule over the ACTUALLY-DISPATCHED payload.
 */
export function isRawContentShaped(value: unknown, key?: string): boolean {
  if (key !== undefined && RAW_CONTENT_SHAPED_KEYS.has(key.toLowerCase())) return true;
  if (typeof value === "string") {
    return value.length > MAX_GENERIC_EXPLANATION_LEN || /[\r\n]/.test(value);
  }
  if (Array.isArray(value)) return value.some((v) => isRawContentShaped(v));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) =>
      isRawContentShaped(v, k),
    );
  }
  return false;
}

/**
 * True IFF the dispatched payload carries ANY raw-content-shaped value/key. The
 * LOAD-BEARING Flow-3 leakage check: it runs over the payload that actually reaches the
 * Tool Gateway, never the decoy descriptor field.
 */
export function payloadCarriesRawContent(payload: Record<string, unknown>): boolean {
  return Object.entries(payload).some(([k, v]) => isRawContentShaped(v, k));
}

/**
 * A deterministic descriptor for the ONE calendar action the deriver wants to propose,
 * mapped from the validated proposal. The activity turns this into a real
 * {@link ProposedAction} + {@link ExternalWriteEnvelope} pair, computing the
 * canonicalObjectKey (pre-write existence check) + idempotencyKey (replay dedupe) via
 * the §8 key builders — so the descriptor carries the logical IDENTITY, never the raw
 * keys (which are derived here, node:crypto, keeping the driver pure).
 */
export interface DerivedCalendarAction {
  /** Always `calendar` for this workflow — the only auto-create-eligible surface. */
  readonly targetSystem: TargetSystem;
  /** Logical object identity (→ canonicalObjectKey; the pre-write existence key). */
  readonly canonicalIdentity: Record<string, string>;
  /** Logical operation identity (→ idempotencyKey; the replay-dedupe key). */
  readonly operation: string;
  readonly idempotencyIdentity: Record<string, string>;
  /** The event payload — the chosen window + a GENERIC explanation ONLY (Flow 3). */
  readonly payload: Record<string, unknown>;
  /** The approvalPolicy token the classify step reads (`auto_private` for private). */
  readonly approvalPolicy: string;
  /** A deterministic payload digest (the envelope's payloadHash). */
  readonly payloadHash: string;
  /** The envelope's preconditions list. */
  readonly preconditions: readonly string[];
  /** The chosen window's generic explanation (asserted single-line + short). */
  readonly genericExplanation?: string;
}

/**
 * The pure projection the activity is configured with. It maps a
 * {@link ValidatedProposal} + the bound workspaceId onto the chosen calendar action
 * descriptor + an OPTIONAL decision-note create. It is PURE (no clock / I/O) and MUST
 * return an error rather than guess when it cannot project the proposal (fail-closed).
 * It receives ONLY the validated fields + windows, so it can never surface an inferred
 * value.
 */
export interface SchedulingProjection {
  project(
    validated: ValidatedProposal,
    workspaceId: WorkspaceId,
  ): Result<
    {
      readonly action: DerivedCalendarAction;
      readonly note?: NoteCreate;
    },
    BuildSchedulingFailure
  >;
}

/**
 * Injected deps for the proposeWindows activity: the pure {@link SchedulingProjection},
 * the SourceRef the derived plan cites (REQ-F-006: ≥1 sourceRef), the plan-identity
 * seed (→ a stable planId), and the provenance origin (defaults ingestion).
 */
export interface ProposeWindowsActivityDeps {
  readonly projection: SchedulingProjection;
  readonly sourceRef: SourceRef;
  readonly planIdentity: Record<string, string>;
  readonly provenanceOrigin?: ProvenanceOrigin;
  readonly confidence?: number;
}

/** True IFF a proposed window is well-formed (has an interval to schedule). */
export function isProposableWindow(w: ProposedWindow | undefined): boolean {
  return (
    w !== undefined &&
    typeof w.start === "string" &&
    w.start !== "" &&
    typeof w.end === "string" &&
    w.end !== ""
  );
}

/**
 * Build a {@link BuildSchedulingOutputsPort} that DERIVES the calendar action +
 * envelope (+ optional plan) from the validated proposal (never accepts them from the
 * caller). The action targets the PASSED workspaceId (WS-2/WS-4); its payload carries
 * only the chosen window + a GENERIC explanation (Flow 3). The envelope gets its
 * canonicalObjectKey + idempotencyKey computed via the §8 key builders so the driver's
 * idempotent replay holds (inv-5). Never throws — a raw-content-shaped explanation or
 * an unmappable proposal folds to a typed failure.
 */
export function createProposeWindowsActivity(
  deps: ProposeWindowsActivityDeps,
): BuildSchedulingOutputsPort {
  return {
    build(
      validated: ValidatedProposal,
      organizerWorkspaceId: WorkspaceId,
    ): Promise<Result<SchedulingBuiltOutputs, BuildSchedulingFailure>> {
      const projected = deps.projection.project(validated, organizerWorkspaceId);
      if (!projected.ok) {
        return Promise.resolve(err(projected.error));
      }
      const d = projected.value.action;

      // Flow-3 leakage guard (fail-closed) — BACKSTOP on the descriptor field: the
      // derived generic explanation MUST be a short, single-line generic string.
      if (!isGenericExplanation(d.genericExplanation)) {
        return Promise.resolve(
          err({
            code: "build_failed" as const,
            message:
              "derived conflict explanation is raw-content-shaped (multi-line / over-length) — refused (Flow 3 leakage)",
          }),
        );
      }

      // Flow-3 leakage guard (fail-closed) — LOAD-BEARING on the ACTUALLY-DISPATCHED
      // payload: the object that rides the Tool Gateway onto the external calendar event
      // is `action.payload = d.payload`, NOT the `genericExplanation` descriptor field.
      // A guard that only inspects the descriptor is the 7.6 bug class (protective-looking
      // but not on the real egress path). Run the KEY-NAME-INDEPENDENT recursive
      // raw-content detector over the dispatched payload; raw-content-shaped → refuse,
      // never dispatch (driver folds `build_failed` → schema_rejected, NO side effect).
      if (payloadCarriesRawContent(d.payload)) {
        return Promise.resolve(
          err({
            code: "build_failed" as const,
            message:
              "dispatched calendar payload carries raw-content-shaped value (multi-line / over-length / raw-content-shaped key) — refused (Flow 3 leakage)",
          }),
        );
      }

      const canonicalObjectKey = buildCanonicalObjectKey({
        targetSystem: d.targetSystem,
        identity: d.canonicalIdentity,
      });
      const idempotencyKey = buildIdempotencyKey({
        operation: d.operation,
        identity: d.idempotencyIdentity,
      });

      const action: ProposedAction = {
        actionId: actionId(idempotencyKey),
        targetSystem: d.targetSystem,
        canonicalObjectKey,
        payload: d.payload,
        approvalPolicy: d.approvalPolicy,
        idempotencyKey,
      };
      const envelope: ExternalWriteEnvelope = {
        actionId: action.actionId,
        targetSystem: d.targetSystem,
        canonicalObjectKey,
        idempotencyKey,
        preconditions: [...d.preconditions],
        payloadHash: d.payloadHash,
      };

      // OPTIONAL decision note, stamped to the BOUND workspace (WS-2/WS-4).
      let plan: KnowledgeMutationPlan | undefined;
      if (projected.value.note !== undefined) {
        const planKey = buildIdempotencyKey({
          operation: "calendar.schedule.plan",
          identity: { ...deps.planIdentity, workspace: String(organizerWorkspaceId) },
        });
        plan = {
          planId: planId(planKey),
          // WS-2/WS-4: the write targets the BOUND workspace, stamped by construction.
          workspaceId: organizerWorkspaceId,
          sourceRefs: [deps.sourceRef],
          creates: [projected.value.note],
          patches: [],
          linkMutations: [],
          frontmatterUpdates: [],
          externalActionProposals: [],
          confidence: deps.confidence ?? 1,
          requiresApproval: false,
          provenanceOrigin: deps.provenanceOrigin ?? "ingestion",
        };
      }

      const outputs: SchedulingBuiltOutputs =
        plan !== undefined ? { action, envelope, plan } : { action, envelope };
      return Promise.resolve(ok(outputs));
    },
  };
}
