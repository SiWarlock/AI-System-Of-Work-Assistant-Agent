# /tdd brief — budget_real_pricing_cost1_dollar_cap (CP-5)

## Feature
Make the **COST-1 dollar cap actually enforce**: supply **real per-model token pricing** (tokens → USD) and thread it + a `maxCostUsd` default into the composed budget gate, so an over-budget route DENIES on `BudgetCap.maxCostUsd` — not merely on runtime-seconds. The breach machinery already exists (`detectBudgetBreach` computes `meterUsageCost(usage, pricing)` and denies when `costUsd > budget.maxCostUsd`; `resolveEnforcedBudget` already resolves `maxCostUsd`); the gap is that **`config.pricing` is unpopulated** — so `pricingFor` returns `undefined`, `meterUsageCost` reports `measured:false`, and the cost limb never fires (runtime-seconds is the only live cap today). **Two sub-slices, two commits — providers (pricing values) then worker (wire config). SAFE-BUILD: NO real model call, NO spend — this is a deny-only cap that only ever REDUCES spend; a deny-only gate ships ON with no dormancy knob (worker Lesson 44).**

## Use case + traceability
- **Task ID:** 18.15 (CP-5; crossing #13 operational must-fix). Sub-slices: **18.15a** (providers, integrations-impl), **18.15b** (worker, worker-impl3). Independent of GATE-1 — parallel-eligible.
- **Architecture sections it implements:** `ARCHITECTURE.md §19.5` (real-model spend safety), `§7` (broker budget gate), `§5` (providers/broker cost enforcement — verify anchor at Step 1; COST-1/COST-2/OQ-003 live in the budget-enforcer).
- **Related context (machinery already present — this slice supplies data + wiring, not new gate logic):**
  - `packages/providers/src/broker/budget-enforcer.ts`: `BudgetEnforcerConfig{ defaults, pricing? }:66`, `resolveEnforcedBudget:102` (handles `maxCostUsd` from job/defaults), `detectBudgetBreach:136` (cost limb: `if (budget.maxCostUsd !== undefined) { sample = meterUsageCost(usage, pricing); if (sample.measured && sample.costUsd > budget.maxCostUsd) → breach }`), `pricingFor:124` (returns `undefined` when `config.pricing === undefined` — the current dead-cost-limb cause), `createBudgetGate:207`, `budgetBreachHealthItem:182`.
  - `packages/providers/src/broker/cost-meter.ts`: `TokenPricing:16` + `meterUsageCost` (`measured:false` when no pricing).
  - `apps/worker/src/composition/budget-ledger.ts`: `createLedgeredBudgetGate(config, ledger):94` — the worker composition entry that builds the `BudgetEnforcerConfig` passed to `createBudgetGate`. This is where the worker must supply `pricing` + a `maxCostUsd` default.
  - Existing eval: `packages/evals/suites/budget-cap/budget-cap.test.ts` (eval-security territory — do NOT edit; note it as the flip-time confirmation surface).
  - **Claude per-model pricing grounding (Context7 / `claude-api` skill — GROUND at Step 1):** real input/output $/token for the Claude models in scope (Claude-first; defer openai/openrouter/voyage). Pin the numbers with a citation comment + a source date (pricing drifts — worker L3-style honesty).

## Acceptance criteria (what "done" means)

### Sub-slice 18.15a — providers (pricing values), integrations-impl
- [ ] **Real per-model `TokenPricing` table** for the in-scope Claude models — a typed constant keyed by `ProviderId`/model (matching `pricingFor`'s `config.pricing[job.providerRoute.provider]` lookup), each entry the real input/output $/token, with a **citation comment naming the source + date** (pricing is not a frozen fact — do not fabricate; if a rate is uncertain, pick the conservative-higher rate so the cap fails SAFE and flag it).
- [ ] **`meterUsageCost` measures with the table** — pin: a usage sample + the Claude pricing yields `measured:true` with the correct `costUsd` (a currently-dead path: today `measured:false`).
- [ ] **Cost breach fires** — pin `detectBudgetBreach(usage, { maxCostUsd: X }, pricing)` returns a `cost` breach when `costUsd > X`, and NO breach when under (the runtime-seconds limb behavior unchanged).
- [ ] **Claude-first scope** — openai/openrouter/voyage deferred; an absent pricing entry still degrades to `measured:false` (no throw, no false-cheap).

### Sub-slice 18.15b — worker (wire config), worker-impl3 (depends 18.15a)
- [ ] **Thread `pricing` into the composed `BudgetEnforcerConfig`** at `createLedgeredBudgetGate`'s caller (the boot/composition root) so the live broker's budget gate carries the real pricing table.
- [ ] **A `maxCostUsd` default is set** in `BudgetDefaults` (global and/or per-capability) so `resolveEnforcedBudget` yields a non-`undefined` `maxCostUsd` — otherwise `detectBudgetBreach`'s cost limb short-circuits. The default is **owner-config-sourced, not hardcoded arming** (mirror the boot-gate pattern; the owner sets the dollar cap — memory notes ~$10 first runs); a sensible conservative default is acceptable with an owner-tunable seam.
- [ ] **End-to-end deny pin (over the real composed gate, L50):** an over-cost usage on a Claude route → the budget gate `post` DENIES with a cost breach + a redacted `budgetBreachHealthItem` (rule 7 — no raw content/prompt in the health item). Runtime-only routes still enforce runtime-seconds.
- [ ] **Byte-equivalent where unconfigured** — absent owner pricing/cap config, the gate degrades exactly as today (runtime-seconds only, no false cost-cheap). All unit tests pass; `/preflight` clean.

## Wiring / entry point (Step 7.5)
- **18.15a:** the pricing table is consumed by `pricingFor` → `meterUsageCost` → `detectBudgetBreach`; reachable-by-test; the worker binding lands in 18.15b.
- **18.15b:** boot → `createLedgeredBudgetGate(config{ defaults{ …maxCostUsd }, pricing }, ledger)` → `createBudgetGate` → broker `budget.post`. `/wired` the pricing/cap from boot to the breach.

## Files expected to touch (impl traces exact paths at Step 1)
- **18.15a:** `packages/providers/src/broker/cost-meter.ts` or a new `packages/providers/src/broker/pricing.ts` (the pricing constant) + `budget-enforcer.test.ts` / `cost-meter.test.ts`.
- **18.15b:** `apps/worker/src/composition/budget-ledger.ts` and/or the boot composition root that builds `BudgetEnforcerConfig` (`apps/worker/src/boot.ts` / `buildActivities.ts` — trace) + tests over the assembled gate.

## RED test outline (Step 2)
**18.15a:** (1) `claude_pricing_table_meters_cost_measured_true`. (2) `cost_breach_fires_over_maxCostUsd` (+ under ⇒ no breach). (3) `absent_pricing_entry_degrades_measured_false_no_throw`. `spec(§7)`/`spec(§19.5)`.
**18.15b:** (1) `composed_budget_gate_denies_over_cost_route` (real `createLedgeredBudgetGate`, L50). (2) `maxCostUsd_default_is_resolved_not_undefined`. (3) `breach_health_item_is_redacted` (rule 7). (4) `unconfigured_gate_is_byte_equivalent_runtime_only`. `spec(§19.5)`.

## Cross-doc invariant impact
- No new model. A real pricing table + a `maxCostUsd` default become live behavior → flag for the §19.5 spend-safety note + worker/providers LESSONS. The `maxCostUsd` owner-config knob is a new arming-adjacent surface — note it in the §19.5 arming runbook (alongside the CP-4 health-source caveat).

## Things to flag at Step 2.5
1. **Pricing source honesty** — the numbers are Context7/official-grounded with a dated citation; conservative-higher on uncertainty (fail-SAFE). Confirm the key axis matches `pricingFor` (`job.providerRoute.provider`).
2. **`maxCostUsd` default vs arming** — a deny-only cap ships ON (L44), but the DOLLAR AMOUNT is owner-tunable. Confirm the default is owner-config-sourced (not a hardcoded number that silently caps every deployment) and there is a seam for the owner's ~$10 first-run cap.
3. **Health-item redaction** — `budgetBreachHealthItem` carries only safe fields (job/ws/capability refs + the numeric observed/limit), never raw content/prompt (rule 7).

## Dependencies + sequencing
- **Depends on:** nothing external (machinery from 18.2 already live). **18.15b depends on 18.15a committed.** Parallel-eligible with CP-2/CP-3/CP-7.
- **Blocks:** the flip (a real spend cap is a #13 precondition).

## Estimated commit count
**2** (18.15a providers pricing, then 18.15b worker wire). **ISOLATE** (spend safety). **security-reviewer = MANDATORY** on BOTH (spend cap + rule-7 health redaction) + code-quality = every-slice.

## Lessons-logged candidates anticipated
- The COST-1 dollar cap was structurally present but DEAD because `config.pricing` was unpopulated (`measured:false` ⇒ cost limb never fires); real dated pricing + an owner-tunable `maxCostUsd` default activate it, fail-SAFE (conservative-higher on uncertainty), deny-only (ships ON, L44), byte-equivalent where unconfigured.

## How to invoke
1. **18.15a first:** `/tdd budget_real_pricing_cost1_dollar_cap` in `integrations-impl` — GROUND Claude pricing on Context7/`claude-api`; date the citation; security-reviewer MANDATORY.
2. **18.15b after 18.15a commits:** `/tdd budget_real_pricing_cost1_dollar_cap` in `worker-impl3` — trace the boot composition of `BudgetEnforcerConfig`; drive the deny over the REAL assembled gate (L50); security-reviewer MANDATORY.
