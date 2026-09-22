import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";
import {
  UiSafeApprovalDetailSchema,
  UiSafeApprovalSchema,
  UiSafeSendNowResultSchema,
  type UiSafeApproval,
  type UiSafeApprovalDetail,
  type UiSafeSendNowResult,
} from "@sow/contracts/api/ui-safe";

// Linear slice 3+4, step 5 — the renderer callers for the Approvals screen's send surface (`approvalSend.*`).
// The renderer only REQUESTS: the worker serves details only for the workspace it is asked about (WS-8), and the
// App always asks with the ACTIVE scope's workspace. Worker output is candidate data here too (desktop L46): an
// error, a thrown transport and an ok value that fails its UI-safe contract (e.g. an extra `payload` key) all fold
// to { ok: false } — the screen then shows "unavailable", never a partial or raw result.

export type ApprovalDetailResult = { readonly ok: true; readonly detail: UiSafeApprovalDetail } | { readonly ok: false };
export type UnsentApprovalsResult = { readonly ok: true; readonly approvals: readonly UiSafeApproval[] } | { readonly ok: false };
export type SendNowResult = { readonly ok: true; readonly result: UiSafeSendNowResult } | { readonly ok: false };

export function createApprovalDetail(
  client: CreateTRPCClient<AppRouter>,
): (workspaceId: string, approvalId: string) => Promise<ApprovalDetailResult> {
  return async (workspaceId, approvalId) => {
    try {
      const res = await client.approvalSend.detail.query({ workspaceId, approvalId });
      if (res.ok !== true) return { ok: false };
      const parsed = UiSafeApprovalDetailSchema.safeParse(res.value);
      return parsed.success ? { ok: true, detail: parsed.data } : { ok: false };
    } catch {
      return { ok: false };
    }
  };
}

export function createUnsentApprovals(
  client: CreateTRPCClient<AppRouter>,
): (workspaceId: string) => Promise<UnsentApprovalsResult> {
  return async (workspaceId) => {
    try {
      const res = await client.approvalSend.unsent.query({ workspaceId });
      if (res.ok !== true || !Array.isArray(res.value)) return { ok: false };
      const approvals: UiSafeApproval[] = [];
      for (const item of res.value) {
        const parsed = UiSafeApprovalSchema.safeParse(item);
        if (!parsed.success) return { ok: false }; // one bad row voids the list: a wrong list is worse than none
        approvals.push(parsed.data);
      }
      return { ok: true, approvals };
    } catch {
      return { ok: false };
    }
  };
}

export function createSendNow(
  client: CreateTRPCClient<AppRouter>,
): (workspaceId: string, approvalId: string) => Promise<SendNowResult> {
  return async (workspaceId, approvalId) => {
    try {
      const res = await client.approvalSend.sendNow.mutate({ workspaceId, approvalId });
      if (res.ok !== true) return { ok: false };
      const parsed = UiSafeSendNowResultSchema.safeParse(res.value);
      return parsed.success ? { ok: true, result: parsed.data } : { ok: false };
    } catch {
      return { ok: false };
    }
  };
}
