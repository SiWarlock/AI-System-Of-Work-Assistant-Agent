// 18.20 — the subscription-backed extraction RUNTIME runner bound into the broker's run leg
// (§19.5 Option-B subscription path). These tests pin the runner's behavior over FAKES (no SDK,
// no network, no real subscription):
//   • a successful completion FRAMES `structuredOutput` as `AgentResult.candidateOutput`
//     UNVALIDATED — the run leg emits candidate data (rule 2); the broker normalizer +
//     `validateNoInference` are the gate, not this runner;
//   • capability drives the prompt (meeting vs source) + the resolved content is inlined;
//   • the enforced dollar cap reaches the SDK `maxBudgetUsd` lever by PRESENCE (COST-1 / Finding-F);
//   • every `CompletionError` folds to a typed `GateDeny` — KIND-only message (rule 7 / §16),
//     budget ⇒ `cancelled_budget`, the rest ⇒ retryable/terminal `provider_*` per `error.retryable`;
//   • the run leg is TOTAL — a rogue throw (content seam OR client) folds to a fail-closed deny,
//     never escapes (§16, the broker awaits the run leg unguarded).
//
// SAFE-BUILD: fakes only — the real subscription client + the real content resolver bind at the
// owner ENABLE (#13); nothing here spawns the SDK, opens a socket, or spends.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { AgentJob, ProviderRoute } from "@sow/contracts";
import {
  DEFAULT_EXTRACTION_BETAS,
  MEETING_EXTRACTION_PROMPT,
  SOURCE_EXTRACTION_PROMPT,
  type ClaudeSubscriptionCompletion,
  type CompletionRequest,
  type CompletionOutput,
  type CompletionError,
  type EnforcedBudget,
} from "@sow/providers";
import type { Result } from "@sow/contracts";
import {
  createSubscriptionExtractionRunner,
  createSubscriptionOnlyProviderRunner,
  type ExtractionContentResolver,
} from "../../src/composition/subscription-extraction-runner";

// ── deterministic constants + fixtures ─────────────────────────────────────────
const MODEL = "claude-sonnet-5";
const CONTENT = "the resolved transcript / source body text";

const runtimeRoute = (): ProviderRoute =>
  ({
    runtime: "claude-agent-sdk",
    model: MODEL,
    endpoint: "https://api.anthropic.com",
    egressClass: "cloud",
  }) as unknown as ProviderRoute;

const makeJob = (capability: string, over: Record<string, unknown> = {}): AgentJob =>
  ({
    id: "job-1",
    workflowRunId: "wf-1",
    workspaceId: "ws-1",
    capability,
    contextRefs: [],
    outputSchemaId: "sow:agent-extraction",
    toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [] },
    providerRoute: runtimeRoute(),
    trustLevel: "trusted",
    carriesRawContent: false,
    maxRuntimeSeconds: 30,
    idempotencyKey: "idem-1",
    ...over,
  }) as unknown as AgentJob;

const budget = (over: Partial<EnforcedBudget> = {}): EnforcedBudget => ({ maxRuntimeSeconds: 30, ...over });

// A fake subscription client that records the CompletionRequest it received + returns a canned Result.
function fakeCompletion(
  result: Result<CompletionOutput, CompletionError>,
  calls: CompletionRequest[] = [],
): ClaudeSubscriptionCompletion {
  return {
    complete: (req: CompletionRequest) => {
      calls.push(req);
      return Promise.resolve(result);
    },
  };
}
const throwingCompletion = (): ClaudeSubscriptionCompletion => ({
  // A secret-shaped detail in the throw — the runner's deny must NEVER echo it (rule 7 / §16).
  complete: () => Promise.reject(new Error("sdk boom sk-canary-secret")),
});

const okContent = (text = CONTENT): ExtractionContentResolver => ({
  resolve: () => Promise.resolve(ok(text)),
});
const errContent = (): ExtractionContentResolver => ({
  resolve: () => Promise.resolve(err({ code: "content_unavailable" })),
});
const throwingContent = (): ExtractionContentResolver => ({
  resolve: () => Promise.reject(new Error("content boom sk-canary-secret")),
});

// ── #1 — success frames structuredOutput as candidateOutput (UNVALIDATED, rule 2) ─
describe("createSubscriptionExtractionRunner — candidate framing", () => {
  it("success_frames_structuredoutput_as_candidateoutput — run leg emits candidate data UNVALIDATED [spec(§19.5)]", async () => {
    const structured = { fields: { owner: { value: "TBD" } } };
    const runner = createSubscriptionExtractionRunner({
      completion: fakeCompletion(ok({ structuredOutput: structured, costUsd: 0.004 })),
      content: okContent(),
      model: MODEL,
    });
    const res = await runner(runtimeRoute(), makeJob("meeting.close"), budget());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    const agentResult = res.value.value;
    expect(agentResult.status).toBe("completed");
    // pass-through, unvalidated — the runner is NOT the gate (broker bySchemaIdNormalizer + validateNoInference are).
    expect(agentResult.candidateOutput).toEqual(structured);
    expect(agentResult.usage.costUsd).toBe(0.004);
  });
});

// ── #2 — capability drives the prompt; content is inlined ───────────────────────
describe("createSubscriptionExtractionRunner — request assembly", () => {
  it.each([
    { capability: "meeting.close", expectedPrompt: MEETING_EXTRACTION_PROMPT, name: "meeting" },
    { capability: "source.process", expectedPrompt: SOURCE_EXTRACTION_PROMPT, name: "source" },
  ])(
    "builds_$name_request_for_$name_capability — capability-driven prompt + inlined content [spec(§9)][spec(§19.5)]",
    async ({ capability, expectedPrompt }) => {
      const calls: CompletionRequest[] = [];
      const runner = createSubscriptionExtractionRunner({
        completion: fakeCompletion(ok({ structuredOutput: {}, costUsd: 0 }), calls),
        content: okContent(),
        model: MODEL,
      });
      const res = await runner(runtimeRoute(), makeJob(capability), budget());
      expect(isOk(res)).toBe(true);
      expect(calls).toHaveLength(1);
      const req = calls[0]!;
      expect(req.model).toBe(MODEL);
      expect(req.systemPrompt).toBe(expectedPrompt); // capability-driven prompt selection
      expect(req.userPrompt).toBe(CONTENT); // resolved content inlined
      expect(typeof req.outputSchema).toBe("object"); // the inline sow:agent-extraction schema
      expect(req.outputSchema).not.toBeNull();
      expect(req.betas).toEqual(DEFAULT_EXTRACTION_BETAS); // extraction betas, NOT the Copilot default
    },
  );

  // ── #3 — the enforced dollar cap → SDK maxBudgetUsd by PRESENCE (COST-1 / Finding-F) ─
  it.each([
    { label: "positive", cap: 1.5 as number | undefined, expected: 1.5 as number | undefined },
    { label: "zero_by_presence", cap: 0, expected: 0 },
    { label: "unset_omits_key", cap: undefined, expected: undefined },
  ])(
    "threads_enforced_maxcostusd_$label — COST-1 dollar cap → SDK maxBudgetUsd by presence [spec(§7)][spec(§19.5)]",
    async ({ cap, expected }) => {
      const calls: CompletionRequest[] = [];
      const runner = createSubscriptionExtractionRunner({
        completion: fakeCompletion(ok({ structuredOutput: {}, costUsd: 0 }), calls),
        content: okContent(),
        model: MODEL,
      });
      await runner(runtimeRoute(), makeJob("meeting.close"), budget(cap !== undefined ? { maxCostUsd: cap } : {}));
      expect(calls[0]?.maxCostUsd).toBe(expected);
      // presence-threading (L8/L57): the unset case OMITS the key (absent), never an explicit undefined.
      expect("maxCostUsd" in calls[0]!).toBe(cap !== undefined);
    },
  );
});

// ── #4/#5 — CompletionError → GateDeny (KIND-only message, rule 7); taxonomy ─────
describe("createSubscriptionExtractionRunner — CompletionError → GateDeny", () => {
  it("budget_completion_error_maps_to_cancelled_budget_deny — budget kind → cancelled_budget, KIND-only [spec(§16)][spec(§7)]", async () => {
    const runner = createSubscriptionExtractionRunner({
      completion: fakeCompletion(err({ kind: "budget", message: "over sk-canary-budget", retryable: false })),
      content: okContent(),
      model: MODEL,
    });
    const res = await runner(runtimeRoute(), makeJob("meeting.close"), budget());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.reason).toBe("budget_exceeded");
    expect(res.error.branch).toBe("cancelled_budget");
    expect(res.error.retryable).toBe(false);
    expect(JSON.stringify(res.error)).not.toContain("sk-canary"); // rule 7 — no SDK message survives
  });

  it.each([
    { kind: "auth", retryable: false, reason: "provider_unavailable", branch: "failed_terminal", retry: false },
    // auth is ENFORCED terminal by the runner (the local `claude` login is unavailable — nothing to
    // retry against without re-login), NOT client-derived: even a (hypothetical) retryable auth folds terminal.
    { kind: "auth", retryable: true, reason: "provider_unavailable", branch: "failed_terminal", retry: false },
    { kind: "transport", retryable: true, reason: "provider_error", branch: "failed_retryable", retry: true },
    { kind: "rate_limited", retryable: true, reason: "provider_error", branch: "failed_retryable", retry: true },
    { kind: "timeout", retryable: true, reason: "provider_error", branch: "failed_retryable", retry: true },
    { kind: "malformed", retryable: false, reason: "provider_error", branch: "failed_terminal", retry: false },
    { kind: "cancelled", retryable: false, reason: "provider_cancelled", branch: "failed_terminal", retry: false },
  ])(
    "completion_error_$kind_maps_to_$reason — failure taxonomy + KIND-only message [spec(§16)]",
    async ({ kind, retryable, reason, branch, retry }) => {
      const runner = createSubscriptionExtractionRunner({
        completion: fakeCompletion(err({ kind, message: "detail sk-canary-secret", retryable } as CompletionError)),
        content: okContent(),
        model: MODEL,
      });
      const res = await runner(runtimeRoute(), makeJob("meeting.close"), budget());
      expect(isErr(res)).toBe(true);
      if (!isErr(res)) return;
      expect(res.error.reason).toBe(reason);
      expect(res.error.branch).toBe(branch);
      expect(res.error.retryable).toBe(retry);
      expect(JSON.stringify(res.error)).not.toContain("sk-canary"); // rule 7
    },
  );
});

// ── #6 — totality: a rogue throw (either collaborator) folds closed; content-err denies ─
describe("createSubscriptionExtractionRunner — totality + fail-closed content", () => {
  it.each([
    { label: "content_seam_throw", content: throwingContent(), completion: fakeCompletion(ok({ structuredOutput: {}, costUsd: 0 })) },
    { label: "client_throw", content: okContent(), completion: throwingCompletion() },
  ])("$label_folds_closed — a rogue throw folds to a fail-closed deny, never escapes [spec(§16)]", async ({ content, completion }) => {
    const runner = createSubscriptionExtractionRunner({ completion, content, model: MODEL });
    // Capture UNCONDITIONALLY (L15) — a resolve-instead-of-throw still hits the asserts.
    const res = await runner(runtimeRoute(), makeJob("meeting.close"), budget());
    expect(isErr(res)).toBe(true); // RESOLVED, not thrown — the run leg is TOTAL
    if (!isErr(res)) return;
    expect(res.error.reason).toBe("provider_unavailable");
    expect(res.error.branch).toBe("failed_terminal");
    expect(res.error.retryable).toBe(false);
    expect(JSON.stringify(res.error)).not.toContain("sk-canary"); // no cause echoed (rule 7)
  });

  it("non_cloud_runtime_route_folds_closed_no_dispatch — a non-cloud runtime route rejected BEFORE egress (rule-5 defense-in-depth) [spec(§7)]", async () => {
    // Defense-in-depth over the egress veto (mirrors createClaudeCopilotSynthesis): the subscription
    // ALWAYS egresses to Anthropic cloud, so a route the veto classified `local` reaching the runner is a
    // WIRING ERROR — reject BEFORE any egress so a mis-classified route can't laundering-egress cloud
    // while the veto thought it zero-egress. The broker egress veto stays the PRIMARY gate (runs upstream).
    const calls: CompletionRequest[] = [];
    const runner = createSubscriptionExtractionRunner({
      completion: fakeCompletion(ok({ structuredOutput: {}, costUsd: 0 }), calls),
      content: okContent(),
      model: MODEL,
    });
    const localRuntime = {
      runtime: "claude-agent-sdk",
      model: MODEL,
      endpoint: "http://127.0.0.1:11434",
      egressClass: "local",
    } as unknown as ProviderRoute;
    const res = await runner(localRuntime, makeJob("meeting.close"), budget());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.reason).toBe("provider_unavailable");
    expect(res.error.branch).toBe("failed_terminal");
    expect(calls).toHaveLength(0); // never egressed cloud under a local-classified route
  });

  it("content_resolution_err_folds_closed_no_dispatch — a typed content err denies BEFORE the client [spec(§16)]", async () => {
    const calls: CompletionRequest[] = [];
    const runner = createSubscriptionExtractionRunner({
      completion: fakeCompletion(ok({ structuredOutput: {}, costUsd: 0 }), calls),
      content: errContent(),
      model: MODEL,
    });
    const res = await runner(runtimeRoute(), makeJob("meeting.close"), budget());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.reason).toBe("provider_unavailable");
    expect(res.error.branch).toBe("failed_terminal");
    expect(calls).toHaveLength(0); // never dispatched — content couldn't be resolved (no cloud spend)
  });

  it("unrecognized_capability_folds_closed_no_dispatch — a non-extraction runtime capability denies, no dispatch [spec(§16)]", async () => {
    const calls: CompletionRequest[] = [];
    const runner = createSubscriptionExtractionRunner({
      completion: fakeCompletion(ok({ structuredOutput: {}, costUsd: 0 }), calls),
      content: okContent(),
      model: MODEL,
    });
    const res = await runner(runtimeRoute(), makeJob("copilot.answer"), budget());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.reason).toBe("provider_unavailable");
    expect(calls).toHaveLength(0);
  });

  it("unresolved_output_schema_folds_closed_no_dispatch — an unregistered outputSchemaId denies before complete(), zero dispatch [spec(§16)]", async () => {
    // buildMeeting/SourceExtractionRequest resolves job.outputSchemaId → its inline schema and returns a
    // `schema_unresolved` fault for an unregistered id (never an unconstrained request, extraction-request.ts).
    // The runner must fail-closed to a typed deny BEFORE resolving content or dispatching (rule-2-adjacent).
    const calls: CompletionRequest[] = [];
    const runner = createSubscriptionExtractionRunner({
      completion: fakeCompletion(ok({ structuredOutput: {}, costUsd: 0 }), calls),
      content: okContent(),
      model: MODEL,
    });
    const res = await runner(
      runtimeRoute(),
      makeJob("meeting.close", { outputSchemaId: "sow:does-not-exist" }),
      budget(),
    );
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.reason).toBe("provider_unavailable");
    expect(res.error.branch).toBe("failed_terminal");
    expect(calls).toHaveLength(0); // never built an unconstrained request / never dispatched
  });
});

// ── 18.25 step-6 — the SUBSCRIPTION-ONLY runner for the owner arm (no 5-provider registry ⇒ no
//    post-assembleBackends controller/now/transport; serves ONLY the cloud {runtime} route). ─────────────
const providerRoute = (): ProviderRoute =>
  ({ provider: "claude", model: MODEL, endpoint: "https://api.anthropic.com", egressClass: "cloud" }) as unknown as ProviderRoute;

describe("createSubscriptionOnlyProviderRunner — the arm runner (18.25 step-6)", () => {
  it("provider_route_fails_closed — a `provider` (raw-API) route ⇒ fail-closed deny; completion/content NEVER touched [spec(§19.5/rule5)]", async () => {
    const completionCalls: CompletionRequest[] = [];
    let contentCalled = false;
    const runner = createSubscriptionOnlyProviderRunner({
      completion: fakeCompletion(ok({ structuredOutput: {}, costUsd: 0.01 }), completionCalls),
      content: { resolve: () => { contentCalled = true; return Promise.resolve(ok(CONTENT)); } },
      model: MODEL,
    });
    const res = await runner(providerRoute(), makeJob("source.process"), budget());
    expect(isErr(res)).toBe(true); // the subscription arm NEVER serves a raw-API provider route
    if (isErr(res)) expect(res.error.reason).toBe("provider_unavailable");
    expect(completionCalls).toHaveLength(0); // no dispatch
    expect(contentCalled).toBe(false); // no content resolve
  });

  it("runtime_route_delegates_to_subscription_runner — a cloud {runtime} route ⇒ delegates (success frames candidate) [spec(§19.5)]", async () => {
    const structured = { fields: { title: { value: "T", evidenceRef: "s#1" } } };
    const runner = createSubscriptionOnlyProviderRunner({
      completion: fakeCompletion(ok({ structuredOutput: structured, costUsd: 0.004 })),
      content: okContent(),
      model: MODEL,
    });
    const res = await runner(runtimeRoute(), makeJob("source.process"), budget());
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.value.candidateOutput).toEqual(structured);
  });

  it("runtime_route_content_err_denies — delegation preserves the runtime runner's fail-closed (content err ⇒ deny, no spend) [spec(§16)]", async () => {
    const completionCalls: CompletionRequest[] = [];
    const runner = createSubscriptionOnlyProviderRunner({
      completion: fakeCompletion(ok({ structuredOutput: {}, costUsd: 0.01 }), completionCalls),
      content: errContent(), // content unresolvable ⇒ fail closed BEFORE dispatch
      model: MODEL,
    });
    const res = await runner(runtimeRoute(), makeJob("source.process"), budget());
    expect(isErr(res)).toBe(true);
    expect(completionCalls).toHaveLength(0); // no cloud dispatch on unresolved content
  });
});
