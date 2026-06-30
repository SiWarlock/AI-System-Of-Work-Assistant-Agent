// ParityReport seam model (task WT, §6/§12/§16). The revision-scoped OPERATIONAL
// record the SoW-owned ParityReconciler emits each reconciliation pass: it
// reconciles the gbrain-independent canonical-Markdown fact set against the
// read-only DB projection (and, when run, a rebuild oracle), embeds the per-fact
// `Divergence[]` it classified, and carries the two booleans the serving gate
// reads — `cleanForServing` (no serving-blocking parity defect) and
// `coverageComplete` (the pass covered the full set). A dirty/incomplete report
// degrades the workspace to Markdown-provenanced-only serving (§12 fail-closed).
// Operational truth (not rebuildable — backed up, never reconstructed). Zod is
// the single source of truth: the TS type is `z.infer` (surfaced via an explicit
// `ParityReport` interface), the JSON Schema is generated via `emitJsonSchema`.
// PURE — imports only foundation primitives + the sibling Divergence seam model.
import { z } from "zod";
import {
  ReportIdSchema,
  WorkspaceIdSchema,
  RevisionIdSchema,
} from "../primitives/zod-brands";
import { DivergenceSchema } from "./divergence";
import type { ReportId, RevisionId } from "../primitives/zod-brands";
import type { WorkspaceId } from "../primitives/ids";
import type { Divergence } from "./divergence";

/** Stable JSON-Schema `$id` for the schema registry. */
export const PARITY_REPORT_SCHEMA_ID = "sow:parity-report" as const;

// Explicit output interface + annotation: the inferred type would otherwise force
// the declaration emitter to name `ids.ts`'s module-private `__brand` symbol
// (TS4023) via the branded `ReportId` / `WorkspaceId` / `RevisionId` (and the
// branded fields of the embedded `Divergence`). A nameable `ParityReport` type
// sidesteps that — the same workaround `egress-policy.ts` / `divergence.ts` use;
// `.strict()` runtime rejection of unknown keys and the `.refine()` invariant are
// unaffected.
export interface ParityReport {
  reportId: ReportId;
  workspaceId: WorkspaceId;
  // The Markdown revision this reconciliation was scoped to (the allow-set is
  // keyed by `(workspaceId, revisionId)`; reconciliation is revision-scoped).
  reconciledAtRevision: RevisionId;
  // arch_gap: the gbrain index/doctor schema_version (`gbrain doctor --json`).
  // Appendix A names the field but not its representation — modeled as an OPEN
  // `number` (NOT constrained to int/nonnegative) per the task invariant, never a
  // closed shape; the precise versioning scheme is unspecified upstream.
  gbrainSchemaVersion: number;
  // Count of facts the gbrain-independent CanonicalFactDeriver derived from
  // committed Markdown at `reconciledAtRevision`.
  canonicalFactCount: number;
  // Count of facts in the read-only DB projection.
  dbFactCount: number;
  // Count of facts the rebuild oracle derived — OPTIONAL: the oracle is only a
  // corroborating cross-check (its disagreement is a defect, never calibration)
  // and does not run on every pass.
  oracleFactCount?: number;
  // The per-fact disagreements this pass classified (empty ⇒ a clean reconcile).
  // The REAL Divergence schema is embedded — its closed class lattice + its own
  // db_only/unstamped ⇒ HARD-floor refine apply transitively.
  divergences: Divergence[];
  // No serving-blocking (HARD-floor) parity defect was found — the report is not
  // "dirty". Enforced against `divergences` by the refine below.
  cleanForServing: boolean;
  // The pass covered the full fact set. arch_gap: INDEPENDENT of `cleanForServing`
  // — the serving gate ANDs the two (a clean-but-incomplete report still degrades
  // serving, §12); Appendix A does not couple them at the model level, so no
  // model-level cross-field constraint is imposed between them.
  coverageComplete: boolean;
}

interface ParityReportInput {
  reportId: string;
  workspaceId: string;
  reconciledAtRevision: string;
  gbrainSchemaVersion: number;
  canonicalFactCount: number;
  dbFactCount: number;
  oracleFactCount?: number;
  // The embedded Divergence carries branded fields, so its parse INPUT differs
  // from its output — take it straight from the sibling schema.
  divergences: z.input<typeof DivergenceSchema>[];
  cleanForServing: boolean;
  coverageComplete: boolean;
}

export const ParityReportSchema: z.ZodType<ParityReport, z.ZodTypeDef, ParityReportInput> = z
  .object({
    reportId: ReportIdSchema,
    workspaceId: WorkspaceIdSchema,
    reconciledAtRevision: RevisionIdSchema,
    // Open `number` (see interface arch_gap) — deliberately NOT int/nonnegative.
    gbrainSchemaVersion: z.number(),
    // Counts are non-negative integers (0 is valid: a clean/empty workspace).
    canonicalFactCount: z.number().int().nonnegative(),
    dbFactCount: z.number().int().nonnegative(),
    oracleFactCount: z.number().int().nonnegative().optional(),
    divergences: z.array(DivergenceSchema),
    cleanForServing: z.boolean(),
    coverageComplete: z.boolean(),
  })
  .strict()
  // Conditional invariant (§12 fail-closed): a HARD-floor divergence (db_only /
  // unstamped) is a non-downgradable parity defect that quarantines the fact and
  // makes the report "dirty" → the workspace degrades to Markdown-provenanced-only
  // serving. So a report carrying ANY HARD-floor divergence cannot claim
  // `cleanForServing`. (One-directional: `cleanForServing === false` is always
  // permitted, including with hard divergences; `coverageComplete` is independent.)
  .refine(
    (r) =>
      !r.cleanForServing || !r.divergences.some((d) => d.severityFloor === "hard"),
    {
      message:
        "cleanForServing must be false when any divergence carries a HARD severity floor (db_only/unstamped parity defect)",
      path: ["cleanForServing"],
    },
  );
