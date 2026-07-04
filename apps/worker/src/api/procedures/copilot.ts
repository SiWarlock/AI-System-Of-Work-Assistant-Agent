// §9.6 A2 — Copilot workspace-scoped knowledge retrieval (the READ half of the Copilot Q&A backend).
//
// Copilot answers a question from a SINGLE workspace's knowledge (§4.6, WS-8): retrieval is
// workspace-scoped and fails CLOSED on an unknown workspace — NEVER a cross-workspace read (the GCL
// Visibility Gate is the ONLY sanctioned cross-brain path, and Copilot does not use it). Retrieval
// returns CANDIDATE context — raw-ish knowledge passages + citable source refs — that stays
// WORKER-SIDE; the governed synthesis (A3) + the procedure's candidate-data gate (A4) turn it into
// the UI-safe `UiSafeCopilotAnswer`, so a raw `block` NEVER crosses to the renderer.
//
// The REAL adapter is GBrain/GCL retrieval (deferred — the app runs over stubs; a passage-serving
// read-model does not exist yet). The fixture-backed retrieval here is the honest interim (like the
// dev-provisioner), wired into `query.copilotAsk` at A4.

import { ok, err, failure, type Result, type FailureVariant } from "@sow/contracts";

/** A port result delivered sync (the in-memory fixture / test fake) or async (the real adapter). */
export type MaybeAsyncResult<T> = Result<T, FailureVariant> | Promise<Result<T, FailureVariant>>;

/** One retrieved source — an opaque canonical ref + a display title (maps to UiSafeCitation at A4). */
export interface RetrievedSource {
  readonly citationId: string;
  readonly title: string;
}

/**
 * Candidate context retrieved for a Copilot question — WORKER-SIDE only. `workspaceId` is the scope
 * it was retrieved FOR (the WS-8 self-check anchor); `blocks` are raw-ish knowledge passages the
 * synthesis reads (NEVER sent to the renderer); `sources` are the citable refs.
 */
export interface RetrievedContext {
  readonly workspaceId: string;
  readonly blocks: readonly string[];
  readonly sources: readonly RetrievedSource[];
}

/** The workspace-scoped Copilot retrieval port. Unknown workspace → typed err (fail-closed). */
export interface CopilotRetrievalPort {
  readonly retrieve: (workspaceId: string, question: string) => MaybeAsyncResult<RetrievedContext>;
}

/** Fail-closed err for a workspace the retrieval source doesn't recognize.
 *  Uses the codebase-wide `WORKSPACE_NOT_FOUND` cause code (readModel.ts / systemHealth) so a
 *  consumer switching on the code catches the Copilot path too. */
function unknownWorkspace(): FailureVariant {
  return failure("validation_rejected", "workspace not found", {
    cause: { code: "WORKSPACE_NOT_FOUND" },
  });
}

/**
 * Defense-in-depth WS-8 guard the procedure (A4) applies to ANY retrieval adapter's output: the
 * returned context MUST be for the workspace we asked about. A mismatch — a buggy or malicious
 * adapter handing back FOREIGN-workspace context — fails CLOSED, so an answer is never synthesized
 * from cross-workspace content. An empty requested scope is never treated as a workspace.
 */
export function enforceRetrievalScope(
  requestedWorkspaceId: string,
  context: RetrievedContext,
): Result<RetrievedContext, FailureVariant> {
  // Narrow `context` defensively BEFORE dereferencing — the threat this guard names is an
  // untyped/malicious adapter, which could hand back null/undefined/non-object. Fail closed with a
  // typed err (§16 no-throw), never a TypeError.
  if (
    requestedWorkspaceId.length === 0 ||
    typeof context !== "object" ||
    context === null ||
    context.workspaceId !== requestedWorkspaceId
  ) {
    return err(
      failure("validation_rejected", "retrieval scope mismatch", {
        cause: { code: "RETRIEVAL_SCOPE_MISMATCH" },
      }),
    );
  }
  return ok(context);
}

/**
 * The interim fixture-backed retrieval (honest pre-GBrain stub; the real adapter is GBrain/GCL).
 * Workspace-scoped: returns the fixture context for a KNOWN workspace, else fails closed. It runs
 * its own fixtures through `enforceRetrievalScope`, so even a MIS-KEYED fixture (scoped to a
 * different workspace than its key) fails closed rather than leaking a foreign workspace's context.
 */
export function createFixtureRetrieval(
  fixtures: Readonly<Record<string, RetrievedContext>>,
): CopilotRetrievalPort {
  return {
    retrieve: (workspaceId): Result<RetrievedContext, FailureVariant> => {
      // OWN-key lookup only — a prototype-chain key ("__proto__"/"constructor"/…) must resolve to
      // "unknown workspace", never an inherited object (the `=== undefined` check alone wouldn't).
      if (!Object.hasOwn(fixtures, workspaceId)) return err(unknownWorkspace());
      const context = fixtures[workspaceId];
      if (context === undefined) return err(unknownWorkspace());
      return enforceRetrievalScope(workspaceId, context);
    },
  };
}
