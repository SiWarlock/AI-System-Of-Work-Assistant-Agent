// spec(§12) — knowledge-sync latency benchmark: KnowledgeWriter-commit →
// GBrain-search-visibility (≤60s p95) → dashboard-read-model (≤10s p95). This is
// the SOLE timing-assertion path (REQ-NF-003). Deterministic core over INJECTED
// samples/probe — no real gbrain, no clock, no network. Never throws (§16).
import { describe, expect, it } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import {
  GBRAIN_SEARCH_VISIBILITY_P95_BUDGET_MS,
  READ_MODEL_P95_BUDGET_MS,
  DEFAULT_SYNC_LATENCY_BUDGET,
  assessSyncLatency,
  runSyncLatencyBenchmark,
  runSyncLatencyBenchmarkIfKeyed,
  makeSyncLatencyProbe,
  type SyncTrialSample,
  type SyncLatencyProbe,
  type Clock,
  type SyncLatencyProbeDeps,
} from "../../src/benchmarks/knowledge-sync-latency.bench";
import type { Result } from "@sow/contracts";

/** A within-budget trial: search visible well under 60s, read-model under 10s. */
function trial(searchMs: number, readMs: number): SyncTrialSample {
  return { commitToSearchVisibleMs: searchMs, commitToReadModelMs: readMs };
}

/** 20 deterministic within-budget trials (p95 comfortably under both budgets). */
const withinBudgetSamples: readonly SyncTrialSample[] = Array.from({ length: 20 }, (_, i) =>
  trial(1_000 + i * 500, 200 + i * 100),
);

describe("recorded budget thresholds — spec(§12)", () => {
  it("pins the REQ-NF-003 p95 budgets (60s search-visible, 10s read-model)", () => {
    expect(GBRAIN_SEARCH_VISIBILITY_P95_BUDGET_MS).toBe(60_000);
    expect(READ_MODEL_P95_BUDGET_MS).toBe(10_000);
    expect(DEFAULT_SYNC_LATENCY_BUDGET).toEqual({
      gbrainSearchVisibilityP95Ms: 60_000,
      readModelP95Ms: 10_000,
    });
  });
});

describe("assessSyncLatency — spec(§12)", () => {
  it("reports BOTH stages within budget for compliant samples", () => {
    const r = assessSyncLatency(withinBudgetSamples);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const report = r.value;
    expect(report.trials).toBe(20);
    expect(report.allWithinBudget).toBe(true);
    const search = report.stages.find((s) => s.stage === "gbrain_search_visibility");
    const read = report.stages.find((s) => s.stage === "read_model");
    expect(search?.status).toBe("within_budget");
    expect(search?.budgetMs).toBe(60_000);
    expect(read?.status).toBe("within_budget");
    expect(read?.budgetMs).toBe(10_000);
  });

  it("computes p95 by nearest-rank (deterministic, not the max outlier)", () => {
    // 20 sorted search values 1000..10500 step 500 → nearest-rank p95 = 19th value = 10000.
    const r = assessSyncLatency(withinBudgetSamples);
    if (!isOk(r)) throw new Error("expected ok");
    const search = r.value.stages.find((s) => s.stage === "gbrain_search_visibility");
    expect(search?.p95Ms).toBe(10_000);
  });

  it("flags the GBrain-search stage OVER budget when p95 exceeds 60s", () => {
    // 19 fast + 1 slow would still pass p95; make the top 5% breach: 20 all at 61s search.
    const samples = Array.from({ length: 20 }, () => trial(61_000, 500));
    const r = assessSyncLatency(samples);
    if (!isOk(r)) throw new Error("expected ok");
    const search = r.value.stages.find((s) => s.stage === "gbrain_search_visibility");
    expect(search?.status).toBe("over_budget");
    expect(r.value.allWithinBudget).toBe(false);
  });

  it("flags the read-model stage OVER budget independently of the search stage", () => {
    const samples = Array.from({ length: 20 }, () => trial(2_000, 11_000));
    const r = assessSyncLatency(samples);
    if (!isOk(r)) throw new Error("expected ok");
    const search = r.value.stages.find((s) => s.stage === "gbrain_search_visibility");
    const read = r.value.stages.find((s) => s.stage === "read_model");
    expect(search?.status).toBe("within_budget");
    expect(read?.status).toBe("over_budget");
    expect(r.value.allWithinBudget).toBe(false);
  });

  it("honors a caller-supplied stricter budget", () => {
    const r = assessSyncLatency(withinBudgetSamples, {
      gbrainSearchVisibilityP95Ms: 5_000,
      readModelP95Ms: 10_000,
    });
    if (!isOk(r)) throw new Error("expected ok");
    const search = r.value.stages.find((s) => s.stage === "gbrain_search_visibility");
    expect(search?.status).toBe("over_budget");
  });

  it("returns a typed Err (not a throw) on empty samples", () => {
    const r = assessSyncLatency([]);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("empty_samples");
  });

  it("returns a typed Err on a non-finite / negative sample", () => {
    const r = assessSyncLatency([trial(-1, 200)]);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("invalid_sample");
  });
});

describe("runSyncLatencyBenchmark (injected probe) — spec(§12)", () => {
  it("collects N trials from the probe and assesses them", async () => {
    let n = 0;
    const probe: SyncLatencyProbe = () => {
      n += 1;
      return Promise.resolve({ ok: true, value: trial(1_000 * n, 100 * n) });
    };
    const r = await runSyncLatencyBenchmark(probe, 5);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.trials).toBe(5);
    expect(r.value.allWithinBudget).toBe(true);
  });

  it("propagates a probe failure as a typed Err (never throws)", async () => {
    const probe: SyncLatencyProbe = () => Promise.resolve({ ok: false, error: "gbrain_unreachable" });
    const r = await runSyncLatencyBenchmark(probe, 3);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("probe_failed");
  });
});

describe("runSyncLatencyBenchmarkIfKeyed — spec(§12)", () => {
  const probe: SyncLatencyProbe = () => Promise.resolve({ ok: true, value: trial(1_000, 200) });

  it("SKIPS the real-gbrain run by default (no env key)", async () => {
    const skipped = await runSyncLatencyBenchmarkIfKeyed(probe, 3, {});
    expect(skipped).toBeUndefined();
  });

  it("runs when the env key is set", async () => {
    const r = await runSyncLatencyBenchmarkIfKeyed(probe, 3, { SOW_RUN_SYNC_LATENCY_BENCH: "1" });
    expect(r).toBeDefined();
    expect(r && isOk(r)).toBe(true);
  });
});

// ── makeSyncLatencyProbe — deps-injected probe (task 12.21) ──────────────────
//
// The probe under test is transport-free (closures only, no real gbrain / socket
// / clock) so every case below runs on plain fakes and an injected monotone
// clock. No real timer ever runs in this suite (evals forbidden-pattern #2).

/** A monotone clock: each call returns the current tick, then advances by `step`. */
function makeStepClock(step: number): { now: Clock; callCount: () => number } {
  let t = 0;
  let calls = 0;
  return {
    now: (): number => {
      const v = t;
      t += step;
      calls += 1;
      return v;
    },
    callCount: (): number => calls,
  };
}

/** A poll fn that reports true starting on its Nth call (1-indexed), false before. */
function resolvesOnPoll(n: number): (factId: string) => Promise<Result<boolean, string>> {
  let calls = 0;
  return (_factId: string): Promise<Result<boolean, string>> => {
    calls += 1;
    return Promise.resolve({ ok: true, value: calls >= n });
  };
}

/** Records every `sleep(ms)` call — proves the probe never reaches for a real timer. */
function makeSleepSpy(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    sleep: (ms: number): Promise<void> => {
      calls.push(ms);
      return Promise.resolve();
    },
    calls,
  };
}

const POLL_INTERVAL_MS = 1_000;
const GENEROUS_TIMEOUT_MS = 60_000;

describe("makeSyncLatencyProbe — deps-injected probe (task 12.21)", () => {
  it("times ONE trial with an injected monotone clock (exact computed durations)", async () => {
    const clock = makeStepClock(POLL_INTERVAL_MS);
    const deps: SyncLatencyProbeDeps = {
      commit: () => Promise.resolve({ ok: true, value: { factId: "fact-1" } }),
      searchVisible: resolvesOnPoll(3),
      readModelReflected: resolvesOnPoll(1),
      now: clock.now,
      sleep: () => Promise.resolve(),
      pollIntervalMs: POLL_INTERVAL_MS,
      timeoutMs: GENEROUS_TIMEOUT_MS,
    };
    const r = await makeSyncLatencyProbe(deps)();
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    // search-visible flips true on the 3rd poll → exactly 3 * pollIntervalMs since t0.
    expect(r.value.commitToSearchVisibleMs).toBe(3_000);
    // read-model flips true on the 1st poll → exactly 1 * pollIntervalMs since t0.
    expect(r.value.commitToReadModelMs).toBe(1_000);
  });

  it("measures both stages from the SAME commit — read-model resolves faster than search here", async () => {
    const clock = makeStepClock(POLL_INTERVAL_MS);
    const deps: SyncLatencyProbeDeps = {
      commit: () => Promise.resolve({ ok: true, value: { factId: "fact-1" } }),
      searchVisible: resolvesOnPoll(3),
      readModelReflected: resolvesOnPoll(1),
      now: clock.now,
      sleep: () => Promise.resolve(),
      pollIntervalMs: POLL_INTERVAL_MS,
      timeoutMs: GENEROUS_TIMEOUT_MS,
    };
    const r = await makeSyncLatencyProbe(deps)();
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    // Both stages are deltas off the SAME shared t0 (doc comment :44-52) — pinning
    // that invariant here, distinct from the exact-value pin above.
    expect(r.value.commitToReadModelMs).toBeLessThan(r.value.commitToSearchVisibleMs);
  });

  it("propagates a commit failure as a typed probe error (never throws)", async () => {
    const deps: SyncLatencyProbeDeps = {
      commit: () => Promise.resolve({ ok: false, error: "commit_failed" }),
      searchVisible: () => Promise.resolve({ ok: true, value: true }),
      readModelReflected: () => Promise.resolve({ ok: true, value: true }),
      now: () => 0,
      sleep: () => Promise.resolve(),
      pollIntervalMs: POLL_INTERVAL_MS,
      timeoutMs: GENEROUS_TIMEOUT_MS,
    };
    const r = await makeSyncLatencyProbe(deps)();
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error).toBe("commit_failed");
  });

  it("propagates a search-poll failure as a typed probe error", async () => {
    let readCalls = 0;
    const deps: SyncLatencyProbeDeps = {
      commit: () => Promise.resolve({ ok: true, value: { factId: "fact-1" } }),
      searchVisible: () => Promise.resolve({ ok: false, error: "search_poll_failed" }),
      readModelReflected: (): Promise<Result<boolean, string>> => {
        readCalls += 1;
        return Promise.resolve({ ok: true, value: true });
      },
      now: () => 0,
      sleep: () => Promise.resolve(),
      pollIntervalMs: POLL_INTERVAL_MS,
      timeoutMs: GENEROUS_TIMEOUT_MS,
    };
    const r = await makeSyncLatencyProbe(deps)();
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error).toBe("search_poll_failed");
    // the search-stage error short-circuits the trial before the read stage is ever polled.
    expect(readCalls).toBe(0);
  });

  it("returns err on stage timeout rather than hanging, naming the stage, with a bounded poll count", async () => {
    const clock = makeStepClock(POLL_INTERVAL_MS);
    const timeoutMs = 5_000;
    let searchCalls = 0;
    const deps: SyncLatencyProbeDeps = {
      commit: () => Promise.resolve({ ok: true, value: { factId: "fact-1" } }),
      searchVisible: (): Promise<Result<boolean, string>> => {
        searchCalls += 1;
        return Promise.resolve({ ok: true, value: false });
      },
      readModelReflected: resolvesOnPoll(1),
      now: clock.now,
      sleep: () => Promise.resolve(),
      pollIntervalMs: POLL_INTERVAL_MS,
      timeoutMs,
    };
    const r = await makeSyncLatencyProbe(deps)();
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error).toBe("timeout:gbrain_search_visibility");
    // Elapsed first exceeds the 5000ms timeout at the 6th poll (6 * 1000 > 5000) — the
    // loop TERMINATED at a bounded call count instead of hanging CI.
    expect(searchCalls).toBe(6);
  });

  it("never uses a real timer — sleeps via the injected fn, pollIntervalMs apart on the injected clock", async () => {
    const clock = makeStepClock(POLL_INTERVAL_MS);
    const sleepSpy = makeSleepSpy();
    const deps: SyncLatencyProbeDeps = {
      commit: () => Promise.resolve({ ok: true, value: { factId: "fact-1" } }),
      searchVisible: resolvesOnPoll(3),
      readModelReflected: resolvesOnPoll(1),
      now: clock.now,
      sleep: sleepSpy.sleep,
      pollIntervalMs: POLL_INTERVAL_MS,
      timeoutMs: GENEROUS_TIMEOUT_MS,
    };
    const r = await makeSyncLatencyProbe(deps)();
    expect(isOk(r)).toBe(true);
    // the injected sleep was actually invoked — never a real setTimeout ...
    expect(sleepSpy.calls.length).toBeGreaterThan(0);
    // ... and every poll waited exactly one pollIntervalMs on the injected clock.
    expect(sleepSpy.calls.every((ms) => ms === POLL_INTERVAL_MS)).toBe(true);
  });

  it("feeds runSyncLatencyBenchmark end-to-end for 5 trials, all within budget", async () => {
    const clock = makeStepClock(POLL_INTERVAL_MS);
    const deps: SyncLatencyProbeDeps = {
      commit: () => Promise.resolve({ ok: true, value: { factId: "fact-1" } }),
      searchVisible: () => Promise.resolve({ ok: true, value: true }),
      readModelReflected: () => Promise.resolve({ ok: true, value: true }),
      now: clock.now,
      sleep: () => Promise.resolve(),
      pollIntervalMs: POLL_INTERVAL_MS,
      timeoutMs: GENEROUS_TIMEOUT_MS,
    };
    // Proves makeSyncLatencyProbe actually satisfies the SyncLatencyProbe contract
    // (:162) — not just a lookalike shape — by composing it straight into the runner.
    const r = await runSyncLatencyBenchmark(makeSyncLatencyProbe(deps), 5);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.trials).toBe(5);
    expect(r.value.allWithinBudget).toBe(true);
  });

  it("stays skipped without the env key, even against the real factory", async () => {
    const deps: SyncLatencyProbeDeps = {
      commit: () => Promise.resolve({ ok: true, value: { factId: "fact-1" } }),
      searchVisible: () => Promise.resolve({ ok: true, value: true }),
      readModelReflected: () => Promise.resolve({ ok: true, value: true }),
      now: () => 0,
      sleep: () => Promise.resolve(),
      pollIntervalMs: POLL_INTERVAL_MS,
      timeoutMs: GENEROUS_TIMEOUT_MS,
    };
    const skipped = await runSyncLatencyBenchmarkIfKeyed(makeSyncLatencyProbe(deps), 3, {});
    expect(skipped).toBeUndefined();
  });
});
