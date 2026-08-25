// @sow/integrations — task 21.8a: the Telegram approval-card transport over the
// injected `CardSend` seam (card-port.ts).
//
// Resolves the bot token via the 17.4 write-secret ref convention
// (`writeSecretRef("telegram")` === "keychain://telegram-bot/*",
// adapters/adapter-core.ts:102) through the injected `WriteSecretsAccessor`
// (adapter-core.ts:91), and FAILS CLOSED on an unavailable / throwing /
// whitespace-only token — exactly as `resolveWriteCredentialFault` does at
// `tools/gateway.ts:133` (rule 7): no unauthenticated send, and the resolved
// token value is read ONLY to hand to `deps.send` via the dedicated `auth`
// field — NEVER inside `CardPayload`, never in a fault, never in a returned
// message.
//
// Telegram sends have no persistent object identity — per the
// `createTelegramWriteAdapter` header (`adapters/telegram.ts:1-15`) their
// dedupe identity IS the idempotencyKey. A `deduped:true` echo from
// `deps.send` is honoured as a SUCCESSFUL render, never a distinct failure or
// a second post.
//
// No real network/Keychain backend in this module (§16) — the owner's arming
// bundle binds the real Telegram client + Keychain-backed accessor (PROV-6
// territory, dormant here).
import { err, ok } from "@sow/contracts";
import type { Approval, Result } from "@sow/contracts";
import { writeSecretRef } from "../adapters/adapter-core";
import type { WriteSecretsAccessor } from "../adapters/adapter-core";
import type { CardRendererLike, CardSend, CardSendRequest } from "./card-port";
import { projectCardPayload } from "./card-port";

/** Injected deps for {@link createTelegramCardTransport}. */
export interface TelegramCardDeps {
  readonly send: CardSend;
  readonly secrets: WriteSecretsAccessor;
  readonly clock: () => string;
}

/** Derive a stable, per-(approval, channel) idempotency key — the SAME shape
 *  as the Mac transport's, kept local (no cross-file constant needed for two
 *  literal-identical one-liners; see mac-card.ts's `macIdempotencyKey`). */
function telegramIdempotencyKey(approval: Approval, channel: Approval["channel"]): string {
  return `${approval.id}:${channel}`;
}

/**
 * Resolve the Telegram bot token at send-time, fail-closed. Mirrors
 * `resolveWriteCredentialFault` (`tools/gateway.ts:133`) message-for-message:
 * an unavailable accessor ⇒ `"write credential unavailable: <reason>"`; an
 * empty/whitespace-only token ⇒ `"write credential unavailable: empty"`; a
 * throwing accessor ⇒ `"write credential resolution faulted"` (caught, never
 * propagates). The token value is returned on success ONLY so the caller can
 * hand it to `deps.send` via `auth` — never logged, never echoed in a fault.
 */
async function resolveTelegramToken(
  secrets: WriteSecretsAccessor,
): Promise<Result<string, string>> {
  try {
    const got = await secrets.getSecret(writeSecretRef("telegram"));
    if (!got.ok) {
      return err(`write credential unavailable: ${got.error.reason}`);
    }
    if (got.value.trim().length === 0) {
      return err("write credential unavailable: empty");
    }
    return ok(got.value);
  } catch {
    return err("write credential resolution faulted");
  }
}

/**
 * Build a Telegram card transport over the injected {@link CardSend} +
 * {@link WriteSecretsAccessor}. Resolves the bot token BEFORE any send;
 * projects the approval to a redaction-safe `CardPayload`; derives a stable
 * idempotency key from `approval.id` + the render channel; calls `deps.send`
 * with the token riding ONLY `auth`; maps a vendor fault to `err({ message })`
 * using ONLY the closed fault CODE (never `detail`, rule 7). A throwing `send`
 * is caught and folded to the same closed shape — never propagates (§16).
 */
export function createTelegramCardTransport(deps: TelegramCardDeps): CardRendererLike {
  return {
    async render(approval, channel) {
      const token = await resolveTelegramToken(deps.secrets);
      if (!token.ok) {
        return err({ message: token.error });
      }
      const req: CardSendRequest = {
        targetChannel: "telegram",
        idempotencyKey: telegramIdempotencyKey(approval, channel),
        card: projectCardPayload(approval),
        auth: token.value,
      };
      let result;
      try {
        result = await deps.send(req);
      } catch {
        return err({ message: "telegram card send faulted" });
      }
      if (result.ok) {
        // A `deduped:true` echo (idempotent re-send of the same key) counts as
        // a successful render — never a distinct failure or a second post.
        return ok(undefined);
      }
      return err({ message: result.fault });
    },
  };
}
