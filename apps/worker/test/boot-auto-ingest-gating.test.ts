// OPEN-THE-GATES slice 1 (task 11.1) — the BOOT flag-gating for owner-opt-in auto-ingest. The pure
// `gateAutoIngest` helper augments `bootWorker` with { vaultWatch, proofSpineParams, temporalAddress } ONLY
// when the owner opt-in is ON AND a vaultRoot is present; every other combination is fail-safe `undefined`
// (⇒ today's exact degraded boot). Mirrors `gateCopilotVaultReadDeps`: the proof-spine builder is a thunk so
// it is NEVER constructed on the OFF path. `buildAutoIngestProofSpineParams` carries a REAL sourceIngestion
// binding (WS-2 bind to the configured workspace) + INERT meeting leaves (registered but never dispatched on
// the shipped path — the review confirms). The live fs.watch→Temporal→sourceIngestion path is the SOW_TEMPORAL=1
// suites; this file pins the config→wiring GATE + the binding.
import { describe, it, expect, vi } from "vitest";
import {
  gateAutoIngest,
  buildAutoIngestProofSpineParams,
  DEFAULT_INGEST_WORKSPACE,
} from "../src/boot";
import type { ProofSpineParams } from "../src/composition/buildActivities";

const WS = "personal-business";
// A sentinel the injected builder returns — the gate tests only care that it's threaded, not its shape.
const FAKE_PARAMS = { sentinel: "proof-spine" } as unknown as ProofSpineParams;

describe("gateAutoIngest — auto-ingest boot gating (fail-safe, default OFF)", () => {
  // spec(§13/§16) — the wiring is built IFF autoIngest === true AND vaultRoot is present; every other combo is
  // fail-safe undefined, and the proof-spine builder is NEVER invoked (no ProofSpineParams constructed OFF-path).
  const combos: ReadonlyArray<{ flag?: boolean; root?: string; wired: boolean }> = [
    { flag: true, root: "/vault", wired: true }, // opt-in ON + vaultRoot → WIRED
    { flag: false, root: "/vault", wired: false }, // opt-in explicitly off
    { flag: undefined, root: "/vault", wired: false }, // opt-in absent (default OFF)
    { flag: true, root: undefined, wired: false }, // no vaultRoot (owner runtime precondition)
    { flag: false, root: undefined, wired: false }, // both off
  ];

  it.each(combos)("autoIngest=$flag vaultRoot=$root ⇒ wired=$wired", ({ flag, root, wired }) => {
    const build = vi.fn((_ws: string) => FAKE_PARAMS);
    const r = gateAutoIngest({ autoIngest: flag, ingestWorkspaceId: WS }, root, build);
    if (wired) {
      expect(r).toEqual({
        vaultWatch: { workspaceId: WS, sensitivity: "normal" },
        proofSpineParams: FAKE_PARAMS,
        temporalAddress: "127.0.0.1:7233",
      });
      expect(build).toHaveBeenCalledWith(WS); // proof-spine built for the configured workspace
    } else {
      expect(r).toBeUndefined();
      expect(build).not.toHaveBeenCalled(); // fail-safe: no ProofSpineParams constructed on the OFF path
    }
  });

  it("auto_ingest_vaultwatch_carries_workspace_and_sensitivity — configured ws + explicit sensitivity", () => {
    const r = gateAutoIngest(
      { autoIngest: true, ingestWorkspaceId: "ws-x", ingestSensitivity: "confidential" },
      "/vault",
      () => FAKE_PARAMS,
    );
    expect(r?.vaultWatch).toEqual({ workspaceId: "ws-x", sensitivity: "confidential" });
  });

  it("auto_ingest defaults workspace + sensitivity + temporalAddress when unset", () => {
    let builtFor: string | null = null;
    const r = gateAutoIngest({ autoIngest: true }, "/vault", (ws) => {
      builtFor = ws;
      return FAKE_PARAMS;
    });
    expect(builtFor).toBe(DEFAULT_INGEST_WORKSPACE);
    expect(r?.vaultWatch).toEqual({ workspaceId: DEFAULT_INGEST_WORKSPACE, sensitivity: "normal" });
    expect(r?.temporalAddress).toBe("127.0.0.1:7233");
  });

  it("auto_ingest honors a configured temporalAddress", () => {
    const r = gateAutoIngest({ autoIngest: true, temporalAddress: "127.0.0.1:9999" }, "/vault", () => FAKE_PARAMS);
    expect(r?.temporalAddress).toBe("127.0.0.1:9999");
  });
});

describe("buildAutoIngestProofSpineParams — real sourceIngestion binding + inert meeting leaves", () => {
  it("auto_ingest_proofspine_binds_configured_workspace — sourceIngestion.boundWorkspaceId = configured ws", () => {
    // spec(WS-8) the source-ingestion binding is bound BY POLICY to the configured workspace (never content-inferred).
    const p = buildAutoIngestProofSpineParams("ws-target");
    expect(String(p.sourceIngestion?.boundWorkspaceId)).toBe("ws-target");
    expect(p.sourceIngestion?.sourceRef.sourceId).toBeTruthy(); // REQ-F-006 ≥1 sourceRef
    expect(p.sourceIngestion?.planIdentity).toBeTruthy(); // stable plan-identity seed
  });

  it("meeting leaves are INERT + deterministic (fixed inert binding; a fresh in-memory revisions store)", () => {
    // The meeting flow is registered-but-never-dispatched on the shipped path — its leaves are fixed inert
    // constants (deterministic across calls), and `revisions` is a fresh in-memory store (NOT the durable path).
    const a = buildAutoIngestProofSpineParams("ws-target");
    const b = buildAutoIngestProofSpineParams("ws-target");
    expect(a.meetingJobInputs).toEqual(b.meetingJobInputs);
    expect(a.commit.actor).toBe(b.commit.actor);
    expect(typeof a.revisions.record).toBe("function");
    expect(typeof a.revisions.getByIdempotencyKey).toBe("function");
  });
});
