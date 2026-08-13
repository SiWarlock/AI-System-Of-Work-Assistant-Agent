// spec(§5 WS-8, §6 KN-4/KN-9) — 24.12 remedy: the foreign-workspace path-consistency guard. The
// packages/policy Copilot LegacyContentPolicy {mode:"assign"} bridge treats every UNPREFIXED note in
// the combined gbrain brain as belonging to its one toWorkspaceId — sound only while the brain holds a
// single workspace's unprefixed content. This guard makes that unsound state UNREPRESENTABLE at
// KnowledgeWriter (the one place every semantic write crosses, safety rule 1) instead of trusting an
// operator-discipline comment (contracts L123).
import { describe, it, expect } from "vitest";
import { ok, isOk, isErr, validKnowledgeMutationPlan, workspaceId as wsId } from "@sow/contracts";
import type { KnowledgeMutationPlan, WorkflowRunRef } from "@sow/contracts";
import { applyPlan } from "../src/knowledge-writer/writer";
import type { KnowledgeWriteCommand, KnowledgeWriterDeps, WorkspacePathContext } from "../src/knowledge-writer/writer";
import { computeRevisionId } from "../src/knowledge-writer/revision";
import { SOURCE_NOTE_SUBTREE } from "../src/knowledge-writer/workspace-path-guard";
import { MemoryAuditRepo, MemoryRevisionStore, MemoryVaultFs } from "./helpers";
// 24.26 step 1 of 3 — the factory under test. Imported on its OWN line (rather than extended onto
// the `:13` import) so every pre-existing line in this file stays byte-identical: the acceptance
// criterion "no existing test was edited" is then checkable by diff, not by assertion.
import { makeEnforceWorkspacePathScope } from "../src/knowledge-writer/workspace-path-guard";
import type { WorkspacePathCheck } from "../src/knowledge-writer/writer";

// 24.26 step 3 — the module constant and the module-level `enforceWorkspacePathScope` are GONE, so
// this file supplies its own exempt id and builds ONE instance for every test below. That is the
// point of the task, not an inconvenience: production's single home for this value is
// `apps/worker/src/composition/legacy-workspace.ts`, and a test asserting the guard's behaviour has
// no business importing production's copy of a value it is free to choose.
// ⚠ ONE literal, at module scope — not one per call site. Re-pointing the four pure-predicate calls
// at four separate `makeEnforceWorkspacePathScope("personal-business")` literals would have traded a
// deleted module-level home for four scattered ones.
const EXEMPT_WS = "personal-business";
const guard = makeEnforceWorkspacePathScope(EXEMPT_WS);

const wf: WorkflowRunRef = {
  workflowId: "wf-24-12" as WorkflowRunRef["workflowId"],
  trigger: "manual",
  state: "running",
  idempotencyKey: "idem-24-12",
  auditRefs: [],
};
const EMPTY_REV = computeRevisionId(new Map());

/** applyPlan deps with ownership/secret-scan passed through — isolates THIS gate from the others. */
function deps(vault: MemoryVaultFs): KnowledgeWriterDeps & { revisions: MemoryRevisionStore; audit: MemoryAuditRepo } {
  return {
    vault,
    revisions: new MemoryRevisionStore(),
    audit: new MemoryAuditRepo(),
    now: () => "2026-07-01T00:00:00.000Z",
    ownershipCheck: () => ok(undefined),
    secretScan: () => ok(undefined),
    // 24.26 step 3: SUPPLIED, not omitted. This line used to read "deliberately OMITTED — every test
    // in this file exercises the REAL default"; there is no default any more, and the field is
    // required. What these tests exercise is now the instance built above, which is the same
    // predicate over the same id — see `applyPlan_uses_the_SUPPLIED_exempt_id` for the pin that this
    // is genuinely the supplied one and not a resurrected default.
    workspacePathCheck: guard,
  };
}

function cmd(plan: unknown, key = "idem-24-12"): KnowledgeWriteCommand {
  return { plan, expectedBaseRevision: EMPTY_REV, actor: "KnowledgeWriter", sourceEventRef: "evt-1", workflowRunRef: { ...wf, idempotencyKey: key }, idempotencyKey: key };
}

const planWithCreate = (workspaceId: string, path: string, body = "hello"): KnowledgeMutationPlan => ({
  ...validKnowledgeMutationPlan,
  workspaceId: wsId(workspaceId),
  creates: [{ path, body }],
});

const FOREIGN = "employer-work";

describe("applyPlan — foreign-workspace path consistency (24.12 remedy, constructing the bad state)", () => {
  it("a foreign-workspace note landing UNPREFIXED is rejected before any write", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, "projects/acme.md"); // no "employer-work/" prefix
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("workspace_path_violation");
    // fail-closed: nothing committed, no revision recorded (mirrors the secret_found regression pin)
    expect(vault.snapshot()["projects/acme.md"]).toBeUndefined();
    expect(d.revisions.recordCalls).toBe(0);
    expect(d.audit.records).toHaveLength(0);
  });

  it("the LEGACY-EXEMPT workspace's unprefixed content is UNAFFECTED — non-vacuity partner of the test above", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(EXEMPT_WS, "projects/acme.md"); // unprefixed, but the ONE exempt workspace
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(vault.snapshot()["projects/acme.md"]).toBe("hello");
  });

  it("a CORRECTLY-PREFIXED foreign-workspace note is unaffected", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, "employer-work/projects/acme.md");
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(vault.snapshot()["employer-work/projects/acme.md"]).toBe("hello");
  });

  it("the legacy-exempt workspace MAY ALSO be prefixed — the exemption permits, never requires, unprefixed", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(EXEMPT_WS, `${EXEMPT_WS}/projects/acme.md`);
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(true);
  });

  it("segment-boundary correctness — a LOOKALIKE prefix (employer-work-x) does NOT satisfy employer-work's requirement", async () => {
    // Mirrors packages/policy copilot-workspace-scope.ts's own segment-wise matching discipline
    // ("personal-business never captures personal-business-x").
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, "employer-work-x/projects/acme.md");
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("workspace_path_violation");
  });

  it("KN-12 structural surfaces are exempt for EVERY workspace — mergeStructural rides inside any workspace's plan (13.8d)", async () => {
    // ingest-rewrite.ts's mergeStructural puts index.md/log.md/Logs/<date>.md patches inside the SAME
    // AUTO plan as a non-personal-business workspace's semantic content. A naive prefix rule would
    // break KN-12 parity for every workspace but the legacy-exempt one.
    for (const structuralPath of ["index.md", "log.md", "Logs/2026-08-11.md"]) {
      const vault = new MemoryVaultFs();
      const d = deps(vault);
      const plan: KnowledgeMutationPlan = { ...validKnowledgeMutationPlan, workspaceId: wsId(FOREIGN), patches: [{ path: structuralPath, regionId: "r1", newBody: "x" }] };
      const r = await applyPlan(cmd(plan, `idem-${structuralPath}`), d);
      expect(isOk(r), `${structuralPath} was rejected`).toBe(true);
    }
  });

  it("a MIXED plan — foreign-workspace semantic content plus a structural patch — the semantic content still needs its own prefix", async () => {
    // The structural exemption must not become a back door: only the structural path itself is exempt.
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan: KnowledgeMutationPlan = {
      ...validKnowledgeMutationPlan,
      workspaceId: wsId(FOREIGN),
      creates: [{ path: "projects/acme.md", body: "hello" }], // unprefixed — still a violation
      patches: [{ path: "index.md", regionId: "r1", newBody: "x" }], // exempt
    };
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("workspace_path_violation");
    expect((r.error as { path?: string }).path).toBe("projects/acme.md"); // the OFFENDING path, not the structural one
  });

  it("rule 7 — the violation carries a code and a path, and NOTHING else (no entity name, no content fragment)", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, "projects/acme.md", "this body has secret-looking content xyz");
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(Object.keys(r.error).sort()).toEqual(["code", "path"]);
    expect(JSON.stringify(r.error)).not.toContain("secret-looking");
  });

  it("SECURITY (review finding) — a traversal-crafted STRUCTURAL lookalike is rejected, never silently exempted", async () => {
    // "Logs/../employer-work-secret.md" string-STARTS-WITH "logs/" (isStructuralSurface would say yes)
    // but path.resolve() lands it OUTSIDE Logs/ entirely, unprefixed, at the vault root.
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, "Logs/../employer-work-secret.md");
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("workspace_path_violation");
    expect(vault.snapshot()["employer-work-secret.md"]).toBeUndefined(); // never committed under EITHER shape
  });

  it("SECURITY (review finding) — a traversal-crafted PREFIX lookalike is rejected even though it string-starts with its own workspaceId", async () => {
    // "employer-work/../secret.md" string-starts-with "employer-work" but resolves to the vault ROOT.
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, "employer-work/../secret.md");
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("workspace_path_violation");
  });

  it("the SOURCE-INGESTION shape (sources/<ws>/<digest>.md) is a second sanctioned prefix, not just the first-segment one — the regression this slice would otherwise have shipped", async () => {
    // apps/worker/src/composition/sourceNotePath.ts derives every real ingested-source note at exactly
    // this path. Verified against apps/worker's own real tests (not inferred) that this was a live
    // regression before this test + the fix landed.
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, `${SOURCE_NOTE_SUBTREE}/${FOREIGN}/abc123.md`);
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(true);
  });

  it("sources/<ws>/ still requires the SECOND segment to match — a different workspace's source subtree is still a violation", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, `${SOURCE_NOTE_SUBTREE}/some-other-workspace/abc123.md`);
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("workspace_path_violation");
  });

  it("SECURITY (review finding) — a traversal-crafted SOURCES lookalike is rejected", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan = planWithCreate(FOREIGN, `${SOURCE_NOTE_SUBTREE}/${FOREIGN}/../../secret.md`);
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("workspace_path_violation");
  });
});

describe("the built check — the pure predicate (unit level, for branches applyPlan's own schema gate makes unreachable in practice)", () => {
  const ctx = (path: string, workspaceId: unknown): WorkspacePathContext => ({ path, plan: { ...validKnowledgeMutationPlan, workspaceId } as unknown as KnowledgeMutationPlan });

  it("fails closed on a malformed/absent plan.workspaceId — never silently admits", () => {
    for (const bad of [undefined, null, "", 42]) {
      const r = guard(ctx("projects/acme.md", bad));
      expect(isErr(r)).toBe(true);
    }
  });

  it("fails closed on an empty path", () => {
    const r = guard(ctx("", FOREIGN));
    expect(isErr(r)).toBe(true);
  });

  it("is case-sensitive on the segment match — 'Employer-Work' is not 'employer-work' (fail closed on ambiguity, never a lenient match)", () => {
    const r = guard(ctx("Employer-Work/projects/acme.md", FOREIGN));
    expect(isErr(r)).toBe(true);
  });

  it("SECURITY — hasNoTraversalSegments gates the WHOLE function, not just the structural branch: every match kind rejects a '..'/'.'/'' segment", () => {
    const traversalCrafted = [
      "Logs/../employer-work-secret.md", // structural lookalike
      "employer-work/../secret.md", // prefix lookalike
      `${SOURCE_NOTE_SUBTREE}/employer-work/../../secret.md`, // sources/<ws>/ lookalike
      "employer-work//projects/acme.md", // empty segment
      "employer-work/./acme.md", // current-dir segment
    ];
    for (const path of traversalCrafted) {
      const r = guard(ctx(path, FOREIGN));
      expect(isErr(r), `expected ${path} to be rejected`).toBe(true);
    }
  });
});

// 24.26 COMPLETE (all three steps). The exempt workspace is a REQUIRED factory argument, the two
// worker composition literals supply it, and `KnowledgeWriterDeps.workspacePathCheck` is required
// with no fallback. Production's single home for the value is
// `apps/worker/src/composition/legacy-workspace.ts`.
// ⚠ THIS HEADER DESCRIBED STEP 1'S INTERMEDIATE STATE and was still asserting it after steps 2 and 3
// landed — a stale-by-construction comment, since the commits that falsified it were in another
// territory and could not edit it. ⛔ `EXEMPT_WS` below is a TEST-LOCAL literal and is in no
// production path; an earlier sweep renamed the old constant into this sentence and made it claim
// otherwise. ⚠ Legs are anchored to `### 24.26`, never to a bare `#N` — those number independently
// in this repo, and the id first drafted here resolves in the plan to a different, already-CLOSED task.
describe("makeEnforceWorkspacePathScope — the exempt workspace id is a required factory argument (24.26 step 1 of 3)", () => {
  const ctx = (path: string, workspaceId: unknown): WorkspacePathContext => ({ path, plan: { ...validKnowledgeMutationPlan, workspaceId } as unknown as KnowledgeMutationPlan });

  it("the exempt id is REQUIRED FROM BIRTH — a call omitting it does not compile", () => {
    // The acceptance criterion made executable. `tsc --noEmit` really covers this file
    // (packages/knowledge/tsconfig.json `include: ["src","test"]`, and `lint` === `typecheck`).
    // NEVER INVOKED — it is a type-level pin: if the parameter is ever widened to optional, the
    // suppression below goes unused and TYPECHECK FAILS. It reds in the direction that matters
    // (the guarantee weakening), which a runtime assertion cannot do.
    // ⚠ Do not start a comment line with the directive's own name while describing it — tsc reads
    // `//` + the token as a REAL directive wherever it appears, so the prose becomes a second,
    // unused suppression and errors. (Cost one RED cycle here.)
    const neverInvoked = (): WorkspacePathCheck =>
      // @ts-expect-error — exemptWorkspaceId is required; a no-arg call must not typecheck
      makeEnforceWorkspacePathScope();
    expect(typeof neverInvoked).toBe("function");
  });

  it("exempts the workspace it was GIVEN, not some other instance's id", () => {
    // The whole point of the factory: this fails if the returned predicate ignored its argument and
    // closed over anything else.
    const check = makeEnforceWorkspacePathScope(FOREIGN);
    const r = check(ctx("projects/acme.md", FOREIGN)); // unprefixed, but THIS instance's exempt ws
    expect(isOk(r)).toBe(true);
  });

  it("does NOT exempt a DIFFERENT id than the one it was given — the discriminating half", () => {
    // Test above passes even if the factory exempted BOTH its argument and some other id. Only this
    // one proves nothing else is consulted; a closure bug that ORs two ids is the realistic failure
    // mode and the positive test cannot see it.
    const check = makeEnforceWorkspacePathScope(FOREIGN);
    const r = check(ctx("projects/acme.md", EXEMPT_WS));
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("workspace_path_violation");
  });

  it("changes ONLY the exempt id — every other branch of the predicate is byte-identical on a custom instance", () => {
    // Non-vacuity partner: proves the factory is the SAME predicate parameterised, not a second
    // implementation that happens to agree on the exemption. Mirrors the shipped const's own pins.
    const check = makeEnforceWorkspacePathScope("some-other-workspace");
    expect(isOk(check(ctx("index.md", FOREIGN)))).toBe(true); // KN-12 structural, exempt for every ws
    expect(isOk(check(ctx("employer-work/projects/acme.md", FOREIGN)))).toBe(true); // own prefix
    expect(isOk(check(ctx(`${SOURCE_NOTE_SUBTREE}/${FOREIGN}/abc123.md`, FOREIGN)))).toBe(true); // sources/<ws>/
    expect(isErr(check(ctx("employer-work-x/projects/acme.md", FOREIGN)))).toBe(true); // lookalike segment
    expect(isErr(check(ctx("employer-work/../secret.md", FOREIGN)))).toBe(true); // traversal
    expect(isErr(check(ctx("projects/acme.md", "")))).toBe(true); // malformed plan workspaceId
  });

  it("construction FAILS FAST on an empty or whitespace-only exempt id, naming the parameter", () => {
    // ⚠ NOT because a blank id would open an exemption hole — it provably would not: the predicate
    // rejects an empty/malformed plan.workspaceId BEFORE the exemption comparison is reached, so a
    // blank exempt id is inert ("nothing is exempt"), which is strictly fail-CLOSED. The reason is
    // the step-3 supplier: once the composition root feeds this value, a blank one is a
    // MISCONFIGURATION that silently disables the legacy-content posture the `assign` bridge
    // depends on, and it should name itself at boot rather than surface later as "every
    // personal-business unprefixed write started failing."
    // ⛔ Asserts the MESSAGE, not a bare .toThrow(): before the factory existed this test passed on
    // `TypeError: not a function` — a green resting on the wrong cause. Pinning the message is what
    // stops an unrelated future throw from keeping it green.
    // The cast entries cover the `typeof` half, which TypeScript makes unreachable but a JS caller or
    // an `as`-cast at a composition root does not — so that branch is defensive, not dead.
    const blanks: string[] = ["", "   ", "\t", "\n", undefined as unknown as string, null as unknown as string, 42 as unknown as string];
    for (const blank of blanks) {
      expect(() => makeEnforceWorkspacePathScope(blank)).toThrow(/exemptWorkspaceId must be a non-blank string/);
    }
    // Non-vacuity partner: a real id does NOT throw, so the assertion above is discriminating
    // rather than "this factory always throws."
    expect(() => makeEnforceWorkspacePathScope(FOREIGN)).not.toThrow();
    // ⛔ KNOWN RESIDUAL, pinned as a COMMENT and deliberately NOT an assertion, so nobody reads it as
    // intended behaviour: `.trim()` covers the ECMAScript whitespace class only, so a zero-width /
    // format id (U+200B, U+2060, U+180E) CONSTRUCTS here and also clears WorkspaceIdSchema's identical
    // `.trim()` test. Asserting it would encode the gap as desired; closing it means validating the
    // exempt id against the known workspace set at the composition root (brief 271 option (c)) — out
    // of this slice's scope and owed by whoever supplies the value.
  });
});

// 24.26 step 3 — what the flip actually MEANS, in two directions the type system cannot express.
describe("workspacePathCheck is REQUIRED — the supplied id is load-bearing, and omission is no longer safe", () => {
  it("applyPlan_uses_the_SUPPLIED_exempt_id: a different id changes behaviour, which it could not before step 3", async () => {
    // ⭐ THE PIN THAT MAKES THE WHOLE SEQUENCE MEAN SOMETHING. At step 2 both worker literals passed
    // `makeEnforceWorkspacePathScope(LEGACY_UNPREFIXED_WORKSPACE_ID)` while writer.ts still had
    // `?? enforceWorkspacePathScope` — the SAME factory over the SAME string. Supplying a wrong id
    // was therefore indistinguishable from supplying the right one, and no test could tell. With the
    // fallback deleted, the supplied value is the only source, so it is finally observable.
    const vault = new MemoryVaultFs();
    const d = { ...deps(vault), workspacePathCheck: makeEnforceWorkspacePathScope("some-other-workspace") };
    // `EXEMPT_WS` is exempt under the file's own instance; under THIS instance it is not.
    const plan = planWithCreate(EXEMPT_WS, "projects/acme.md");
    const r = await applyPlan(cmd(plan), d);
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.code).toBe("workspace_path_violation");
    expect(vault.snapshot()["projects/acme.md"]).toBeUndefined();
  });

  it("omitted_workspacepathcheck_runtime_behaviour_is_pinned_not_inferred", async () => {
    // ⛔ MEASURED, NOT INFERRED, and recorded rather than fixed (orchestrator ruling): the flip
    // changed what OMISSION means. Before, `?? enforceWorkspacePathScope` made an omitted check
    // silently take the default — omission was SAFE. Now there is no fallback, so `workspaceScope`
    // is `undefined` and applyPlan's step-4.5 loop invokes it.
    // ⛔ SCOPE OF THE EXPOSURE — CORRECTED TWICE, and the second correction is the point. The first
    // version claimed `packages/workflows`' 9 `deps: {} as never` sites "are the only places that can
    // reach it", and task #49 was scoped from that. The first correction said all 9 feed
    // `createCommitActivity`. Both were wrong; measured, the 9 are TWO different populations:
    //   • 4 (`meeting-activities.test.ts:863, :874, :888, :907`) are `createProposeActivity`, whose
    //     `deps` is `ExternalWriteDeps` — a different type with no `workspacePathCheck` at all, so
    //     they are unrelated to this flip rather than uncovered by it.
    //   • 5 (`commit-activity-base-revision.test.ts:32`, `meeting-activities.test.ts:738/756/784/802`)
    //     do feed `createCommitActivity`, but each injects a FAKE `applyPlan` that never dereferences
    //     `deps`, so the real one is never invoked. A bare `{}` would throw earlier regardless, at
    //     `deps.revisions.getByIdempotencyKey`, never reaching the workspace-scope loop.
    // ⇒ ZERO of the nine can reach this line. The only site in the repo that reaches it is the test
    //   below. ⚠ A count that survived two corrections was never one population — grouping by the
    //   literal `deps: {} as never` grouped by SPELLING, not by type.
    // ⇒ What actually reaches this line is the shape BELOW: a near-complete deps literal missing
    // exactly one field, cast past the type system. That is a BROADER class than "the 9 sites", and
    // it is unbounded by construction — any `as`-cast anywhere can produce it. Typecheck is the only
    // thing standing in front of it, which is precisely why the field being required is the fix.
    // ⛔ NOT guarded here — by orchestrator ruling, recorded rather than fixed. ⚠ THE RULING'S STATED
    // REASON DOES NOT SURVIVE REVIEW, so do not re-derive from it: it was "a guard would be the
    // deleted fallback wearing a different hat", and a fail-closed
    // `if (typeof workspaceScope !== "function") return err(violation(...))` is the OPPOSITE of that
    // fallback — it ADMITS NOTHING and creates no second home for the exempt id, whereas the fallback
    // admitted writes under a hardcoded one. Whether to add it is a live question routed at Step 9,
    // not a settled equivalence.
    const vault = new MemoryVaultFs();
    const omitted = {
      vault,
      revisions: new MemoryRevisionStore(),
      audit: new MemoryAuditRepo(),
      now: () => "2026-07-01T00:00:00.000Z",
      ownershipCheck: () => ok(undefined),
      secretScan: () => ok(undefined),
    } as unknown as KnowledgeWriterDeps; // an `as`-cast past the required field — not the workflows shape
    await expect(applyPlan(cmd(planWithCreate(EXEMPT_WS, "projects/acme.md")), omitted)).rejects.toThrow(
      /is not a function/, // deliberately NOT the local's name — a pure rename must not red this
    );

    // ⚠ THE VACUITY TRAP, pinned as its own assertion so nobody "simplifies" the test into it: with
    // ZERO changes the step-4.5 loop is never entered, so omission does NOT throw. A version of this
    // test built on an empty plan would pass while pinning nothing at all.
    const emptyPlan: KnowledgeMutationPlan = { ...validKnowledgeMutationPlan, workspaceId: wsId(EXEMPT_WS), creates: [], patches: [] };
    const empty = await applyPlan(cmd(emptyPlan, "idem-empty"), omitted);
    // `toBeDefined()` would be satisfied by an `err` too, leaving the stated mechanism ("the loop is
    // never entered") silently false if an empty plan ever failed EARLIER. Pin the mechanism.
    expect(isOk(empty)).toBe(true);
  });
});
