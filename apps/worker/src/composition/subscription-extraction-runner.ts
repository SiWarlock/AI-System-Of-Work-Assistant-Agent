// 18.20 — the subscription-backed extraction RUNTIME runner (§19.5 Option-B subscription path).
//
// Binds the broker's `!("provider" in route)` runtime branch (previously an unconditional fail-closed
// deny in provider-runner.ts) to a runner that drives `createClaudeSubscriptionCompletion` — the Agent
// SDK `query()` on the local `claude` login (NO api key; the worker runs ANTHROPIC_API_KEY UNSET, or a
// stale key shadows the subscription profile). Mirrors the existing `createClaudeCopilotSynthesis`
// worker adapter over the SAME subscription client — the difference is this produces a run-leg
// `AgentResult` whose `candidateOutput` is the model's `sow:agent-extraction` structured output.
//
// CANDIDATE DATA (rule 2): the run leg emits `structuredOutput` UNVALIDATED as `AgentResult.candidateOutput`.
// It does NOT parse/normalize it — the broker's `bySchemaIdNormalizer` (keyed on `outputSchemaId ===
// "sow:agent-extraction"`) turns it into the `agent_extraction` BrokerCandidate, then `validateNoInference`
// (REQ-F-017) gates the evidence. This runner is the run leg, never the gate.
//
// SAFETY:
//   • TOTAL — never throws across the boundary (§16; the broker awaits the run leg unguarded). A rogue
//     throw from the injected content seam or the client folds to a fail-closed `provider_unavailable`
//     deny, redaction-safe (no cause echoed).
//   • Redaction (rule 7 / §16): a `CompletionError` folds to a KIND-only deny message — the SDK message
//     (which MAY carry prompt/content fragments) is NEVER echoed.
//   • COST-1 (§19.5 Finding-F): the token-priced broker budget gate can't meter a runtime route, so the
//     enforced dollar cap reaches the model ONLY via the SDK-native `maxBudgetUsd` — threaded here from
//     the broker's `EnforcedBudget.maxCostUsd` into `buildExtractionCompletionRequest`'s `opts.maxCostUsd`.
//   • The egress veto still runs BEFORE this run leg (the broker's fixed order: admission → route →
//     egress veto → health → budget → RUN) — a subscription is CLOUD egress; the cloud `{runtime}` route
//     re-triggering the veto for untrusted employer-raw source jobs is the owner-ENABLE (#13) precondition.
//
// SAFE BUILD (dormant): this runner is bound into the runtime branch ONLY when the owner supplies the
// subscription deps (via `RealProviderRunnerDeps.subscription`, itself behind the default-OFF
// `providerTransport` gate). The shipped `capabilityDefaults` route stays `{provider:"ollama",local}`, so
// the runtime branch is NOT reached in production this round — reachability-WAIVERED (L11). The real
// `ContentResolver` + the `{runtime}` route-selection change bind at the owner ENABLE.
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { AgentJob, Result } from "@sow/contracts";
import {
  buildMeetingExtractionRequest,
  buildSourceExtractionRequest,
  buildExtractionCompletionRequest,
  DEFAULT_EXTRACTION_BETAS,
  makeAgentResult,
  type ClaudeSubscriptionCompletion,
  type CompletionError,
  type ProviderRunner,
  type GateDeny,
  type JobBranch,
} from "@sow/providers";
import { buildAuditSignal, type AuditSignal } from "@sow/policy";

// ── the content-resolution seam (new — the ref path is marker-only) ─────────────

/** A redaction-safe fault of resolving inline content (code only — never raw content, rule 7). */
export interface ContentResolutionFault {
  readonly code: string;
}

/**
 * Resolves an extraction job's input → the inline text the subscription `userPrompt` needs. There is NO
 * existing `contextRefs → text` resolver (the ref path emits `[refKind:ref]` MARKERS, not content), so a
 * real resolver (reading the transcript / `SourceEnvelope.body` / vault refs) is REQUIRED to inline
 * content. FAKE in tests; the real resolver binds at the owner ENABLE (like the fetch transport, L11).
 * Returns a typed `Result` — the runner ALSO wraps the call so a throwing resolver folds closed (§16).
 */
export interface ExtractionContentResolver {
  resolve(job: AgentJob, signal?: AbortSignal): Promise<Result<string, ContentResolutionFault>>;
}

/** Injected deps for the subscription-extraction runner. All fakeable; no SDK/network here. */
export interface SubscriptionExtractionRunnerDeps {
  /** The generic Claude-subscription completion client (`createClaudeSubscriptionCompletion`). */
  readonly completion: ClaudeSubscriptionCompletion;
  /** The content-resolution seam (fake in tests; real at ENABLE). */
  readonly content: ExtractionContentResolver;
  /** The owner-configured extraction model id (bound at ENABLE). */
  readonly model: string;
  /** SDK beta flags; defaults to `DEFAULT_EXTRACTION_BETAS` (the 1M-context window). */
  readonly betas?: readonly string[];
}

const RUNNER_ACTOR = "provider:subscription-runner" as const;
const RUNNER_MARKER = "provider:subscription-runner-decision" as const;

/** A redaction-safe run-leg audit signal — refs the job + a safe summary, never a secret/content. */
function runnerAudit(job: AgentJob, event: string, afterSummary: string): AuditSignal {
  return buildAuditSignal({
    actor: RUNNER_ACTOR,
    event,
    refs: [`ref:job:${job.id}`],
    payloadHash: RUNNER_MARKER,
    beforeSummary: "subscription run leg",
    afterSummary,
  });
}

/** A fail-closed, terminal `provider_unavailable` deny — redaction-safe, never retryable. */
function denyUnavailable(job: AgentJob, message: string): GateDeny {
  return {
    reason: "provider_unavailable",
    message,
    audit: runnerAudit(job, "subscription.run.unavailable", message),
    branch: "failed_terminal",
    retryable: false,
  };
}

/**
 * Map a typed {@link CompletionError} to a {@link GateDeny}. Redaction-safe: the message names the error
 * KIND only (never the SDK message, which MAY carry prompt/content fragments — rule 7 / §16). A `budget`
 * kind rides the broker's `budget_exceeded`/`cancelled_budget` shape; a `cancelled` rides
 * `provider_cancelled`; the rest fold to a retryable/terminal `provider_*` derived from `error.retryable`.
 * NOTE: unlike the ModelProviderPort `auth_unavailable` path, a subscription `auth` failure is TERMINAL —
 * the ambient local `claude` login is unavailable, there is NO keychain credential to HOLD retryable.
 */
function denyFromCompletionError(cerr: CompletionError, job: AgentJob): GateDeny {
  if (cerr.kind === "budget") {
    return {
      reason: "budget_exceeded",
      message: "subscription run cancelled on budget cap (budget)",
      audit: runnerAudit(job, "subscription.run.budget", "subscription run leg denied (budget)"),
      branch: "cancelled_budget",
      retryable: false,
    };
  }
  if (cerr.kind === "cancelled") {
    return {
      reason: "provider_cancelled",
      message: "subscription run failed (cancelled)",
      audit: runnerAudit(job, "subscription.run.cancelled", "subscription run leg denied (cancelled)"),
      branch: "failed_terminal",
      retryable: false,
    };
  }
  if (cerr.kind === "auth") {
    // A subscription auth failure is ENFORCED TERMINAL here (NOT derived from `cerr.retryable`): the
    // ambient local `claude` login is unavailable, there is NO keychain credential to HOLD retryable
    // (unlike the ModelProviderPort `auth_unavailable` path). Enforcing it (rather than trusting the
    // client's flag) means a future client change can't silently make a broken login retryable.
    return {
      reason: "provider_unavailable",
      message: "subscription run failed (auth)",
      audit: runnerAudit(job, "subscription.run.failed", "subscription run leg denied (auth)"),
      branch: "failed_terminal",
      retryable: false,
    };
  }
  // transport / rate_limited / timeout / malformed: a generic provider error; the retryable branch rides
  // the error's own `retryable` flag (transport/rate_limited/timeout are retryable, malformed is not).
  const branch: JobBranch = cerr.retryable ? "failed_retryable" : "failed_terminal";
  return {
    reason: "provider_error",
    message: `subscription run failed (${cerr.kind})`,
    audit: runnerAudit(job, "subscription.run.failed", `subscription run leg denied (${cerr.kind})`),
    branch,
    retryable: cerr.retryable,
  };
}

/**
 * Build the extraction request for a job, discriminating meeting vs source on `job.capability`. Both legs
 * resolve the inline schema off `job.outputSchemaId` and fail closed (`schema_unresolved`) on an
 * unregistered id — never an unconstrained request. Returns `undefined` for a NON-extraction capability
 * (a misrouted runtime route — fail-closed at the caller, never guessed).
 */
function buildExtractionRequestForJob(
  job: AgentJob,
): ReturnType<typeof buildMeetingExtractionRequest> | undefined {
  const capability = String(job.capability);
  if (capability === "meeting.close") return buildMeetingExtractionRequest(job);
  if (capability === "source.process") return buildSourceExtractionRequest(job);
  return undefined;
}

/**
 * Build the subscription-extraction {@link ProviderRunner}. This leg binds the OWNER-CONFIGURED
 * `deps.model` and always egresses to the Anthropic subscription (the SDK's ambient `claude` login), so
 * it asserts the `route` the veto classified is a `cloud`-egress route BEFORE any egress (defense-in-depth
 * over the egress veto — see the guard below). Total — never throws across the boundary (§16).
 */
export function createSubscriptionExtractionRunner(
  deps: SubscriptionExtractionRunnerDeps,
): ProviderRunner {
  const { completion, content, model } = deps;
  const betas = deps.betas ?? DEFAULT_EXTRACTION_BETAS;

  return async (route, job, budget, signal) => {
    try {
      // 0. Defense-in-depth over the egress veto (rule 5), mirroring createClaudeCopilotSynthesis: the
      //    subscription client ALWAYS egresses to the Anthropic cloud, so a route the veto classified as
      //    anything but `cloud` reaching here is a WIRING ERROR — reject BEFORE any content resolve/egress
      //    so a mis-classified `{runtime,local}` route can't laundering-egress cloud while the veto thought
      //    it zero-egress. The broker egress veto stays the PRIMARY gate (it runs upstream of the run leg).
      if (route.egressClass !== "cloud") {
        return err(denyUnavailable(job, "runtime extraction route is not a cloud-egress route"));
      }

      // 1. Build the extraction request (capability → meeting/source; schema resolved off the job's
      //    outputSchemaId, fail-closed on an unresolved id). Short-circuits BEFORE content/dispatch.
      const reqResult = buildExtractionRequestForJob(job);
      if (reqResult === undefined) {
        return err(denyUnavailable(job, "runtime extraction route capability not recognized"));
      }
      if (isErr(reqResult)) {
        return err(denyUnavailable(job, "runtime extraction output schema unresolved"));
      }
      const extractionReq = reqResult.value;

      // 2. Resolve the inline content. A typed err fails closed BEFORE any dispatch (no cloud spend on
      //    unresolvable content). The call is inside the outer try so a throwing seam also folds closed.
      const contentResult = await content.resolve(job, signal);
      if (isErr(contentResult)) {
        return err(denyUnavailable(job, "runtime extraction content unavailable"));
      }

      // 3. Assemble the subscription CompletionRequest (18.19): the enforced dollar cap threads by
      //    PRESENCE into the SDK `maxBudgetUsd` (COST-1 / §19.5 Finding-F).
      const request = buildExtractionCompletionRequest(extractionReq, contentResult.value, {
        model,
        betas,
        ...(budget.maxCostUsd !== undefined ? { maxCostUsd: budget.maxCostUsd } : {}),
      });

      // 4. Drive the subscription completion. `structuredOutput` is CANDIDATE DATA — passed through
      //    UNVALIDATED as candidateOutput (rule 2); the broker normalizer + validateNoInference are the gate.
      const res = await completion.complete(request, signal);
      if (isOk(res)) {
        const out = res.value;
        return ok({
          value: makeAgentResult({
            status: "completed",
            candidateOutput: out.structuredOutput,
            // runtimeSeconds is UNMEASURED on this route (the SDK meters wall-time internally for
            // maxBudgetUsd but does not report it back). Carry the REAL reported costUsd so the
            // BudgetLedgerPort records true subscription spend; the broker POST cost/runtime breach gates
            // are inert for a runtime route (Finding-F) — maxBudgetUsd is the in-flight cap.
            usage: { runtimeSeconds: 0, costUsd: out.costUsd },
            logs: [],
          }),
        });
      }
      return err(denyFromCompletionError(res.error, job));
    } catch {
      // §16 — the run leg is TOTAL. A rogue throw (content seam or client) folds closed, redaction-safe.
      return err(denyUnavailable(job, "runtime extraction run leg faulted"));
    }
  };
}
