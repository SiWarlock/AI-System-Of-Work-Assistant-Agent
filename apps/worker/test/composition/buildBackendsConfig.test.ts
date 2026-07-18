// 18.18a / flip-wiring (worker) — the NON-gated drop-regression guard for `buildBackendsConfig`.
//
// `bootWorker` reconstructs `backendsConfig` by forwarding a SUBSET of the BootConfig fields; before
// this slice `config.providerTransport` was SILENTLY DROPPED (boot.ts:1157-1165), so an owner-armed
// `ProviderTransportGate` never reached `selectProviderRunner`/`selectHealthSources`. This pure
// config-builder unit test is the LOAD-BEARING forward pin — it runs in DEFAULT CI (no SOW_API boot),
// unlike the behavioral broker-routing assertion (SOW_API-gated, skipped in preflight).
import { describe, it, expect } from "vitest";
import { buildBackendsConfig, type BootConfig } from "../../src/boot";
import type { ProviderTransportGate } from "../../src/composition/provider-runner";
import type { ProviderRunner } from "@sow/providers";

// The builder only READS a handful of optional BootConfig fields; a cast minimal object suffices (the
// required live-boot deps — sessionToken/allowlist/triageDispatch/dispatchApproval — are never touched).
const bootConfig = (partial: Partial<BootConfig>): BootConfig => partial as unknown as BootConfig;

describe("buildBackendsConfig — the flip-wiring forward pin (18.18a)", () => {
  it("armed_providerTransport_forwards_into_backendsConfig — an owner-set gate REACHES assembleBackends (the drop-fix)", () => {
    const gate: ProviderTransportGate = { enabled: true, make: (): ProviderRunner => ({}) as unknown as ProviderRunner };
    const cfg = buildBackendsConfig(bootConfig({ providerTransport: gate }));
    // SAME reference forwarded through — not cloned, not dropped. This is the whole point of the slice.
    expect(cfg.providerTransport).toBe(gate);
  });

  it("unset_providerTransport_is_byte_equivalent — the key is ABSENT (⇒ the deterministic stub runner via selectProviderRunner)", () => {
    const cfg = buildBackendsConfig(bootConfig({}));
    // Not merely `undefined` but ABSENT (conditional-spread) ⇒ backendsConfig is byte-equivalent to
    // pre-slice, so `selectProviderRunner(config.providerTransport, stub)` returns the EXACT stub.
    expect("providerTransport" in cfg).toBe(false);
    // Byte-equivalence pin: with every optional field unset the builder yields the empty config (L57
    // .toStrictEqual — non-vacuous: a leaked/force-forwarded key would fail here).
    expect(cfg).toStrictEqual({});
  });

  it("forward_coexists_with_sibling_fields — arming does not clobber the other forwarded BootConfig fields", () => {
    const gate: ProviderTransportGate = { enabled: true, make: (): ProviderRunner => ({}) as unknown as ProviderRunner };
    const now = (): string => "2026-07-18T00:00:00.000Z";
    const cfg = buildBackendsConfig(bootConfig({ dbPath: "/tmp/x.db", now, providerTransport: gate }));
    expect(cfg.providerTransport).toBe(gate);
    expect(cfg.dbPath).toBe("/tmp/x.db");
    expect(cfg.now).toBe(now);
  });
});
