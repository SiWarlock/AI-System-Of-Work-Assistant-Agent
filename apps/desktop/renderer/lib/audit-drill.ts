import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";
import { UiSafeAuditDrillSummarySchema, type UiSafeAuditDrillSummary } from "@sow/contracts/api/ui-safe";

// 9.41 leg C — the renderer audit-drill caller. The renderer only REQUESTS — the worker
// (`query.auditDrill`) re-derives the AuditRecord server-side from the opaque `changeId` and
// re-checks WS-8 scope-ownership. This wrapper folds a typed denial (err Result), a transport
// error, AND a malformed-but-ok / schema-invalid runtime value (desktop L46 — worker output is
// candidate data to the renderer too) ALL to { ok: false } — the three must be indistinguishable
// to the caller (leg B mints distinct codes server-side for the operator; those never reach here).

export type AuditDrillResult =
  | { readonly ok: true; readonly summary: UiSafeAuditDrillSummary }
  | { readonly ok: false };

/** Build the audit-drill caller over a live tRPC client. */
export function createAuditDrill(
  client: CreateTRPCClient<AppRouter>,
): (workspaceId: string, changeId: string) => Promise<AuditDrillResult> {
  return async (workspaceId: string, changeId: string): Promise<AuditDrillResult> => {
    try {
      const res = await client.query.auditDrill.query({ workspaceId, changeId });
      if (res.ok !== true) return { ok: false };
      // Re-validate against the SAME contract schema the worker gated it with (desktop L46) — this
      // is the arc's first content-bearing crossing, so this re-gate is load-bearing, not ceremony.
      const parsed = UiSafeAuditDrillSummarySchema.safeParse(res.value);
      if (!parsed.success) return { ok: false };
      return { ok: true, summary: parsed.data };
    } catch {
      // Transport failure → fail closed (never surface a partial / raw result).
      return { ok: false };
    }
  };
}
