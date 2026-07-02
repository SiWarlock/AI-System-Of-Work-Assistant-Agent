// task 7.6 — in-memory test doubles + builders for the meeting-closeout PORTS.
//
// These fakes SATISFY the real port interfaces (src/ports/meetingCloseout.ts) so
// the PURE meeting-closeout driver (a later slice) is Vitest-unit-testable with NO
// broker / KnowledgeWriter / Tool Gateway / Temporal server and NO real DB. Every
// fake returns the EXACT typed Result the port declares (never throws) and is
// deterministic (no Date.now()/Math.random() — the foundation FakeClock injects
// time). The fakes model the 7.6 safety invariants they stand in for:
//   • FakeCorrelatePort   — high binds a workspace; low → routingReview (never guesses).
//   • FakeAgentJobPort    — accepted → candidate; rejected → typed admission/provider.
//   • FakeValidatePort    — runs the REAL domain no-inference rule; force schema-reject.
//   • FakeCommitPort      — idempotent-by-idempotencyKey (replayed:true, one write).
//   • FakeProposePort     — envelope reuse by idempotencyKey (reused, one create).
//   • FakeReindexPort     — idempotent set of reindexed revisions.
//   • FakeMeetingHealthSink — records every surfaced failure (nothing silent).
import { ok, err, sourceId, workspaceId, planId, actionId } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  KnowledgeMutationPlan,
  ProposedAction,
  ExternalWriteEnvelope,
  WriteReceipt,
} from "@sow/contracts";
import { validateNoInference, TBD } from "@sow/domain";
import type { ExtractionField } from "@sow/domain";
import type {
  CorrelatePort,
  CorrelateError,
  CorrelateErrorCode,
  CorrelationOutcome,
  RunMeetingAgentJobPort,
  MeetingAgentFailure,
  MeetingAgentFailureCode,
  ValidateExtractionPort,
  ValidationRejection,
  ValidatedExtraction,
  BuildOutputsPort,
  BuildOutputsFailure,
  BuildOutputsFailureCode,
  MeetingBuiltOutputs,
  MeetingExternalActionInput,
  CommitKnowledgePort,
  KnowledgeCommitSuccess,
  KnowledgeCommitFailure,
  KnowledgeCommitFailureCode,
  ProposeActionsPort,
  ProposeResult,
  ProposeError,
  ProposeErrorCode,
  ReindexGbrainPort,
  ReindexError,
  ReindexErrorCode,
  MeetingHealthSink,
  MeetingWorkflowFailure,
  MeetingSurfaceOutcome,
  MeetingHealthSinkError,
  MeetingCloseoutContext,
  AgentExtraction,
} from "../../src/ports/meetingCloseout";

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

/**
 * Build a well-formed pre-correlation {@link MeetingCloseoutContext}. Defaults: a
 * registered source, NO bound workspaceId (WS-2 — bound only after correlation),
 * an empty envelopes list. Pass a partial to override any field.
 */
export function makeMeetingContext(
  partial: Partial<MeetingCloseoutContext> = {},
): MeetingCloseoutContext {
  return {
    source: {
      sourceId: sourceId("src-meeting-1"),
      workspaceId: workspaceId("ws-inbox"),
      origin: "meeting://transcript/1",
      contentHash: "hash-transcript-1",
      type: "meeting_transcript",
      sensitivity: "normal",
      routingHints: {},
    },
    envelopes: [],
    ...partial,
  };
}

/**
 * Build a candidate {@link AgentExtraction}. Defaults are safe under the
 * no-inference rule (REQ-F-017): `owner` is evidence-backed, `dueDate` is the TBD
 * sentinel — so the default extraction PASSES {@link FakeValidatePort}. Pass a
 * partial (e.g. an inferred owner with no evidenceRef) to model a rejection.
 */
export function makeAgentExtraction(
  partial: Partial<AgentExtraction> = {},
): AgentExtraction {
  return {
    fields: {
      owner: { value: "Bob", evidenceRef: "transcript#L12" },
      dueDate: { value: TBD },
    },
    schemaId: "sow:meeting-close-output",
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// FakeCorrelatePort (confidence high/low)
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link FakeCorrelatePort}:
 *   • `{ confidence: "high", workspaceId, projectId? }` — binds a workspace.
 *   • `{ confidence: "low", reason? }`                  — routingReview, no bind.
 *   • `{ failWith }`                                    — a typed correlate error.
 */
export type FakeCorrelateConfig =
  | { confidence: "high"; workspaceId: WorkspaceId; projectId?: string }
  | { confidence: "low"; reason?: string }
  | { failWith: CorrelateErrorCode };

export class FakeCorrelatePort implements CorrelatePort {
  readonly calls: MeetingCloseoutContext[] = [];
  constructor(private readonly config: FakeCorrelateConfig) {}

  correlate(
    ctx: MeetingCloseoutContext,
  ): Promise<Result<CorrelationOutcome, CorrelateError>> {
    this.calls.push(ctx);
    if ("failWith" in this.config) {
      const error: CorrelateError = {
        code: this.config.failWith,
        message: `fake correlate failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    if (this.config.confidence === "high") {
      const outcome: CorrelationOutcome = {
        confidence: "high",
        workspaceId: this.config.workspaceId,
        ...(this.config.projectId !== undefined ? { projectId: this.config.projectId } : {}),
      };
      return Promise.resolve(ok(outcome));
    }
    // low confidence → routing review, NO bound workspace (never guesses, inv-1).
    const outcome: CorrelationOutcome = {
      confidence: "low",
      routingReview: true,
      ...(this.config.reason !== undefined ? { reason: this.config.reason } : {}),
    };
    return Promise.resolve(ok(outcome));
  }
}

// ---------------------------------------------------------------------------
// FakeAgentJobPort (accepted / rejected)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeAgentJobPort}: `accepted` returns a candidate extraction
 * (default {@link makeAgentExtraction}, or an override); `rejected` returns a
 * typed {@link MeetingAgentFailure} under the given code (defaults to
 * `admission_rejected` — the ING-7 mutating-tool case).
 */
export type FakeAgentJobConfig =
  | { result: "accepted"; extraction?: AgentExtraction }
  | { result: "rejected"; rejection?: MeetingAgentFailureCode };

export class FakeAgentJobPort implements RunMeetingAgentJobPort {
  readonly calls: MeetingCloseoutContext[] = [];
  constructor(private readonly config: FakeAgentJobConfig = { result: "accepted" }) {}

  run(
    ctx: MeetingCloseoutContext,
  ): Promise<Result<AgentExtraction, MeetingAgentFailure>> {
    this.calls.push(ctx);
    if (this.config.result === "accepted") {
      return Promise.resolve(ok(this.config.extraction ?? makeAgentExtraction()));
    }
    const code = this.config.rejection ?? "admission_rejected";
    const failure: MeetingAgentFailure = {
      code,
      message: `fake agent-job rejection: ${code}`,
    };
    return Promise.resolve(err(failure));
  }
}

// ---------------------------------------------------------------------------
// FakeValidatePort (valid / rejects-inferred)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeValidatePort}. By default it runs the REAL domain
 * no-inference validator (REQ-F-017) over the extraction's fields, so an inferred
 * owner/date is HARD-REJECTED authentically. `forceSchemaReject` short-circuits to
 * a `schema_rejected` rejection regardless of field content (to exercise the
 * schema-gate branch without a real ajv registry).
 */
export interface FakeValidateConfig {
  readonly forceSchemaReject?: boolean;
}

export class FakeValidatePort implements ValidateExtractionPort {
  constructor(private readonly config: FakeValidateConfig = {}) {}

  validate(
    extraction: AgentExtraction,
  ): Result<ValidatedExtraction, ValidationRejection> {
    if (this.config.forceSchemaReject === true) {
      const rejection: ValidationRejection = {
        code: "schema_rejected",
        message: "fake schema-gate rejection",
        rejections: [],
      };
      return err(rejection);
    }
    // The REAL no-inference rule (REQ-F-017): inferred owner/date or missing
    // evidence → a hard reject with the per-field rejection list.
    const noInference = validateNoInference(extraction.fields);
    if (!noInference.ok) {
      const rejection: ValidationRejection = {
        code: "no_inference_violation",
        message: "REQ-F-017: extraction carries inferred or unsupported field(s)",
        rejections: noInference.error,
      };
      return err(rejection);
    }
    const validated: ValidatedExtraction = {
      validated: true,
      fields: extraction.fields,
      ...(extraction.schemaId !== undefined ? { schemaId: extraction.schemaId } : {}),
    };
    return ok(validated);
  }
}

// ---------------------------------------------------------------------------
// FakeBuildOutputsPort (derives the plan + actions FROM the validated extraction)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeBuildOutputsPort}:
 *   • `{ failWith }`     — force a typed {@link BuildOutputsFailure} (→ the driver
 *     folds it to schema_rejected, NO partial commit).
 *   • `{ actionCount }`  — how many derived external actions to emit (default 1, so
 *     the happy path still drives the external stage exactly once). 0 ⇒ no external
 *     stage (summarize straight from knowledge_committed).
 *
 * When it succeeds it DERIVES the plan from the arguments it is given:
 *   • `plan.workspaceId` is set to the PASSED workspaceId (never a caller value) —
 *     so a test can prove the write targets the correlation-bound workspace.
 *   • the meeting-note frontmatter is populated ONLY from the VALIDATED fields
 *     (owner/date come straight off `validated.fields`) — so a test can prove the
 *     committed owner/date came from validated data, and (because validate already
 *     rejected inferred fields) an inferred value can never appear here.
 * The derived plan's planId is STABLE per (workspace + field identity) so the
 * FakeCommitPort's idempotent replay (keyed by planId) still holds across a
 * re-drive (inv-5).
 */
export interface FakeBuildOutputsConfig {
  readonly failWith?: BuildOutputsFailureCode;
  readonly actionCount?: number;
}

export class FakeBuildOutputsPort implements BuildOutputsPort {
  /** Every (validated, workspaceId) pair the driver asked to build — proof it ran. */
  readonly calls: Array<{
    readonly validated: ValidatedExtraction;
    readonly workspaceId: WorkspaceId;
  }> = [];

  constructor(private readonly config: FakeBuildOutputsConfig = {}) {}

  build(
    validated: ValidatedExtraction,
    ws: WorkspaceId,
  ): Promise<Result<MeetingBuiltOutputs, BuildOutputsFailure>> {
    this.calls.push({ validated, workspaceId: ws });
    if (this.config.failWith !== undefined) {
      const failure: BuildOutputsFailure = {
        code: this.config.failWith,
        message: `fake buildOutputs failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(failure));
    }

    // Frontmatter is DERIVED from the validated fields only (owner/date carried
    // straight through — never invented). A TBD field stays TBD (REQ-F-017).
    const fmValue = (f: ExtractionField<unknown> | undefined): unknown =>
      f === undefined ? TBD : f.value;
    const frontmatter: Record<string, unknown> = {
      owner: fmValue(validated.fields.owner),
      dueDate: fmValue(validated.fields.dueDate),
    };

    // Stable planId per (workspace + owner value) so a re-drive replays the commit.
    const stablePlanId = `plan-derived-${String(ws)}-${String(frontmatter.owner)}`;
    const plan: KnowledgeMutationPlan = {
      planId: planId(stablePlanId),
      // WS-2/WS-4: stamped from the PASSED workspace — not any caller field.
      workspaceId: ws,
      sourceRefs: [{ sourceId: sourceId("src-meeting-1") }],
      creates: [
        {
          path: `meetings/${String(ws)}/closeout.md`,
          body: "meeting closeout",
          frontmatter,
        },
      ],
      patches: [],
      linkMutations: [],
      frontmatterUpdates: [],
      externalActionProposals: [],
      confidence: 1,
      requiresApproval: false,
      provenanceOrigin: "meeting_close",
    };

    const count = this.config.actionCount ?? 1;
    const actions: MeetingExternalActionInput[] = [];
    for (let i = 0; i < count; i += 1) {
      const idem = `idem-derived-${String(ws)}-${i}`;
      const action: ProposedAction = {
        actionId: actionId(idem),
        targetSystem: "todoist",
        canonicalObjectKey: `todoist:task:${String(ws)}:${i}`,
        payload: { title: `Follow up ${i}` },
        approvalPolicy: "auto",
        idempotencyKey: idem,
      };
      const envelope: ExternalWriteEnvelope = {
        actionId: action.actionId,
        targetSystem: "todoist",
        canonicalObjectKey: action.canonicalObjectKey,
        idempotencyKey: idem,
        preconditions: ["not_exists"],
        payloadHash: `sha256:${idem}`,
      };
      actions.push({ action, envelope });
    }

    const outputs: MeetingBuiltOutputs = { plan, actions };
    return Promise.resolve(ok(outputs));
  }
}

// ---------------------------------------------------------------------------
// FakeCommitPort (ok / conflict, idempotent-by-key)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeCommitPort}: `failWith` forces a typed
 * {@link KnowledgeCommitFailure}; absent, the commit succeeds and is IDEMPOTENT by
 * the plan's idempotencyKey (a re-commit returns `replayed:true` with the same
 * revisionId — no second underlying write, tracked by `writeCount`).
 */
export interface FakeCommitConfig {
  readonly failWith?: KnowledgeCommitFailureCode;
}

export class FakeCommitPort implements CommitKnowledgePort {
  /** Number of DISTINCT underlying commits (a replay does NOT bump this). */
  writeCount = 0;
  /** revisionId minted per idempotencyKey (drives idempotent replay). */
  private readonly byKey = new Map<string, string>();

  constructor(private readonly config: FakeCommitConfig = {}) {}

  commit(
    plan: KnowledgeMutationPlan,
  ): Promise<Result<KnowledgeCommitSuccess, KnowledgeCommitFailure>> {
    if (this.config.failWith !== undefined) {
      const failure: KnowledgeCommitFailure = {
        code: this.config.failWith,
        message: `fake knowledge-commit failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(failure));
    }
    // KnowledgeMutationPlan has no top-level idempotencyKey field; the plan's
    // dedupe identity for THIS fake is the planId, so a re-commit of the SAME plan
    // replays. (The production activity derives the KnowledgeWriteCommand's
    // idempotencyKey from the plan; the fake models the observable replay property.)
    const key = commitKey(plan);
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

/** The fake's replay key for a plan: its planId (stringified) — stable per plan. */
function commitKey(plan: KnowledgeMutationPlan): string {
  return String(plan.planId);
}

// ---------------------------------------------------------------------------
// FakeProposePort (created / reused)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeProposePort}: `failWith` forces a typed
 * {@link ProposeError} (e.g. `approval_pending` — fail-closed, no write); absent,
 * the first propose CREATES the external write (a receipt is attached) and a
 * REPLAY with the same idempotencyKey REUSES the receipt (`status:'reused'`, no
 * second create — tracked by `createCount`).
 */
export interface FakeProposeConfig {
  readonly failWith?: ProposeErrorCode;
}

export class FakeProposePort implements ProposeActionsPort {
  /** Number of DISTINCT external creates (a reuse does NOT bump this). */
  createCount = 0;
  /** Receipt minted per idempotencyKey (drives envelope reuse). */
  private readonly byKey = new Map<string, WriteReceipt>();

  constructor(private readonly config: FakeProposeConfig = {}) {}

  propose(
    action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<ProposeResult, ProposeError>> {
    if (this.config.failWith !== undefined) {
      // Fail-closed: NO create happens (createCount stays put).
      const error: ProposeError = {
        code: this.config.failWith,
        message: `fake propose failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    const key = env.idempotencyKey || action.idempotencyKey;
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      // REPLAY: reuse the receipt — zero duplicate external write (inv-5).
      const result: ProposeResult = {
        status: "reused",
        envelope: { ...env, writeReceipt: existing },
      };
      return Promise.resolve(ok(result));
    }
    this.createCount += 1;
    const receipt: WriteReceipt = {
      externalObjectId: `ext-${this.createCount}`,
      recordedAt: "2026-07-01T00:00:00.000Z",
    };
    this.byKey.set(key, receipt);
    const result: ProposeResult = {
      status: "created",
      envelope: { ...env, writeReceipt: receipt },
    };
    return Promise.resolve(ok(result));
  }
}

// ---------------------------------------------------------------------------
// FakeReindexPort (async, idempotent, after commit)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeReindexPort}: `failWith` forces a typed {@link ReindexError};
 * absent, reindex succeeds and records the revision in the idempotent `reindexed`
 * set (re-indexing the same revision does not duplicate — inv-4).
 */
export interface FakeReindexConfig {
  readonly failWith?: ReindexErrorCode;
}

export class FakeReindexPort implements ReindexGbrainPort {
  /** The set of revisions reindexed (insertion order; deduped). */
  readonly reindexed: string[] = [];

  constructor(private readonly config: FakeReindexConfig = {}) {}

  reindex(revisionId: string): Promise<Result<void, ReindexError>> {
    if (this.config.failWith !== undefined) {
      const error: ReindexError = {
        code: this.config.failWith,
        message: `fake reindex failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    if (!this.reindexed.includes(revisionId)) {
      this.reindexed.push(revisionId);
    }
    return Promise.resolve(ok(undefined));
  }
}

// ---------------------------------------------------------------------------
// FakeMeetingHealthSink (the failure sink)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeMeetingHealthSink}: `failWith` forces a typed
 * {@link MeetingHealthSinkError} (to exercise the §16 "the sink itself failed"
 * path); absent, every surfaced failure is RECORDED in `surfaced` so a test can
 * assert nothing failed silently (inv-5).
 */
export interface FakeMeetingHealthSinkConfig {
  readonly failWith?: MeetingHealthSinkError["code"];
}

export class FakeMeetingHealthSink implements MeetingHealthSink {
  /** Every failure routed through the sink (proof nothing was swallowed). */
  readonly surfaced: MeetingWorkflowFailure[] = [];

  constructor(private readonly config: FakeMeetingHealthSinkConfig = {}) {}

  surface(
    failure: MeetingWorkflowFailure,
  ): Promise<Result<MeetingSurfaceOutcome, MeetingHealthSinkError>> {
    if (this.config.failWith !== undefined) {
      const error: MeetingHealthSinkError = {
        code: this.config.failWith,
        message: `fake health-sink failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    this.surfaced.push(failure);
    return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
  }
}
