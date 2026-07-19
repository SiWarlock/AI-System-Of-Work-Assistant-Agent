// OPEN-THE-GATES slice 1 (task 11.1) — the BOOT flag-gating for owner-opt-in auto-ingest. The pure
// `gateAutoIngest` helper augments `bootWorker` with { vaultWatch, proofSpineParams, temporalAddress } ONLY
// when the owner opt-in is ON AND a vaultRoot is present; every other combination is fail-safe `undefined`
// (⇒ today's exact degraded boot). Mirrors `gateCopilotVaultReadDeps`: the proof-spine builder is a thunk so
// it is NEVER constructed on the OFF path. `buildAutoIngestProofSpineParams` carries a REAL sourceIngestion
// binding (WS-2 bind to the configured workspace) + INERT meeting leaves (registered but never dispatched on
// the shipped path — the review confirms). The live fs.watch→Temporal→sourceIngestion path is the SOW_TEMPORAL=1
// suites; this file pins the config→wiring GATE + the binding.
import { describe, it, expect, vi } from "vitest";
import { processorId } from "@sow/contracts";
import {
  gateAutoIngest,
  buildAutoIngestProofSpineParams,
  DEFAULT_INGEST_WORKSPACE,
} from "../src/boot";
import type { ProofSpineParams } from "../src/composition/buildActivities";
import type { StubMeetingExtraction } from "../src/composition/backends";

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

// 18.10 (Lesson 28) — the truthy-not-`true` strict-arming REGRESSION GUARD. The combos block above
// covers true / false / undefined; this pins the MISSING case: a truthy-NON-`true` value — the shape
// an env/IPC-sourced flag actually arrives as (`"true"`, `1`, the L28-named `"false"` string, a
// truthy `{}`) — must NOT arm the (hard-line-adjacent) ingestion loop. The desktop worker-host passes
// `config.autoIngest` RAW (no host-side `=== true`), so `gateAutoIngest`'s strict `!== true` is the
// SOLE arming chokepoint — pinning it here covers the desktop activation path too. Behavioral cast
// test (a runtime seam exists — `gateAutoIngest` is directly callable), per L28.
describe("gateAutoIngest — L28 truthy-not-`true` strict-arming guard (18.10)", () => {
  it.each([
    { label: '"true" (string)', v: "true" as unknown as boolean },
    { label: "1 (number)", v: 1 as unknown as boolean },
    { label: '"false" (string — the L28-named case)', v: "false" as unknown as boolean },
    { label: "{} (truthy object)", v: {} as unknown as boolean },
  ])("auto_ingest_truthy_not_true_does_not_arm — autoIngest=$label ⇒ undefined + build NOT called", ({ v }) => {
    const build = vi.fn((_ws: string) => FAKE_PARAMS);
    const r = gateAutoIngest({ autoIngest: v, ingestWorkspaceId: WS }, "/vault", build);
    // A truthy-coerce must NOT arm the ingestion gate — fail-safe undefined, and the proof-spine
    // builder is NEVER invoked (no ProofSpineParams / in-memory revisions store constructed).
    expect(r).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
  });

  it("auto_ingest_literal_true_arms — positive control (co-located): ONLY strict `true` arms (non-vacuity, not a blanket deny)", () => {
    const build = vi.fn((_ws: string) => FAKE_PARAMS);
    const r = gateAutoIngest({ autoIngest: true, ingestWorkspaceId: WS }, "/vault", build);
    expect(r).toEqual({
      vaultWatch: { workspaceId: WS, sensitivity: "normal" },
      proofSpineParams: FAKE_PARAMS,
      temporalAddress: "127.0.0.1:7233",
    });
    expect(build).toHaveBeenCalledWith(WS);
  });
});

// CP-3b / 18.13b (#13 precondition) — the SOURCE stubExtraction SEAM. The broker's stub provider-runner output
// (`StubMeetingExtraction.candidateOutput`) is what an ARMED auto-ingest SOURCE run emits; today it is NOT threaded
// through `AutoIngestWiring`, so an armed source boots with the `assembleBackends` `{ candidateOutput: {} }` default
// and fails CLOSED at the schema gate (no note) — the boot.ts `buildAutoIngestProofSpineParams` VERIFICATION-OWED
// note. This threads the SEAM: `gateAutoIngest` forwards an owner-provided source stub into the wiring as
// `stubExtraction` — a BootConfig field the desktop worker-host already spreads → `bootWorker` → `assembleBackends`
// + `makeProofSpineRegisterHook`. Per the crossing ruling the DORMANT DEFAULT stays EMPTY: no stub is provisioned
// until arming, and the `outputSchemaId → sow:agent-extraction` switch that makes the stub normalize to an
// `agent_extraction` candidate (rather than the KMP stand-in ⇒ EMPTY ⇒ reject) is arming-bundle scope, NOT this
// slice. So the end-to-end "armed source passes the gate + commits a note" is reachability-WAIVERED (L11); this
// pins the SEAM + the byte-equivalent default + the AND-lock (a stub alone can NOT arm a disabled gate).
describe("gateAutoIngest — source stubExtraction seam (CP-3b/18.13b, #13 precondition)", () => {
  const SOURCE_STUB: StubMeetingExtraction = { candidateOutput: { agentExtraction: "sentinel" } };

  it("gate_threads_source_stub_when_provided — ON + a provided source stub ⇒ the wiring carries it (the #13 seam)", () => {
    const r = gateAutoIngest(
      { autoIngest: true, ingestWorkspaceId: WS },
      "/vault",
      () => FAKE_PARAMS,
      SOURCE_STUB,
    );
    // Threaded BY REFERENCE (→ config.stubExtraction → assembleBackends' stub provider-runner). The three prior
    // wiring fields are unchanged — the stub is purely additive.
    expect(r?.stubExtraction).toBe(SOURCE_STUB);
    expect(r?.vaultWatch).toEqual({ workspaceId: WS, sensitivity: "normal" });
    expect(r?.proofSpineParams).toBe(FAKE_PARAMS);
    expect(r?.temporalAddress).toBe("127.0.0.1:7233");
  });

  it("gate_omits_stub_by_default_byte_equivalent — ON + NO stub arg ⇒ wiring shape byte-identical to the shipped default (no stubExtraction key)", () => {
    const r = gateAutoIngest({ autoIngest: true, ingestWorkspaceId: WS }, "/vault", () => FAKE_PARAMS);
    // Byte-equivalent: the default (unprovisioned) wiring DEEP-EQUALS the EXACT prior 3-field shape via
    // `.toStrictEqual` (stricter than `.toEqual` — rejects an extra `stubExtraction: undefined` key), and the
    // `in`-check proves the key is OMITTED entirely (the conditional spread never sets it). The source stub is
    // EMPTY until the owner arms it.
    expect(r).toStrictEqual({
      vaultWatch: { workspaceId: WS, sensitivity: "normal" },
      proofSpineParams: FAKE_PARAMS,
      temporalAddress: "127.0.0.1:7233",
    });
    expect(r !== undefined && "stubExtraction" in r).toBe(false);
  });

  it("gate_off_path_ignores_stub — a provided stub can NOT arm a disabled gate (AND-lock: autoIngest===true still required)", () => {
    const build = vi.fn((_ws: string) => FAKE_PARAMS);
    // Opt-in OFF but a stub is supplied — the stub is INERT; the gate ANDs (opt-in ON + vaultRoot), so it stays
    // fail-safe undefined and the proof-spine builder is never invoked. A stub is not an arming knob.
    const r = gateAutoIngest({ autoIngest: false, ingestWorkspaceId: WS }, "/vault", build, SOURCE_STUB);
    expect(r).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
  });
});

// 18.31 — the auto-ingest EGRESS-ALLOWLIST seam. `AutoIngestGateOpts` gains an optional
// `egressAllowedProcessors`; `gateAutoIngest` threads it into `buildAutoIngestProofSpineParams`, which
// populates the proof-spine `EgressPolicy.allowedProcessors` AND `.rawContentAllowedProcessors` (source
// ingestion carries raw content ⇒ both). Default-empty ⇒ byte-equivalent to today (both lists []). Without
// this seam an armed subscription cloud `{runtime}` route is denied `PROCESSOR_NOT_ALLOWED`; the desktop
// forward (18.32) supplies the real value. This pins the GATE→proof-spine EgressPolicy threading; the
// assembled-broker consequence (allowlist is the operative veto gate) is in egress-veto-assembled.test.ts.
describe("gateAutoIngest — egress-allowlist seam (18.31, gate → proof-spine EgressPolicy)", () => {
  const AGENT_SDK = processorId("claude-agent-sdk");

  it("egress_allowlist_default_empty_is_byte_equivalent — ARMED but NO egressAllowedProcessors ⇒ proof-spine EgressPolicy both lists [] (identical to the pre-seam builder output)", () => {
    // spec(§5) — the dormant default stays fail-closed empty; byte-equivalent to today (Lessons 23/50).
    const r = gateAutoIngest(
      { autoIngest: true, ingestWorkspaceId: WS },
      "/vault",
      buildAutoIngestProofSpineParams,
    );
    const egress = r?.proofSpineParams.resolved.egressPolicy;
    expect(egress?.allowedProcessors).toStrictEqual([]);
    expect(egress?.rawContentAllowedProcessors).toStrictEqual([]);
    // The whole EgressPolicy is byte-identical to the pre-seam direct builder (default param []).
    expect(egress).toStrictEqual(buildAutoIngestProofSpineParams(WS).resolved.egressPolicy);
  });

  it("egress_allowlist_populates_both_processor_lists — egressAllowedProcessors:['claude-agent-sdk'] ⇒ BOTH allowedProcessors AND rawContentAllowedProcessors carry it", () => {
    // spec(§5) — source ingestion carries raw content, so the cloud processor must be in BOTH lists
    // (session 098 CP3 precondition: allowedProcessors AND rawContentAllowedProcessors).
    const r = gateAutoIngest(
      { autoIngest: true, ingestWorkspaceId: WS, egressAllowedProcessors: [AGENT_SDK] },
      "/vault",
      buildAutoIngestProofSpineParams,
    );
    const egress = r?.proofSpineParams.resolved.egressPolicy;
    expect(egress?.allowedProcessors).toStrictEqual([AGENT_SDK]);
    expect(egress?.rawContentAllowedProcessors).toStrictEqual([AGENT_SDK]);
    // Distinct array instances (no aliasing between the two lists).
    expect(egress?.allowedProcessors).not.toBe(egress?.rawContentAllowedProcessors);
  });

  it("egress_allowlist_empty_calls_thunk_single_arg_byte_equivalent — explicit [] routes to the SINGLE-arg thunk call (byte-equivalent to the pre-seam call); a non-empty list passes it as the 2nd arg (L23/L28/L57 arity pin)", () => {
    // The `.length > 0` guard keeps the default/empty path calling the thunk EXACTLY as the pre-seam code did
    // (single arg) so byte-equivalence is preserved BY CONSTRUCTION regardless of the injected thunk's impl — an
    // ARITY pin (L23/L28 factory-spy style), since with the real builder an explicit [] and a single-arg call are
    // output-indistinguishable (a value assertion can't see the branch). Guards against a future "simplify to
    // always pass `?? []`" that would move byte-equivalence from by-construction to by-callee-behavior (L57).
    const build = vi.fn((_ws: string, _allow?: readonly string[]) => FAKE_PARAMS);
    gateAutoIngest({ autoIngest: true, ingestWorkspaceId: WS, egressAllowedProcessors: [] }, "/vault", build);
    expect(build).toHaveBeenCalledWith(WS); // exactly one arg — an empty allowlist adds NO 2nd arg
    expect(build.mock.calls[0]).toHaveLength(1);

    build.mockClear();
    gateAutoIngest({ autoIngest: true, ingestWorkspaceId: WS, egressAllowedProcessors: [AGENT_SDK] }, "/vault", build);
    expect(build).toHaveBeenCalledWith(WS, [AGENT_SDK]); // non-empty ⇒ passed as the 2nd arg
  });
});
