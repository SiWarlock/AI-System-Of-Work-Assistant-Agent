import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";
import {
  UiSafeLinearProposalResultSchema,
  UiSafeLinearTeamListSchema,
  type UiSafeLinearProposalResult,
  type UiSafeLinearTeamList,
} from "@sow/contracts/api/ui-safe";

// Linear slice 5a, part 4 — the renderer callers for the New Linear issue form (`linearIssue.*`). The renderer only
// REQUESTS, and the App always passes the ACTIVE scope's workspace. Worker output is candidate data here too
// (desktop L46): an error, a thrown transport, and an ok value that fails its UI-safe contract all fold to
// { ok: false } — the form then says it could not load or propose, never shows a partial or raw result.

export type LinearTeamsResult = { readonly ok: true; readonly list: UiSafeLinearTeamList } | { readonly ok: false };
export type ProposeLinearIssueResult = { readonly ok: true; readonly result: UiSafeLinearProposalResult } | { readonly ok: false };

/**
 * One submission of the form, WITHOUT a workspace — the App adds the active one. `draftId` is minted when the form
 * opens and kept until a proposal lands, so a retry is the same proposal (rule 3). No owner, no date (REQ-F-017).
 */
export interface LinearIssueDraft {
  readonly draftId: string;
  readonly teamId: string;
  readonly title: string;
  readonly description: string;
  /** Linear's priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  readonly priority: number;
}

export function createLinearTeams(client: CreateTRPCClient<AppRouter>): (workspaceId: string) => Promise<LinearTeamsResult> {
  return async (workspaceId) => {
    try {
      const res = await client.linearIssue.teams.query({ workspaceId });
      if (res.ok !== true) return { ok: false };
      const parsed = UiSafeLinearTeamListSchema.safeParse(res.value);
      return parsed.success ? { ok: true, list: parsed.data } : { ok: false };
    } catch {
      return { ok: false };
    }
  };
}

export function createProposeLinearIssue(
  client: CreateTRPCClient<AppRouter>,
): (workspaceId: string, draft: LinearIssueDraft) => Promise<ProposeLinearIssueResult> {
  return async (workspaceId, draft) => {
    try {
      const res = await client.linearIssue.propose.mutate({ workspaceId, ...draft });
      if (res.ok !== true) return { ok: false };
      const parsed = UiSafeLinearProposalResultSchema.safeParse(res.value);
      return parsed.success ? { ok: true, result: parsed.data } : { ok: false };
    } catch {
      return { ok: false };
    }
  };
}
