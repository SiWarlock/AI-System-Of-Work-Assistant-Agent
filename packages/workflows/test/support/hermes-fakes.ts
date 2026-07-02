// task 7.18 — in-memory test doubles + builders for the Hermes-automation PORTS
// that are Hermes-SPECIFIC (the routing seam + the Hermes agent-job seam). The rest
// of the governed pipeline (validate / buildOutputs / commit / propose / reindex /
// health) reuses the derive-from-validated fakes in ./meeting-fakes — the Hermes
// workflow shares that exact governance surface, so its no-inference + workspace-
// stamp guarantees are IDENTICAL. These fakes SATISFY the real port interfaces
// declared on src/workflows/hermesAutomation.ts so the pure driver is
// Vitest-unit-testable with NO Temporal / broker / KnowledgeWriter / Tool Gateway.
//
// Every fake returns the EXACT typed Result the port declares (never throws) and is
// deterministic (no Date.now()/Math.random()).
//  • FakeHermesRoutePort — high binds the workspace; low → routingReview (never
//    guesses a workspace); { failWith } → a typed route error.
//  • FakeHermesAgentJobPort — accepted → candidate extraction; rejected → a typed
//    admission/provider/… failure.
import { ok, err, sourceId, workspaceId } from "@sow/contracts";
import type { Result, WorkspaceId } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { AgentExtraction } from "../../src/ports/meetingCloseout";
import type {
  HermesRoutePort,
  HermesRouteError,
  HermesRouteErrorCode,
  HermesRouteOutcome,
  RunHermesAgentJobPort,
  HermesAgentFailure,
  HermesAgentFailureCode,
  HermesAutomationContext,
} from "../../src/workflows/hermesAutomation";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Build a well-formed pre-route {@link HermesAutomationContext}: a Hermes automation
 * trigger descriptor with NO bound workspace (WS-2 — the workspace is bound only
 * after a high-confidence route). Pass a partial to override.
 */
export function makeHermesContext(
  partial: Partial<HermesAutomationContext> = {},
): HermesAutomationContext {
  return {
    trigger: {
      source: "cron",
      automationId: "auto-daily-tidy",
      sourceRef: { sourceId: sourceId("src-hermes-1") },
    },
    envelopes: [],
    ...partial,
  };
}

/**
 * Build a candidate {@link AgentExtraction}. Defaults are safe under the no-inference
 * rule (REQ-F-017): `owner` is evidence-backed, `dueDate` is the TBD sentinel — so a
 * default extraction PASSES FakeValidatePort. Pass a partial (e.g. an inferred owner
 * with no evidenceRef) to model a rejection.
 */
export function makeHermesExtraction(
  partial: Partial<AgentExtraction> = {},
): AgentExtraction {
  return {
    fields: {
      owner: { value: "Eve", evidenceRef: "kanban#card-7" },
      dueDate: { value: TBD },
    },
    schemaId: "sow:hermes-automation-output",
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// FakeHermesRoutePort (confidence high/low, or a typed route error)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeHermesRoutePort}:
 *  • `{ confidence: "high", workspaceId, projectId? }` binds the workspace.
 *  • `{ confidence: "low", reason? }` → routingReview, no bind.
 *  • `{ failWith }` → a typed route error (the router/source itself failed).
 */
export type FakeHermesRouteConfig =
  | { confidence: "high"; workspaceId: WorkspaceId; projectId?: string }
  | { confidence: "low"; reason?: string }
  | { failWith: HermesRouteErrorCode };

export class FakeHermesRoutePort implements HermesRoutePort {
  readonly calls: HermesAutomationContext[] = [];
  constructor(private readonly config: FakeHermesRouteConfig) {}

  route(
    ctx: HermesAutomationContext,
  ): Promise<Result<HermesRouteOutcome, HermesRouteError>> {
    this.calls.push(ctx);
    if ("failWith" in this.config) {
      const error: HermesRouteError = {
        code: this.config.failWith,
        message: `fake hermes-route error: ${this.config.failWith}`,
      };
      return Promise.resolve(err(error));
    }
    if (this.config.confidence === "high") {
      const outcome: HermesRouteOutcome = {
        confidence: "high",
        workspaceId: this.config.workspaceId,
        ...(this.config.projectId !== undefined ? { projectId: this.config.projectId } : {}),
      };
      return Promise.resolve(ok(outcome));
    }
    // LOW confidence — NO workspace bound (WS-2 / inv-1).
    const outcome: HermesRouteOutcome = {
      confidence: "low",
      routingReview: true,
      ...(this.config.reason !== undefined ? { reason: this.config.reason } : {}),
    };
    return Promise.resolve(ok(outcome));
  }
}

// ---------------------------------------------------------------------------
// FakeHermesAgentJobPort (accepted / rejected)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeHermesAgentJobPort}: `accepted` returns a candidate
 * extraction (default {@link makeHermesExtraction}, or an override); `rejected`
 * returns a typed {@link HermesAgentFailure} under the given code (defaults to
 * `admission_rejected` — the ING-7 mutating-tool case).
 */
export type FakeHermesAgentJobConfig =
  | { result: "accepted"; extraction?: AgentExtraction }
  | { result: "rejected"; rejection?: HermesAgentFailureCode };

export class FakeHermesAgentJobPort implements RunHermesAgentJobPort {
  readonly calls: HermesAutomationContext[] = [];
  constructor(
    private readonly config: FakeHermesAgentJobConfig = { result: "accepted" },
  ) {}

  run(
    ctx: HermesAutomationContext,
  ): Promise<Result<AgentExtraction, HermesAgentFailure>> {
    this.calls.push(ctx);
    if (this.config.result === "accepted") {
      return Promise.resolve(ok(this.config.extraction ?? makeHermesExtraction()));
    }
    const code = this.config.rejection ?? "admission_rejected";
    const failure: HermesAgentFailure = {
      code,
      message: `fake hermes agent-job rejection: ${code}`,
    };
    return Promise.resolve(err(failure));
  }
}

// Re-export the source-workspace id constructors used above so a test can mint
// correctly-branded ids without re-importing @sow/contracts directly.
export { sourceId, workspaceId };
