// Task 9.10-A — the store-backed WorkspacePosture resolver (§5 / §16, safety rule 5).
//
// Makes the Employer-Work egress veto read the DURABLE per-workspace posture from
// `WorkspaceConfigRepository.egressPolicy` instead of a hardcoded fail-closed constant (or the
// retired `type==="employer_work"` fail-OPEN hack). Option A (owner ruling D1=A): the persisted
// egressPolicy is the SOLE posture source — the resolver projects `{type, dataOwner, egress}`
// straight from the stored `Workspace`. Absence OR any store fault is FAIL-CLOSED (typed err,
// mirroring `createLocalWorkspacePosture`'s miss = `unknownWorkspace()`) — a posture is NEVER
// synthesized with a default-true acknowledgment.
//
// The resolver is async, dropping into the existing `MaybeAsyncResult` seam
// (`WorkspacePostureResolver.resolve`, copilot.ts) with no interface change; the consumer already
// awaits it.
import { ok, err, isOk } from "@sow/contracts";
import type { Result, WorkspaceId, FailureVariant } from "@sow/contracts";
import type { WorkspaceConfigRepository } from "@sow/db";
import type { WorkspacePosture, WorkspacePostureResolver } from "../procedures/copilot";
import { unknownWorkspace } from "../procedures/copilot";

/**
 * Build a {@link WorkspacePostureResolver} backed by the durable `WorkspaceConfigRepository`.
 * `resolve(workspaceId)` reads `workspaceConfig.get(id)` and projects the stored workspace's
 * governance posture. A `not_found` OR any store fault ⇒ `err(unknownWorkspace())` (fail closed) —
 * never a permissive default. Never throws.
 */
export function createStoreBackedWorkspacePosture(
  workspaceConfig: WorkspaceConfigRepository,
): WorkspacePostureResolver {
  return {
    resolve: async (workspaceId: string): Promise<Result<WorkspacePosture, FailureVariant>> => {
      const got = await workspaceConfig.get(workspaceId as WorkspaceId);
      // not_found OR any store fault ⇒ fail closed (rule 5: never a synthesized default-true posture).
      if (!isOk(got)) return err(unknownWorkspace());
      const ws = got.value;
      // WS-8 read-back re-gate (Lessons 12/20/32; mirrors the sibling `enforceRetrievalScope`): the
      // resolved posture MUST be bound to the REQUESTED workspace. A buggy/malicious adapter returning a
      // FOREIGN (possibly more-permissive) row would otherwise feed a foreign posture straight into the
      // egress veto — the most safety-critical input. Fail closed on any id mismatch.
      if (String(ws.id) !== workspaceId) return err(unknownWorkspace());
      return ok({ type: ws.type, dataOwner: ws.dataOwner, egress: ws.egressPolicy });
    },
  };
}
