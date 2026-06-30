// GbrainReadGrant seam model (task WT, §6/§7). The typed proof that NO
// write/admin token or generation capability reaches the GBrain runtime: every
// grant minted for the runtime is read-only (scope:['read']), workspace-scoped
// (no cross-brain federation), generation-disabled, and bound to a pinned index
// build. Appendix A pairs this with `GbrainServePolicy` — they SHARE one field
// set, so `GbrainServePolicySchema` is an alias of this schema (see flags). Zod
// is the single source of truth: the TS type is the explicit interface below
// (the inferred type would leak `ids.ts`'s private brand symbol — TS4023), the
// JSON Schema is generated via `emitJsonSchema`. PURE — imports only foundation
// primitives + shared enums.
import { z } from "zod";
import { WorkspaceIdSchema, BrainIdSchema } from "../primitives/zod-brands";
import { gbrainAllowedOpSchema } from "./shared-enums";
import type { WorkspaceId } from "../primitives/ids";
import type { BrainId } from "../primitives/zod-brands";
import type { GbrainAllowedOp } from "./shared-enums";

/** Stable JSON-Schema `$id` for the schema registry. */
export const GBRAIN_READ_GRANT_SCHEMA_ID = "sow:gbrain-read-grant" as const;

// Explicit output interface + annotation: the inferred type would otherwise
// force the declaration emitter to name `ids.ts`'s module-private `__brand`
// symbol (TS4023) — the same workaround `egress-policy.ts` / `tool-policy.ts`
// use for branded fields. A nameable `GbrainReadGrant` type sidesteps that;
// `.strict()` runtime rejection of unknown keys and the literal invariants are
// unaffected.
export interface GbrainReadGrant {
  workspaceId: WorkspaceId;
  brainId: BrainId;
  transport: "http";
  scope: "read"[];
  tokenRef: string;
  allowedOps: GbrainAllowedOp[];
  federationScope: "workspace_only";
  generativeCycleEnabled: false;
  pinnedSha: string;
  indexSchemaVersion: number;
}

interface GbrainReadGrantInput {
  workspaceId: string;
  brainId: string;
  transport: "http";
  scope: "read"[];
  tokenRef: string;
  allowedOps: GbrainAllowedOp[];
  federationScope: "workspace_only";
  generativeCycleEnabled: false;
  pinnedSha: string;
  indexSchemaVersion: number;
}

// Every invariant here is a LITERAL constraint (no conditional cross-field
// `.refine` is implied by Appendix A), and together they ARE the safety proof:
//   • transport: only HTTP serving is granted.
//   • scope: a `read` literal array — no write/admin scope can be encoded.
//   • allowedOps ⊆ the read-op enum {search,graph,timeline,schema_read,health,
//     contained_synthesis}; any mutating/admin op is rejected at the gate.
//   • federationScope: workspace_only — no cross-brain federation (WS-8).
//   • generativeCycleEnabled: hard-off (the generative cycle never runs here).
// arch_gap: `tokenRef` is a Keychain reference handle and `pinnedSha` a pinned
// index build SHA — Appendix A specifies neither format, so both are modeled as
// open non-empty strings (no Keychain-URI / 40-hex shape pinned upstream).
// arch_gap: `scope` is modeled as `z.array(z.literal('read'))` per the spec
// value `['read']`; cardinality (exactly-one / non-empty) is NOT pinned upstream,
// so `[]` and duplicate `['read','read']` are structurally accepted (see flags).
export const GbrainReadGrantSchema: z.ZodType<
  GbrainReadGrant,
  z.ZodTypeDef,
  GbrainReadGrantInput
> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    brainId: BrainIdSchema,
    transport: z.literal("http"),
    scope: z.array(z.literal("read")),
    tokenRef: z.string().min(1),
    allowedOps: z.array(gbrainAllowedOpSchema),
    federationScope: z.literal("workspace_only"),
    generativeCycleEnabled: z.literal(false),
    pinnedSha: z.string().min(1),
    indexSchemaVersion: z.number(),
  })
  .strict();

// ── Appendix-A alias: GbrainServePolicy IS GbrainReadGrant ───────────────────
// Appendix A pairs `GbrainReadGrant / GbrainServePolicy` as one row with one
// field set. They are the SAME contract under two names (the runtime-facing read
// grant === the serve-side policy that mints it), so both the schema and the
// type are exported as aliases — there is no second schema/field set to freeze.
export const GbrainServePolicySchema = GbrainReadGrantSchema;
export type GbrainServePolicy = GbrainReadGrant;
/** Alias of {@link GBRAIN_READ_GRANT_SCHEMA_ID} — the pair shares one `$id`. */
export const GBRAIN_SERVE_POLICY_SCHEMA_ID = GBRAIN_READ_GRANT_SCHEMA_ID;
