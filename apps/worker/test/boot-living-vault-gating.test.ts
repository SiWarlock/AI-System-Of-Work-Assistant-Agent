// spec(§6 KN-10 / §19.5 arming) — 13.8d: the living-vault rewrite ships DORMANT.
//
// The arming decision lives at the composition root, behind a pure gate helper (the shape established by
// `gateCopilotVaultReadDeps` / `gateAutoIngest`): the worker's own dormancy discipline is that a built-but-
// unarmed capability must construct NOTHING at boot, so the OFF path is byte-equivalent to a build where
// the capability does not exist. The `build` thunk is therefore invoked ONLY on the armed path.
//
// STRICT `=== true` (worker L28 / knowledge L2): the flag arrives from config that is ultimately
// env/IPC-derived, where `"true"` (string), `1`, and `"false"` are all TRUTHY. A truthy-non-`true` value
// arming a capability that mutates the vault is precisely the false-green vector those lessons exist to
// close, so anything that is not the boolean `true` leaves the capability inert.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, workspaceId, sourceId } from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";
import type { EntityGbrainReadPort, SynthesisReasonPort } from "@sow/knowledge";
import type { ValidatedExtraction, SourceNoteIdentity } from "@sow/workflows";
import { gateLivingVaultRewrite, withLivingVaultRewrite } from "../src/boot";
import type { ProofSpineParams } from "../src/composition/buildActivities";

const VAULT = "/tmp/sow-test-vault";

describe("gateLivingVaultRewrite — dormant by default (13.8d)", () => {
  it("boot_default_leaves_flag_off — flag ABSENT ⇒ undefined, and the thunk is never invoked", () => {
    let built = 0;
    const wiring = gateLivingVaultRewrite({ vaultRoot: VAULT }, () => {
      built += 1;
      return { bound: true };
    });
    expect(wiring).toBeUndefined();
    // Not merely "returns undefined" — the capability's deps are never CONSTRUCTED on the shipped path.
    expect(built).toBe(0);
  });

  it("strict_true_only — every truthy-non-true value leaves it inert", () => {
    const truthyImposters: unknown[] = [false, "true", "false", 1, 0, "", null, undefined, {}];
    for (const value of truthyImposters) {
      let built = 0;
      const wiring = gateLivingVaultRewrite(
        { livingVaultRewrite: value as boolean | undefined, vaultRoot: VAULT },
        () => {
          built += 1;
          return { bound: true };
        },
      );
      expect(wiring, `value ${JSON.stringify(value)} must not arm`).toBeUndefined();
      expect(built).toBe(0);
    }
  });

  it("armed_requires_a_vault_root — flag true but no vaultRoot ⇒ inert (fail-safe)", () => {
    let built = 0;
    const wiring = gateLivingVaultRewrite({ livingVaultRewrite: true }, () => {
      built += 1;
      return { bound: true };
    });
    expect(wiring).toBeUndefined();
    expect(built).toBe(0);
  });

  it("armed_builds_once — flag strictly true + a vaultRoot ⇒ the thunk runs with the narrowed root", () => {
    const roots: string[] = [];
    const wiring = gateLivingVaultRewrite(
      { livingVaultRewrite: true, vaultRoot: VAULT },
      (vaultRoot) => {
        roots.push(vaultRoot);
        return { bound: true };
      },
    );
    expect(wiring).toEqual({ bound: true });
    expect(roots).toEqual([VAULT]);
  });
});

// ── task ARM-RESEARCH-3 — the bootWorker CALL SITE `gateLivingVaultRewrite` never had. Drives the REAL
// `withLivingVaultRewrite` (the exact function `bootWorker` calls, not a re-derivation) so dormancy is
// pinned BY RUNNING the composition, never by asserting a constant — mirroring worker Lesson 59's
// "dormant must be observationally identical to not having the capability, proven by running the
// unarmed activity" discipline. `stubParams` deliberately carries NONE of ProofSpineParams' other
// fields real — `withLivingVaultRewrite` only ever reads/writes `.livingVault`, so a minimal stub is
// the correct fixture, not an omission.
describe("withLivingVaultRewrite — the bootWorker call site (task ARM-RESEARCH-3)", () => {
  const stubParams = {} as unknown as ProofSpineParams;
  const WS: WorkspaceId = workspaceId("ws-lv");
  const fakeGbrain: EntityGbrainReadPort = { workspaceId: WS, findCandidates: () => Promise.resolve(ok([])) };
  const fakeReason: SynthesisReasonPort = { reason: () => Promise.resolve({}) };

  it("flag ABSENT ⇒ SourceIngestionDeps.livingVault (ProofSpineParams.livingVault) is undefined — pinned BY RUNNING withLivingVaultRewrite, not by asserting gateLivingVaultRewrite alone", () => {
    const result = withLivingVaultRewrite(stubParams, {}, undefined);
    expect(result).toBeDefined();
    expect(result?.livingVault).toBeUndefined();
  });

  it("flag=== true + vaultRoot present BUT providers ABSENT ⇒ STILL undefined — the THIRD independent OFF-lock (flag+vaultRoot alone can never arm a real adapter)", () => {
    const result = withLivingVaultRewrite(
      stubParams,
      { livingVaultRewrite: true, vaultRoot: VAULT },
      undefined, // providers OMITTED — the shipped-default state even if the flag were somehow set
    );
    expect(result?.livingVault).toBeUndefined();
  });

  it("flag strictly === true + a vaultRoot + providers ALL present ⇒ a NON-DEGENERATE SourceLivingVaultPort is bound (real, callable, wired to the injected providers — not a stub)", async () => {
    let gbrainCalls = 0;
    let reasonCalls = 0;
    const observingGbrain: EntityGbrainReadPort = {
      workspaceId: WS,
      findCandidates: (...args) => {
        gbrainCalls += 1;
        return fakeGbrain.findCandidates(...args);
      },
    };
    const observingReason: SynthesisReasonPort = {
      reason: (...args) => {
        reasonCalls += 1;
        return fakeReason.reason(...args);
      },
    };
    // A REAL, on-disk directory — createLivingVaultPort realpath-resolves the vault root for
    // containment (unlike the pure-gate tests above, this exercises the actual fs check).
    const realVaultRoot = mkdtempSync(join(tmpdir(), "sow-lv-gate-"));
    const result = withLivingVaultRewrite(
      stubParams,
      { livingVaultRewrite: true, vaultRoot: realVaultRoot },
      { gbrain: observingGbrain, reason: observingReason },
    );
    expect(result?.livingVault).toBeDefined();
    expect(typeof result?.livingVault?.rewrite).toBe("function");
    // NON-DEGENERATE: actually drive it (this is what `createLivingVaultActivity(undefined)`'s dormant
    // `ok([])` stub can NEVER do — it invokes zero deps). A real adapter reaches the injected reason
    // port (the pure planner's SENSE step) on a genuine run.
    const validated = { validated: true, fields: {} } as unknown as ValidatedExtraction;
    const source: SourceNoteIdentity = { sourceId: sourceId("src-lv-1"), contentHash: "hash:lv-1" };
    const rewriteResult = await result!.livingVault!.rewrite(validated, WS, source);
    expect(rewriteResult.ok).toBe(true); // an empty synthesis candidate yields an empty (not failed) plan set
    expect(reasonCalls).toBeGreaterThan(0); // the injected reason port was genuinely invoked
  });
});
