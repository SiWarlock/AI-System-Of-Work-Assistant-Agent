// Task 8.4 (integrator step) — the REAL @sow/db + dispatch-seam binding of the
// command-procedure ports. `commands.ts` declares the `ApprovalCommandPort` +
// `TriagePort` seams and the exactly-once / one-writer command logic; the FAKES are
// the unit-test seams. THIS module binds those ports to the real backends:
//   • `createDbApprovalCommandPort` — over the @sow/db `ApprovalRepository` CAS
//     (`get` + `applyTransition`, which itself drives the pure `decideApprovalCas`
//     apply | idempotent_noop | stale_conflict verdicts, unit 2.5). The exactly-once
//     compare-and-set lives ONCE in the repository — this adapter re-exposes it as
//     the command port with NO re-implementation, so a cross-channel double-apply /
//     replay collapses to exactly one durable transition (REQ-F-012, §9).
//   • `createDbTriagePort` — over an INJECTED dispatch seam. The ingestion re-entry
//     is a Temporal / Tool-Gateway effect (the real dispatch fn is wired at boot);
//     the port reuses the caller's `idempotencyKey` verbatim (replay-safe, ING-4).
//
// ONE-WRITER / TOOL-GATEWAY (root CLAUDE.md safety 1 + 3, §7/§8). NEITHER adapter
// writes an external system or Markdown directly. The approval command's only durable
// effect is the CAS on the @sow/db approval row (operational truth, not an external
// write); the triage command's only effect is the injected dispatch (Temporal /
// Tool-Gateway is the sole writer). A command NEVER opens a vendor client here.
//
// §16 typed boundary: every method returns a typed `Result` and never throws across
// the boundary. The @sow/db repo already returns `Result<..., DbError>`; the triage
// dispatch seam returns `Result<..., FailureVariant>` (already boundary-typed).
//
// IMPORT DIRECTION (root CLAUDE.md §2.5): apps/worker may import @sow/db + @sow/contracts;
// it never inverts the dependency. This is the worker-layer adapter the @sow/db
// `ApprovalRepository` doc calls for.
import type { Result, FailureVariant } from "@sow/contracts";
import type { ApprovalRepository } from "@sow/db";
import type {
  ApprovalCommandPort,
  TriagePort,
  TriageDisposition,
  RerouteTarget,
} from "../procedures/commands";

// ── (a) approval command port over the @sow/db ApprovalRepository CAS ─────────

/**
 * Bind the 8.4 {@link ApprovalCommandPort} to the real @sow/db
 * {@link ApprovalRepository}. The port is EXACTLY the repository's `get` +
 * `applyTransition` surface — the exactly-once compare-and-set (and its
 * `decideApprovalCas` verdicts: genuine apply | idempotent no-op | stale/tombstoned
 * conflict) lives ONCE in the repository, so this adapter is a faithful pass-through
 * (no CAS re-implementation, no extra state). `applyTransition`'s `applied` flag —
 * true only for a genuine durable transition — is surfaced unchanged so the command
 * layer dispatches the downstream side effect exactly once (a no-op contender / a
 * replay never re-dispatches; REQ-F-012 / §9 / safety 3).
 *
 * The method bodies are one-liners that forward to the repo, but the adapter is a
 * NAMED boundary (not an inline `repo` pass) so the composition root binds a stable
 * port type and a future repo signature drift is caught HERE, at the seam.
 */
export function createDbApprovalCommandPort(
  repo: ApprovalRepository,
): ApprovalCommandPort {
  return {
    get: (id) => repo.get(id),
    applyTransition: (id, expectedFrom, next) =>
      repo.applyTransition(id, expectedFrom, next),
  };
}

// ── (b) triage port over an injected dispatch seam ────────────────────────────

/**
 * The injected ingestion-re-entry dispatch seam. The command layer's triage effect
 * is a Temporal / Tool-Gateway dispatch — NOT a direct write (safety 1 + 3). The
 * real binding (wired at worker boot) starts / signals the ingestion workflow through
 * the worker's Temporal client, using the caller's `idempotencyKey` as the workflow's
 * dedupe id so a replay / double-apply lands the SAME key → one effect (ING-4). A
 * fake implements this for unit tests. It returns a boundary-typed `Result` — never
 * throws (§16).
 */
export type TriageDispatchFn = (input: {
  sourceId: string;
  idempotencyKey: string;
  disposition: TriageDisposition;
  /** The registry-validated reroute target (15.8) — present only for a `reroute`. */
  target?: RerouteTarget;
}) => Promise<Result<{ idempotencyKey: string }, FailureVariant>>;

/**
 * Bind the 8.4 {@link TriagePort} over an injected {@link TriageDispatchFn}. The
 * port REUSES the caller's `idempotencyKey` verbatim (replay-safe, ING-4) — it does
 * NOT mint a new key — and returns the reused key so the renderer can correlate. The
 * adapter performs NO direct write: the injected dispatch (Temporal / Tool-Gateway)
 * is the only writer (safety 1 + 3). The real dispatch fn is wired at boot; the fake
 * is the unit-test seam.
 */
export function createDbTriagePort(dispatch: TriageDispatchFn): TriagePort {
  return {
    reenterIngestion: (input) =>
      dispatch({
        sourceId: input.sourceId,
        // Verbatim reuse — the ING-4 replay-safety proof. Never re-minted here.
        idempotencyKey: input.idempotencyKey,
        disposition: input.disposition,
        // Forward the pre-validated reroute target (15.8) when present (omitted for
        // accept/reject so the dispatched object stays byte-equivalent for them).
        ...(input.target !== undefined ? { target: input.target } : {}),
      }),
  };
}

// Re-export the seam types so the integrator (and the tests) import the ports + their
// adapters from one place, mirroring `commands.ts`'s own re-export discipline.
export type { ApprovalCommandPort, TriagePort, TriageDisposition, RerouteTarget };
export type { ApprovalRepository };
