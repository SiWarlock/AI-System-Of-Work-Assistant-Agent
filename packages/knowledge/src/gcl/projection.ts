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
//    over-visibility content is refused at serve, not leaked); a re-gate denial's
//    audit signal is persisted the same fail-closed-gated way the write path's is
//    (task 24.44).
import { ok, err } from "@sow/contracts";
import type { GclProjection, Workspace, Result } from "@sow/contracts";
import type { GclProjectionRepository, DbError } from "@sow/db";
import type { SchemaRegistry } from "@sow/contracts/schema/registry";
import type { ProjectionTypeVisibilityTaxonomy, AuditSignal } from "@sow/policy";
import { isRedactionSafe } from "@sow/policy";
import { admitProjection, auditOf, type GclGateError, type GclAdmitResult } from "./visibility-gate";

/** Enumerable failure reasons for a gated persist (§16 closed set). */
export type GclPersistError =
  | { readonly code: "rejected"; readonly reason: GclGateError }
  | { readonly code: "persist_failed"; readonly dbError: DbError };

/**
 * Injected sink for a GCL denial's `AuditSignal` (task 24.33). Same shape as `24.7`'s
 * `AuditPersistPort` (`apps/worker/src/api/procedures/copilot.ts`) — NOT imported directly:
 * importing from `apps/worker` would invert this package's layer direction
 * (`packages/knowledge → packages/policy → {domain,contracts}`). A GCL-local equivalent
 * instead. Mirrors `createAuditPersistPort`'s own contract: never throws, never surfaces a
 * persistence fault back to the caller — the denial guarantee must never depend on the audit
 * write succeeding.
 */
export interface GclAuditPersistPort {
  readonly persistDenial: (signal: AuditSignal, workspaceId: string) => Promise<void>;
}

/**
 * Gate + persist a denial's `AuditSignal`, when one exists and a port is injected. Fail-closed:
 * a signal that fails `@sow/policy`'s `isRedactionSafe` is refused, never persisted. The gate
 * lives HERE (not inside the injected port, unlike `24.7`'s `createAuditPersistPort`) because
 * this package's real port binding is deferred to Phase 25.2/25.4 — the safety property must
 * hold at the layer guaranteed to run today, not depend on a not-yet-written future adapter
 * remembering its own gate. A no-op (never throws) when there is no signal or no port — and
 * NEVER throws even if the injected port itself does (security review: the port's own
 * `Promise<void>` contract documents never-throw like `24.7`'s `createAuditPersistPort`, but
 * nothing enforces that on a future implementation; a caught, discarded throw here keeps this
 * write path's own never-throw guarantee (§16) from depending on that adapter's discipline).
 */
export async function persistDenialAudit(
  audit: AuditSignal | undefined,
  workspaceId: string,
  auditPersist: GclAuditPersistPort | undefined,
): Promise<void> {
  if (audit === undefined || auditPersist === undefined) return;
  if (!isRedactionSafe(audit)) return;
  try {
    await auditPersist.persistDenial(audit, workspaceId);
  } catch {
    // A throwing port implementation must never break this write path's own never-throw
    // contract (§16) — the denial guarantee (the write stays rejected) must never depend on
    // the audit persist succeeding, mirroring 24.7's own "never surfaces a persistence
    // failure back to the caller" doc'd behavior.
  }
}

/**
 * Gate a candidate projection through the Visibility Gate, then — only if it is
 * admitted — upsert it via the repository interface. A HARD-rejected candidate
 * (raw content / over-visibility / malformed) is returned as `rejected` and is
 * NEVER handed to `repo.upsert`. A denial's `AuditSignal`, when the injected
 * `auditPersist` port is present, is persisted (fail-closed gated — see
 * {@link persistDenialAudit}) before this returns (task 24.33). `auditPersist` is
 * OPTIONAL and UNBOUND in production — this mechanism is not wired anywhere yet
 * (Phase 25.2/25.4).
 */
export async function admitAndPersistProjection(
  candidate: unknown,
  sourceWorkspace: Workspace,
  repo: GclProjectionRepository,
  registry?: SchemaRegistry,
  taxonomy?: ProjectionTypeVisibilityTaxonomy,
  auditPersist?: GclAuditPersistPort,
): Promise<Result<GclProjection, GclPersistError>> {
  const admitted = admitProjection(candidate, sourceWorkspace, registry, taxonomy);
  if (!admitted.ok) {
    await persistDenialAudit(auditOf(admitted.error), sourceWorkspace.id, auditPersist);
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
 * typed gate error set as {@link admitProjection}. A re-gate denial's `AuditSignal`,
 * when the injected `auditPersist` port is present, is persisted the same way
 * `admitAndPersistProjection`'s write-path denial is (task 24.44, completing
 * `24.33`'s deliberately-scoped-out coverage) — arguably the MORE safety-critical
 * of the two audit paths, since this one catches a projection already stored,
 * not just one on the way in.
 *
 * `apps/worker/src/composition/crossWorkspaceRead.ts` names a real call site for
 * this function — but that caller, `resolveApprovedCrossWorkspaceSlice`, has ZERO
 * production callers of its own as of 2026-08-12 (established `24.33` Step 0,
 * re-verified at `24.44`; every real caller is in a test file). Re-derive this
 * before relying on it — `Phase 25.2/25.4`'s port wiring is what would change it.
 * A call site existing in production source is not the same claim as the path
 * executing in production.
 *
 * `auditPersist` is OPTIONAL and UNBOUND in production, same as
 * `admitAndPersistProjection`'s — the persist is fail-closed gated (see
 * {@link persistDenialAudit}), never a best-effort write of a possibly-unsafe signal.
 */
export async function serveProjection(
  stored: GclProjection,
  sourceWorkspace: Workspace,
  registry?: SchemaRegistry,
  taxonomy?: ProjectionTypeVisibilityTaxonomy,
  auditPersist?: GclAuditPersistPort,
): Promise<GclAdmitResult> {
  const admitted = admitProjection(stored, sourceWorkspace, registry, taxonomy);
  if (!admitted.ok) {
    await persistDenialAudit(auditOf(admitted.error), sourceWorkspace.id, auditPersist);
  }
  return admitted;
}
