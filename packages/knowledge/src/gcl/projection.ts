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
  /**
   * OPTIONAL refusal notice (task 24.53). Invoked when a signal is refused by the redaction gate
   * and therefore NOT persisted — so a refusal stops being byte-identical to "no denial happened."
   *
   * ⛔ TAKES NO PARAMETERS, AND THAT IS THE SAFETY PROPERTY, NOT AN OVERSIGHT. A refusal means at
   * least one of the six fields `isRedactionSafe` scans (`actor`, `event`, `payloadHash`,
   * `beforeSummary`, `afterSummary`, `refs`) is unsafe, and this function CANNOT KNOW WHICH — so any
   * signal-derived value handed over here could be exactly the value the gate refused. ⚠ That
   * includes `event`: "event name only" reads safe because an event name is usually a literal, but
   * the gate scans it precisely because that is not guaranteed. The obligation is discharged by the
   * SIGNATURE — an implementer has nothing to leak — rather than by every present and future
   * implementer remembering a convention (desktop L20's shape: make the unsafe state
   * unrepresentable, don't forbid it in prose).
   * ⚠ Deliberately NOT `denialCode` either: it is unscanned because it is "a closed code," which is
   * closed BY TYPE and not validated at runtime — the same trusted-provenance-vs-validated-shape
   * mistake `24.55` was corrected for.
   *
   * Optional so every pre-24.53 call site stays byte-identical; a port without it refuses silently,
   * exactly as before.
   */
  readonly onRefused?: () => void;
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
  // ⛔ DO NOT REMOVE THIS GATE AS DEAD CODE — task `### 24.55`'s protection obligation
  // (`IMPLEMENTATION_PLAN.md`). It is the ONLY redaction gate `persistDenialAudit` has. ⚠ BOTH of
  // 24.55's stated reasons are wrong; the obligation is real, so the corrected reasons are recorded
  // here rather than the filed ones:
  //
  // (a) 24.55 says the gate is *"unreachable from `validateProjectionVisibility` since 24.45."*
  //     FALSE. 24.45 closed the FOREIGN-workspace path (a mismatching `wsId` renders `UNVALIDATED`),
  //     but `visibility.ts`'s `ref:workspace:` still interpolates the RAW id on the
  //     `wsId === sourceWorkspace.id` branch, and nothing constrains that id's SHAPE
  //     (`WorkspaceIdSchema`, `zod-brands.ts:30-35`, is `.min(1)` + a non-blank refine). 24.55's own
  //     enumeration lists that outcome as `sourceWorkspace?.id` and treats it as safe — mistaking
  //     trusted PROVENANCE for validated SHAPE. ⇒ reachable, and shown rather than argued:
  //     `test/gcl-projection.test.ts`'s `serve_projection_denial_routes_through_the_redaction_gate`
  //     drives this call to `false` through that producer, and reds when this line is removed.
  // (b) 24.55 says it is what *"stops the OTHER ~40"* `buildAuditSignal` producers. ALSO FALSE, and
  //     counterfactual in the other direction: `persistDenialAudit` has exactly two call sites
  //     (`:110`, `:153`), both passing `auditOf(...)` from the GCL gate, so no other producer can
  //     reach this function at all — the CALL GRAPH stops them, not this gate.
  // ⇒ The honest statement of the obligation: this is the only thing that would refuse a signal
  //   reaching here — today from the GCL gate, and from any producer ever routed here later.
  if (!isRedactionSafe(audit)) {
    // task 24.53 — a refused signal WAS indistinguishable from one never produced. The notice fires
    // with no arguments; see `GclAuditPersistPort.onRefused` for why it must stay that way.
    // ⚠ PARITY, NOT A CLAIM THAT ANYONE IS WATCHING (contracts L82): this makes the refusal EMITTABLE, matching
    // the precedent at `boot.ts:585-591`. No consumer is named because none is wired — the GCL port
    // binding is still deferred to Phase 25.2/25.4 — and asserting operator visibility without being
    // able to name the consumer is the overclaim this file has now been corrected for twice.
    // ⛔ `onRefused` is CALLER-SUPPLIED and fires ONLY on the refusal path, so a notice that can
    // break this function turns "a signal was unsafe" into "the write path died" — a
    // CONTENT-CONDITIONED failure, strictly worse than the silence 24.53 removes. Two escape routes,
    // both closed here; the persist below is guarded for the same never-throw reason (§16).
    //   • sync throw — the `catch`. Covers a throwing `get onRefused` accessor too.
    //   • ⛔ ASYNC REJECTION — `() => void` does NOT forbid an async implementation (TypeScript's
    //     void-return assignability rule), so `onRefused: async () => { await sink.write(...) }`
    //     typechecks. Its rejected promise would escape the `catch` entirely; Node 22 defaults to
    //     `--unhandled-rejections=throw` and this repo registers no handler, so it would TERMINATE
    //     the process. The signature cannot make that unrepresentable, so it is handled here rather
    //     than asserted in prose.
    try {
      void Promise.resolve(auditPersist.onRefused?.() as unknown).catch(() => undefined);
    } catch {
      // Swallowed deliberately: the refusal guarantee (nothing is persisted) must never depend on
      // the notice succeeding, exactly as the denial guarantee does not depend on the persist.
    }
    return;
  }
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
