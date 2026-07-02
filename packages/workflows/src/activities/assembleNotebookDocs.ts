// @sow/workflows — slice 7.16 ACTIVITY: ASSEMBLE the five NotebookLM managed-doc bodies
// (00 Brief / 01 Decisions / 02 Meeting Digest / 03 Research / 04 Open Questions) FROM
// COMMITTED Markdown (inv-1 — the DERIVE-FROM-COMMITTED anchor).
//
// This is an ACTIVITY, NOT workflow code — it runs worker-side and MAY bind real adapters
// (the NotebookMapping resolver + a committed-Markdown reader over the workspace's Markdown
// repo / read model). It implements {@link AssembleDocsPort}. The pure driver
// (src/workflows/notebookLmSync.ts) NEVER imports a real reader; it only RECEIVES the typed
// {@link AssembleDocsResult}. Tested with injected fakes (no real filesystem / read model).
//
// THE LOAD-BEARING PIN (REQ-I-004 / NLM-2): every managed-doc body this activity returns is
// rendered DIRECTLY from COMMITTED Markdown read through the injected `readMarkdown` seam —
// the committed, already-validated canonical truth — never accepted from the caller (the
// driver has no bodies input at all). So a managed doc always mirrors committed truth; a
// caller cannot smuggle un-committed content into a Drive-backed managed doc. The mapping
// (which Drive doc each slot maps to) is likewise RESOLVED here, not caller-supplied.
//
// §16: returns a typed Result — never throws. A missing mapping folds to
// `mapping_unavailable` (no upsert should follow); a committed-Markdown read failure folds
// to `assemble_failed`. Both are fail-closed — the driver never upserts on a failed
// assemble.
import { ok, err } from "@sow/contracts";
import type { Result, NotebookMapping } from "@sow/contracts";
import type { ManagedDocBodies, NotebookSlot } from "@sow/integrations";
import type {
  AssembleDocsPort,
  AssembleDocsResult,
  AssembleDocsError,
} from "../workflows/notebookLmSync";
import { NOTEBOOK_SLOTS_ORDER } from "../workflows/notebookLmSync";

/**
 * Injected deps for the assemble activity. `resolveMapping` looks up the
 * {@link NotebookMapping} for a (workspace, project) — which Drive docs the five slots map
 * to; a missing mapping folds to `mapping_unavailable`. `readMarkdown` reads the COMMITTED
 * Markdown for ONE slot of the bound workspace and renders its managed-doc body — the sole
 * content source (inv-1). Both are injected so tests pass fakes and no real read model is
 * touched. `readMarkdown` MUST be scoped to the passed workspaceId (WS-2).
 */
export interface AssembleNotebookDocsActivityDeps {
  readonly resolveMapping: (
    workspaceId: string,
    projectId: string,
  ) => Promise<Result<NotebookMapping, AssembleDocsError>>;
  readonly readMarkdown: (
    workspaceId: string,
    slot: NotebookSlot,
  ) => Promise<Result<string, AssembleDocsError>>;
}

/**
 * Build an {@link AssembleDocsPort} that assembles the five managed-doc bodies FROM
 * COMMITTED Markdown. It resolves the mapping first (fail-closed on a missing mapping,
 * BEFORE reading any slot), then renders each of the five 00→04 slots from the committed-
 * Markdown reader. The bodies are DERIVED from committed truth, never caller-supplied
 * (inv-1). Never throws.
 */
export function createAssembleNotebookDocsActivity(
  deps: AssembleNotebookDocsActivityDeps,
): AssembleDocsPort {
  return {
    async assemble(
      workspaceId: string,
      projectId: string,
    ): Promise<Result<AssembleDocsResult, AssembleDocsError>> {
      // Resolve the mapping FIRST — a missing mapping means the managed-doc pack was never
      // created; fail closed with NO slot read (and the driver attempts NO upsert).
      const mapping = await deps.resolveMapping(workspaceId, projectId);
      if (!mapping.ok) {
        return err(mapping.error);
      }

      // Render each of the five slots from COMMITTED Markdown (inv-1). A read failure on
      // any slot fails the whole assemble closed — the driver never upserts a partial pack.
      const partial: Partial<Record<NotebookSlot, string>> = {};
      for (const slot of NOTEBOOK_SLOTS_ORDER) {
        const body = await deps.readMarkdown(workspaceId, slot);
        if (!body.ok) {
          return err(body.error);
        }
        partial[slot] = body.value;
      }

      // Every slot was read (the loop returned early otherwise), so the partial record is
      // now total over the five slots. Assert the complete shape for the ManagedDocBodies
      // contract (exactly the five 00→04 keys).
      const bodies = partial as ManagedDocBodies;
      return ok({ mapping: mapping.value, bodies });
    },
  };
}
