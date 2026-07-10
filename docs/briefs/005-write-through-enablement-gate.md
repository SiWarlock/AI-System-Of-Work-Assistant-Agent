# /tdd brief — write_through_enablement_gate (Phase 11.3 — deterministic AND-gate core)

> **Step-0 correction (2026-07-09, `c4467ee`):** the VERIFICATION note below ("no composed `decide` predicate exists") was incomplete — `evaluateEnablementGate` (`write-through-flag.ts`) DOES exist: the RUNTIME auto-revert gate (9 all-required §12-GO legs, no parity, inside `resolveWriteThrough`). The shipped `decideWriteThroughEnablement` is DISTINCT (the one-time flip-precondition gate — adds divergence-clean + reindex-complete setup legs; fail-closed-on-omission); two intentional gates for two moments, documented in the file header + the §13 two-gate arch-note. Shared legs consume the same upstream booleans (no drift).

## Feature
The deterministic **write-through enablement-refusal predicate** — the pure, fail-closed AND-gate that decides whether `writeThroughEnabled` MAY be flipped ON for a workspace: `decideWriteThroughEnablement(inputs) → WriteThroughEnablementDecision` composing the ARCHITECTURE-§13 legs (pin-validated · divergence-suite-clean · read-token-rejects-write conformance-green · full-reindex-complete · embedding-key-present · no-stray-gbrain-writer) into a single decision + a typed **refusal list** naming every blocking leg. It is PURE over an injected leg-result record; the real leg PRODUCERS (running the §12 divergence suite, the conformance run, the reindex, the Keychain embedding-key probe, the stray-writer probe) are deferred (bucket B), and the FLIP itself stays HITL. Mirrors the install-doctor pattern (pure engine over injected probe results; real collectors deferred) + the gate-4 core-first/wire-later posture.

## Use case + traceability
- **Task ID:** 11.3 (GBrain pin verify + gated-upgrade / write-through enablement refusal). Plan `IMPLEMENTATION_PLAN.md:1757`.
- **VERIFICATION (2026-07-09, scoping this slice):** the version-compare→degrade CORE is **already built** — `checkVersionPin(pin, running, ctx)` (`packages/knowledge/src/gbrain/version-pin.ts:137`) returns `read_only_index_only` + a `HealthItem` on gbrain_unavailable / sha_mismatch / index_schema_mismatch / pending_validation, else `serving` with `writeThroughEligible: pin.writeThroughEnabled`; `pinValidatedForEnablement(pin)` (`enablement/write-through-flag.ts:275`) is a built leg. **The NON-built piece is the AND-composed enablement gate** — no composed `decide` predicate exists (only the single pin leg; the other legs live in separate modules). This slice builds ONLY that composition; it REUSES `checkVersionPin`/`pinValidatedForEnablement` as legs (does not rebuild them).
- **Architecture sections it implements:** `ARCHITECTURE.md §13` (GBrain version-pin, upgrade & write-through enablement gate — "pin bump AND flipping `writeThroughEnabled` ON gated on: §12 four-GO divergence suite + read-token-rejects-write conformance green against the actual pinned SHA, full re-index, present embedding key, no `dream`/`autopilot`/`sync --install-cron`/`jobs-work` bound to a canonical brain") + `§12` (parity/divergence) + `§6` (write-through / one-writer) + safety rule **1**. Implementer confirms the §13 write-through-gate anchor at Step 0.
- **Related context:** `checkVersionPin` + `VersionPinServing`/`VersionPinDegraded` (`version-pin.ts`); `pinValidatedForEnablement` + `write-through-flag.ts`; `ParityReport.cleanForServing`/`coverageComplete` (the divergence leg); the evals `ConformanceGate` (`packages/evals/src/conformance/conformance-core.ts` — the conformance leg's producer, deferred); `GbrainPin` (Appendix A, frozen — unchanged).

## Scope boundary (IN vs deferred)
- **IN (this slice, deterministic, non-gated):** the typed `WriteThroughEnablementDecision`/`WriteThroughEnablementInputs` + `decideWriteThroughEnablement(inputs)` — the fail-closed AND over injected leg results, with a per-leg refusal list. Reuses the built pin legs.
- **DEFERRED (bucket B / HITL — record, don't build):** the real leg PRODUCERS (execute the §12 divergence suite against the actual pinned SHA, the read-token-rejects-write conformance run, the full-reindex completeness check, the Keychain embedding-key probe, the stray-gbrain-writer process probe — several overlap the install-doctor's bucket-B collectors + posture probe); the actual **`writeThroughEnabled: true` per-workspace FLIP** (owner-gated HITL — deferred-HITL ledger); the `config/gbrain.pin` RE-CAPTURE against installed gbrain 0.35.1.0 (real `gbrain --version`/`doctor --json`, bucket B).

## Acceptance criteria (what "done" means)
- [ ] NEW typed `WriteThroughEnablementDecision` = `{ enabled: boolean; refusals: EnablementRefusal[] }` where `EnablementRefusal` names a closed leg id + a reason; `enabled === true` IFF `refusals` is empty. `WriteThroughEnablementInputs` = a record of the per-leg outcomes (all optional ⇒ a partial/`{}` input fails closed). Local `knowledge`-package types (not a frozen Appendix-A seam; no snapshot/registry) — confirm at Step 2.5 Q2.
- [ ] `decideWriteThroughEnablement(inputs)` is PURE (no I/O, no clock, no throw) and **fail-closed AND**: `enabled` only when EVERY leg is present AND satisfied — pin-validated (reuse `pinValidatedForEnablement`) · divergence-clean (ParityReport `cleanForServing && coverageComplete`) · conformance-green · reindex-complete · embedding-key-present · no-stray-writer. Any absent/unknown/false leg ⇒ a refusal for that leg + `enabled:false` (never enabled-by-omission).
- [ ] **Distinct refusal per leg (no catch-all):** each failing leg yields its OWN typed refusal reason (assert pairwise-distinct across a fully-failing input), so the operator sees exactly what blocks the flip.
- [ ] **Reuse, don't rebuild:** the pin leg composes `pinValidatedForEnablement` (and, where the version-pin serving state is an input, `checkVersionPin`'s result) — no re-implementation of the version-compare logic.
- [ ] **Fail-closed on empty/partial input:** `decideWriteThroughEnablement({})` ⇒ `enabled:false` with a refusal for every required leg. Never throws (§16).
- [ ] Unit tests pin: all-legs-green ⇒ `enabled:true`, empty refusals; each single failing leg ⇒ `enabled:false` + that leg's distinct refusal (others pass); empty input ⇒ all-legs-refused; purity (same input → deep-equal decision, no mutation); never-throws.

## RED outline (write cases first)
1. `all_legs_green_enables` — every leg present + satisfied ⇒ `enabled:true`, `refusals:[]`.
2. `each_failing_leg_has_distinct_refusal` — flip each leg false in turn ⇒ `enabled:false` + exactly that leg's distinct refusal; a fully-failing input ⇒ all refusals pairwise-distinct (no catch-all).
3. `absent_leg_fails_closed` — a leg OMITTED from the input ⇒ treated as unsatisfied ⇒ refusal (never enabled-by-omission).
4. `empty_input_refuses_every_leg` — `decideWriteThroughEnablement({})` ⇒ `enabled:false`, a refusal per required leg.
5. `pin_leg_reuses_built_predicate` — a PENDING-sentinel pin ⇒ the pin-validated leg refuses (via `pinValidatedForEnablement`), not a re-implemented check.
6. `pure_and_never_throws` — two calls on the same input ⇒ deep-equal decision, input unmutated; a malformed leg value ⇒ a decision (fail-closed), never a throw (§16).

## Cross-doc invariant impact
- **Model field changes:** **none** — `GbrainPin` (Appendix A) unchanged; `WriteThroughEnablementDecision`/`Inputs`/`EnablementRefusal` are local `@sow/knowledge` types (Step-2.5 Q2 confirms not-a-seam). No snapshot/registry/Appendix-A change. If the implementer concludes the decision belongs on a frozen seam → Step-9 cross-doc flag.
- **Architecture-doc note candidate:** §13 write-through-gate prose may note the enablement-refusal predicate landed (deterministic; real leg producers + the flip deferred). Orchestrator-write.

## Things to flag at Step 2.5 (design questions — default votes)
1. **Leg-input shape.** Default vote: an injected `WriteThroughEnablementInputs` record of typed per-leg outcomes (the pin serving-state/validity, the ParityReport clean/coverage booleans, conformance-green bool, reindex-complete bool, embedding-key-present bool, no-stray-writer bool) → pure `decide`. The real leg producers stay a deferred bucket-B collector (as the doctor does). Confirm vs calling producers (would make it impure).
2. **Decision/refusal placement + shape.** Default vote: local `@sow/knowledge/src/gbrain/enablement/*` types (Zod-as-source if a runtime schema is wanted, else plain typed), NOT a frozen seam; `enabled ⇔ refusals empty`; closed `EnablementRefusalLeg` enum. Confirm.
3. **Fail-closed default.** Default vote: absent/unknown leg ⇒ refusal (assume-unsatisfied); `enabled` requires every leg explicitly satisfied. Confirm.
4. **Overlap with the install-doctor.** Default vote: the stray-writer + embedding-key legs OVERLAP the doctor's posture/keychain probes — this slice consumes their RESULT as a leg input; do NOT duplicate the doctor's probe logic. Note the shared bucket-B producer at Step 9.

## Wiring / entry point / blocks
- **Entry point (future, HITL):** the write-through enablement flip path (boot/config, per-workspace) calls `decideWriteThroughEnablement` and refuses the flip on any refusal. NOT built this slice ⇒ unit-reachable now, production-wired when the (HITL) flip path lands (documented unreachable-by-design waiver, as with the oracle-core / doctor engine). Note at Step 7.5.
- **Blocks:** the `writeThroughEnabled` per-workspace flip (HITL, deferred ledger) — this predicate is its deterministic precondition gate.
- **Depends on:** `checkVersionPin` + `pinValidatedForEnablement` (built) + `ParityReport` (built). No new production infra.

## Estimated commit count
**1–2.** (1) the typed decision/inputs + `decideWriteThroughEnablement` + tests. (Optional 2 if a Zod runtime schema for the decision is added.) Safety gate (write-through / one-writer) ⇒ Step-8 review MANDATORY.

## Lessons-logged candidates (implementer flags Step 9)
- Possible: "a go-live enablement gate is a pure fail-closed AND over INJECTED leg results (real leg producers deferred) with a distinct refusal per leg — enabled IFF every leg is explicitly satisfied; never enabled-by-omission; reuse the already-built legs (`checkVersionPin`/`pinValidatedForEnablement`), don't rebuild." (May fold into lesson 8's pure-over-injected pattern — implementer's call.)

## How to invoke (implementer)
1. `/tdd` against this brief. Step 0 — confirm the §13 write-through-gate anchor + READ `checkVersionPin`/`pinValidatedForEnablement` (reuse, don't rebuild).
2. Step 2.5 — ping Q1–Q4 (defaults above; Q1 injected-legs + Q3 fail-closed default are load-bearing) BEFORE writing cases.
3. RED first (fail-closed-on-empty + never-throws are the load-bearing pins).
4. **Step 8 — MANDATORY adversarial review** (general-purpose Agent, security + code-quality): this gate guards the write-through flip (safety rule 1 / §6 one-writer) — NO absent/partial/unknown leg state may resolve to `enabled:true`; fail-closed AND + §16 no-throw hold on every axis.
5. Step 9 — categorized flags (esp. the shared bucket-B producer overlap with the doctor; any pull toward a frozen seam) + ship-ask.
