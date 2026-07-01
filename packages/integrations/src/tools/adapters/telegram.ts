// @sow/integrations — 6.4 TELEGRAM write adapter (send card / notification).
//
// UNLIKE the object-oriented targets (calendar/drive/…), a Telegram send has no
// mutable external "object" — its dedupe identity IS the idempotencyKey (send
// once per key). So this adapter's per-target identity is keyed on the
// idempotencyKey (`sendKey`), and the transport is expected to be idempotent on
// it: a re-send of the SAME idempotencyKey echoes the same message WITHOUT a
// second post (the fake/real transport returns `deduped:true`). This makes the
// no-duplicate invariant hold for a non-object target: the existence probe + the
// transport's idempotency echo together guarantee a single post.
//
// arch_gap: §8 names no per-target identity contract for a Telegram send — we
// adopt {sendKey: idempotencyKey} because the send is keyed by the replay/dedupe
// key, not a persistent object identity.
import type { TargetWriteAdapter } from "../adapter-port";
import type { AdapterDeps } from "./adapter-core";
import { makeTargetWriteAdapter } from "./adapter-core";

/**
 * Factory: a Telegram `TargetWriteAdapter` over the injected transport + clock.
 * Send a card/notification, idempotent on the idempotencyKey (a re-send of the
 * same key does NOT double-post — the transport echoes the prior message).
 */
export function createTelegramWriteAdapter(deps: AdapterDeps): TargetWriteAdapter {
  return makeTargetWriteAdapter(
    {
      targetSystem: "telegram",
      deriveIdentity: (env) => ({ sendKey: env.idempotencyKey }),
    },
    deps,
  );
}
