// Task 14.7 — THE cross-workspace READ GATE (worker leg). HIGHEST safety bar (safety rule 4 / WS-8).
//
// `resolveApprovedCrossWorkspaceSlice(readerWorkspaceId)` is the ONLY path by which reader-workspace
// A sees any of source-workspace B's content — and only the APPROVED, DIRECTIONAL, SCOPED, SANITIZED
// slice. Fail-closed by construction:
//   - absent any approved link ⇒ ok([]) (ZERO cross-workspace bleed — WS-8 stays fully isolating).
//   - only B rows matching the link's scope (projectionType + visibilityLevel) cross.
//   - every crossing row is RE-VALIDATED through the frozen `GclProjectionSchema` (§6 leakage gate:
//     key-name-independent, rejects any multi-line / over-length value) — a raw-content-shaped row
//     fails CLOSED (`sanitization_rejected`), so raw bytes NEVER cross even under an approved link.
//   - a degenerate (empty) persisted scope crosses NOTHING (never all-of-B).
//   - any store fault ⇒ `store_fault` (never a partial / leaky read). Never throws.
//
// REACHABILITY (Lesson 11): the consumers that BLEND this slice into a coordination/global brief are
// Phase 25.2/25.4 (deferred). This gate is the reachable unit they will call — it is deliberately NOT
// wired into the empty aggregate global producer (`queries.ts globalSurface`, workspaceId=null), which
// is a different (aggregate, non-directional) concept. Ships behind a reachability waiver until 25.2/25.4.
import { ok, err, isErr, type Result } from "@sow/contracts";
import { GclProjectionSchema, type GclProjection, type WorkspaceId } from "@sow/contracts";
import type { CrossWorkspaceLinkRepository, GclProjectionRepository } from "@sow/db";

/** Deps for the read gate — the link store (approved links) + the GCL projection store (B's slices). */
export interface CrossWorkspaceReadDeps {
  readonly links: CrossWorkspaceLinkRepository;
  readonly gclProjections: GclProjectionRepository;
}

/** Typed, redaction-safe read failures. */
export type CrossWorkspaceReadError =
  | { readonly code: "store_fault"; readonly message: string }
  // A B projection carried a raw-content-shaped value — withhold the WHOLE read (never raw bytes).
  | { readonly code: "sanitization_rejected"; readonly message: string };

/**
 * Resolve the APPROVED, SCOPED, SANITIZED cross-workspace slice a reader workspace may blend.
 * The single sanctioned WS-8 cross-workspace read. Fail-closed everywhere; never throws.
 */
export async function resolveApprovedCrossWorkspaceSlice(
  deps: CrossWorkspaceReadDeps,
  readerWorkspaceId: string,
): Promise<Result<readonly GclProjection[], CrossWorkspaceReadError>> {
  try {
    const approved = await deps.links.listApprovedForReader(readerWorkspaceId as WorkspaceId);
    if (isErr(approved)) return err({ code: "store_fault", message: "cross-workspace link list failed" });
    // ZERO bleed — the fail-closed default. WS-8 stays fully isolating absent an approved link.
    if (approved.value.length === 0) return ok([]);

    const out: GclProjection[] = [];
    for (const link of approved.value) {
      // Defense-in-depth: the store already filters status + reader, re-assert both here so a
      // looser store binding can never widen the gate.
      if (link.status !== "approved") continue;
      if (link.fromWorkspaceId !== readerWorkspaceId) continue; // directional (A→B ≠ B→A)
      if (link.scopeProjectionType.length === 0) continue; // degenerate scope ⇒ cross nothing

      const projections = await deps.gclProjections.listByWorkspace(link.toWorkspaceId);
      if (isErr(projections)) return err({ code: "store_fault", message: "gcl projection list failed" });

      for (const projection of projections.value) {
        // Read-back identity re-gate (worker Lesson 12): the crossing row MUST belong to the link's
        // SOURCE workspace (B). WS-8 source correctness must not rest on `listByWorkspace`'s filter
        // alone — a mis-filtered / tampered store row from another workspace never crosses to A.
        if (projection.workspaceId !== link.toWorkspaceId) continue;
        // Scope gate — only the link's approved slice crosses (never wider than the scope).
        if (projection.projectionType !== link.scopeProjectionType) continue;
        if (projection.visibilityLevel !== link.scopeVisibilityLevel) continue;
        // Sanitizer — the link authorizes the SANITIZER's output, never raw bytes (safety rule 4).
        // A raw-content-shaped row fails CLOSED: withhold the whole read (redaction-safe — no payload).
        const parsed = GclProjectionSchema.safeParse(projection);
        if (!parsed.success) {
          return err({ code: "sanitization_rejected", message: "cross-workspace projection failed sanitization" });
        }
        out.push(parsed.data);
      }
    }
    return ok(out);
  } catch {
    return err({ code: "store_fault", message: "cross-workspace read failed" });
  }
}
