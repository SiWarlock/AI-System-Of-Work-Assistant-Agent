import type { CreateTRPCClient } from "@trpc/client";
import type { AnyTRPCRouter } from "@trpc/server";
import type { UiSafeCopilotAnswer } from "@sow/contracts/api/ui-safe";

// §9.6 A5 Copilot ask (renderer side). The renderer is UNTRUSTED: it only REQUESTS an answer —
// the worker (`query.copilotAsk`) does the workspace-scoped retrieval, governed synthesis, and the
// UI-safe candidate-data gate server-side, returning either a validated `UiSafeCopilotAnswer` or a
// typed err. This wrapper folds a typed err (WS-8 / gate rejection) OR any transport error to
// `{ ok: false }` so nothing raw or partial is ever surfaced on a failed ask.

export type AskResult =
  | { readonly ok: true; readonly answer: UiSafeCopilotAnswer }
  | { readonly ok: false };

/** Build the Copilot ask caller over a live tRPC client. */
export function createAskCopilot(
  client: CreateTRPCClient<AnyTRPCRouter>,
): (workspaceId: string, question: string) => Promise<AskResult> {
  return async (workspaceId: string, question: string): Promise<AskResult> => {
    try {
      // Generic-router client (full AppRouter typing deferred) → dynamic access.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = client as any;
      const res = await c.query.copilotAsk.query({ workspaceId, question });
      if (res?.ok === true && res.value !== undefined && res.value !== null) {
        return { ok: true, answer: res.value as UiSafeCopilotAnswer };
      }
      // A typed err (WS-8 fail-closed / candidate-data gate rejection) → no answer.
      return { ok: false };
    } catch {
      // Transport failure → fail closed (never surface a partial / raw result).
      return { ok: false };
    }
  };
}
