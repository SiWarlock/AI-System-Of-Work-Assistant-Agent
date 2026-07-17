# /tdd brief — real_health_source_and_locked_to_transport

## Feature
Replace the **always-green** `DEFAULT_HEALTH_SOURCES` with a real health/availability source **AND-locked to the transport arming**, so the broker HEALTH gate reports "healthy" only when the real transport is actually reachable — killing the false-green default that would let an unhealthy/unreachable real provider pass the HEALTH gate once the transport is armed. **SAFE-BUILD: dormant wiring — the real health probe engages ONLY on the armed path (the flip, owner-gated); the shipped default (dormant stub transport) stays byte-equivalent green. NO real endpoint call in the dormant path, NO spend.**

## Use case + traceability
- **Task ID:** 18.14 (CP-4; a #13 operational must-fix — HEALTH gate false-green under real transport)
- **Architecture sections it implements:** `ARCHITECTURE.md §19.5` (primary — real transport intelligence legs), `§7` (broker pipeline: HEALTH gate; provider health lives here).
- **Related context:**
  - **The gap:** `DEFAULT_HEALTH_SOURCES` (`apps/worker/src/composition/backends.ts:562`) is hardcoded green — `health: () => ({ state: "healthy" })`, `availability: () => ({ modelPresent: true, conformanceStatus: "passing" })`. Under the DORMANT stub transport this is correct (the stub is always available). But once the real transport is ARMED (18.1's `providerTransport` gate), this default would report a DEAD/unreachable real provider as healthy — the HEALTH gate would admit a job that then fails at the real call (or worse, masks an outage). #13 flags it as an arming must-fix.
  - **The seam:** `HealthGateSources` (`packages/providers/src/broker/provider-health.ts:69`); the transport arming gate is 18.1's `providerTransport` (`assembleBackends`, default-OFF). The HEALTH gate is a **deny-only policing gate** (worker Lesson 44 — active by default, no dormancy knob); this slice makes its SOURCE reflect reality when the transport is real, not the gate's activation.
  - **AND-lock (the safety property):** the real availability source is selected ONLY when the transport is armed (mirror the 18.1 AND-composed gate); dormant transport ⇒ the existing green stub (byte-equivalent). So the shipped default is untouched; the real probe is a reachable-when-armed seam (worker Lesson 11), exercised at the flip.

## Acceptance criteria (what "done" means)
- [ ] **No false-green under real transport:** when the transport is ARMED and the real provider is unreachable/unhealthy, the HEALTH source reports NOT healthy ⇒ the HEALTH gate DENIES (fail-closed) — it does NOT ride the always-green default.
- [ ] **AND-locked to the transport arming:** the real availability source is selected only when `providerTransport` is armed (`enabled === true` & bound); the real health probe is NEVER constructed/invoked on the dormant path (factory-spy zero-invocation OFF pin, mirror 18.1/worker L23).
- [ ] **Byte-equivalent dormant default:** with the transport unset (shipped default), `DEFAULT_HEALTH_SOURCES` behavior is unchanged (the stub is available ⇒ green) — no boot/behavior change, no real call.
- [ ] **Deny-gate stays active** (worker L44): the HEALTH gate itself has no dormancy knob; only its SOURCE switches from stub-green to real-availability under the armed transport.
- [ ] **SAFE-BUILD:** the real availability probe (a real endpoint reachability/health check) is only reached on the armed path — the OWNER's flip. No real call in this slice's tested/dormant paths (use a fake availability source in tests).
- [ ] All unit tests pass; `/preflight` clean.

## Wiring / entry point (Step 7.5)
`assembleBackends` composes the broker gates over `HealthGateSources`. This slice makes the health-source SELECTION AND-locked to the `providerTransport` arming (mirror the 18.1 runner selection): armed ⇒ a real availability source, dormant ⇒ `DEFAULT_HEALTH_SOURCES`. Reachability of the real source is waivered-until-armed (worker L11); the SELECTION logic is unit-tested directly (armed→real, dormant→stub, factory-spy OFF pin).

## Files expected to touch (trace exact at Step 1)
**New/Modified:**
- `apps/worker/src/composition/backends.ts` (the health-source selection AND-locked to the transport gate; the real availability source factory, unbound-by-default).
- Possibly `packages/providers/src/broker/provider-health.ts` (if a real availability-source shape/helper is needed) — flag the providers touch at Step 2.5 (may route a thin leg to integrations-impl; default worker-only if it's pure selection wiring).

## RED test outline (Step 2)
1. **`armed_transport_unhealthy_provider_denies`** — transport armed + a fake availability source reporting unreachable ⇒ HEALTH gate DENIES (not green).
2. **`dormant_default_stays_green_byte_equivalent`** — transport unset ⇒ `DEFAULT_HEALTH_SOURCES` selected, HEALTH gate green, real source factory NOT invoked (factory-spy zero-invocation).
3. **`health_source_selection_and_locked`** — the real availability source is chosen ONLY on `enabled === true` & bound (truthy-not-`true` guard, worker L28); a truthy-non-true / unbound ⇒ the stub.
4. **`armed_transport_healthy_provider_admits`** — transport armed + a fake source reporting reachable/healthy ⇒ HEALTH gate admits (proves it's not a blanket deny — non-vacuity).

## Cross-doc invariant impact
- **Model field changes:** none — reuses `HealthGateSources`. Confirm at Step 9.
- **Shared-contract seam model touched?** No (unless a providers availability-source shape is added — flag at Step 2.5).

## Things to flag at Step 2.5
1. **Providers touch** — whether a real availability-source shape belongs in `packages/providers` (integrations-impl co-leg) or the selection is pure worker wiring over the existing `HealthGateSources` (worker-only). Default vote: worker-only selection + a fake source in tests; the REAL probe (reachability against a live endpoint) is deferred to the flip.
2. **AND-lock granularity** — confirm the health source AND-locks to the SAME `providerTransport` arming gate as the run leg (18.1), so a single flip arms both (no split-brain where the transport is real but health stays stub-green).
3. **Dormant byte-equivalence** — confirm the shipped default is untouched (the stub-green default is correct while the transport is dormant; only the armed path changes).

## Dependencies + sequencing
- **Depends on:** 18.1 (the `providerTransport` arming gate — landed). Independent of GATE-1 (CP-1/CP-2/CP-3) — Wave-1 parallel-eligible.
- **Blocks:** the flip (a false-green HEALTH gate is an arming blocker).

## Estimated commit count
**1** — health-source selection AND-locked (worker). **INVARIANT** (deny-gate false-green risk) → **security-reviewer** + code-quality = every-slice; ISOLATE (do not bundle).

## Lessons-logged candidates anticipated
- **Convention candidate** — a deny-only policing gate's SOURCE must AND-lock to the effect-transport arming (a stub-green source is only safe while the transport is dormant; under a real transport the source must reflect real availability, else the gate false-greens) — extends worker L44 (gate active-by-default) + L23 (AND-locked arming).

## How to invoke
1. Read this brief end-to-end.
2. Run `/tdd real_health_source_and_locked_to_transport` in `worker-impl3`.
3. Step 0 — SAFE-BUILD; dormant wiring; no false-green under real transport; byte-equivalent default.
4. Step 1 — trace `DEFAULT_HEALTH_SOURCES` + the 18.1 `providerTransport` gate + `HealthGateSources`.
5. Step 2.5 — write-up + the 3 questions → me (`APPROVED.`/`TWEAK:`/`ADD:`).
6. Step 8 — security-reviewer (deny-gate false-green) + code-quality.
7. Step 9 — flags + ship-ask.
