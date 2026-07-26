import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";

// Task 9.10-C (desktop leg) — the renderer egress-posture callers (9.10 REQ-S-002, ⚠ safety rule 5).
//
// READ  = `systemHealth.egressStatus` — the per-workspace Employer-Work raw-cloud-egress posture.
// WRITE = `egressCommand.revokeEgressAck` — the ONE mutating affordance: the audited, fail-SAFE OFF
//         command shipped by worker #53 (`225c10ca`). The renderer NEVER flips policy locally; it
//         only REQUESTS, and the worker owns the get-before-upsert + audit + WS-8 re-gate.
//
// There is deliberately NO ack-ON caller here. Turning employer raw-cloud egress ON is an owner-gated
// rule-5 crossing performed at PROVISIONING time (`bcde3d61`), and the worker exposes no re-ack
// command — so a renderer path to it must not exist. A test pins that absence (exports + naming).
// ⚠ SCOPE OF THAT CLAIM (Step-9 Finding, worker track): it holds for the egress API only. Provisioning
// itself is NOT ack-preserving today — `provisionWorkspace.ts` re-seeds the employer ack BEFORE its
// existence check, so re-onboarding an existing employer workspace (`onboarding.createWorkspace`, also
// on this same live handle) restores ack=true with a fresh `acknowledgedAt` and NO audit row. Until
// that is fixed worker-side, a revoke is durable against this surface but not against a re-provision.
//
// Both callers RECONSTRUCT from the three allowlisted fields, so a widened/leaky server payload (a
// projector regression) cannot carry raw content, a secret ref, or a path into the UI (rule 7). A typed
// err / transport throw / malformed ok all fold to `{ ok: false }` (desktop Lesson 6) — which the
// surface renders as "posture unavailable", NEVER as acknowledged: an unknown posture must never read
// as permission.

/** The renderer's view of the worker's UI-safe egress projection — exactly the 3 allowlisted fields.
 *  A local view type (mirroring `cross-workspace-link.ts`) rather than a `@sow/worker` type import, so
 *  the renderer's node-heavy type surface stays narrow (desktop Lesson 5); the runtime guard is the
 *  allowlist reconstruction below. ⚠ Documented pair with `apps/worker/src/api/procedures/systemHealth.ts`
 *  `UiSafeEgressStatus` — a worker-side rename/removal of a field degrades to "posture unavailable"
 *  at runtime (the honest direction) rather than failing to compile here. */
export interface UiSafeEgressStatusView {
  readonly workspaceId: string;
  readonly employerRawEgressAcknowledged: boolean;
  readonly zeroEgressOnly: boolean;
}

/** Fail-closed result: an `ok:false` means UNKNOWN posture / command-not-applied — never "allowed". */
export type EgressStatusResult =
  | { readonly ok: true; readonly status: UiSafeEgressStatusView }
  | { readonly ok: false };

/**
 * Accept only a well-formed ok whose value carries all three allowlisted fields with their exact
 * primitive types, then REBUILD from that allowlist. A missing / non-boolean ack is rejected outright
 * (never coerced, never defaulted) — a fault must not manufacture a posture in either direction.
 *
 * The returned `workspaceId` must also EQUAL the requested one: a posture is only meaningful bound to
 * its workspace, so a server-side projector/command regression answering with a different workspace's
 * posture folds to UNKNOWN rather than rendering one workspace's "acknowledged" under another's label
 * (WS-8 + rule 5).
 */
function foldStatus(res: { ok?: unknown; value?: unknown }, workspaceId: string): EgressStatusResult {
  if (res.ok !== true || res.value == null || typeof res.value !== "object") return { ok: false };
  const v = res.value as Record<string, unknown>;
  if (
    v["workspaceId"] !== workspaceId ||
    typeof v["employerRawEgressAcknowledged"] !== "boolean" ||
    typeof v["zeroEgressOnly"] !== "boolean"
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    status: {
      workspaceId,
      employerRawEgressAcknowledged: v["employerRawEgressAcknowledged"],
      zeroEgressOnly: v["zeroEgressOnly"],
    },
  };
}

/** Read one workspace's egress posture (visibility half — REQ-S-002). Fails closed to `{ok:false}`. */
export function createEgressStatus(
  client: CreateTRPCClient<AppRouter>,
): (workspaceId: string) => Promise<EgressStatusResult> {
  return async (workspaceId: string): Promise<EgressStatusResult> => {
    try {
      return foldStatus(await client.systemHealth.egressStatus.query({ workspaceId }), workspaceId);
    } catch {
      return { ok: false };
    }
  };
}

/**
 * Revoke a workspace's employer raw-egress acknowledgment — the audited, fail-SAFE OFF direction
 * (⚠ safety rule 5). Sends ONLY `{workspaceId}` (no ack / allowlist / acknowledgedAt smuggling) and
 * returns the worker's NEW status, which is the post-revoke truth the surface re-renders from — the
 * renderer never optimistically flips its own display.
 */
export function createRevokeEgressAck(
  client: CreateTRPCClient<AppRouter>,
): (workspaceId: string) => Promise<EgressStatusResult> {
  return async (workspaceId: string): Promise<EgressStatusResult> => {
    try {
      return foldStatus(await client.egressCommand.revokeEgressAck.mutate({ workspaceId }), workspaceId);
    } catch {
      return { ok: false };
    }
  };
}
