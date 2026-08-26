// @sow/integrations — 13.9 NotebookLM grounding adapter (upload → synthesize →
// force-delete), dormant behind the Tool-Gateway envelope.
//
// OPPOSITE direction of 6.6 notebooklm.sync (notebooklm-sync.ts pushes
// vault-derived Markdown OUT to Drive). This module uploads a WORKSPACE-SCOPED
// note set into an ephemeral NotebookLM store THROUGH the Tool Gateway
// (dispatchExternalWrite — safety rule 3: the same idempotencyKey /
// canonicalObjectKey / receipt-reuse envelope as every other external write,
// so a replay REUSES the receipt instead of a second upload), asks the
// injected transport a grounding question against that store, and
// FORCE-DELETES the ephemeral store on BOTH the success and the failure path
// (a leaked ephemeral store is the whole reason this hop exists).
//
// KnowledgeWriter is the ONLY autonomous writer of canonical Markdown (safety
// rule 1). The synthesis this module returns is CANDIDATE DATA ONLY (safety
// rule 2) — this module imports nothing from @sow/knowledge and calls no
// writer; the caller is responsible for routing the candidate through the
// JSON-Schema gate + validator before it ever reaches KnowledgeWriter.
//
// EGRESS (safety rule 5): the REAL `@sow/policy` `egressVeto` is run over a
// synthetic cloud-classed NotebookLM route (mirrors
// `free-source-aggregator.ts`'s self-run pattern) BEFORE any transport or
// dispatch call. A DENY fails closed — zero transport calls, zero
// dispatchExternalWrite calls, no cloud fallback, no retry.
//
// WORKSPACE ISOLATION (safety rule 4 / WS-8): the upload set is built ONLY
// from notes whose `workspaceId` matches the grounding request's
// `workspaceId`; a note from any other workspace never reaches the upload
// payload, the transport, or the dispatch.
//
// NOTHING ARMS: no API key, no network client, no default that could reach a
// real Gemini/NotebookLM endpoint. `transport` is fully injected; the real
// egress bind is the owner's arming crossing (out of scope here). No
// production caller constructs this port (pinned by the test's source scan).
//
// ADD NO NEW CONTRACT: the envelope's `targetSystem` is read off the injected
// `gateway.adapter.targetSystem` — the same closed `TargetSystem` the caller's
// bound Tool-Gateway adapter already declares — rather than inventing a new
// enum member for NotebookLM.
//
// §16: `ground` returns a typed Result; nothing throws across the boundary.
// Every fault message is a FIXED safe literal (rule 7) — never note content,
// question text, or a credential.
import { ok, err, actionId } from "@sow/contracts";
import type { ProposedAction, ProviderRoute, Result } from "@sow/contracts";
import { buildCanonicalObjectKey, buildIdempotencyKey } from "@sow/domain";
import { egressVeto, isDeny } from "@sow/policy";
import { dispatchExternalWrite, type ExternalWriteDeps } from "../tools/gateway";
import { buildEnvelopeFromAction } from "../tools/envelope";
import type {
  NotebookGroundPort,
  NotebookGroundRequest,
  NotebookGroundCandidate,
  NotebookGroundTransport,
  NotebookGroundError,
  GroundResult,
} from "./notebook-ground-port";

/** The stable operation label the canonicalObjectKey/idempotencyKey identity
 * is built over (mirrors notebooklm-sync.ts's `SYNC_OPERATION` convention). */
const GROUND_OPERATION = "notebooklm.ground" as const;

/**
 * The synthetic route the veto runs over (mirrors `free-source-aggregator.ts`'s
 * `FREE_SOURCE_EGRESS_ROUTE`): `egressClass: "cloud"` classifies it as a
 * distinct EGRESS processor (`processorOfRoute !== null`), which is what makes
 * the employer-work veto FIRE — a non-egress route would fall through to
 * ALLOW (a silent rule-5 fail-open). NotebookLM IS a cloud processor, so this
 * is honest; this module self-runs the veto rather than routing through the
 * broker, so this route is a pure veto INPUT, never dispatched to.
 */
export const NOTEBOOKLM_EGRESS_ROUTE: ProviderRoute = {
  runtime: "notebooklm-ground",
  model: "notebooklm-ground",
  endpoint: "https://notebooklm.egress.example",
  egressClass: "cloud",
};

/**
 * Injected deps (§16 — no real network/clock/randomness in this module).
 * `gateway` — the fully-wired Tool-Gateway `ExternalWriteDeps` (adapter +
 * receipt store + approval verdict + audit/log sinks + clock) the upload
 * dispatches against; its bound `adapter.targetSystem` supplies the envelope's
 * `TargetSystem` (no new contract added here). `transport` — the injected
 * NotebookLM grounding transport (dormant; see notebook-ground-port.ts).
 * `egressVeto` — INJECTABLE only for testing; production uses the REAL
 * `@sow/policy` `egressVeto` (safety rule 5), run over the request's
 * `{job, egress, workspace}` + {@link NOTEBOOKLM_EGRESS_ROUTE}.
 * `approvalPolicy` — the recorded `ProposedAction.approvalPolicy` label.
 * `clock` — injected ISO clock (no direct system-clock read anywhere in src).
 */
export interface NotebookGroundDeps {
  readonly gateway: ExternalWriteDeps;
  readonly transport: NotebookGroundTransport;
  readonly egressVeto?: typeof egressVeto;
  readonly approvalPolicy: string;
  readonly clock: () => string;
}

// Validate the transport's raw synthesis shape. A hostile/pathological
// response (wrong types, missing fields) becomes a typed transport_fault,
// never a thrown/propagated malformed value.
function isWellFormedGroundResult(value: unknown): value is GroundResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.answer === "string" &&
    Array.isArray(v.citations) &&
    v.citations.every((c) => typeof c === "string")
  );
}

// Force-delete the ephemeral store. Never throws (§16); a throwing OR a
// returned-err delete both become the SAME typed `cleanup_failed`, naming the
// residual store — never silently swallowed.
async function forceDeleteStore(
  transport: NotebookGroundTransport,
  storeRef: string,
): Promise<Result<void, NotebookGroundError>> {
  try {
    const deleted = await transport.deleteStore(storeRef);
    if (!deleted.ok) {
      return err({ code: "cleanup_failed", message: "ephemeral store could not be deleted", storeRef });
    }
    return ok(undefined);
  } catch {
    return err({ code: "cleanup_failed", message: "ephemeral store could not be deleted", storeRef });
  }
}

/**
 * Factory: a `NotebookGroundPort` whose `ground` uploads a workspace-scoped
 * note set through the Tool Gateway, asks the injected transport a grounding
 * question, and force-deletes the ephemeral store on every path. Never
 * throws.
 */
export function createNotebookLmGround(deps: NotebookGroundDeps): NotebookGroundPort {
  const veto = deps.egressVeto ?? egressVeto;
  return {
    async ground(
      req: NotebookGroundRequest,
    ): Promise<Result<NotebookGroundCandidate, NotebookGroundError>> {
      // safety rule 4 / WS-8: exclude every note from a workspace other than
      // the one being grounded BEFORE it ever reaches the upload payload.
      const scopedNotes = req.notes.filter((n) => n.workspaceId === req.workspaceId);

      // safety rule 5: the REAL egress veto runs BEFORE any transport or
      // dispatch call, over the request's own {job, egress, workspace} facts
      // and the synthetic cloud-classed NotebookLM route. A DENY fails
      // closed — zero transport calls, zero dispatch calls, no cloud
      // fallback, no retry.
      const decision = veto(req.job, NOTEBOOKLM_EGRESS_ROUTE, req.egress, req.workspace);
      if (isDeny(decision)) {
        return err({ code: "egress_denied", message: "egress not acknowledged for this workspace" });
      }

      const targetSystem = deps.gateway.adapter.targetSystem;
      const identity = { project: req.project, operation: GROUND_OPERATION };
      const canonicalObjectKey = buildCanonicalObjectKey({ targetSystem, identity });
      const idempotencyKey = buildIdempotencyKey({ operation: GROUND_OPERATION, identity });

      const action: ProposedAction = {
        actionId: actionId(`${GROUND_OPERATION}:${req.project}`),
        targetSystem,
        canonicalObjectKey,
        payload: {
          operation: GROUND_OPERATION,
          project: req.project,
          question: req.question,
          notes: scopedNotes,
        },
        approvalPolicy: deps.approvalPolicy,
        idempotencyKey,
      };

      const built = buildEnvelopeFromAction(action, { preconditions: ["exists_check"] });
      if (!built.ok) {
        return err({
          code: "gate_rejected",
          message: "external write envelope was rejected by the candidate gate",
        });
      }

      const dispatched = await dispatchExternalWrite(built.value, action, deps.gateway);
      if (dispatched.status !== "created" && dispatched.status !== "reused") {
        return err({
          code: "dispatch_failed",
          message: "external write dispatch did not create or reuse an upload store",
        });
      }

      const storeRef = dispatched.receipt.externalObjectId;

      // ground — the transport may throw or return a pathological shape;
      // both become a typed transport_fault, and the ephemeral store is
      // STILL force-deleted before returning (never a leaked store on the
      // failure path).
      let raw: unknown;
      try {
        raw = await deps.transport.ground({ storeRef, question: req.question });
      } catch {
        await forceDeleteStore(deps.transport, storeRef);
        return err({ code: "transport_fault", message: "grounding transport failed" });
      }
      if (!isWellFormedGroundResult(raw)) {
        await forceDeleteStore(deps.transport, storeRef);
        return err({ code: "transport_fault", message: "grounding transport returned a malformed result" });
      }

      // success path — the store is STILL force-deleted; a failing/throwing
      // delete here is surfaced as cleanup_failed, never folded into a
      // silent ok (a leaked ephemeral store is the whole reason this hop
      // exists).
      const cleanup = await forceDeleteStore(deps.transport, storeRef);
      if (!cleanup.ok) {
        return cleanup;
      }

      // CANDIDATE DATA ONLY (safety rules 1 + 2). No writer is called; the
      // caller routes this through the schema gate and then KnowledgeWriter.
      return ok({
        kind: "notebooklm_ground_candidate",
        answer: raw.answer,
        citations: raw.citations,
      });
    },
  };
}
