// Task 9.10-B ⚠ rule-5 SAFETY — the owner-authorized egress-ack REVOKE command procedure. Declares the
// `EgressCommandPort` seam (implemented by `composition/egressRevoke.ts` over the real repos) + mounts the
// `revokeEgressAck` tRPC `.mutation()` behind the 8.1 auth gate (owner session). The fail-SAFE OFF
// direction of the 9.10 egress ack — turns employer raw-cloud egress OFF for a workspace, audited,
// fail-closed. The VISIBILITY read stays `systemHealth.egressStatus` (this is the command half only).
//
// Mirrors `crossWorkspaceLink.ts`: the procedure declares the port + does the UI-safe re-projection; the
// composition root binds the real port. Returns the NEW `UiSafeEgressStatus` (worker-local type, reused
// from `systemHealth.ts` — a 9.10-C renderer imports it via tsc-tie, no contract touch).
import { ok, err, failure } from "@sow/contracts";
import type { Result, FailureVariant } from "@sow/contracts";
import { router, publicProcedure, authedResolver } from "../router";
import type { UiSafeEgressStatus } from "./systemHealth";

/** The owner-authorized revoke input — the workspace whose egress ack is being turned OFF. */
export interface RevokeEgressAckInput {
  readonly workspaceId: string;
}

/**
 * Closed, enumerable revoke failure set (§16 — never thrown; redaction-safe, code + static message only,
 * NO raw content / policy / cause value crosses, rule 7). `workspace_not_found` = the fail-closed
 * unknown-workspace path; `store_fault` = any get/upsert/audit fault (preserve-fault — never a fault-time
 * default). NOTE (carry-forward): `store_fault` conflates "revoke didn't land" vs "landed but audit
 * failed" — acceptable because `egressStatus` disambiguates the actual state + the direction is fail-safe OFF.
 */
export type RevokeEgressAckError =
  | { readonly code: "workspace_not_found"; readonly message: string }
  // Task 9.36 — the stored row failed re-validation at the repository read boundary (an
  // out-of-band-corrupted row, never producible by a real writer). Distinct from `store_fault`:
  // this is PERMANENTLY non-retryable (the row will not become consistent on retry), so it must
  // never be collapsed into the retryable store-fault code.
  | { readonly code: "stored_row_schema_violation"; readonly message: string }
  | { readonly code: "store_fault"; readonly message: string };

/**
 * The egress command seam — the composition root binds the real port (get→flip-off+clear→upsert→audit
 * over `WorkspaceConfigRepository` + `AuditRepository` + a clock). A unit test injects a fake. Never throws.
 */
export interface EgressCommandPort {
  readonly revokeEgressAck: (
    input: RevokeEgressAckInput,
  ) => Promise<Result<UiSafeEgressStatus, RevokeEgressAckError>>;
}

/** Dependencies for {@link buildEgressCommandRouter}. */
export interface EgressCommandRouterDeps {
  readonly egressCommand: EgressCommandPort;
}

/** tRPC plain-function validator narrowing an unknown payload → RevokeEgressAckInput (§3 boundary rule). */
function parseWorkspaceInput(value: unknown): RevokeEgressAckInput {
  if (typeof value !== "object" || value === null) throw new Error("invalid_input");
  const source = value as Record<string, unknown>;
  const workspaceId = source["workspaceId"];
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    // Transport-level malformed payload — the 8.2 errorFormatter net maps this redaction-safely.
    throw new Error("invalid_input");
  }
  return { workspaceId };
}

/**
 * Map a {@link RevokeEgressAckError} → the §16 boundary taxonomy. REDACTION-SAFE: only a stable code
 * crosses (never the workspaceId / raw cause). An unknown workspace is a `validation_rejected`; any store
 * fault is a retryable `degraded_unavailable`.
 */
function toBoundaryError(e: RevokeEgressAckError): FailureVariant {
  if (e.code === "workspace_not_found") {
    return failure("validation_rejected", "workspace not found", { cause: { code: "WORKSPACE_NOT_FOUND" } });
  }
  if (e.code === "stored_row_schema_violation") {
    // Task 9.36 — PERMANENTLY non-retryable (a corrupt stored row will not self-heal on retry;
    // `retryable: true` here would be a new silent-hang class, not a transient outage).
    return failure("degraded_unavailable", "workspace record failed schema re-validation", {
      retryable: false,
      cause: { code: "EGRESS_REVOKE_STORED_ROW_SCHEMA_VIOLATION" },
    });
  }
  return failure("degraded_unavailable", "egress ack revoke failed", {
    retryable: true,
    cause: { code: "EGRESS_REVOKE_STORE_FAULT" },
  });
}

/**
 * Reconstruct a UI-safe egress status from ONLY the three allowlisted fields (defense-in-depth — mirrors
 * `systemHealth.ts`'s `toUiSafeEgressStatus`, so an over-broad port result can never leak an extra field).
 */
/**
 * ⛔ THIS PRODUCER DELIBERATELY DOES NOT REDACT `workspaceId`, AND THE ASYMMETRY WITH
 * `systemHealth.ts`'s SAME-NAMED `toUiSafeEgressStatus` IS LOAD-BEARING — DO NOT 'MAKE THEM
 * CONSISTENT' (`### 24.112`). Both results are folded by ONE shared consumer, `foldStatus`
 * (`apps/desktop/renderer/lib/egress-status.ts`), which COMPARES THE RETURNED `workspaceId`
 * AGAINST THE REQUESTED ONE and fails closed on a mismatch. On the READ path a mismatch
 * renders 'posture unavailable' — correct, and priced. On THIS path — the revoke — it renders
 * 'Couldn't revoke the acknowledgment … the posture on screen is UNCHANGED', so a revoke that
 * ACTUALLY LANDED would report failure, indistinguishably from a real failure, on the
 * fail-safe OFF control for employer raw egress (safety rule 5). Redacting here without
 * resolving that is a rule-5 regression that looks like a cleanup.
 *
 * ⚠ PRECONDITION, STATED SO A VERIFIER WHO CANNOT REPRODUCE THE SCENARIO DOES NOT
 * CONCLUDE THIS FENCE IS STALE: if the consistency edit reuses THIS file's redactor,
 * the composed failure is blocked upstream — the READ mismatches first, the cell
 * renders `unavailable`, and the revoke control is never offered (`egress.tsx:249`
 * requires `cell.kind === "ready"`). ⛔ THE HAZARD REMAINS REACHABLE BY THREE ROUTES:
 * an edit importing a DIFFERENT same-named `redactString` (this repo has MULTIPLE,
 * with divergent pattern sets — census on `### 24.118`, deliberately NOT restated here:
 * a guard that carries a count rots when someone adds one), "consistency" applied in
 * the OTHER direction (removing the gate from `systemHealth.ts`), or any future
 * revoke path not gated on a successful read.
 * ⛔ NOT grounds to weaken or delete this fence.
 *
 * ⭐ `### 24.112` RESOLUTION (safety rules 5 AND 7), SUPERSEDING NOTHING ABOVE — read it as an
 * ADDENDUM: rule 5 wins THIS sink (the wire response stays unredacted, as argued above), and that
 * is safe specifically BECAUSE rule 7's real enforcement point for `workspaceId` is NOT this
 * return value — it is the DURABLE audit sink, one layer down. `composition/egressRevoke.ts`'s
 * `revokeEgressAck` builds an `AuditRecord` with `refs: [wsId]` and runs it through
 * `@sow/policy`'s `isRedactionSafe` (which DOES scan `refs`, task 24.45) BEFORE `deps.audit.append`
 * — a credential-/keyword-shaped `workspaceId` is rejected there (`store_fault`, "audit rejected by
 * redaction gate"), never persisted raw. So the two sinks divide the obligation: the EPHEMERAL wire
 * reply stays verbatim (rule 5 — a landed revoke must report success), the DURABLE audit trail
 * stays gated (rule 7 — a rule-7 log sink never gets an unredacted id). Neither producer needs the
 * other's behavior; each is responsible for its OWN sink. THE PIN: `egressCommands.test.ts`'s
 * `revoke_landed_reports_success_workspaceid_unredacted` (this file's projector, wire sink) and
 * `revoke_credential_shaped_workspaceid_never_reaches_the_durable_audit_sink` (the composition
 * layer's audit sink) — both RED-verified by mutation, so neither producer can silently regress
 * into the other's job.
 */
function toUiSafeEgressStatus(status: UiSafeEgressStatus): UiSafeEgressStatus {
  return {
    workspaceId: status.workspaceId,
    employerRawEgressAcknowledged: status.employerRawEgressAcknowledged,
    zeroEgressOnly: status.zeroEgressOnly,
  };
}

/**
 * Build the egress command router. `revokeEgressAck` is a tRPC `.mutation()` behind `authedResolver` (owner
 * session) — an unauthenticated caller gets the interceptor's typed err as DATA; a thrown port is caught +
 * mapped to a typed err (§16). Returns the NEW `UiSafeEgressStatus`, re-projected to the allowlisted fields.
 */
export function buildEgressCommandRouter(deps: EgressCommandRouterDeps) {
  const { egressCommand } = deps;
  return router({
    revokeEgressAck: publicProcedure.input(parseWorkspaceInput).mutation(
      authedResolver<RevokeEgressAckInput, UiSafeEgressStatus>(
        async (_ctx, input): Promise<Result<UiSafeEgressStatus, FailureVariant>> => {
          const res = await egressCommand.revokeEgressAck(input);
          return res.ok ? ok(toUiSafeEgressStatus(res.value)) : err(toBoundaryError(res.error));
        },
      ),
    ),
  });
}

/** The mounted-router type (for the integrator's `AppRouter` composition). */
export type EgressCommandRouter = ReturnType<typeof buildEgressCommandRouter>;
