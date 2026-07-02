// @sow/worker — the WORKER REGISTRATION wiring (the activity-worker side of the
// proof spine). This is the ACTIVITY-worker half of the two-layer split: it
// assembles the composition root (real backends + the bound proof-spine activities)
// and stands up the @temporalio Worker that registers BOTH the sandbox workflows
// (workflowsPath → ./workflows) AND the activities (the real-backend delegates).
//
// It is the ONLY module that touches BOTH ./composition (which opens a DB / vault /
// vendor client — forbidden in the sandbox) AND @temporalio/worker. The workflow
// sandbox (workflows.ts) imports neither, so the two halves stay cleanly separated:
// the sandbox holds only the pure drivers + activity proxies; the real I/O lives
// here, behind the registered activities the worker executes off the task queue.
//
// It closes the gap the 7.1 bootstrap left open: `bootstrapWorker` used to connect
// then DROP the connection before ever calling Worker.create. This module supplies
// the `onConnected` registration hook the bootstrap now calls on a successful
// connect — so the worker actually registers the workflows + activities and runs.
import { createRequire } from "node:module";

import type { WorkspaceId, SourceRef, WorkflowRunRef } from "@sow/contracts";
import type { KnowledgeRevisionStore, RevisionId } from "@sow/knowledge";
import type {
  AgentExtraction,
  CorrelationSignals,
  MeetingJobInputs,
} from "@sow/workflows";
import { SOW_CONTROL_PLANE_TASK_QUEUE } from "@sow/workflows/runtime/taskQueue";
import type { SowTaskQueue } from "@sow/workflows/runtime/taskQueue";

import {
  assembleBackends,
  type ProofSpineBackends,
  type BackendsConfig,
  type StubMeetingExtraction,
  type ResolvedWorkspacePolicy,
} from "../composition/backends";
import {
  buildProofSpineActivities,
  type ProofSpineActivities,
  type ProofSpineParams,
} from "../composition/buildActivities";
import type { RegisterWorkerHook, LiveConnection } from "./worker";

// The @temporalio Worker/NativeConnection types are used only in this activity-side
// module (never in the sandbox); a type-only import keeps them off the pure
// worker.ts graph while giving Worker.create full typing here.
import type {
  Worker as TemporalWorker,
  NativeConnection,
  BundleOptions,
} from "@temporalio/worker";

const require_ = createRequire(import.meta.url);

/**
 * Resolve the sandbox workflows module path for `bundleWorkflowCode` /
 * `Worker.create({ workflowsPath })`. `require.resolve` is a CommonJS construct; in
 * this ESM module it is obtained via `createRequire(import.meta.url)` (the same
 * pattern backends.ts uses to resolve @sow/db). The resolved file is the ONLY module
 * @temporalio bundles into the deterministic workflow sandbox.
 *
 * Resolution is EXTENSION-ROBUST so the SAME entrypoint works in both worlds:
 *   • compiled deployment — `require.resolve("./workflows")` finds `workflows.js`;
 *   • source tree (the bundler-purity gate + tsx dev) — Node's CJS resolver does not
 *     know `.ts`, so we fall back to the sibling `workflows.ts` next to this module
 *     (the @temporalio bundler transpiles TS itself). Either way we hand
 *     bundleWorkflowCode an absolute path to the pure sandbox module.
 */
export function proofSpineWorkflowsPath(): string {
  try {
    return require_.resolve("./workflows");
  } catch {
    // Source-tree fallback: the sibling .ts (the bundler compiles TS).
    return new URL("./workflows.ts", import.meta.url).pathname;
  }
}

/**
 * The Node built-in modules the workflow bundler must IGNORE (stub to an empty
 * module) so the sandbox bundle compiles.
 *
 * WHY: the pure drivers reach these built-ins ONLY through package-barrel
 * re-exports that are never CALLED at workflow runtime —
 *   • `node:fs`     ← @sow/contracts barrel `export *`s schema/registry.ts, whose
 *                     top-level `import { readdirSync } from "node:fs"` loads the
 *                     JSON-Schema registry. The candidate-data GATE runs in the
 *                     ACTIVITY worker, never in the sandbox, so the fs code is dead
 *                     in the workflow path.
 *   • `node:crypto` ← @sow/domain barrel `export *`s keys/idempotency-key.ts, whose
 *                     top-level `import … from "node:crypto"` hashes idempotency
 *                     keys. Every driver header pins that per-step KEYS are computed
 *                     in ACTIVITIES (node:crypto lives there) — so the crypto code is
 *                     dead in the workflow path too.
 * The Temporal bundler rejects the `node:` scheme outright, so we stub these
 * provably-unreachable built-ins. This is the sanctioned `ignoreModules` escape
 * hatch, applied IDENTICALLY on both the real-worker `Worker.create({ workflowsPath,
 * bundlerOptions })` and the integration test's `bundleWorkflowCode` so the two
 * bundles are the same.
 *
 * CARRY-FORWARD (Finding — cross-track, packages/contracts + packages/domain): a
 * workflow-safe subpath (or `sideEffects:false` + a fs-free schema-registry seam)
 * on those barrels would let a workflow import them WITHOUT dragging node:fs/crypto
 * into the graph, and this ignore list could shrink to empty. Flagged, not fixed
 * here — it is not this track's territory.
 */
// The Temporal bundler strips a leading `node:` before matching ignoreModules
// against its DISALLOWED-warning set (bundler.js: `data.request.slice("node:")`), so
// the BARE builtin names are what belong here — this dismisses the disallowed-module
// warning path. The actual empty-module SUBSTITUTION for the `node:`-scheme requests
// is done by {@link proofSpineWebpackConfigHook} below (the bundler's own
// `resolve.alias` uses bare names, which do NOT catch a `node:fs` request before
// webpack's scheme handler errors — so we alias the prefixed forms explicitly).
export const PROOF_SPINE_IGNORE_MODULES: readonly string[] = ["fs", "crypto"];

/** The subset of a resolve-data object the replacement callback rewrites. */
interface WebpackResolveData {
  request: string;
}

/** A constructor with a readable name (what we need off a webpack plugin instance). */
type NamedCtor = { readonly name: string } & (new (...args: readonly unknown[]) => unknown);

/** Read the constructor of an unknown plugin entry, when it is a named class instance. */
function pluginCtor(entry: unknown): NamedCtor | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const ctor = (entry as { constructor?: unknown }).constructor;
  return typeof ctor === "function" && typeof (ctor as NamedCtor).name === "string"
    ? (ctor as NamedCtor)
    : undefined;
}

// The stub module the bundler substitutes for the unreachable sandbox modules.
const EMPTY_BUILTIN_STUB = new URL("./emptyBuiltinStub.cjs", import.meta.url).pathname;

/**
 * The modules to STUB OUT of the workflow bundle — each pulled into the sandbox graph
 * ONLY through a package-barrel re-export and NEVER called in the workflow path:
 *   • `/^node:(fs|crypto)$/`            — the raw Node built-ins (fs via the schema
 *     registry, crypto via the idempotency-key hasher). Both run in ACTIVITIES.
 *   • the @sow/contracts schema-REGISTRY module itself — beyond its `node:fs` import
 *     it also does `new URL("../../schemas", import.meta.url)` which webpack resolves
 *     as an asset dependency and fails. The candidate-data GATE that uses the registry
 *     runs in the ACTIVITY worker, never in the sandbox, so stubbing the whole module
 *     out of the WORKFLOW bundle is sound (the activity worker loads the real one).
 */
// NormalModuleReplacementPlugin matches the REQUEST/resource string — for a barrel
// `export * from "./schema/registry"` that is the relative specifier `./schema/registry`
// (no extension), for the raw builtin it is `node:fs`/`node:crypto`. So the pattern
// matches the `schema/registry` segment with an OPTIONAL extension/boundary (catching
// both the specifier and any resolved absolute path form), plus the two builtins.
const SANDBOX_STUB_PATTERN =
  /(?:^node:(?:fs|crypto)$)|(?:schema[\\/]registry(?:\.[jt]s)?$)/;

/**
 * The webpack config hook that stubs the provably-unreachable modules
 * ({@link SANDBOX_STUB_PATTERN}) out of the workflow bundle.
 *
 * WHY A PLUGIN, NOT `resolve.alias`: webpack 5 resolves a `node:`-scheme request
 * (`node:fs`) through its scheme handler BEFORE `resolve.alias` runs, so aliasing the
 * bare `fs`/`crypto` (what the bundler's own alias does) never catches the prefixed
 * request and it errors with UnhandledSchemeError. A `NormalModuleReplacementPlugin`
 * rewrites the request to an EMPTY stub before the scheme handler — the standard
 * webpack-5 fix. We reuse the `NormalModuleReplacementPlugin` CLASS the bundler
 * already put on `config.plugins` (it always adds two), so we never import webpack.
 *
 * The stubbed modules are NEVER CALLED in the workflow path (fs/crypto/schema-gate
 * all live in ACTIVITIES), so an empty module is sound. Applied identically on both
 * bundle paths: `bundleWorkflowCode({ webpackConfigHook })` (the integration test) and
 * `Worker.create({ bundlerOptions: { webpackConfigHook } })` (the real worker).
 *
 * Typed against @temporalio's own hook signature so it drops into either seam.
 */
export const proofSpineWebpackConfigHook: NonNullable<
  BundleOptions["webpackConfigHook"]
> = (config) => {
  const plugins: unknown[] = config.plugins ?? [];
  // Find the NormalModuleReplacementPlugin class the bundler already registered.
  let nmrp: NamedCtor | undefined;
  for (const p of plugins) {
    const ctor = pluginCtor(p);
    if (ctor?.name === "NormalModuleReplacementPlugin") {
      nmrp = ctor;
      break;
    }
  }
  if (nmrp === undefined) {
    // Defensive: if the bundler ever stops adding one, leave the config untouched
    // rather than crash — the bundle error would then surface the real chain.
    return config;
  }
  const rewriteToStub = (resolveData: WebpackResolveData): void => {
    resolveData.request = EMPTY_BUILTIN_STUB;
  };
  const Replacement = nmrp as unknown as new (
    pattern: RegExp,
    fn: (data: WebpackResolveData) => void,
  ) => unknown;
  const replacement = new Replacement(SANDBOX_STUB_PATTERN, rewriteToStub);
  return { ...config, plugins: [...plugins, replacement] } as typeof config;
};

// ---------------------------------------------------------------------------
// Building the registered activities from the composition root
// ---------------------------------------------------------------------------

/**
 * The proof-spine activity object @temporalio registers, built from the real
 * backends + the flow params. This is exactly `buildProofSpineActivities` — re-
 * exposed here so the registration wiring and the integration test share ONE
 * assembly path (no divergent hand-rolled activity set).
 */
export function buildRegisteredActivities(
  backends: ProofSpineBackends,
  params: ProofSpineParams,
): ProofSpineActivities {
  return buildProofSpineActivities(backends, params);
}

// ---------------------------------------------------------------------------
// The Worker.create wiring
// ---------------------------------------------------------------------------

/** What a stood-up proof-spine worker exposes to its caller (run / stop). */
export interface ProofSpineWorker {
  /** The live @temporalio Worker (poll loop not yet started until `run`). */
  readonly worker: TemporalWorker;
  /** Run the worker until `worker.shutdown()` (or a fatal poll error). */
  run(): Promise<void>;
  /**
   * Run the worker only until `fnOrPromise` settles, then shut down (the
   * integration-test entrypoint — a workflow execute drives one run to completion).
   */
  runUntil<R>(fnOrPromise: Promise<R> | (() => Promise<R>)): Promise<R>;
  /** Request graceful shutdown of the poll loop (synchronous signal; the loop drains). */
  shutdown(): void;
}

/**
 * Create the @temporalio Worker over a live connection, registering BOTH the
 * sandbox workflows (workflowsPath → ./workflows) AND the proof-spine activities
 * (the real-backend delegates). This is the exact 1.19 wiring:
 * `Worker.create({ connection, taskQueue, workflowsPath, activities })`.
 *
 * The caller owns the connection lifetime; on the SOW_TEMPORAL live path the
 * bootstrap's `onConnected` hook passes the NativeConnection it opened. The test
 * path uses the ephemeral TestWorkflowEnvironment's `nativeConnection` + a prebuilt
 * `workflowBundle` (bundleWorkflowCode) instead of `workflowsPath` — see the
 * integration test; both register the SAME activities object.
 */
export async function createProofSpineWorker(args: {
  readonly connection: NativeConnection;
  readonly taskQueue: SowTaskQueue;
  readonly activities: ProofSpineActivities;
  readonly namespace?: string;
}): Promise<ProofSpineWorker> {
  // Import the concrete Worker only on the live path (never pulled into the sandbox).
  const { Worker } = await import("@temporalio/worker");
  const worker = await Worker.create({
    connection: args.connection,
    ...(args.namespace !== undefined ? { namespace: args.namespace } : {}),
    taskQueue: args.taskQueue,
    workflowsPath: proofSpineWorkflowsPath(),
    // Stub the provably-unreachable node:fs/node:crypto the barrels pull (see
    // PROOF_SPINE_IGNORE_MODULES + proofSpineWebpackConfigHook) so the internal
    // bundle compiles. The hook aliases the `node:`-prefixed forms to empty; the
    // ignoreModules list dismisses the disallowed-module warning path.
    bundlerOptions: {
      ignoreModules: [...PROOF_SPINE_IGNORE_MODULES],
      webpackConfigHook: proofSpineWebpackConfigHook,
    },
    // The activities object is a plain map of async fns — the shape Worker.create
    // registers. Every fn is a typed-Result delegate to a real-backend port method.
    activities: args.activities as unknown as Record<string, unknown>,
  });
  return {
    worker,
    run: () => worker.run(),
    runUntil: <R>(fnOrPromise: Promise<R> | (() => Promise<R>)) => worker.runUntil(fnOrPromise),
    shutdown: () => worker.shutdown(),
  };
}

// ---------------------------------------------------------------------------
// The ProofSpineParams factory (deployment/job identity)
// ---------------------------------------------------------------------------

/**
 * The per-job identity + policy the proof-spine flows are bound under. A real
 * deployment resolves these from the meeting.close job + the workspace posture;
 * exposed as a factory so the caller (a boot config, or the integration test)
 * supplies concrete, deterministic values.
 */
export interface ProofSpineParamsInput {
  readonly resolved: ResolvedWorkspacePolicy;
  readonly correlationSignals: CorrelationSignals;
  readonly meetingJobInputs: MeetingJobInputs;
  readonly meetingExtraction: AgentExtraction;
  readonly revisions: KnowledgeRevisionStore;
  readonly commit: {
    readonly actor: string;
    readonly sourceEventRef: string;
    readonly workflowRunRef: WorkflowRunRef;
    readonly expectedBaseRevision: RevisionId;
  };
  readonly sourceRef: SourceRef;
  readonly planIdentity: Record<string, string>;
}

/** Assemble the ProofSpineParams the composition root binds the activities under. */
export function buildProofSpineParams(input: ProofSpineParamsInput): ProofSpineParams {
  return {
    resolved: input.resolved,
    correlationSignals: input.correlationSignals,
    meetingJobInputs: input.meetingJobInputs,
    meetingExtraction: input.meetingExtraction,
    revisions: input.revisions,
    commit: input.commit,
    sourceRef: input.sourceRef,
    planIdentity: input.planIdentity,
  };
}

// ---------------------------------------------------------------------------
// The bootstrap registration hook + the live entrypoint
// ---------------------------------------------------------------------------

/**
 * Build the {@link RegisterWorkerHook} the 7.1 bootstrap calls on a successful
 * connect. It assembles the real backends, binds the proof-spine activities, creates
 * the Worker over the handed connection (registering workflows + activities), and
 * runs it until shutdown — then closes the connection. This is the wiring that makes
 * `bootstrapWorker` actually register + serve, rather than connect-and-drop.
 *
 * `params` is resolved once at boot (a deployment supplies the workspace posture +
 * job identity + the durable revision store). `backendsConfig` points the DB + vault
 * at durable paths for a real deployment (defaults to a tmpdir/in-memory for a smoke
 * boot). The stub meeting extraction is the deterministic candidate the broker maps
 * until the real model transport lands (carry-forward).
 */
export function makeProofSpineRegisterHook(args: {
  readonly params: ProofSpineParams;
  readonly backendsConfig?: BackendsConfig;
  readonly stubExtraction?: StubMeetingExtraction;
  readonly namespace?: string;
}): RegisterWorkerHook {
  return async (connection: LiveConnection, taskQueue: SowTaskQueue): Promise<void> => {
    const backends = await assembleBackends(args.backendsConfig ?? {}, args.stubExtraction);
    try {
      const activities = buildRegisteredActivities(backends, args.params);
      // The bootstrap hands a LiveConnection (structurally narrowed); the concrete
      // NativeConnection satisfies it — cast at this single seam so worker.ts stays
      // free of the @temporalio type import.
      const spine = await createProofSpineWorker({
        connection: connection as unknown as NativeConnection,
        taskQueue,
        activities,
        ...(args.namespace !== undefined ? { namespace: args.namespace } : {}),
      });
      // Serve until shutdown — the poll loop owns the process from here.
      await spine.run();
    } finally {
      backends.close();
      await connection.close();
    }
  };
}

/** The canonical proof-spine task queue (re-exported for the boot entrypoint). */
export const PROOF_SPINE_TASK_QUEUE: SowTaskQueue = SOW_CONTROL_PLANE_TASK_QUEUE;
