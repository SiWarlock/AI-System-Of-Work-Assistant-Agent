// WriteReceipt seam model (task 1.7, §8). The sub-shape of
// `ExternalWriteEnvelope.writeReceipt` — the proof an external write committed
// exactly once (the §8 Tool Gateway records it once per object; replay reuses
// the receipt → no duplicate external writes, §20.1 replay gate). Zod is the
// single source of truth: the TS type is `z.infer`, the JSON Schema is generated
// via `emitJsonSchema`. PURE — a leaf model that imports only `zod` (no
// foundation brands/enums/shapes). All fields are plain strings, so `z.infer`
// names a clean type with no branded `__brand` symbol (no TS4023 interface
// workaround needed, unlike the branded seam models).
import { z } from "zod";

/** Stable JSON-Schema `$id` for the schema registry. */
export const WRITE_RECEIPT_SCHEMA_ID = "sow:write-receipt" as const;

// arch_gap: externalObjectId taxonomy unspecified upstream — §8 never names a
// per-targetSystem identity contract (a Drive fileId vs a Linear issue id vs a
// GitHub node id differ in shape), so it is modeled as an OPEN non-empty string,
// not a closed enum. arch_gap: rawRef shape unspecified — it is a redaction-safe
// pointer into the raw write request/response (never raw secrets/content inline,
// safety rule 7), modeled as an open non-empty string.
export const WriteReceiptSchema = z
  .object({
    // The vendor's identity for the written object — the core proof. Non-empty
    // AND non-whitespace (a whitespace-only id is not real proof of a write).
    externalObjectId: z
      .string()
      .min(1)
      .refine((s) => s.trim().length > 0, "empty/whitespace"),
    externalUrl: z.string().url().optional(),
    recordedAt: z.string().datetime(),
    rawRef: z.string().min(1).optional(),
  })
  .strict();
export type WriteReceipt = z.infer<typeof WriteReceiptSchema>;
