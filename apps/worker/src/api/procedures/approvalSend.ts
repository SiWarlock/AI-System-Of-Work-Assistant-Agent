// @sow/worker — the Approvals screen's send surface: an approval's details, the approved-but-unsent list, and
// "Send now". Linear slice 3+4, step 4d.
//
// Owner decisions (2026-09-22): details load ON OPEN and are served ONLY in the approval's own workspace (WS-8);
// the card shows the REAL send state; "Send now" re-runs the SAME guarded dispatch the decide command uses. The
// port (composition/approvalSend.ts) enforces all three; this router authenticates, validates the input, and
// re-checks every output against its UI-safe contract before it crosses to the renderer.
import { err, failure } from "@sow/contracts";
import type { FailureVariant, Result, UiSafeApproval, UiSafeApprovalDetail, UiSafeSendNowResult } from "@sow/contracts";
import { UiSafeApprovalDetailSchema, UiSafeApprovalSchema, UiSafeSendNowResultSchema } from "@sow/contracts";
import { router, publicProcedure, authedResolver } from "../router";

export interface ApprovalRefInput {
  readonly workspaceId: string;
  readonly approvalId: string;
}
export interface WorkspaceInput {
  readonly workspaceId: string;
}

/** The send surface's port. The composition root binds the real one; a test injects a fake. Never throws. */
export interface ApprovalSendPort {
  /** One approval's details — served only when `workspaceId` is the approval's own; otherwise NOT_FOUND. */
  readonly detail: (input: ApprovalRefInput) => Promise<Result<UiSafeApprovalDetail, FailureVariant>>;
  /** The workspace's approved external cards whose write has not gone out. */
  readonly unsent: (input: WorkspaceInput) => Promise<Result<readonly UiSafeApproval[], FailureVariant>>;
  /** Re-run the guarded dispatch for one approved card, then report its re-read send state. */
  readonly sendNow: (input: ApprovalRefInput) => Promise<Result<UiSafeSendNowResult, FailureVariant>>;
}

/** The port bound when nothing real is available: every call fails closed, nothing is ever faked. */
export const UNAVAILABLE_APPROVAL_SEND_PORT: ApprovalSendPort = {
  detail: async () => err(failure("degraded_unavailable", "approval send surface not bound", { cause: { code: "APPROVAL_SEND_UNAVAILABLE" } })),
  unsent: async () => err(failure("degraded_unavailable", "approval send surface not bound", { cause: { code: "APPROVAL_SEND_UNAVAILABLE" } })),
  sendNow: async () => err(failure("degraded_unavailable", "approval send surface not bound", { cause: { code: "APPROVAL_SEND_UNAVAILABLE" } })),
};

function nonEmpty(source: Record<string, unknown>, key: string): string {
  const v = source[key];
  if (typeof v !== "string" || v.length === 0) throw new Error("invalid_input");
  return v;
}
function parseApprovalRef(value: unknown): ApprovalRefInput {
  if (typeof value !== "object" || value === null) throw new Error("invalid_input");
  const source = value as Record<string, unknown>;
  return { workspaceId: nonEmpty(source, "workspaceId"), approvalId: nonEmpty(source, "approvalId") };
}
function parseWorkspace(value: unknown): WorkspaceInput {
  if (typeof value !== "object" || value === null) throw new Error("invalid_input");
  return { workspaceId: nonEmpty(value as Record<string, unknown>, "workspaceId") };
}

const UNSERVABLE = (): Result<never, FailureVariant> =>
  err(failure("validation_rejected", "approval send output failed its contract", { cause: { code: "APPROVAL_SEND_UNSERVABLE" } }));

/** Re-check an ok output against its contract; a producer bug becomes a typed error, never a leak. */
function checked<T>(res: Result<T, FailureVariant>, valid: (v: T) => boolean): Result<T, FailureVariant> {
  if (!res.ok) return res;
  return valid(res.value) ? res : UNSERVABLE();
}

export interface ApprovalSendRouterDeps {
  readonly approvalSend: ApprovalSendPort;
}

export function buildApprovalSendRouter(deps: ApprovalSendRouterDeps) {
  const { approvalSend } = deps;
  return router({
    detail: publicProcedure.input(parseApprovalRef).query(
      authedResolver<ApprovalRefInput, UiSafeApprovalDetail>(async (_ctx, input) =>
        checked(await approvalSend.detail(input), (v) => UiSafeApprovalDetailSchema.safeParse(v).success),
      ),
    ),
    unsent: publicProcedure.input(parseWorkspace).query(
      authedResolver<WorkspaceInput, readonly UiSafeApproval[]>(async (_ctx, input) =>
        checked(await approvalSend.unsent(input), (v) => v.every((a) => UiSafeApprovalSchema.safeParse(a).success)),
      ),
    ),
    sendNow: publicProcedure.input(parseApprovalRef).mutation(
      authedResolver<ApprovalRefInput, UiSafeSendNowResult>(async (_ctx, input) =>
        checked(await approvalSend.sendNow(input), (v) => UiSafeSendNowResultSchema.safeParse(v).success),
      ),
    ),
  });
}

export type ApprovalSendRouter = ReturnType<typeof buildApprovalSendRouter>;
