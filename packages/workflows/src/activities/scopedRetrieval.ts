// @sow/workflows — task 7.17 ACTIVITY: SCOPED RETRIEVAL for the COPILOT Q&A read
// path (WS-8 isolation seam — REQ-F-005 / Section 9.13).
//
// This is an ACTIVITY, NOT workflow code — it runs worker-side and MAY use the real
// adapters (@sow/knowledge GBrain read + the GCL Visibility Gate `admitProjection`,
// @sow/policy) and node:crypto. It implements the TWO scope-appropriate retrieval
// ports the copilot-Q&A driver depends on: {@link RetrieveWorkspacePort} (one bound
// brain) and {@link RetrieveGlobalPort} (the GCL Visibility Gate).
//
// ★★ WHY THIS IS THE ISOLATION SEAM (WS-8 / safety rule 4): an owner question is
// answered from EITHER a single workspace's own brain OR the GLOBAL/coordination view
// — and the global view is the SINGLE cross-workspace read path: the GCL Visibility
// Gate. This activity makes that structural:
//   • the workspace retriever queries ONLY the passed workspace's brain — it never
//     touches another workspace's brain and never issues a cross-brain federation
//     query (a direct cross-brain GBrain query is exactly what WS-8 forbids);
//   • the global retriever asks an injected PURE source for candidate cross-workspace
//     context (summary/metadata only) and runs EACH candidate through the injected
//     {@link ScopedProjectionGate} (backed by @sow/knowledge `admitProjection`, which
//     recovers the raw-content-shaped-key refine ajv drops + the §5 visibility
//     ceiling); a candidate carrying raw content is HARD-rejected (gate_denied) and
//     NEVER returned — no downgrade-and-serve. So a raw cross-workspace body can never
//     ride the answer.
//
// The read path has NO write side: this activity reads + gates ONLY. It never
// commits Markdown and never dispatches an external write (those ports do not exist
// on the copilot-Q&A seam at all).
//
// §16: returns a typed Result — never throws. A failed/denied read or a gate
// rejection is a typed error the driver folds to retrieval_denied.
import { ok, err } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  GclProjection,
  SourceRef,
  VisibilityLevel,
} from "@sow/contracts";
import type {
  CopilotQuestion,
  RetrievedEvidence,
  RetrieveWorkspacePort,
  RetrieveWorkspaceError,
  RetrieveGlobalPort,
  RetrieveGlobalError,
} from "../ports/copilotQa";

// ---------------------------------------------------------------------------
// Workspace-scoped retrieval — ONE bound brain (WS-8)
// ---------------------------------------------------------------------------

/**
 * The injected PURE source of workspace-scoped evidence. It reads ONLY the passed
 * workspace's own GBrain and returns the SourceRefs backing the answer. It MUST
 * return a typed error rather than a stale/guessed result when it cannot read
 * (fail-closed) — the driver folds that to retrieval_denied. It is passed the
 * workspaceId explicitly so it can NEVER read a different workspace's brain than the
 * one classification bound.
 */
export interface WorkspaceRetrievalSource {
  read(
    workspaceId: WorkspaceId,
    question: CopilotQuestion,
  ): Promise<Result<readonly SourceRef[], RetrieveWorkspaceError>>;
}

/**
 * Build a {@link RetrieveWorkspacePort} that reads ONLY the passed workspace's brain
 * (WS-8). The returned evidence is `workspace`-scoped and carries the workspaceId it
 * was read from — stamped from the PASSED workspaceId, so the evidence provably
 * belongs to the bound workspace (never a caller-controlled or cross-brain value).
 * Never throws.
 */
export function createRetrieveWorkspaceActivity(
  source: WorkspaceRetrievalSource,
): RetrieveWorkspacePort {
  return {
    async retrieve(
      workspaceId: WorkspaceId,
      question: CopilotQuestion,
    ): Promise<Result<RetrievedEvidence, RetrieveWorkspaceError>> {
      const read = await source.read(workspaceId, question);
      if (!read.ok) {
        return err(read.error);
      }
      const evidence: RetrievedEvidence = {
        scope: "workspace",
        // Stamped from the PASSED (classification-bound) workspaceId — the evidence
        // provably belongs to the bound workspace (WS-8).
        workspaceId,
        sourceRefs: read.value,
      };
      return ok(evidence);
    },
  };
}

// ---------------------------------------------------------------------------
// Global retrieval — THE GCL VISIBILITY GATE (the single cross-workspace path)
// ---------------------------------------------------------------------------

/**
 * A candidate cross-workspace projection the {@link GlobalRetrievalSource} proposes.
 * It is SUMMARY-only by contract intent, but it is still CANDIDATE data until the
 * gate admits it — the source is not trusted to have sanitized correctly, so the gate
 * is the enforcement point (defense in depth), exactly like the 7.10 projection seam.
 */
export interface CandidateGlobalProjection {
  readonly workspaceId: WorkspaceId;
  readonly visibilityLevel: VisibilityLevel;
  readonly projectionType: string;
  readonly sanitizedPayload: Record<string, unknown>;
  readonly sourceRefs: readonly SourceRef[];
}

/**
 * The injected PURE source of candidate cross-workspace projections for a GLOBAL
 * question. It projects the in-scope workspaces' brains into SUMMARY candidates. It
 * MUST return a typed error rather than a stale/guessed projection when it cannot
 * freshly project (fail-closed) — the driver folds that to retrieval_denied. It does
 * NOT issue a direct cross-brain query that returns raw content; the ONLY thing it
 * emits is summary candidates that MUST still pass the gate below.
 */
export interface GlobalRetrievalSource {
  project(
    question: CopilotQuestion,
  ): Promise<Result<readonly CandidateGlobalProjection[], RetrieveGlobalError>>;
}

/** A gate rejection — the projection carried raw content or over-visibility. */
export interface ScopedGateRejection {
  readonly reason: string;
}

/**
 * The injected GCL Visibility Gate seam. In production this wraps @sow/knowledge
 * `admitProjection` (the composed ajv ∘ Zod ∘ §5-visibility gate): a candidate
 * carrying raw content OR exceeding the source's default visibility is HARD-rejected
 * — never downgraded. A rejection is the leakage HARD-reject (safety rule 4).
 */
export interface ScopedProjectionGate {
  admit(candidate: CandidateGlobalProjection): Result<GclProjection, ScopedGateRejection>;
}

/** Injected deps for the global retrieval activity. */
export interface GlobalRetrievalDeps {
  readonly source: GlobalRetrievalSource;
  readonly gate: ScopedProjectionGate;
}

/**
 * Build a {@link RetrieveGlobalPort} that answers a GLOBAL question ONLY through the
 * GCL Visibility Gate (WS-8 / safety rule 4 — the single cross-workspace read path).
 * It derives one summary candidate per in-scope workspace and runs EACH through the
 * gate before returning it; a candidate carrying raw content / over-visibility is a
 * leakage HARD-reject (`gate_denied`) and the WHOLE retrieval fails closed — never a
 * partial set, never a downgrade-and-serve — so a raw cross-workspace body can never
 * ride a global answer. Never throws.
 */
export function createRetrieveGlobalActivity(
  deps: GlobalRetrievalDeps,
): RetrieveGlobalPort {
  return {
    async retrieve(
      question: CopilotQuestion,
    ): Promise<Result<RetrievedEvidence, RetrieveGlobalError>> {
      const candidates = await deps.source.project(question);
      if (!candidates.ok) {
        // Stale / unreadable source — fail-closed (no partial projection set).
        return err(candidates.error);
      }

      const admitted: GclProjection[] = [];
      for (const candidate of candidates.value) {
        const decision = deps.gate.admit(candidate);
        if (!decision.ok) {
          // A candidate carrying raw content / over-visibility is a leakage HARD
          // reject (safety rule 4). Fail the WHOLE retrieval closed — never return a
          // partial set, never downgrade-and-serve.
          const error: RetrieveGlobalError = {
            code: "gate_denied",
            message: `GCL Visibility Gate denied a projection for ${String(
              candidate.workspaceId,
            )}: ${decision.error.reason}`,
          };
          return err(error);
        }
        admitted.push(decision.value);
      }

      const evidence: RetrievedEvidence = { scope: "global", projections: admitted };
      return ok(evidence);
    },
  };
}
