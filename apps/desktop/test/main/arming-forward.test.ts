import { describe, it, expect } from "vitest";
import { subscriptionArmForward, buildAutoIngestGateOpts } from "../../worker-host/arming-forward";
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
