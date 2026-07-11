// spec(§6) — human-owned section preservation (REQ-F-016 / KN-7 / KN-8, task 4.2):
// the OwnershipCheck rewrites ONLY marker-bounded assistant regions; any edit that
// modifies human text, an untargeted assistant region, or absorbs human content
// into a region is REJECTED with ownership_violation.
import { describe, it, expect } from "vitest";
import { isOk, isErr, validKnowledgeMutationPlan } from "@sow/contracts";
import type { KnowledgeMutationPlan } from "@sow/contracts";
import { checkOwnership, enforceHumanOwnership } from "../src/knowledge-writer/ownership";
import type { OwnershipCheckContext } from "../src/knowledge-writer/writer";
import { renderRegion, renderUserRegion, renderGeneratedRegion } from "../src/markdown-vault/sections";

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

// spec(§6 / §13 / task 13.7b) — the `@user`/`@generated` sentinel vocabulary adds protection, never
// removes it. Human-owned = (unmarked complement) ∪ (`@user` regions); `@generated` == a `kw:region`
// assistant region. The gate logic is UNCHANGED — this coverage flows through `parseSections`.
describe("checkOwnership — @user / @generated additive protection (task 13.7b)", () => {
  it("rejects a write that modifies text INSIDE a @user region (additive explicit human protection)", () => {
    const prior = `intro\n${renderUserRegion("secret notes")}\ntail`;
    const next = `intro\n${renderUserRegion("SECRET CHANGED")}\ntail`;
    const r = checkOwnership(ctx(prior, next, planPatching()));
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("ownership_violation");
  });

  it("rejects DE-MARKING a @user region — stripping the markers while keeping the inner text (ownership cannot be seized by de-marking)", () => {
    const prior = renderUserRegion("private");
    const next = "private"; // markers stripped, inner text byte-identical
    const r = checkOwnership(ctx(prior, next, planPatching()));
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("ownership_violation");
  });

  it("treats a @generated region as writer-owned — an untargeted @generated change ⇒ ownership_violation (KN-8, == kw:region)", () => {
    const prior = renderGeneratedRegion("g", "one");
    const next = renderGeneratedRegion("g", "TWO"); // g is not targeted by the plan
    const r = checkOwnership(ctx(prior, next, planPatching()));
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.regionId).toBe("g");
  });

  it("recognizing @generated does NOT reclassify unmarked human text — prose mentioning the plain words stays human-protected (NO weakening)", () => {
    const prior = "a note that mentions @generated and @user as plain words";
    const next = "a DIFFERENT note that mentions @generated and @user as plain words";
    const r = checkOwnership(ctx(prior, next, planPatching()));
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("ownership_violation"); // unmarked prose is still human-owned + protected
  });

  it("allows appending a new targeted assistant region next to an untouched @user region", () => {
    const prior = renderUserRegion("keep me");
    const next = `${renderUserRegion("keep me")}\n\n${renderRegion("fresh", "generated")}`;
    const r = checkOwnership(ctx(prior, next, planPatching("fresh")));
    expect(isOk(r)).toBe(true);
  });

  it("allows a TARGETED rewrite of a @generated region (writer-owned + refreshable, == kw:region)", () => {
    const prior = renderGeneratedRegion("g", "one");
    const next = renderGeneratedRegion("g", "two"); // g IS targeted by the plan
    const r = checkOwnership(ctx(prior, next, planPatching("g")));
    expect(isOk(r)).toBe(true);
  });
});
