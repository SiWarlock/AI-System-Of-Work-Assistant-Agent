// Divergence seam model (task WT, §6/§12). The per-fact unit of GBrain
// write-through PARITY reconciliation: one Divergence records that a single
// content-INDEPENDENT `factIdentity` disagrees between the canonical Markdown
// derive and the read-only DB projection, classifies the disagreement, pins the
// non-downgradable severity floor, and names the remediation route. Embedded in
// `ParityReport.divergences[]` and referenced by `QuarantineRecord.divergenceRef`.
// Zod is the single source of truth: the TS type is `z.infer` (surfaced via an
// explicit `Divergence` interface), the JSON Schema is generated via
// `emitJsonSchema`. PURE — imports only foundation primitives.
import { z } from "zod";
import { FactIdentitySchema, MdContentShaSchema } from "../primitives/zod-brands";
import {
  divergenceClassSchema,
  severityFloorSchema,
  remediationSchema,
} from "./shared-enums";
import type { FactIdentity, MdContentSha } from "../primitives/zod-brands";
import type {
  DivergenceClass,
  SeverityFloor,
  Remediation,
} from "./shared-enums";

/** Stable JSON-Schema `$id` for the schema registry. */
export const DIVERGENCE_SCHEMA_ID = "sow:divergence" as const;

// Explicit output interface + annotation: the inferred type would otherwise
// force the declaration emitter to name `ids.ts`'s module-private `__brand`
// symbol (TS4023) — the same workaround `semantic-fact.ts`/`egress-policy.ts`
// use. A nameable `Divergence` type sidesteps that; `.strict()` runtime
// rejection of unknown keys and the `.refine()` invariant are unaffected.
export interface Divergence {
  factIdentity: FactIdentity;
  divergenceClass: DivergenceClass;
  severityFloor: SeverityFloor;
  // arch_gap: present only for the side(s) that carry materialized content
  // (content_mismatch / md_only / stale_revision). Appendix A does NOT specify
  // a class→digest-presence coupling, so it is left unconstrained.
  mdContentSha?: MdContentSha;
  // arch_gap: the DB digest format is unspecified upstream — modeled as an OPEN
  // non-empty string (NOT the canonical-Markdown sha256), never a closed shape.
  dbContentHash?: string;
  remediation: Remediation;
}

interface DivergenceInput {
  factIdentity: string;
  divergenceClass: DivergenceClass;
  severityFloor: SeverityFloor;
  mdContentSha?: string;
  dbContentHash?: string;
  remediation: Remediation;
}

export const DivergenceSchema: z.ZodType<Divergence, z.ZodTypeDef, DivergenceInput> = z
  .object({
    factIdentity: FactIdentitySchema,
    divergenceClass: divergenceClassSchema,
    severityFloor: severityFloorSchema,
    mdContentSha: MdContentShaSchema.optional(),
    dbContentHash: z.string().min(1).optional(),
    remediation: remediationSchema,
  })
  .strict()
  // Conditional invariant (§12): a db_only or unstamped divergence is a HARD
  // parity defect whose floor cannot be downgraded — so its severityFloor MUST
  // be "hard". arch_gap: "non-downgradable" is a lifecycle property (the floor
  // may not be *lowered* across reconciliations); a single static record can
  // only pin the floor value here, not enforce monotonicity over time.
  .refine(
    (d) =>
      !(d.divergenceClass === "db_only" || d.divergenceClass === "unstamped") ||
      d.severityFloor === "hard",
    {
      message:
        "severityFloor must be 'hard' (non-downgradable) when divergenceClass is db_only or unstamped",
      path: ["severityFloor"],
    },
  );
