// @sow/worker — the VAULT FILE-WATCHER capture-trigger test (make-it-real slice C3b).
//
// The arc capstone. A real node:fs watcher on a local vault root turns a `.md`
// add/change into a captured `sourceIngestion` run: C2's ROOT-confined transport →
// extractFileSource → RegisterSourceInput → C3a's dispatchSourceIngestion
// (trigger:"connector_event") → live workflow. The watcher is workspace-BOUND by
// policy (WS-2/REQ-F-017 — never content-inferred), ROOT-confinement is
// double-guarded (watcher scope + transport read), debounced, `.md` add/change only,
// and degraded-safe (never throws; fails-closed on a down Temporal).
//
// Two tiers, mirroring C1:
//   • FAST UNIT (default suite, no Temporal): filter/binding/containment/debounce/
//     delete/degraded driven through createVaultWatchHandler with injected deps.
//   • GATED e2e (describe.skipIf(!SOW_TEMPORAL)): a REAL watcher over a temp vault +
//     the ephemeral TestWorkflowEnvironment worker — the full make-it-real proof.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { ok, workspaceId, workflowId, sourceId, auditId } from "@sow/contracts";
import type {
  WorkspaceId,
  WorkflowRunRef,
  SourceRef,
  ProviderRoute,
  AuditId,
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
import { SOW_CONTROL_PLANE_TASK_QUEUE } from "@sow/workflows/runtime/taskQueue";
import type { FileExtractTransport } from "@sow/integrations/connectors/adapters/file-source";
import { createFileReadTransport } from "@sow/integrations/connectors/adapters/file-read-transport";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client as TemporalClient } from "@temporalio/client";

import {
  dispatchSourceIngestion,
  createTemporalClientStartRun,
} from "../../src/temporal/dispatchSourceIngestion";
import {
  createVaultWatchHandler,
  startVaultWatcher,
  type VaultWatchBinding,
  type VaultDispatch,
  type CaptureOutcome,
  type WatchFactory,
  type Realpath,
} from "../../src/watch/vaultWatcher";
// 15.6 — the note-path PRODUCER + the SHARED reserved-output-subtree constant. The watcher
// excludes exactly this producer's output home so a written note can't re-fire the watcher.
import {
  deriveSourceNotePath,
  SOURCE_NOTE_SUBTREE,
} from "../../src/composition/sourceNotePath";

import { SOW_TEMPORAL } from "../support/temporalGate";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
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
const DISPATCH_AUDIT: AuditId = auditId("vault-watch:live");
const EMPTY_VAULT_REVISION = computeRevisionId(new Map());

// ── fast-unit helpers ──────────────────────────────────────────────────────────

/** A binding is workspace-BOUND by policy — content can never move it (WS-2/REQ-F-017). */
const BINDING: VaultWatchBinding = {
  vaultRoot: "/vault",
  workspaceId: "ws-emp",
  sensitivity: "confidential",
};

/** Identity realpath ⇒ every in-root relative path resolves contained. */
const identityRealpath = (p: string): Promise<string> => Promise.resolve(p);

/** A transport that always returns `ok` with the given (possibly hostile) text. */
const transportOk =
  (text: string): FileExtractTransport =>
  (req) =>
    Promise.resolve({ ok: true, file: { path: req.path, filename: req.path, text } });

/** A dispatch spy that records the input it received and reports a fresh start. */
function recordingDispatch(): { readonly calls: SourceIngestionInput[]; readonly fn: VaultDispatch } {
  const calls: SourceIngestionInput[] = [];
  const fn: VaultDispatch = (input) => {
    calls.push(input);
    return Promise.resolve(ok({ workflowId: input.run.idempotencyKey, dispatched: true, deduped: false }));
  };
  return { calls, fn };
}

// ── fast unit: filter / binding / containment / debounce / delete / degraded ────
describe("vaultWatcher — capture handler (fast unit, no Temporal)", () => {
  it("workspace_binding_from_policy_not_content — binds workspaceId/sensitivity from the policy binding, never the file — spec(§9 WS-2/REQ-F-017)", async () => {
    const { calls, fn } = recordingDispatch();
    const handler = createVaultWatchHandler(BINDING, {
      // Hostile decoy content naming a DIFFERENT workspace — must be ignored.
      transport: transportOk("# note\nworkspace: SNEAKY-OTHER\nowner: attacker\n"),
      dispatch: fn,
      realpath: identityRealpath,
    });
    const outcome = await handler.capture("note.md");
    expect(outcome.kind).toBe("dispatched");
    expect(calls).toHaveLength(1);
    const input = calls[0];
    if (input === undefined) throw new Error("expected exactly one dispatch");
    // WS-2: the captured source is scoped from the binding — never the content/path.
    expect(input.context.source.workspaceId).toBe("ws-emp");
    expect(input.context.source.sensitivity).toBe("confidential");
    expect(input.run.workspaceId).toBe("ws-emp");
    // The closed WorkflowTrigger union member for a connector capture (per the C3a finding).
    expect(input.run.trigger).toBe("connector_event");
  });

  it("symlink_escape_event_ignored — an event whose realpath escapes root is never captured/dispatched — spec(§9 ROOT-confinement)", async () => {
    const transport = vi.fn(transportOk("# should not be read"));
    const { calls, fn } = recordingDispatch();
    const dispatch = vi.fn(fn);
    const handler = createVaultWatchHandler(BINDING, {
      transport,
      dispatch,
      // The target's realpath escapes the vault root (a symlink out of root).
      realpath: (p) => Promise.resolve(p === "/vault" ? "/vault" : "/outside/evil.md"),
    });
    const outcome = await handler.capture("evil.md");
    expect(outcome).toEqual({ kind: "ignored", reason: "escapes_root" });
    // Double-guard: the watcher drops it BEFORE the transport read is ever attempted.
    expect(transport).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("delete_event_ignored — a delete/rename-away (absent realpath) never dispatches — spec(§9 add/change-only)", async () => {
    const transport = vi.fn(transportOk("# gone"));
    const { calls, fn } = recordingDispatch();
    const dispatch = vi.fn(fn);
    const handler = createVaultWatchHandler(BINDING, {
      transport,
      dispatch,
      // The file no longer exists — realpath throws ENOENT (delete / rename-away).
      realpath: (p) => {
        if (p === "/vault") return Promise.resolve("/vault");
        return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      },
    });
    const outcome = await handler.capture("removed.md");
    expect(outcome).toEqual({ kind: "ignored", reason: "absent" });
    expect(transport).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("non_markdown_event_ignored — a non-.md path is filtered out before any I/O — spec(§9 .md-only)", async () => {
    const transport = vi.fn(transportOk("data"));
    const { fn } = recordingDispatch();
    const dispatch = vi.fn(fn);
    const handler = createVaultWatchHandler(BINDING, { transport, dispatch, realpath: identityRealpath });
    const outcome = await handler.capture("notes.txt");
    expect(outcome).toEqual({ kind: "ignored", reason: "not_markdown" });
    expect(transport).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rapid_writes_debounce_to_one_dispatch — N rapid events on one path coalesce to a single dispatch — spec(§9 debounce)", async () => {
    vi.useFakeTimers();
    try {
      const dispatch = vi.fn((input: SourceIngestionInput) =>
        Promise.resolve(ok({ workflowId: input.run.idempotencyKey, dispatched: true, deduped: false })),
      );
      const handler = createVaultWatchHandler(BINDING, {
        transport: transportOk("# note\ncontent"),
        dispatch,
        realpath: identityRealpath,
        debounceMs: 50,
      });
      for (let i = 0; i < 5; i++) handler.onEvent("change", "note.md");
      await vi.advanceTimersByTimeAsync(60);
      await handler.drain();
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("degraded_temporal_never_throws — a down Temporal fails-closed with a surfaced health item, never a throw or silent drop — spec(§16 degraded-safe)", async () => {
    const healthSpy = vi.fn(() => Promise.resolve());
    // The REAL C3a dispatch with NO startRun (Temporal unavailable) → temporal_unavailable.
    const dispatch: VaultDispatch = (input) =>
      dispatchSourceIngestion(input, {
        surfaceHealth: healthSpy,
        taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE,
        auditRef: DISPATCH_AUDIT,
      });
    const handler = createVaultWatchHandler(BINDING, {
      transport: transportOk("# note\ncontent"),
      dispatch,
      realpath: identityRealpath,
    });
    // capture RESOLVING (not rejecting) is itself the §16 never-throw proof.
    const outcome = await handler.capture("note.md");
    expect(outcome.kind).toBe("dispatch_failed");
    if (outcome.kind === "dispatch_failed") expect(outcome.code).toBe("temporal_unavailable");
    // The degraded failure surfaced a §16 health item — no silent drop.
    expect(healthSpy).toHaveBeenCalledTimes(1);
  });

  it("watch_start_failure_never_crashes — a synchronous fs.watch start-throw degrades to a no-op watcher, never crashing boot — spec(§16 degraded-safe)", () => {
    const onWatchError = vi.fn();
    const throwingWatch: WatchFactory = () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, watch '/vault'"), {
        code: "ENOENT",
      });
    };
    const { fn } = recordingDispatch();
    // startVaultWatcher MUST NOT throw even though fs.watch throws synchronously.
    let watcher: ReturnType<typeof startVaultWatcher> | undefined;
    expect(() => {
      watcher = startVaultWatcher(BINDING, {
        transport: transportOk("x"),
        dispatch: fn,
        realpath: identityRealpath,
        watch: throwingWatch,
        onWatchError,
      });
    }).not.toThrow();
    expect(onWatchError).toHaveBeenCalledTimes(1);
    // The returned handle is still usable (stop is a safe no-op).
    expect(() => watcher?.stop()).not.toThrow();
  });

  it("extract_failed_surfaces_typed_outcome — an unreadable file yields a typed extract_failed, no dispatch — spec(§16 fail-closed)", async () => {
    const transport: FileExtractTransport = () =>
      Promise.resolve({ ok: false, code: "unreachable", message: "file unreachable (ENOENT)" });
    const { calls, fn } = recordingDispatch();
    const handler = createVaultWatchHandler(BINDING, { transport, dispatch: fn, realpath: identityRealpath });
    const outcome = await handler.capture("note.md");
    expect(outcome).toEqual({ kind: "extract_failed", code: "unreachable" });
    expect(calls).toHaveLength(0);
  });

  it("dedupe_key_content_versioned — the run key is src:${ws}:${contentHash}; an EDIT re-keys (re-ingests) — spec(§9 idempotency)", async () => {
    const { calls, fn } = recordingDispatch();
    const handlerV1 = createVaultWatchHandler(BINDING, { transport: transportOk("# v1"), dispatch: fn, realpath: identityRealpath });
    await handlerV1.capture("note.md");
    const handlerV2 = createVaultWatchHandler(BINDING, { transport: transportOk("# v2 edited"), dispatch: fn, realpath: identityRealpath });
    await handlerV2.capture("note.md");
    expect(calls).toHaveLength(2);
    const c0 = calls[0];
    const c1 = calls[1];
    if (c0 === undefined || c1 === undefined) throw new Error("expected two dispatches");
    // The key is workspace-scoped + content-versioned (never a random/path-only key).
    expect(c0.run.idempotencyKey.startsWith("src:ws-emp:")).toBe(true);
    expect(c1.run.idempotencyKey.startsWith("src:ws-emp:")).toBe(true);
    // An edit (new content ⇒ new hash) RE-KEYS ⇒ a fresh run, not a dedupe.
    expect(c0.run.idempotencyKey).not.toBe(c1.run.idempotencyKey);
    // The Temporal dedupe id == the run's idempotencyKey.
    expect(c0.run.workflowId).toBe(c0.run.idempotencyKey);
  });

  it("duplicate_event_dedupe_flag_surfaces — a same-content re-dispatch that Temporal dedupes surfaces deduped:true — spec(§9 idempotency)", async () => {
    let n = 0;
    const dispatch: VaultDispatch = (input) => {
      n += 1;
      return Promise.resolve(ok({ workflowId: input.run.idempotencyKey, dispatched: n === 1, deduped: n > 1 }));
    };
    const handler = createVaultWatchHandler(BINDING, { transport: transportOk("# same"), dispatch, realpath: identityRealpath });
    const first = await handler.capture("note.md");
    const second = await handler.capture("note.md");
    expect(first).toMatchObject({ kind: "dispatched", deduped: false });
    // A duplicate EVENT on unchanged content dedupes at Temporal — surfaced, not a fresh run.
    expect(second).toMatchObject({ kind: "dispatched", deduped: true });
  });

  it("root_realpath_throw_yields_redacted_error — a throwing root realpath resolves to a typed error whose message leaks no absolute path — spec(§16 never-throw + redaction)", async () => {
    const secretPath = "/Users/secret/vault";
    const realpath: Realpath = () =>
      Promise.reject(
        Object.assign(new Error(`ENOENT: no such file or directory, realpath '${secretPath}'`), {
          code: "ENOENT",
        }),
      );
    const { calls, fn } = recordingDispatch();
    const handler = createVaultWatchHandler(BINDING, { transport: transportOk("x"), dispatch: fn, realpath });
    const outcome = await handler.capture("note.md");
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      // Redaction: the absolute path is stripped, only the errno code is retained.
      expect(outcome.message).not.toContain(secretPath);
      expect(outcome.message).toContain("ENOENT");
    }
    expect(calls).toHaveLength(0);
  });
});

// ── 15.6: auto-ingest output-subtree feedback-loop guard (closes G6) ─────────────
// The watcher's `.md` OUTPUT notes are written back INTO the watched vault root
// (`sources/<ws>/<digest>.md`, per deriveSourceNotePath). Without an exclusion, every
// KnowledgeWriter-written note re-fires the watcher → an infinite write→watch→re-ingest
// loop. The guard EXCLUDES the reserved `sources/` output subtree (root-anchored,
// segment-safe) so a written note never re-dispatches — while a user's own `.md` OUTSIDE
// `sources/` is NOT over-excluded, and the `.md`-only scope is unchanged.
describe("vaultWatcher — output-subtree feedback-loop guard (15.6, fast unit)", () => {
  // A hex-shaped digest segment matching deriveSourceNotePath's output form.
  const DIGEST = "a".repeat(32);

  it("output_subtree_note_does_not_dispatch — a .md under the reserved sources/<ws>/ output subtree is excluded ⇒ 0 dispatch (feedback loop broken) BEFORE any disk read — spec(§19.2 G6)", async () => {
    const transport = vi.fn(transportOk("# a KnowledgeWriter-written ingestion note"));
    const { calls, fn } = recordingDispatch();
    const dispatch = vi.fn(fn);
    const handler = createVaultWatchHandler(BINDING, { transport, dispatch, realpath: identityRealpath });
    const outcome = await handler.capture(`sources/ws-emp/${DIGEST}.md`);
    expect(outcome).toEqual({ kind: "ignored", reason: "output_subtree" });
    // Loop broken before the transport read AND before dispatch — no resource use.
    expect(transport).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("output_subtree_onEvent_arms_no_timer_zero_dispatch — the fs.watch onEvent path also refuses an output-subtree note (no debounce timer armed; 0 dispatch across a write burst) — spec(§19.2 G6)", async () => {
    vi.useFakeTimers();
    try {
      const dispatch = vi.fn((input: SourceIngestionInput) =>
        Promise.resolve(ok({ workflowId: input.run.idempotencyKey, dispatched: true, deduped: false })),
      );
      const handler = createVaultWatchHandler(BINDING, {
        transport: transportOk("# note"),
        dispatch,
        realpath: identityRealpath,
        debounceMs: 50,
      });
      for (let i = 0; i < 5; i++) handler.onEvent("change", `sources/ws-emp/${DIGEST}.md`);
      // Pin the ACTUAL onEvent-leg behavior: no debounce timer is armed for an output-subtree
      // note. (Without this, the test would still pass on the computeOutcome guard alone, so the
      // onEvent pre-filter would be unpinned — an L15 pass-for-the-wrong-reason.)
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60);
      await handler.drain();
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("user_md_outside_output_subtree_still_dispatches — a user/source .md OUTSIDE sources/ is NOT over-excluded ⇒ still dispatches — spec(§19.2)", async () => {
    const { calls, fn } = recordingDispatch();
    const handler = createVaultWatchHandler(BINDING, {
      transport: transportOk("# a real user note"),
      dispatch: fn,
      realpath: identityRealpath,
    });
    const outcome = await handler.capture("mynotes/note.md");
    expect(outcome.kind).toBe("dispatched");
    expect(calls).toHaveLength(1);
  });

  it("exclusion_matches_real_derived_output_path — the exclusion is tied to the REAL deriveSourceNotePath output via the shared SOURCE_NOTE_SUBTREE constant (producer + watcher cannot drift) — spec(§19.2 G6)", async () => {
    const derived = deriveSourceNotePath(WS, {
      sourceId: sourceId("file:ws-emp:whatever.md"),
      contentHash: "deadbeef",
    });
    if (!derived.ok) throw new Error("expected a derived note path");
    // The producer writes under the shared reserved subtree...
    expect(derived.value.startsWith(`${SOURCE_NOTE_SUBTREE}/`)).toBe(true);
    // ...and the watcher excludes EXACTLY that real output path (no drift).
    const transport = vi.fn(transportOk("# body"));
    const { calls, fn } = recordingDispatch();
    const dispatch = vi.fn(fn);
    const handler = createVaultWatchHandler(BINDING, { transport, dispatch, realpath: identityRealpath });
    const outcome = await handler.capture(derived.value);
    expect(outcome).toEqual({ kind: "ignored", reason: "output_subtree" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("exclusion_is_root_anchored_and_separator_safe — only a root-anchored `sources/` SEGMENT is excluded; a nested user note and a same-prefix sibling still dispatch (no over-exclusion) — spec(§19.2 G6)", async () => {
    const mk = (): { calls: SourceIngestionInput[]; handler: ReturnType<typeof createVaultWatchHandler> } => {
      const { calls, fn } = recordingDispatch();
      const handler = createVaultWatchHandler(BINDING, {
        transport: transportOk("# n"),
        dispatch: fn,
        realpath: identityRealpath,
      });
      return { calls, handler };
    };
    // (a) root-anchored output note ⇒ excluded.
    const a = mk();
    expect(await a.handler.capture(`sources/ws-emp/${DIGEST}.md`)).toEqual({
      kind: "ignored",
      reason: "output_subtree",
    });
    expect(a.calls).toHaveLength(0);
    // (b) `sources` nested under a user dir is NOT the output home ⇒ dispatches.
    const b = mk();
    expect((await b.handler.capture("mynotes/sources/x.md")).kind).toBe("dispatched");
    expect(b.calls).toHaveLength(1);
    // (c) a same-prefix sibling with NO separator is NOT excluded ⇒ dispatches.
    const c = mk();
    expect((await c.handler.capture("sourcesX.md")).kind).toBe("dispatched");
    expect(c.calls).toHaveLength(1);
  });

  it("md_only_scope_precedes_output_subtree — a non-.md path (even under sources/) stays ignored as not_markdown; the existing .md-only scope is unchanged — spec(§19.2 .md-only)", async () => {
    const { fn } = recordingDispatch();
    const handler = createVaultWatchHandler(BINDING, {
      transport: transportOk("data"),
      dispatch: fn,
      realpath: identityRealpath,
    });
    expect(await handler.capture(`sources/ws-emp/${DIGEST}.txt`)).toEqual({
      kind: "ignored",
      reason: "not_markdown",
    });
  });
});

// ── meeting + source fixtures for the gated rig (mirrors C1) ────────────────────
const localRoute = (endpoint: string): ProviderRoute =>
  ({ provider: "ollama", model: "local-default", endpoint, egressClass: "local" }) as unknown as ProviderRoute;

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
  fields: { title: { value: "Weekly Sync", evidenceRef: "src:1#0" } },
};

const meetingSourceRef: SourceRef = { sourceId: sourceId("src-1") };

const sourceExtraction: AgentExtraction = {
  fields: { owner: { value: "Bob", evidenceRef: "source#L12" }, dueDate: { value: TBD } },
  schemaId: "sow:source-ingest-output",
};

const sourceIngestSourceRef: SourceRef = { sourceId: sourceId("src-ingest-1") };

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

// ── one ephemeral Temporal env + one long-lived worker for the gated tier ───────
interface SharedRig {
  readonly backends: ProofSpineBackends;
  readonly client: TemporalClient;
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

  sharedRig = { backends, client: env.client };
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

// ── gated e2e: the full make-it-real capstone ───────────────────────────────────
describe.skipIf(!SOW_TEMPORAL)("vaultWatcher — live end-to-end over a real Temporal worker", () => {
  it("md_change_captures_and_dispatches — a .md write under the vault root auto-captures → dispatches (connector_event) → the run reaches applied — spec(§9)", async () => {
    const vaultBase = await mkdtemp(join(tmpdir(), "sow-c3b-e2e-"));
    try {
      const root = join(vaultBase, "vault");
      await mkdir(root, { recursive: true });

      let settle: ((o: CaptureOutcome) => void) | undefined;
      const firstCapture = new Promise<CaptureOutcome>((r) => {
        settle = r;
      });

      const transport = createFileReadTransport(root);
      const startRun = createTemporalClientStartRun(rig().client);
      const dispatch: VaultDispatch = (input) =>
        dispatchSourceIngestion(input, {
          startRun,
          surfaceHealth: () => Promise.resolve(),
          taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE,
          auditRef: DISPATCH_AUDIT,
        });

      const watcher = startVaultWatcher(
        { vaultRoot: root, workspaceId: String(SRC_WS), sensitivity: "normal" },
        {
          transport,
          dispatch,
          debounceMs: 50,
          onCapture: (o) => {
            if (settle !== undefined) {
              const done = settle;
              settle = undefined;
              done(o);
            }
          },
        },
      );
      try {
        await writeFile(join(root, "captured.md"), "# Captured\nReal local vault note for C3b.\n", "utf8");
        const outcome = await firstCapture;
        expect(outcome.kind).toBe("dispatched");
        if (outcome.kind !== "dispatched") return;
        const wf = (await rig()
          .client.workflow.getHandle(outcome.workflowId)
          .result()) as SourceIngestionOutcome;
        expect(wf.state).toBe("applied");
        expect(wf.context.workspaceId).toBe(String(SRC_WS));
      } finally {
        watcher.stop();
      }
    } finally {
      await rm(vaultBase, { recursive: true, force: true });
    }
  }, 30_000);
});
