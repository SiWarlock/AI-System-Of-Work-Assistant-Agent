// §9.6 A2 — Copilot workspace-scoped knowledge retrieval (the READ half of the Copilot Q&A backend).
//
// Copilot answers a question from a SINGLE workspace's knowledge (§4.6, WS-8): retrieval is
// workspace-scoped and fails CLOSED on an unknown workspace — NEVER a cross-workspace read (the GCL
// Visibility Gate is the ONLY sanctioned cross-brain path, and Copilot does not use it). Retrieval
// returns CANDIDATE context — raw-ish knowledge passages + citable source refs — that stays
// WORKER-SIDE; the governed synthesis (A3) + the procedure's candidate-data gate (A4) turn it into
// the UI-safe `UiSafeCopilotAnswer`, so a raw `block` NEVER crosses to the renderer.
//
// The REAL adapter is GBrain/GCL retrieval (deferred — the app runs over stubs; a passage-serving
// read-model does not exist yet). The fixture-backed retrieval here is the honest interim (like the
// dev-provisioner), wired into `query.copilotAsk` at A4.

import {
  ok,
  err,
  isOk,
  failure,
  collapseToSummaryLine,
  UiSafeCopilotAnswerSchema,
  type Result,
  type FailureVariant,
  type UiSafeCopilotAnswer,
} from "@sow/contracts";
import type {
  AgentJob,
  AgentJobId,
  Capability,
  DataOwner,
  EgressPolicy,
  ProcessorId,
  ProviderRoute,
  WorkflowId,
  WorkspaceId,
  WorkspaceType,
} from "@sow/contracts";
import { isAllow, processorOfRoute } from "@sow/policy";
import { vetoJobEgress } from "@sow/providers";

/** A port result delivered sync (the in-memory fixture / test fake) or async (the real adapter). */
export type MaybeAsyncResult<T> = Result<T, FailureVariant> | Promise<Result<T, FailureVariant>>;

/** One retrieved source — an opaque canonical ref + a display title (maps to UiSafeCitation at A4). */
export interface RetrievedSource {
  readonly citationId: string;
  readonly title: string;
}

/**
 * Candidate context retrieved for a Copilot question — WORKER-SIDE only. `workspaceId` is the scope
 * it was retrieved FOR (the WS-8 self-check anchor); `blocks` are raw-ish knowledge passages the
 * synthesis reads (NEVER sent to the renderer); `sources` are the citable refs.
 */
export interface RetrievedContext {
  readonly workspaceId: string;
  readonly blocks: readonly string[];
  readonly sources: readonly RetrievedSource[];
}

/** The workspace-scoped Copilot retrieval port. Unknown workspace → typed err (fail-closed). */
export interface CopilotRetrievalPort {
  readonly retrieve: (workspaceId: string, question: string) => MaybeAsyncResult<RetrievedContext>;
}

/** Fail-closed err for a workspace the retrieval source doesn't recognize.
 *  Uses the codebase-wide `WORKSPACE_NOT_FOUND` cause code (readModel.ts / systemHealth) so a
 *  consumer switching on the code catches the Copilot path too. */
export function unknownWorkspace(): FailureVariant {
  return failure("validation_rejected", "workspace not found", {
    cause: { code: "WORKSPACE_NOT_FOUND" },
  });
}

/**
 * Defense-in-depth WS-8 guard the procedure (A4) applies to ANY retrieval adapter's output: the
 * returned context MUST be for the workspace we asked about. A mismatch — a buggy or malicious
 * adapter handing back FOREIGN-workspace context — fails CLOSED, so an answer is never synthesized
 * from cross-workspace content. An empty requested scope is never treated as a workspace.
 */
export function enforceRetrievalScope(
  requestedWorkspaceId: string,
  context: RetrievedContext,
): Result<RetrievedContext, FailureVariant> {
  // Narrow `context` defensively BEFORE dereferencing — the threat this guard names is an
  // untyped/malicious adapter, which could hand back null/undefined/non-object. Fail closed with a
  // typed err (§16 no-throw), never a TypeError.
  if (
    requestedWorkspaceId.length === 0 ||
    typeof context !== "object" ||
    context === null ||
    context.workspaceId !== requestedWorkspaceId
  ) {
    return err(
      failure("validation_rejected", "retrieval scope mismatch", {
        cause: { code: "RETRIEVAL_SCOPE_MISMATCH" },
      }),
    );
  }
  return ok(context);
}

/**
 * The interim fixture-backed retrieval (honest pre-GBrain stub; the real adapter is GBrain/GCL).
 * Workspace-scoped: returns the fixture context for a KNOWN workspace, else fails closed. It runs
 * its own fixtures through `enforceRetrievalScope`, so even a MIS-KEYED fixture (scoped to a
 * different workspace than its key) fails closed rather than leaking a foreign workspace's context.
 */
export function createFixtureRetrieval(
  fixtures: Readonly<Record<string, RetrievedContext>>,
): CopilotRetrievalPort {
  return {
    retrieve: (workspaceId): Result<RetrievedContext, FailureVariant> => {
      // OWN-key lookup only — a prototype-chain key ("__proto__"/"constructor"/…) must resolve to
      // "unknown workspace", never an inherited object (the `=== undefined` check alone wouldn't).
      if (!Object.hasOwn(fixtures, workspaceId)) return err(unknownWorkspace());
      const context = fixtures[workspaceId];
      if (context === undefined) return err(unknownWorkspace());
      return enforceRetrievalScope(workspaceId, context);
    },
  };
}

// ── A3 — governed synthesis (egress veto + candidate answer) ────────────────────
//
// The WRITE-of-the-answer half. Copilot READS ONLY (§4.6) — synthesis has NO side effects; it
// produces a CANDIDATE answer that A4 validates against `UiSafeCopilotAnswerSchema` (candidate-data
// gate) before serving, and any implied ACTION becomes a ProposedAction routed to Approvals (never
// a direct write). The real synthesis routes (question + retrieved context) through
// ModelProviderPort/AgentRuntimePort — deferred (the app runs over stubs); its PROSE is EVAL-tested
// (A6), not unit-tested. What IS deterministic + TDD-tested here: the Employer-Work EGRESS VETO and
// the interim stub's redact-by-type safety.

/** The candidate answer a synthesizer produces (PRE-validation). A4 gates it → UiSafeCopilotAnswer. */
export interface CandidateCopilotAnswer {
  readonly answer: readonly string[];
  readonly citations: readonly RetrievedSource[];
}

/** The governed synthesis port — turns retrieved context into a candidate answer. No side effects. */
export interface CopilotSynthesisPort {
  readonly synthesize: (
    workspaceId: string,
    question: string,
    context: RetrievedContext,
  ) => MaybeAsyncResult<CandidateCopilotAnswer>;
}

/**
 * The Employer-Work raw-content egress VETO for Copilot synthesis (safety rule 5 / hard denial #1).
 * REUSES the broker's certified composition `vetoJobEgress` (@sow/providers) — which itself
 * delegates to @sow/policy `egressVeto` (never re-implemented: OpenRouter is its own processor not
 * an OpenAI alias, a tunneled-'local' route whose endpoint is remote FAILS CLOSED, NO cloud
 * fallback) AND adds the narrow-only DEFENSE-IN-DEPTH guard ("no later gate can re-open it": a
 * widened/substituted route on an allow fails closed rather than trusting a route the veto rewrote).
 *
 * A Copilot synthesis job READS raw workspace notes, so it ALWAYS carries raw content — the guard
 * FORCES `carriesRawContent: true` so a caller can't (accidentally or maliciously) bypass the veto
 * by declaring the job carries none. Under employer-work + ack OFF the only eligible route is a
 * loopback-local provider; anything else denies (fail closed).
 */
export function guardCopilotEgress(params: {
  readonly job: AgentJob;
  readonly route: ProviderRoute;
  readonly egress: EgressPolicy;
  readonly workspace: { readonly type: WorkspaceType; readonly dataOwner: DataOwner };
}): Result<ProviderRoute, FailureVariant> {
  const job: AgentJob = { ...params.job, carriesRawContent: true };
  const decision = vetoJobEgress(job, params.route, params.egress, params.workspace);
  if (isAllow(decision)) return ok(decision.value);
  return err(
    failure("validation_rejected", "Copilot synthesis route denied by the egress veto", {
      cause: { code: decision.reason },
    }),
  );
}

// ── P1.2 egress DECISION layer: authoritative posture → route → veto → the notice ───────────

/**
 * The authoritative governance posture the egress veto reads — resolved SERVER-SIDE from a
 * workspaceId, NEVER from client input. Deliberately NARROW (exactly the veto's three inputs): a
 * synthesizer/route-selector handed a posture can't reach `providerMatrix`/`gbrainBrainId`.
 */
export interface WorkspacePosture {
  readonly type: WorkspaceType;
  readonly dataOwner: DataOwner;
  readonly egress: EgressPolicy;
}

/** Resolve the authoritative posture by workspaceId. Unknown workspace → typed err (fail closed). */
export interface WorkspacePostureResolver {
  readonly resolve: (workspaceId: string) => MaybeAsyncResult<WorkspacePosture>;
}

/**
 * Select the candidate ProviderRoute the (future real) synthesis adapter would call for a workspace.
 * The interim adapter returns a fixed LOCAL route: no `copilot.answer` capability is registered in
 * any workspace's ProviderMatrix yet (the route-selection arch gap), so a real matrix-driven resolve
 * would DENY for every workspace. Swap this adapter behind the port when the matrix entry lands.
 */
export interface EgressRouteSelector {
  readonly select: (
    workspaceId: string,
    posture: WorkspacePosture,
  ) => MaybeAsyncResult<ProviderRoute>;
}

/** The egress-veto verdict for a Copilot answer: the allowed route + the OPTIONAL Employer-Work notice. */
export interface EgressDecision {
  readonly route: ProviderRoute;
  /**
   * The processor label — PRESENT iff the allowed route EGRESSES under employer-work (the notice).
   * Branded `ProcessorId` (from the trusted `processorOfRoute` — a provider/runtime identity, never
   * raw content); it widens to `string` at the `UiSafeCopilotAnswer.egressProcessor` boundary, where
   * the strict schema re-validates it (P1.2b — that gate is load-bearing for this field).
   */
  readonly egressProcessor?: ProcessorId;
}

/**
 * Decide whether a Copilot synthesis may egress, and derive the Employer-Work notice. Runs the
 * fail-closed veto (which forces carriesRawContent), then classifies the ALLOWED route with the
 * TRUSTED `processorOfRoute` — NOT the route's own `egressClass` field: a route claiming 'local' on a
 * REMOTE endpoint still egresses, and trusting the field would MISS the notice (an under-notification
 * leak). The notice fires iff employer-work AND the allowed route egresses (a non-null processor);
 * reaching an ALLOW under those conditions already proves egress-ack is ON (else the veto denied).
 */
export function decideCopilotEgress(params: {
  readonly job: AgentJob;
  readonly route: ProviderRoute;
  readonly posture: WorkspacePosture;
}): Result<EgressDecision, FailureVariant> {
  const guarded = guardCopilotEgress({
    job: params.job,
    route: params.route,
    egress: params.posture.egress,
    workspace: { type: params.posture.type, dataOwner: params.posture.dataOwner },
  });
  if (!isOk(guarded)) return guarded; // veto DENY (e.g. employer-work + cloud + ack OFF) → fail closed
  const proc = processorOfRoute(guarded.value); // ProcessorId | null — the leak-safe egress classifier
  if (params.posture.type === "employer_work" && proc !== null) {
    return ok({ route: guarded.value, egressProcessor: proc }); // employer-work cloud egress → the notice
  }
  return ok({ route: guarded.value }); // local, OR non-employer cloud → allow, NO notice
}

/**
 * A minimal SCHEMA-VALID, read-only synthetic AgentJob for the egress veto. The veto only reads
 * `carriesRawContent` (forced true) + the audit ids; the rest just has to satisfy `AgentJobSchema`.
 * Interim `capability` "copilot.answer" (an open branded id — its ProviderMatrix route is the
 * deferred arch gap; the interim route selector returns a local route instead).
 */
export function buildCopilotJob(workspaceId: string, route: ProviderRoute): AgentJob {
  return {
    id: `job-copilot-${workspaceId}` as AgentJobId,
    workflowRunId: `wf-copilot-${workspaceId}` as WorkflowId,
    workspaceId: workspaceId as WorkspaceId,
    capability: "copilot.answer" as Capability,
    contextRefs: [{ refKind: "source", ref: "ref:copilot" }],
    outputSchemaId: "sow:ui-safe-copilot-answer",
    toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
    providerRoute: route,
    trustLevel: "trusted",
    carriesRawContent: true,
    maxRuntimeSeconds: 300,
    idempotencyKey: `idem-copilot-${workspaceId}`,
  };
}

/** The interim genuine loopback-LOCAL route the route selector defaults to (processorOfRoute → null). */
const INTERIM_LOCAL_ROUTE: ProviderRoute = {
  provider: "ollama",
  model: "llama3.1",
  endpoint: "http://127.0.0.1:11434",
  egressClass: "local",
};

/**
 * Interim posture resolver: an own-key (prototype-safe) lookup over an injected map; a miss (unknown
 * workspace, or a prototype key like "__proto__") FAILS CLOSED with WORKSPACE_NOT_FOUND (mirrors
 * `createFixtureRetrieval`). The real adapter reads `WorkspaceConfigRepository.get(workspaceId)`.
 */
export function createLocalWorkspacePosture(
  map: Record<string, WorkspacePosture>,
): WorkspacePostureResolver {
  return {
    resolve: (workspaceId): Result<WorkspacePosture, FailureVariant> => {
      if (!Object.hasOwn(map, workspaceId)) return err(unknownWorkspace());
      const p = map[workspaceId];
      if (p === undefined) return err(unknownWorkspace());
      return ok(p);
    },
  };
}

/** Interim route selector: always the genuine loopback-local route (⇒ the veto allows, no notice). */
export function createLocalRouteSelector(
  route: ProviderRoute = INTERIM_LOCAL_ROUTE,
): EgressRouteSelector {
  return { select: (_workspaceId, _posture): Result<ProviderRoute, FailureVariant> => ok(route) };
}

/**
 * The interim STUB synthesizer (honest pre-LLM state; the real synthesis through the model/runtime
 * ports is deferred — the app runs over stubs). It produces a SAFE, DETERMINISTIC candidate that
 * CITES the retrieved sources but NEVER echoes a raw `block` verbatim (the A1 redact-by-type
 * obligation) — so no raw note content can leak even in the interim. It has NO side effects.
 */
export function createStubSynthesis(): CopilotSynthesisPort {
  return {
    synthesize: (
      _workspaceId,
      _question,
      context,
    ): Result<CandidateCopilotAnswer, FailureVariant> => {
      const n = context.sources.length;
      const answer =
        n === 0
          ? ["I couldn't find anything in this workspace to answer that yet."]
          : [
              `I found ${String(n)} relevant note${n === 1 ? "" : "s"} in this workspace.`,
              "A full answer needs the language model, which isn't wired up yet — see the cited sources below.",
            ];
      // Cites the retrieved sources (opaque ref + title only); the raw `context.blocks` are read by
      // the real model but NEVER surfaced here.
      return ok({ answer, citations: context.sources });
    },
  };
}

// ── A4 — the ask orchestration + the candidate-data / UI-safe gate ──────────────
//
// `query.copilotAsk` calls `answerCopilotQuestion` behind the 8.1 auth gate. The orchestration is
// READ-ONLY (§4.6, §13) — no side effects — and fails CLOSED at every step (unknown workspace,
// scope mismatch, synthesis failure, gate rejection). The redaction/validation boundary lives HERE
// (the procedure), mirroring the sibling read procedures: the ports hand back candidate data, and
// `toUiSafeCopilotAnswer` is the ONE place a candidate becomes servable UI-safe data.

/** The Copilot ask deps — the retrieval + synthesis ports, injected (fakes in tests, interim in boot). */
export interface CopilotDeps {
  readonly retrieval: CopilotRetrievalPort;
  readonly synthesis: CopilotSynthesisPort;
}

/** The validated ask input (narrowed at the procedure boundary). */
export interface CopilotAskInput {
  readonly workspaceId: string;
  readonly question: string;
}

/**
 * The candidate-data gate (rule 2) + the WS-8 leakage gate (A1): project a CANDIDATE answer to the
 * servable `UiSafeCopilotAnswer`. Each answer block + citation TITLE is normalized through
 * `collapseToSummaryLine` (the redact-by-type SHAPE defense — single-line, ≤1024, matching the
 * write-side projectors so read/write can't drift); the OPAQUE `citationId` passes through untouched
 * so the schema's `uiSafeOpaqueRef` can REJECT a path/URL. The whole shape is then validated against
 * `UiSafeCopilotAnswerSchema` — a candidate that fails (empty answer, over-cap, leak-shaped
 * citationId/title) is REJECTED (never served), fail-closed.
 */
export function toUiSafeCopilotAnswer(
  candidate: CandidateCopilotAnswer,
): Result<UiSafeCopilotAnswer, FailureVariant> {
  const projected = {
    answer: candidate.answer.map(collapseToSummaryLine),
    citations: candidate.citations.map((c) => ({
      citationId: c.citationId,
      title: collapseToSummaryLine(c.title),
    })),
  };
  const parsed = UiSafeCopilotAnswerSchema.safeParse(projected);
  if (!parsed.success) {
    return err(
      failure("schema_rejected", "copilot answer failed the UI-safe candidate-data gate", {
        cause: { code: "COPILOT_ANSWER_REJECTED" },
      }),
    );
  }
  return ok(parsed.data);
}

/**
 * The Copilot ask orchestration (§4.6, read-only): retrieve workspace-scoped context → RE-ENFORCE
 * the WS-8 scope guard (defense-in-depth over ANY adapter) → synthesize a candidate → project +
 * validate → `UiSafeCopilotAnswer`. Any step's typed err short-circuits (fail-closed); NO side
 * effects, and an implied action would become a ProposedAction routed to Approvals — never a write.
 *
 * EGRESS NOTE (safety rule 5): the interim synthesis is a LOCAL stub (no provider, no network) → no
 * egress occurs, so no egress guard runs here. When a REAL model/runtime synthesis adapter lands (it
 * selects a provider route), it MUST call `guardCopilotEgress` at route selection with the
 * AUTHORITATIVE Workspace record's posture (type + egress policy resolved from the workspaceId,
 * NEVER client input) BEFORE any provider call — the fail-closed Employer-Work egress veto.
 */
export async function answerCopilotQuestion(
  deps: CopilotDeps,
  input: CopilotAskInput,
): Promise<Result<UiSafeCopilotAnswer, FailureVariant>> {
  const retrieved = await deps.retrieval.retrieve(input.workspaceId, input.question);
  if (!isOk(retrieved)) return retrieved;
  const scoped = enforceRetrievalScope(input.workspaceId, retrieved.value);
  if (!isOk(scoped)) return scoped;
  const candidate = await deps.synthesis.synthesize(input.workspaceId, input.question, scoped.value);
  if (!isOk(candidate)) return candidate;
  return toUiSafeCopilotAnswer(candidate.value);
}
