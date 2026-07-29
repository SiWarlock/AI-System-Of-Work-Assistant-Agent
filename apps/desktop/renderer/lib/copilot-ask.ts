import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";
import { UiSafeCopilotAnswerSchema, type UiSafeCopilotAnswer } from "@sow/contracts/api/ui-safe";

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
  client: CreateTRPCClient<AppRouter>,
): (workspaceId: string, question: string) => Promise<AskResult> {
  return async (workspaceId: string, question: string): Promise<AskResult> => {
    try {
      const res = await client.query.copilotAsk.query({ workspaceId, question });
      // A typed err (WS-8 fail-closed / candidate-data gate rejection) → no answer.
      if (res.ok !== true) return { ok: false };
      // 9.26 — RE-VALIDATE the payload client-side against the SAME contract schema the worker
      // gated it with. The renderer treats worker output as CANDIDATE DATA, matching the four
      // sibling read paths in `live.ts` (approvals · ingestion · calendar · task-rollup); this path
      // was the only one that didn't, on the single surface that renders a server-derived string
      // verbatim into the DOM.
      //
      // ⚠ ADAPTATION (deliberate, ratified — do NOT "fix" this into a partial render): the siblings
      // validate ARRAYS and drop the malformed ITEM while keeping the rest. An answer is a single
      // object, so there is no per-item drop — the faithful analog is reject the WHOLE payload and
      // fold to {ok:false}, which the caller renders as ASK_FAILED. Same posture (a rejection never
      // renders), different mechanics. A half-rendered answer reading as complete is the hazard.
      //
      // Uses the CONTRACT schema, never a local re-declaration: a renderer gate stricter than the
      // producer gate would silently turn working answers into ASK_FAILED, which reads as a worker
      // fault and is harder to diagnose than no re-gate at all (pinned at the cap boundaries).
      const parsed = UiSafeCopilotAnswerSchema.safeParse(res.value);
      if (!parsed.success) return { ok: false };
      return { ok: true, answer: parsed.data };
    } catch {
      // Transport failure → fail closed (never surface a partial / raw result).
      return { ok: false };
    }
  };
}
