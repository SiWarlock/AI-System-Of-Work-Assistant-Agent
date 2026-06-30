// QuarantineRecord seam model (task WT, §6/§16). OPERATIONAL TRUTH — the durable
// record of a quarantined parity defect: a DB-only (or otherwise diverged)
// semantic fact that safety rule 1 ("one writer / no hidden brain") forbids from
// being served as canonical until it is remediated. A QuarantineRecord pins WHICH
// fact (factIdentity, content-INDEPENDENT) in WHICH workspace diverged, names the
// Divergence it came from BY REFERENCE (divergenceRef — it does NOT embed the
// Divergence object), snapshots the offending DB state (capturedDbDigest), and
// tracks where remediation stands (remediationState). It is audit-linked
// (auditRef), health-linked (healthItemId), and optionally tied to the remediation
// KnowledgeMutationPlan (planId?). Zod is the single source of truth: the TS type
// is the explicit interface below, the JSON Schema is generated via
// `emitJsonSchema`. PURE — imports only foundation primitives + shared enums.
import { z } from "zod";
import {
  FactIdentitySchema,
  WorkspaceIdSchema,
  AuditIdSchema,
  PlanIdSchema,
} from "../primitives/zod-brands";
import { divergenceClassSchema, remediationStateSchema } from "./shared-enums";
import type { FactIdentity } from "../primitives/zod-brands";
import type { WorkspaceId, AuditId, PlanId } from "../primitives/ids";
import type { DivergenceClass, RemediationState } from "./shared-enums";

/** Stable JSON-Schema `$id` for the schema registry. */
export const QUARANTINE_RECORD_SCHEMA_ID = "sow:quarantine-record" as const;

// Explicit output interface + annotation: the inferred type would otherwise
// force the declaration emitter to name `ids.ts`'s module-private `__brand`
// symbol (TS4023) — the same workaround `egress-policy.ts`/`health-item.ts` use
// whenever a model carries branded fields (here factIdentity/workspaceId/
// auditRef/planId). `.strict()` rejection of unknown keys is unaffected.
export interface QuarantineRecord {
  // content-INDEPENDENT structured identity (page:/link:/timeline:/tag:) — pins
  // the fact's LOCATION, never its content hash, so a content edit keeps the same
  // QuarantineRecord identity rather than spawning a phantom new/missing entry.
  factIdentity: FactIdentity;
  workspaceId: WorkspaceId;
  // arch_gap: divergenceRef is the id of the Divergence (§12) this record was
  // raised from — a REFERENCE, never the embedded Divergence object. No
  // DivergenceId brand is defined upstream (a Divergence is keyed by its
  // factIdentity in the ParityReport, but the ref grammar QuarantineRecord uses
  // is unspecified), so it is an OPEN non-empty string.
  divergenceRef: string;
  divergenceClass: DivergenceClass;
  // arch_gap: capturedDbDigest snapshots the quarantined DB-side state at capture
  // time (so post-hoc tampering is detectable). Its digest algorithm/encoding is
  // unspecified upstream — modeled as an OPEN non-empty string, NOT a fixed
  // sha256-hex brand (capture may hash a row, an edge, or a serialized projection).
  capturedDbDigest: string;
  remediationState: RemediationState;
  // arch_gap: healthItemId references the HealthItem (§16) opened for this
  // quarantine. HealthItem.id is itself a plain non-empty string upstream (no
  // HealthItemId brand), so this mirror is an OPEN non-empty string.
  healthItemId: string;
  auditRef: AuditId;
  // Optional: the remediation KnowledgeMutationPlan once one exists (a quarantine
  // begins with no plan — pending — and gains one when remediation is scheduled).
  planId?: PlanId;
}

interface QuarantineRecordInput {
  factIdentity: string;
  workspaceId: string;
  divergenceRef: string;
  divergenceClass: DivergenceClass;
  capturedDbDigest: string;
  remediationState: RemediationState;
  healthItemId: string;
  auditRef: string;
  planId?: string;
}

// DESCRIPTIVE, NOT PRESCRIPTIVE — no cross-field refine. divergenceClass and
// remediationState are INDEPENDENT dimensions: a record must be able to REPRESENT
// every (class, state) pair the parity layer might encounter, including an
// adversarial/defective one (e.g. a HARD `db_only`/`unstamped` divergence that
// was wrongly `dismissed`) so the layer can DETECT and re-open it. Appendix A
// names no QuarantineRecord-specific conditional coupling, so adding one (e.g.
// "HARD class ⟹ not dismissed", or "edge_* class ⟹ link: identity") would invent
// semantics and make legitimate-to-store defect states unrepresentable — the
// latent contract bug `fact-provenance.ts` documents. The §12 "non-downgradable"
// rule lives on Divergence.severityFloor, not here. Invariants are field-level:
// required fields, branded non-empty ids, the two enums, and the content-
// independent factIdentity regex.
export const QuarantineRecordSchema: z.ZodType<
  QuarantineRecord,
  z.ZodTypeDef,
  QuarantineRecordInput
> = z
  .object({
    factIdentity: FactIdentitySchema,
    workspaceId: WorkspaceIdSchema,
    divergenceRef: z.string().min(1),
    divergenceClass: divergenceClassSchema,
    capturedDbDigest: z.string().min(1),
    remediationState: remediationStateSchema,
    healthItemId: z.string().min(1),
    auditRef: AuditIdSchema,
    planId: PlanIdSchema.optional(),
  })
  .strict();
