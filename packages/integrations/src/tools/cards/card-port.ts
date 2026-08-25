// @sow/integrations — task 21.8a: the approval-card SEAM shared by both the Mac
// and Telegram card transports (mac-card.ts / telegram-card.ts).
//
// Mirrors the header of `tools/adapters/transport.ts:1-18`: NO real network
// lives in this module (§16). Each transport takes an injected `CardSend` — a
// test injects a capturing fake; the owner's arming bundle binds the real
// vendor client (PROV-6 territory — no worker wiring happens in this slice).
//
// `CardPayload` is a REDACTION-SAFE projection of a pending `Approval` (safety
// rule 7): it is a straight PICK of exactly the fields named below — never a
// spread of the approval, so a field the schema might grow later (or an
// unrelated free-text field like `actor`) can never ride along silently. It
// carries NO raw content, prompt, or free-text body.
import type { Approval, Result } from "@sow/contracts";

/**
 * A redaction-safe projection of a pending {@link Approval}. Identity + routing
 * only — never a secret, raw content, a prompt, or a free-text body (rule 7).
 * `channel` here is the approval's OWN recorded channel (a straight field pick),
 * not the render-loop's per-call channel argument — see {@link projectCardPayload}.
 */
export interface CardPayload {
  readonly approvalId: Approval["id"];
  readonly subjectKind: Approval["subjectKind"];
  readonly actionRef?: Approval["actionRef"];
  readonly channel: Approval["channel"];
  readonly payloadHash: Approval["payloadHash"];
  readonly expiresAt?: Approval["expiresAt"];
}

/**
 * Project an `Approval` to its redaction-safe {@link CardPayload}. A DELIBERATE
 * field-by-field pick (never `{...approval}`) so `workspaceId` / `status` /
 * `actor` / `planRef` / `snoozeUntil` — none of them declared safe here — can
 * never leak through by a future spread refactor. Pure, no I/O.
 */
export function projectCardPayload(approval: Approval): CardPayload {
  return {
    approvalId: approval.id,
    subjectKind: approval.subjectKind,
    ...(approval.actionRef !== undefined ? { actionRef: approval.actionRef } : {}),
    channel: approval.channel,
    payloadHash: approval.payloadHash,
    ...(approval.expiresAt !== undefined ? { expiresAt: approval.expiresAt } : {}),
  };
}

/**
 * One outbound card-send request. `targetChannel` is which vendor sink this
 * request is FOR (mac vs telegram) — named distinctly from `card.channel` (the
 * approval's own recorded channel) so a render-on-both-channels caller can't
 * conflate "who I'm sending to" with "what the approval says". `auth` carries a
 * resolved per-channel credential (telegram's bot token) — NEVER inside `card`,
 * never in a fault, never in a returned message (rule 7).
 */
export interface CardSendRequest {
  readonly targetChannel: "mac" | "telegram";
  readonly idempotencyKey: string;
  readonly card: CardPayload;
  readonly auth?: string;
}

/**
 * The closed card-send outcome. `deduped:true` is a SUCCESSFUL idempotent echo
 * (a re-send of the same `idempotencyKey`) — not a second post; a caller counts
 * it as rendered. `ok:false` carries a CLOSED, code-only fault; `detail` is a
 * free-text diagnostic from the (untrusted) vendor path and is NEVER surfaced by
 * a transport's mapped error (rule 7 — a transport maps only the closed `fault`).
 */
export type CardSendResult =
  | { readonly ok: true; readonly deduped?: boolean }
  | {
      readonly ok: false;
      readonly fault: "unreachable" | "rejected" | "unknown";
      readonly detail: string;
    };

/**
 * The injected send seam. NO real network in this module — the test injects a
 * capturing fake; the owner's arming bundle binds the real vendor client
 * (dormant here, PROV-6 territory).
 */
export type CardSend = (req: CardSendRequest) => Promise<CardSendResult>;

/**
 * The structural shape both `createMacCardTransport` and
 * `createTelegramCardTransport` return — mirrors `@sow/workflows`'
 * `CardRenderer` (`approvalTransition.ts:167`) field-for-field. Re-declared
 * HERE rather than imported: `@sow/integrations` does not depend on
 * `@sow/workflows` (deps: contracts/db/domain/policy), the same layering reason
 * the read-side template re-declares its seams at
 * `connectors/adapters/http-transport.ts:46-61`. TS structural typing means an
 * object satisfying this shape also satisfies the real `CardRenderer` at the
 * worker's bind site — no cast needed there.
 */
export interface CardRendererLike {
  render(
    approval: Approval,
    channel: Approval["channel"],
  ): Promise<Result<void, { message: string }>>;
}
