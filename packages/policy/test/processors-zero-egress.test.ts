// spec(§5) — task 9.22 (Option C): the two-axis "is this workspace pinned to
// zero egress?" predicates. `zeroEgressOnly` is a POSITIVE SAFETY CLAIM rendered
// to a human as "your content stays on this machine", so it is true ONLY when
// BOTH axes hold and false for everything ambiguous:
//
//   axis 1 — ROUTING pins local: the matrix is NON-VACUOUS (at least one allowed
//            provider AND at least one capability route) AND
//            `allowedProviders ⊆ LOCAL_PROVIDERS` AND every `capabilityDefaults`
//            route is genuinely loopback-local (`processorOfRoute(route) === null`
//            — the PROOF, never the `egressClass` CLAIM) AND
//            `rawCloudEgressEnabled === false`.
//   axis 2 — NO DESTINATION is approved: both egress allowlists are EMPTY.
//
// The non-vacuity requirement is the owner's third conjunct: without it an EMPTY
// matrix satisfies axis 1 vacuously, and since the same absence also empties the
// allowlists, ONE missing event would satisfy BOTH axes — collapsing the two-axis
// design into the single-axis one it was chosen over.
//
// ⛔ Axis 2 is EMPTINESS, not local-membership — the correction this whole task
// exists for. The argument (why an empty allowlist is the STRONGEST zero-egress
// state, and why `["ollama"]` in an EGRESS allowlist can only mean a REMOTE
// ollama) is stated ONCE, beside the code, in `src/processors.ts` above
// `everyProviderIsLocal`. Read it there; it is deliberately not restated here,
// because two copies of a load-bearing argument diverge.
import { describe, it, expect } from "vitest";
import { processorId, validWorkspace, workspaceId } from "@sow/contracts";
import type { EgressPolicy, ProcessorId, ProviderMatrix, ProviderRoute } from "@sow/contracts";
import * as processorsModule from "../src/processors";
import {
  hasNoApprovedEgressDestination,
  isLocalOnlyProviderMatrix,
  isZeroEgressOnlyWorkspace,
} from "../src/processors";

// ── builders ─────────────────────────────────────────────────────────────────
const WS = workspaceId("ws-zero-egress");

const route = (
  identity: { provider: string } | { runtime: string },
  endpoint: string,
  egressClass: "local" | "cloud",
): ProviderRoute => ({ ...identity, model: "m", endpoint, egressClass }) as unknown as ProviderRoute;

const defaults = (
  entries: Record<string, ProviderRoute>,
): ProviderMatrix["capabilityDefaults"] => entries as ProviderMatrix["capabilityDefaults"];

const matrix = (over: Partial<ProviderMatrix> = {}): ProviderMatrix => ({
  workspaceId: WS,
  allowedProviders: [],
  capabilityDefaults: defaults({}),
  rawCloudEgressEnabled: false,
  ...over,
});

const policy = (over: Partial<EgressPolicy> = {}): EgressPolicy => ({
  workspaceId: WS,
  allowedProcessors: [],
  rawContentAllowedProcessors: [],
  employerRawEgressAcknowledged: false,
  ...over,
});

const ids = (...names: string[]): ProcessorId[] => names.map((n) => processorId(n));

// A genuinely non-egress route: local provider + loopback endpoint (proof, not claim).
const LOOPBACK_OLLAMA = route({ provider: "ollama" }, "http://127.0.0.1:11434", "local");
// The tunneled-local hole: claims 'local', points somewhere remote.
const TUNNELED_LOCAL = route({ provider: "ollama" }, "https://ollama.example.com", "local");

/**
 * A CONFIGURED local matrix — the only shape that can legitimately claim
 * local-only under the third conjunct. Used wherever a test means to break
 * exactly ONE thing: build from here and override the single field under test, so
 * the assertion cannot pass for the unrelated reason that the matrix was empty.
 */
const localMatrix = (over: Partial<ProviderMatrix> = {}): ProviderMatrix =>
  matrix({
    allowedProviders: ["ollama"],
    capabilityDefaults: defaults({ "meeting.close": LOOPBACK_OLLAMA }),
    ...over,
  });

// ── axis 1 — routing pins local ──────────────────────────────────────────────
describe("isLocalOnlyProviderMatrix — axis 1 (9.22 option C)", () => {
  it("local_matrix_is_local_only", () => {
    expect(
      isLocalOnlyProviderMatrix(
        matrix({
          allowedProviders: ["ollama", "lm_studio"],
          capabilityDefaults: defaults({ "meeting.close": LOOPBACK_OLLAMA }),
        }),
      ),
    ).toBe(true);
  });

  it("an_unconfigured_matrix_claims_nothing", () => {
    // ⭐ THE THIRD CONJUNCT (owner ruling). `[] ⊆ LOCAL_PROVIDERS` and "no routes"
    // are both VACUOUSLY satisfied, so without a liveness requirement an empty
    // matrix would claim local-only. It must not: the app does not yet know what
    // this workspace routes, and not-knowing may never render as reassurance.
    //
    // Each half is independently disqualifying, because each is independently
    // vacuous — a provider-listed-but-routeless matrix routes NOTHING, and a
    // routed matrix with no allowed providers is equally unconfigured.
    expect(isLocalOnlyProviderMatrix(matrix())).toBe(false);
    expect(isLocalOnlyProviderMatrix(localMatrix({ allowedProviders: [] }))).toBe(false);
    expect(isLocalOnlyProviderMatrix(localMatrix({ capabilityDefaults: defaults({}) }))).toBe(false);
  });

  it("cloud_provider_in_allowed_providers_defeats_it", () => {
    // Built from a CONFIGURED local matrix so the provider list is the only thing
    // wrong — otherwise this would pass on the unconfigured conjunct instead.
    expect(isLocalOnlyProviderMatrix(localMatrix({ allowedProviders: ["claude"] }))).toBe(false);
    // ALL, not ANY — one cloud id is enough however many local ones accompany it.
    expect(
      isLocalOnlyProviderMatrix(
        localMatrix({ allowedProviders: ["ollama", "lm_studio", "claude"] }),
      ),
    ).toBe(false);
  });

  it("research_and_cloud_providers_are_never_local", () => {
    // §ARM-RESEARCH structural invariant, asserted from the CONSUMING side:
    // perplexity/xai are cloud processors, each its own — listing either as local
    // would make an employer-work ack-OFF job silently egress instead of failing
    // closed (safety rule 5).
    //
    // The ids are typed `ProviderId`, so a typo cannot make this pass by naming a
    // provider that does not exist; and the POSITIVE CONTROL below proves the
    // predicate can still say `true`, so "false for everything" cannot satisfy it.
    const cloud: ProviderMatrix["allowedProviders"] = [
      "claude",
      "openai",
      "openrouter",
      "perplexity",
      "xai",
    ];
    for (const p of cloud) {
      expect(
        isLocalOnlyProviderMatrix(localMatrix({ allowedProviders: [p] })),
        `${p} must not read as local`,
      ).toBe(false);
    }
    const local: ProviderMatrix["allowedProviders"] = ["ollama", "lm_studio"];
    for (const p of local) {
      expect(
        isLocalOnlyProviderMatrix(localMatrix({ allowedProviders: [p] })),
        `${p} is the positive control — it must read as local`,
      ).toBe(true);
    }
  });

  it("raw_cloud_egress_enabled_defeats_it", () => {
    expect(isLocalOnlyProviderMatrix(localMatrix({ rawCloudEgressEnabled: true }))).toBe(false);
    // STRICT === false: a missing/non-boolean flag is not a verified 'off'.
    expect(
      isLocalOnlyProviderMatrix(
        localMatrix({ rawCloudEgressEnabled: undefined as unknown as boolean }),
      ),
    ).toBe(false);
  });

  it("non_loopback_capability_route_defeats_it", () => {
    // The routing PROOF is processorOfRoute() === null, never the egressClass claim.
    expect(
      isLocalOnlyProviderMatrix(
        matrix({
          allowedProviders: ["ollama"],
          capabilityDefaults: defaults({ "meeting.close": TUNNELED_LOCAL }),
        }),
      ),
    ).toBe(false);
    expect(
      isLocalOnlyProviderMatrix(
        matrix({
          allowedProviders: ["ollama"],
          capabilityDefaults: defaults({
            "meeting.close": LOOPBACK_OLLAMA,
            "source.extract": route({ provider: "claude" }, "https://api.anthropic.com", "cloud"),
          }),
        }),
      ),
    ).toBe(false);
  });

  it("sparse_allowed_providers_is_not_local_only", () => {
    // `Array.prototype.every` SKIPS HOLES, so a bare `.every` would report a
    // 3-hole array as all-local and mint a safety claim out of junk. A hole is
    // malformed input, and malformed never yields a positive claim.
    expect(
      isLocalOnlyProviderMatrix(
        localMatrix({ allowedProviders: new Array(3) as ProviderMatrix["allowedProviders"] }),
      ),
    ).toBe(false);
    const withHole = ["ollama", undefined, "lm_studio"] as unknown as ProviderMatrix["allowedProviders"];
    delete withHole[1];
    expect(isLocalOnlyProviderMatrix(localMatrix({ allowedProviders: withHole }))).toBe(false);
  });

  it("an_under_reported_length_cannot_hide_a_cloud_provider", () => {
    // The scan is bounded by `length`, so anything that UNDER-reports it leaves the
    // tail unexamined and mints a local-only claim over a cloud member. A real
    // Array cannot do this — `length` is a non-configurable own property, so even
    // an Array subclass can't shadow it — but `Array.isArray` pierces a Proxy to
    // its target, so a proxied array can. Malformed ⇒ false, same as a hole.
    //
    // ⚠ The under-report must be NON-ZERO, or this test pins nothing. A `length → 0`
    // proxy is rejected earlier by the non-vacuity conjunct and never reaches the
    // length-consistency check — leaving that check, the only thing standing
    // between an under-reporting array-like and a spurious local-only claim, with
    // zero coverage while the suite stays green. Reporting 1 over 2 members clears
    // the conjunct and reaches the scan: index 0 is local, and the count mismatch
    // is what denies.
    const lying = new Proxy(["ollama", "claude"], {
      get: (t, k, r) => (k === "length" ? 1 : Reflect.get(t, k, r)),
    }) as unknown as ProviderMatrix["allowedProviders"];
    expect(isLocalOnlyProviderMatrix(localMatrix({ allowedProviders: lying }))).toBe(false);

    // The zeroed form is kept as a second assert — it now pins the CONJUNCT.
    const zeroed = new Proxy(["claude"], {
      get: (t, k, r) => (k === "length" ? 0 : Reflect.get(t, k, r)),
    }) as unknown as ProviderMatrix["allowedProviders"];
    expect(isLocalOnlyProviderMatrix(localMatrix({ allowedProviders: zeroed }))).toBe(false);
  });

  it("non_enumerable_or_symbol_keyed_capability_route_is_not_skipped", () => {
    // Totality: a route hidden behind a non-enumerable — or symbol-keyed — own
    // property must still be inspected. Skipping it would let an unexamined remote
    // route ride under a local-only claim, which is the claim's whole failure mode.
    // Each fixture carries a PLAIN enumerable loopback route alongside the hidden
    // one, so the non-vacuity conjunct is satisfied by a key any enumeration
    // strategy can see. Without it these fixtures would clear the conjunct only
    // because it happens to use `Reflect.ownKeys` too — and switching that to the
    // natural-looking `Object.keys` would make both tests pass at the conjunct
    // while never running the route scan they are named for. Green, and blind.
    const nonEnumerable = { "source.extract": LOOPBACK_OLLAMA } as Record<string, ProviderRoute>;
    Object.defineProperty(nonEnumerable, "meeting.close", {
      value: TUNNELED_LOCAL,
      enumerable: false,
    });
    expect(
      isLocalOnlyProviderMatrix(
        matrix({ allowedProviders: ["ollama"], capabilityDefaults: defaults(nonEnumerable) }),
      ),
    ).toBe(false);

    const symbolKeyed = {
      "source.extract": LOOPBACK_OLLAMA,
      [Symbol("meeting.close")]: TUNNELED_LOCAL,
    } as unknown as Record<string, ProviderRoute>;
    expect(
      isLocalOnlyProviderMatrix(
        matrix({ allowedProviders: ["ollama"], capabilityDefaults: defaults(symbolKeyed) }),
      ),
    ).toBe(false);
  });

  it("a_route_whose_identity_cannot_be_branded_denies_rather_than_throws", () => {
    // `processorOfRoute` brands the route's RAW identity string, and the brand
    // constructor THROWS on a blank one — so `{provider: ""}` (a shape only a
    // deserialized row can produce; the type forbids it) would escape as an
    // exception instead of a decision. A safety predicate that throws where it
    // should deny is not fail-closed: the caller sees a crash, not `false`.
    for (const identity of ["", "   "]) {
      for (const branch of [{ provider: identity }, { runtime: identity }]) {
        const m = localMatrix({
          capabilityDefaults: defaults({
            "meeting.close": route(branch, "https://remote.example.com", "cloud"),
          }),
        });
        expect(() => isLocalOnlyProviderMatrix(m)).not.toThrow();
        expect(isLocalOnlyProviderMatrix(m)).toBe(false);
      }
    }
  });

  it("a_throwing_getter_denies_rather_than_throws", () => {
    const hostile = {} as Record<string, ProviderRoute>;
    Object.defineProperty(hostile, "meeting.close", {
      get() {
        throw new Error("hostile getter");
      },
      enumerable: true,
    });
    const m = localMatrix({ capabilityDefaults: defaults(hostile) });
    expect(() => isLocalOnlyProviderMatrix(m)).not.toThrow();
    expect(isLocalOnlyProviderMatrix(m)).toBe(false);
  });

  it("a_throwing_key_enumeration_denies_rather_than_throws", () => {
    // The non-vacuity conjunct enumerates keys BEFORE the route scan does, so it
    // needs its own totality guarantee — an `ownKeys` trap that throws would
    // otherwise escape from the earlier call and never reach the scan's try.
    const hostile = new Proxy(
      { "meeting.close": LOOPBACK_OLLAMA },
      {
        ownKeys() {
          throw new Error("hostile ownKeys");
        },
      },
    ) as Record<string, ProviderRoute>;
    const m = localMatrix({ capabilityDefaults: defaults(hostile) });
    expect(() => isLocalOnlyProviderMatrix(m)).not.toThrow();
    expect(isLocalOnlyProviderMatrix(m)).toBe(false);
  });

  it("malformed_matrix_is_not_local_only", () => {
    const bad = (v: unknown): boolean => isLocalOnlyProviderMatrix(v as ProviderMatrix);
    expect(bad(undefined)).toBe(false);
    expect(bad(null)).toBe(false);
    expect(bad("ollama")).toBe(false);
    expect(bad(localMatrix({ allowedProviders: "ollama" as unknown as ProviderMatrix["allowedProviders"] }))).toBe(false);
    expect(
      bad(localMatrix({ allowedProviders: [null] as unknown as ProviderMatrix["allowedProviders"] })),
    ).toBe(false);
    expect(
      bad(localMatrix({ allowedProviders: [""] as unknown as ProviderMatrix["allowedProviders"] })),
    ).toBe(false);
    expect(
      bad(localMatrix({ capabilityDefaults: null as unknown as ProviderMatrix["capabilityDefaults"] })),
    ).toBe(false);
    // An undefined VALUE under a present capability key is a malformed route, not "no route".
    expect(
      bad(
        localMatrix({
          capabilityDefaults: { "meeting.close": undefined } as unknown as ProviderMatrix["capabilityDefaults"],
        }),
      ),
    ).toBe(false);
  });
});

// ── axis 2 — no destination is approved ──────────────────────────────────────
describe("hasNoApprovedEgressDestination — axis 2 (9.22 option C)", () => {
  it("both_allowlists_empty_is_no_approved_destination", () => {
    expect(hasNoApprovedEgressDestination(policy())).toBe(true);
  });

  it("remote_ollama_in_an_egress_allowlist_is_a_destination", () => {
    // ⛔ THE corrected-model assertion. A genuine loopback-local route never
    // consults this list (egress.ts:157), so an entry here — including "ollama" —
    // is a REMOTE endpoint approved to receive content.
    expect(hasNoApprovedEgressDestination(policy({ allowedProcessors: ids("ollama") }))).toBe(false);
    expect(hasNoApprovedEgressDestination(policy({ allowedProcessors: ids("lm_studio") }))).toBe(false);
    expect(hasNoApprovedEgressDestination(policy({ allowedProcessors: ids("claude") }))).toBe(false);
  });

  it("raw_content_allowlist_is_an_independent_destination_set", () => {
    expect(
      hasNoApprovedEgressDestination(policy({ rawContentAllowedProcessors: ids("claude") })),
    ).toBe(false);
  });

  it("the_acknowledgment_flag_does_not_move_the_answer", () => {
    // Severs the original defect at its root: `zeroEgressOnly` was `!acknowledged`,
    // a claim about CONSENT masquerading as a claim about ROUTING.
    //
    // Asserting only `acked === unacked` would be satisfied by a predicate that
    // returned a constant — i.e. by a broken predicate — so the value is pinned on
    // BOTH sides. Under the old `!acknowledged` model these two would differ.
    const acked = policy({
      employerRawEgressAcknowledged: true,
      acknowledgedAt: "2026-07-27T00:00:00.000Z",
    });
    expect(hasNoApprovedEgressDestination(acked)).toBe(true);
    expect(hasNoApprovedEgressDestination(policy())).toBe(true);
  });

  it("sparse_or_malformed_allowlists_are_never_empty", () => {
    const bad = (v: unknown): boolean => hasNoApprovedEgressDestination(v as EgressPolicy);
    expect(bad(policy({ allowedProcessors: new Array(3) as ProcessorId[] }))).toBe(false);
    // A zeroed `length` over real members must not read as "no destination
    // approved" (proxied array — `Array.isArray` pierces the Proxy).
    const lying = new Proxy(ids("claude"), {
      get: (t, k, r) => (k === "length" ? 0 : Reflect.get(t, k, r)),
    }) as ProcessorId[];
    expect(bad(policy({ allowedProcessors: lying }))).toBe(false);
    expect(bad(policy({ allowedProcessors: "claude" as unknown as ProcessorId[] }))).toBe(false);
    // The killer case for a missing `Array.isArray`: `"".length === 0`, so a bare
    // length check would read an empty STRING as "no destinations approved".
    expect(bad(policy({ allowedProcessors: "" as unknown as ProcessorId[] }))).toBe(false);
    expect(bad(policy({ rawContentAllowedProcessors: "" as unknown as ProcessorId[] }))).toBe(false);
    expect(bad(policy({ rawContentAllowedProcessors: null as unknown as ProcessorId[] }))).toBe(false);
    expect(bad(undefined)).toBe(false);
    expect(bad(null)).toBe(false);
    expect(bad("")).toBe(false);
  });
});

// ── the composition — both axes, fail-closed on each ─────────────────────────
describe("isZeroEgressOnlyWorkspace — the two-axis claim (9.22 option C)", () => {
  const ws = (
    m: Partial<ProviderMatrix> = {},
    p: Partial<EgressPolicy> = {},
  ): { egressPolicy: EgressPolicy; providerMatrix: ProviderMatrix } => ({
    egressPolicy: policy(p),
    providerMatrix: localMatrix(m),
  });

  it("both_axes_hold_is_zero_egress_only", () => {
    expect(
      isZeroEgressOnlyWorkspace(
        ws({
          allowedProviders: ["ollama"],
          capabilityDefaults: defaults({ "meeting.close": LOOPBACK_OLLAMA }),
        }),
      ),
    ).toBe(true);
  });

  it("either_axis_alone_is_not_enough", () => {
    // Local matrix + a leftover cloud destination — the case option B could not see.
    expect(
      isZeroEgressOnlyWorkspace(
        ws({ allowedProviders: ["ollama"] }, { allowedProcessors: ids("claude") }),
      ),
    ).toBe(false);
    // Empty allowlists + a cloud-capable matrix — the case option A could not see.
    expect(isZeroEgressOnlyWorkspace(ws({ allowedProviders: ["claude"] }))).toBe(false);
  });

  it("is_independent_of_the_acknowledgment", () => {
    // Both sides pinned to a VALUE, not merely to each other — an equality-only
    // assertion is satisfied by a constant predicate, i.e. by the broken case.
    const off = ws({ allowedProviders: ["ollama"] });
    const on = ws(
      { allowedProviders: ["ollama"] },
      { employerRawEgressAcknowledged: true, acknowledgedAt: "2026-07-27T00:00:00.000Z" },
    );
    expect(isZeroEgressOnlyWorkspace(off)).toBe(true);
    expect(isZeroEgressOnlyWorkspace(on)).toBe(true);
  });

  it("the_canonical_valid_workspace_fails_on_axis_1_alone", () => {
    // Driven from the REAL shared fixture, not a hand-built lookalike: it carries
    // EMPTY allowlists (axis 2 passes) but a non-local matrix (axis 1 fails). An
    // axis-2-only implementation returns `true` here and has silently become
    // option A — exactly the collapse this test exists to catch.
    expect(hasNoApprovedEgressDestination(validWorkspace.egressPolicy)).toBe(true);
    expect(isLocalOnlyProviderMatrix(validWorkspace.providerMatrix)).toBe(false);
    expect(isZeroEgressOnlyWorkspace(validWorkspace)).toBe(false);

    // ⚠ The fixture's matrix is `{allowedProviders:["claude"], capabilityDefaults:{}}`,
    // so the assertion above is now earned by the NON-VACUITY conjunct (no routes),
    // not by `["claude"]` being a cloud provider — the fault this test is named for
    // is no longer the one it observes. Give the fixture a route so the cloud
    // provider is the SOLE remaining fault, and the cloud-membership check is
    // genuinely exercised against the real shared shape.
    expect(
      isLocalOnlyProviderMatrix({
        ...validWorkspace.providerMatrix,
        capabilityDefaults: defaults({ "meeting.close": LOOPBACK_OLLAMA }),
      }),
    ).toBe(false);
  });

  it("an_entirely_unconfigured_workspace_claims_nothing", () => {
    // ⭐ THE REASON FOR THE THIRD CONJUNCT (owner ruling), asserted at the composed
    // level because that is where the collapse happened. Provisioning SEEDS both
    // allowlists, so "both empty" is not a locked-down workspace — it is the
    // never-provisioned (or 9.29-wiped) one, and the SAME absence empties the
    // matrix. Without a liveness requirement, ONE missing event satisfies BOTH
    // axes and option C degrades to option A exactly where it was chosen to be
    // stronger. An unconfigured workspace must report `false`: the app does not
    // know yet, and not-knowing may never render as reassurance.
    expect(isZeroEgressOnlyWorkspace({ egressPolicy: policy(), providerMatrix: matrix() })).toBe(
      false,
    );
    // ...and the axes still fail INDEPENDENTLY. Asserted PER AXIS, because the
    // fused result alone cannot show WHICH axis failed — a composed `false` is
    // equally consistent with both failing, which is the collapse being ruled out.
    const seeded = policy({
      allowedProcessors: ids("claude"),
      rawContentAllowedProcessors: ids("claude"),
    });
    expect(isLocalOnlyProviderMatrix(localMatrix())).toBe(true);
    expect(hasNoApprovedEgressDestination(seeded)).toBe(false);
    expect(isZeroEgressOnlyWorkspace({ egressPolicy: seeded, providerMatrix: localMatrix() })).toBe(
      false,
    );
  });

  it("absent_or_malformed_input_never_claims_zero_egress", () => {
    const bad = (v: unknown): boolean =>
      isZeroEgressOnlyWorkspace(v as { egressPolicy: EgressPolicy; providerMatrix: ProviderMatrix });
    expect(bad(undefined)).toBe(false);
    expect(bad(null)).toBe(false);
    expect(bad({})).toBe(false);
    expect(bad({ egressPolicy: policy() })).toBe(false);
    expect(bad({ providerMatrix: localMatrix() })).toBe(false);
  });
});

// ── structural pin ───────────────────────────────────────────────────────────
describe("LOCAL_PROVIDERS stays module-private", () => {
  it("membership_is_asked_never_read", () => {
    // Exporting the set invites a caller to re-derive membership and reach a
    // second, weaker answer (contracts forbidden-pattern #6). Callers get
    // predicates; the set stays here with the identity-wins-over-endpoint rule.
    expect(Object.keys(processorsModule)).not.toContain("LOCAL_PROVIDERS");
  });
});
