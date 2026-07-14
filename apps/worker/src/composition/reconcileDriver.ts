// Task 13.10 (reconcile-TRIGGER arc, piece D) — the pure, trigger-agnostic reconcile DRIVER. spec(§6) spec(§12)
//
// runReconcileForWorkspace is the end-to-end composition of pieces A+B+C over INJECTED async collaborators: it
// reads the canonical reference (C: getCanonicalFactSet) and — only on a `derived` reference — reads the DB
// projection (B: getDbProjection), assembles the ReconcileRequest, and runs the pass (A: runPass), routing the
// result into a typed 4-way ReconcileDriverOutcome.
//
// TRIGGER-AGNOSTIC: the collaborators are injected async fns, so the driver runs UNCHANGED under either trigger
// model — in a Temporal workflow they are `proxyActivities`, in a worker-scheduled pass they are direct async
// calls. The workflow-weight choice (full Temporal workflow vs a lighter worker pass) therefore belongs at the
// TRIGGER (piece E), where the driver is invoked, not baked in here.
//
// Fail-closed routing (§12):
//   • getCanonicalFactSet → absent          ⇒ { skipped_absent } — no canonical reference, so SHORT-CIRCUIT:
//     the gbrain read (getDbProjection) is NOT issued (no wasted read without a reference to compare against);
//   • getCanonicalFactSet → derive_error    ⇒ { skipped_derive_error, error } — a structurally-broken vault is
//     surfaced TYPED for the trigger (E/F) to route to health; the driver stays PURE (no HealthItem minted here);
//   • runPass rejects                        ⇒ { pass_faulted, cause } — caught, NEVER thrown.
//
// rebuildOracle is OMITTED from the request (decision #2): coverageComplete rests on dbProjection.complete, not
// forced false; the real RebuildOracleSet (gbrain scratch-import) is OWNER-GATED and stays unbound the whole arc.
//
// Never throws: `runPass` is the ONLY collaborator with a DESIGNED rejection channel (piece A deliberately rejects
// on a store record / health-sink fault so the fault is visible), so it is caught into `pass_faulted`.
// getCanonicalFactSet (C degrades to `absent`) and getDbProjection (B degrades to `complete=false`) are
// contractually never-reject, so the driver relies on them — the outermost fs/gbrain boundary is already wrapped
// inside C/B (Lesson 20). Catch the collaborator with a rejection channel; rely on the never-reject ones.
//
// DORMANT + reachability-waivered: no production caller — piece E supplies the trigger/origin + drives this, piece
// F is the default-OFF boot gate binding the real collaborators. No boot, no Temporal, no real I/O here; the two
// OWNER-GATED real bindings (live GbrainReadGrant transport behind B, real RebuildOracleSet) stay unbound.
import type {
  ReconcileRequest,
  ReconcileTriggerOrigin,
  ReconcilerDbProjection,
  DeriveError,
} from "@sow/knowledge";
import type { ParityRecordDisposition } from "./parityReportStore";
import type { CanonicalSnapshotOutcome } from "./canonicalFactSet";

/** The injected collaborators for one reconcile pass — all fakeable; bound to the real A/B/C at the E/F seam. */
export interface ReconcileDriverDeps {
  /** Piece C, bound to the real committed-vault reader at wiring — the canonical "what SHOULD exist" reference. */
  readonly getCanonicalFactSet: (workspaceId: string) => Promise<CanonicalSnapshotOutcome>;
  /** Piece B, bound to the real gbrain read adapter at wiring — the DB-facts projection (fail-closed coverage). */
  readonly getDbProjection: (workspaceId: string) => Promise<ReconcilerDbProjection>;
  /** The trigger origin (piece E owns it — the driver never invents one). */
  readonly origin: ReconcileTriggerOrigin;
  /** Piece A, with its passDeps closed in at wiring: `(req) => runReconcilePass(req, passDeps)`. */
  readonly runPass: (req: ReconcileRequest) => Promise<ParityRecordDisposition>;
}

/** The typed 4-way outcome the trigger (piece E) routes on. */
export type ReconcileDriverOutcome =
  | { readonly kind: "reconciled"; readonly disposition: ParityRecordDisposition }
  | { readonly kind: "skipped_absent" }
  | { readonly kind: "skipped_derive_error"; readonly error: DeriveError }
  | { readonly kind: "pass_faulted"; readonly cause: unknown };

/**
 * Run one end-to-end reconciliation pass for a workspace: read the canonical reference (C) → on `derived`, read
 * the DB projection (B) → assemble the request (rebuildOracle omitted) → run the pass (A) → a typed outcome.
 * Short-circuits absent/derive_error; never throws (a runPass rejection is caught into `pass_faulted`).
 */
export async function runReconcileForWorkspace(
  workspaceId: string,
  deps: ReconcileDriverDeps,
): Promise<ReconcileDriverOutcome> {
  const canonical = await deps.getCanonicalFactSet(workspaceId);
  if (canonical.kind === "absent") {
    return { kind: "skipped_absent" }; // no canonical reference ⇒ skip; do NOT issue the gbrain read
  }
  if (canonical.kind === "derive_error") {
    return { kind: "skipped_derive_error", error: canonical.error }; // broken vault ⇒ surfaced typed (E/F → health)
  }

  const dbProjection = await deps.getDbProjection(workspaceId);
  const req: ReconcileRequest = {
    origin: deps.origin,
    canonicalSet: canonical.set,
    dbProjection,
    // rebuildOracle OMITTED (decision #2) — coverageComplete rests on dbProjection.complete; oracle owner-gated.
  };

  try {
    const disposition = await deps.runPass(req);
    return { kind: "reconciled", disposition };
  } catch (cause) {
    return { kind: "pass_faulted", cause }; // §12 fault-visible + never-thrown across the trigger boundary
  }
}
