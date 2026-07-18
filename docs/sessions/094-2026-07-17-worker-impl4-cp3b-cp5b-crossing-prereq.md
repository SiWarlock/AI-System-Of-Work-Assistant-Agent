# Session 094 — worker-impl4 — CP-3b + CP-5b (crossing-prereq Wave 2, worker slices)

- **Date:** 2026-07-17
- **Phase:** 18 (§19.5 real ModelProvider) — crossing-prerequisite round, Wave 2 (DORMANT / NO-SPEND)
- **Track:** worker (single-track `main`)
- **Predecessor session:** [093-2026-07-17-worker-impl3-phase18-s8-s9-egress-veto-autoingest-guard.md](093-2026-07-17-worker-impl3-phase18-s8-s9-egress-veto-autoingest-guard.md)
- **Successor session:** _(next worker-impl, TBD — Phase-18 owner crossing #13 is lead/owner-gated, not an impl slice)_
- **Commits:** CP-3b `052522ae` · CP-5b `b24429f5`

## Why this session existed

worker-impl3 died on repeated context overflow ("Prompt is too long") mid-CP-3b. As its fresh-context successor (worker-impl4), I carried the **last two worker slices** of the OWNER-authorized go-live crossing-prerequisite round — both built DORMANT / NO-SPEND (no real key, model call, or spend; the flip is the lead's last step):

- **CP-3b / 18.13b (#30)** — fix the #13 precondition where dormant auto-ingest fails a source CLOSED at the schema gate.
- **CP-5b / 18.15b (#32)** — make the dead COST-1 dollar cap actually enforce (real per-model Claude pricing threaded into the composed budget gate).

## What was built

### CP-3b / 18.13b — source `stubExtraction` seam (`052522ae`)

**Trace finding (orch2-confirmed):** the brief pointed at `registerWorker.ts`, but the register-hook `stubExtraction?` param already existed and already flowed to `assembleBackends`; the source reconstruction from `agent_extraction` was already wired by CP-2b (`mapAcceptedMeetingExtraction(outcome)` at `buildActivities.ts:816`). The genuine #13 hole was in `boot.ts`: `AutoIngestWiring`/`gateAutoIngest` did not carry a `stubExtraction`, so an armed auto-ingest source booted with the `assembleBackends {candidateOutput:{}}` default → source fails CLOSED at the schema gate (exactly the boot.ts `buildAutoIngestProofSpineParams` "NOT yet threaded through AutoIngestWiring" note).

**Files modified**
- `apps/worker/src/boot.ts` — added optional `AutoIngestWiring.stubExtraction?: StubMeetingExtraction`; added an optional 4th param to `gateAutoIngest` that is **conditionally spread** onto the returned wiring (omitted by default ⇒ byte-identical shipped wiring shape; AND-lock intact — a supplied stub can't arm a disabled gate); updated the `buildAutoIngestProofSpineParams` ARMING-OWED comment to reflect the seam now exists.

**Files created (tests)**
- `apps/worker/test/boot-auto-ingest-gating.test.ts` (extended) — 3 seam tests: threads-when-provided (the RED), byte-equivalent-default (`.toStrictEqual` + `in`-check), off-path-ignores-stub (AND-lock).
- `apps/worker/test/composition/source-extraction.test.ts` (extended) — 2 source-path evidenceRef-faithful reconstruction pins (concrete value WITH ⇒ ok / WITHOUT ⇒ `no_inference_violation`).

Ruling carried: **thread the SEAM only — the DORMANT default stays EMPTY**. The end-to-end "armed source passes the gate + commits a note" also needs the arming-bundle `outputSchemaId → sow:agent-extraction` switch (so the stub normalizes to an `agent_extraction` candidate, not the KMP stand-in ⇒ EMPTY ⇒ reject) — reachability-WAIVERED (L11), routed to #13.

### CP-5b / 18.15b — COST-1 dollar cap made live (`b24429f5`)

**Files modified**
- `apps/worker/src/composition/budget-ledger.ts` — added `DEFAULT_CLAUDE_PRICING` (transcribed per-model claude token pricing, framed as a **conservative fail-safe placeholder pending flip-time Context7 re-verify**, not current authority) and `DEFAULT_PROVIDER_PRICING = { claude: conservativeProviderPricing(DEFAULT_CLAUDE_PRICING) }` (CP-5a's element-wise MAX ⇒ fable-5's $10/$50). In-code NOTEs for Finding-F + the single-loader Future-TODO.
- `apps/worker/src/composition/backends.ts` — added `BackendsConfig.budgetPricing?` seam and threaded `pricing: config.budgetPricing ?? DEFAULT_PROVIDER_PRICING` into the composed `createLedgeredBudgetGate` (default-ON — deny-only ships ON, L44). The cost limb was previously DEAD because `pricing` was never wired here.

**Files created (tests)**
- `apps/worker/test/composition/budget-cost-cap.test.ts` (NEW) — 8 tests over the real `createLedgeredBudgetGate` with the shipped constants: over-cost claude route DENIES on COST; tokenless-dormant shipped-behavior guard (turning the cap ON must not newly-deny the dormant app); under-cost discriminator (cap discriminates, not deny-all); conservative-rate pin ($10/$50); **bidirectional** config drift-guard (`DEFAULT_CLAUDE_PRICING` ↔ config §costEstimation.pricing.claude, + opus-4-8 $5/$25 positive control); maxCostUsd-resolved; unpriced→runtime-only degrade; rule-7 HealthItem redaction (negative control).

## Decisions made

1. **Finding-E correction (spend-safety, orch2-ratified):** grounded Claude pricing on the authoritative claude-api skill (Current Models, cached 2026-06-24 — newer than the config's 2026-06-04): **Opus 4.8 = $5/$25**; the "$10/$50 opus" the brief/CP-5a asserted is actually **Fable 5's** rate (a conflation). Left the config opus value at $5/$25 (falsifying a cited table is worse than the non-existent staleness); the conservative margin comes correctly from Fable-5 dominating the element-wise max.
2. **Option A over Option B (sourcing):** a compiled-in `DEFAULT_CLAUDE_PRICING` constant + a transcription drift-guard test, NOT a boot config-loader. A loader on a SAFETY cap could fail-OPEN on a packaged-path resolution failure ⇒ silently lose the cap (the exact silent-safety-loss class this round hardens — CP-4 always-green, 17.3 silent-hold). A compiled-in cap can't vanish.
3. **CP-3b seam-only, dormant EMPTY:** the seam is additive + byte-equivalent by default; the real stub + `outputSchemaId` flip are arming-bundle scope.

## Decisions explicitly NOT made (deferred → #13)

- Did NOT bump the config opus price to $10/$50 (Finding-E: false premise).
- Did NOT rewrite the `budgets.derivation` comment (its `$0.45 < $0.50` math is valid at opus $5/$25).
- Did NOT replace the transcriptions with a real config loader (Future-TODO — must be **fail-CLOSED at arming**, §5.4 end state).
- Did NOT extend the cost meter to runtime (`claude-agent-sdk`) routes (Finding-F — Future-TODO).

## TDD compliance

**Clean.** Both slices strict RED-first: CP-3b (1 behavioral RED + byte-equivalence/AND-lock guards), CP-5b (new-file RED on undefined pricing constants → GREEN). All Step-2.5 write-ups sent to orch2 and APPROVED before GREEN. No violations.

## Cross-doc invariant audit

**No cross-doc invariant changed.** The touched types (`AutoIngestWiring.stubExtraction?`, `BackendsConfig.budgetPricing?`, `DEFAULT_CLAUDE_PRICING`) are worker-internal composition types, not contract models mirrored in `ARCHITECTURE.md` (per the `packages/contracts/CLAUDE.md` cross-doc invariants table). No `ARCHITECTURE.md` edit owed.

## Reachability

- **CP-3b:** `AutoIngestWiring.stubExtraction` → the desktop worker-host's existing spread (`worker-host/index.ts:217-226`) → `config.stubExtraction` → `assembleBackends` + `makeProofSpineRegisterHook`. Downstream wired; population (passing the 4th arg) deferred to arming (L11). No desktop edit needed for forwarding.
- **CP-5b:** `DEFAULT_PROVIDER_PRICING` → threaded into the real `assembleBackends` budget gate (`backends.ts`, default-ON). This **de-deads CP-5a's `conservativeProviderPricing` helper** (was L11-waivered). Full-broker cost-breach e2e is arming-gated (dormant stub emits `{runtimeSeconds:1}`, no tokens ⇒ `measured:false`) — pinned at the composed gate with real constants (L11 waiver, consistent with CP-3b).
- No tested-but-unwired gaps.

## Open follow-ups (routed to #13; orch2 logging)

1. **Finding-E** pricing correction — opus $5/$25 not $10/$50 (Fable-5 conflation); changes flip-prep.
2. **Finding-F** (HARD arming precondition) — the flagship `meeting.close.cloudPreferred` route is `{runtime:"claude-agent-sdk"}` (no `providerRoute.provider`), so `pricingFor` can't key it ⇒ NOT dollar-capped. Arm the dollar-capped raw-model PROVIDER routes first; runtime-route cost metering is a Future-TODO.
3. **HARD flip precondition** — re-verify `DEFAULT_CLAUDE_PRICING` vs Context7 + config at flip (it is a fail-safe PLACEHOLDER, not authority).
4. **Future-TODO** — replace BOTH transcriptions (`DEFAULT_CLAUDE_PRICING` + `DEFAULT_BUDGET_DEFAULTS`) with ONE fail-CLOSED config loader (§5.4 "must not hardcode" end state).
5. **CP-3b arming** — the desktop host passes a valid source stub (gateAutoIngest 4th arg) AND the arming bundle flips `outputSchemaId → sow:agent-extraction`, else source auto-ingest still fails closed by design.

## Lesson candidates (for orch2 to bank in `apps/worker/LESSONS.md`)

1. **COST-1 dollar cap — conservative element-wise-MAX pricing is fail-SAFE; ship the deny-gate ON but guard shipped-behavior.** Project the per-model pricing to one provider-axis rate via the element-wise MAX (over-count ⇒ the cap fires early, never under-caps); ship deny-only ON (L44) but pin that a tokenless dormant job is NOT newly-denied (a false nonzero cost on the default-ON path would break the dormant app); absent/empty pricing degrades to `measured:false` runtime-only (never a false cost-cheap); the projection helper throws fail-CLOSED at import on empty/NaN/negative.
2. **A compiled-in safety cap can't fail-open; a boot config-loader on a SAFETY cap can.** Prefer a compiled-in constant + a **bidirectional** transcription drift-guard test (config ↔ constant, non-vacuous) over a runtime loader, until a **fail-CLOSED-at-arming** loader exists — a loader that fails OPEN on a packaged-path miss silently loses the cap.
3. **Never trust cached/memory vendor pricing — ground on the live source.** opus-4-8 = $5/$25; the "$10/$50" was a Fable-5 conflation. Falsifying a cited authoritative table (even in the "conservative" direction) is worse than a non-existent staleness when the conservative margin is already delivered by the max.
4. **Thread the seam only; the dormant default stays EMPTY (fail-closed preserved).** For an arming precondition, add the additive seam (conditional-spread, byte-equivalent default, AND-lock guard so a supplied input can't arm a disabled gate); arming supplies the real value + any coupled `outputSchemaId` flip.

## Known environment issues (non-blocking — tooling fast-follow)

- **`pnpm lint` fails: `Command "eslint" not found`.** Pre-existing + environment-level (the `eslint` binary isn't installed in this environment) — NOT introduced by this slice: the worker's own `lint` script is `tsc --noEmit` (clean via `pnpm typecheck`, 20/20), and no eslint config was touched. Spend-safety for the flip rides on `tsc` + the test suite + the security reviews (all green). Flagged to orch2 for a tooling fast-follow; no code change owed.

## How to use what was built

- CP-3b: at arming, the desktop worker-host passes a valid source stub as `gateAutoIngest`'s 4th arg; the arming bundle flips the source `outputSchemaId`.
- CP-5b: the COST-1 cap is live for raw-model PROVIDER routes today (deny-only). Override `BackendsConfig.budgetPricing` to inject deployment pricing or `{}` to force the runtime-only degrade.
