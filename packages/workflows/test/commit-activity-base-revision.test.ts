// §13.10a G4a — createCommitActivity's expectedBaseRevision may be a FIXED RevisionId (proof-spine) OR a
// per-commit RESOLVER (commit-on-approval: the live head is resolved at commit time so the writer's
// whole-vault compare-revision passes; a fixed base would spuriously write_conflict on any unrelated vault
// change between propose and approve). The resolver runs inside the §16 boundary — a throw folds to
// commit_failed, never crosses.
import { describe, it, expect } from "vitest";
import { ok, isOk, isErr } from "@sow/contracts";
import type { KnowledgeMutationPlan } from "@sow/contracts";
import { createCommitActivity } from "../src/activities/commitKnowledge";
import type { ApplyPlanFn } from "../src/activities/commitKnowledge";
import type { WriteSuccess } from "@sow/knowledge";

const PLAN = { planId: "p1" } as unknown as KnowledgeMutationPlan;

/** A fake applyPlan that records the expectedBaseRevision each command carried. */
function recordingApplyPlan(): { fn: ApplyPlanFn; seen: () => string[] } {
  const seen: string[] = [];
  let n = 0;
  const fn: ApplyPlanFn = (command) => {
    seen.push(String(command.expectedBaseRevision));
    n += 1;
    return Promise.resolve(
      ok({ revisionId: `rev-${n}` as WriteSuccess["revisionId"], auditRecord: {} as WriteSuccess["auditRecord"], replayed: false } as WriteSuccess),
    );
  };
  return { fn, seen: () => seen };
}

function port(applyPlan: ApplyPlanFn, expectedBaseRevision: CommitBase): ReturnType<typeof createCommitActivity> {
  return createCommitActivity({
    applyPlan,
    deps: {} as never,
    actor: "copilot-approval",
    sourceEventRef: "src-1",
    workflowRunRef: "run-1" as never,
    expectedBaseRevision: expectedBaseRevision as never,
    deriveIdempotencyKey: (p) => `commit:${String(p.planId)}`,
  });
}
type CommitBase = string | (() => Promise<string>);

describe("createCommitActivity — base-revision resolver (commit-on-approval)", () => {
  it("passes a FIXED RevisionId straight through (proof-spine path, unchanged)", async () => {
    const applied = recordingApplyPlan();
    await port(applied.fn, "rev-fixed").commit(PLAN);
    expect(applied.seen()).toEqual(["rev-fixed"]);
  });

  it("RESOLVES a per-commit resolver and flows its value into the write command", async () => {
    const applied = recordingApplyPlan();
    let calls = 0;
    const resolver = async (): Promise<string> => `rev-head-${(calls += 1)}`;
    const p = port(applied.fn, resolver);
    await p.commit(PLAN);
    await p.commit(PLAN);
    // Resolved FRESH each commit (a moving head), so each command sees the current live head — the whole
    // point of head-at-commit resolution.
    expect(applied.seen()).toEqual(["rev-head-1", "rev-head-2"]);
    expect(calls).toBe(2);
  });

  it("folds a resolver THROW into commit_failed and never throws (§16)", async () => {
    const applied = recordingApplyPlan();
    const resolver = async (): Promise<string> => {
      throw new Error("vault read blew up");
    };
    const p = port(applied.fn, resolver);
    let res: Awaited<ReturnType<typeof p.commit>>;
    await expect(
      (async () => {
        res = await p.commit(PLAN);
      })(),
    ).resolves.toBeUndefined(); // resolved, not rejected
    expect(isErr(res!)).toBe(true);
    if (isErr(res!)) expect(res!.error.code).toBe("commit_failed");
    // applyPlan is NEVER reached when base-revision resolution fails (fail-closed — no partial commit).
    expect(applied.seen()).toEqual([]);
  });

  it("still returns ok when the resolver succeeds (end-to-end through applyPlan)", async () => {
    const applied = recordingApplyPlan();
    const res = await port(applied.fn, async () => "rev-live").commit(PLAN);
    expect(isOk(res)).toBe(true);
  });

  it("folds a THROWING applyPlan (injected substrate fault) into commit_failed and never throws (§16 parity)", async () => {
    const throwing: ApplyPlanFn = () => {
      throw new Error("revision store connection dropped");
    };
    const p = port(throwing, "rev-fixed");
    let res: Awaited<ReturnType<typeof p.commit>>;
    await expect(
      (async () => {
        res = await p.commit(PLAN);
      })(),
    ).resolves.toBeUndefined(); // resolved, not rejected
    expect(isErr(res!)).toBe(true);
    if (isErr(res!)) expect(res!.error.code).toBe("commit_failed");
  });
});
