// task 7.8 — in-memory test doubles + builders for the ingestion-triage PORTS.
//
// These fakes SATISFY the real port interfaces (src/ports/ingestionTriage.ts) so
// the PURE triage driver (src/workflows/ingestionTriage.ts) is Vitest-unit-testable
// with NO operational store / 7.7 re-entry adapter / Temporal server and NO real
// DB. Every fake returns the EXACT typed Result the port declares (never throws) and
// is deterministic (no Date.now()/Math.random()). The fakes model the 7.8 safety
// invariants:
//   • FakeRecordDispositionPort — EXACTLY-ONCE by a stable disposition key; a
//     re-submit of the SAME disposition OR the converging second channel is a no-op
//     reusing the prior auditRef (inv-A/inv-B). A SHARED instance across two drives
//     models the durable operational store.
//   • FakeRescopeSourcePort — applies the routing override to the parked source,
//     preserving contentHash (inv-C/inv-D).
//   • FakeReenterIngestionPort — records the (source, idempotencyKey) it re-entered
//     with, so a test can prove the SAME key is reused (inv-D); models 7.7's
//     resolveRun reuse by returning runReused=true on the 2nd identical key.
//   • FakeTriageHealthSink — records every surfaced failure (nothing silent).
import { ok, err, auditId, sourceId, workspaceId } from "@sow/contracts";
import type { Result, WorkspaceId, SourceEnvelope, AuditId } from "@sow/contracts";
import type {
  TriageChannel,
  TriageDisposition,
  RecordDispositionPort,
  RecordDispositionOutcome,
  RecordDispositionError,
  RecordDispositionErrorCode,
  RescopeSourcePort,
  RescopeError,
  RescopeErrorCode,
  ReenterIngestionPort,
  ReenterOutcome,
  ReenterError,
  ReenterErrorCode,
  TriageHealthSink,
  TriageWorkflowFailure,
  TriageSurfaceOutcome,
  TriageHealthSinkError,
  IngestionTriageContext,
} from "../../src/ports/ingestionTriage";

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

/** Build a parked {@link SourceEnvelope} (the inbox row). Pass a partial to override. */
export function makeParkedSource(partial: Partial<SourceEnvelope> = {}): SourceEnvelope {
  return {
    sourceId: sourceId("src-parked-1"),
    // A parked source was registered under an INBOX workspace pending triage — it is
    // NOT yet bound to a real workspace; the owner's override does that.
    workspaceId: workspaceId("ws-inbox"),
    origin: "https://youtube.com/watch?v=parked",
    contentHash: "hash-parked-1",
    type: "youtube_video",
    sensitivity: "normal",
    routingHints: {},
    ...partial,
  };
}

/** Build an owner {@link TriageDisposition}. Defaults bind ws-employer from Mac. */
export function makeDisposition(
  partial: Partial<TriageDisposition> = {},
): TriageDisposition {
  return {
    sourceId: "src-parked-1",
    workspaceId: workspaceId("ws-employer"),
    channel: "mac" as TriageChannel,
    ...partial,
  };
}

/** Build a triage pipeline context from a disposition. */
export function makeTriageContext(
  partial: Partial<IngestionTriageContext> = {},
): IngestionTriageContext {
  return {
    disposition: makeDisposition(),
    ...partial,
  };
}

/**
 * The stable disposition key the FAKE record port keys idempotency on. Mirrors the
 * production activity's key: (sourceId + routing fields) — deliberately CHANNEL-FREE
 * so Mac + Telegram of the SAME disposition converge (inv-B).
 */
export function dispositionKeyOf(d: TriageDisposition): string {
  return [
    d.sourceId,
    String(d.workspaceId),
    d.projectId ?? "",
    d.sensitivity ?? "",
  ].join("|");
}

// ---------------------------------------------------------------------------
// FakeRecordDispositionPort (exactly-once by a channel-free key)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeRecordDispositionPort}: `failWith` forces a typed
 * {@link RecordDispositionError}; absent, the FIRST record for a disposition key
 * mints a fresh auditRef (`recorded`), and every subsequent record for the SAME key
 * — a re-submit OR the converging other channel — is a `noop` reusing that auditRef.
 */
export interface FakeRecordDispositionConfig {
  readonly failWith?: RecordDispositionErrorCode;
}

export class FakeRecordDispositionPort implements RecordDispositionPort {
  /** Number of DISTINCT records minted (a no-op does NOT bump this) — inv-A/inv-B. */
  recordCount = 0;
  /** The disposition keys + channels recorded (proof of convergence). */
  readonly calls: Array<{ key: string; channel: TriageChannel }> = [];
  private readonly byKey = new Map<string, AuditId>();

  constructor(private readonly config: FakeRecordDispositionConfig = {}) {}

  record(
    disposition: TriageDisposition,
  ): Promise<Result<RecordDispositionOutcome, RecordDispositionError>> {
    if (this.config.failWith !== undefined) {
      const error: RecordDispositionError = {
        code: this.config.failWith,
        message: `fake record failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    const key = dispositionKeyOf(disposition);
    this.calls.push({ key, channel: disposition.channel });
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      // Idempotent re-submit OR converging second channel → NO second record,
      // NO second transition; reuse the prior auditRef (inv-A / inv-B).
      return Promise.resolve(ok({ outcome: "noop", auditRef: existing }));
    }
    this.recordCount += 1;
    const ref = auditId(`audit-disposition-${this.recordCount}`);
    this.byKey.set(key, ref);
    return Promise.resolve(ok({ outcome: "recorded", auditRef: ref }));
  }
}

// ---------------------------------------------------------------------------
// FakeRescopeSourcePort (applies the routing override, preserves contentHash)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeRescopeSourcePort}: `failWith` forces a typed
 * {@link RescopeError}; absent, it returns the parked source RE-SCOPED with the
 * disposition's workspace/project/sensitivity override, preserving contentHash.
 */
export interface FakeRescopeConfig {
  readonly failWith?: RescopeErrorCode;
  /** The parked source to re-scope (defaults to {@link makeParkedSource}). */
  readonly parked?: SourceEnvelope;
}

export class FakeRescopeSourcePort implements RescopeSourcePort {
  readonly calls: TriageDisposition[] = [];
  constructor(private readonly config: FakeRescopeConfig = {}) {}

  rescope(
    disposition: TriageDisposition,
  ): Promise<Result<SourceEnvelope, RescopeError>> {
    this.calls.push(disposition);
    if (this.config.failWith !== undefined) {
      const error: RescopeError = {
        code: this.config.failWith,
        message: `fake rescope failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    const parked = this.config.parked ?? makeParkedSource();
    // inv-C: apply the OWNER override; inv-D: PRESERVE contentHash (same logical
    // source → same downstream idempotency identity).
    const reScoped: SourceEnvelope = {
      ...parked,
      workspaceId: disposition.workspaceId,
      ...(disposition.sensitivity !== undefined
        ? { sensitivity: disposition.sensitivity }
        : {}),
      routingHints: {
        ...parked.routingHints,
        ...(disposition.projectId !== undefined
          ? { projectId: disposition.projectId }
          : {}),
      },
    };
    return Promise.resolve(ok(reScoped));
  }
}

// ---------------------------------------------------------------------------
// FakeReenterIngestionPort (models 7.7 resolveRun reuse by idempotencyKey)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeReenterIngestionPort}: `failWith` forces a typed
 * {@link ReenterError}; `restState` is the 7.7 state the re-entry rests in (default
 * `applied`). A SHARED instance across two drives models the durable downstream:
 * the SECOND re-entry with the SAME idempotencyKey reports `runReused: true` and does
 * NOT bump `commitCount` (7.7's KnowledgeWriter/Tool-Gateway idempotent replay).
 */
export interface FakeReenterConfig {
  readonly failWith?: ReenterErrorCode;
  readonly restState?: string;
}

export class FakeReenterIngestionPort implements ReenterIngestionPort {
  /** The (source, idempotencyKey) tuples re-entered with (proof of same-key reuse). */
  readonly calls: Array<{ source: SourceEnvelope; idempotencyKey: string }> = [];
  /** Number of DISTINCT downstream commits (a same-key replay does NOT bump this). */
  commitCount = 0;
  private readonly seenKeys = new Set<string>();

  constructor(private readonly config: FakeReenterConfig = {}) {}

  reenter(
    reScopedSource: SourceEnvelope,
    idempotencyKey: string,
  ): Promise<Result<ReenterOutcome, ReenterError>> {
    this.calls.push({ source: reScopedSource, idempotencyKey });
    if (this.config.failWith !== undefined) {
      const error: ReenterError = {
        code: this.config.failWith,
        message: `fake reenter failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    const runReused = this.seenKeys.has(idempotencyKey);
    if (!runReused) {
      this.seenKeys.add(idempotencyKey);
      this.commitCount += 1; // first re-entry drives the durable downstream once.
    }
    const outcome: ReenterOutcome = {
      state: this.config.restState ?? "applied",
      runReused,
    };
    return Promise.resolve(ok(outcome));
  }
}

// ---------------------------------------------------------------------------
// FakeTriageHealthSink (the failure sink)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeTriageHealthSink}: `failWith` forces a typed
 * {@link TriageHealthSinkError} (to exercise the §16 "the sink itself failed" path);
 * absent, every surfaced failure is RECORDED so a test can assert nothing failed
 * silently (inv-5).
 */
export interface FakeTriageHealthSinkConfig {
  readonly failWith?: TriageHealthSinkError["code"];
}

export class FakeTriageHealthSink implements TriageHealthSink {
  readonly surfaced: TriageWorkflowFailure[] = [];
  constructor(private readonly config: FakeTriageHealthSinkConfig = {}) {}

  surface(
    failure: TriageWorkflowFailure,
  ): Promise<Result<TriageSurfaceOutcome, TriageHealthSinkError>> {
    if (this.config.failWith !== undefined) {
      const error: TriageHealthSinkError = {
        code: this.config.failWith,
        message: `fake triage health-sink failure: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    this.surfaced.push(failure);
    return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
  }
}

// A re-export convenience for tests asserting the parked→bound override.
export type { WorkspaceId };
