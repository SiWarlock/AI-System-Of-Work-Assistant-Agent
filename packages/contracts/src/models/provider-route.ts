// ProviderRoute seam model (task 1.4, §3/§7). A resolved routing target for a
// capability: EITHER an agentic runtime (AgentRuntimePort — Claude Agent SDK,
// Hermes) OR a raw model provider (ModelProviderPort — Claude, OpenAI,
// OpenRouter, Ollama, LM Studio). §7 keeps the two ports as separate layers;
// this contract enforces "exactly one" structurally. Zod is the single source
// of truth: the TS type is `z.infer`, the JSON Schema is generated via
// `emitJsonSchema`. PURE — imports only foundation primitives/enums.
import { z } from "zod";
import { ProviderIdSchema, EgressClassSchema } from "./shared-enums";

/** Stable JSON-Schema `$id` for the schema registry. */
export const PROVIDER_ROUTE_SCHEMA_ID = "sow:provider-route" as const;

// Shared fields present on BOTH branches. Authored once so the two branch
// objects can't drift.
//   - model:    arch_gap: the model-id catalog is unspecified upstream (varies
//               per runtime/provider, e.g. claude-opus-4 | anthropic/claude-opus-4
//               | llama3.1) — open non-empty string until §7 names a catalog.
//   - endpoint: arch_gap: the endpoint address format is unspecified upstream
//               (cloud base URL, local host:port, or socket path for Ollama/
//               LM Studio) — open non-empty string, NOT constrained to a URL.
//   - egressClass: closed EgressClass enum. `"local"` marks a NON-EGRESS route —
//               the §5 egress veto's only legal pick for an unacknowledged
//               Employer-Work raw-content job. (The veto predicate lives in §7,
//               not here; this contract only carries the marker.)
const routeCommon = {
  model: z.string().min(1),
  endpoint: z.string().min(1),
  egressClass: EgressClassSchema,
};

// Discriminated by which port-key is present. `z.union` (not
// `z.discriminatedUnion`) so mutual exclusivity rides on `.strict()`: a foreign
// discriminator (`provider` on the runtime branch, or vice-versa) is an unknown
// key on the branch it doesn't belong to → rejected; a route with BOTH keys
// fails BOTH branches; a route with NEITHER fails the required-key check on both.
//   - runtime:  arch_gap: the agent-runtime id catalog is open (e.g.
//               claude-agent-sdk | hermes) — non-empty string, not a closed enum.
//   - provider: closed ProviderId enum (claude|openai|openrouter|ollama|lm_studio).
export const ProviderRouteSchema = z.union([
  z.object({ runtime: z.string().min(1), ...routeCommon }).strict(),
  z.object({ provider: ProviderIdSchema, ...routeCommon }).strict(),
]);

export type ProviderRoute = z.infer<typeof ProviderRouteSchema>;
