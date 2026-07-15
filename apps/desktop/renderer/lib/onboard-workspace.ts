import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";
import type { WorkspaceType } from "@sow/contracts/primitives/enums";

// Task 14.1 (desktop leg) — the renderer onboarding command-caller. The renderer is UNTRUSTED:
// it only REQUESTS provisioning — the worker (`onboarding.createWorkspace`) owns the candidate-
// data gate, the one-writer provisioning (`provisionWorkspace`), the fail-closed WS-8 registry
// union, and the redaction-safe typed Result. This wrapper folds a typed err (validation /
// store fault / auth) OR any transport error OR a malformed ok to `{ ok: false }` so a failed
// onboarding never surfaces a raw driver cause / partial state (desktop Lesson 6 pattern).

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
  | { readonly ok: false };

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
      // A typed err (validation_rejected / degraded_unavailable / auth) or a malformed ok → fail closed.
      return { ok: false };
    } catch {
      // Transport failure → fail closed (never surface a partial / raw provisioning result).
      return { ok: false };
    }
  };
}
