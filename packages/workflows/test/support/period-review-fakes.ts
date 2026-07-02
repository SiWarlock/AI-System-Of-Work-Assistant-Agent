// task 7.11 — in-memory test doubles + builders for the PERIOD-REVIEW ports.
//
// The fakes SATISFY the real port interfaces (declared in the driver
// src/workflows/periodReview.ts) so the PURE period-review driver is
// Vitest-unit-testable with NO connectors / KnowledgeWriter / Tool Gateway /
// Broker / GCL gate / Temporal server and NO real DB. Every fake returns the
// EXACT typed Result the port declares (never throws) and is deterministic (no
// Date.now()/Math.random() — the foundation FakeClock injects time). Sibling of
// the 7.10 daily-brief fakes, but PERIOD-WINDOWED: the review reasons over the
// period's meetings/decisions/commitments, the project-progress deltas, and the
// recurring-blocker detection over the window (BRF-1 — distinct from the daily
// brief). The fakes model the 7.11 safety invariants they stand in for:
//   • FakeRefreshConnectorsPort  — refreshes ids; force a stale/unreachable error.
//   • FakeUpdateProjectionsPort  — returns SANITIZED projections; force a gate reject.
//   • FakeReviewAgentPort        — accepted → candidate global+workspace review
//     drafts whose fields carry the recurring-blocker signal; rejected → typed
//     provider/egress/budget failure. The default global draft carries ONLY
//     sanitized-projection-derived text — never a raw workspace body, so a
//     leakage-safety test can assert a raw string never appears.
//   • FakeValidateReviewPort     — runs the REAL domain no-inference rule; force schema reject.
//   • FakeBuildGlobalReviewPort  — derives the GLOBAL plan + dashboard + telegram FROM validated.
//   • FakeBuildWorkspaceReviewPort — derives a per-workspace plan stamped to the bound ws.
//   • FakeCommitReviewPort       — idempotent-by-planId (replayed:true, one write).
//   • FakeUpdateDashboardPort    — records dashboard payloads; force a failure.
//   • FakeNotifyPort             — envelope reuse by idempotencyKey (reused, one create).
//   • FakePeriodReviewHealthSink — records every surfaced failure (nothing silent).
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
  PeriodReviewContext,
  ReviewWorkspaceScope,
  ReviewDraft,
  ValidatedReview,
  ReviewRefreshConnectorsPort,
  ReviewRefreshConnectorsError,
  ReviewRefreshConnectorsErrorCode,
  ReviewRefreshConnectorsResult,
  ReviewUpdateProjectionsPort,
  ReviewUpdateProjectionsError,
  ReviewUpdateProjectionsErrorCode,
  RunReviewAgentPort,
  ReviewAgentFailure,
  ReviewAgentFailureCode,
  ReviewAgentOutput,
  ValidateReviewPort,
  ReviewValidationRejection,
  BuildGlobalReviewPort,
  BuildReviewFailure,
  BuildReviewFailureCode,
  GlobalReviewOutputs,
  PeriodReviewExternalAction,
  BuildWorkspaceReviewPort,
  CommitReviewPort,
  ReviewCommitSuccess,
  ReviewCommitFailure,
  ReviewCommitFailureCode,
  ReviewUpdateDashboardPort,
  ReviewUpdateDashboardError,
  ReviewUpdateDashboardErrorCode,
  ReviewNotifyPort,
  ReviewNotifyResult,
  ReviewNotifyError,
  ReviewNotifyErrorCode,
  PeriodReviewHealthSink,
  PeriodReviewFailure,
  PeriodReviewSurfaceOutcome,
  PeriodReviewHealthSinkError,
} from "../../src/workflows/periodReview";
import type { ReviewWindow } from "../../src/activities/periodWindow";

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

/** The GLOBAL/Coordination workspace id (the run's global-review target). */
export const GLOBAL_WS = workspaceId("ws-global-coordination");

/**
 * A RAW cross-workspace body the leakage test asserts NEVER appears in the global
 * review output. Simulated employer-work raw content — it must stay behind the GCL
 * gate; only a sanitized projection may cross.
 */
export const RAW_EMPLOYER_SECRET =
  "RAW-EMPLOYER-SECRET: acme merger term-sheet $4.2M closes Friday";

/** The recurring-blocker string the review must surface (BRF-1 window signal). */
export const RECURRING_BLOCKER = "CI flakiness blocked 3 of 4 deploys this week";

/** Build a well-formed period-review context bound to the given workspaces (WS-2). */
export function makePeriodReviewContext(
  partial: Partial<PeriodReviewContext> = {},
): PeriodReviewContext {
  const scopes: ReviewWorkspaceScope[] = [
    { workspaceId: workspaceId("ws-employer"), brainId: "brain-employer" },
    { workspaceId: workspaceId("ws-personal"), brainId: "brain-personal" },
  ];
  return {
    scopes,
    ...partial,
  };
}

/**
 * Build a candidate global {@link ReviewDraft}. Defaults are safe under the
 * no-inference rule (REQ-F-017): `headline` + `recurringBlocker` evidence-backed,
 * `nextDeadline` the TBD sentinel — so the default draft PASSES
 * {@link FakeValidateReviewPort}. Crucially the default carries ONLY
 * sanitized-projection-derived text (no raw body), so the leakage-safety test can
 * assert the raw employer secret never appears. The `recurringBlocker` field is the
 * period-window signal the daily brief does not carry (BRF-1).
 */
export function makeGlobalReviewDraft(partial: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    fields: {
      headline: { value: "2 workspaces reviewed this period", evidenceRef: "gcl://projection/ws-employer" },
      recurringBlocker: { value: RECURRING_BLOCKER, evidenceRef: "gcl://projection/ws-employer#blockers" },
      progressDelta: { value: "+8 tasks closed", evidenceRef: "gcl://projection/ws-employer#delta" },
      nextDeadline: { value: TBD },
    },
    schemaId: "sow:period-review-output",
    ...partial,
  };
}

/** Build a candidate per-workspace {@link ReviewDraft} (defaults pass validation). */
export function makeWorkspaceReviewDraft(partial: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    fields: {
      headline: { value: "5 decisions, 12 commitments this period", evidenceRef: "md://ws/log#L1" },
      recurringBlocker: { value: RECURRING_BLOCKER, evidenceRef: "md://ws/log#blockers" },
      progressDelta: { value: "+8 tasks closed", evidenceRef: "md://ws/log#delta" },
      nextDeadline: { value: TBD },
    },
    schemaId: "sow:period-review-output",
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
    projectionType: "period-summary",
    sanitizedPayload: { status: "busy", closedTasks: 8, openDeadlines: 2, blockers: 1 },
    sourceRefs: [{ sourceId: sourceId("src-ws-employer-1") }],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// FakeRefreshConnectorsPort
// ---------------------------------------------------------------------------

export type FakeRefreshConnectorsConfig =
  | { refreshed?: readonly string[] }
  | { failWith: ReviewRefreshConnectorsErrorCode };

export class FakeRefreshConnectorsPort implements ReviewRefreshConnectorsPort {
  readonly calls: PeriodReviewContext[] = [];
  constructor(private readonly config: FakeRefreshConnectorsConfig = {}) {}

  refresh(
    ctx: PeriodReviewContext,
  ): Promise<Result<ReviewRefreshConnectorsResult, ReviewRefreshConnectorsError>> {
    this.calls.push(ctx);
    if ("failWith" in this.config) {
      const error: ReviewRefreshConnectorsError = {
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
  | { failWith: ReviewUpdateProjectionsErrorCode };

export class FakeUpdateProjectionsPort implements ReviewUpdateProjectionsPort {
  readonly calls: PeriodReviewContext[] = [];
  constructor(private readonly config: FakeUpdateProjectionsConfig = {}) {}

  update(
    ctx: PeriodReviewContext,
  ): Promise<Result<readonly GclProjection[], ReviewUpdateProjectionsError>> {
    this.calls.push(ctx);
    if ("failWith" in this.config) {
      const error: ReviewUpdateProjectionsError = {
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
// FakeReviewAgentPort
// ---------------------------------------------------------------------------

export type FakeReviewAgentConfig =
  | { result: "accepted"; output?: ReviewAgentOutput }
  | { result: "rejected"; rejection?: ReviewAgentFailureCode };

export class FakeReviewAgentPort implements RunReviewAgentPort {
  readonly calls: PeriodReviewContext[] = [];
  constructor(
    private readonly config: FakeReviewAgentConfig = { result: "accepted" },
  ) {}

  run(
    ctx: PeriodReviewContext,
  ): Promise<Result<ReviewAgentOutput, ReviewAgentFailure>> {
    this.calls.push(ctx);
    if (this.config.result === "accepted") {
      const output: ReviewAgentOutput =
        this.config.output ?? {
          // Global draft over sanitized projections ONLY — no raw workspace body.
          global: makeGlobalReviewDraft(),
          workspaceDrafts: {
            "ws-employer": makeWorkspaceReviewDraft(),
            "ws-personal": makeWorkspaceReviewDraft(),
          },
        };
      return Promise.resolve(ok(output));
    }
    const code = this.config.rejection ?? "provider_failed";
    const failure: ReviewAgentFailure = {
      code,
      message: `fake review-agent rejection: ${code}`,
    };
    return Promise.resolve(err(failure));
  }
}

// ---------------------------------------------------------------------------
// FakeValidateReviewPort (runs the REAL domain no-inference rule)
// ---------------------------------------------------------------------------

export interface FakeValidateReviewConfig {
  readonly forceSchemaReject?: boolean;
}

export class FakeValidateReviewPort implements ValidateReviewPort {
  constructor(private readonly config: FakeValidateReviewConfig = {}) {}

  validate(draft: ReviewDraft): Result<ValidatedReview, ReviewValidationRejection> {
    if (this.config.forceSchemaReject === true) {
      const rejection: ReviewValidationRejection = {
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
      const rejection: ReviewValidationRejection = {
        code: "no_inference_violation",
        message: "REQ-F-017: review carries inferred or unsupported field(s)",
        rejections: noInference.error,
      };
      return err(rejection);
    }
    const validated: ValidatedReview = {
      validated: true,
      fields: draft.fields,
      ...(draft.schemaId !== undefined ? { schemaId: draft.schemaId } : {}),
    };
    return ok(validated);
  }
}

// ---------------------------------------------------------------------------
// FakeBuildGlobalReviewPort (derives GLOBAL plan + dashboard + telegram)
// ---------------------------------------------------------------------------

export interface FakeBuildGlobalReviewConfig {
  readonly failWith?: BuildReviewFailureCode;
  readonly withNotify?: boolean;
}

export class FakeBuildGlobalReviewPort implements BuildGlobalReviewPort {
  readonly calls: {
    validated: ValidatedReview;
    projections: readonly GclProjection[];
    window: ReviewWindow;
    workspaceId: WorkspaceId;
  }[] = [];
  constructor(private readonly config: FakeBuildGlobalReviewConfig = {}) {}

  build(
    validated: ValidatedReview,
    projections: readonly GclProjection[],
    window: ReviewWindow,
    ws: WorkspaceId,
  ): Promise<Result<GlobalReviewOutputs, BuildReviewFailure>> {
    this.calls.push({ validated, projections, window, workspaceId: ws });
    if (this.config.failWith !== undefined) {
      const failure: BuildReviewFailure = {
        code: this.config.failWith,
        message: `fake buildGlobalReview failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(failure));
    }

    // Derive text ONLY from validated fields + sanitized projection summaries.
    const headline = String(fmValue(validated.fields.headline));
    const blocker = String(fmValue(validated.fields.recurringBlocker));
    const projectionSummary = projections
      .map((p) => `${String(p.workspaceId)}:${JSON.stringify(p.sanitizedPayload)}`)
      .join("; ");
    // The window bounds are stamped into the derived summary (period-scoped).
    const summaryLine = `[${window.windowStart}..${window.windowEnd}] ${headline} — blocker: ${blocker} — ${projectionSummary}`;

    const plan: KnowledgeMutationPlan = {
      planId: planId(`plan-review-global-${String(ws)}-${window.windowEnd}`),
      // WS-2/WS-4: stamped from the PASSED global workspace, not a caller field.
      workspaceId: ws,
      sourceRefs: [{ sourceId: sourceId("src-period-review-1") }],
      creates: [
        {
          path: `global/${String(ws)}/period-review-${window.windowEnd}.md`,
          body: summaryLine,
          frontmatter: {
            headline,
            recurringBlocker: blocker,
            windowStart: window.windowStart,
            windowEnd: window.windowEnd,
            period: window.period,
            nextDeadline: fmValue(validated.fields.nextDeadline),
          },
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
      readModelKey: "period-review:global",
      summary: summaryLine,
      recurringBlocker: blocker,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      workspaceCount: projections.length,
    };

    const withNotify = this.config.withNotify ?? true;
    const outputs: GlobalReviewOutputs = withNotify
      ? { plan, dashboard, notify: makeTelegramAction(ws, summaryLine, window.windowEnd) }
      : { plan, dashboard };
    return Promise.resolve(ok(outputs));
  }
}

/** Frontmatter-safe projection of a validated field (TBD stays TBD). */
function fmValue(f: ExtractionField<unknown> | undefined): unknown {
  return f === undefined ? TBD : f.value;
}

/** Build a deterministic Telegram summary external action for the fake. */
function makeTelegramAction(
  ws: WorkspaceId,
  summary: string,
  windowEnd: string,
): PeriodReviewExternalAction {
  const idempotencyKey = `idem-telegram-review-${String(ws)}-${windowEnd}`;
  const canonicalObjectKey = `telegram:period-review:${String(ws)}:${windowEnd}`;
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
// FakeBuildWorkspaceReviewPort (per-workspace plan stamped to the bound ws)
// ---------------------------------------------------------------------------

export interface FakeBuildWorkspaceReviewConfig {
  readonly failWith?: BuildReviewFailureCode;
}

export class FakeBuildWorkspaceReviewPort implements BuildWorkspaceReviewPort {
  readonly calls: {
    validated: ValidatedReview;
    window: ReviewWindow;
    workspaceId: WorkspaceId;
  }[] = [];
  constructor(private readonly config: FakeBuildWorkspaceReviewConfig = {}) {}

  build(
    validated: ValidatedReview,
    window: ReviewWindow,
    ws: WorkspaceId,
  ): Promise<Result<KnowledgeMutationPlan, BuildReviewFailure>> {
    this.calls.push({ validated, window, workspaceId: ws });
    if (this.config.failWith !== undefined) {
      const failure: BuildReviewFailure = {
        code: this.config.failWith,
        message: `fake buildWorkspaceReview failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(failure));
    }
    const headline = String(fmValue(validated.fields.headline));
    const blocker = String(fmValue(validated.fields.recurringBlocker));
    const plan: KnowledgeMutationPlan = {
      // Stable per (workspace + window) so re-drive replays the same commit.
      planId: planId(`plan-review-ws-${String(ws)}-${window.windowEnd}`),
      // WS-2/WS-4: stamped from the PASSED workspace — the per-workspace review
      // commits ONLY to its own workspace repo.
      workspaceId: ws,
      sourceRefs: [{ sourceId: sourceId("src-period-review-1") }],
      creates: [
        {
          path: `${String(ws)}/period-review-${window.windowEnd}.md`,
          body: `${headline} — blocker: ${blocker}`,
          frontmatter: {
            headline,
            recurringBlocker: blocker,
            windowStart: window.windowStart,
            windowEnd: window.windowEnd,
          },
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
// FakeCommitReviewPort (idempotent-by-planId)
// ---------------------------------------------------------------------------

export interface FakeCommitReviewConfig {
  readonly failWith?: ReviewCommitFailureCode;
}

export class FakeCommitReviewPort implements CommitReviewPort {
  /** Number of DISTINCT underlying commits (a replay does NOT bump this). */
  writeCount = 0;
  /** Every plan the port committed (so a test can assert derived workspaceIds). */
  readonly committedPlans: KnowledgeMutationPlan[] = [];
  private readonly byKey = new Map<string, string>();

  constructor(private readonly config: FakeCommitReviewConfig = {}) {}

  commit(
    plan: KnowledgeMutationPlan,
  ): Promise<Result<ReviewCommitSuccess, ReviewCommitFailure>> {
    if (this.config.failWith !== undefined) {
      const failure: ReviewCommitFailure = {
        code: this.config.failWith,
        message: `fake review-commit failure: ${this.config.failWith}`,
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
  readonly failWith?: ReviewUpdateDashboardErrorCode;
}

export class FakeUpdateDashboardPort implements ReviewUpdateDashboardPort {
  readonly payloads: Record<string, unknown>[] = [];
  constructor(private readonly config: FakeUpdateDashboardConfig = {}) {}

  update(payload: Record<string, unknown>): Promise<Result<void, ReviewUpdateDashboardError>> {
    if (this.config.failWith !== undefined) {
      const error: ReviewUpdateDashboardError = {
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
  readonly failWith?: ReviewNotifyErrorCode;
}

export class FakeNotifyPort implements ReviewNotifyPort {
  /** Number of DISTINCT external creates (a reuse does NOT bump this). */
  createCount = 0;
  /** Every payload sent, so a leakage test can scan the outbound summary text. */
  readonly sentPayloads: Record<string, unknown>[] = [];
  private readonly byKey = new Map<string, WriteReceipt>();

  constructor(private readonly config: FakeNotifyConfig = {}) {}

  notify(
    action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<ReviewNotifyResult, ReviewNotifyError>> {
    if (this.config.failWith !== undefined) {
      // Fail-closed: NO create happens (createCount stays put).
      const error: ReviewNotifyError = {
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
      const result: ReviewNotifyResult = {
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
    const result: ReviewNotifyResult = {
      status: "created",
      envelope: { ...env, writeReceipt: receipt },
    };
    return Promise.resolve(ok(result));
  }
}

// ---------------------------------------------------------------------------
// FakePeriodReviewHealthSink (the failure sink)
// ---------------------------------------------------------------------------

export interface FakePeriodReviewHealthSinkConfig {
  readonly failWith?: PeriodReviewHealthSinkError["code"];
}

export class FakePeriodReviewHealthSink implements PeriodReviewHealthSink {
  /** Every failure routed through the sink (proof nothing was swallowed). */
  readonly surfaced: PeriodReviewFailure[] = [];

  constructor(private readonly config: FakePeriodReviewHealthSinkConfig = {}) {}

  surface(
    failure: PeriodReviewFailure,
  ): Promise<Result<PeriodReviewSurfaceOutcome, PeriodReviewHealthSinkError>> {
    if (this.config.failWith !== undefined) {
      const error: PeriodReviewHealthSinkError = {
        code: this.config.failWith,
        message: `fake health-sink failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    this.surfaced.push(failure);
    return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
  }
}
