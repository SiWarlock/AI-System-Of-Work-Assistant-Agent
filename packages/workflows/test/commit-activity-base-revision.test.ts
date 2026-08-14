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

// ⛔ `deps: {} as never` BELOW IS A DELIBERATE OPT-OUT (`### 24.85`, the surviving residual of `24.26` step 3),
// NOT AN OVERSIGHT — and what it costs is stated here rather than left to be re-derived.
//
// NOT EXERCISED HERE: the KnowledgeWriter's WORKSPACE-PATH SCOPING. The real `applyPlan` reads
// `deps.workspacePathCheck` (`packages/knowledge/src/knowledge-writer/writer.ts`, the
// `const workspaceScope = deps.workspacePathCheck` binding) to reject a changed path that neither matches its
// own workspace's prefix nor falls in a sanctioned exemption (`workspace_path_violation`).
// ⚠ That is a SEGMENT-EQUALITY test, NOT containment: the legacy-exempt workspace, KN-12 structural surfaces
// and the `sources/<ws>/**` shape all escape the workspace subtree BY DESIGN and are admitted; traversal
// safety comes from a separate pre-check in `workspace-path-guard.ts`, not from this match.
// Nothing in this file can reach any of it: `createCommitActivity` FORWARDS this object as argument 2
// (`commitKnowledge.ts`, the `deps.applyPlan(command, deps.deps)` call) and never dereferences it, and no fake
// `ApplyPlanFn` here declares a SECOND parameter (two fakes: one takes `(command)`, one takes none). The value
// is passed and discarded.
// ⚠ NOT a structural guarantee — `ApplyPlanFn` DECLARES two parameters and TS permits fewer-parameter
// implementations, so a future fake COULD take `(command, deps)`. That is invalidating condition (1) below.
//
// WHY NOT SIMPLY SUPPLY A REAL CHECK: it would change nothing observable, and a diff doing so would read as
// coverage while buying none (`contracts L82`'s forbidden middle; `contracts L85` — mirroring a real guard
// inside a double buys discrimination for the double, never coverage of the code it stands in for).
// ⭐ MEASURED at `### 24.85`, not assumed: a `workspacePathCheck` THROWING ON ANY CALL was installed at all 5
// in-scope sites and all 40 tests stayed GREEN. The control — breaking `expectedBaseRevision`, a SIBLING FIELD
// OF THIS SAME LITERAL — went RED (3 failed / 2 passed), proving the file executes and this object is live.
// ⇒ green under the probe means NOT READ rather than "did not run" (`contracts L84`'s two readings, separated
// by measurement). ⚠ PRECISELY: not-read FOR THE ASSERTIONS THAT WOULD HAVE OBSERVED A FOLD. This activity
// wraps `applyPlan` in a §16 try/catch folding any throw to `commit_failed`, so the tests here that ASSERT
// `commit_failed` would stay green even if a throwing check WERE read — the discrimination comes from the
// ok-asserting tests, not from all five.
//
// EXERCISED HERE: `createCommitActivity`'s ORCHESTRATION — base-revision resolution (fixed value and
// per-commit resolver), idempotency-key derivation, `WriteFailure` → `KnowledgeCommitFailureCode` mapping, and
// the §16 never-throw folds.
//
// REAL ASSURANCE FOR THE OPTED-OUT GUARANTEE LIVES AT: `packages/knowledge/test/workspace-path-guard.test.ts`
// (`contracts L85` — name the load-bearing test, because nothing in this file's name or output says so).
// ⚠ INVALIDATING CONDITIONS — THREE, and only the first is about this file:
//   (1) the injected `applyPlan` stops being a fake that ignores argument 2 — a fake taking `(command, deps)`,
//       or any test here pointed at the REAL `applyPlan`. That site then needs a genuine `workspacePathCheck`.
//   (2) `createCommitActivity` ITSELF starts reading `deps.deps.*` — a fact about `commitKnowledge.ts`, not
//       about this file. `{} as never` would then yield `undefined`, and a resulting throw is absorbed by the
//       same §16 catch into `commit_failed` — i.e. GREEN in the failure-mapping tests, silently.
//       ⭐ That premise is independently pinned, so this is checkable rather than merely hoped:
//       `apps/worker/test/composition/semanticApprovalDispatch.test.ts` — `capturingApplyPlan` reads argument 2
//       and asserts `workspacePathCheck` is defined on the deps that actually reach the writer.
//   (3) a SIXTH `createCommitActivity` site added to this file inherits no note and nothing points at it.
// ⚠ CITATIONS ABOVE ARE SYMBOL-ANCHORED ON PURPOSE — do NOT "helpfully" add line numbers back. The first draft
// of this note cited `writer.ts:335`; that was correct at `ea8cafd4` and was ALREADY STALE when written,
// because an in-flight edit in another package had moved the binding — which then moved AGAIN when that work
// landed. A symbol that goes missing gets investigated; a line number that silently resolves to the wrong
// thing gets believed (`contracts L152`).
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
