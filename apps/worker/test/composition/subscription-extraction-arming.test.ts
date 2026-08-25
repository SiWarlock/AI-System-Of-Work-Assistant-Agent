// 18.25 step-6 — `gateSubscriptionOnlyExtraction` / `buildSubscriptionArmWiring` / `resolveSubscriptionArming`:
// the SUBSCRIPTION-ONLY default-OFF arming helpers (dormant). OFF (the shipped default) ⇒ `undefined` + ZERO
// dep-thunk invocations (byte-equivalent — the factory-spy pin, L23/L27/L58); ON (owner step-6 flip) ⇒ the
// wiring bundle: a `ProviderTransportGate` (enabled BY CONSTRUCTION, subscription deps threaded) + the armed
// cloud `{runtime}` route + a SHORT-TTL-memoized health source so one reachability probe feeds BOTH health-
// source dimensions per gate evaluation (item vi). AND-locked (L52): the gate is the single arming signal boot
// derives `armed` from. Reachability-WAIVERED (L11): the owner ENABLE (step 6, HARD STOP) calls it; building
// the helper crosses no hard line. NOTHING here arms, provisions, or spends.
//
// R18-c: the SIBLING full-registry builder `gateSubscriptionExtraction` (18.24) is DELETED — every non-test
// caller was already on the wired `gateSubscriptionOnlyExtraction` successor (18.25), and carrying two arming
// helpers over the same rule-5 surface is the split-brain shape 18.36 came from. Its dedicated tests (the
// `arming_*`/`health_*` cases over the full `RealProviderRunnerDeps`) are deleted with it — they exercised
// only the deleted function, never a shared invariant `gateSubscriptionOnlyExtraction`'s own tests below don't
// already cover (both builders shared the OFF-guard + memoize-health-probe contract, which the surviving
// `only_*` tests below pin independently).
import { describe, it, expect, vi } from "vitest";
import { ok, isOk, isErr } from "@sow/contracts";
import type { SourceEnvelope } from "@sow/contracts";
import {
  gateSubscriptionOnlyExtraction,
  buildSubscriptionArmWiring,
  resolveSubscriptionArming,
  type SubscriptionOnlyArmingDeps,
} from "../../src/composition/subscription-extraction-arming";
import {
  createReaderHolder,
  SOURCE_CONTEXT_REF_KIND,
} from "../../src/composition/real-extraction-content-resolver";
import type { EnforcedBudget, CompletionRequest } from "@sow/providers";
import type { ProviderTransportGate } from "../../src/composition/provider-runner";
import { CLOUD_EXTRACTION_ROUTE } from "../../src/composition/extraction-route-gate";
import type { ProviderRoute, AgentJob } from "@sow/contracts";
import type { ProviderRunner, ClaudeSubscriptionCompletion } from "@sow/providers";
import type { ExtractionContentResolver } from "../../src/composition/subscription-extraction-runner";

// ── fakes — every dep is a spy/thunk so we can prove the OFF path constructs NOTHING ───────────
const HS_ROUTE = {} as unknown as ProviderRoute;
const HS_JOB = {} as unknown as AgentJob;
const FAKE_RUNNER = {} as unknown as ProviderRunner;
const FAKE_COMPLETION = {} as unknown as ClaudeSubscriptionCompletion;
const FAKE_RESOLVER = {} as unknown as ExtractionContentResolver;
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

  it("armed_boot_degrades_on_lowercase_proxy — armed + lowercase `http_proxy` (a var the 8-set MISSED) ⇒ DEGRADE (effectiveArmed=false + typed fault), NOT a crash — the full-set close-out flows through the boot path [spec(§19.5/L61/L62)]", () => {
    const r = resolveSubscriptionArming(ARMED_GATE, { http_proxy: "http://evil.proxy:8080" });
    expect(r.armed).toBe(true); // the raw signal was armed …
    expect(r.authRefused).toBe(true); // … but the newly-enumerated lowercase proxy var refuses the arm
    expect(r.effectiveArmed).toBe(false); // ⇒ extraction stays LOCAL/unarmed (fail-closed, ZERO cloud extraction)
    expect(r.authFault?.code).toBe("anthropic_key_set_on_armed_path");
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
