// ToolPolicy seam model (task 1.3, §3/§5/§7). Gates the ING-7 untrusted-content
// job-admission gate (safety rule 6) and is carried by value on an AgentJob so
// the §5 admission predicate evaluates without extra lookups. Zod is the single
// source of truth: the TS type is `z.infer`-shaped, the JSON Schema is generated
// via `emitJsonSchema`. PURE — imports only foundation primitives.
import { z } from "zod";
import { ToolIdSchema } from "../primitives/zod-brands";
import type { ToolId } from "../primitives/enums";

/** Stable JSON-Schema `$id` for the schema registry. */
export const TOOL_POLICY_SCHEMA_ID = "sow:tool-policy" as const;

// Explicit output interface + annotation: the inferred type would otherwise
// force the declaration emitter to name `ids.ts`'s module-private `__brand`
// symbol (TS4023) — the same workaround `egress-policy.ts` / `shared-shapes.ts`
// use for branded fields. A nameable `ToolPolicy` type sidesteps that; `.strict()`
// runtime rejection of unknown keys and the `.refine()` invariant are unaffected.
export interface ToolPolicy {
  mode: "read_only" | "scoped_write";
  allowedTools: ToolId[];
  deniedTools: ToolId[];
  allowsMutating: boolean;
}

interface ToolPolicyInput {
  mode: "read_only" | "scoped_write";
  allowedTools: string[];
  deniedTools: string[];
  allowsMutating: boolean;
}

// arch_gap: there is no mutating-tool catalog upstream — `ToolId` is an open
// branded string (catalog unspecified; arch_gap recorded on the ToolId
// primitive). So the §3/1.3 "read_only ⇒ allowedTools contains no mutating tool"
// clause is NOT enforceable here (we cannot classify a ToolId as mutating). This
// model pins only the catalog-independent half: read_only ⇒ !allowsMutating. The
// per-tool mutation check is deferred to the §5 admission gate once a catalog
// (or a mutating-tool predicate) exists.
export const ToolPolicySchema: z.ZodType<ToolPolicy, z.ZodTypeDef, ToolPolicyInput> = z
  .object({
    mode: z.enum(["read_only", "scoped_write"]),
    allowedTools: z.array(ToolIdSchema),
    deniedTools: z.array(ToolIdSchema),
    allowsMutating: z.boolean(),
  })
  .strict()
  // Construction-time consistency: a read_only policy that declares it admits
  // mutating tools is a contradictory record — reject it at the schema gate.
  .refine((p) => !(p.mode === "read_only" && p.allowsMutating === true), {
    message: "read_only ToolPolicy cannot set allowsMutating === true",
    path: ["allowsMutating"],
  });

/**
 * Pure consistency predicate exposed for the §5 ING-7 admission gate: a
 * read_only policy must not admit mutation (`read_only ⇒ !allowsMutating`).
 * Independent of construction-time validation, so callers can check any
 * `ToolPolicy` value (e.g. one assembled outside `ToolPolicySchema.parse`).
 * `scoped_write` is always consistent at this level.
 */
export function isToolPolicyConsistent(p: ToolPolicy): boolean {
  return p.mode === "read_only" ? p.allowsMutating === false : true;
}

/**
 * Effective allow-list = `allowedTools` minus `deniedTools` (deny wins on
 * overlap). Preserves `allowedTools` order. Pure.
 */
export function effectiveAllowedTools(p: ToolPolicy): ToolId[] {
  const denied = new Set<string>(p.deniedTools);
  return p.allowedTools.filter((t) => !denied.has(t));
}
