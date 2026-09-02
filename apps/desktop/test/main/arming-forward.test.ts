import { describe, it, expect } from "vitest";
import {
  subscriptionArmForward,
  buildAutoIngestGateOpts,
  gbrainStartupVerifyForward,
  provenanceArmForward,
} from "../../worker-host/arming-forward";
import type { WorkerHostConfig as MainInjectedConfig } from "../../main/worker-supervisor";
import type { WorkerHostConfig as HostReceivedConfig } from "../../worker-host/index";

// 18.32 — the WORKER-HOST-side WorkerHostConfig → bootWorker forward mapping (a seam with zero coverage
// before this slice, and the integration point with 18.31's `AutoIngestGateOpts.egressAllowedProcessors`).
//
// Processor-AGNOSTIC by design: the desktop forwards `egressAllowedProcessors` as opaque owner-set strings and
// imports NO worker processor constant (the "claude-agent-sdk" → note semantic is owned worker-side — 18.33 /
// the phase-18.10 auto-ingest runbook; keeps this clear of the node-heavy-import trap, apps/desktop LESSONS §5).
// "claude-agent-sdk" below is PLAIN test data, not an imported symbol.
//
// Composition with 18.33 (brief 147 — the committed L64 armed-auto-ingest fake-completion dry-run harness):
// THIS slice pins desktop → the armed WorkerHostConfig shape; 18.33 pins the armed shape → a produced note.
// They compose ONLY via the shared `AutoIngestGateOpts` / `subscriptionArm` types (no desktop→worker runtime edge).
const BASE: HostReceivedConfig = {
  token: "tok",
  launchId: "l1",
  origins: ["app://sow"],
  hosts: ["127.0.0.1:47100"],
  apiHost: "127.0.0.1",
  apiPort: 47100,
};

describe("subscriptionArmForward — WorkerHostConfig → bootWorker conditional-spread", () => {
  it("omits subscriptionArm when unset (byte-equivalent bootWorker arg)", () => {
    expect(subscriptionArmForward(BASE)).toStrictEqual({});
    expect("subscriptionArm" in subscriptionArmForward(BASE)).toBe(false);
  });

  it("forwards the plain-data subscriptionArm verbatim when set", () => {
    expect(
      subscriptionArmForward({ ...BASE, subscriptionArm: { enabled: true, model: "claude-sonnet-5" } }),
    ).toStrictEqual({ subscriptionArm: { enabled: true, model: "claude-sonnet-5" } });
  });
});

describe("buildAutoIngestGateOpts — WorkerHostConfig → gateAutoIngest opts (18.31 egress forward)", () => {
  it("omits egressAllowedProcessors when unset (proof-spine EgressPolicy stays fail-closed-empty)", () => {
    expect("egressAllowedProcessors" in buildAutoIngestGateOpts(BASE)).toBe(false);
  });

  it("passes the plain-string allowlist straight through when set (no branding desktop-side)", () => {
    expect(
      buildAutoIngestGateOpts({ ...BASE, egressAllowedProcessors: ["claude-agent-sdk"] }).egressAllowedProcessors,
    ).toStrictEqual(["claude-agent-sdk"]);
  });

  it("forwards the existing auto-ingest knobs (autoIngest / ingestWorkspaceId / temporalAddress)", () => {
    const opts = buildAutoIngestGateOpts({
      ...BASE,
      autoIngest: true,
      ingestWorkspaceId: "personal-business",
      temporalAddress: "127.0.0.1:7233",
    });
    expect(opts.autoIngest).toBe(true);
    expect(opts.ingestWorkspaceId).toBe("personal-business");
    expect(opts.temporalAddress).toBe("127.0.0.1:7233");
  });
});

describe("gbrainStartupVerifyForward — WorkerHostConfig → bootWorker conditional-spread (11.3a)", () => {
  it("omits gbrainStartupVerify when unset (byte-equivalent bootWorker arg — the shipped default)", () => {
    expect(gbrainStartupVerifyForward(BASE)).toStrictEqual({});
    expect("gbrainStartupVerify" in gbrainStartupVerifyForward(BASE)).toBe(false);
  });

  it("forwards { gbrainStartupVerify: { pinPath } } when gbrainPinPath is set (mirrors subscriptionArmForward's shape)", () => {
    expect(
      gbrainStartupVerifyForward({ ...BASE, gbrainPinPath: "/repo/config/gbrain.pin" }),
    ).toStrictEqual({ gbrainStartupVerify: { pinPath: "/repo/config/gbrain.pin" } });
  });
});

// Test 5 — the two IPC-mirrored WorkerHostConfig interfaces (main/worker-supervisor.ts injects; worker-host
// receives) must stay structurally identical, else a field added to one but not the other silently drops
// across the fork channel. Uses the INVARIANT type-identity form (`(<T>() => …)`), NOT bare bidirectional
// assignability: assignability is blind to OPTIONAL-field drift (a missing `foo?:` is assignable both ways),
// and every field this slice mirrors is optional — so an assignability check would pass on exactly the drift
// it must catch. This form errors under tsc when the two interfaces differ in ANY field, incl. optional ones.
// `import type` is erased (no entry-module side effect). Enforced by `tsc -p tsconfig.node.json` (test/ is a root).
type TypeEquals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const INTERFACES_IN_SYNC: TypeEquals<MainInjectedConfig, HostReceivedConfig> = true;

describe("WorkerHostConfig IPC mirror", () => {
  it("both interfaces stay structurally in sync (compile-time pin)", () => {
    expect(INTERFACES_IN_SYNC).toBe(true);
  });
});

// ── task 20.1 — provenanceArmForward ─────────────────────────────────────────────────────────────
describe("provenanceArmForward — all three fields move together, or none do", () => {
  const BUNDLE = { signingKeyRef: "keychain://sow/kw-signing", pin: { gbrainTag: "0.35.1.0" } };

  it("NOT ARMED ⇒ {} — byte-equivalent to today's shipped boot", () => {
    // The unarmed path must be indistinguishable from this code not existing: no fields, no
    // construction, nothing for bootWorker to react to.
    expect(provenanceArmForward({ armed: false })).toStrictEqual({});
    // Defensive: armed-but-no-bundle is not a state `resolveProvenanceArming` can produce, but a
    // forwarder that trusted the flag alone would emit `provenanceServingOracle: undefined` and
    // change the shipped shape.
    expect(provenanceArmForward({ armed: true })).toStrictEqual({});
  });

  it("ARMED ⇒ all four fields, together", () => {
    // ⛔ THE PROPERTY. `copilotProvenanceStamping` + `provenanceServingOracle` CONSTRUCT the
    // loader-backed oracle; `copilotServingOracleGoLive` SELECTS it; `keychainSecrets` supplies
    // OFF-lock 2. Forwarding a subset yields a half-armed state that bootWorker treats as OFF while
    // reporting a different precondition set than the operator expects (`worker L52` split-brain).
    expect(provenanceArmForward({ armed: true, bundle: BUNDLE })).toStrictEqual({
      keychainSecrets: {},
      provenanceServingOracle: BUNDLE,
      copilotProvenanceStamping: true,
      copilotServingOracleGoLive: true,
    });
  });

  it("forwards the bundle BY REFERENCE — never a reconstruction", () => {
    // A forwarder that rebuilt the bundle could silently drop `resolveRunning` or `secrets`, which
    // are optional on the boot type and would fail SILENTLY (`contracts L15`).
    const out = provenanceArmForward({ armed: true, bundle: BUNDLE });
    expect(out["provenanceServingOracle"]).toBe(BUNDLE);
  });
});
