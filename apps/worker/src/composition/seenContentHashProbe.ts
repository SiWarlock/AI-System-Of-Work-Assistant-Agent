// Task 16.6 — the real persisted seen-content-hash dedupe probe (worker composition, §19.2/§4).
//
// Adapts the durable 15.4 `SeenContentHashRepository` (`has`/`record`, WS-8-scoped by
// `(workspaceId, contentHash)`) onto the WS-scoped `seenContentHash(workspaceId, contentHash)` probe
// the register activity binds — replacing the hardwired always-miss `() => false`. On a miss it
// records the hash FIRST-WRITE-WINS (so a later identical import dedupes); the persisted store is the
// dedup that survives Temporal history-retention expiry (REQ-F-010).
//
// LOAD-BEARING (worker Lesson 34) — a store fault PROCEEDs, never HOLDs: a `has`-probe fault (or a
// `record` fault on a miss) resolves to `false` (NOT-seen), so `registerSource` + dispatch run and the
// Temporal `src:ws:hash` REJECT_DUPLICATE workflowId remains the exactly-once backstop. A persistent
// store fault must NEVER block the connector (a HOLD) nor drop a source (a false dedupe-hit).
import { isErr } from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";
import type { SeenContentHashRepository } from "@sow/db";

/**
 * Build the WS-8-scoped Flow-4 dedupe probe over the durable {@link SeenContentHashRepository}.
 * Returns `true` (seen ⇒ dedupe_hit) only on a confirmed hit; a MISS records the hash first-write-wins
 * and returns `false`; any store fault (`has` OR `record`) returns `false` (PROCEED — L34). Never throws.
 */
export function createSeenContentHashProbe(
  repo: SeenContentHashRepository,
  now: () => string,
): (workspaceId: string, contentHash: string) => Promise<boolean> {
  return async (workspaceId: string, contentHash: string): Promise<boolean> => {
    // Structural never-throws (L20/L24): PROCEED (return false) on ANY fault — a typed `err` Result OR a
    // contract-violating throw/reject from the injected repo/clock. A store fault must NEVER HOLD the
    // connector nor mint a false dedupe-hit (L34); the Temporal `src:ws:hash` REJECT_DUPLICATE backstops.
    try {
      const key = { workspaceId: workspaceId as WorkspaceId, contentHash };
      const seen = await repo.has(key);
      if (isErr(seen)) return false; // a has-fault is not-seen (PROCEED), never a HOLD/false-hit
      if (seen.value) return true; // confirmed seen ⇒ dedupe_hit (short-circuits before any record)
      // MISS: record first-write-wins (idempotent — a re-record preserves the original seenAt), then
      // PROCEED. A record fault (typed err OR throw) also PROCEEDs — the record is a best-effort
      // optimisation, never a gate.
      await repo.record({ workspaceId: workspaceId as WorkspaceId, contentHash, seenAt: now() });
      return false;
    } catch {
      return false;
    }
  };
}
