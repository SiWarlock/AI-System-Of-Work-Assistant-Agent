// ProviderMatrix seam model (task 1.5, §3/§5/§7). The per-workspace aggregate
// routing config: which providers a workspace may use, the default route per
// capability, and the raw-cloud-egress posture. The §5 egress veto + §7 route
// resolution read this matrix; route resolution is SOLELY from
// `capabilityDefaults[capability]`. Zod is the single source of truth: the TS
// type is `z.infer` (surfaced as an explicit nameable interface), the JSON
// Schema is generated via `emitJsonSchema`. PURE — imports only foundation
// primitives/enums + the ProviderRoute seam model (no app/adapter code).
import { z } from "zod";
import { WorkspaceIdSchema, CapabilitySchema } from "../primitives/zod-brands";
import { ProviderIdSchema } from "./shared-enums";
import { ProviderRouteSchema } from "./provider-route";
import type { WorkspaceId } from "../primitives/ids";
import type { Capability } from "../primitives/zod-brands";
import type { ProviderId } from "../primitives/enums";
import type { ProviderRoute } from "./provider-route";

/** Stable JSON-Schema `$id` for the schema registry. */
export const PROVIDER_MATRIX_SCHEMA_ID = "sow:provider-matrix" as const;

// Explicit output interface + annotation: the inferred type would otherwise force
// the declaration emitter to name `ids.ts`'s module-private `__brand` symbol
// (TS4023) via the branded `WorkspaceId` + `Capability` record key. A nameable
// `ProviderMatrix` type sidesteps that (the same workaround `egress-policy.ts` and
// `gcl-projection.ts` use); `.strict()` runtime rejection of unknown keys and the
// `.refine()` invariant are unaffected.
//
// arch_gap: the Capability taxonomy is an OPEN branded string (Capability lives in
// zod-brands as a branded non-empty string) — §7 does not pin a closed capability
// enum. `capabilityDefaults` is therefore an open map keyed by capability id whose
// values are the closed ProviderRoute union (runtime | provider branch).
//
// arch_gap: `localProviderPreference` is NOT pinned to `allowedProviders` by
// Appendix A — only the provider-branch routes in `capabilityDefaults` carry the
// subset invariant (the `.refine()` below). The preference is left unconstrained
// (a closed-enum ProviderId hint, optional) rather than inventing a subset rule
// the spec doesn't name.
export interface ProviderMatrix {
  workspaceId: WorkspaceId;
  // Closed ProviderId enum set (claude|openai|openrouter|ollama|lm_studio).
  allowedProviders: ProviderId[];
  // Open map: capability id -> resolved default route (the §7 resolution source).
  // `Partial<>` mirrors Zod's `z.record` inference for a branded-string key.
  capabilityDefaults: Partial<Record<Capability, ProviderRoute>>;
  rawCloudEgressEnabled: boolean;
  localProviderPreference?: ProviderId;
}

interface ProviderMatrixInput {
  workspaceId: string;
  allowedProviders: ProviderId[];
  capabilityDefaults: Record<string, ProviderRoute>;
  rawCloudEgressEnabled: boolean;
  localProviderPreference?: ProviderId;
}

// Consistency predicate (1.5 bullet / Appendix A): every provider referenced by a
// PROVIDER-branch route in `capabilityDefaults` must be a member of
// `allowedProviders`. Runtime-branch routes carry no `provider` and are exempt.
const everyProviderRouteAllowed = (m: ProviderMatrix): boolean => {
  const allowed = new Set<string>(m.allowedProviders);
  return Object.values(m.capabilityDefaults).every((route) =>
    route !== undefined && "provider" in route ? allowed.has(route.provider) : true,
  );
};

export const ProviderMatrixSchema: z.ZodType<
  ProviderMatrix,
  z.ZodTypeDef,
  ProviderMatrixInput
> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    allowedProviders: z.array(ProviderIdSchema),
    capabilityDefaults: z.record(CapabilitySchema, ProviderRouteSchema),
    rawCloudEgressEnabled: z.boolean(),
    localProviderPreference: ProviderIdSchema.optional(),
  })
  .strict()
  .refine(everyProviderRouteAllowed, {
    message:
      "every provider-branch route in capabilityDefaults must reference a provider in allowedProviders",
    path: ["capabilityDefaults"],
  });
