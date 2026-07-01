// ParityReconciler (task 4.16, §6/§12; write-through amendment invariants
// (iv)/(vii)). The SoW-owned, Temporal-scheduled (NOT gbrain-cron) continuous
// bidirectional parity pass that keeps GBrain honest: it diffs the trusted,
// gbrain-INDEPENDENT `CanonicalFactSet` (CanonicalFactDeriver, 4.14 — the
// reference "what SHOULD exist" side) against a read-only `ReconcilerDbProjection` (a
// `GbrainReadGrant` HTTP read; NEVER a byte source), keyed by content-independent
// `factIdentity`, and classifies every disagreement through the closed
// `DivergenceClassifier` lattice.
//
// The gbrain `import`-into-scratch RebuildOracle is an OPTIONAL SECOND
// corroborating cross-check ONLY: its disagreement LOWERS confidence
// (coverageComplete=false → serving degrades to direct committed-Markdown) and
// raises a `rebuild_divergence` HealthItem, but it NEVER reclassifies the
// canonical-vs-DB diff — the SoW parser is the reference side on BOTH legs, so the
// oracle is never a calibration target (invariant (ii)).
//
// Fires on post-commit index / fs-watch / schedule / on-demand; a burst collapses
// to the MAX revision (LIFE-2) via `collapseToMaxRevision`.
//
// Output (all fail-closed, §12):
//   - a revision-scoped, contract-valid `ParityReport` carrying `cleanForServing`
//     (false IFF any HARD-floor db_only/unstamped divergence — a serving-blocking
//     parity defect) and `coverageComplete` (the pass covered the full set AND the
//     oracle, if run, corroborated);
//   - the classified `Divergence[]`;
//   - a `parity_defect` HealthItem on any HARD-floor divergence (pinned to the
//     report + the first offending fact), plus a `rebuild_divergence` item on
//     oracle disagreement.
//
// PURE relative to its injected deps (id minters + clock). Returns a typed Result —
// NEVER throws across the boundary (§16).
import { ok, err, ParityReportSchema, HealthItemSchema } from "@sow/contracts";
import type {
  ParityReport,
  Divergence,
  HealthItem,
  FailureClass,
  Result,
} from "@sow/contracts";
import type { CanonicalFactSet, DerivedFact } from "../derive/canonical-fact-deriver";
import { classifyDivergence } from "./divergence-classifier";
import type { DbFact, FactComparison } from "./divergence-classifier";

// ── inputs ─────────────────────────────────────────────────────────────────────

/**
 * A read-only snapshot of the DB's semantic facts for one workspace (the
 * `GbrainReadGrant` HTTP read surface). `complete` is false when the read was
 * truncated / paged-short / partially errored — an incomplete projection can never
 * claim full coverage, so serving degrades even if what WAS read is clean.
 */
export interface ReconcilerDbProjection {
  readonly workspaceId: string;
  /** gbrain index/doctor schema version (OPEN number per the ParityReport model). */
  readonly gbrainSchemaVersion: number;
  readonly facts: readonly DbFact[];
  readonly complete: boolean;
}

/**
 * The gbrain import-rebuild oracle result — a SECOND corroborating cross-check.
 * Only the derived identity set + a completion flag are needed; the reconciler
 * never trusts the oracle over the SoW parser (disagreement is a defect).
 */
export interface RebuildOracleSet {
  readonly factIdentities: readonly string[];
  /** True IFF the scratch import/rebuild ran to completion. */
  readonly complete: boolean;
}

export type ReconcileTriggerOrigin = "post_commit" | "fs_watch" | "schedule" | "on_demand";

export interface ReconcileRequest {
  readonly origin: ReconcileTriggerOrigin;
  readonly canonicalSet: CanonicalFactSet;
  readonly dbProjection: ReconcilerDbProjection;
  readonly rebuildOracle?: RebuildOracleSet;
}

export interface ReconcilerDeps {
  readonly newReportId: () => string;
  readonly newHealthItemId: () => string;
  readonly newAuditId: () => string;
  /** ISO-8601 clock for `HealthItem.openedAt` (kept injected for determinism). */
  readonly now: () => string;
}

// ── outputs ──────────────────────────────────────────────────────────────────

export type ReconcileError =
  | { readonly code: "workspace_mismatch"; readonly canonical: string; readonly db: string }
  | { readonly code: "report_invalid"; readonly detail: string };

export interface ReconcilerOutcome {
  readonly report: ParityReport;
  /** Convenience mirror of `report.divergences` (deterministic factIdentity order). */
  readonly divergences: readonly Divergence[];
  /** 0..2 items: a `parity_defect` (HARD divergence) and/or `rebuild_divergence`. */
  readonly healthItems: readonly HealthItem[];
  /** Mirror of `report.coverageComplete` (the serving gate ANDs it with cleanForServing). */
  readonly coverageComplete: boolean;
}

// ── the pass ────────────────────────────────────────────────────────────────────

/**
 * Run one revision-scoped parity reconciliation. Total function: returns a typed
 * `ParityReport` + `Divergence[]` + `HealthItem[]`, or a typed error; never throws.
 */
export function reconcileParity(
  req: ReconcileRequest,
  deps: ReconcilerDeps,
): Result<ReconcilerOutcome, ReconcileError> {
  const { canonicalSet, dbProjection, rebuildOracle } = req;

  // The two sides MUST describe the same workspace — a cross-workspace compare is a
  // hard error, never a silent reconcile (WS isolation, safety rule 4).
  const wsCanonical = canonicalSet.workspaceId as string;
  const wsDb = dbProjection.workspaceId;
  if (wsCanonical !== wsDb) {
    return err({ code: "workspace_mismatch", canonical: wsCanonical, db: wsDb });
  }

  const canonicalRevision = canonicalSet.revisionId as string;

  const byIdCanonical = new Map<string, DerivedFact>();
  for (const df of canonicalSet.facts) {
    byIdCanonical.set(df.fact.factIdentity as string, df);
  }
  const byIdDb = new Map<string, DbFact>();
  for (const f of dbProjection.facts) {
    byIdDb.set(f.factIdentity, f);
  }

  // Deterministic factIdentity order over the union of both sides.
  const identities = [...new Set([...byIdCanonical.keys(), ...byIdDb.keys()])].sort();

  const divergences: Divergence[] = [];
  for (const id of identities) {
    const c = byIdCanonical.get(id);
    const d = byIdDb.get(id);
    let cmp: FactComparison;
    if (c !== undefined && d !== undefined) {
      cmp = { present: "both", canonical: c, db: d };
    } else if (c !== undefined) {
      cmp = { present: "canonical_only", canonical: c };
    } else {
      // Exactly one of c/d is defined (id came from the union); here d is defined.
      cmp = { present: "db_only", db: d as DbFact };
    }
    const outcome = classifyDivergence(cmp, canonicalRevision);
    if (outcome.kind === "invalid") {
      return err({
        code: "report_invalid",
        detail: `divergence ${outcome.factIdentity}: ${outcome.detail}`,
      });
    }
    if (outcome.kind === "divergent") {
      divergences.push(outcome.divergence);
    }
  }

  const hasHard = divergences.some((x) => x.severityFloor === "hard");
  // A HARD-floor (db_only/unstamped) divergence is a serving-blocking parity defect;
  // soft divergences (md_only/content_mismatch/edge_*/stale) don't block serving —
  // the ServingGate (4.17) is per-fact default-deny + Markdown-rehydrated anyway.
  const cleanForServing = !hasHard;

  // Oracle corroboration — SECOND cross-check only. Any identity-set disagreement
  // (or an incomplete oracle) lowers confidence; it NEVER reclassifies the diff.
  let oracleCorroborates = true;
  let oracleFactCount: number | undefined;
  if (rebuildOracle !== undefined) {
    oracleFactCount = rebuildOracle.factIdentities.length;
    const oracleIds = new Set(rebuildOracle.factIdentities);
    const canonicalIds = [...byIdCanonical.keys()];
    oracleCorroborates =
      rebuildOracle.complete &&
      oracleIds.size === canonicalIds.length &&
      canonicalIds.every((x) => oracleIds.has(x));
  }

  const coverageComplete = dbProjection.complete && oracleCorroborates;

  const reportDraft = {
    reportId: deps.newReportId(),
    workspaceId: wsCanonical,
    reconciledAtRevision: canonicalRevision,
    gbrainSchemaVersion: dbProjection.gbrainSchemaVersion,
    canonicalFactCount: canonicalSet.facts.length,
    dbFactCount: dbProjection.facts.length,
    ...(oracleFactCount !== undefined ? { oracleFactCount } : {}),
    divergences,
    cleanForServing,
    coverageComplete,
  };
  const parsed = ParityReportSchema.safeParse(reportDraft);
  if (!parsed.success) {
    return err({ code: "report_invalid", detail: parsed.error.message });
  }
  const report = parsed.data;
  const reportId = report.reportId as string;

  const healthItems: HealthItem[] = [];
  if (hasHard) {
    const hard = divergences.filter((x) => x.severityFloor === "hard");
    const first = hard[0] as Divergence;
    healthItems.push(
      buildHealthItem(deps, {
        failureClass: "parity_defect",
        severity: "critical",
        message:
          `Parity defect in workspace ${wsCanonical} at revision ${canonicalRevision}: ` +
          `${hard.length} HARD-floor divergence(s) (DB-only/unstamped semantic fact) ` +
          `quarantined — a DB-only fact is a hidden-brain defect (safety rule 1). Serving ` +
          `withholds these facts; remediate via materialize-or-purge.`,
        parityReportRef: reportId,
        factIdentity: first.factIdentity as string,
      }),
    );
  }
  if (rebuildOracle !== undefined && !oracleCorroborates) {
    healthItems.push(
      buildHealthItem(deps, {
        failureClass: "rebuild_divergence",
        severity: "warn",
        message:
          `GBrain rebuild oracle disagrees with the SoW canonical set for workspace ` +
          `${wsCanonical} at revision ${canonicalRevision} (oracle=${oracleFactCount ?? 0} vs ` +
          `canonical=${canonicalSet.facts.length}); coverage incomplete → serving degrades to ` +
          `direct committed-Markdown. Oracle disagreement is a defect, never a calibration target.`,
        parityReportRef: reportId,
      }),
    );
  }

  return { ok: true, value: { report, divergences: report.divergences, healthItems, coverageComplete } };
}

// ── LIFE-2 trigger collapse ─────────────────────────────────────────────────────

/** A queued reconcile trigger. `seq` is the monotonic revision counter (MAX wins). */
export interface PendingTrigger {
  readonly origin: ReconcileTriggerOrigin;
  readonly revisionId: string;
  readonly seq: number;
}

/**
 * Collapse a burst of queued triggers to the single newest one (MAX `seq`,
 * LIFE-2). Deterministic: the first trigger at the maximum seq wins. An empty
 * burst collapses to `undefined` (nothing to reconcile).
 */
export function collapseToMaxRevision(
  triggers: readonly PendingTrigger[],
): PendingTrigger | undefined {
  let best: PendingTrigger | undefined;
  for (const t of triggers) {
    if (best === undefined || t.seq > best.seq) {
      best = t;
    }
  }
  return best;
}

// ── helpers ─────────────────────────────────────────────────────────────────────

interface HealthItemDraft {
  readonly failureClass: FailureClass;
  readonly severity: string;
  readonly message: string;
  readonly parityReportRef: string;
  readonly factIdentity?: string;
}

/**
 * Build a System Health item validated through the frozen `HealthItemSchema`. On
 * the (structurally unreachable) parse-fail path we still return a type-correct
 * item — the reconciler must always surface a defect, never throw (§16).
 */
function buildHealthItem(deps: ReconcilerDeps, draft: HealthItemDraft): HealthItem {
  const candidate = {
    id: deps.newHealthItemId(),
    failureClass: draft.failureClass,
    // severity is an OPEN string upstream (no closed enum) — see HealthItem model.
    severity: draft.severity,
    message: draft.message,
    auditRef: deps.newAuditId(),
    openedAt: deps.now(),
    state: "open" as const,
    parityReportRef: draft.parityReportRef,
    ...(draft.factIdentity !== undefined ? { factIdentity: draft.factIdentity } : {}),
  };
  const parsed = HealthItemSchema.safeParse(candidate);
  return parsed.success ? parsed.data : (candidate as unknown as HealthItem);
}
