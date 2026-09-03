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
import type { ExternalWriteDeps, ExternalWriteResult, DispatchOptions } from "@sow/integrations";
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
  /** C3 ordering — forwarded verbatim to the gateway. A propose is a FRESH dispatch
   *  and omits it; the parameter exists so a binding that DOES have an intent time
   *  (a re-drive wired through this same seam) cannot be silently truncated. */
  opts?: DispatchOptions,
) => Promise<ExternalWriteResult>;

/** Injected deps for the propose activity: the gateway dispatch fn + its dep bundle. */
export interface ProposeActivityDeps {
  readonly dispatch: DispatchExternalWriteFn;
  readonly deps: ExternalWriteDeps;
  /**
   * The proposing workspace — scopes the external-write credential (rule 4), so personal and
   * employer proposals never authenticate with the same vendor token.
   *
   * ⛔ Optional in the type, fail-closed in effect: absent ⇒ no credential resolves and the write
   * is refused. Omitting it can only deny a write, never widen one.
   */
  readonly workspaceId?: string;
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
      // RULE 4 — scope the write credential to the proposing workspace. Absent ⇒ the gateway
      // refuses rather than falling back to a credential shared across workspaces.
      const outcome = await deps.dispatch(env, action, deps.deps, {
        ...(deps.workspaceId !== undefined ? { workspaceId: deps.workspaceId } : {}),
      });
      // NOTE: a propose is always a FRESH intent, so no `intentCreatedAt` is passed —
      // it is current by definition and must never be judged out-of-date.
      switch (outcome.status) {
        case "created":
        case "updated":
        case "reused":
          return ok({
            status: outcome.status,
            envelope: { ...env, writeReceipt: outcome.receipt },
          });
        case "approval_pending":
          return err(proposeError("approval_pending", "external write awaits approval"));
        case "superseded":
          // Unreachable on a fresh propose (no `intentCreatedAt` is supplied), but
          // total by construction. Terminal, never retried.
          return err(proposeError("rejected", outcome.reason));
        case "held":
          return err(proposeError("held", outcome.reason));
        case "conflict":
          return err(proposeError("conflict", outcome.reason));
        // No `default:` — `ExternalWriteResult.status` is a CLOSED union, and a
        // catch-all on one makes a NEW status compile silently into whichever
        // disposition the fallthrough happens to have (here: terminal `rejected`).
        // A new retryable status would be permanently failed. Same defect class as
        // the `branch`/`stage` bug; the `never` binding below turns it into a
        // compile error instead.
        case "rejected":
          return err(proposeError("rejected", outcome.reason));
      }
      const unhandled: never = outcome;
      return err(proposeError("rejected", `unhandled dispatch status: ${String(unhandled)}`));
    },
  };
}

function proposeError(code: ProposeErrorCode, message: string): ProposeError {
  return { code, message };
}

// R2/§S — WHY `outcome.reason` IS FORWARDED VERBATIM HERE.
//
// An earlier round collapsed the `held`/`conflict`/`rejected` reason into a
// fixed `GENERIC_PROPOSE_REASON` sentence at this consumer. That was a
// REGRESSION: it destroyed the §21.10 credential-fault signal (a locked /
// missing / denied Keychain accessor yields a `reason` CONTAINING the closed
// token `"locked"` — how an operator tells "your Mac Keychain is locked" apart
// from "the vendor rejected the write", worker LESSONS §41) for every activity
// built on `propose()` (meetingPropose / sourcePropose / outputWorkflows.ts +
// siblings). That is the confirmed break this reversal fixes.
//
// PRECISELY WHAT MAKES THAT SAFE — and do NOT restate it more strongly than
// the mechanism supports. The gateway does NOT build `reason` "from a closed
// code only": on the held/conflict/rejected arms it INTERPOLATES the adapter's
// `AdapterError.message` (gateway.ts ~:266 / ~:310). `reason` is redaction-safe
// by TWO different provenances:
//
//   (1) GATEWAY-AUTHORED — a closed code in a fixed template, a Zod-issue
//       summary built ONLY from `.code`/`.path` (candidate-gate.ts's
//       `safeZodIssueSummary`, never Zod's value-echoing `.message`), the
//       §21.10 credential-fault token, the reservation-conflict literal.
//   (2) ADAPTER-AUTHORED — `AdapterError.message`, safe because the ADAPTER
//       builds it from CLOSED inputs. Every shipped vendor adapter
//       (calendar/todoist/linear/asana/drive/github/telegram) is produced by
//       `makeTargetWriteAdapter` (tools/adapters/adapter-core.ts), whose
//       `faultToError` composes `message` from the 4-value closed
//       `TransportFault` code plus the NUMERIC `httpStatus` — it never reads
//       the transport's free-text `detail`, so a misbehaving per-vendor
//       `mapResponse` cannot get a raw vendor body or a token-bearing URL in.
//
// RESIDUAL, stated honestly: `TargetWriteAdapter` is a plain interface, so a
// hand-written adapter that BYPASSES `makeTargetWriteAdapter` could construct
// an `AdapterError` with arbitrary `message` text and this path would forward
// it. The guarantee holds for adapters built on the shared core — not for the
// type alone. Close that residual, if it ever needs closing, AT THE ADAPTER
// BOUNDARY (adapter-core.ts) — the one place vendor text enters the system.
//
// DO NOT re-add a redaction layer at this consumer — that is exactly the
// mistake that caused the regression above, and it would silently re-strip the
// provenance-(1) credential-fault signal. If a future change reopens a real
// leak, fix it AT THE SOURCE it came from (adapter-core.ts for adapter text,
// gateway.ts for gateway text) and in that package's own suite
// (packages/integrations/test/gateway-reason-redaction.test.ts).
//
// CONTROL FLOW NEVER READS THIS STRING. A caller that must branch on the
// failure kind reads the typed `ProposeErrorCode` (or, one layer down, the
// gateway's `adapterCode` / `AdapterError.httpStatus`) — never a regex or a
// substring match on `message`. Four separate breaks in this area all came
// from reading a machine decision out of a human-readable string.
