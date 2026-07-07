// task 7.13 — in-memory test doubles + builders for the project-sync PORTS.
//
// These fakes SATISFY the real port interfaces (src/ports/projectSync.ts) so the
// PURE project-sync driver (src/workflows/projectSync.ts) is Vitest-unit-testable
// with NO registry / connector / broker / KnowledgeWriter / Tool Gateway / Temporal
// server and NO real DB. Every fake returns the EXACT typed Result the port declares
// (never throws) and is deterministic (no Date.now()/Math.random()). The fakes model
// the 7.13 safety invariants:
//   • FakeResolveRegistryPort  — resolved → entry (binds workspace); provider_unmapped.
//   • FakeParseProgressPort    — the DETERMINISTIC numeric source; parse/stale/ambiguous.
//   • FakeSynthesizeNarrativePort — accepted → CANDIDATE prose; rejected → typed failure.
//   • FakeBuildSyncOutputsPort — DERIVES the plan: number from the FACTS, prose from
//     the validated narrative, workspaceId from the PASSED workspace (never a caller value).
// The VALIDATE fake runs the REAL domain no-inference rule (REQ-F-017).
import { ok, err, planId, actionId, sourceId, workspaceId } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  KnowledgeMutationPlan,
  ProposedAction,
  ExternalWriteEnvelope,
} from "@sow/contracts";
import { TBD, validateNoInference } from "@sow/domain";
import type { ExtractionField } from "@sow/domain";
import type {
  ProjectSyncContext,
  ProjectRegistryEntry,
  ResolveRegistryPort,
  ResolveRegistryError,
  ResolveRegistryErrorCode,
  ParseProgressPort,
  ParseProgressError,
  ParseProgressErrorCode,
  DeterministicProgress,
  SynthesizeNarrativePort,
  ProjectSyncSynthesizeFailure,
  ProjectSyncSynthesizeFailureCode,
  ProgressNarrativeDraft,
  ValidateNarrativePort,
  ValidatedNarrative,
  NarrativeRejection,
  BuildSyncOutputsPort,
  BuildSyncOutputsFailure,
  BuildSyncOutputsFailureCode,
  ProjectSyncOutputs,
  ProjectSyncExternalAction,
  CommitStatusPort,
  StatusCommitSuccess,
  StatusCommitFailure,
  StatusCommitFailureCode,
  ProjectSyncUpdateDashboardPort,
  ProjectSyncUpdateDashboardError,
  ProjectSyncProposeActionsPort,
  ProjectSyncProposeResult,
  ProjectSyncProposeError,
  ProjectSyncProposeErrorCode,
  ProjectSyncHealthSink,
  ProjectSyncFailure,
  ProjectSyncSurfaceOutcome,
  ProjectSyncHealthSinkError,
  ProjectIdentity,
} from "../../src/ports/projectSync";

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

export const PROJECT_WS: WorkspaceId = workspaceId("ws-project-acme");

/** Build a project-sync context. Defaults: a project ref, nothing resolved yet. */
export function makeProjectSyncContext(
  partial: Partial<ProjectSyncContext> = {},
): ProjectSyncContext {
  return {
    projectRef: "acme-api",
    ...partial,
  };
}

/** Build a resolved registry entry (binds PROJECT_WS by default). */
export function makeRegistryEntry(
  partial: Partial<ProjectRegistryEntry> = {},
): ProjectRegistryEntry {
  return {
    projectId: "acme-api",
    workspaceId: PROJECT_WS,
    planPath: "employer-work/acme-api/IMPLEMENTATION_PLAN.md",
    progressProviders: [{ connectorId: "linear-1", remoteHandle: "ACME" }],
    aliases: ["acme"],
    title: "Acme API",
    slug: "employer-work/acme-api",
    lifecycleState: "active",
    ...partial,
  };
}

/** Build DETERMINISTIC progress facts (7 of 10 done → 70%). */
export function makeProgress(
  partial: Partial<DeterministicProgress> = {},
): DeterministicProgress {
  return {
    completedCount: 7,
    totalCount: 10,
    percentComplete: 70,
    perProvider: [{ source: "plan", completedCount: 7, totalCount: 10 }],
    ...partial,
  };
}

/**
 * Build a candidate narrative draft. Defaults are safe under the no-inference rule
 * (REQ-F-017): all fields are prose that is either evidence-backed or TBD. The
 * narrative carries NO numeric progress field (prose only). Pass a partial to model
 * a rejection (e.g. an inferred field with no evidenceRef).
 */
export function makeNarrativeDraft(
  partial: Partial<ProgressNarrativeDraft> = {},
): ProgressNarrativeDraft {
  return {
    fields: {
      explanation: { value: "Auth redesign underway; DB migration done.", evidenceRef: "plan#L40" },
      blockers: { value: TBD },
      nextActions: { value: "Wire the gateway.", evidenceRef: "plan#L52" },
    },
    schemaId: "sow:project-sync-output",
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// FakeResolveRegistryPort
// ---------------------------------------------------------------------------

export type FakeResolveRegistryConfig =
  | { result: "resolved"; entry?: ProjectRegistryEntry }
  | { failWith: ResolveRegistryErrorCode };

export class FakeResolveRegistryPort implements ResolveRegistryPort {
  readonly calls: ProjectSyncContext[] = [];
  constructor(private readonly config: FakeResolveRegistryConfig = { result: "resolved" }) {}

  resolve(
    ctx: ProjectSyncContext,
  ): Promise<Result<ProjectRegistryEntry, ResolveRegistryError>> {
    this.calls.push(ctx);
    if ("failWith" in this.config) {
      return Promise.resolve(
        err({ code: this.config.failWith, message: `fake registry failure: ${this.config.failWith}` }),
      );
    }
    return Promise.resolve(ok(this.config.entry ?? makeRegistryEntry()));
  }
}

// ---------------------------------------------------------------------------
// FakeParseProgressPort — the DETERMINISTIC numeric source
// ---------------------------------------------------------------------------

export type FakeParseProgressConfig =
  | { result: "parsed"; progress?: DeterministicProgress }
  | { failWith: ParseProgressErrorCode };

export class FakeParseProgressPort implements ParseProgressPort {
  readonly calls: ProjectSyncContext[] = [];
  constructor(private readonly config: FakeParseProgressConfig = { result: "parsed" }) {}

  parse(
    ctx: ProjectSyncContext,
  ): Promise<Result<DeterministicProgress, ParseProgressError>> {
    this.calls.push(ctx);
    if ("failWith" in this.config) {
      return Promise.resolve(
        err({ code: this.config.failWith, message: `fake parse failure: ${this.config.failWith}` }),
      );
    }
    return Promise.resolve(ok(this.config.progress ?? makeProgress()));
  }
}

// ---------------------------------------------------------------------------
// FakeSynthesizeNarrativePort
// ---------------------------------------------------------------------------

export type FakeSynthesizeConfig =
  | { result: "accepted"; draft?: ProgressNarrativeDraft }
  | { result: "rejected"; rejection?: ProjectSyncSynthesizeFailureCode };

export class FakeSynthesizeNarrativePort implements SynthesizeNarrativePort {
  /** Every (ctx, progress) pair the driver asked to synthesize — proof of what it saw. */
  readonly calls: Array<{ ctx: ProjectSyncContext; progress: DeterministicProgress }> = [];
  constructor(private readonly config: FakeSynthesizeConfig = { result: "accepted" }) {}

  synthesize(
    ctx: ProjectSyncContext,
    progress: DeterministicProgress,
  ): Promise<Result<ProgressNarrativeDraft, ProjectSyncSynthesizeFailure>> {
    this.calls.push({ ctx, progress });
    if (this.config.result === "accepted") {
      return Promise.resolve(ok(this.config.draft ?? makeNarrativeDraft()));
    }
    const code = this.config.rejection ?? "provider_failed";
    return Promise.resolve(err({ code, message: `fake synthesis rejection: ${code}` }));
  }
}

// ---------------------------------------------------------------------------
// FakeValidateNarrativePort — runs the REAL domain no-inference rule
// ---------------------------------------------------------------------------

export interface FakeValidateNarrativeConfig {
  readonly forceSchemaReject?: boolean;
}

export class FakeValidateNarrativePort implements ValidateNarrativePort {
  constructor(private readonly config: FakeValidateNarrativeConfig = {}) {}

  validate(
    draft: ProgressNarrativeDraft,
  ): Result<ValidatedNarrative, NarrativeRejection> {
    if (this.config.forceSchemaReject === true) {
      return err({ code: "schema_rejected", message: "fake schema-gate rejection", rejections: [] });
    }
    const noInference = validateNoInference(draft.fields);
    if (!noInference.ok) {
      return err({
        code: "no_inference_violation",
        message: "REQ-F-017: narrative carries inferred or unsupported field(s)",
        rejections: noInference.error,
      });
    }
    const validated: ValidatedNarrative = {
      validated: true,
      fields: draft.fields,
      ...(draft.schemaId !== undefined ? { schemaId: draft.schemaId } : {}),
    };
    return ok(validated);
  }
}

// ---------------------------------------------------------------------------
// FakeBuildSyncOutputsPort — DERIVES the plan (number from FACTS, prose from narrative)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeBuildSyncOutputsPort}:
 *   • `{ failWith }`     — force a typed {@link BuildSyncOutputsFailure} (→ driver
 *     folds to schema_rejected, NO partial commit).
 *   • `{ actionCount }`  — how many derived external actions to emit (default 0, so
 *     the happy path ends without the external stage). >0 drives the external stage.
 *
 * On success it DERIVES the plan from its arguments so a test can prove:
 *   • `plan.workspaceId` is the PASSED workspaceId (never a caller value) — WS-2/WS-4;
 *   • the committed numeric progress in the note frontmatter is `progress.percentComplete`
 *     (the DETERMINISTIC fact) — NEVER read from the narrative (REQ-F-011);
 *   • the prose frontmatter comes off the VALIDATED narrative fields.
 */
export interface FakeBuildSyncOutputsConfig {
  readonly failWith?: BuildSyncOutputsFailureCode;
  readonly actionCount?: number;
}

export class FakeBuildSyncOutputsPort implements BuildSyncOutputsPort {
  readonly calls: Array<{
    readonly validated: ValidatedNarrative;
    readonly progress: DeterministicProgress;
    readonly workspaceId: WorkspaceId;
    readonly identity: ProjectIdentity;
    readonly updatedAt: string;
  }> = [];

  constructor(private readonly config: FakeBuildSyncOutputsConfig = {}) {}

  build(
    validated: ValidatedNarrative,
    progress: DeterministicProgress,
    ws: WorkspaceId,
    identity: ProjectIdentity,
    updatedAt: string,
  ): Promise<Result<ProjectSyncOutputs, BuildSyncOutputsFailure>> {
    this.calls.push({ validated, progress, workspaceId: ws, identity, updatedAt });
    if (this.config.failWith !== undefined) {
      return Promise.resolve(
        err({ code: this.config.failWith, message: `fake buildSyncOutputs failure: ${this.config.failWith}` }),
      );
    }

    const proseValue = (f: ExtractionField<unknown> | undefined): unknown =>
      f === undefined ? TBD : f.value;

    // ★ REQ-F-011: the committed numeric progress comes ONLY from the DETERMINISTIC
    //   facts (`progress`), NEVER from the narrative fields.
    const frontmatter: Record<string, unknown> = {
      percentComplete: progress.percentComplete,
      completedCount: progress.completedCount,
      totalCount: progress.totalCount,
      // prose off the validated narrative
      explanation: proseValue(validated.fields.explanation),
      blockers: proseValue(validated.fields.blockers),
      nextActions: proseValue(validated.fields.nextActions),
    };

    const stablePlanId = `plan-sync-${String(ws)}`;
    const plan: KnowledgeMutationPlan = {
      planId: planId(stablePlanId),
      workspaceId: ws, // WS-2/WS-4: stamped from the PASSED workspace.
      sourceRefs: [{ sourceId: sourceId("src-plan-1") }],
      creates: [
        {
          path: `projects/${String(ws)}/status.md`,
          body: "project status",
          frontmatter,
        },
      ],
      patches: [],
      linkMutations: [],
      frontmatterUpdates: [],
      externalActionProposals: [],
      confidence: 1,
      requiresApproval: false,
      // Stay faithful to the real activity's derived-plan provenance (deterministicProgress defaults
      // project_sync since §13.5 P1 added the member) so the fake can't mask a provenance regression.
      provenanceOrigin: "project_sync",
    };

    const dashboard: Record<string, unknown> = {
      projectId: String(ws),
      percentComplete: progress.percentComplete,
    };

    const count = this.config.actionCount ?? 0;
    const actions: ProjectSyncExternalAction[] = [];
    for (let i = 0; i < count; i += 1) {
      const idem = `idem-sync-${String(ws)}-${i}`;
      const action: ProposedAction = {
        actionId: actionId(idem),
        targetSystem: "telegram",
        canonicalObjectKey: `telegram:status:${String(ws)}:${i}`,
        payload: { text: `${progress.percentComplete}% complete` },
        approvalPolicy: "auto",
        idempotencyKey: idem,
      };
      const envelope: ExternalWriteEnvelope = {
        actionId: action.actionId,
        targetSystem: "telegram",
        canonicalObjectKey: action.canonicalObjectKey,
        idempotencyKey: idem,
        preconditions: ["not_exists"],
        payloadHash: `sha256:${idem}`,
      };
      actions.push({ action, envelope });
    }

    return Promise.resolve(ok({ plan, dashboard, actions }));
  }
}

// ---------------------------------------------------------------------------
// FakeCommitStatusPort (ok / conflict, idempotent-by-planId)
// ---------------------------------------------------------------------------

export interface FakeCommitStatusConfig {
  readonly failWith?: StatusCommitFailureCode;
}

export class FakeCommitStatusPort implements CommitStatusPort {
  /** DISTINCT underlying commits (a replay does NOT bump this). */
  writeCount = 0;
  private readonly byKey = new Map<string, string>();

  constructor(private readonly config: FakeCommitStatusConfig = {}) {}

  commit(
    plan: KnowledgeMutationPlan,
  ): Promise<Result<StatusCommitSuccess, StatusCommitFailure>> {
    if (this.config.failWith !== undefined) {
      return Promise.resolve(
        err({ code: this.config.failWith, message: `fake commit failure: ${this.config.failWith}` }),
      );
    }
    const key = String(plan.planId);
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      return Promise.resolve(ok({ revisionId: existing, replayed: true }));
    }
    this.writeCount += 1;
    const revisionId = `rev-${this.writeCount}`;
    this.byKey.set(key, revisionId);
    return Promise.resolve(ok({ revisionId, replayed: false }));
  }
}

// ---------------------------------------------------------------------------
// FakeUpdateDashboardPort
// ---------------------------------------------------------------------------

export interface FakeUpdateDashboardConfig {
  readonly failWith?: ProjectSyncUpdateDashboardError["code"];
}

export class FakeUpdateDashboardPort implements ProjectSyncUpdateDashboardPort {
  readonly payloads: Array<Record<string, unknown>> = [];
  constructor(private readonly config: FakeUpdateDashboardConfig = {}) {}

  update(payload: Record<string, unknown>): Promise<Result<void, ProjectSyncUpdateDashboardError>> {
    if (this.config.failWith !== undefined) {
      return Promise.resolve(
        err({ code: this.config.failWith, message: `fake dashboard failure: ${this.config.failWith}` }),
      );
    }
    this.payloads.push(payload);
    return Promise.resolve(ok(undefined));
  }
}

// ---------------------------------------------------------------------------
// FakeProposePort (created / reused, or failure)
// ---------------------------------------------------------------------------

export type FakeProposeConfig =
  | { result?: "created" | "reused" }
  | { failWith: ProjectSyncProposeErrorCode };

export class FakeProposePort implements ProjectSyncProposeActionsPort {
  createCount = 0;
  private readonly seen = new Set<string>();
  constructor(private readonly config: FakeProposeConfig = {}) {}

  propose(
    action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<ProjectSyncProposeResult, ProjectSyncProposeError>> {
    if ("failWith" in this.config) {
      return Promise.resolve(
        err({ code: this.config.failWith, message: `fake propose failure: ${this.config.failWith}` }),
      );
    }
    // Idempotent by idempotencyKey: a replay REUSES the receipt (zero duplicate write).
    if (this.seen.has(env.idempotencyKey)) {
      return Promise.resolve(ok({ status: "reused", envelope: env }));
    }
    this.seen.add(env.idempotencyKey);
    this.createCount += 1;
    return Promise.resolve(ok({ status: "created", envelope: env }));
  }
}

// ---------------------------------------------------------------------------
// FakeProjectSyncHealthSink
// ---------------------------------------------------------------------------

export interface FakeProjectSyncHealthSinkConfig {
  readonly failWith?: ProjectSyncHealthSinkError["code"];
}

export class FakeProjectSyncHealthSink implements ProjectSyncHealthSink {
  readonly surfaced: ProjectSyncFailure[] = [];
  constructor(private readonly config: FakeProjectSyncHealthSinkConfig = {}) {}

  surface(
    failure: ProjectSyncFailure,
  ): Promise<Result<ProjectSyncSurfaceOutcome, ProjectSyncHealthSinkError>> {
    if (this.config.failWith !== undefined) {
      return Promise.resolve(
        err({ code: this.config.failWith, message: `fake health-sink failure: ${this.config.failWith}` }),
      );
    }
    this.surfaced.push(failure);
    return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
  }
}
