// task 7.10 — in-memory test doubles + builders for the DAILY-BRIEF ports.
//
// The fakes SATISFY the real port interfaces (src/ports/dailyBrief.ts) so the PURE
// daily-brief driver is Vitest-unit-testable with NO connectors / KnowledgeWriter /
// Tool Gateway / Broker / GCL gate / Temporal server and NO real DB. Every fake
// returns the EXACT typed Result the port declares (never throws) and is
// deterministic (no Date.now()/Math.random() — the foundation FakeClock injects
// time). The fakes model the 7.10 safety invariants they stand in for:
//   • FakeRefreshConnectorsPort — refreshes ids; force a stale/unreachable error.
//   • FakeUpdateProjectionsPort  — returns SANITIZED projections; force a gate reject.
//   • FakeBriefingAgentPort      — accepted → candidate global+workspace drafts;
//     rejected → typed provider/egress/budget failure. The default global draft
//     carries ONLY sanitized-projection-derived text — never a raw workspace body,
//     so a leakage-safety test can assert a raw string never appears in the global
//     brief output.
//   • FakeValidateBriefPort      — runs the REAL domain no-inference rule; force schema reject.
//   • FakeBuildGlobalBriefPort   — derives the GLOBAL plan + dashboard + telegram FROM validated.
//   • FakeBuildWorkspaceBriefPort — derives a per-workspace plan stamped to the bound ws.
//   • FakeCommitBriefPort        — idempotent-by-planId (replayed:true, one write).
//   • FakeUpdateDashboardPort    — records dashboard payloads; force a failure.
//   • FakeNotifyPort             — envelope reuse by idempotencyKey (reused, one create).
//   • FakeDailyBriefHealthSink   — records every surfaced failure (nothing silent).
import { ok, err, sourceId, workspaceId, planId, actionId } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  KnowledgeMutationPlan,
  ProposedAction,
  ExternalWriteEnvelope,
  GclProjection,
  WriteReceipt,
} from "@sow/contracts";
import { validateNoInference, TBD } from "@sow/domain";
import type { ExtractionField } from "@sow/domain";
import type {
  DailyBriefContext,
  BriefWorkspaceScope,
  BriefDraft,
  ValidatedBrief,
  RefreshConnectorsPort,
  RefreshConnectorsError,
  RefreshConnectorsErrorCode,
  RefreshConnectorsResult,
  UpdateProjectionsPort,
  UpdateProjectionsError,
  UpdateProjectionsErrorCode,
  RunBriefingAgentPort,
  BriefingAgentFailure,
  BriefingAgentFailureCode,
  BriefingAgentOutput,
  ValidateBriefPort,
  BriefValidationRejection,
  BuildGlobalBriefPort,
  BuildGlobalBriefFailure,
  BuildGlobalBriefFailureCode,
  GlobalBriefOutputs,
  DailyBriefExternalAction,
  BuildWorkspaceBriefPort,
  CommitBriefPort,
  BriefCommitSuccess,
  BriefCommitFailure,
  BriefCommitFailureCode,
  UpdateDashboardPort,
  UpdateDashboardError,
  UpdateDashboardErrorCode,
  NotifyPort,
  NotifyResult,
  NotifyError,
  NotifyErrorCode,
  DailyBriefHealthSink,
  DailyBriefFailure,
  DailyBriefSurfaceOutcome,
  DailyBriefHealthSinkError,
} from "../../src/ports/dailyBrief";

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

/** The GLOBAL/Coordination workspace id (the run's global-brief target). */
export const GLOBAL_WS = workspaceId("ws-global-coordination");

/**
 * A RAW cross-workspace body the leakage test asserts NEVER appears in the global
 * brief output. Simulated employer-work raw content — it must stay behind the GCL
 * gate; only a sanitized projection may cross.
 */
export const RAW_EMPLOYER_SECRET =
  "RAW-EMPLOYER-SECRET: acme merger term-sheet $4.2M closes Friday";

/** Build a well-formed daily-brief context bound to the given workspaces (WS-2). */
export function makeDailyBriefContext(
  partial: Partial<DailyBriefContext> = {},
): DailyBriefContext {
  const scopes: BriefWorkspaceScope[] = [
    { workspaceId: workspaceId("ws-employer"), brainId: "brain-employer" },
    { workspaceId: workspaceId("ws-personal"), brainId: "brain-personal" },
  ];
  return {
    scopes,
    ...partial,
  };
}

/**
 * Build a candidate global {@link BriefDraft}. Defaults are safe under the
 * no-inference rule (REQ-F-017): `headline` evidence-backed, `nextDeadline` the TBD
 * sentinel — so the default draft PASSES {@link FakeValidateBriefPort}. Crucially
 * the default carries ONLY sanitized-projection-derived text (no raw body), so the
 * leakage-safety test can assert the raw employer secret never appears.
 */
export function makeGlobalDraft(partial: Partial<BriefDraft> = {}): BriefDraft {
  return {
    fields: {
      headline: { value: "2 workspaces busy today", evidenceRef: "gcl://projection/ws-employer" },
      nextDeadline: { value: TBD },
    },
    schemaId: "sow:daily-brief-output",
    ...partial,
  };
}

/** Build a candidate per-workspace {@link BriefDraft} (defaults pass validation). */
export function makeWorkspaceDraft(partial: Partial<BriefDraft> = {}): BriefDraft {
  return {
    fields: {
      headline: { value: "3 tasks due", evidenceRef: "md://ws/tasks#L1" },
      nextDeadline: { value: TBD },
    },
    schemaId: "sow:daily-brief-output",
    ...partial,
  };
}

/**
 * Build a SANITIZED {@link GclProjection}. Short single-line summary values only —
 * it is the ONLY cross-workspace shape allowed to cross the gate (REQ-F-005/008).
 * It never carries a raw body.
 */
export function makeProjection(partial: Partial<GclProjection> = {}): GclProjection {
  return {
    workspaceId: workspaceId("ws-employer"),
    visibilityLevel: "coordination",
    projectionType: "daily-summary",
    sanitizedPayload: { status: "busy", openDeadlines: 2 },
    sourceRefs: [{ sourceId: sourceId("src-ws-employer-1") }],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// FakeRefreshConnectorsPort
// ---------------------------------------------------------------------------

export type FakeRefreshConnectorsConfig =
  | { refreshed?: readonly string[] }
  | { failWith: RefreshConnectorsErrorCode };

export class FakeRefreshConnectorsPort implements RefreshConnectorsPort {
  readonly calls: DailyBriefContext[] = [];
  constructor(private readonly config: FakeRefreshConnectorsConfig = {}) {}

  refresh(
    ctx: DailyBriefContext,
  ): Promise<Result<RefreshConnectorsResult, RefreshConnectorsError>> {
    this.calls.push(ctx);
    if ("failWith" in this.config) {
      const error: RefreshConnectorsError = {
        code: this.config.failWith,
        message: `fake connector-refresh failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    const refreshedConnectors = this.config.refreshed ?? ["connector-gcal", "connector-email"];
    return Promise.resolve(ok({ refreshedConnectors }));
  }
}

// ---------------------------------------------------------------------------
// FakeUpdateProjectionsPort
// ---------------------------------------------------------------------------

export type FakeUpdateProjectionsConfig =
  | { projections?: readonly GclProjection[] }
  | { failWith: UpdateProjectionsErrorCode };

export class FakeUpdateProjectionsPort implements UpdateProjectionsPort {
  readonly calls: DailyBriefContext[] = [];
  constructor(private readonly config: FakeUpdateProjectionsConfig = {}) {}

  update(
    ctx: DailyBriefContext,
  ): Promise<Result<readonly GclProjection[], UpdateProjectionsError>> {
    this.calls.push(ctx);
    if ("failWith" in this.config) {
      const error: UpdateProjectionsError = {
        code: this.config.failWith,
        message: `fake projection-update failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    const projections = this.config.projections ?? [makeProjection()];
    return Promise.resolve(ok(projections));
  }
}

// ---------------------------------------------------------------------------
// FakeBriefingAgentPort
// ---------------------------------------------------------------------------

export type FakeBriefingAgentConfig =
  | { result: "accepted"; output?: BriefingAgentOutput }
  | { result: "rejected"; rejection?: BriefingAgentFailureCode };

export class FakeBriefingAgentPort implements RunBriefingAgentPort {
  readonly calls: DailyBriefContext[] = [];
  constructor(
    private readonly config: FakeBriefingAgentConfig = { result: "accepted" },
  ) {}

  run(
    ctx: DailyBriefContext,
  ): Promise<Result<BriefingAgentOutput, BriefingAgentFailure>> {
    this.calls.push(ctx);
    if (this.config.result === "accepted") {
      const output: BriefingAgentOutput =
        this.config.output ?? {
          // Global draft over sanitized projections ONLY — no raw workspace body.
          global: makeGlobalDraft(),
          workspaceDrafts: {
            "ws-employer": makeWorkspaceDraft(),
            "ws-personal": makeWorkspaceDraft(),
          },
        };
      return Promise.resolve(ok(output));
    }
    const code = this.config.rejection ?? "provider_failed";
    const failure: BriefingAgentFailure = {
      code,
      message: `fake briefing-agent rejection: ${code}`,
    };
    return Promise.resolve(err(failure));
  }
}

// ---------------------------------------------------------------------------
// FakeValidateBriefPort (runs the REAL domain no-inference rule)
// ---------------------------------------------------------------------------

export interface FakeValidateBriefConfig {
  readonly forceSchemaReject?: boolean;
}

export class FakeValidateBriefPort implements ValidateBriefPort {
  constructor(private readonly config: FakeValidateBriefConfig = {}) {}

  validate(draft: BriefDraft): Result<ValidatedBrief, BriefValidationRejection> {
    if (this.config.forceSchemaReject === true) {
      const rejection: BriefValidationRejection = {
        code: "schema_rejected",
        message: "fake schema-gate rejection",
        rejections: [],
      };
      return err(rejection);
    }
    // REAL no-inference validator (REQ-F-017): an inferred owner/date yields the
    // per-field rejection list.
    const noInference = validateNoInference(draft.fields);
    if (!noInference.ok) {
      const rejection: BriefValidationRejection = {
        code: "no_inference_violation",
        message: "REQ-F-017: brief carries inferred or unsupported field(s)",
        rejections: noInference.error,
      };
      return err(rejection);
    }
    const validated: ValidatedBrief = {
      validated: true,
      fields: draft.fields,
      ...(draft.schemaId !== undefined ? { schemaId: draft.schemaId } : {}),
    };
    return ok(validated);
  }
}

// ---------------------------------------------------------------------------
// FakeBuildGlobalBriefPort (derives GLOBAL plan + dashboard + telegram)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeBuildGlobalBriefPort}:
 *  • `{ failWith }` — force a typed {@link BuildGlobalBriefFailure} (→ driver folds
 *    it to schema_rejected, NO partial commit).
 *  • `{ withNotify }` — whether a Telegram summary action is derived (default true).
 *
 * When it succeeds it DERIVES the outputs from the VALIDATED brief + the sanitized
 * projections:
 *  • `plan.workspaceId` is set to the PASSED globalWorkspaceId (never a caller value)
 *    — a test proves the global brief commits to the Global/Coordination repo.
 *  • the derived text comes ONLY from `validated.fields` + the sanitized
 *    projections' summary values — never a raw workspace body — so a leakage test
 *    can assert the raw employer secret never appears anywhere in the outputs.
 */
export interface FakeBuildGlobalBriefConfig {
  readonly failWith?: BuildGlobalBriefFailureCode;
  readonly withNotify?: boolean;
}

export class FakeBuildGlobalBriefPort implements BuildGlobalBriefPort {
  readonly calls: {
    validated: ValidatedBrief;
    projections: readonly GclProjection[];
    workspaceId: WorkspaceId;
  }[] = [];
  constructor(private readonly config: FakeBuildGlobalBriefConfig = {}) {}

  build(
    validated: ValidatedBrief,
    projections: readonly GclProjection[],
    ws: WorkspaceId,
  ): Promise<Result<GlobalBriefOutputs, BuildGlobalBriefFailure>> {
    this.calls.push({ validated, projections, workspaceId: ws });
    if (this.config.failWith !== undefined) {
      const failure: BuildGlobalBriefFailure = {
        code: this.config.failWith,
        message: `fake buildGlobalBrief failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(failure));
    }

    // Derive text ONLY from validated fields + sanitized projection summaries.
    const headline = String(fmValue(validated.fields.headline));
    const projectionSummary = projections
      .map((p) => `${String(p.workspaceId)}:${JSON.stringify(p.sanitizedPayload)}`)
      .join("; ");
    const summaryLine = `${headline} — ${projectionSummary}`;

    const plan: KnowledgeMutationPlan = {
      planId: planId(`plan-global-${String(ws)}-${headline}`),
      // WS-2/WS-4: stamped from the PASSED global workspace, not a caller field.
      workspaceId: ws,
      sourceRefs: [{ sourceId: sourceId("src-daily-brief-1") }],
      creates: [
        {
          path: `global/${String(ws)}/daily-brief.md`,
          body: summaryLine,
          frontmatter: { headline, nextDeadline: fmValue(validated.fields.nextDeadline) },
        },
      ],
      patches: [],
      linkMutations: [],
      frontmatterUpdates: [],
      externalActionProposals: [],
      confidence: 1,
      requiresApproval: false,
      provenanceOrigin: "ingestion",
    };

    const dashboard: Record<string, unknown> = {
      readModelKey: "daily-brief:global",
      summary: summaryLine,
      workspaceCount: projections.length,
    };

    const withNotify = this.config.withNotify ?? true;
    const outputs: GlobalBriefOutputs = withNotify
      ? { plan, dashboard, notify: makeTelegramAction(ws, summaryLine) }
      : { plan, dashboard };
    return Promise.resolve(ok(outputs));
  }
}

/** Frontmatter-safe projection of a validated field (TBD stays TBD). */
function fmValue(f: ExtractionField<unknown> | undefined): unknown {
  return f === undefined ? TBD : f.value;
}

/** Build a deterministic Telegram summary external action for the fake. */
function makeTelegramAction(ws: WorkspaceId, summary: string): DailyBriefExternalAction {
  const idempotencyKey = `idem-telegram-${String(ws)}`;
  const canonicalObjectKey = `telegram:daily-brief:${String(ws)}`;
  const action: ProposedAction = {
    actionId: actionId(idempotencyKey),
    targetSystem: "telegram",
    canonicalObjectKey,
    payload: { text: summary },
    approvalPolicy: "auto",
    idempotencyKey,
  };
  const envelope: ExternalWriteEnvelope = {
    actionId: action.actionId,
    targetSystem: "telegram",
    canonicalObjectKey,
    idempotencyKey,
    preconditions: [],
    payloadHash: `hash-${summary.length}`,
  };
  return { action, envelope };
}

// ---------------------------------------------------------------------------
// FakeBuildWorkspaceBriefPort (per-workspace plan stamped to the bound ws)
// ---------------------------------------------------------------------------

export interface FakeBuildWorkspaceBriefConfig {
  readonly failWith?: BuildGlobalBriefFailureCode;
}

export class FakeBuildWorkspaceBriefPort implements BuildWorkspaceBriefPort {
  readonly calls: { validated: ValidatedBrief; workspaceId: WorkspaceId }[] = [];
  constructor(private readonly config: FakeBuildWorkspaceBriefConfig = {}) {}

  build(
    validated: ValidatedBrief,
    ws: WorkspaceId,
  ): Promise<Result<KnowledgeMutationPlan, BuildGlobalBriefFailure>> {
    this.calls.push({ validated, workspaceId: ws });
    if (this.config.failWith !== undefined) {
      const failure: BuildGlobalBriefFailure = {
        code: this.config.failWith,
        message: `fake buildWorkspaceBrief failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(failure));
    }
    const headline = String(fmValue(validated.fields.headline));
    const plan: KnowledgeMutationPlan = {
      // Stable per (workspace + headline) so re-drive replays the same commit.
      planId: planId(`plan-ws-${String(ws)}-${headline}`),
      // WS-2/WS-4: stamped from the PASSED workspace — the per-workspace brief
      // commits ONLY to its own workspace repo.
      workspaceId: ws,
      sourceRefs: [{ sourceId: sourceId("src-daily-brief-1") }],
      creates: [
        {
          path: `${String(ws)}/daily-brief.md`,
          body: headline,
          frontmatter: { headline },
        },
      ],
      patches: [],
      linkMutations: [],
      frontmatterUpdates: [],
      externalActionProposals: [],
      confidence: 1,
      requiresApproval: false,
      provenanceOrigin: "ingestion",
    };
    return Promise.resolve(ok(plan));
  }
}

// ---------------------------------------------------------------------------
// FakeCommitBriefPort (idempotent-by-planId)
// ---------------------------------------------------------------------------

export interface FakeCommitBriefConfig {
  readonly failWith?: BriefCommitFailureCode;
}

export class FakeCommitBriefPort implements CommitBriefPort {
  /** Number of DISTINCT underlying commits (a replay does NOT bump this). */
  writeCount = 0;
  /** Every plan the port committed (so a test can assert derived workspaceIds). */
  readonly committedPlans: KnowledgeMutationPlan[] = [];
  private readonly byKey = new Map<string, string>();

  constructor(private readonly config: FakeCommitBriefConfig = {}) {}

  commit(
    plan: KnowledgeMutationPlan,
  ): Promise<Result<BriefCommitSuccess, BriefCommitFailure>> {
    if (this.config.failWith !== undefined) {
      const failure: BriefCommitFailure = {
        code: this.config.failWith,
        message: `fake brief-commit failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(failure));
    }
    this.committedPlans.push(plan);
    const key = String(plan.planId);
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      // Idempotent REPLAY: reuse the prior revision, NO second write (inv-5).
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
  readonly failWith?: UpdateDashboardErrorCode;
}

export class FakeUpdateDashboardPort implements UpdateDashboardPort {
  readonly payloads: Record<string, unknown>[] = [];
  constructor(private readonly config: FakeUpdateDashboardConfig = {}) {}

  update(payload: Record<string, unknown>): Promise<Result<void, UpdateDashboardError>> {
    if (this.config.failWith !== undefined) {
      const error: UpdateDashboardError = {
        code: this.config.failWith,
        message: `fake dashboard-update failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    this.payloads.push(payload);
    return Promise.resolve(ok(undefined));
  }
}

// ---------------------------------------------------------------------------
// FakeNotifyPort (envelope reuse by idempotencyKey)
// ---------------------------------------------------------------------------

export interface FakeNotifyConfig {
  readonly failWith?: NotifyErrorCode;
}

export class FakeNotifyPort implements NotifyPort {
  /** Number of DISTINCT external creates (a reuse does NOT bump this). */
  createCount = 0;
  /** Every payload sent, so a leakage test can scan the outbound summary text. */
  readonly sentPayloads: Record<string, unknown>[] = [];
  private readonly byKey = new Map<string, WriteReceipt>();

  constructor(private readonly config: FakeNotifyConfig = {}) {}

  notify(
    action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<NotifyResult, NotifyError>> {
    if (this.config.failWith !== undefined) {
      // Fail-closed: NO create happens (createCount stays put).
      const error: NotifyError = {
        code: this.config.failWith,
        message: `fake notify failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    this.sentPayloads.push(action.payload);
    const key = env.idempotencyKey || action.idempotencyKey;
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      // REPLAY: reuse the receipt — zero duplicate external write (inv-5).
      const result: NotifyResult = {
        status: "reused",
        envelope: { ...env, writeReceipt: existing },
      };
      return Promise.resolve(ok(result));
    }
    this.createCount += 1;
    const receipt: WriteReceipt = {
      externalObjectId: `telegram-msg-${this.createCount}`,
      recordedAt: "2026-07-01T00:00:00.000Z",
    };
    this.byKey.set(key, receipt);
    const result: NotifyResult = {
      status: "created",
      envelope: { ...env, writeReceipt: receipt },
    };
    return Promise.resolve(ok(result));
  }
}

// ---------------------------------------------------------------------------
// FakeDailyBriefHealthSink (the failure sink)
// ---------------------------------------------------------------------------

export interface FakeDailyBriefHealthSinkConfig {
  readonly failWith?: DailyBriefHealthSinkError["code"];
}

export class FakeDailyBriefHealthSink implements DailyBriefHealthSink {
  /** Every failure routed through the sink (proof nothing was swallowed). */
  readonly surfaced: DailyBriefFailure[] = [];

  constructor(private readonly config: FakeDailyBriefHealthSinkConfig = {}) {}

  surface(
    failure: DailyBriefFailure,
  ): Promise<Result<DailyBriefSurfaceOutcome, DailyBriefHealthSinkError>> {
    if (this.config.failWith !== undefined) {
      const error: DailyBriefHealthSinkError = {
        code: this.config.failWith,
        message: `fake health-sink failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    this.surfaced.push(failure);
    return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
  }
}
