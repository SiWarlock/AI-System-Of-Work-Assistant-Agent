import { describe, it, expect } from "vitest";
import { readWorkerArmingEnv } from "../../main/worker-arming-env";

// 18.32 — the MAIN-side env → WorkerHostConfig arming slice (Path-β, dormant/default-OFF).
// Pure + electron-free (apps/desktop LESSONS §3): compiles under tsconfig.node.json, no window/electron
// import reaches this test. These pin the env-parsing acceptance bullets; the worker-host-side forward
// (config → bootWorker/gateAutoIngest) is pinned separately in arming-forward.test.ts.
describe("readWorkerArmingEnv — main-side env → WorkerHostConfig arming slice", () => {
  it('SOW_LINEAR_WRITES: strict ("1"/"true" only), plain data, and ABSENT when unset (Linear slice 2)', () => {
    // The owner switch for real Linear writes. Absent ⇒ no key at all (byte-equivalent); any other
    // value ⇒ explicitly disabled, never a truthy-coerce (worker L28).
    expect("linearWrites" in readWorkerArmingEnv({})).toBe(false);
    expect(readWorkerArmingEnv({ SOW_LINEAR_WRITES: "true" }).linearWrites).toStrictEqual({ enabled: true });
    expect(readWorkerArmingEnv({ SOW_LINEAR_WRITES: "1" }).linearWrites).toStrictEqual({ enabled: true });
    for (const v of ["TRUE", "yes", "on", "false", "0", " true"]) {
      expect(readWorkerArmingEnv({ SOW_LINEAR_WRITES: v }).linearWrites, v).toStrictEqual({ enabled: false });
    }
  });

  it("omits the new keys entirely when no arming env is set (byte-equivalent dormancy)", () => {
    expect(readWorkerArmingEnv({})).toStrictEqual({});
    expect("subscriptionArm" in readWorkerArmingEnv({})).toBe(false);
    expect("egressAllowedProcessors" in readWorkerArmingEnv({})).toBe(false);
  });

  it("populates subscriptionArm with plain data only (no thunks) when armed with a model", () => {
    const out = readWorkerArmingEnv({
      SOW_SUBSCRIPTION_ARM: "1",
      SOW_SUBSCRIPTION_MODEL: "claude-sonnet-5",
    });
    expect(out.subscriptionArm).toStrictEqual({ enabled: true, model: "claude-sonnet-5" });
    // IPC-safe (§19.5): the structured-clone channel can carry no function deps.
    expect("makeCompletion" in (out.subscriptionArm ?? {})).toBe(false);
    expect("checkReachable" in (out.subscriptionArm ?? {})).toBe(false);
  });

  it('strict-parses SOW_SUBSCRIPTION_ARM (only "1"/"true" arm; truthy-not-true never arms — worker L28)', () => {
    expect(readWorkerArmingEnv({ SOW_SUBSCRIPTION_ARM: "1" }).subscriptionArm).toStrictEqual({ enabled: true });
    expect(readWorkerArmingEnv({ SOW_SUBSCRIPTION_ARM: "true" }).subscriptionArm).toStrictEqual({ enabled: true });
    expect(readWorkerArmingEnv({ SOW_SUBSCRIPTION_ARM: "false" }).subscriptionArm).toStrictEqual({ enabled: false });
    expect(readWorkerArmingEnv({ SOW_SUBSCRIPTION_ARM: "TRUE" }).subscriptionArm).toStrictEqual({ enabled: false });
    expect(readWorkerArmingEnv({ SOW_SUBSCRIPTION_ARM: "0" }).subscriptionArm).toStrictEqual({ enabled: false });
    // absent ⇒ the whole subscriptionArm key is omitted (not { enabled: false }).
    expect("subscriptionArm" in readWorkerArmingEnv({})).toBe(false);
  });

  it("trims SOW_SUBSCRIPTION_MODEL and treats empty/whitespace as absent (no blank model forwarded)", () => {
    // whitespace-only model, no arm ⇒ nothing to arm + no model ⇒ subscriptionArm omitted entirely.
    expect("subscriptionArm" in readWorkerArmingEnv({ SOW_SUBSCRIPTION_MODEL: "   " })).toBe(false);
    // armed + whitespace model ⇒ armed, model dropped (empty-after-trim).
    expect(
      readWorkerArmingEnv({ SOW_SUBSCRIPTION_ARM: "1", SOW_SUBSCRIPTION_MODEL: "  " }).subscriptionArm,
    ).toStrictEqual({ enabled: true });
    // a present model is trimmed.
    expect(
      readWorkerArmingEnv({ SOW_SUBSCRIPTION_ARM: "1", SOW_SUBSCRIPTION_MODEL: "  claude-sonnet-5  " })
        .subscriptionArm,
    ).toStrictEqual({ enabled: true, model: "claude-sonnet-5" });
  });

  it("emits a dormant subscriptionArm when a model is set WITHOUT the arm flag (enabled:false, model preserved)", () => {
    // Path-β design: a model without the arm flag is preserved but dormant (worker gates on enabled === true).
    expect(readWorkerArmingEnv({ SOW_SUBSCRIPTION_MODEL: "claude-sonnet-5" }).subscriptionArm).toStrictEqual({
      enabled: false,
      model: "claude-sonnet-5",
    });
  });

  it("comma-splits SOW_EGRESS_ALLOWED_PROCESSORS (trim, drop empties); empty/whitespace/unset ⇒ omitted", () => {
    expect(
      readWorkerArmingEnv({ SOW_EGRESS_ALLOWED_PROCESSORS: "claude-agent-sdk, foo" }).egressAllowedProcessors,
    ).toStrictEqual(["claude-agent-sdk", "foo"]);
    // empty string ⇒ omitted, never [""].
    expect("egressAllowedProcessors" in readWorkerArmingEnv({ SOW_EGRESS_ALLOWED_PROCESSORS: "" })).toBe(false);
    // all-empty segments ⇒ omitted.
    expect("egressAllowedProcessors" in readWorkerArmingEnv({ SOW_EGRESS_ALLOWED_PROCESSORS: "  , ," })).toBe(false);
    expect("egressAllowedProcessors" in readWorkerArmingEnv({})).toBe(false);
  });
});
