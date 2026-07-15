import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";
import type { UiSafeCrossWorkspaceLinkView } from "../store/cross-workspace-links";

// Task 14.7 (desktop leg) — the renderer cross-workspace-link command-callers. The renderer only
// REQUESTS the owner-approval transitions — the worker (crossWorkspaceLink.create/approve/revoke)
// owns the candidate-data whitelist (a smuggled status/approvedAt is DROPPED — owner approval is a
// separate explicit transition), the immutable-anchor guard, the terminal-transition guards, and
// the UI-safe summary. These wrappers fold a typed err / transport throw / malformed ok to
// { ok: false } (desktop Lesson 6). NO pre-approval smuggling: create sends ONLY the 5 create fields.
export type { UiSafeCrossWorkspaceLinkView };

/** The whitelisted create input (NO status/approvedAt — approval is a separate explicit transition). */
export interface CreateCrossWorkspaceLinkInput {
  readonly linkId: string;
  readonly fromWorkspaceId: string;
  readonly toWorkspaceId: string;
  readonly scopeProjectionType: string;
  readonly scopeVisibilityLevel: string;
}

export type CrossWorkspaceLinkResult =
  | { readonly ok: true; readonly link: UiSafeCrossWorkspaceLinkView }
  | { readonly ok: false };

/** Accept only a well-formed ok whose value is a UI-safe link; reconstruct from the allowlist. */
function foldLink(res: { ok?: unknown; value?: unknown }): CrossWorkspaceLinkResult {
  if (res.ok !== true || res.value == null || typeof res.value !== "object") return { ok: false };
  const v = res.value as Record<string, unknown>;
  if (
    typeof v["linkId"] !== "string" ||
    typeof v["fromWorkspaceId"] !== "string" ||
    typeof v["toWorkspaceId"] !== "string" ||
    typeof v["status"] !== "string"
  ) {
    return { ok: false };
  }
  const str = (k: string): string => (typeof v[k] === "string" ? (v[k] as string) : "");
  const nullableStr = (k: string): string | null => (typeof v[k] === "string" ? (v[k] as string) : null);
  return {
    ok: true,
    link: {
      linkId: v["linkId"] as string,
      fromWorkspaceId: v["fromWorkspaceId"] as string,
      toWorkspaceId: v["toWorkspaceId"] as string,
      scopeProjectionType: str("scopeProjectionType"),
      scopeVisibilityLevel: str("scopeVisibilityLevel"),
      status: v["status"] as string,
      createdAt: str("createdAt"),
      approvedAt: nullableStr("approvedAt"),
      revokedAt: nullableStr("revokedAt"),
    },
  };
}

/** Create a PENDING cross-workspace link (owner approval is a SEPARATE explicit transition). */
export function createCrossWorkspaceLink(
  client: CreateTRPCClient<AppRouter>,
): (input: CreateCrossWorkspaceLinkInput) => Promise<CrossWorkspaceLinkResult> {
  return async (input: CreateCrossWorkspaceLinkInput): Promise<CrossWorkspaceLinkResult> => {
    try {
      return foldLink(await client.crossWorkspaceLink.create.mutate(input));
    } catch {
      return { ok: false };
    }
  };
}

/** Approve a PENDING link — the deliberate owner authorization that opens the scoped cross-read. */
export function approveCrossWorkspaceLink(
  client: CreateTRPCClient<AppRouter>,
): (linkId: string) => Promise<CrossWorkspaceLinkResult> {
  return async (linkId: string): Promise<CrossWorkspaceLinkResult> => {
    try {
      return foldLink(await client.crossWorkspaceLink.approve.mutate({ linkId }));
    } catch {
      return { ok: false };
    }
  };
}

/** Revoke a link — terminal; closes the scoped cross-read path immediately. */
export function revokeCrossWorkspaceLink(
  client: CreateTRPCClient<AppRouter>,
): (linkId: string) => Promise<CrossWorkspaceLinkResult> {
  return async (linkId: string): Promise<CrossWorkspaceLinkResult> => {
    try {
      return foldLink(await client.crossWorkspaceLink.revoke.mutate({ linkId }));
    } catch {
      return { ok: false };
    }
  };
}
