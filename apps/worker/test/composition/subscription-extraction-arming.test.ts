// 18.24 step-6 — `gateSubscriptionExtraction`: the SINGLE default-OFF arming helper that composes the staged
// 18.20–18.23 helpers into the owner's step-6 bundle (dormant). OFF (the shipped default) ⇒ `undefined` +
// ZERO dep-thunk invocations (byte-equivalent — the factory-spy pin, L23/L27/L58); ON (owner step-6 flip) ⇒
// the wiring bundle: a `ProviderTransportGate` (enabled BY CONSTRUCTION, subscription deps threaded) + the
// armed cloud `{runtime}` route + a SHORT-TTL-memoized health source so one reachability probe feeds BOTH
// HealthGateSources dimensions per gate evaluation (item vi). AND-locked (L52): the gate is the single arming
// signal boot derives `armed` from. Reachability-WAIVERED (L11): the owner ENABLE (step 6, HARD STOP) calls
// it; building the helper crosses no hard line. NOTHING here arms, provisions, or spends.
import { describe, it, expect, vi } from "vitest";
import { ok, isOk, isErr } from "@sow/contracts";
import type { SourceEnvelope } from "@sow/contracts";
import {
  gateSubscriptionExtraction,
  gateSubscriptionOnlyExtraction,
  buildSubscriptionArmWiring,
  resolveSubscriptionArming,
  type SubscriptionArmingDeps,
  type SubscriptionOnlyArmingDeps,
} from "../../src/composition/subscription-extraction-arming";
import {
  createReaderHolder,
  SOURCE_CONTEXT_REF_KIND,
} from "../../src/composition/real-extraction-content-resolver";
import type { EnforcedBudget, CompletionRequest } from "@sow/providers";
import {
  selectHealthSources,
  UNAVAILABLE_HEALTH_SOURCES,
  type ProviderTransportGate,
  type RealProviderRunnerDeps,
} from "../../src/composition/provider-runner";
import {
  CLOUD_EXTRACTION_ROUTE,
  DEFAULT_EXTRACTION_MODEL,
} from "../../src/composition/extraction-route-gate";
import type { ProviderRoute, AgentJob } from "@sow/contracts";
import type {
  ProviderRunner,
  ClaudeSubscriptionCompletion,
  HealthGateSources,
} from "@sow/providers";
import type { ExtractionContentResolver } from "../../src/composition/subscription-extraction-runner";

// ── fakes — every dep is a spy/thunk so we can prove the OFF path constructs NOTHING ───────────
// The HealthGateSources dims take (route, job); the subscription source ignores them (global reachability).
const HS_ROUTE = {} as unknown as ProviderRoute;
const HS_JOB = {} as unknown as AgentJob;
const FAKE_RUNNER = {} as unknown as ProviderRunner;
const FAKE_COMPLETION = {} as unknown as ClaudeSubscriptionCompletion;
const FAKE_RESOLVER = {} as unknown as ExtractionContentResolver;
// The base runner deps the helper forwards verbatim to `buildRealProviderTransportGate` (never inspected).
const RUNNER_DEPS = {} as unknown as RealProviderRunnerDeps;

/** Build a fresh deps object with fresh spies each test (so call-counts are isolated). */
function makeDeps(overrides: Partial<SubscriptionArmingDeps> = {}): {
  deps: SubscriptionArmingDeps;
  createRunner: ReturnType<typeof vi.fn>;
  makeCompletion: ReturnType<typeof vi.fn>;
  makeContentResolver: ReturnType<typeof vi.fn>;
  checkReachable: ReturnType<typeof vi.fn>;
} {
  const createRunner = vi.fn((_d: RealProviderRunnerDeps) => FAKE_RUNNER);
  const makeCompletion = vi.fn(() => FAKE_COMPLETION);
  const makeContentResolver = vi.fn(() => FAKE_RESOLVER);
  // A HEALTHY reachability check by default (both dimensions true); tests override for the split case.
  const checkReachable = vi.fn(() => ({ loginPresent: true, sdkReachable: true }));
  const deps: SubscriptionArmingDeps = {
    runnerDeps: RUNNER_DEPS,
    makeCompletion,
    makeContentResolver,
    checkReachable,
    // A constant injected clock so the short-TTL memoize coalesces the two dimension reads in one eval.
    now: () => 1000,
    createRunner,
    ...overrides,
  };
  return { deps, createRunner, makeCompletion, makeContentResolver, checkReachable };
}

describe("gateSubscriptionExtraction — the step-6 default-OFF arming helper (18.24, dormant)", () => {
  it("arming_gate_off_is_byte_equivalent — opts undefined ⇒ undefined + ZERO dep-thunk invocations (L23/L58) [spec(§19.5)]", () => {
    const { deps, createRunner, makeCompletion, makeContentResolver, checkReachable } = makeDeps();
    expect(gateSubscriptionExtraction(undefined, deps)).toBeUndefined();
    // The OFF path constructs NOTHING — no runner, no completion client, no resolver, no probe.
    expect(createRunner).toHaveBeenCalledTimes(0);
    expect(makeCompletion).toHaveBeenCalledTimes(0);
    expect(makeContentResolver).toHaveBeenCalledTimes(0);
    expect(checkReachable).toHaveBeenCalledTimes(0);
  });

  it("arming_gate_enabled_false_is_off — { enabled:false } ⇒ undefined + zero invocations (default-OFF) [spec(§19.5)]", () => {
    const { deps, createRunner } = makeDeps();
    expect(gateSubscriptionExtraction({ enabled: false }, deps)).toBeUndefined();
    expect(createRunner).toHaveBeenCalledTimes(0);
  });

  it("arming_signal_truthy_not_true_does_not_arm — STRICT ===true; \"true\"/1/{} ⇒ undefined, byte-equivalent (L28/L50) [spec(L28)]", () => {
    const { deps, createRunner, makeCompletion } = makeDeps();
    for (const truthy of ["true", 1, {}, [], "armed"] as unknown[]) {
      expect(gateSubscriptionExtraction({ enabled: truthy as boolean }, deps)).toBeUndefined();
    }
    expect(createRunner).toHaveBeenCalledTimes(0);
    expect(makeCompletion).toHaveBeenCalledTimes(0);
  });

  it("arming_gate_on_constructs_bundle — armed ⇒ {providerTransport(enabled), armed cloud route}; make is a factory-spy-zero-at-build thunk [spec(§19.5)]", () => {
    const { deps, createRunner, makeCompletion, makeContentResolver } = makeDeps();
    const wiring = gateSubscriptionExtraction({ enabled: true }, deps);
    expect(wiring).toBeDefined();
    if (wiring === undefined) return;
    // The gate is armed BY CONSTRUCTION (enabled === true literal) — the SINGLE arming signal boot reads.
    expect(wiring.providerTransport.enabled).toBe(true);
    // The armed route is the cloud {runtime} subscription route (selectExtractionRoute(true)).
    expect(wiring.route).toBe(CLOUD_EXTRACTION_ROUTE);
    // `make` is a THUNK: the runner factory + the subscription-dep thunks fire only on make(), 0x at build (L23/L27).
    expect(createRunner).toHaveBeenCalledTimes(0);
    expect(makeCompletion).toHaveBeenCalledTimes(0);
    expect(makeContentResolver).toHaveBeenCalledTimes(0);
    wiring.providerTransport.make?.();
    expect(createRunner).toHaveBeenCalledTimes(1);
    // The subscription deps (completion + content) are threaded into the runner deps at make() time.
    const passed = createRunner.mock.calls[0]![0] as RealProviderRunnerDeps;
    expect(passed.subscription).toBeDefined();
    passed.subscription!.completion();
    passed.subscription!.content();
    expect(makeCompletion).toHaveBeenCalledTimes(1);
    expect(makeContentResolver).toHaveBeenCalledTimes(1);
  });

  it("arming_model_is_owner_config_not_hardcoded — the owner-set model threads into the subscription deps (defaulted, L2) [spec(§19.5)]", () => {
    const { deps, createRunner } = makeDeps();
    const wiring = gateSubscriptionExtraction({ enabled: true, model: "claude-sonnet-9-owner" }, deps)!;
    wiring.providerTransport.make?.();
    const passed = createRunner.mock.calls[0]![0] as RealProviderRunnerDeps;
    expect(passed.subscription!.model).toBe("claude-sonnet-9-owner");
    // Unset ⇒ the DEFAULT_EXTRACTION_MODEL placeholder (re-confirm-at-flip), never a hardcoded literal here.
    const d2 = makeDeps();
    const dflt = gateSubscriptionExtraction({ enabled: true }, d2.deps)!;
    dflt.providerTransport.make?.();
    expect((d2.createRunner.mock.calls[0]![0] as RealProviderRunnerDeps).subscription!.model).toBe(
      DEFAULT_EXTRACTION_MODEL,
    );
  });

  it("health_source_omitted_never_stub_green — the armed gate carries a real healthSource (never the always-green stub) (L52)", () => {
    const { deps } = makeDeps();
    const wiring = gateSubscriptionExtraction({ enabled: true }, deps)!;
    expect(typeof wiring.providerTransport.healthSource).toBe("function");
    // AND-locked: selecting health on the armed gate returns the REAL source, never UNAVAILABLE-by-omission.
    expect(selectHealthSources(wiring.providerTransport, {} as HealthGateSources)).not.toBe(
      UNAVAILABLE_HEALTH_SOURCES,
    );
  });

  it("health_binding_memoizes_check_reachable — one gate evaluation ⇒ checkReachable invoked ONCE across both dimensions (item vi) [spec(§7)]", () => {
    const { deps, checkReachable } = makeDeps();
    const wiring = gateSubscriptionExtraction({ enabled: true }, deps)!;
    const sources = wiring.providerTransport.healthSource!();
    const health = sources.health(HS_ROUTE, HS_JOB);
    const availability = sources.availability(HS_ROUTE, HS_JOB);
    // Short-TTL memoize (constant clock) ⇒ ONE probe feeds BOTH dimensions (no double-probe, health-sources.ts:22).
    expect(checkReachable).toHaveBeenCalledTimes(1);
    expect(health.state).toBe("healthy");
    expect(availability.modelPresent).toBe(true);
  });

  it("health_split_verdict_denies — a partial reachability (login yes, sdk no) ⇒ NON-healthy, never false-green (L52)", () => {
    const checkReachable = vi.fn(() => ({ loginPresent: true, sdkReachable: false }));
    const { deps } = makeDeps({ checkReachable });
    const wiring = gateSubscriptionExtraction({ enabled: true }, deps)!;
    const sources = wiring.providerTransport.healthSource!();
    expect(sources.health(HS_ROUTE, HS_JOB).state).not.toBe("healthy"); // ⇒ the HEALTH gate DENIES
    expect(checkReachable).toHaveBeenCalledTimes(1); // still one probe (memoized)
  });

  it("health_memoize_reprobes_after_ttl — advancing the injected clock past healthTtlMs ⇒ checkReachable RE-invoked (fresh verdict, not a permanent cache) [spec(§7)]", () => {
    let t = 1000;
    const checkReachable = vi.fn(() => ({ loginPresent: true, sdkReachable: true }));
    const { deps } = makeDeps({ checkReachable, now: () => t, healthTtlMs: 100 });
    const wiring = gateSubscriptionExtraction({ enabled: true }, deps)!;
    const sources = wiring.providerTransport.healthSource!();
    sources.health(HS_ROUTE, HS_JOB); // t=1000 → probe #1
    sources.availability(HS_ROUTE, HS_JOB); // t=1000 → SAME window ⇒ cached (no 2nd probe)
    expect(checkReachable).toHaveBeenCalledTimes(1);
    t = 1000 + 100 + 1; // advance the clock PAST the TTL window
    sources.health(HS_ROUTE, HS_JOB); // ⇒ the cache is stale ⇒ RE-probe (a permanent cache would fail this)
    expect(checkReachable).toHaveBeenCalledTimes(2);
  });
});

// ── resolveSubscriptionArming — the boot-side degrade decision (#2 TWEAK: degrade-arming, never boot-crash) ──
const ARMED_GATE: ProviderTransportGate = { enabled: true, make: () => FAKE_RUNNER };

describe("resolveSubscriptionArming — armed-path env guard degrades the arm, never crashes boot (18.24, #2 L52)", () => {
  it("resolve_unarmed_default_never_reads_env — providerTransport unset ⇒ unarmed, effectiveArmed=false, EVEN with a shadowing var set (byte-equivalent) [spec(L23)]", () => {
    const r = resolveSubscriptionArming(undefined, { ANTHROPIC_API_KEY: "sk-x" });
    expect(r.armed).toBe(false);
    expect(r.authRefused).toBe(false); // the unarmed path never consults env
    expect(r.effectiveArmed).toBe(false);
  });

  it("resolve_armed_clean_env_arms — armed gate + no shadowing var ⇒ effectiveArmed=true, not refused [spec(§19.5)]", () => {
    const r = resolveSubscriptionArming(ARMED_GATE, {});
    expect(r.armed).toBe(true);
    expect(r.authRefused).toBe(false);
    expect(r.effectiveArmed).toBe(true);
  });

  it("armed_boot_refuses_to_arm_on_shadowing_env — armed + shadowing var ⇒ DEGRADE: effectiveArmed=false + typed fault surfaced (extraction stays local, boot completes; NOT a crash) [spec(§19.5/L52)]", () => {
    const r = resolveSubscriptionArming(ARMED_GATE, { ANTHROPIC_BASE_URL: "http://evil.proxy" });
    expect(r.armed).toBe(true); // the raw signal was armed …
    expect(r.authRefused).toBe(true); // … but a shadowing var refuses the arm
    expect(r.effectiveArmed).toBe(false); // ⇒ extraction stays LOCAL/unarmed (fail-closed, ZERO cloud extraction)
    expect(r.authFault?.code).toBe("anthropic_key_set_on_armed_path"); // the loud, typed surface (rule 7 code-only)
    expect(JSON.stringify(r)).not.toContain("evil.proxy"); // rule 7 — the env VALUE is never echoed
  });

  it("resolve_truthy_not_true_not_armed — providerTransport.enabled truthy-not-true ⇒ unarmed (STRICT, single-sourced predicate) [spec(L28)]", () => {
    const r = resolveSubscriptionArming(
      { enabled: "true" as unknown as boolean, make: () => FAKE_RUNNER },
      { ANTHROPIC_API_KEY: "sk-x" },
    );
    expect(r.armed).toBe(false);
    expect(r.effectiveArmed).toBe(false);
    expect(r.authRefused).toBe(false); // unarmed ⇒ never reads env
  });
});

// ── gateSubscriptionOnlyExtraction — the SUBSCRIPTION-ONLY arm builder (18.25 step-6) ─────────────────────
function makeOnlyDeps(overrides: Partial<SubscriptionOnlyArmingDeps> = {}): {
  deps: SubscriptionOnlyArmingDeps;
  makeCompletion: ReturnType<typeof vi.fn>;
  makeContentResolver: ReturnType<typeof vi.fn>;
  checkReachable: ReturnType<typeof vi.fn>;
} {
  const makeCompletion = vi.fn(() => FAKE_COMPLETION);
  const makeContentResolver = vi.fn(() => FAKE_RESOLVER);
  const checkReachable = vi.fn(() => ({ loginPresent: true, sdkReachable: true }));
  const deps: SubscriptionOnlyArmingDeps = {
    makeCompletion,
    makeContentResolver,
    checkReachable,
    now: () => 1000,
    ...overrides,
  };
  return { deps, makeCompletion, makeContentResolver, checkReachable };
}

describe("gateSubscriptionOnlyExtraction — the subscription-ONLY arm builder (18.25 step-6, dormant)", () => {
  it("only_off_is_byte_equivalent — opts undefined ⇒ undefined + ZERO thunk invocations (no registry deps needed) [spec(§19.5)]", () => {
    const { deps, makeCompletion, makeContentResolver, checkReachable } = makeOnlyDeps();
    expect(gateSubscriptionOnlyExtraction(undefined, deps)).toBeUndefined();
    expect(makeCompletion).toHaveBeenCalledTimes(0);
    expect(makeContentResolver).toHaveBeenCalledTimes(0);
    expect(checkReachable).toHaveBeenCalledTimes(0);
  });

  it("only_truthy_not_true_does_not_arm — STRICT ===true; \"true\"/1/{} ⇒ undefined [spec(L28)]", () => {
    const { deps } = makeOnlyDeps();
    for (const truthy of ["true", 1, {}, []] as unknown[]) {
      expect(gateSubscriptionOnlyExtraction({ enabled: truthy as boolean }, deps)).toBeUndefined();
    }
  });

  it("only_on_constructs_bundle — armed ⇒ {providerTransport(enabled), cloud route}; make is factory-spy-0-at-build, deps thread at make() [spec(§19.5)]", () => {
    const { deps, makeCompletion, makeContentResolver } = makeOnlyDeps();
    const wiring = gateSubscriptionOnlyExtraction({ enabled: true }, deps);
    expect(wiring).toBeDefined();
    if (wiring === undefined) return;
    expect(wiring.providerTransport.enabled).toBe(true);
    expect(wiring.route).toBe(CLOUD_EXTRACTION_ROUTE);
    // THUNK — nothing constructs until make() (0× at build, L23/L27).
    expect(makeCompletion).toHaveBeenCalledTimes(0);
    expect(makeContentResolver).toHaveBeenCalledTimes(0);
    const runner = wiring.providerTransport.make?.();
    expect(typeof runner).toBe("function"); // a ProviderRunner
    expect(makeCompletion).toHaveBeenCalledTimes(1); // subscription deps built on make()
    expect(makeContentResolver).toHaveBeenCalledTimes(1);
  });

  it("only_health_source_memoizes — one gate eval ⇒ checkReachable ONCE across both dims; never stub-green (L52) [spec(§7)]", () => {
    const { deps, checkReachable } = makeOnlyDeps();
    const wiring = gateSubscriptionOnlyExtraction({ enabled: true }, deps)!;
    const sources = wiring.providerTransport.healthSource!();
    expect(sources.health(HS_ROUTE, HS_JOB).state).toBe("healthy");
    expect(sources.availability(HS_ROUTE, HS_JOB).modelPresent).toBe(true);
    expect(checkReachable).toHaveBeenCalledTimes(1); // short-TTL memoize coalesces both dims
  });
});

// ── buildSubscriptionArmWiring — the boot-composition glue: the late-bound reader assembly (18.25 step-6) ──
describe("buildSubscriptionArmWiring — gate over the late-bound reader holder (18.25 step-6, dormant)", () => {
  const CLOUD_RUNTIME = {
    runtime: "claude-agent-sdk", model: "m", endpoint: "https://api.anthropic.com", egressClass: "cloud",
  } as unknown as ProviderRoute;
  const sourceJob = {
    id: "j", workflowRunId: "wf", workspaceId: "ws-1", capability: "source.process",
    contextRefs: [{ refKind: SOURCE_CONTEXT_REF_KIND, ref: "S1" }],
    outputSchemaId: "sow:agent-extraction",
    toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [] },
    providerRoute: CLOUD_RUNTIME, trustLevel: "untrusted", carriesRawContent: true,
    maxRuntimeSeconds: 30, idempotencyKey: "idem",
  } as unknown as AgentJob;
  const parked = { sourceId: "S1", workspaceId: "ws-1", body: "the parked transcript" } as unknown as SourceEnvelope;
  const bud = { maxRuntimeSeconds: 30 } as unknown as EnforcedBudget;

  it("off_is_byte_equivalent — opt-in unset ⇒ undefined, the holder is NEVER touched [spec(§19.5)]", () => {
    const holder = createReaderHolder();
    const res = buildSubscriptionArmWiring(undefined, {
      readerHolder: holder,
      makeCompletion: () => FAKE_COMPLETION,
      checkReachable: () => undefined,
      now: () => 1,
    });
    expect(res).toBeUndefined();
    expect(holder.reader).toBeUndefined();
  });

  it("on_late_binds_reader_via_holder — the runner's content resolves ONLY after the holder is filled post-assembly (the eager-consumption ordering fix) [spec(§19.5)]", async () => {
    const holder = createReaderHolder();
    const calls: CompletionRequest[] = [];
    const completion = {
      complete: (req: CompletionRequest) => {
        calls.push(req);
        return Promise.resolve(ok({ structuredOutput: { fields: {} }, costUsd: 0 }));
      },
    };
    const wiring = buildSubscriptionArmWiring(
      { enabled: true },
      { readerHolder: holder, makeCompletion: () => completion, checkReachable: () => ({ loginPresent: true, sdkReachable: true }), now: () => 1 },
    )!;
    const runner = wiring.providerTransport.make!(); // built while the holder is still EMPTY (pre-assembly)

    // BEFORE the holder is filled (pre-assembly / pre-arm) ⇒ content fail-closed ⇒ deny, ZERO cloud dispatch.
    const before = await runner(CLOUD_RUNTIME, sourceJob, bud);
    expect(isErr(before)).toBe(true);
    expect(calls).toHaveLength(0);

    // FILL the holder POST-assembly (what bootWorker does after assembleBackends) ⇒ content now resolves.
    holder.reader = { read: () => Promise.resolve(ok(parked)) };
    const after = await runner(CLOUD_RUNTIME, sourceJob, bud);
    expect(isOk(after)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.userPrompt).toBe("the parked transcript"); // the late-bound parked body inlined into the prompt
  });
});
