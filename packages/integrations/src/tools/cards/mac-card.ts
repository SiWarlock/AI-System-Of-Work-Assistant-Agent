// @sow/integrations — task 21.8a: the Mac approval-card transport over the
// injected `CardSend` seam (card-port.ts). No real network in this module (§16)
// — the owner's arming bundle binds the real Mac notification/card client
// (PROV-6 territory, dormant here).
import { err, ok } from "@sow/contracts";
import type { Approval } from "@sow/contracts";
import type { CardRendererLike, CardSend, CardSendRequest } from "./card-port";
import { projectCardPayload } from "./card-port";

/** Injected deps for {@link createMacCardTransport}. */
export interface MacCardDeps {
  readonly send: CardSend;
  readonly clock: () => string;
}

/** Derive a stable, per-(approval, channel) idempotency key. Deterministic +
 *  pure — no randomness (§16). */
function macIdempotencyKey(approval: Approval, channel: Approval["channel"]): string {
  return `${approval.id}:${channel}`;
}

/**
 * Build a Mac card transport over the injected {@link CardSend}. Projects the
 * approval to a redaction-safe {@link CardPayload}, derives a stable
 * idempotency key from `approval.id` + the render channel, calls `deps.send`,
 * and maps a vendor fault to `err({ message })` using ONLY the closed fault
 * CODE (never the vendor's free-text `detail`, rule 7). A throwing `send` is
 * caught and folded to the same closed shape — never propagates (§16).
 */
export function createMacCardTransport(deps: MacCardDeps): CardRendererLike {
  return {
    async render(approval, channel) {
      const req: CardSendRequest = {
        targetChannel: "mac",
        idempotencyKey: macIdempotencyKey(approval, channel),
        card: projectCardPayload(approval),
      };
      let result;
      try {
        result = await deps.send(req);
      } catch {
        // The thrown value may embed vendor-internal detail — never included in
        // the message (rule 7). A fixed, redaction-safe diagnostic only.
        return err({ message: "mac card send faulted" });
      }
      if (result.ok) {
        return ok(undefined);
      }
      // Map ONLY the closed fault code — never `result.detail` (rule 7).
      return err({ message: result.fault });
    },
  };
}
