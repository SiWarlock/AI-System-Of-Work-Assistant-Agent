// spec(§6) — human-owned section preservation (REQ-F-016 / KN-7 / KN-8, task 4.2):
// the OwnershipCheck rewrites ONLY marker-bounded assistant regions; any edit that
// modifies human text, an untargeted assistant region, or absorbs human content
// into a region is REJECTED with ownership_violation.
import { describe, it, expect } from "vitest";
import { isOk, isErr, validKnowledgeMutationPlan } from "@sow/contracts";
import type { KnowledgeMutationPlan } from "@sow/contracts";
import { checkOwnership, enforceHumanOwnership } from "../src/knowledge-writer/ownership";
import type { OwnershipCheckContext } from "../src/knowledge-writer/writer";
import { renderRegion } from "../src/markdown-vault/sections";

const PATH = "notes/a.md";

function planPatching(...regionIds: string[]): KnowledgeMutationPlan {
  return {
    ...validKnowledgeMutationPlan,
    patches: regionIds.map((regionId) => ({ path: PATH, regionId, newBody: "x" })),
  };
}

function ctx(
  priorContent: string | undefined,
  nextContent: string,
  plan: KnowledgeMutationPlan,
): OwnershipCheckContext {
  return { path: PATH, priorContent, nextContent, plan };
}

describe("checkOwnership — allowed writes", () => {
  it("allows rewriting the body of a targeted, existing assistant region", () => {
    const prior = `intro\n${renderRegion("r", "old body")}\noutro`;
    const next = `intro\n${renderRegion("r", "new body")}\noutro`;
    const r = checkOwnership(ctx(prior, next, planPatching("r")));
    expect(isOk(r)).toBe(true);
  });

  it("allows appending a new, targeted assistant region to a human-only file", () => {
    const prior = "just human prose\nsecond line";
    const next = `just human prose\nsecond line\n\n${renderRegion("fresh", "generated")}`;
    const r = checkOwnership(ctx(prior, next, planPatching("fresh")));
    expect(isOk(r)).toBe(true);
  });

  it("passes creates (no prior content) whose regions are well-formed", () => {
    const next = `title\n${renderRegion("r", "body")}`;
    const r = checkOwnership(ctx(undefined, next, planPatching("r")));
    expect(isOk(r)).toBe(true);
  });

  it("enforceHumanOwnership is the injectable OwnershipCheck alias", () => {
    const prior = `intro\n${renderRegion("r", "old")}\nout`;
    const next = `intro\n${renderRegion("r", "new")}\nout`;
    expect(isOk(enforceHumanOwnership(ctx(prior, next, planPatching("r"))))).toBe(true);
  });
});

describe("checkOwnership — human-owned content is protected", () => {
  it("rejects an edit that modifies human text outside any region", () => {
    const prior = `Hello human\n${renderRegion("r", "b")}\ntail`;
    const next = `Hallo human\n${renderRegion("r", "b")}\ntail`;
    const r = checkOwnership(ctx(prior, next, planPatching("r")));
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("ownership_violation");
    expect(r.error.path).toBe(PATH);
  });

  it("rejects overwriting a human range by wrapping it in assistant markers (no absorption)", () => {
    const prior = "line1\nHUMAN-SECRET\nline3";
    const next = `line1\n${renderRegion("r", "assistant injected")}\nline3`;
    // even though the plan 'targets' region r, the human line vanished → reject.
    const r = checkOwnership(ctx(prior, next, planPatching("r")));
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("ownership_violation");
  });

  it("rejects modifying an UNRELATED (untargeted) assistant region", () => {
    const prior = `${renderRegion("r1", "one")}\n\n${renderRegion("r2", "two")}`;
    const next = `${renderRegion("r1", "ONE-CHANGED")}\n\n${renderRegion("r2", "two-CHANGED")}`;
    // plan only targets r1; r2 must stay byte-stable.
    const r = checkOwnership(ctx(prior, next, planPatching("r1")));
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.regionId).toBe("r2");
  });

  it("rejects introducing a new assistant region that no patch targets", () => {
    const prior = "human only";
    const next = `human only\n\n${renderRegion("ghost", "unrequested")}`;
    const r = checkOwnership(ctx(prior, next, planPatching("someOtherId")));
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.regionId).toBe("ghost");
  });

  it("rejects a next document with malformed markers when a prior exists", () => {
    const prior = `intro\n${renderRegion("r", "old")}\ntail`;
    const next = `intro\n<!-- kw:region:r -->\nunclosed body\ntail`;
    const r = checkOwnership(ctx(prior, next, planPatching("r")));
    expect(isErr(r)).toBe(true);
  });
});
