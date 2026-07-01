// QuarantineLedger (task 4.17, §6/§16; write-through amendment invariants (i)/(v)).
// The do-not-serve enforcement GBrain has no native concept of. It is the durable
// record of which parity defects (DB-only / diverged semantic facts) safety rule 1
// ("one writer / no hidden brain") forbids from being served as canonical until
// they are remediated.
//
// ABSENCE MODEL, keyed on the content-INDEPENDENT `factIdentity` (which pins a
// fact's LOCATION — page:/link:/timeline:/tag: — never a content hash). Because the
// ledger stores no content, a one-byte-changed re-introduction of a quarantined
// fact hits the SAME key: a purge cannot be evaded by re-introduction, and a
// quarantined fact cannot resurrect itself ("no resurrection"). The key is
// additionally scoped by `workspaceId` (safety rule 4 — a quarantine in one
// workspace never blocks the same identity form in another).
//
// SERVING-BLOCKED vs CLEARED (by `remediationState`):
//   • pending / materializing — an ACTIVE quarantine → do-not-serve.
//   • purged                  — the offending DB fact was destroyed for cause;
//                               it stays do-not-serve so a later re-introduction of
//                               the same identity cannot resurrect it.
//   • materialized            — the fact was re-canonicalized through the FULL
//                               KnowledgeWriter pipeline (RemediationRouter
//                               materialize-via-plan, 4.18) → cleared for serving.
//                               (It must still independently pass the ServingGate's
//                               allow-set + hash + signature checks, so clearing the
//                               ledger block here is never sufficient to serve.)
//   • dismissed               — the divergence was reviewed as benign (never a real
//                               hidden-brain fact) → cleared.
//
// PURE data structure over the frozen `QuarantineRecord` contract; no clock,
// network, filesystem, or gbrain. Total functions — never throw across a boundary.
import type { QuarantineRecord, RemediationState } from "@sow/contracts";

/**
 * Remediation states that keep a fact do-not-serve. `materialized`/`dismissed` are
 * the two RESOLVED states that clear the block (see module header).
 */
const SERVING_BLOCKED_STATES: ReadonlySet<RemediationState> = new Set<RemediationState>([
  "pending",
  "materializing",
  "purged",
]);

/**
 * The do-not-serve ledger the {@link admitForServing} gate consults. Records are
 * upserted by `(workspaceId, factIdentity)`; membership is content-independent.
 */
export interface QuarantineLedger {
  /** Upsert a quarantine record (re-quarantining the same identity replaces it). */
  quarantine(record: QuarantineRecord): void;
  /** True iff `factIdentity` in `workspaceId` is under an ACTIVE quarantine. */
  isQuarantined(workspaceId: string, factIdentity: string): boolean;
  /** The stored record for an identity (present even once resolved — audit trail). */
  get(workspaceId: string, factIdentity: string): QuarantineRecord | undefined;
  /** All stored records (one per `(workspaceId, factIdentity)` key). */
  list(): readonly QuarantineRecord[];
}

// Content-independent, workspace-scoped composite key. The NUL separator (built
// via char code so no control byte lands in source) cannot appear in a workspace
// id or factIdentity, so the two segments can never be confused.
const KEY_SEP = String.fromCharCode(0);
function keyOf(workspaceId: string, factIdentity: string): string {
  return `${workspaceId}${KEY_SEP}${factIdentity}`;
}

/**
 * Create an in-memory QuarantineLedger, optionally seeded with existing records
 * (e.g. rehydrated from the operational store at startup — the ledger is
 * operational truth, not rebuildable). Deterministic; total functions.
 */
export function createQuarantineLedger(
  seed: readonly QuarantineRecord[] = [],
): QuarantineLedger {
  const byKey = new Map<string, QuarantineRecord>();
  for (const r of seed) {
    byKey.set(keyOf(r.workspaceId as string, r.factIdentity as string), r);
  }

  return {
    quarantine(record: QuarantineRecord): void {
      byKey.set(keyOf(record.workspaceId as string, record.factIdentity as string), record);
    },
    isQuarantined(workspaceId: string, factIdentity: string): boolean {
      const r = byKey.get(keyOf(workspaceId, factIdentity));
      return r !== undefined && SERVING_BLOCKED_STATES.has(r.remediationState);
    },
    get(workspaceId: string, factIdentity: string): QuarantineRecord | undefined {
      return byKey.get(keyOf(workspaceId, factIdentity));
    },
    list(): readonly QuarantineRecord[] {
      return [...byKey.values()];
    },
  };
}
