// HealthItem seam model (task WT-amended, §16/§10/§11). The typed System Health
// record (OBS-1/OBS-2) consumed by the §10 API and §11 UI — one DISTINCT item
// per failure class, persistent + audit-linked, deduped, with a lifecycle
// (open → acknowledged | resolved). Zod is the single source of truth: the TS
// type is the explicit interface below, the JSON Schema is generated via
// `emitJsonSchema`. PURE — imports only foundation primitives + shared enums.
import { z } from "zod";
import { AuditIdSchema, ReportIdSchema, FactIdentitySchema } from "../primitives/zod-brands";
import type { AuditId } from "../primitives/ids";
import type { ReportId, FactIdentity } from "../primitives/zod-brands";
import { failureClassSchema, healthStateSchema } from "./shared-enums";
import type { FailureClass, HealthState } from "./shared-enums";

/** Stable JSON-Schema `$id` for the schema registry. */
export const HEALTH_ITEM_SCHEMA_ID = "sow:health-item" as const;

// Explicit output interface + annotation: the inferred type would otherwise
// force the declaration emitter to name `ids.ts`'s module-private `__brand`
// symbol (TS4023) — the same workaround `egress-policy.ts`/`shared-shapes.ts`
// use whenever a model carries branded fields (here auditRef/parityReportRef/
// factIdentity). `.strict()` rejection of unknown keys + the `.refine()`
// lifecycle invariant are unaffected.
export interface HealthItem {
  // arch_gap: no HealthItemId brand defined upstream — id is a plain non-empty
  // string (dedupe identity is (failureClass, subjectRef) per §10.3, not this id).
  id: string;
  failureClass: FailureClass;
  // arch_gap: severity taxonomy unspecified upstream — an OPEN non-empty string,
  // NOT a closed enum (no warn/error/critical set is named in §16/§10/§11).
  severity: string;
  message: string;
  auditRef: AuditId;
  openedAt: string;
  state: HealthState;
  resolvedAt?: string;
  parityReportRef?: ReportId;
  factIdentity?: FactIdentity;
}

interface HealthItemInput {
  id: string;
  failureClass: FailureClass;
  severity: string;
  message: string;
  auditRef: string;
  openedAt: string;
  state: HealthState;
  resolvedAt?: string;
  parityReportRef?: string;
  factIdentity?: string;
}

export const HealthItemSchema: z.ZodType<HealthItem, z.ZodTypeDef, HealthItemInput> = z
  .object({
    id: z.string().min(1),
    failureClass: failureClassSchema,
    severity: z.string().min(1),
    message: z.string().min(1),
    auditRef: AuditIdSchema,
    openedAt: z.string().datetime(),
    state: healthStateSchema,
    resolvedAt: z.string().datetime().optional(),
    // parityReportRef links a parity_defect/rebuild_divergence item to its
    // ParityReport (§12); factIdentity pins the offending fact for those classes.
    parityReportRef: ReportIdSchema.optional(),
    factIdentity: FactIdentitySchema.optional(),
  })
  .strict()
  // Lifecycle coupling: a resolution timestamp exists IFF the item is resolved.
  // resolved-without-resolvedAt loses the when; resolvedAt-while-open|acknowledged
  // is a contradictory record (resolved is terminal — §10.3 lifecycle).
  .refine((h) => (h.resolvedAt !== undefined) === (h.state === "resolved"), {
    message: "resolvedAt must be present IFF state === 'resolved'",
    path: ["resolvedAt"],
  });
