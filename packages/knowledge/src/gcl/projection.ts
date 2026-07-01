// GCL projection persistence + serve (§6, task 4.10). The GCL DB is the queryable
// MASTER of sanitized cross-workspace projections; this module is the only path
// that admits a projection into it, and it does so exclusively through the
// `GclProjectionRepository` INTERFACE — no concrete driver dependency lives in
// this package (§13 single-owner store; interfaces from `@sow/db`).
//
// Both directions are gated by the Visibility Gate (`admitProjection`):
//  - WRITE: `admitAndPersistProjection` HARD-rejects a raw / over-visibility
//    candidate BEFORE any upsert — a rejected candidate never reaches the store
//    (no downgrade-and-store, §3 P3 / §5); a repo failure surfaces as a typed
//    error, never a throw (§16).
//  - READ: `serveProjection` re-gates a stored row before it crosses a workspace
//    boundary (defense in depth: a row tampered post-write to carry raw or
//    over-visibility content is refused at serve, not leaked).
import { ok, err } from "@sow/contracts";
import type { GclProjection, Workspace, Result } from "@sow/contracts";
import type { GclProjectionRepository, DbError } from "@sow/db";
import type { SchemaRegistry } from "@sow/contracts/schema/registry";
import { admitProjection, type GclGateError, type GclAdmitResult } from "./visibility-gate";

/** Enumerable failure reasons for a gated persist (§16 closed set). */
export type GclPersistError =
  | { readonly code: "rejected"; readonly reason: GclGateError }
  | { readonly code: "persist_failed"; readonly dbError: DbError };

/**
 * Gate a candidate projection through the Visibility Gate, then — only if it is
 * admitted — upsert it via the repository interface. A HARD-rejected candidate
 * (raw content / over-visibility / malformed) is returned as `rejected` and is
 * NEVER handed to `repo.upsert`.
 */
export async function admitAndPersistProjection(
  candidate: unknown,
  sourceWorkspace: Workspace,
  repo: GclProjectionRepository,
  registry?: SchemaRegistry,
): Promise<Result<GclProjection, GclPersistError>> {
  const admitted = admitProjection(candidate, sourceWorkspace, registry);
  if (!admitted.ok) {
    return err({ code: "rejected", reason: admitted.error });
  }

  const persisted = await repo.upsert(admitted.value);
  if (!persisted.ok) {
    return err({ code: "persist_failed", dbError: persisted.error });
  }
  return ok(persisted.value);
}

/**
 * Serve a stored projection across the cross-workspace read path. Re-runs the
 * full Visibility Gate on the row so a post-write tamper (raw content injected,
 * visibility raised) is refused at serve rather than leaked. Returns the same
 * typed gate error set as {@link admitProjection}.
 */
export function serveProjection(
  stored: GclProjection,
  sourceWorkspace: Workspace,
  registry?: SchemaRegistry,
): GclAdmitResult {
  return admitProjection(stored, sourceWorkspace, registry);
}
