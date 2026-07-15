// The fail-closed WS-8 workspace-registry union — the SINGLE source of the
// known-workspace membership discipline (task 14.1). EXTRACTED from `provisionDev.ts`
// so BOTH the production provisioning path (`provisionWorkspace`) and the dev fixture
// (`provisionDevWorkspace`) share ONE union implementation (no divergent copy).
//
// The registry read-model (`READ_MODEL_KEYS.registry`, `{ workspaceIds: string[] }`,
// workspaceId = null) is the SOLE visibility authority: a workspace-scoped read
// resolves ONLY for an id in this set (WS-8 — `resolveKnownWorkspace`). A workspace
// absent from the set is UNKNOWN, and its scoped reads fail closed. This module owns
// the union's fail-closed discipline: a genuine store fault is a typed err, NEVER a
// fold-to-empty (that would DROP previously-registered workspaces).
//
// SCOPE: worker composition only. It writes the rebuildable registry read-model row
// (safe to clobber, §4); it never writes Markdown and never routes a semantic mutation.
import { ok, err, isErr, type Result } from "@sow/contracts";
import type { ReadModelRepository } from "@sow/db";
import { READ_MODEL_KEYS } from "../api/adapters/readModel";

/** Typed, redaction-safe registry-union failure (never a raw driver cause). */
export type RegistryUnionError = { readonly code: "store_fault"; readonly message: string };

/** Read the registry's `workspaceIds` string set off a payload; malformed/absent → `[]`. */
function readWorkspaceIds(data: unknown): readonly string[] {
  if (typeof data !== "object" || data === null) return [];
  const arr = (data as Record<string, unknown>)["workspaceIds"];
  if (!Array.isArray(arr)) return [];
  return arr.filter((x): x is string => typeof x === "string");
}

/**
 * UNION `workspaceId` into the global fail-closed workspace registry (`{ workspaceIds }`).
 * Idempotent: re-registering an already-known workspace is a no-op set. This is what makes
 * a workspace-scoped query resolve (WS-8: absent from the registry → the query fails closed).
 *
 * A benign `not_found` miss starts from empty; a GENUINE store fault returns a typed
 * `store_fault` rather than folding to empty — folding would silently DROP previously-
 * registered workspaces (making their scoped reads fail closed). Fail loudly; a
 * re-provision repairs.
 *
 * arch_gap (concurrency): this is a non-atomic read-modify-write (get → union → put).
 * Two near-concurrent unions can lose-update the set (A reads [], B reads [], A puts
 * [A], B puts [B] → A dropped). The direction is fail-SAFE — a dropped id becomes
 * INVISIBLE (its scoped reads fail closed), never a cross-workspace leak — and a
 * re-provision repairs it. The dev fixture only ever called this in a sequential loop;
 * the production `onboarding.createWorkspace` mutation is the first plausibly-concurrent
 * surface. A single-writer serialization / atomic set-union (a dedicated registry repo
 * with an atomic append) is the follow-up; deferred (fail-safe, out of scope for 14.1).
 */
export async function registerWorkspace(
  readModels: ReadModelRepository,
  workspaceId: string,
  at: string,
): Promise<Result<void, RegistryUnionError>> {
  const existing = await readModels.get(READ_MODEL_KEYS.registry, null);
  if (isErr(existing) && existing.error.code !== "not_found") {
    return err({ code: "store_fault", message: "workspace registry get failed" });
  }
  const prior = existing.ok ? readWorkspaceIds(existing.value.data) : [];
  const workspaceIds = prior.includes(workspaceId) ? prior : [...prior, workspaceId];
  const put = await readModels.put({
    readModelKey: READ_MODEL_KEYS.registry,
    data: { workspaceIds },
    rebuiltAt: at,
  });
  return put.ok ? ok(undefined) : err({ code: "store_fault", message: "workspace registry put failed" });
}
