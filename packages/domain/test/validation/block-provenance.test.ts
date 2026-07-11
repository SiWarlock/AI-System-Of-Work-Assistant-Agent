// spec(§6/§7) — 13.7a numbered-block provenance: segregated-inference over CanonicalSourceRef.block.
// PURE + total; the require-block aggregate is the FUTURE gate primitive (dormant, not wired live).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isOk, isErr } from "@sow/contracts";
import type { CanonicalSourceRef } from "@sow/contracts";
import {
  hasBlockProvenance,
  distillBlockProvenance,
  validateBlockProvenance,
} from "../../src/validation/block-provenance";

const ref = (r: string, block?: string): CanonicalSourceRef =>
  block === undefined ? { kind: "markdown", ref: r } : { kind: "markdown", ref: r, block };

describe("block-provenance — numbered-block segregated-inference (task 13.7a)", () => {
  it("hasBlockProvenance is true ONLY for a ref carrying a non-empty block", () => {
    expect(hasBlockProvenance(ref("a", "B3"))).toBe(true);
    expect(hasBlockProvenance(ref("a"))).toBe(false);
    expect(hasBlockProvenance({ kind: "markdown", ref: "a", block: "   " })).toBe(false); // whitespace-only
  });

  it("distillBlockProvenance partitions block-traceable vs block-less, order-preserving + no mutation", () => {
    const input: CanonicalSourceRef[] = [ref("a", "B1"), ref("b"), ref("c", "B2"), ref("d")];
    const frozen = input.map((r) => Object.freeze({ ...r }));
    const { blockTraceable, withoutBlock } = distillBlockProvenance(frozen);
    expect(blockTraceable.map((r) => r.ref)).toEqual(["a", "c"]);
    expect(withoutBlock.map((r) => r.ref)).toEqual(["b", "d"]);
    // inputs unmutated (order + membership preserved).
    expect(frozen.map((r) => r.ref)).toEqual(["a", "b", "c", "d"]);
  });

  it("validateBlockProvenance: all-block ⇒ ok; block-less ⇒ one missing_block_provenance each (deterministic order)", () => {
    expect(isOk(validateBlockProvenance([ref("a", "B1"), ref("c", "B2")]))).toBe(true);

    const r = validateBlockProvenance([ref("a", "B1"), ref("b"), ref("d")]);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error).toEqual([
      { code: "missing_block_provenance", ref: "b", index: 1 },
      { code: "missing_block_provenance", ref: "d", index: 2 },
    ]);
  });

  it("validateBlockProvenance never throws — an empty ref set ⇒ ok", () => {
    expect(isOk(validateBlockProvenance([]))).toBe(true);
  });

  // DORMANCY (load-bearing safety, task 13.7a): no producer emits `block` yet, so wiring the
  // require-block aggregate as a live gate into intakeGenerativeProposal would drop EVERY ref. This
  // pin fails loudly if the validator is prematurely wired there before producer coordination lands.
  // `intakeGenerativeProposal` is the SOLE intended future wiring site (per the brief), so scanning it
  // is the targeted tripwire; the validator has zero non-test callers repo-wide today.
  it("is NOT wired into generative-proposal-intake (dormant — required-gate composition is a named follow-up)", () => {
    const intakePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../knowledge/src/gbrain/remediation/generative-proposal-intake.ts",
    );
    const src = readFileSync(intakePath, "utf8");
    for (const token of [
      "block-provenance",
      "validateBlockProvenance",
      "hasBlockProvenance",
      "distillBlockProvenance",
    ]) {
      expect(src.includes(token)).toBe(false);
    }
  });
});
