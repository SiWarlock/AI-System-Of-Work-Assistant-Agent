// GBrain parity check + DB-only quarantine primitive (§6, task 4.9; safety rule 1
// "one writer / no hidden brain", KN-4/KN-9). This is the FOUNDATIONAL quarantine
// primitive — the full continuous bidirectional ParityReconciler + the complete
// DivergenceClassifier + the serving gate live in 4.16/4.17. Here we detect the
// one safety-critical divergence class: a DB-only fact.
//
// The gbrain DB is a DERIVED, disposable pointer/ranking index; committed Markdown
// is the only canonical semantic truth (REQ-D-001). So the trusted "what SHOULD
// exist" reference set is the gbrain-INDEPENDENT `CanonicalFactSet` (task 4.14) —
// gbrain is deliberately OUT of its own checker's trust base. We diff a read-only DB
// projection against it:
//
//   • A factIdentity PRESENT in the DB projection but ABSENT from the canonical set
//     is a DB-only fact — a "hidden GBrain semantic truth" (THREAT_MODEL). It is a
//     HARD, non-downgradable `db_only` parity DEFECT: it is quarantined (a
//     QuarantineRecord keyed on the content-INDEPENDENT `factIdentity` so a one-byte
//     DB edit produces the SAME identity and cannot evade the purge / resurrect it),
//     surfaced as a distinct `parity_defect` System-Health item, and queued for
//     remediation through the NORMAL KnowledgeWriter write path (a materialize-or-
//     purge plan — never a DB-first "fix"). Quarantine = the record's existence +
//     the report's dirtiness; a quarantined fact is NEVER re-served as authoritative
//     until promoted by an accepted KnowledgeMutationPlan committed by KnowledgeWriter.
//   • A canonical fact ABSENT from the DB (`md_only`) is NOT a rule-1 defect — the
//     index is merely behind (a benign re-index handled by 4.8/4.16). We do not flag
//     it here; the full `content_mismatch` / `md_only` / `edge_*` classification is
//     4.16's DivergenceClassifier. Keeping 4.9 to `db_only` keeps this primitive tight.
//
// Fail-closed (§12): any HARD divergence forces `cleanForServing=false`; a partial
// projection read (`complete=false`) degrades `coverageComplete` even with zero
// defects — the serving gate ANDs the two, so an incomplete pass degrades serving.
//
// PURE + total, like `fs-watch/reconcile.ts`: no fs / clock / network / gbrain call.
// The caller (the 4.16 reconciler / worker) owns the never-throwing read of the DB
// projection via the read-only `GbrainReadGrant` and the actual queuing of the
// returned remediation requests through the write path — so this function never
// mutates canonical state and never throws across the boundary (§16). The injected
// `now` / id minters / `auditRef` are the only seams.
import {
  DivergenceSchema,
  QuarantineRecordSchema,
  ParityReportSchema,
  HealthItemSchema,
} from "@sow/contracts";
import type {
  Divergence,
  QuarantineRecord,
  ParityReport,
  HealthItem,
  DivergenceClass,
  Remediation,
  FactIdentity,
  WorkspaceId,
  RevisionId,
} from "@sow/contracts";
import type { CanonicalFactSet } from "./derive/canonical-fact-deriver";

// ── the read-only DB projection this check diffs against ─────────────────────

/** One fact as it exists in the gbrain DB projection: its content-INDEPENDENT
 *  identity plus an OPAQUE DB-side digest (the DB's own content hash — NOT the
 *  canonical-Markdown sha256). The caller reads this via the read-only grant. */
export interface DbProjectionFact {
  readonly factIdentity: FactIdentity;
  readonly dbContentHash: string;
}

/**
 * The read-only DB projection at a revision. `complete=false` marks a PARTIAL read
 * (the reader could not enumerate the full store) → the pass degrades
 * `coverageComplete` and serving fails closed, even if no defect was found.
 */
export interface DbProjection {
  readonly workspaceId: WorkspaceId;
  readonly revisionId: RevisionId;
  readonly facts: readonly DbProjectionFact[];
  readonly complete: boolean;
}

// ── injected seams (no ambient clock / random) ───────────────────────────────

export interface ParityDeps {
  /** The gbrain index schema_version (`gbrain doctor --json`) stamped on the report. */
  readonly gbrainSchemaVersion: number;
  /** Injected clock (ISO-8601) — keeps health-item timestamps deterministic. */
  readonly now: () => string;
  /** Injected ParityReport id minter (no ambient random). */
  readonly newReportId: () => string;
  /** Injected System-Health id minter (one per defect). */
  readonly newHealthItemId: () => string;
  /** AuditRecord id every quarantine + health item links back to (§6 / §16). */
  readonly auditRef: string;
}

// ── outcome ──────────────────────────────────────────────────────────────────

/**
 * A remediation to queue through the NORMAL KnowledgeWriter write path. This is the
 * HAND-OFF, not the mutation: `checkGbrainParity` never queues or mutates — the
 * caller routes each request into the write path (a re-validated KnowledgeMutationPlan
 * — materialize-or-purge for `db_only`), so there is never a DB-first semantic fix.
 */
export interface ParityRemediationRequest {
  readonly factIdentity: FactIdentity;
  readonly workspaceId: WorkspaceId;
  readonly divergenceClass: DivergenceClass;
  readonly remediation: Remediation;
  readonly quarantineHealthItemId: string;
  readonly reason: string;
}

export type ParityCheckOutcomeKind = "clean" | "parity_defect";

export interface ParityCheckOutcome {
  readonly kind: ParityCheckOutcomeKind;
  /** The revision-scoped ParityReport (embeds the classified `divergences`). */
  readonly report: ParityReport;
  /** The `db_only` divergences this pass classified (empty ⇒ clean). */
  readonly divergences: readonly Divergence[];
  /** One QuarantineRecord per defect, keyed on the content-independent identity. */
  readonly quarantineRecords: readonly QuarantineRecord[];
  /** One distinct `parity_defect` System-Health item per defect (§16). */
  readonly healthItems: readonly HealthItem[];
  /** One remediation-to-queue per defect (the caller routes via the write path). */
  readonly remediationRequests: readonly ParityRemediationRequest[];
}

// db_only is the materialize-or-purge case; choosing between them requires positive
// proof of non-derivability (4.18 RemediationRouter / owner). The foundational
// primitive routes conservatively to owner `review` — never an auto-mutation.
const DB_ONLY_REMEDIATION: Remediation = "review";

/**
 * Diff a read-only DB projection against the gbrain-independent canonical fact set
 * and quarantine every DB-only fact. See the module header for the fail-closed +
 * one-writer contract. PURE + total: it never throws and never mutates canonical
 * state (it returns the records + remediation requests for the caller to persist /
 * queue through the write path).
 */
export function checkGbrainParity(
  canonical: CanonicalFactSet,
  projection: DbProjection,
  deps: ParityDeps,
): ParityCheckOutcome {
  const reportId = deps.newReportId();

  // The trusted "what SHOULD exist" identities — the derive is the REFERENCE side.
  const canonicalIdentities = new Set<string>(
    canonical.facts.map((d) => d.fact.factIdentity as string),
  );

  // Stable, deterministic order: sort DB-only facts by identity (the derive is
  // already identity-sorted, so this makes the whole pass order-independent).
  const dbOnly = projection.facts
    .filter((f) => !canonicalIdentities.has(f.factIdentity as string))
    .slice()
    .sort((a, b) =>
      a.factIdentity < b.factIdentity ? -1 : a.factIdentity > b.factIdentity ? 1 : 0,
    );

  const divergences: Divergence[] = [];
  const quarantineRecords: QuarantineRecord[] = [];
  const healthItems: HealthItem[] = [];
  const remediationRequests: ParityRemediationRequest[] = [];

  for (const fact of dbOnly) {
    // A DB-only fact must carry SOME digest (evidence of the offending state); a
    // missing one is still quarantined — use a non-empty sentinel (schemas require min 1).
    const capturedDbDigest =
      fact.dbContentHash.length > 0 ? fact.dbContentHash : "db-digest-unavailable";

    const divergence = buildDbOnlyDivergence(fact.factIdentity, capturedDbDigest);
    const healthItemId = deps.newHealthItemId();
    const healthItem = buildParityDefectHealthItem(
      deps,
      fact.factIdentity,
      reportId,
      healthItemId,
    );
    const quarantine = buildQuarantineRecord(
      deps,
      projection.workspaceId,
      fact.factIdentity,
      reportId,
      capturedDbDigest,
      healthItemId,
    );

    divergences.push(divergence);
    healthItems.push(healthItem);
    quarantineRecords.push(quarantine);
    remediationRequests.push({
      factIdentity: fact.factIdentity,
      workspaceId: projection.workspaceId,
      divergenceClass: "db_only",
      remediation: DB_ONLY_REMEDIATION,
      quarantineHealthItemId: healthItemId,
      reason:
        `DB-only semantic fact ${fact.factIdentity} has no canonical Markdown backing ` +
        `(hidden GBrain semantic truth). Quarantined; queue a materialize-or-purge ` +
        `remediation through the KnowledgeWriter write path.`,
    });
  }

  // Fail-closed: ANY hard divergence ⇒ not clean for serving; a partial read ⇒
  // coverage incomplete (the serving gate ANDs the two).
  const cleanForServing = !divergences.some((d) => d.severityFloor === "hard");
  const report = buildParityReport(deps, reportId, canonical, projection, divergences, {
    cleanForServing,
    coverageComplete: projection.complete,
  });

  return {
    kind: divergences.length > 0 ? "parity_defect" : "clean",
    report,
    divergences,
    quarantineRecords,
    healthItems,
    remediationRequests,
  };
}

// ── builders (schema-validated; type-correct fallback on the unreachable fail) ──

function buildDbOnlyDivergence(
  factIdentity: FactIdentity,
  dbContentHash: string,
): Divergence {
  const candidate = {
    factIdentity: factIdentity as string,
    divergenceClass: "db_only" as const,
    // HARD, non-downgradable floor (the Divergence schema also enforces this).
    severityFloor: "hard" as const,
    dbContentHash,
    remediation: DB_ONLY_REMEDIATION,
  };
  const parsed = DivergenceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : (candidate as unknown as Divergence);
}

function buildQuarantineRecord(
  deps: ParityDeps,
  workspaceId: WorkspaceId,
  factIdentity: FactIdentity,
  reportId: string,
  capturedDbDigest: string,
  healthItemId: string,
): QuarantineRecord {
  const candidate = {
    factIdentity: factIdentity as string,
    workspaceId: workspaceId as string,
    // Reference (not an embed) to the Divergence this record was raised from.
    divergenceRef: `${reportId}#${factIdentity}`,
    divergenceClass: "db_only" as const,
    capturedDbDigest,
    // A fresh quarantine begins pending — it gains a plan when remediation is queued.
    remediationState: "pending" as const,
    healthItemId,
    auditRef: deps.auditRef,
  };
  const parsed = QuarantineRecordSchema.safeParse(candidate);
  return parsed.success ? parsed.data : (candidate as unknown as QuarantineRecord);
}

function buildParityDefectHealthItem(
  deps: ParityDeps,
  factIdentity: FactIdentity,
  reportId: string,
  healthItemId: string,
): HealthItem {
  const candidate = {
    id: healthItemId,
    failureClass: "parity_defect" as const,
    // severity is an OPEN string upstream (no closed enum) — a hidden-brain DB-only
    // fact is a rule-1 violation, so `error`.
    severity: "error",
    message:
      `DB-only semantic fact ${factIdentity} is present in the GBrain index but not ` +
      `derivable from committed Markdown (hidden GBrain semantic truth, safety rule 1). ` +
      `Quarantined; remediation queued via the KnowledgeWriter write path.`,
    auditRef: deps.auditRef,
    openedAt: deps.now(),
    state: "open" as const,
    parityReportRef: reportId,
    factIdentity: factIdentity as string,
  };
  const parsed = HealthItemSchema.safeParse(candidate);
  return parsed.success ? parsed.data : (candidate as unknown as HealthItem);
}

function buildParityReport(
  deps: ParityDeps,
  reportId: string,
  canonical: CanonicalFactSet,
  projection: DbProjection,
  divergences: readonly Divergence[],
  flags: { cleanForServing: boolean; coverageComplete: boolean },
): ParityReport {
  const candidate = {
    reportId,
    workspaceId: canonical.workspaceId as string,
    reconciledAtRevision: canonical.revisionId as string,
    gbrainSchemaVersion: deps.gbrainSchemaVersion,
    canonicalFactCount: canonical.facts.length,
    dbFactCount: projection.facts.length,
    // oracleFactCount omitted — the rebuild oracle is a 4.16 corroborating check.
    divergences: divergences.map((d) => ({ ...d })),
    cleanForServing: flags.cleanForServing,
    coverageComplete: flags.coverageComplete,
  };
  const parsed = ParityReportSchema.safeParse(candidate);
  return parsed.success ? parsed.data : (candidate as unknown as ParityReport);
}
