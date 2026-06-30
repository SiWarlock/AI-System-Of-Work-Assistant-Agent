// ExternalWriteEnvelope seam model (task 1.7, §3/§8). The §8 Tool-Gateway
// external-write envelope — the ONLY external-write path (safety rule 3). Every
// external side effect carries an `idempotencyKey` (replay-dedupe key), a
// `canonicalObjectKey` (pre-write existence-check key), a `payloadHash`, and a
// `writeReceipt` once committed; replay reuses the receipt/matched object → no
// duplicate external writes (the §20.1 replay gate). The envelope is derived from
// a validated `ProposedAction`; `envelopeMatchesAction` pins that linkage. Zod is
// the single source of truth: the TS type is the explicit `ExternalWriteEnvelope`
// interface, the JSON Schema is generated via `emitJsonSchema`. PURE — imports
// only foundation primitives/enums + the leaf `WriteReceipt` / `ProposedAction`
// seam models.
import { z } from "zod";
import { ActionIdSchema, ApprovalIdSchema } from "../primitives/zod-brands";
import { targetSystemSchema, type TargetSystem } from "./shared-enums";
import { WriteReceiptSchema, type WriteReceipt } from "./write-receipt";
import type { ProposedAction } from "./proposed-action";
import type { ActionId, ApprovalId } from "../primitives/ids";

/** Stable JSON-Schema `$id` for the schema registry. */
export const EXTERNAL_WRITE_ENVELOPE_SCHEMA_ID = "sow:external-write-envelope" as const;

// Explicit output interface + annotation: the inferred type would otherwise force
// the declaration emitter to name `ids.ts`'s module-private `__brand` symbol
// (TS4023) — the same workaround `egress-policy.ts` / `proposed-action.ts` use,
// because `actionId` and `approvalId` are branded. A nameable
// `ExternalWriteEnvelope` type sidesteps that; `.strict()` runtime rejection of
// unknown keys is unaffected.
export interface ExternalWriteEnvelope {
  actionId: ActionId;
  targetSystem: TargetSystem;
  canonicalObjectKey: string;
  idempotencyKey: string;
  // arch_gap: the `preconditions` shape is unspecified upstream — §8 names
  // "preconditions" as a gate but never a structured predicate contract, so it is
  // modeled OPEN as a list of non-empty strings, NOT a closed predicate taxonomy.
  preconditions: string[];
  // arch_gap: the `payloadHash` digest algorithm is unspecified upstream — §8 says
  // "payload hash" but never names the algorithm (sha256 vs other), so it is an
  // OPEN non-empty deterministic string, NOT a closed sha256-hex brand.
  payloadHash: string;
  approvalId?: ApprovalId;
  writeReceipt?: WriteReceipt;
}

interface ExternalWriteEnvelopeInput {
  actionId: string;
  targetSystem: TargetSystem;
  canonicalObjectKey: string;
  idempotencyKey: string;
  preconditions: string[];
  payloadHash: string;
  approvalId?: string;
  writeReceipt?: WriteReceipt;
}

export const ExternalWriteEnvelopeSchema: z.ZodType<
  ExternalWriteEnvelope,
  z.ZodTypeDef,
  ExternalWriteEnvelopeInput
> = z
  .object({
    actionId: ActionIdSchema,
    // Closed external-target set (§8 connector catalog), shared with ProposedAction.
    targetSystem: targetSystemSchema,
    // Universal external-write rule (§3 / safety rule 3): both keys required,
    // non-empty. canonicalObjectKey gates the pre-write existence check;
    // idempotencyKey gates replay dedupe.
    canonicalObjectKey: z.string().min(1),
    idempotencyKey: z.string().min(1),
    preconditions: z.array(z.string().min(1)),
    payloadHash: z.string().min(1),
    // Optional: present only once an approval covers the write.
    approvalId: ApprovalIdSchema.optional(),
    // Optional: present only once the write committed (the §8 proof-of-write,
    // frozen transitively through this model's schema.json).
    writeReceipt: WriteReceiptSchema.optional(),
  })
  .strict();

/**
 * Linkage pin (safety rule 3): an `ExternalWriteEnvelope` must target the SAME
 * object the originating `ProposedAction` was approved for. The four shared keys
 * — `actionId`, `targetSystem`, `canonicalObjectKey`, `idempotencyKey` — MUST
 * agree so the pre-write existence check + replay dedupe hit the same object the
 * approval covered. Pure; the envelope's derived fields (`preconditions`,
 * `payloadHash`, `approvalId`, `writeReceipt`) are intentionally NOT compared.
 */
export function envelopeMatchesAction(
  env: ExternalWriteEnvelope,
  action: ProposedAction,
): boolean {
  return (
    env.actionId === action.actionId &&
    env.targetSystem === action.targetSystem &&
    env.canonicalObjectKey === action.canonicalObjectKey &&
    env.idempotencyKey === action.idempotencyKey
  );
}
