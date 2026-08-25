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
import { ok, err, isOk, failure } from "@sow/contracts";
import type { Result, WorkspaceId, FailureVariant } from "@sow/contracts";
import type { WorkspaceConfigRepository } from "@sow/db";
import type { WorkspacePosture, WorkspacePostureResolver } from "../procedures/copilot";
import { unknownWorkspace } from "../procedures/copilot";

/**
 * Task 24.101 — the WS-8 read-back re-gate firing gets its OWN cause code, distinct from
 * `unknownWorkspace()`'s generic `WORKSPACE_NOT_FOUND`. Before this, a store returning a FOREIGN
 * workspace's row for the requested id (a mis-filtered/tampered read — the most safety-critical of
 * this resolver's three failure paths per this file's own header) collapsed into the SAME code as
 * "the workspace genuinely doesn't exist" / "the store faulted." A caller (or a test) reading only
 * the cause code could never tell "the re-gate caught something" from "there was nothing to find" —
 * exactly the defect `storeBackedWorkspacePosture.test.ts`'s `resolver_foreign_readback_fails_closed`
 * exists to catch, and previously could not, since bare `isOk(...)===false` doesn't discriminate
 * either. `not_found` and any OTHER store fault (incl. `stored_row_schema_violation`) deliberately
 * stay collapsed into `unknownWorkspace()` — that collapse is intentional (mirrors
 * `createLocalWorkspacePosture`'s miss), only the WS-8 identity mismatch is split out.
 */
function readBackIdentityMismatch(): FailureVariant {
  return failure("validation_rejected", "workspace read-back identity mismatch", {
    cause: { code: "WORKSPACE_READBACK_MISMATCH" },
  });
}

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
      if (String(ws.id) !== workspaceId) return err(readBackIdentityMismatch());
      return ok({ type: ws.type, dataOwner: ws.dataOwner, egress: ws.egressPolicy });
    },
  };
}
