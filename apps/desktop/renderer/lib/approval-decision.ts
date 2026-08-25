import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";
import { UiSafeApprovalSchema, type UiSafeApproval } from "@sow/contracts/api/ui-safe";

// §9.8 S3 approval decision (renderer side). The renderer is UNTRUSTED: it only
// REQUESTS a decision — the worker (`command.decideApproval`) owns the exactly-once
// CAS, the one-writer dispatch, and the UI-safe projection (S2). This wrapper:
//   - carries the FIXED `mac` channel — this IS the Mac app; Mac+Telegram parity (a
//     cross-channel double-apply collapsing to exactly one transition) is enforced
//     server-side, so the renderer never sends anything but its own channel;
//   - returns the worker's authoritative post-CAS UI-safe record on ok, so the caller
//     folds it straight into the inbox Map (no re-query — it IS the new truth);
//   - folds a typed err (CAS conflict on an already-terminal item / not-found / auth)
//     OR any transport error to `{ ok: false }` — a failed decision surfaces nothing.

/**
 * The four channel-agnostic decisions the inbox offers. Defined locally (a UI-level
 * concept — the four buttons); the worker RE-VALIDATES against its frozen
 * `APPROVAL_DECISIONS` set, so this union is a convenience, never the authority.
 */
export type ApprovalDecision = "approve" | "edit" | "reject" | "defer";

/**
 * §9.8 — a client-visible outcome, distinct from a transport failure. `"already_resolved"` is the
 * CAS's exactly-once loser (a `write_conflict`: the item transitioned via another channel/click
 * before this decision landed) — the honest, expected outcome of losing a race, not an error. Every
 * other failure (not-found / auth / malformed / a thrown transport error) folds to `"unavailable"`.
 * A CLOSED two-value union so the worker's `FailureVariant` enum + its prose message never reach the
 * renderer (rule 7) — only this reason survives the fold.
 */
export type DecisionResult =
  | { readonly ok: true; readonly applied: boolean; readonly approval: UiSafeApproval }
  | { readonly ok: false; readonly reason: "already_resolved" | "unavailable" };

/** Build the approval-decision caller over a live tRPC client. */
export function createApprovalDecision(
  client: CreateTRPCClient<AppRouter>,
): (approvalId: string, decision: ApprovalDecision) => Promise<DecisionResult> {
  return async (approvalId: string, decision: ApprovalDecision): Promise<DecisionResult> => {
    try {
      const res = await client.command.decideApproval.mutate({ approvalId, decision, channel: "mac" });
      // Accept only a well-formed ok result whose approval RE-VALIDATES against the
      // UI-safe schema (.strict). Defense-in-depth mirroring the stream path
      // (event-stream.ts safeParses every event): the server already projects to
      // UI-safe (S2) + the type now says so, so this is belt-and-suspenders — a
      // leaky/malformed record from a future server-projector regression is DROPPED
      // (fold to {ok:false}), never folded into the inbox with a raw `actor`/`payloadHash`.
      if (res.ok === true && res.value != null && typeof res.value === "object") {
        const parsed = UiSafeApprovalSchema.safeParse(res.value.approval);
        if (parsed.success) {
          // `applied` is NOT schema-validated (only `approval` is) — keep the strict-boolean
          // coercion so a malformed non-boolean from a server regression folds to `false`.
          return { ok: true, applied: res.value.applied === true, approval: parsed.data };
        }
      }
      // A typed err (CAS conflict / not-found / auth) or a malformed/leaky result → fail closed.
      // Only a write_conflict (the CAS's exactly-once loser) is the honest "already resolved";
      // everything else (not-found / auth / degraded / a malformed or leaky ok) is "unavailable".
      // The worker's `kind`/`message`/`cause` never survive the fold (rule 7).
      return { ok: false, reason: res.ok === false && res.error.kind === "write_conflict" ? "already_resolved" : "unavailable" };
    } catch {
      // Transport failure → fail closed (never surface a partial / stale decision).
      return { ok: false, reason: "unavailable" };
    }
  };
}
