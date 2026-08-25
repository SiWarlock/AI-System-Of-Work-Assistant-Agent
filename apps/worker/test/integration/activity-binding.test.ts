// @sow/worker — 12.24: the per-path activity-BINDING-IDENTITY proof.
//
// `test/proof-spine-composition.test.ts:211-235` asserts only NAME PRESENCE
// (`typeof acts[name] === "function"`) over a HARDCODED 15-name list — it never
// executes anything, and the list omits every per-path SOURCE name
// (`sourceCommit`, `sourceLivingVaultRewrite`, `sourceProposeKnowledgeApproval`).
// A name-presence check cannot catch a WIRING swap (e.g. `meetingCommit` and
// `sourceCommit` trading their right-hand-side bindings in
// `composition/buildActivities.ts`'s returned object) — both sides would still
// be `typeof === "function"`.
//
// This harness instead drives the REAL sandbox workflows over a REAL
// `@temporalio` Worker + `TestWorkflowEnvironment` (reusing the EXACT setup
// `test/integration/proof-spine.test.ts:230` already proved: `Worker.create`
// over `env.nativeConnection` + `bundleWorkflowCode(proofSpineWorkflowsPath())`
// with the SAME sandbox stubs, `env.client.workflow.execute`) and asserts a
// PRODUCTION-MEANINGFUL, BINDING-SPECIFIC side effect for the one pair where a
// swap is actually observable: `meetingCommit` and `sourceCommit` are TWO
// DISTINCT `CommitKnowledgePort` instances (buildActivities.ts ~1090-1231) —
// only `sourceCommit`'s wrapper calls `refreshRecentChanges` after a successful
// commit (meetingCommit's plain `commit.commit(plan)` never does). Driving BOTH
// workflows to a successful commit, under two DISTINCT workspaces, and reading
// the `recent_changes` read-model back for each workspace, proves BOTH names
// reach their INTENDED port — never each other's.
//
// MUTATION-VERIFIED (per the brief): swapping `meetingCommit` and `sourceCommit`
// in a scratch copy of buildActivities.ts's returned object and re-running this
// file with SOW_TEMPORAL=1 REDS both assertions below (the recent_changes
// refresh flips to the WRONG workspace in each direction). See the PKG-W2
// Step-9 report for the transcript; the swap is not committed anywhere.
//
// GATED: `describe.skipIf(!SOW_TEMPORAL)` for the live cases (never needed by
// the default suite). The activity-name-coverage check runs UNGATED — it needs
// no Temporal server and closes the old hardcoded-list's coverage gap on its own.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  ok,
  isErr,
  workspaceId,
  workflowId,
  sourceId,
  validKnowledgeMutationPlan,
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
} from "@sow/contracts";
import type {
  WorkspaceId,
  WorkflowRunRef,
  SourceRef,
  ProviderRoute,
} from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import type {
  AgentExtraction,
  MeetingCloseoutContext,
  MeetingCloseoutInput,
  MeetingCloseoutOutcome,
  MeetingJobInputs,
  SourceIngestionInput,
  SourceIngestionOutcome,
  SourceIngestionContext,
  IngestionTriageInput,
  IngestionTriageOutcome,
  SourceLivingVaultPort,
  ProposeKnowledgeApprovalPort,
  ValidatedExtraction,
  SourceNoteIdentity,
} from "@sow/workflows";
import type { CommittedRevision, KnowledgeRevisionStore } from "@sow/knowledge";
import { computeRevisionId } from "@sow/knowledge";
import type { SourceDispositionRow } from "@sow/db";

import { SOW_TEMPORAL } from "../support/temporalGate";
import {
  assembleBackends,
  type ProofSpineBackends,
} from "../../src/composition/backends";
import { buildProofSpineActivities } from "../../src/composition/buildActivities";
import type { ProofSpineParams } from "../../src/composition/buildActivities";
import {
  proofSpineWorkflowsPath,
  PROOF_SPINE_IGNORE_MODULES,
  proofSpineWebpackConfigHook,
} from "../../src/temporal/registerWorker";
import { READ_MODEL_KEYS } from "../../src/api/adapters/readModel";

// ── deterministic constants ───────────────────────────────────────────────────
const MEETING_WS: WorkspaceId = workspaceId("ws-bind-meeting");
const SRC_WS: WorkspaceId = workspaceId("ws-bind-source");
const TRIAGE_WS: WorkspaceId = workspaceId("ws-bind-triage");
const NOW = "2026-07-02T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const MEETING_CAP = "meeting.close";
const TASK_QUEUE = "sow-control-plane";
const EMPTY_VAULT_REVISION = computeRevisionId(new Map());

// ─────────────────────────────────────────────────────────────────────────────
// (1) ACTIVITY-NAME COVERAGE — ungated, no Temporal server. Closes the old
// hardcoded-15-name list's gap: every registered name, INCLUDING the three the
// old list omitted (sourceCommit, sourceLivingVaultRewrite,
// sourceProposeKnowledgeApproval) plus the ones added since (meetingPark,
// connectorPoll).
// ─────────────────────────────────────────────────────────────────────────────
const ALL_REGISTERED_ACTIVITY_NAMES = [
  "meetingCorrelate",
  "meetingRunAgentJob",
  "meetingValidate",
  "meetingBuildOutputs",
  "meetingCommit",
  "meetingPropose",
  "meetingReindex",
  "meetingPark",
  "meetingProposeKnowledgeApproval",
  "approvalRecordPending",
  "approvalSurfaceCard",
  "approvalApply",
  "approvalDispatchApproved",
  "triageRecordDisposition",
  "triageRescopeSource",
  "triageReenter",
  "sourceRegister",
  "sourceRoute",
  "sourceRunAgentJob",
  "sourceBuildOutputs",
  "sourceCommit",
  "sourcePropose",
  "sourceIndex",
  "sourceLivingVaultRewrite",
  "sourceProposeKnowledgeApproval",
  "connectorPoll",
  "surfaceFailure",
] as const;

const localRoute = (endpoint: string): ProviderRoute =>
  ({
    provider: "ollama",
    model: "local-default",
    endpoint,
    egressClass: "local",
  }) as unknown as ProviderRoute;

const resolvedFor = (endpoint: string): ResolvedWorkspacePolicy => ({
  workspaceId: String(MEETING_WS),
  type: "employer_work",
  dataOwner: "employer",
  defaultVisibility: "coordination",
  egressPolicy: {
    workspaceId: MEETING_WS,
    allowedProcessors: [],
    rawContentAllowedProcessors: [],
    employerRawEgressAcknowledged: false,
  },
  providerMatrix: {
    workspaceId: MEETING_WS,
    allowedProviders: ["ollama"],
    capabilityDefaults: {
      [MEETING_CAP]: localRoute(endpoint),
      "source.process": localRoute(endpoint),
    } as never,
    rawCloudEgressEnabled: false,
  },
});

const runRef: WorkflowRunRef = {
  workflowId: workflowId("wf-bind"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:bind",
  auditRefs: [],
};

const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-bind"),
  workspaceId: MEETING_WS,
  capability: MEETING_CAP,
  // 18.2 — the meeting.close broker candidate is a KnowledgeMutationPlan
  // stand-in (proof-spine.test.ts's pattern); the real SCHEMA gate validates
  // candidateOutput against THIS registered schema.
  outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:meeting:bind",
};

const meetingExtraction: AgentExtraction = {
  fields: { title: { value: "Binding Proof Sync", evidenceRef: "src:1#0" } },
};

// A candidate extraction safe under the no-inference rule (owner evidence-backed,
// dueDate the TBD sentinel) — the REAL in-sandbox validate gate PASSES it.
const sourceExtraction: AgentExtraction = {
  fields: {
    owner: { value: "Bob", evidenceRef: "source#L12" },
    dueDate: { value: TBD },
  },
  schemaId: "sow:source-ingest-output",
};

function paramsFor(revisions: KnowledgeRevisionStore): ProofSpineParams {
  return {
    resolved: resolvedFor(LOCAL_ENDPOINT),
    correlationSignals: { confidence: 0.95, workspaceId: MEETING_WS },
    meetingJobInputs,
    meetingExtraction,
    revisions,
    commit: {
      actor: "worker:bind",
      sourceEventRef: "evt:bind",
      workflowRunRef: runRef,
      expectedBaseRevision: EMPTY_VAULT_REVISION,
    },
    sourceRef: { sourceId: sourceId("src-bind-meeting") } satisfies SourceRef,
    planIdentity: { closeout: "meeting:bind" },
    sourceIngestion: {
      boundWorkspaceId: SRC_WS,
      extraction: sourceExtraction,
      sourceRef: { sourceId: sourceId("src-bind-source") } satisfies SourceRef,
      planIdentity: { ingest: "source:ingest:bind" },
    },
  };
}

function memRevisionStore(): KnowledgeRevisionStore {
  const byKey = new Map<string, CommittedRevision>();
  return {
    getByIdempotencyKey: (k) => Promise.resolve(byKey.get(k)),
    record: (rev) => {
      byKey.set(rev.idempotencyKey, rev);
      return Promise.resolve();
    },
  };
}

const meetingCtx = (): MeetingCloseoutContext => ({
  source: {
    sourceId: sourceId("src-bind-meeting"),
    workspaceId: MEETING_WS,
    origin: "https://example.test/binding-meeting",
    contentHash: "hash:bind-meeting",
    type: "transcript",
    sensitivity: "internal",
    routingHints: {},
  },
  envelopes: [],
});

const sourceCtx = (): SourceIngestionContext => ({
  source: {
    sourceId: sourceId("src-bind-source"),
    workspaceId: SRC_WS,
    origin: "https://www.youtube.com/watch?v=bindingproof",
    contentHash: "sha256:binding-source-1",
    type: "youtube_video",
    sensitivity: "normal",
    routingHints: {},
  },
  envelopes: [],
});

describe("buildProofSpineActivities — full registered activity-name surface (no Temporal server)", () => {
  it("exposes EVERY registered activity as a function, including the 3 names the old hardcoded list omitted", async () => {
    const backends = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] },
      { candidateOutput: validKnowledgeMutationPlan },
    );
    try {
      const acts = buildProofSpineActivities(backends, paramsFor(memRevisionStore()));
      for (const name of ALL_REGISTERED_ACTIVITY_NAMES) {
        expect(typeof (acts as unknown as Record<string, unknown>)[name]).toBe("function");
      }
    } finally {
      backends.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (1b) BINDING IDENTITY for the two per-path pairs 12.24's own header names as
// still uncovered: `sourceLivingVaultRewrite`, and the
// `meetingProposeKnowledgeApproval`/`sourceProposeKnowledgeApproval` pair.
// UNGATED (no Temporal server needed): `buildProofSpineActivities` returns each
// of these as a PLAIN function closing over the injected port
// (`createLivingVaultActivity`/`createProposeKnowledgeApprovalActivity`,
// composition/living-vault.ts — `port === undefined ⇒ the unarmed default; else
// port.rewrite/propose(...)`), so calling the returned function DIRECTLY
// exercises the exact composition-root wiring 12.24 names, with no Worker or
// TestWorkflowEnvironment required.
//
// The propose pair is DOCUMENTED (buildActivities.ts ~1394: "SAME shared port
// instance as meetingProposeKnowledgeApproval") to delegate to ONE shared
// `params.proposeKnowledgeApproval` instance — 12.24's own severity note
// already established a NAME SWAP between the two is behaviourally inert
// (identical right-hand side) and therefore cannot be discriminated by any
// test. What CAN be discriminated, and is the real risk this closes, is EACH
// name reaching ITS intended injected dependency AT ALL — the class of
// regression where one leg is silently left wired to the unarmed default while
// the other correctly threads the port. The third test below is the
// mutation-proof for that: with NEITHER port injected (paramsFor's shipped
// default), production `createProposeKnowledgeApprovalActivity`/
// `createLivingVaultActivity` return the unarmed outcome for BOTH — the same
// observable shape a dropped wiring line would produce — proving the spy-based
// assertions above are load-bearing rather than vacuously satisfied.
// ─────────────────────────────────────────────────────────────────────────────
describe("buildProofSpineActivities — sourceLivingVaultRewrite / propose-approval pair reach their injected ports", () => {
  function spyLivingVault(): { port: SourceLivingVaultPort; calls: Parameters<SourceLivingVaultPort["rewrite"]>[] } {
    const calls: Parameters<SourceLivingVaultPort["rewrite"]>[] = [];
    return {
      calls,
      port: {
        rewrite: (...args: Parameters<SourceLivingVaultPort["rewrite"]>) => {
          calls.push(args);
          return Promise.resolve(ok([]));
        },
      },
    };
  }
  function spyProposeApproval(): { port: ProposeKnowledgeApprovalPort; calls: Parameters<ProposeKnowledgeApprovalPort["propose"]>[] } {
    const calls: Parameters<ProposeKnowledgeApprovalPort["propose"]>[] = [];
    return {
      calls,
      port: {
        propose: (...args: Parameters<ProposeKnowledgeApprovalPort["propose"]>) => {
          calls.push(args);
          return Promise.resolve(ok({ approvalRef: "appr:bind-spy", created: true }));
        },
      },
    };
  }

  it("sourceLivingVaultRewrite reaches the INJECTED livingVault port instance (not the unarmed ok([]) default)", async () => {
    const spy = spyLivingVault();
    const backends = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] },
      { candidateOutput: validKnowledgeMutationPlan },
    );
    try {
      const acts = buildProofSpineActivities(backends, {
        ...paramsFor(memRevisionStore()),
        livingVault: spy.port,
      });
      const validated: ValidatedExtraction = { validated: true, fields: {} };
      const source: SourceNoteIdentity = {
        sourceId: sourceId("src-bind-lv"),
        contentHash: "hash:bind-lv",
      };
      const result = await acts.sourceLivingVaultRewrite(validated, SRC_WS, source);
      // Reached the SPY, not the unarmed `ok([])` default: the spy's own args round-trip.
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.[0]).toBe(validated);
      expect(spy.calls[0]?.[1]).toBe(SRC_WS);
      expect(spy.calls[0]?.[2]).toEqual(source);
      expect(result).toEqual(ok([]));
    } finally {
      backends.close();
    }
  });

  it("meetingProposeKnowledgeApproval AND sourceProposeKnowledgeApproval BOTH reach the SAME injected proposeKnowledgeApproval port instance", async () => {
    const spy = spyProposeApproval();
    const backends = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] },
      { candidateOutput: validKnowledgeMutationPlan },
    );
    try {
      const acts = buildProofSpineActivities(backends, {
        ...paramsFor(memRevisionStore()),
        proposeKnowledgeApproval: spy.port,
      });
      const meetingRes = await acts.meetingProposeKnowledgeApproval(validKnowledgeMutationPlan, MEETING_WS);
      const sourceRes = await acts.sourceProposeKnowledgeApproval(validKnowledgeMutationPlan, SRC_WS);
      // Both calls reached the SAME spy instance, each carrying its OWN workspace — proving
      // neither name is silently unbound nor accidentally routed to a DIFFERENT port.
      expect(spy.calls).toHaveLength(2);
      expect(spy.calls[0]?.[1]).toBe(MEETING_WS);
      expect(spy.calls[1]?.[1]).toBe(SRC_WS);
      expect(meetingRes).toEqual(ok({ approvalRef: "appr:bind-spy", created: true }));
      expect(sourceRes).toEqual(ok({ approvalRef: "appr:bind-spy", created: true }));
    } finally {
      backends.close();
    }
  });

  it("MUTATION PROOF — with NEITHER port injected, both names return the unarmed outcome (never a silent success) — proves the two tests above are load-bearing, not vacuous", async () => {
    const backends = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] },
      { candidateOutput: validKnowledgeMutationPlan },
    );
    try {
      // paramsFor(...) alone omits BOTH `livingVault` and `proposeKnowledgeApproval` — the exact
      // shape a wiring regression that forgot to thread either port would produce.
      const acts = buildProofSpineActivities(backends, paramsFor(memRevisionStore()));
      const validated: ValidatedExtraction = { validated: true, fields: {} };
      const source: SourceNoteIdentity = {
        sourceId: sourceId("src-bind-lv-unarmed"),
        contentHash: "hash:bind-lv-unarmed",
      };
      const lvResult = await acts.sourceLivingVaultRewrite(validated, SRC_WS, source);
      expect(lvResult).toEqual(ok([])); // unarmed default — never a thrown/observable failure

      const meetingRes = await acts.meetingProposeKnowledgeApproval(validKnowledgeMutationPlan, MEETING_WS);
      const sourceRes = await acts.sourceProposeKnowledgeApproval(validKnowledgeMutationPlan, SRC_WS);
      expect(isErr(meetingRes)).toBe(true);
      expect(isErr(sourceRes)).toBe(true);
      if (isErr(meetingRes)) expect(meetingRes.error.code).toBe("not_armed");
      if (isErr(sourceRes)) expect(sourceRes.error.code).toBe("not_armed");
    } finally {
      backends.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) BINDING-IDENTITY over a REAL Temporal Worker (SOW_TEMPORAL-gated). ONE
// ephemeral env + ONE long-lived worker for the whole file (the Temporal Node
// SDK Runtime is a process singleton — proof-spine.test.ts's rationale).
// ─────────────────────────────────────────────────────────────────────────────
interface SharedRig {
  readonly execute: <R>(workflowType: string, wfId: string, arg: unknown) => Promise<R>;
  readonly backends: ProofSpineBackends;
}

let sharedRig: SharedRig | undefined;
let teardownAll: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!SOW_TEMPORAL) return;
  const { TestWorkflowEnvironment } = await import("@temporalio/testing");
  const { Worker, bundleWorkflowCode } = await import("@temporalio/worker");

  const bundle = await bundleWorkflowCode({
    workflowsPath: proofSpineWorkflowsPath(),
    ignoreModules: [...PROOF_SPINE_IGNORE_MODULES],
    webpackConfigHook: proofSpineWebpackConfigHook,
  });
  const env = await TestWorkflowEnvironment.createLocal();
  const backends = await assembleBackends(
    { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    { candidateOutput: validKnowledgeMutationPlan },
  );
  const activities = buildProofSpineActivities(backends, paramsFor(memRevisionStore()));
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle: bundle,
    activities: activities as unknown as Record<string, unknown>,
  });
  const runPromise = worker.run();

  sharedRig = {
    backends,
    execute: <R>(workflowType: string, wfId: string, arg: unknown): Promise<R> =>
      env.client.workflow.execute(workflowType, {
        workflowId: wfId,
        taskQueue: TASK_QUEUE,
        args: [arg],
      }) as Promise<R>,
  };
  teardownAll = async (): Promise<void> => {
    worker.shutdown();
    await runPromise.catch(() => undefined);
    backends.close();
    await env.teardown();
  };
}, 120_000);

afterAll(async () => {
  await teardownAll?.();
  sharedRig = undefined;
  teardownAll = undefined;
});

function rig(): SharedRig {
  if (sharedRig === undefined) throw new Error("shared rig not initialised");
  return sharedRig;
}

describe.skipIf(!SOW_TEMPORAL)(
  "activity binding identity — meetingCommit vs sourceCommit over a real Temporal worker",
  () => {
    it("meetingCommit reaches the MEETING port: a meeting note lands under meetings/<ws>/, and recent_changes is NOT refreshed for that workspace", async () => {
      const input: MeetingCloseoutInput = {
        run: {
          workflowId: workflowId("wf-bind-meeting"),
          trigger: "owner_action",
          idempotencyKey: "run:bind:meeting",
          workspaceId: String(MEETING_WS),
        },
        context: meetingCtx(),
      };
      const outcome = await rig().execute<MeetingCloseoutOutcome>(
        "meetingCloseoutWorkflow",
        "wf-bind-meeting",
        input,
      );
      expect(["knowledge_committed", "summarized"]).toContain(outcome.state);

      const notes = await rig().backends.vault.list();
      expect(notes.some((p) => p.startsWith(`meetings/${String(MEETING_WS)}/`))).toBe(true);

      // The flagship discriminator: ONLY sourceCommit's wrapper calls
      // refreshRecentChanges. If meetingCommit/sourceCommit were swapped in
      // buildActivities.ts, THIS would flip to `ok` (the swapped-in
      // sourceCommit block would refresh the MEETING workspace instead).
      const recentChanges = await rig().backends.repos.readModels.get(
        READ_MODEL_KEYS.recentChanges,
        String(MEETING_WS),
      );
      expect(isErr(recentChanges)).toBe(true);
      if (isErr(recentChanges)) expect(recentChanges.error.code).toBe("not_found");
    });

    it("sourceCommit reaches the SOURCE port: a source note lands under sources/<ws>/, and recent_changes IS refreshed for that workspace", async () => {
      const input: SourceIngestionInput = {
        run: {
          workflowId: workflowId("wf-bind-source"),
          trigger: "owner_action",
          idempotencyKey: "run:bind:source",
          workspaceId: String(SRC_WS),
        },
        context: sourceCtx(),
      };
      const outcome = await rig().execute<SourceIngestionOutcome>(
        "sourceIngestionWorkflow",
        "wf-bind-source",
        input,
      );
      // Reaching `applied` transitively proves sourceRegister/Route/RunAgentJob/
      // BuildOutputs/Index AND the two always-invoked dormant legs
      // (sourceLivingVaultRewrite, sourceProposeKnowledgeApproval) all ran
      // without an uncaught throw across the Temporal boundary (§16).
      expect(outcome.state).toBe("applied");
      expect(outcome.context.workspaceId).toBe(String(SRC_WS));

      const notes = await rig().backends.vault.list();
      expect(notes.some((p) => p.startsWith(`sources/${String(SRC_WS)}/`))).toBe(true);

      // The flagship discriminator's other half: sourceCommit's wrapper DID
      // refresh recent_changes for the SOURCE workspace. If swapped, this
      // would flip to `err(not_found)` (the swapped-in plain meetingCommit
      // block never calls refreshRecentChanges).
      const recentChanges = await rig().backends.repos.readModels.get(
        READ_MODEL_KEYS.recentChanges,
        String(SRC_WS),
      );
      expect(recentChanges.ok).toBe(true);
      if (recentChanges.ok) expect(recentChanges.value.data).toBeDefined();
    });
  },
);

describe.skipIf(!SOW_TEMPORAL)(
  "activity binding identity — the ingestion-triage activity trio over a real Temporal worker",
  () => {
    it("triageRecordDisposition/triageRescopeSource/triageReenter reach the real durable disposition store", async () => {
      const SRC = "src:bind:triage-1";
      await rig().backends.repos.sourceDisposition.park({
        sourceId: SRC,
        sourceEnvelope: {
          sourceId: sourceId(SRC),
          workspaceId: TRIAGE_WS,
          origin: "https://example.test/binding-triage",
          contentHash: "hash:bind-triage",
          type: "document",
          sensitivity: "internal",
          routingHints: {},
        },
        idempotencyKey: `idem:${SRC}`,
        state: "queued_for_review",
        dispositionKey: null,
        auditRef: null,
        parkedAt: NOW,
        dispositionedAt: null,
      } satisfies SourceDispositionRow);

      const input: IngestionTriageInput = {
        run: {
          workflowId: workflowId("wf-bind-triage"),
          trigger: "owner_action",
          idempotencyKey: "run:bind:triage",
          workspaceId: String(TRIAGE_WS),
        },
        disposition: { sourceId: SRC, workspaceId: TRIAGE_WS, channel: "mac" },
      };
      const outcome = await rig().execute<IngestionTriageOutcome>(
        "ingestionTriageWorkflow",
        "wf-bind-triage",
        input,
      );
      expect(outcome.context.auditRef).toBeDefined();
      expect(outcome.resolved).toBe(true);

      // The REAL durable row, not the in-sandbox run-repo outcome: proves
      // triageRecordDisposition reached the actual @sow/db-backed store.
      const row = await rig().backends.repos.sourceDisposition.getBySourceId(SRC);
      expect(row.ok).toBe(true);
      if (row.ok) {
        expect(row.value?.state).toBe("dispositioned");
        expect(row.value?.auditRef).toBe(String(outcome.context.auditRef));
      }
    });
  },
);
