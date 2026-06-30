// ProviderProfile seam model (task 1.4, §3/§4/§7). The typed description of a
// configured provider endpoint the ProviderMatrix routes capabilities onto.
// Zod is the single source of truth: the TS type is `z.infer` (surfaced via an
// explicit interface — see below), the JSON Schema is generated via
// `emitJsonSchema`. PURE — imports only foundation primitives + shared enums.
//
// REQ-S-003 (safety rule 7): NO inline secret. The schema carries NO
// apiKey/apiKeyRef/secret/token/key/credentials field — provider secrets are
// resolved ONLY through SecretsPort/Keychain (Appendix A: "keys in Keychain").
// `.strict()` makes that absence load-bearing: any inline secret key is rejected.
import { z } from "zod";
import { ProviderIdSchema, EgressClassSchema, conformanceStatusSchema } from "./shared-enums";
import { CapabilitySchema } from "../primitives/zod-brands";
import type { Capability } from "../primitives/zod-brands";
import type { ProviderId, EgressClass } from "../primitives/enums";
import type { ConformanceStatus } from "./shared-enums";

/** Stable JSON-Schema `$id` for the schema registry. */
export const PROVIDER_PROFILE_SCHEMA_ID = "sow:provider-profile" as const;

// arch_gap: costCaps is the minimal spec-implied budget shape — Appendix A names
// only `costCaps` with no inner field list. §7's matrix-eligibility / budget
// semantics imply a per-job cost ceiling + a runtime ceiling; both are modeled
// OPEN (optional, positive) until §7 firms the budget contract. No other budget
// dimension (token caps, rate limits) is invented here.
export interface CostCaps {
  maxCostUsd?: number;
  maxRuntimeSeconds?: number;
}

// Explicit output interface + annotation: the inferred type embeds the
// `Capability` brand, which would otherwise force the declaration emitter to
// name `ids.ts`'s module-private `__brand` symbol (TS4023) — the same workaround
// EgressPolicy / shared-shapes' SourceRef use. A nameable `ProviderProfile` type
// sidesteps that; `.strict()` runtime rejection of unknown keys (incl. inline
// secrets) is unaffected.
export interface ProviderProfile {
  provider: ProviderId;
  endpoint: string;
  model: string;
  capabilities: Capability[];
  egressClass: EgressClass;
  costCaps: CostCaps;
  conformanceStatus: ConformanceStatus;
}

interface ProviderProfileInput {
  provider: ProviderId;
  endpoint: string;
  model: string;
  capabilities: string[];
  egressClass: EgressClass;
  costCaps: CostCaps;
  conformanceStatus: ConformanceStatus;
}

// costCaps is required (Appendix A lists it unconditionally); its inner ceilings
// are each OPTIONAL but, when present, must be strictly positive — a zero or
// negative cost/runtime cap is a malformed budget. `.strict()` on the inner
// object rejects any unknown budget key.
const CostCapsSchema = z
  .object({
    maxCostUsd: z.number().positive().optional(),
    maxRuntimeSeconds: z.number().positive().optional(),
  })
  .strict();

export const ProviderProfileSchema: z.ZodType<
  ProviderProfile,
  z.ZodTypeDef,
  ProviderProfileInput
> = z
  .object({
    // Closed provider enum (claude|openai|openrouter|ollama|lm_studio). OpenRouter
    // is its OWN provider, NOT an OpenAI alias (safety rule 5).
    provider: ProviderIdSchema,
    endpoint: z.string().min(1),
    model: z.string().min(1),
    // capabilities: Capability[] — open branded capability ids (config-driven
    // membership, e.g. meeting.close / notebooklm.sync), NOT a closed enum.
    capabilities: z.array(CapabilitySchema),
    egressClass: EgressClassSchema,
    costCaps: CostCapsSchema,
    // conformanceStatus ∈ unknown|passing|failing|disabled. A non-passing profile
    // is REPRESENTABLE (not rejected) — the matrix-eligibility predicate that
    // gates routing on it lives in §7, not in this contract.
    conformanceStatus: conformanceStatusSchema,
  })
  .strict();
