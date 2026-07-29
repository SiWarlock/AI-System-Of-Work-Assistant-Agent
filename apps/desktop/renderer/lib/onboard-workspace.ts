import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";
import type { WorkspaceType } from "@sow/contracts/primitives/enums";

// Task 14.1 (desktop leg) — the renderer onboarding command-caller. The renderer is UNTRUSTED:
// it only REQUESTS provisioning — the worker (`onboarding.createWorkspace`) owns the candidate-
// data gate, the one-writer provisioning (`provisionWorkspace`), the fail-closed WS-8 registry
// union, and the redaction-safe typed Result. This wrapper folds a typed err (validation /
// store fault / auth) OR any transport error OR a malformed ok to `{ ok: false }` so a failed
// onboarding never surfaces a raw driver cause (desktop Lesson 6 pattern).
//
// 9.21-B — EXACTLY ONE case is widened out of that fold: worker's `ONBOARDING_PARTIAL_SCAFFOLD`
// (9.21-A, `provisionErrorToFailure` in apps/worker/src/api/procedures/onboarding.ts) is a
// distinguishable REPAIRABLE state — the workspace config row was durably written, only the
// registry union is incomplete, and re-running resumes idempotently. Every OTHER typed err
// (validation / a different degraded_unavailable cause / auth), malformed ok, and transport
// throw still folds to the same opaque `{ ok: false }` as before. `reason` is a CLOSED literal
// with no message/detail field at all — mirroring the 9.35 `ErrorBoundary.fallback` shape —
// so rule 7 is enforced by the type (there is nothing to leak), not by discipline.

/** The onboarding form input the user fills (the worker re-validates every field server-side). */
export interface OnboardWorkspaceInput {
  readonly id: string;
  readonly name: string;
  readonly type: WorkspaceType;
  readonly vaultRoot: string;
  readonly gbrainBrainId: string;
  readonly preset: string;
}

/** The worker's UI-safe provisioned summary (safe scalars only — no raw content). */
export interface UiSafeProvisioned {
  readonly workspaceId: string;
  readonly registryMember: boolean;
  readonly preset: string;
}

export type OnboardResult =
  | { readonly ok: true; readonly workspace: UiSafeProvisioned }
  | { readonly ok: false; readonly reason?: "partial_scaffold" };

/** Build the onboarding command-caller over a live tRPC client. */
export function createOnboardWorkspace(
  client: CreateTRPCClient<AppRouter>,
): (input: OnboardWorkspaceInput) => Promise<OnboardResult> {
  return async (input: OnboardWorkspaceInput): Promise<OnboardResult> => {
    try {
      const res = await client.onboarding.createWorkspace.mutate(input);
      // Accept only a well-formed ok result carrying a non-empty string workspaceId. There is
      // no `.strict()` Zod schema for the provisioned summary (a plain UI-safe interface), so
      // this scalar re-gate is the defense-in-depth: a leaky/malformed record from a future
      // server-projector regression folds to `{ ok: false }`, never surfaced with a raw field.
      if (
        res.ok === true &&
        res.value != null &&
        typeof res.value === "object" &&
        typeof res.value.workspaceId === "string" &&
        res.value.workspaceId.length > 0
      ) {
        return {
          ok: true,
          workspace: {
            workspaceId: res.value.workspaceId,
            registryMember: res.value.registryMember === true,
            preset: typeof res.value.preset === "string" ? res.value.preset : "",
          },
        };
      }
      // Admit EXACTLY the partial-scaffold case out of the fold — every other typed err (a
      // different degraded_unavailable cause, validation_rejected, auth) and every malformed ok
      // stays the opaque failure below. Each level is narrowed before being read (candidate data
      // off the wire) so a malformed/foreign shape can never accidentally match.
      if (
        res.ok === false &&
        res.error != null &&
        typeof res.error === "object" &&
        "cause" in res.error &&
        res.error.cause != null &&
        typeof res.error.cause === "object" &&
        "code" in res.error.cause &&
        res.error.cause.code === "ONBOARDING_PARTIAL_SCAFFOLD"
      ) {
        return { ok: false, reason: "partial_scaffold" };
      }
      // A typed err (validation_rejected / degraded_unavailable / auth) or a malformed ok → fail closed.
      return { ok: false };
    } catch {
      // Transport failure → fail closed (never surface a partial / raw provisioning result).
      return { ok: false };
    }
  };
}
