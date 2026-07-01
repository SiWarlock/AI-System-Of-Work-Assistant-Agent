// @sow/integrations — 6.4 ASANA write adapter (task create/update).
//
// arch_gap: §8 names no per-target identity contract for an Asana task — we
// adopt {taskKey} keyed off the canonicalObjectKey so the existence probe matches
// by canonical key (safety invariant 2, no duplicate create).
import type { TargetWriteAdapter } from "../adapter-port";
import type { AdapterDeps } from "./adapter-core";
import { makeTargetWriteAdapter } from "./adapter-core";

/**
 * Factory: an Asana `TargetWriteAdapter` over the injected transport + clock.
 * Create/update a task; existence-probe by the task's canonical identity.
 */
export function createAsanaWriteAdapter(deps: AdapterDeps): TargetWriteAdapter {
  return makeTargetWriteAdapter(
    {
      targetSystem: "asana",
      deriveIdentity: (env) => ({ taskKey: env.canonicalObjectKey }),
    },
    deps,
  );
}
