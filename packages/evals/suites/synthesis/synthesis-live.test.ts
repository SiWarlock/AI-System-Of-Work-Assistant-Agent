// spec(§6 KN-10 · §12 · §ARM-RESEARCH) — task 13.8c-eval: the LIVE real-model REASON leg (DEFERRED).
//
// The real-`SynthesisReasonPort` acceptance leg: run `planSynthesis` over the labeled corpus with a REAL model
// producing the `SynthesisCandidate` (not the recorded fixture), asserting the SAME safety invariants + a
// synthesis-QUALITY bar hold on genuine model output. Owner-gated / live-provider prerequisite (§ARM-RESEARCH) —
// tracked as `it.todo` so the row is visibly pending, not silently missing; the deterministic recorded-candidate
// leg (`synthesis-reason.test.ts`) certifies the planner's safety invariants today.
import { describe, it } from "vitest";

describe("§6 KN-10 — synthesis REASON-leg over a REAL model (live provider, deferred)", () => {
  it.todo("the same safety invariants hold on genuine model candidates (hard-100% floor, real SynthesisReasonPort)");
  it.todo("synthesis faithfulness holds on real model output (no fabricated entity paths)");
});
