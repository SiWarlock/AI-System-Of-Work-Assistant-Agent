// §5 ToolPolicy evaluation (REQ-S-001). Closed, deny-wins mutation assessment
// reused by the ING-7 admission gate (`./admission`). PURE — no clock, network,
// or randomness; reuses the frozen contract helpers so the deny-wins /
// consistency rules have a single source of truth.
import type { ToolId, ToolPolicy } from "@sow/contracts";
import { effectiveAllowedTools } from "@sow/contracts";

/**
 * Does this ToolPolicy admit MUTATION? Used by the ING-7 gate to decide whether
 * an untrusted-content job may carry any mutating capability.
 *
 * A policy admits mutation iff `allowsMutating === true` OR `mode ==='scoped_write'`
 * OR (an `isMutatingTool` catalog is supplied AND some *effective* allowed tool —
 * `allowedTools` minus `deniedTools`, so deny always wins — is classified mutating).
 *
 * `mode === 'read_only'` is the fail-safe override: it forces the effective
 * result to `false` REGARDLESS of declared tools or an inconsistently-set
 * `allowsMutating` flag (a read_only policy that declared `allowsMutating: true`
 * is rejected upstream by `ToolPolicySchema`'s refine — see `./admission`).
 *
 * arch_gap: there is no upstream mutating-tool catalog (`ToolId` is an open
 * branded string). So `isMutatingTool` is an INJECTED predicate — a
 * forward-looking hook; absent it, the assessment keys off `allowsMutating` /
 * `mode` only. Pure; never throws.
 */
export function admitsMutating(
  p: ToolPolicy,
  isMutatingTool?: (t: ToolId) => boolean,
): boolean {
  // read_only override: never mutating, regardless of declared tools / flag.
  if (p.mode === "read_only") return false;
  return (
    p.allowsMutating === true ||
    p.mode === "scoped_write" ||
    (isMutatingTool !== undefined &&
      effectiveAllowedTools(p).some((t) => isMutatingTool(t)))
  );
}
