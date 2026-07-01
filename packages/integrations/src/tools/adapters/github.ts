// @sow/integrations — 6.4 GITHUB write adapter (issue / PR / comment).
//
// arch_gap: §8 names no per-target identity contract for a GitHub object (issue
// vs PR vs comment differ in shape) — we adopt {objectKey} keyed off the
// canonicalObjectKey so the existence probe matches by canonical key (safety
// invariant 2, no duplicate create) regardless of the underlying GitHub object
// kind. The write body's kind (issue/PR/comment) rides in the payload, opaque to
// this adapter; the identity is uniform.
import type { TargetWriteAdapter } from "../adapter-port";
import type { AdapterDeps } from "./adapter-core";
import { makeTargetWriteAdapter } from "./adapter-core";

/**
 * Factory: a GitHub `TargetWriteAdapter` over the injected transport + clock.
 * Create/update an issue/PR/comment; existence-probe by the object's canonical
 * identity.
 */
export function createGithubWriteAdapter(deps: AdapterDeps): TargetWriteAdapter {
  return makeTargetWriteAdapter(
    {
      targetSystem: "github",
      deriveIdentity: (env) => ({ objectKey: env.canonicalObjectKey }),
    },
    deps,
  );
}
