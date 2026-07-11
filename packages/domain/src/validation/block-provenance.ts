// 13.7a — numbered-block provenance (osb `(src: Bn)` back-reference). Segregated-inference over
// `CanonicalSourceRef.block`: a claim whose evidence ref carries a non-empty numbered block is
// block-traceable; one without is segregated (the "keep the numbered-block-traceable claim, flag the
// block-less one" primitive). Extends the no-inference posture (REQ-F-017) with numbered-block
// GRANULARITY. Mirrors `no-inference.ts` — PURE + total; identical input ⇒ identical result;
// no clock/network/random; typed `Result`; NEVER throws.
//
// ⚠ DORMANT: a STANDALONE primitive + its validator. `validateBlockProvenance` is the FUTURE
// required-gate aggregate — it is NOT wired into the live generative path (`intakeGenerativeProposal`)
// today, because no producer emits `block` yet, so a block-required gate would drop EVERY ref. It
// composes as a required gate only WITH producer emission (a named follow-up).
import { ok, err } from "@sow/contracts";
import type { Result, CanonicalSourceRef } from "@sow/contracts";

/** Enumerable block-provenance rejection code. */
export type BlockProvenanceRejectionCode = "missing_block_provenance";

export interface BlockProvenanceRejection {
  readonly code: BlockProvenanceRejectionCode;
  /** The offending ref's `ref` locator (its source id) — for diagnostics. */
  readonly ref: string;
  /** The offending ref's position in the input array — uniquely traceable even if two refs share a locator. */
  readonly index: number;
}

/** True iff the ref carries a non-empty numbered `block` back-reference. Pure. */
export function hasBlockProvenance(ref: CanonicalSourceRef): boolean {
  return typeof ref.block === "string" && ref.block.trim().length > 0;
}

/**
 * Partition refs into `blockTraceable` (carry a numbered `block`) vs `withoutBlock` (segregated-
 * inference) — ORDER-PRESERVING within each bucket, no mutation of the input. Pure. This is the
 * distillation primitive: keep the numbered-block-traceable claims, segregate the block-less ones.
 */
export function distillBlockProvenance(refs: readonly CanonicalSourceRef[]): {
  readonly blockTraceable: readonly CanonicalSourceRef[];
  readonly withoutBlock: readonly CanonicalSourceRef[];
} {
  const blockTraceable: CanonicalSourceRef[] = [];
  const withoutBlock: CanonicalSourceRef[] = [];
  for (const ref of refs) {
    (hasBlockProvenance(ref) ? blockTraceable : withoutBlock).push(ref);
  }
  return { blockTraceable, withoutBlock };
}

/**
 * The require-block aggregate — the FUTURE required-gate primitive (NOT wired live yet; see the
 * dormancy note above). Returns `ok(refs)` iff EVERY ref carries a numbered `block`; otherwise
 * `err([...])` with one `missing_block_provenance` rejection per block-less ref, in deterministic
 * insertion order. Pure; never throws.
 */
export function validateBlockProvenance(
  refs: readonly CanonicalSourceRef[],
): Result<readonly CanonicalSourceRef[], BlockProvenanceRejection[]> {
  const rejections: BlockProvenanceRejection[] = [];
  refs.forEach((ref, index) => {
    if (!hasBlockProvenance(ref)) {
      rejections.push({ code: "missing_block_provenance", ref: ref.ref, index });
    }
  });
  if (rejections.length > 0) {
    return err(rejections);
  }
  return ok(refs);
}
