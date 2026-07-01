// ConformanceResult seam model (task 5.10, §7/§12/§4). The persisted outcome of
// one conformance evaluation: a subject (a raw ModelProviderPort provider OR an
// agentic AgentRuntimePort runtime) × capability × pinned-model pair, with the
// pass/fail verdict the §7 matrix-eligibility gate reads. Stored in the §4
// operational store; its `status` maps directly onto `ProviderProfile.conformanceStatus`.
//
// Zod is the single source of truth (ADR-008): the TS type is surfaced via an
// explicit nameable interface (the branded `Capability` would otherwise force
// the declaration emitter to name `ids.ts`'s module-private `__brand` symbol —
// TS4023, the same workaround ProviderProfile / ProviderMatrix use), the JSON
// Schema is generated via `emitJsonSchema`. PURE — imports only foundation
// primitives + shared enums.
//
// REQ-S-003 / §16 redaction: `detail` is a redaction-SAFE failure summary only —
// the harness derives it from a typed error KIND + JSON-Schema field paths, never
// from raw provider content or a secret. `.strict()` rejects any unknown key.
import { z } from "zod";
import { EgressClassSchema, conformanceStatusSchema } from "../models/shared-enums";
import { CapabilitySchema } from "../primitives/zod-brands";
import type { Capability } from "../primitives/zod-brands";
import type { EgressClass } from "../primitives/enums";
import type { ConformanceStatus } from "../models/shared-enums";

/** Stable JSON-Schema `$id` for the schema registry. */
export const CONFORMANCE_RESULT_SCHEMA_ID = "sow:conformance-result" as const;

// Which port layer the certified subject belongs to. NEW closed enum, specific to
// this contract (declared here, not in shared-enums, because no other model uses
// it): 'provider' = a ModelProviderPort provider; 'runtime' = an AgentRuntimePort
// agentic runtime. "Claude" can appear under both kinds (Claude model provider vs
// Claude Agent SDK runtime) — the pair is disambiguated by (subjectKind, subjectId).
export const ConformanceSubjectKind = ["provider", "runtime"] as const;
export const conformanceSubjectKindSchema = z.enum(ConformanceSubjectKind);
export type ConformanceSubjectKind = z.infer<typeof conformanceSubjectKindSchema>;

export interface ConformanceResult {
  subjectKind: ConformanceSubjectKind;
  // providerId (claude|openai|…) for a provider subject, or the OPEN runtime id
  // (claude-agent-sdk|hermes|…) for a runtime subject — an open non-empty string,
  // NOT the closed ProviderId enum (runtime ids are open, per ProviderRoute).
  subjectId: string;
  capability: Capability;
  // Pinned model id (arch_gap: no upstream catalog — open non-empty string).
  model: string;
  // 'local' marks a NON-EGRESS (zero-egress) subject; a local-conformance failure
  // does NOT block the meeting.close DoD gate (§7), a cloud failure does.
  egressClass: EgressClass;
  // unknown|passing|failing|disabled — the same enum ProviderProfile carries.
  status: ConformanceStatus;
  // Redaction-safe failure summary (error kind + schema field paths); absent on pass.
  detail?: string;
  // ISO-8601 datetime the conformance was evaluated (caller-supplied; no clock here).
  checkedAt: string;
}

interface ConformanceResultInput {
  subjectKind: ConformanceSubjectKind;
  subjectId: string;
  capability: string;
  model: string;
  egressClass: EgressClass;
  status: ConformanceStatus;
  detail?: string;
  checkedAt: string;
}

export const ConformanceResultSchema: z.ZodType<
  ConformanceResult,
  z.ZodTypeDef,
  ConformanceResultInput
> = z
  .object({
    subjectKind: conformanceSubjectKindSchema,
    subjectId: z.string().min(1),
    // capability: branded non-empty id (open taxonomy, e.g. meeting.close).
    capability: CapabilitySchema,
    model: z.string().min(1),
    egressClass: EgressClassSchema,
    status: conformanceStatusSchema,
    detail: z.string().min(1).optional(),
    checkedAt: z.string().datetime(),
  })
  .strict();
