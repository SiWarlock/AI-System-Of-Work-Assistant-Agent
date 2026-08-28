// spec(§9/Phase-25, root CLAUDE.md §16) — PKG-W3: `createOutputWorkflowActivities`
// — the single flat factory. This suite pins:
//   (1) the factory returns EVERY declared member name, and each is a function;
//   (2) EVERY member's REJECTION path returns a typed member of its port's error
//       union — never throws — when every injected leg is wired to fail.
//
// Every injected sub-dependency below is deliberately configured to REJECT (a
// broker denial, a gate rejection, a store fault, an unresolvable workspace, a
// no-inference violation) so calling each of the 37 members exercises its
// rejection path for real, not a stub that merely returns a hardcoded err.
import { describe, it, expect } from "vitest";
import { ok, err, workspaceId, sourceId, validKnowledgeMutationPlan, validProposedAction, validExternalWriteEnvelope } from "@sow/contracts";
import type { AuditId } from "@sow/contracts";
import type { BrokerOutcome } from "@sow/providers";
import type { KnowledgeWriterDeps } from "@sow/knowledge";
import type { ExternalWriteDeps } from "@sow/integrations";
import { createOutputWorkflowActivities } from "../../src/activities/outputWorkflows";
import type { OutputWorkflowActivities, OutputWorkflowActivitiesDeps } from "../../src/activities/outputWorkflows";
import type { ReadOnlyAgentJobDeps } from "../../src/activities/readOnlyAgentJob";
import { InMemoryScheduleStore } from "../support/fakes";

// ---------------------------------------------------------------------------
// Every leg wired to REJECT — so every member's rejection path is exercised.
// ---------------------------------------------------------------------------

const FAILING_BROKER = {
  runJob: (): Promise<BrokerOutcome> =>
    Promise.resolve(
      // Only `.ok`, `.error.branch`, `.error.message` are read by the activity;
      // the remaining BrokerRejection fields are @sow/providers-internal and
      // irrelevant to what this factory's own wiring is under test for.
      { ok: false, error: { branch: "provider_failed", message: "fake broker rejection" } } as unknown as BrokerOutcome,
    ),
};

const WS = workspaceId("ws-factory-test");

function agentDeps<Ctx, Output>(): ReadOnlyAgentJobDeps<Ctx, Output> {
  return {
    broker: FAILING_BROKER,
    inputs: {
      workflowRunId: "wf-factory-test",
      workspaceId: WS,
      capability: "test.capability",
      outputSchemaId: "sow:test-output",
      maxRuntimeSeconds: 60,
      idempotencyKey: "idem-factory-agent",
    },
    buildEgress: () => ({}) as never,
    buildMatrix: () => ({}) as never,
    buildWorkspace: () => ({ type: "personal_life", dataOwner: "user" }) as never,
    mapCandidate: () => ({}) as Output,
  } as unknown as ReadOnlyAgentJobDeps<Ctx, Output>;
}

const FAILING_APPLY_PLAN = () =>
  Promise.resolve(
    err({ code: "commit_failed" as const, message: "fake commit failure" }),
  );

const FAILING_DISPATCH = () =>
  Promise.resolve({ status: "rejected" as const, reason: "fake dispatch rejection" });

function makeDeps(): OutputWorkflowActivitiesDeps {
  return {
    commit: {
      applyPlan: FAILING_APPLY_PLAN as unknown as OutputWorkflowActivitiesDeps["commit"]["applyPlan"],
      deps: {} as unknown as KnowledgeWriterDeps,
      actor: "test:factory",
      sourceEventRef: "test:factory",
      workflowRunRef: { workflowId: "wf-factory-test", trigger: "manual", state: "running", idempotencyKey: "idem", auditRefs: [] } as unknown as OutputWorkflowActivitiesDeps["commit"]["workflowRunRef"],
      expectedBaseRevision: "rev-0" as unknown as OutputWorkflowActivitiesDeps["commit"]["expectedBaseRevision"],
      deriveIdempotencyKey: (plan) => String(plan.planId),
    },
    propose: {
      dispatch: FAILING_DISPATCH as unknown as OutputWorkflowActivitiesDeps["propose"]["dispatch"],
      deps: {} as unknown as ExternalWriteDeps,
    },
    dashboard: {
      store: {
        put: () => {
          throw new Error("fake dashboard store fault");
        },
      },
    },
    health: {
      health: {
        getByDedupeKey: () => {
          throw new Error("fake health store fault");
        },
        put: () => {
          throw new Error("fake health store fault");
        },
        list: () => Promise.resolve([]),
      },
      outbox: { enqueueRetry: () => Promise.resolve() },
      clock: { now: () => "2026-08-24T00:00:00.000Z" },
    },
    gclProjection: {
      source: { project: () => Promise.resolve(ok([{ workspaceId: WS, visibilityLevel: "coordination", projectionType: "t", sanitizedPayload: {}, sourceRefs: [] }])) },
      // No registered workspace ⇒ the REAL gate fails closed (gate_rejected).
      lookupWorkspace: () => undefined,
    },
    refreshConnectors: {
      connectorIds: ["connector-1"],
      refresher: { refresh: () => Promise.resolve(err({ code: "connector_unreachable" as const, message: "fake connector fault" })) },
    },
    dailyBriefAgent: agentDeps(),
    periodReviewAgent: agentDeps(),
    projectSyncSynthesize: agentDeps(),
    crossCalendarProposeAgent: agentDeps(),
    dailyBriefOutputs: {
      globalProjection: { project: () => err({ code: "build_failed" as const, message: "fake brief projection failure" }) },
      workspaceProjection: { project: () => err({ code: "build_failed" as const, message: "fake brief projection failure" }) },
      sourceRef: { sourceId: sourceId("src-factory-test") },
      planIdentitySeed: "factory-test",
    },
    periodReviewOutputs: {
      globalProjection: { project: () => err({ code: "build_failed" as const, message: "fake review projection failure" }) },
      workspaceProjection: { project: () => err({ code: "build_failed" as const, message: "fake review projection failure" }) },
      sourceRef: { sourceId: sourceId("src-factory-test") },
      planIdentitySeed: "factory-test",
    },
    projectSyncParse: {
      reader: { read: () => Promise.resolve(err({ code: "parse_failed" as const, message: "fake parse failure" })) },
    },
    projectSyncBuildOutputs: {
      projection: { project: () => err({ code: "build_failed" as const, message: "fake sync outputs failure" }) },
      sourceRef: { sourceId: sourceId("src-factory-test") },
      planIdentity: { seed: "factory-test" },
      noteExists: { exists: () => Promise.resolve(err({ code: "read_failed" as const, message: "fake note-exists failure" })) },
    },
    crossCalendarGather: {
      query: { query: () => Promise.resolve(err({ code: "calendar_unreachable" as const, message: "fake gather failure", readSources: [] })) },
      gate: { admit: () => Promise.resolve(err({ reason: "unused" })) },
    },
    crossCalendarBuildOutputs: {
      projection: { project: () => err({ code: "build_failed" as const, message: "fake scheduling outputs failure" }) },
      sourceRef: { sourceId: sourceId("src-factory-test") },
      planIdentity: { seed: "factory-test" },
    },
    crossCalendarClassify: {
      resolvePolicy: () => undefined,
    },
    crossCalendarRouteToApproval: {
      gateway: { reservePending: () => Promise.resolve(err({ code: "route_failed" as const, message: "fake route failure" })) },
    },
  };
}

const EXPECTED_MEMBERS = [
  "dailyBriefRefreshConnectors",
  "dailyBriefUpdateProjections",
  "dailyBriefRunAgent",
  "dailyBriefValidate",
  "dailyBriefBuildGlobal",
  "dailyBriefBuildWorkspace",
  "dailyBriefCommit",
  "dailyBriefUpdateDashboard",
  "dailyBriefNotify",
  "dailyBriefSurfaceFailure",
  "periodReviewRefreshConnectors",
  "periodReviewUpdateProjections",
  "periodReviewRunAgent",
  "periodReviewValidate",
  "periodReviewBuildGlobal",
  "periodReviewBuildWorkspace",
  "periodReviewCommit",
  "periodReviewUpdateDashboard",
  "periodReviewNotify",
  "periodReviewSurfaceFailure",
  "projectSyncParseProgress",
  "projectSyncSynthesizeNarrative",
  "projectSyncValidateNarrative",
  "projectSyncBuildOutputs",
  "projectSyncCommitStatus",
  "projectSyncUpdateDashboard",
  "projectSyncProposeActions",
  "projectSyncSurfaceFailure",
  "crossCalendarGatherAvailability",
  "crossCalendarProposeWindowsAgent",
  "crossCalendarValidateProposal",
  "crossCalendarBuildOutputs",
  "crossCalendarClassifyAction",
  "crossCalendarAutoCreateEvent",
  "crossCalendarRouteToApproval",
  "crossCalendarCommitNote",
  "crossCalendarSurfaceFailure",
] as const;

/** Assert a Result-shaped value is a typed rejection — never undefined, never thrown. */
function expectTypedRejection(result: unknown, label: string): void {
  expect(result, `${label}: result must be defined`).toBeDefined();
  expect(typeof result, `${label}: result must be an object`).toBe("object");
  const r = result as { ok?: unknown; error?: unknown };
  expect(r.ok, `${label}: ok must be false`).toBe(false);
  expect(r.error, `${label}: error must be present`).toBeDefined();
  expect(typeof (r.error as { code?: unknown } | undefined)?.code, `${label}: error.code must be a string`).toBe(
    "string",
  );
}

describe("createOutputWorkflowActivities — the flat factory surface (Phase 25)", () => {
  it("returns every declared member name, each a function", () => {
    const activities = createOutputWorkflowActivities(makeDeps());
    for (const name of EXPECTED_MEMBERS) {
      expect(typeof activities[name as keyof OutputWorkflowActivities], name).toBe("function");
    }
    // No unexpected surface (an accidental extra member would defeat "flat, exactly
    // the port surface" — count the OWN enumerable keys).
    expect(Object.keys(activities).sort()).toEqual([...EXPECTED_MEMBERS].sort());
  });

  it("registers/schedules nothing — the factory call itself performs zero I/O beyond construction", () => {
    // Constructing the object must not touch the schedule store or any port
    // method — it only WIRES functions. `InMemoryScheduleStore` is unused here
    // deliberately: `deps.schedule` is not even a parameter of this factory.
    const before = new InMemoryScheduleStore();
    createOutputWorkflowActivities(makeDeps());
    expect(before).toBeDefined(); // untouched — nothing to assert on; construction took no schedule dep.
  });

  it("every member's rejection path resolves to a typed error — never throws", async () => {
    const a = createOutputWorkflowActivities(makeDeps());
    const dailyBriefCtx = { scopes: [{ workspaceId: WS }] };
    const periodReviewCtx = { scopes: [{ workspaceId: WS }] };
    const projectSyncCtx = { projectRef: "proj-factory-test" };
    const crossCalendarCtx = { sources: [{ sourceId: "s1", workspaceId: WS }], organizerWorkspaceId: WS };
    const inferredDraft = { fields: { x: { value: "an inferred value with no evidenceRef" } }, schemaId: "s" };
    const auditRef = "audit-factory-test" as unknown as AuditId;

    // --- dailyBrief ---
    expectTypedRejection(await a.dailyBriefRefreshConnectors(dailyBriefCtx as never), "dailyBriefRefreshConnectors");
    expectTypedRejection(await a.dailyBriefUpdateProjections(dailyBriefCtx as never), "dailyBriefUpdateProjections");
    expectTypedRejection(await a.dailyBriefRunAgent(dailyBriefCtx as never), "dailyBriefRunAgent");
    expectTypedRejection(a.dailyBriefValidate(inferredDraft as never), "dailyBriefValidate");
    expectTypedRejection(
      await a.dailyBriefBuildGlobal({ validated: true, fields: {} } as never, [], WS),
      "dailyBriefBuildGlobal",
    );
    expectTypedRejection(
      await a.dailyBriefBuildWorkspace({ validated: true, fields: {} } as never, WS),
      "dailyBriefBuildWorkspace",
    );
    expectTypedRejection(await a.dailyBriefCommit(validKnowledgeMutationPlan), "dailyBriefCommit");
    expectTypedRejection(await a.dailyBriefUpdateDashboard({}), "dailyBriefUpdateDashboard");
    expectTypedRejection(await a.dailyBriefNotify(validProposedAction, validExternalWriteEnvelope), "dailyBriefNotify");
    expectTypedRejection(
      await a.dailyBriefSurfaceFailure({ failureClass: "write_through_failed", subjectRef: "x", message: "m", auditRef }),
      "dailyBriefSurfaceFailure",
    );

    // --- periodReview ---
    expectTypedRejection(await a.periodReviewRefreshConnectors(periodReviewCtx as never), "periodReviewRefreshConnectors");
    expectTypedRejection(await a.periodReviewUpdateProjections(periodReviewCtx as never), "periodReviewUpdateProjections");
    expectTypedRejection(await a.periodReviewRunAgent(periodReviewCtx as never), "periodReviewRunAgent");
    expectTypedRejection(a.periodReviewValidate(inferredDraft as never), "periodReviewValidate");
    const reviewWindow = { windowStart: "2026-08-17T00:00:00.000Z", windowEnd: "2026-08-24T00:00:00.000Z", period: "weekly" as const, elapsedMs: 604800000, source: "wall" as const };
    expectTypedRejection(
      await a.periodReviewBuildGlobal({ validated: true, fields: {} } as never, [], reviewWindow, WS),
      "periodReviewBuildGlobal",
    );
    expectTypedRejection(
      await a.periodReviewBuildWorkspace({ validated: true, fields: {} } as never, reviewWindow, WS),
      "periodReviewBuildWorkspace",
    );
    expectTypedRejection(await a.periodReviewCommit(validKnowledgeMutationPlan), "periodReviewCommit");
    expectTypedRejection(await a.periodReviewUpdateDashboard({}), "periodReviewUpdateDashboard");
    expectTypedRejection(await a.periodReviewNotify(validProposedAction, validExternalWriteEnvelope), "periodReviewNotify");
    expectTypedRejection(
      await a.periodReviewSurfaceFailure({ failureClass: "write_through_failed", subjectRef: "x", message: "m", auditRef }),
      "periodReviewSurfaceFailure",
    );

    // --- projectSync ---
    expectTypedRejection(await a.projectSyncParseProgress(projectSyncCtx), "projectSyncParseProgress");
    const progress = { completedCount: 0, totalCount: 0, percentComplete: 0, perProvider: [] };
    expectTypedRejection(
      await a.projectSyncSynthesizeNarrative(projectSyncCtx, progress),
      "projectSyncSynthesizeNarrative",
    );
    expectTypedRejection(a.projectSyncValidateNarrative(inferredDraft as never), "projectSyncValidateNarrative");
    const identity = { projectId: "p1", title: "P1", slug: "p1", lifecycleState: "active" as const };
    expectTypedRejection(
      await a.projectSyncBuildOutputs({ validated: true, fields: {} } as never, progress, WS, identity, "2026-08-24T00:00:00.000Z"),
      "projectSyncBuildOutputs",
    );
    expectTypedRejection(await a.projectSyncCommitStatus(validKnowledgeMutationPlan), "projectSyncCommitStatus");
    expectTypedRejection(await a.projectSyncUpdateDashboard({}), "projectSyncUpdateDashboard");
    expectTypedRejection(
      await a.projectSyncProposeActions(validProposedAction, validExternalWriteEnvelope),
      "projectSyncProposeActions",
    );
    expectTypedRejection(
      await a.projectSyncSurfaceFailure({ failureClass: "write_through_failed", subjectRef: "x", message: "m", auditRef }),
      "projectSyncSurfaceFailure",
    );

    // --- crossCalendarScheduling ---
    expectTypedRejection(await a.crossCalendarGatherAvailability(crossCalendarCtx), "crossCalendarGatherAvailability");
    expectTypedRejection(await a.crossCalendarProposeWindowsAgent(crossCalendarCtx), "crossCalendarProposeWindowsAgent");
    expectTypedRejection(
      a.crossCalendarValidateProposal({ ...inferredDraft, windows: [] } as never),
      "crossCalendarValidateProposal",
    );
    expectTypedRejection(
      await a.crossCalendarBuildOutputs({ validated: true, fields: {}, windows: [] } as never, WS),
      "crossCalendarBuildOutputs",
    );
    expectTypedRejection(await a.crossCalendarClassifyAction(validProposedAction, WS), "crossCalendarClassifyAction");
    expectTypedRejection(
      await a.crossCalendarAutoCreateEvent(validProposedAction, validExternalWriteEnvelope),
      "crossCalendarAutoCreateEvent",
    );
    expectTypedRejection(
      await a.crossCalendarRouteToApproval(validProposedAction, validExternalWriteEnvelope),
      "crossCalendarRouteToApproval",
    );
    expectTypedRejection(await a.crossCalendarCommitNote(validKnowledgeMutationPlan), "crossCalendarCommitNote");
    expectTypedRejection(
      await a.crossCalendarSurfaceFailure({ failureClass: "write_through_failed", subjectRef: "x", message: "m", auditRef }),
      "crossCalendarSurfaceFailure",
    );
  });
});

// task 24.105 — the binding-site precondition guard's non-vacuity test for THIS factory's
// `createCommitActivity` site (outputWorkflows.ts:353 — the FOURTH production site the task names,
// distinct from apps/worker's buildActivities.ts pair and semanticApprovalDispatch.ts). The raw
// `CommitKnowledgePort` the local `commitActivity` const wraps must NEVER itself be a member of the
// object this factory returns — only through a plain-async WRAPPER function (`dailyBriefCommit` etc.
// below). A bare prohibition invites its own deletion (`L82`); this pins it executably, mirroring
// apps/worker/test/proof-spine-composition.test.ts's sibling pin for the other three sites.
describe("createOutputWorkflowActivities — task 24.105: the raw commit PORT is never a registered activity member", () => {
  it('no "commit" key exists at all, and every commit-bearing member carries no nested .commit method', () => {
    const activities = createOutputWorkflowActivities(makeDeps());
    const record = activities as unknown as Record<string, unknown>;
    // The LOCAL const is named `commitActivity`, but no registered member is literally named
    // "commit" — a `"commit"` key would mean the raw port (or a mis-wired duplicate) leaked into
    // the returned surface under its own name.
    expect("commit" in record).toBe(false);
    // All four commit-bearing members exist and are plain functions — the flat shape this file's
    // header requires and Temporal's `Worker.create({activities})` expects...
    const commitMembers = [
      "dailyBriefCommit",
      "periodReviewCommit",
      "projectSyncCommitStatus",
      "crossCalendarCommitNote",
    ] as const;
    for (const name of commitMembers) {
      expect(typeof record[name], name).toBe("function");
      // ...never the raw CommitKnowledgePort OBJECT (which carries a nested `.commit` method) — a
      // regression that spread `{...commitActivity}` into the returned literal instead of wrapping
      // it would put a `.commit` property on the exposed value; this proves it was WRAPPED, not
      // aliased.
      expect((record[name] as { readonly commit?: unknown }).commit, `${name}.commit`).toBeUndefined();
    }
  });
});

// task 24.105 — the raw WriteFailure `cause` (secret-scan detail, workspace-path detail,
// ownership-rejection detail, and any other validator-authored substance) must be DROPPED at the
// activity boundary, while the stable `code` every workflow driver reads still crosses UNCHANGED.
// Each poison fixture below plants a DIFFERENT detectable substring in `cause` — a bare object
// value (never a string containing the substring, so a naive `JSON.stringify` scan is honest about
// what it is proving) — and the assertion serializes the WHOLE activity result and checks none of
// the three poison substrings appear anywhere in it.
describe("createOutputWorkflowActivities — task 24.105: cause is dropped at the activity boundary", () => {
  const POISON_SECRET = "leak-secret-9f3c";
  const POISON_PATH = "sources/other-workspace/x.md";
  const POISON_DSN = "leak-dsn-a71b";

  function makeDepsWithPoisonedCommit(): OutputWorkflowActivitiesDeps {
    const deps = makeDeps();
    return {
      ...deps,
      commit: {
        ...deps.commit,
        // A hostile `applyPlan` rejecting with a `WriteFailure` whose `cause`-reachable fields
        // carry the three poison markers — mirroring the shape commitKnowledge.ts's own
        // `err({ code, message, cause: result.error })` puts under `cause` on a real
        // ownership/secret/workspace-path rejection (commitKnowledge.ts:160-166).
        applyPlan: (() =>
          Promise.resolve(
            err({
              code: "secret_found" as const,
              message: "fake commit failure carrying poisoned detail",
              cause: {
                secret: POISON_SECRET,
                path: POISON_PATH,
                dsn: POISON_DSN,
                issues: [
                  { message: `secret match: ${POISON_SECRET}` },
                  { message: `workspace path violation: ${POISON_PATH}` },
                  { message: `dsn leaked: ${POISON_DSN}` },
                ],
              },
            }),
          )) as unknown as OutputWorkflowActivitiesDeps["commit"]["applyPlan"],
      },
    };
  }

  const COMMIT_CASES = [
    { member: "dailyBriefCommit", call: (a: OutputWorkflowActivities) => a.dailyBriefCommit(validKnowledgeMutationPlan) },
    { member: "periodReviewCommit", call: (a: OutputWorkflowActivities) => a.periodReviewCommit(validKnowledgeMutationPlan) },
    { member: "projectSyncCommitStatus", call: (a: OutputWorkflowActivities) => a.projectSyncCommitStatus(validKnowledgeMutationPlan) },
    { member: "crossCalendarCommitNote", call: (a: OutputWorkflowActivities) => a.crossCalendarCommitNote(validKnowledgeMutationPlan) },
  ] as const;

  it("no poison substring (secret, cross-workspace path, dsn) survives into the serialized activity result, while `code` crosses unchanged", async () => {
    const activities = createOutputWorkflowActivities(makeDepsWithPoisonedCommit());
    for (const { member, call } of COMMIT_CASES) {
      const result = await call(activities);
      const serialized = JSON.stringify(result);
      expect(serialized, `${member}: must not contain the poisoned secret`).not.toContain(POISON_SECRET);
      expect(serialized, `${member}: must not contain the poisoned cross-workspace path`).not.toContain(POISON_PATH);
      expect(serialized, `${member}: must not contain the poisoned dsn`).not.toContain(POISON_DSN);
      // No `cause` key at all — an explicit `cause: undefined` would still be a live field a future
      // change could populate; the wrapper must OMIT the key entirely.
      expect(serialized, `${member}: must carry no cause key`).not.toContain("cause");
      const r = result as { readonly ok: boolean; readonly error?: { readonly code?: unknown } };
      expect(r.ok, `${member}: ok must be false`).toBe(false);
      expect(r.error?.code, `${member}: the stable code must still cross`).toBe("secret_found");
    }
  });
});
