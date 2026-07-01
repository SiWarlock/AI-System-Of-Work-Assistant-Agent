// CrashRecoveryReconciler (task 4.20, §6/§13; write-through amendment invariant
// (vii) + §13 / the 12.23 fail-closed suite).
//
// On restart the in-memory serving allow-set is gone. It is rebuilt DETERMINISTICALLY
// from `CanonicalFactDeriver(current committed Markdown)` — the gbrain-INDEPENDENT
// parser — NEVER from any pre-crash cache, DB projection, or gbrain read. Two safety
// invariants hold by construction:
//
//   • NEVER STRAND A TRUE FACT UN-SERVED. The recovered allow-set IS the derived set,
//     so every Markdown-derivable fact is admissible again (subject to the per-serve
//     gate). A fact absent from Markdown is un-serveable by definition, not stranded.
//   • NEVER RESURRECT A QUARANTINED FACT. The rehydrated (operational-truth)
//     `QuarantineLedger` is consulted per derived identity: an ACTIVE quarantine
//     (pending / materializing / purged) keeps that identity blocked. Because the
//     ledger is keyed on the content-INDEPENDENT `factIdentity`, a one-byte-changed
//     re-introduction of a purged fact hits the SAME key — a purge cannot be evaded
//     by re-introduction across a crash. A `purged` identity that REAPPEARS in
//     committed Markdown is additionally surfaced (a caught resurrection attempt).
//
// FAIL-CLOSED: if the deriver cannot rebuild the allow-set (e.g. a cross-page
// identity collision), recovery returns a typed error + a `write_through_failed`
// System-Health item — the workspace serves nothing through the gate until repaired,
// never a stale last-known set.
//
// Deterministic relative to its injected deps (clock + id minters) + the PURE
// deriver + the PURE ledger. Returns a typed `Result`; NEVER throws (§16).
import { ok, err, HealthItemSchema } from "@sow/contracts";
import type {
  Result,
  HealthItem,
  WorkspaceId,
  RevisionId,
} from "@sow/contracts";
import { deriveCanonicalFacts } from "../derive/canonical-fact-deriver";
import type {
  CanonicalVaultSnapshot,
  CanonicalFactSet,
} from "../derive/canonical-fact-deriver";
import type { QuarantineLedger } from "../serving/quarantine-ledger";

export interface CrashRecoveryRequest {
  /** The CURRENT committed vault Markdown snapshot at restart. */
  readonly snapshot: CanonicalVaultSnapshot;
  /** The operational-truth QuarantineLedger, rehydrated from the store at startup. */
  readonly quarantine: QuarantineLedger;
}

/** Injected surroundings for building HealthItems — no ambient clock/id. */
export interface CrashRecoveryDeps {
  /** ISO-8601 clock for `HealthItem.openedAt`. */
  readonly now: () => string;
  readonly newHealthItemId: () => string;
  readonly newAuditId: () => string;
}

/** The rebuilt, revision-scoped serving state after a crash. */
export interface RecoveredServingState {
  readonly workspaceId: WorkspaceId;
  readonly revisionId: RevisionId;
  /** The allow-set = `CanonicalFactDeriver(current Markdown)` — the sole trusted set. */
  readonly allowSet: CanonicalFactSet;
  /** Derived AND not actively quarantined — admissible again (in factIdentity order). */
  readonly servable: readonly string[];
  /** Derived BUT under an ACTIVE quarantine — kept blocked (no resurrection). */
  readonly quarantineBlocked: readonly string[];
  /** Subset of `quarantineBlocked` whose quarantine is `purged` yet reappears in
   *  Markdown — a caught purge-evasion / resurrection attempt (owner review). */
  readonly resurrectionBlocked: readonly string[];
  /** One item per resurrection-blocked identity (surfaced for review). */
  readonly healthItems: readonly HealthItem[];
}

export type CrashRecoveryError = {
  readonly code: "derive_failed";
  readonly detail: string;
  readonly healthItem: HealthItem;
};

/**
 * Rebuild the serving allow-set from current committed Markdown and partition it
 * against the rehydrated QuarantineLedger. See the module header for the two
 * invariants. Returns a typed `Result`; never throws (§16).
 */
export function recoverServingState(
  req: CrashRecoveryRequest,
  deps: CrashRecoveryDeps,
): Result<RecoveredServingState, CrashRecoveryError> {
  // 1 — rebuild the allow-set from Markdown ALONE (gbrain-independent). A derive
  //     failure means we cannot build a trusted set → fail closed (serve nothing).
  const derived = deriveCanonicalFacts(req.snapshot);
  if (!derived.ok) {
    return err({
      code: "derive_failed",
      detail: derived.error.code,
      healthItem: buildHealthItem(
        deps,
        `crash-recovery could not rebuild the allow-set from committed Markdown ` +
          `(deriver: ${derived.error.code}); write-through degraded — serving nothing ` +
          `through the gate until repaired.`,
      ),
    });
  }
  const allowSet = derived.value;
  const ws = allowSet.workspaceId as string;

  const servable: string[] = [];
  const quarantineBlocked: string[] = [];
  const resurrectionBlocked: string[] = [];
  const healthItems: HealthItem[] = [];

  // 2 — partition each derived fact against the rehydrated ledger. allowSet.facts is
  //     already in a deterministic factIdentity order, so every list below is too.
  for (const df of allowSet.facts) {
    const id = df.fact.factIdentity as string;
    if (!req.quarantine.isQuarantined(ws, id)) {
      // Not blocked → admissible again (never stranded).
      servable.push(id);
      continue;
    }
    // Actively quarantined → kept blocked (no resurrection).
    quarantineBlocked.push(id);
    const record = req.quarantine.get(ws, id);
    if (record?.remediationState === "purged") {
      // A destroyed-for-cause identity reappears in committed Markdown: the
      // content-independent purge still blocks it; surface the caught attempt.
      resurrectionBlocked.push(id);
      healthItems.push(
        buildHealthItem(
          deps,
          `crash-recovery: purged fact ${id} in workspace ${ws} reappeared in committed ` +
            `Markdown; kept do-not-serve (content-independent purge — no resurrection). ` +
            `Owner review required.`,
          id,
        ),
      );
    }
  }

  return ok({
    workspaceId: allowSet.workspaceId,
    revisionId: allowSet.revisionId,
    allowSet,
    servable,
    quarantineBlocked,
    resurrectionBlocked,
    healthItems,
  });
}

/**
 * Build a `write_through_failed` System-Health item validated through the frozen
 * `HealthItemSchema`. On the (structurally unreachable) parse-fail path we still
 * return a type-correct item — recovery must surface, never throw (§16).
 */
function buildHealthItem(
  deps: CrashRecoveryDeps,
  message: string,
  factIdentity?: string,
): HealthItem {
  const candidate = {
    id: deps.newHealthItemId(),
    failureClass: "write_through_failed" as const,
    // severity is an OPEN string upstream (no closed enum) — see HealthItem model.
    severity: factIdentity !== undefined ? "warn" : "error",
    message,
    auditRef: deps.newAuditId(),
    openedAt: deps.now(),
    state: "open" as const,
    ...(factIdentity !== undefined ? { factIdentity } : {}),
  };
  const parsed = HealthItemSchema.safeParse(candidate);
  return parsed.success ? parsed.data : (candidate as unknown as HealthItem);
}
