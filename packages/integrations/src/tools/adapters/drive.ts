// @sow/integrations — 6.4 DRIVE write adapter (doc upsert).
//
// arch_gap: §8 names no per-target identity contract for a Drive doc — we adopt
// {docKey} keyed off the canonicalObjectKey so the existence probe matches by
// canonical key (safety invariant 2, no duplicate create). Drive upsert flows
// through create (new doc) or update (existing doc under a precondition/etag; a
// stale etag → 'conflict', never a blind overwrite — enforced by the core).
import type { TargetWriteAdapter } from "../adapter-port";
import type { AdapterDeps } from "./adapter-core";
import { makeTargetWriteAdapter } from "./adapter-core";

/**
 * Factory: a Drive `TargetWriteAdapter` over the injected transport + clock.
 * Upsert a doc; existence-probe by the doc's canonical identity.
 */
export function createDriveWriteAdapter(deps: AdapterDeps): TargetWriteAdapter {
  return makeTargetWriteAdapter(
    {
      targetSystem: "drive",
      deriveIdentity: (env) => ({ docKey: env.canonicalObjectKey }),
    },
    deps,
  );
}
