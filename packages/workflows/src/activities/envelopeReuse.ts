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
  /**
   * The workspace this resumed write belongs to — scopes the write credential (rule 4), so a
   * re-drive authenticates as the workspace that formed the original intent rather than through a
   * credential shared across workspaces.
   *
   * ⛔ Optional in the type, fail-closed in effect: absent ⇒ the gateway resolves NO credential and
   * the write is refused, never sent with an unscoped token.
   */
  readonly workspaceId?: string;
}

/**
 * The successful reuse outcome: the write either already existed (`reused`, no
 * second create) or was committed exactly once on this resume (`created`). Both
 * carry the authoritative write receipt.
 */
export interface EnvelopeReuseSuccess {
  /** `updated` — an IN-PLACE update of an object this system already authored (the
   *  §8 update path). Distinct from `created`: no new vendor object came into
   *  existence, so anything counting objects must not double-count it. */
  readonly status: "created" | "updated" | "reused";
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
  /**
   * C3 ORDERING — when the ORIGINAL step formed this intent (ISO-8601). A resume
   * re-drives an envelope built on a previous run, so if a fresher write landed in
   * between, applying it would revert the object. Supplying this lets the gateway
   * drop it as `superseded` instead. Absent ⇒ no ordering check (prior behaviour).
   */
  intentCreatedAt?: string,
): Promise<Result<EnvelopeReuseSuccess, EnvelopeReuseError>> {
  const outcome = await dispatchExternalWrite(
    env,
    action,
    deps.gatewayDeps,
    {
      ...(intentCreatedAt !== undefined ? { intentCreatedAt } : {}),
      ...(deps.workspaceId !== undefined ? { workspaceId: deps.workspaceId } : {}),
    },
  );
  switch (outcome.status) {
    case "created":
    case "updated":
    case "reused":
      return ok({ status: outcome.status, receipt: outcome.receipt });
    case "superseded":
      // C3 — a newer payload is already applied and THIS resumed step predates it.
      // Nothing was written, deliberately. Terminal, NOT `held`: re-driving cannot
      // make a stale intent fresher, and re-holding it would spin forever. Surfaced
      // with its reason rather than silently succeeding, because the caller asked to
      // re-drive a write that did not happen.
      return err({ code: "rejected", reason: outcome.reason });
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

// R2/§S — WHY `outcome.reason` IS FORWARDED VERBATIM HERE.
//
// An earlier round collapsed the `held`/`conflict`/`rejected` reason into a
// fixed `GENERIC_REUSE_REASON` sentence at this consumer. That was a
// REGRESSION: it destroyed the §21.10 credential-fault signal (a locked /
// missing / denied Keychain accessor yields a `reason` CONTAINING the closed
// token `"locked"` — how an operator tells "your Mac Keychain is locked" apart
// from "the vendor rejected the write", worker LESSONS §41), the same break
// already confirmed on the sibling `propose()` path
// (activities/proposeExternalActions.ts).
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
// mistake that caused the sibling regression, and it would silently re-strip
// the provenance-(1) credential-fault signal. If a future change reopens a real
// leak, fix it AT THE SOURCE it came from (adapter-core.ts for adapter text,
// gateway.ts for gateway text) and in that package's own suite
// (packages/integrations/test/gateway-reason-redaction.test.ts).
//
// The one real downstream caller, apps/worker/src/lifecycle/recovery.ts, folds
// this `reason` into an operator-facing `worker_down` HealthItem message — a
// DIFFERENT file this track does not own — and now gets the SAME value this
// activity receives, never less informative.
//
// CONTROL FLOW NEVER READS THIS STRING. A caller that must branch on the
// failure kind reads the typed `EnvelopeReuseError.code` (or, one layer down,
// the gateway's `adapterCode` / `AdapterError.httpStatus`) — never a regex or a
// substring match on `reason`. Four separate breaks in this area all came from
// reading a machine decision out of a human-readable string.
