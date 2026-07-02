// @sow/workflows — slice 7.3 ACTIVITY: external-write ENVELOPE REUSE on resume
// (§8, §20.1, LIFE-3).
//
// This is an ACTIVITY, NOT workflow code — it runs on the worker side and MAY use
// adapters. (It still takes ALL its effects injected so it is Vitest-unit-testable
// with fakes and never touches a real network in the module.) When a re-entered
// run re-drives an external side effect, it MUST reuse the SAME
// ExternalWriteEnvelope it built the first time (identical idempotencyKey +
// canonicalObjectKey + payloadHash). We hand that envelope straight to the §8 Tool
// Gateway (`dispatchExternalWrite` from @sow/integrations): the gateway's stored-
// receipt replay gate + mandatory pre-write existence check guarantee that a
// re-driven step performs NO duplicate external write —
//   • receipt already recorded for the key ⇒ gateway returns `reused`;
//     adapter.create is NEVER called again (the §20.1 replay gate).
//   • no receipt yet ⇒ gateway issues EXACTLY ONE create (`created`).
// We do NOT re-implement the no-dup guarantee here — we lean on the Phase-6
// reservation/receipt path that already provides it.
//
// §16 error convention: we NEVER throw across the activity boundary. The gateway's
// non-terminal / fail-closed outcomes (`held` / `approval_pending`) and its typed
// failures (`conflict` / `rejected`) are folded into a typed `Result` err with an
// ENUMERABLE closed code set — a held (fail-closed) resume is an error the caller
// re-holds, never a silent success.
import { ok, err } from "@sow/contracts";
import type { Result, ExternalWriteEnvelope, ProposedAction, WriteReceipt } from "@sow/contracts";
import { dispatchExternalWrite } from "@sow/integrations";
import type { ExternalWriteDeps } from "@sow/integrations";

/** Injected deps for the reuse activity — the SAME dep bundle the live gateway uses. */
export interface EnvelopeReuseDeps {
  readonly gatewayDeps: ExternalWriteDeps;
}

/**
 * The successful reuse outcome: the write either already existed (`reused`, no
 * second create) or was committed exactly once on this resume (`created`). Both
 * carry the authoritative write receipt.
 */
export interface EnvelopeReuseSuccess {
  readonly status: "created" | "reused";
  readonly receipt: WriteReceipt;
}

/**
 * The closed, enumerable failure set of the reuse activity (§16). `held` — the
 * gateway could not confirm safe dispatch (unreachable existence probe /
 * in-progress reservation) and FAILED CLOSED (no create issued); the caller
 * re-holds via the outbox. `approval_pending` — the write awaits approval.
 * `conflict` — the vendor rejected on a precondition clash (never a blind
 * overwrite). `rejected` — the vendor/gate refused (validation/auth).
 */
export interface EnvelopeReuseError {
  readonly code: "held" | "approval_pending" | "conflict" | "rejected";
  readonly reason: string;
}

/**
 * Re-drive an external side effect on resume, reusing the SAME envelope. Returns a
 * typed Result (never throws). A `reused` outcome proves zero duplicate external
 * writes — adapter.create was NOT called a second time.
 */
export async function reuseExternalWriteOnResume(
  env: ExternalWriteEnvelope,
  action: ProposedAction,
  deps: EnvelopeReuseDeps,
): Promise<Result<EnvelopeReuseSuccess, EnvelopeReuseError>> {
  const outcome = await dispatchExternalWrite(env, action, deps.gatewayDeps);
  switch (outcome.status) {
    case "created":
    case "reused":
      return ok({ status: outcome.status, receipt: outcome.receipt });
    case "approval_pending":
      return err({ code: "approval_pending", reason: "external write awaits approval" });
    case "held":
      return err({ code: "held", reason: outcome.reason });
    case "conflict":
      return err({ code: "conflict", reason: outcome.reason });
    case "rejected":
    default:
      return err({ code: "rejected", reason: outcome.reason });
  }
}
