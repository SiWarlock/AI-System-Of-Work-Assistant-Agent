// @sow/integrations — 6.4 TODOIST write adapter (task create/update).
//
// arch_gap: §8 names no per-target identity contract for a Todoist task — we
// adopt {taskKey} keyed off the canonicalObjectKey (the stable logical-object
// identity from buildCanonicalObjectKey), so the existence probe matches by
// canonical key (safety invariant 2, no duplicate create).
import type { TargetWriteAdapter } from "../adapter-port";
import type { AdapterDeps } from "./adapter-core";
import { makeTargetWriteAdapter } from "./adapter-core";

/**
 * Factory: a Todoist `TargetWriteAdapter` over the injected transport + clock.
 * Create/update a task; existence-probe by the task's canonical identity.
 */
export function createTodoistWriteAdapter(deps: AdapterDeps): TargetWriteAdapter {
  return makeTargetWriteAdapter(
    {
      targetSystem: "todoist",
      deriveIdentity: (env) => ({ taskKey: env.canonicalObjectKey }),
    },
    deps,
  );
}
