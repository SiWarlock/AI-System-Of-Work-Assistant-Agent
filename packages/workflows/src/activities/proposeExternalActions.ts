// @sow/workflows — slice 7.6 ACTIVITY: propose/apply external actions through the
// §8 Tool Gateway (inv-4/inv-5 — the ONLY external-write path; envelope reuse).
//
// This is an ACTIVITY, NOT workflow code — it runs worker-side and dispatches ONLY
// through the @sow/integrations Tool Gateway (`dispatchExternalWrite`). It NEVER
// calls a target-write adapter directly (safety rule 3). It takes the dispatch fn +
// its deps INJECTED so it is Vitest-unit-testable with a fake gateway and never
// touches a real network in the module. It implements {@link ProposeActionsPort}.
//
// SAFETY:
//   inv-4 — external proposals/writes go ONLY through the Tool Gateway envelope.
//   inv-5 — the gateway's reserve-then-create + stored-receipt replay gate makes a
//           replay REUSE the receipt (`status:'reused'`) → zero duplicate external
//           write. We do NOT re-implement that here — we lean on the gateway.
//   An approval-required action FAILS CLOSED (`approval_pending`, no write).
//
// §16: returns a typed Result — never throws. The gateway's non-terminal / typed
// outcomes (held / approval_pending / conflict / rejected) fold onto the closed
// {@link ProposeErrorCode} set — a held resume is an error the caller re-holds,
// never a silent success.
import { ok, err } from "@sow/contracts";
import type {
  Result,
  ProposedAction,
  ExternalWriteEnvelope,
} from "@sow/contracts";
import type { ExternalWriteDeps, ExternalWriteResult } from "@sow/integrations";
import type {
  ProposeActionsPort,
  ProposeResult,
  ProposeError,
  ProposeErrorCode,
} from "../ports/meetingCloseout";

/** The §8 Tool Gateway external-write entry (injected — @sow/integrations `dispatchExternalWrite`). */
export type DispatchExternalWriteFn = (
  env: ExternalWriteEnvelope,
  action: ProposedAction,
  deps: ExternalWriteDeps,
) => Promise<ExternalWriteResult>;

/** Injected deps for the propose activity: the gateway dispatch fn + its dep bundle. */
export interface ProposeActivityDeps {
  readonly dispatch: DispatchExternalWriteFn;
  readonly deps: ExternalWriteDeps;
}

/**
 * Build a {@link ProposeActionsPort} that dispatches through the Tool Gateway
 * (inv-4/inv-5). A first dispatch CREATES the write; a replay with the same
 * idempotencyKey REUSES the receipt (no duplicate). Approval-required fails closed.
 * Never throws.
 */
export function createProposeActivity(deps: ProposeActivityDeps): ProposeActionsPort {
  return {
    async propose(
      action: ProposedAction,
      env: ExternalWriteEnvelope,
    ): Promise<Result<ProposeResult, ProposeError>> {
      const outcome = await deps.dispatch(env, action, deps.deps);
      switch (outcome.status) {
        case "created":
        case "reused":
          return ok({
            status: outcome.status,
            envelope: { ...env, writeReceipt: outcome.receipt },
          });
        case "approval_pending":
          return err(proposeError("approval_pending", "external write awaits approval"));
        case "held":
          return err(proposeError("held", outcome.reason));
        case "conflict":
          return err(proposeError("conflict", outcome.reason));
        case "rejected":
        default:
          return err(
            proposeError(
              "rejected",
              (outcome as { reason?: string }).reason ?? "external write rejected",
            ),
          );
      }
    },
  };
}

function proposeError(code: ProposeErrorCode, message: string): ProposeError {
  return { code, message };
}
