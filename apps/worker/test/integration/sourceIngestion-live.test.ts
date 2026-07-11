// @sow/worker — the SOURCE-INGESTION LIVE integration test (make-it-real slice C1).
//
// It activates the previously-uncalled §9 `sourceIngestion` driver on a REAL local
// Temporal worker (an ephemeral TestWorkflowEnvironment + the SAME bundled workflow
// sandbox the proof spine uses). Guardrail-3 shape: only the REAL @sow/integrations
// `registerSource()` candidate gate runs for real; every other leaf (route / agent /
// buildOutputs / commit / propose / index) is a DETERMINISTIC fake — no real vault
// write, no model call, no external write, no disk-content read in C1 (those are
// C2/C3). It mirrors proof-spine.test.ts's harness verbatim (one ephemeral env + one
// long-lived worker for the whole file).
//
// GATED: `describe.skipIf(!SOW_TEMPORAL)`. The default suite must NEVER need a live
// Temporal server; the live cases run only under SOW_TEMPORAL=1. The fast-unit
// registration check (no Temporal) runs in the default suite so the activity
// registration is guarded even with no server.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { workspaceId, workflowId, sourceId } from "@sow/contracts";
import type {
  WorkspaceId,
  WorkflowRunRef,
  SourceRef,
  SourceEnvelope,
  ProviderRoute,
} from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import type {
  AgentExtraction,
  MeetingJobInputs,
  SourceIngestionInput,
  SourceIngestionOutcome,
  SourceIngestionContext,
} from "@sow/workflows";
import type { CommittedRevision, KnowledgeRevisionStore } from "@sow/knowledge";
import { computeRevisionId } from "@sow/knowledge";
// make-it-real C2: the REAL ROOT-confined node:fs transport + the emit-only adapter,
// deep-imported (kept OFF the barrel/sandbox path — see file-read-transport.ts).
import { createFileReadTransport } from "@sow/integrations/connectors/adapters/file-read-transport";
import { extractFileSource } from "@sow/integrations/connectors/adapters/file-source";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ── deterministic constants ───────────────────────────────────────────────────
const WS: WorkspaceId = workspaceId("ws-emp");
const SRC_WS: WorkspaceId = workspaceId("ws-src");
const NOW = "2026-07-02T00:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const MEETING_CAP = "meeting.close";
const TASK_QUEUE = "sow-control-plane";
const EMPTY_VAULT_REVISION = computeRevisionId(new Map());

/** The source-ingestion activity delegate names the sandbox workflow proxies. */
const SOURCE_DELEGATE_NAMES = [
  "sourceRegister",
  "sourceRoute",
  "sourceRunAgentJob",
  "sourceBuildOutputs",
  "sourceCommit",
  "sourcePropose",
  "sourceIndex",
] as const;

// ── meeting fixtures (ProofSpineParams still binds the meeting flow) ────────────
const localRoute = (endpoint: string): ProviderRoute =>
  ({
    provider: "ollama",
    model: "local-default",
    endpoint,
    egressClass: "local",
  }) as unknown as ProviderRoute;

const resolvedFor = (endpoint: string): ResolvedWorkspacePolicy => ({
  workspaceId: String(WS),
  type: "employer_work",
  dataOwner: "employer",
  defaultVisibility: "coordination",
  egressPolicy: {
    workspaceId: WS,
    allowedProcessors: [],
    rawContentAllowedProcessors: [],
    employerRawEgressAcknowledged: false,
  },
  providerMatrix: {
    workspaceId: WS,
    allowedProviders: ["ollama"],
    capabilityDefaults: { [MEETING_CAP]: localRoute(endpoint) } as never,
    rawCloudEgressEnabled: false,
  },
});

const runRef: WorkflowRunRef = {
  workflowId: workflowId("wf-spine"),
  trigger: "owner_action",
  state: "running",
  idempotencyKey: "run:spine",
  auditRefs: [],
};

const meetingJobInputs: MeetingJobInputs = {
  workflowRunId: workflowId("wf-spine"),
  workspaceId: WS,
  capability: MEETING_CAP,
  outputSchemaId: "sow:meeting.close.output",
  maxRuntimeSeconds: 30,
  idempotencyKey: "job:meeting:spine",
};

const meetingExtraction: AgentExtraction = {
  fields: {
    title: { value: "Weekly Sync", evidenceRef: "src:1#0" },
  },
};

const meetingSourceRef: SourceRef = { sourceId: sourceId("src-1") };

// ── source-ingestion fixtures ──────────────────────────────────────────────────
// A candidate extraction safe under the no-inference rule (owner is evidence-backed,
// dueDate is the TBD sentinel) — so the REAL in-sandbox validate gate PASSES it.
const sourceExtraction: AgentExtraction = {
  fields: {
    owner: { value: "Bob", evidenceRef: "source#L12" },
    dueDate: { value: TBD },
  },
  schemaId: "sow:source-ingest-output",
};

const sourceIngestSourceRef: SourceRef = { sourceId: sourceId("src-ingest-1") };

/** A WELL-FORMED source context — the REAL registerSource gate returns `registered`. */
const validSourceCtx = (): SourceIngestionContext => ({
  source: {
    sourceId: sourceId("src-ingest-1"),
    workspaceId: SRC_WS,
    origin: "https://www.youtube.com/watch?v=abc123",
    contentHash: "sha256:source-live-1",
    type: "youtube_video",
    sensitivity: "normal",
    routingHints: {},
  },
  envelopes: [],
});

/**
 * A MALFORMED source context — a blank `contentHash` trips the REAL registerSource
 * Zod gate (`.min(1)`), so the gate rejects and the driver rests at failed_terminal.
 */
const malformedSourceCtx = (): SourceIngestionContext => ({
  source: { ...validSourceCtx().source, contentHash: "" },
  envelopes: [],
});

/** A tiny in-memory KnowledgeRevisionStore shared across a test's runs. */
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

/** ProofSpineParams with the additive `sourceIngestion` binding (C1). */
function sourceParamsFor(revisions: KnowledgeRevisionStore): ProofSpineParams {
  return {
    resolved: resolvedFor(LOCAL_ENDPOINT),
    correlationSignals: { confidence: 0.95, workspaceId: WS },
    meetingJobInputs,
    meetingExtraction,
    revisions,
    commit: {
      actor: "worker:spine",
      sourceEventRef: "evt:spine",
      workflowRunRef: runRef,
      expectedBaseRevision: EMPTY_VAULT_REVISION,
    },
    sourceRef: meetingSourceRef,
    planIdentity: { closeout: "meeting:spine" },
    sourceIngestion: {
      boundWorkspaceId: SRC_WS,
      extraction: sourceExtraction,
      sourceRef: sourceIngestSourceRef,
      planIdentity: { ingest: "source:ingest:spine" },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fast unit (no Temporal) — the activities object must expose the source delegates,
// or the live worker cannot find them when the sandbox workflow schedules them.
// ─────────────────────────────────────────────────────────────────────────────
describe("buildProofSpineActivities — exposes the sourceIngestion delegates", () => {
  it("registers every source-ingestion activity as a plain async fn — spec(§9)", async () => {
    const backends = await assembleBackends(
      { now: () => NOW, allowedLocalEndpoints: [LOCAL_ENDPOINT] },
      { candidateOutput: {} },
    );
    try {
      const acts = buildProofSpineActivities(backends, sourceParamsFor(memRevisionStore()));
      for (const name of SOURCE_DELEGATE_NAMES) {
        expect(typeof (acts as unknown as Record<string, unknown>)[name]).toBe("function");
      }
    } finally {
      backends.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ONE ephemeral Temporal env + ONE backends bundle + ONE long-lived worker for the
// whole file (the Temporal Node SDK Runtime is a process singleton — see
// proof-spine.test.ts for the rationale). Run REFS are isolated by DISTINCT workflow
// ids; the source-commit revision is deliberately SHARED — every drive of the same
// plan identity converges on one revision (exactly the idempotency test (c) asserts).
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
    { candidateOutput: {} },
  );
  const activities = buildProofSpineActivities(backends, sourceParamsFor(memRevisionStore()));
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

// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SOW_TEMPORAL)(
  "sourceIngestion — live end-to-end over a real Temporal worker",
  () => {
    it("(a) HAPPY PATH → schedules → executes → rests at applied via the REAL registerSource gate — spec(§9)", async () => {
      const input: SourceIngestionInput = {
        run: {
          workflowId: workflowId("wf-src-happy"),
          trigger: "owner_action",
          idempotencyKey: "run:src:happy",
          workspaceId: String(SRC_WS),
        },
        context: validSourceCtx(),
      };
      const outcome = await rig().execute<SourceIngestionOutcome>(
        "sourceIngestionWorkflow",
        "wf-src-happy",
        input,
      );
      // Reaching `applied` REQUIRES the REAL registerSource gate to have returned
      // `registered` (a dedupe_hit rests at rejected; a malformed source at
      // failed_terminal) — so the terminal state transitively proves the real gate ran.
      expect(outcome.state).toBe("applied");
      // The pipeline bound the routing workspace (WS-2) and committed a (fake) revision.
      expect(outcome.context.workspaceId).toBe(String(SRC_WS));
      expect(outcome.context.revisionId).toBeDefined();
    });

    it("(b) MALFORMED source → the REAL gate rejects → failed_terminal + a distinct schema_rejection health item, no uncaught throw — spec(§16)", async () => {
      const before = (await rig().backends.healthItems.list()).length;
      const input: SourceIngestionInput = {
        run: {
          workflowId: workflowId("wf-src-malformed"),
          trigger: "owner_action",
          idempotencyKey: "run:src:malformed",
          workspaceId: String(SRC_WS),
        },
        context: malformedSourceCtx(),
      };
      // The execute RESOLVING (not rejecting) is itself the §16 "no uncaught throw
      // across the worker boundary" proof.
      const outcome = await rig().execute<SourceIngestionOutcome>(
        "sourceIngestionWorkflow",
        "wf-src-malformed",
        input,
      );
      expect(outcome.state).toBe("failed_terminal");
      // A register-malformed schema reject is a DATA-validation failure — its §16 class is
      // schema_rejection (the C-fix; cause-aware, NOT the infra-bucket worker_down).
      expect(outcome.surfaced?.failureClass).toBe("schema_rejection");
      // A REAL persisted health item materialized through the surfacing sink.
      const after = await rig().backends.healthItems.list();
      expect(after.length).toBeGreaterThan(before);
      expect(after.some((h) => h.message.includes("registration failed"))).toBe(true);
    });

    it("(c) IDEMPOTENT COMMIT — two drives of the same source/plan identity converge on ONE durable revision (no duplicate effect) — spec(§9)", async () => {
      // Two DISTINCT Temporal workflow ids carrying the SAME run idempotencyKey + the
      // same source (the proof-spine (b)/(d) shape). The sandbox run repo mints a novel
      // run each time (documented — resolveRun reuse isn't observable in-sandbox), so the
      // idempotency this pins is at the DURABLE (commit) layer: same derived plan
      // identity ⇒ ONE revision. A non-idempotent commit fake would mint two, so the
      // equality below is non-vacuous. The real KnowledgeWriter durable idempotency +
      // run-level replay swap in at C2/C3.
      const mkInput = (wfId: string): SourceIngestionInput => ({
        run: {
          workflowId: workflowId(wfId),
          trigger: "owner_action",
          idempotencyKey: "run:src:replay",
          workspaceId: String(SRC_WS),
        },
        context: validSourceCtx(),
      });
      const first = await rig().execute<SourceIngestionOutcome>(
        "sourceIngestionWorkflow",
        "wf-src-replay-1",
        mkInput("wf-src-replay-1"),
      );
      const second = await rig().execute<SourceIngestionOutcome>(
        "sourceIngestionWorkflow",
        "wf-src-replay-2",
        mkInput("wf-src-replay-2"),
      );
      expect(first.state).toBe("applied");
      expect(second.state).toBe("applied");
      expect(first.context.revisionId).toBe(second.context.revisionId);
    });

    it("(d) REAL local file → ROOT-confined transport → extractFileSource → live workflow → applied via the real gate — spec(§9)", async () => {
      // The C2 end-to-end proof: a REAL temp file under a temp root flows through the
      // real node:fs transport + the emit-only adapter into a genuine RegisterSourceInput,
      // then through the live C1 workflow where the REAL registerSource() gate accepts it.
      const captureBase = await mkdtemp(join(tmpdir(), "sow-c2-e2e-"));
      try {
        const root = join(captureBase, "root");
        await mkdir(root, { recursive: true });
        await writeFile(join(root, "captured.md"), "# Captured\nReal local file content for C2.", "utf8");

        const transport = createFileReadTransport(root);
        const candidate = await extractFileSource(
          { sourceId: "src-c2-file", workspaceId: String(SRC_WS), path: "captured.md", sensitivity: "normal" },
          transport,
        );
        expect(candidate.ok).toBe(true);
        if (!candidate.ok) return;

        // The candidate (string ids) becomes the workflow's SourceEnvelope context; the
        // workflow's registerSource leg re-gates it for real.
        const source: SourceEnvelope = {
          sourceId: sourceId(candidate.value.sourceId),
          workspaceId: workspaceId(candidate.value.workspaceId),
          origin: candidate.value.origin,
          contentHash: candidate.value.contentHash,
          type: candidate.value.type,
          sensitivity: candidate.value.sensitivity,
          routingHints: candidate.value.routingHints,
        };
        const input: SourceIngestionInput = {
          run: {
            workflowId: workflowId("wf-src-c2-file"),
            trigger: "owner_action",
            idempotencyKey: "run:src:c2:file",
            workspaceId: String(SRC_WS),
          },
          context: { source, envelopes: [] },
        };
        const outcome = await rig().execute<SourceIngestionOutcome>(
          "sourceIngestionWorkflow",
          "wf-src-c2-file",
          input,
        );
        expect(outcome.state).toBe("applied");
        expect(outcome.context.revisionId).toBeDefined();
      } finally {
        await rm(captureBase, { recursive: true, force: true });
      }
    });
  },
);
