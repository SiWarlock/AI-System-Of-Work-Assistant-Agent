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
  return e.code === "workspace_not_found"
    ? failure("validation_rejected", "workspace not found", { cause: { code: "WORKSPACE_NOT_FOUND" } })
    : failure("degraded_unavailable", "egress ack revoke failed", {
        retryable: true,
        cause: { code: "EGRESS_REVOKE_STORE_FAULT" },
      });
}

/**
 * Reconstruct a UI-safe egress status from ONLY the three allowlisted fields (defense-in-depth — mirrors
 * `systemHealth.ts`'s `toUiSafeEgressStatus`, so an over-broad port result can never leak an extra field).
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
