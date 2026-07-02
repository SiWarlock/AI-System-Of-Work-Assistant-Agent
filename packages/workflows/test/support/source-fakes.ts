// task 7.7 — in-memory test doubles + builders for the source-ingestion PORTS.
//
// These fakes SATISFY the real port interfaces (src/ports/sourceIngestion.ts) so
// the PURE source-ingestion driver (src/workflows/sourceIngestion.ts) is
// Vitest-unit-testable with NO registerSource / broker / KnowledgeWriter / Tool
// Gateway / Temporal server and NO real DB. Every fake returns the EXACT typed
// Result the port declares (never throws) and is deterministic (no
// Date.now()/Math.random()). The fakes model the 7.7 safety invariants:
//   • FakeRegisterSourcePort — registered → envelope; dedupe_hit → no-op; malformed.
//   • FakeRouteSourcePort    — high binds a workspace; low → queuedForReview.
//   • FakeSourceAgentJobPort — accepted → candidate; rejected → typed admission/etc.
// The VALIDATE / BUILD-OUTPUTS / COMMIT / PROPOSE fakes are REUSED verbatim from the
// 7.6 meeting-fakes (the governance surface is shared), imported below.
import { ok, err, sourceId, workspaceId } from "@sow/contracts";
import type { Result, WorkspaceId, SourceEnvelope } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type {
  RegisterSourcePort,
  RegisterOutcome,
  RegisterError,
  RegisterErrorCode,
  RouteSourcePort,
  RouteOutcome,
  RouteError,
  RouteErrorCode,
  RunSourceAgentJobPort,
  SourceAgentFailure,
  SourceAgentFailureCode,
  IndexGbrainPort,
  IndexError,
  IndexErrorCode,
  SourceHealthSink,
  SourceWorkflowFailure,
  SourceSurfaceOutcome,
  SourceHealthSinkError,
  SourceIngestionContext,
  AgentExtraction,
} from "../../src/ports/sourceIngestion";

// Reuse the 7.6 governance fakes verbatim (validate / buildOutputs / commit /
// propose) — the derive-from-validated surface is shared across §9 workflows.
export {
  FakeValidatePort,
  FakeBuildOutputsPort,
  FakeCommitPort,
  FakeProposePort,
  makeAgentExtraction,
} from "./meeting-fakes";

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

/** Build a well-formed {@link SourceEnvelope} for tests. Pass a partial to override. */
export function makeSourceEnvelope(
  partial: Partial<SourceEnvelope> = {},
): SourceEnvelope {
  return {
    sourceId: sourceId("src-ingest-1"),
    workspaceId: workspaceId("ws-inbox"),
    origin: "https://youtube.com/watch?v=abc",
    contentHash: "hash-source-1",
    type: "youtube_video",
    sensitivity: "normal",
    routingHints: {},
    ...partial,
  };
}

/**
 * Build a pre-registration {@link SourceIngestionContext}. Defaults: a candidate
 * source, NO bound workspaceId (WS-2 — bound only after routing), empty envelopes.
 */
export function makeSourceContext(
  partial: Partial<SourceIngestionContext> = {},
): SourceIngestionContext {
  return {
    source: makeSourceEnvelope(),
    envelopes: [],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// FakeRegisterSourcePort (registered / dedupe_hit / malformed)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeRegisterSourcePort}:
 *   • `{ result: "registered", envelope? }` — mints/echoes a SourceEnvelope.
 *   • `{ result: "dedupe_hit", contentHash? }` — the contentHash is already known
 *     (a NO-OP — the driver ends without reprocessing).
 *   • `{ failWith }` — a typed register error (e.g. `malformed_source`).
 */
export type FakeRegisterConfig =
  | { result: "registered"; envelope?: SourceEnvelope }
  | { result: "dedupe_hit"; contentHash?: string }
  | { failWith: RegisterErrorCode };

export class FakeRegisterSourcePort implements RegisterSourcePort {
  readonly calls: SourceIngestionContext[] = [];
  constructor(private readonly config: FakeRegisterConfig = { result: "registered" }) {}

  register(
    ctx: SourceIngestionContext,
  ): Promise<Result<RegisterOutcome, RegisterError>> {
    this.calls.push(ctx);
    if ("failWith" in this.config) {
      const error: RegisterError = {
        code: this.config.failWith,
        message: `fake register failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    if (this.config.result === "registered") {
      const envelope = this.config.envelope ?? ctx.source;
      return Promise.resolve(ok({ outcome: "registered", envelope }));
    }
    // dedupe_hit → no-op, no source minted (Flow-4 REQ-F-010).
    const contentHash = this.config.contentHash ?? ctx.source.contentHash;
    return Promise.resolve(ok({ outcome: "dedupe_hit", contentHash }));
  }
}

// ---------------------------------------------------------------------------
// FakeRouteSourcePort (confidence high/low, or failure)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeRouteSourcePort}:
 *   • `{ confidence: "high", workspaceId, projectId? }` — binds a workspace.
 *   • `{ confidence: "low", reason? }`                  — queuedForReview, no bind.
 *   • `{ failWith }`                                    — a typed route error.
 */
export type FakeRouteConfig =
  | { confidence: "high"; workspaceId: WorkspaceId; projectId?: string }
  | { confidence: "low"; reason?: string }
  | { failWith: RouteErrorCode };

export class FakeRouteSourcePort implements RouteSourcePort {
  readonly calls: SourceIngestionContext[] = [];
  constructor(private readonly config: FakeRouteConfig) {}

  route(ctx: SourceIngestionContext): Promise<Result<RouteOutcome, RouteError>> {
    this.calls.push(ctx);
    if ("failWith" in this.config) {
      const error: RouteError = {
        code: this.config.failWith,
        message: `fake route failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    if (this.config.confidence === "high") {
      const outcome: RouteOutcome = {
        confidence: "high",
        workspaceId: this.config.workspaceId,
        ...(this.config.projectId !== undefined ? { projectId: this.config.projectId } : {}),
      };
      return Promise.resolve(ok(outcome));
    }
    // low confidence → Ingestion Inbox, NO bound workspace (never auto-routes, inv-1).
    const outcome: RouteOutcome = {
      confidence: "low",
      queuedForReview: true,
      ...(this.config.reason !== undefined ? { reason: this.config.reason } : {}),
    };
    return Promise.resolve(ok(outcome));
  }
}

// ---------------------------------------------------------------------------
// FakeSourceAgentJobPort (accepted / rejected)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeSourceAgentJobPort}: `accepted` returns a candidate
 * extraction (default {@link makeAgentExtraction} from the 7.6 fakes, or an
 * override); `rejected` returns a typed {@link SourceAgentFailure} under the given
 * code (defaults to `admission_rejected` — the ING-7 mutating-tool case).
 */
export type FakeSourceAgentConfig =
  | { result: "accepted"; extraction?: AgentExtraction }
  | { result: "rejected"; rejection?: SourceAgentFailureCode };

export class FakeSourceAgentJobPort implements RunSourceAgentJobPort {
  readonly calls: SourceIngestionContext[] = [];
  constructor(private readonly config: FakeSourceAgentConfig = { result: "accepted" }) {}

  run(
    ctx: SourceIngestionContext,
  ): Promise<Result<AgentExtraction, SourceAgentFailure>> {
    this.calls.push(ctx);
    if (this.config.result === "accepted") {
      const extraction = this.config.extraction ?? defaultExtraction();
      return Promise.resolve(ok(extraction));
    }
    const code = this.config.rejection ?? "admission_rejected";
    const failure: SourceAgentFailure = {
      code,
      message: `fake source-agent rejection: ${code}`,
    };
    return Promise.resolve(err(failure));
  }
}

/** A default candidate extraction safe under the no-inference rule (owner evidence-backed). */
function defaultExtraction(): AgentExtraction {
  return {
    fields: {
      owner: { value: "Bob", evidenceRef: "source#L12" },
      dueDate: { value: TBD },
    },
    schemaId: "sow:source-ingest-output",
  };
}

// ---------------------------------------------------------------------------
// FakeIndexGbrainPort (async, idempotent, after commit)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeIndexGbrainPort}: `failWith` forces a typed
 * {@link IndexError}; absent, index succeeds and records the revision in the
 * idempotent `indexed` set (re-indexing the same revision does not duplicate).
 */
export interface FakeIndexConfig {
  readonly failWith?: IndexErrorCode;
}

export class FakeIndexGbrainPort implements IndexGbrainPort {
  /** The set of revisions indexed (insertion order; deduped). */
  readonly indexed: string[] = [];

  constructor(private readonly config: FakeIndexConfig = {}) {}

  index(revisionId: string): Promise<Result<void, IndexError>> {
    if (this.config.failWith !== undefined) {
      const error: IndexError = {
        code: this.config.failWith,
        message: `fake index failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    if (!this.indexed.includes(revisionId)) {
      this.indexed.push(revisionId);
    }
    return Promise.resolve(ok(undefined));
  }
}

// ---------------------------------------------------------------------------
// FakeSourceHealthSink (the failure sink)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeSourceHealthSink}: `failWith` forces a typed
 * {@link SourceHealthSinkError} (to exercise the §16 "the sink itself failed"
 * path); absent, every surfaced failure is RECORDED in `surfaced` so a test can
 * assert nothing failed silently (inv-5).
 */
export interface FakeSourceHealthSinkConfig {
  readonly failWith?: SourceHealthSinkError["code"];
}

export class FakeSourceHealthSink implements SourceHealthSink {
  /** Every failure routed through the sink (proof nothing was swallowed). */
  readonly surfaced: SourceWorkflowFailure[] = [];

  constructor(private readonly config: FakeSourceHealthSinkConfig = {}) {}

  surface(
    failure: SourceWorkflowFailure,
  ): Promise<Result<SourceSurfaceOutcome, SourceHealthSinkError>> {
    if (this.config.failWith !== undefined) {
      const error: SourceHealthSinkError = {
        code: this.config.failWith,
        message: `fake source health-sink failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    this.surfaced.push(failure);
    return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
  }
}
