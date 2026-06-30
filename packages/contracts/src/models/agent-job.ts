// AgentJob seam model (task 1.6, §3/§7/§9). The unit of agentic work the worker
// Broker dispatches: a capability bound to a resolved ProviderRoute + ToolPolicy,
// carrying the trust + budget pins the §5 egress-veto / ING-7 admission gate and
// the COST-1 budget caps read as PURE functions of these fields. Zod is the
// single source of truth: the TS type is this explicit interface (matching
// `z.infer`), the JSON Schema is generated via `emitJsonSchema`. PURE — imports
// only foundation primitives + sibling seam models (no app/adapter code).
import { z } from "zod";
import {
  AgentJobIdSchema,
  WorkflowIdSchema,
  WorkspaceIdSchema,
  CapabilitySchema,
} from "../primitives/zod-brands";
import { ContextRefSchema } from "./shared-shapes";
import { trustLevelSchema } from "./shared-enums";
import { ToolPolicySchema } from "./tool-policy";
import { ProviderRouteSchema } from "./provider-route";
import type { AgentJobId, WorkflowId, WorkspaceId } from "../primitives/ids";
import type { Capability } from "../primitives/zod-brands";
import type { ContextRef } from "./shared-shapes";
import type { ToolPolicy } from "./tool-policy";
import type { ProviderRoute } from "./provider-route";
import type { TrustLevel } from "./shared-enums";
import type { SchemaRegistry } from "../schema/registry";

/** Stable JSON-Schema `$id` for the schema registry. */
export const AGENT_JOB_SCHEMA_ID = "sow:agent-job" as const;

// Explicit output interface + annotation: the inferred type would otherwise force
// the declaration emitter to name `ids.ts`'s module-private `__brand` symbol
// (TS4023, since `id`/`workflowRunId`/`workspaceId`/`capability` are branded) —
// the same workaround `egress-policy.ts` / `tool-policy.ts` / `shared-shapes.ts`
// use. A nameable `AgentJob` type sidesteps that; `.strict()` runtime rejection
// of unknown keys and the embedded-policy gates are unaffected.
export interface AgentJob {
  id: AgentJobId;
  workflowRunId: WorkflowId;
  workspaceId: WorkspaceId;
  capability: Capability;
  // arch_gap: the ContextRef taxonomy (refKind values + ref formats) is the
  // foundation arch_gap recorded on ContextRefSchema (§9/runtime unspecified).
  contextRefs: ContextRef[];
  // §3 referential pin: a non-empty schema id. Whether it actually NAMES a
  // registered schema is environment state, checked by `isRegisteredOutputSchema`
  // against a `SchemaRegistry` — not a schema-level field constraint.
  outputSchemaId: string;
  toolPolicy: ToolPolicy;
  providerRoute: ProviderRoute;
  trustLevel: TrustLevel; // "trusted" | "untrusted"
  carriesRawContent: boolean;
  // COST-1 budget pins. maxRuntimeSeconds is a required hard cap; maxCostUsd is
  // an optional cost ceiling. arch_gap: integrality/units beyond "positive
  // seconds"/"positive USD" are unspecified upstream — left as positive numbers.
  maxRuntimeSeconds: number;
  maxCostUsd?: number;
  idempotencyKey: string;
}

// Input (pre-parse) shape: branded fields accept raw strings; the embedded
// ToolPolicy input takes raw `string[]` tool ids (its branded output is produced
// by parse). Declared inline (not via `z.input<typeof ToolPolicySchema>`) so the
// emitted declaration never has to name `tool-policy.ts`'s un-exported
// `ToolPolicyInput`.
interface AgentJobInput {
  id: string;
  workflowRunId: string;
  workspaceId: string;
  capability: string;
  contextRefs: ContextRef[];
  outputSchemaId: string;
  toolPolicy: {
    mode: "read_only" | "scoped_write";
    allowedTools: string[];
    deniedTools: string[];
    allowsMutating: boolean;
  };
  providerRoute: ProviderRoute;
  trustLevel: TrustLevel;
  carriesRawContent: boolean;
  maxRuntimeSeconds: number;
  maxCostUsd?: number;
  idempotencyKey: string;
}

// No top-level `.refine`: AgentJob's cross-field controls (the §5 egress veto and
// the ING-7 untrusted-content admission gate) are SEPARATE pure predicates over
// these fields + `EgressPolicy`/`ToolPolicy` (they live in §5/§7, not this
// contract). This schema pins only the structural + field-level invariants;
// embedded `ToolPolicySchema` (read_only ⇒ !allowsMutating) and
// `ProviderRouteSchema` (exactly one of runtime|provider) gates bubble up
// through the parent parse.
export const AgentJobSchema: z.ZodType<AgentJob, z.ZodTypeDef, AgentJobInput> = z
  .object({
    id: AgentJobIdSchema,
    workflowRunId: WorkflowIdSchema,
    workspaceId: WorkspaceIdSchema,
    capability: CapabilitySchema,
    contextRefs: z.array(ContextRefSchema),
    outputSchemaId: z.string().min(1),
    toolPolicy: ToolPolicySchema,
    providerRoute: ProviderRouteSchema,
    trustLevel: trustLevelSchema,
    carriesRawContent: z.boolean(),
    maxRuntimeSeconds: z.number().positive(),
    maxCostUsd: z.number().positive().optional(),
    idempotencyKey: z.string().min(1),
  })
  .strict();

/**
 * §3 referential pin: an AgentJob's `outputSchemaId` must name a schema that is
 * actually registered, so the candidate-data gate (REQ-S-006) has a validator to
 * run the agent's output through before any side effect. Pure lookup against a
 * provided `SchemaRegistry` — registration is environment state, so it lives in
 * this predicate rather than a schema-level constraint. Never throws.
 */
export function isRegisteredOutputSchema(id: string, registry: SchemaRegistry): boolean {
  return registry.has(id);
}
