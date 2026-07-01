// @sow/integrations — 6.4 LINEAR write adapter (issue create/update).
//
// arch_gap: §8 names no per-target identity contract for a Linear issue — we
// adopt {issueKey} keyed off the canonicalObjectKey so the existence probe
// matches by canonical key (safety invariant 2, no duplicate create). A stale
// precondition on update → 'conflict' (never a blind overwrite), handled by the
// shared core.
import type { TargetWriteAdapter } from "../adapter-port";
import type { AdapterDeps } from "./adapter-core";
import { makeTargetWriteAdapter } from "./adapter-core";

/**
 * Factory: a Linear `TargetWriteAdapter` over the injected transport + clock.
 * Create/update an issue; existence-probe by the issue's canonical identity.
 */
export function createLinearWriteAdapter(deps: AdapterDeps): TargetWriteAdapter {
  return makeTargetWriteAdapter(
    {
      targetSystem: "linear",
      deriveIdentity: (env) => ({ issueKey: env.canonicalObjectKey }),
    },
    deps,
  );
}
