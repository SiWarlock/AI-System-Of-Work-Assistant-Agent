# /tdd brief — serving_context_loader (gate 4, G1e-2)

## Feature
The worker-side production `createServingContextLoader` — a `ServingContextLoader` that assembles a `WorkspaceServingContext` for a workspace at its current committed vault revision, so the real `createServingGateOracle` (oracle-core, `6e87602`) can be built over it. It is wired behind boot's `servingOracleFactory` seam **as a dormant, constructible factory — the interim degraded oracle stays the selected default** (nothing is stamped on the live path; propose stays structurally OFF). This closes the last *build* piece of gate 4's serving side; flipping selection to the real oracle stays a separate, security-review-gated go-live event.

## Use case + traceability
- **Task ID:** G1e-2 (gate 4 — the real `admitForServing`-backed serving oracle's serving-context assembly).
- **Architecture sections it implements:** `ARCHITECTURE.md §6` (Knowledge: the §6(v) default-deny `ServingGate`/`admitForServing` + the "Copilot serving-oracle seam — the last go-live gate" note). Related: `§12` (ParityReport / coverage), `§13` (the Copilot enablement ladder + go-live gates).
- **Related context:** `docs/runbooks/copilot-propose-go-live.md` §1 (authoritative go-live gate list + the five GO-LIVE PRECONDITIONS); the oracle-core `createServingGateOracle` + all its types in `apps/worker/src/api/procedures/copilotProvenanceStamp.ts`; the production `RehydrateFn` `createVaultRehydrate` (`packages/knowledge/.../serving/vault-rehydrate.ts`, G1e-1 `2123f66`); the serving gate `admitForServing` + its shapes (`packages/knowledge/.../serving/rehydration-gate.ts`); `deriveCanonicalFacts` (`.../derive/canonical-fact-deriver.ts`) and `createQuarantineLedger` (`.../serving/quarantine-ledger.ts`).

## Acceptance criteria (what "done" means)
- [ ] `createServingContextLoader(deps)` returns a `ServingContextLoader` (`(workspaceId) => Promise<Result<ServingContextResolution, FailureVariant>>`) that NEVER throws (§16).
- [ ] On a workspace with a committed, KW-stamped page note it returns `{ mode: "ready", context }` where `context` carries: `revisionId` = the head committed revision; `allowSet` = `deriveCanonicalFacts` over the committed snapshot; `rehydrate` = `createVaultRehydrate(readNote, allowSet)`; `quarantine` = `createQuarantineLedger(seed)`; `coverage` derived from the real ParityReport + GbrainPin (see Step-2.5 Q1); `servingDeps` = `{ secrets, signingKeyRef }`; and the injective `resolveCitation`.
- [ ] Returns `{ mode: "degraded" }` (a NORMAL state, not a fault) when the workspace cannot be gated-served: never indexed / empty vault / no allow-set / **signing key unresolvable** / a degraded coverage leg. Returns a typed `err` only on an actual load failure.
- [ ] `resolveCitation("gbrain:<slug>")` resolves to `[<page factIdentity>]` (i.e. `["page:<slug>"]`) for a served page — and returns `null` for an unknown slug, a malformed citationId (not `gbrain:<slug>` form), or a slug that is **not uniquely** resolvable to one served page. The back-map is injective (distinct citationIds → disjoint factId sets).
- [ ] `resolveCitation` returns **only the page fact** for a page that also has link/tag/timeline facts (Step-2.5 Q2 — the page is the sole stamped + rehydratable unit; a link fact would fail the gate's leg A and break all-or-nothing).
- [ ] **End-to-end serving-trust pin (own commit):** `createServingGateOracle({ admitForServing, loadContext: createServingContextLoader(deps) })` returns a **gated** verdict admitting the citationId of a genuinely KW-stamped page, and a verdict that does **NOT** admit an unstamped OR body-tampered page (mirrors G1e-1's writer→serving proof, on the worker side).
- [ ] **Boot dormancy pin:** boot's default `servingOracleFactory` still resolves to `createInterimDegradedServingOracle` — the real loader-backed oracle is constructible behind the seam but NOT the selected default (nothing stamped today).
- [ ] All unit tests in `apps/worker/test/api/procedures/servingContextLoader.test.ts` pass.
- [ ] `/preflight` clean; repo-wide `pnpm -w turbo run typecheck test` green (no contract change expected — see Cross-doc impact).

## Wiring / entry point (Step 7.5)
`apps/worker/src/boot.ts` — the real oracle is assembled as `createServingGateOracle({ admitForServing, loadContext: createServingContextLoader(...) })` and made available behind the existing `servingOracleFactory` seam (line ~605), **but the default selection remains `createInterimDegradedServingOracle`** (dormant / reachable-but-not-selected). Confirm the real factory is referenced on the real path (not dead code) yet never selected as the default — a test asserts the default stays interim. Selecting the real oracle is a future security-gated go-live step, never a flag flip in this slice.

## Files expected to touch
**New:**
- `apps/worker/src/api/procedures/servingContextLoader.ts` — `createServingContextLoader` + the injective `gbrain:<slug>`→`page:<slug>` resolver + the ServingCoverage derivation from ParityReport+GbrainPin + the dormant real-oracle factory helper.
- `apps/worker/test/api/procedures/servingContextLoader.test.ts` — the RED suite.

**Modified:**
- `apps/worker/src/boot.ts` — construct the real loader-backed oracle behind `servingOracleFactory` while keeping `createInterimDegradedServingOracle` the selected default (dormant wiring).

If implementation needs files beyond this list (e.g. a shared `CommittedVaultReader` seam type placed elsewhere), **flag at Step 2.5** before going GREEN.

## RED test outline (Step 2) — `apps/worker/test/api/procedures/servingContextLoader.test.ts`
1. **`loader_assembles_ready_context_for_stamped_page`** — Asserts: given a committed vault snapshot with one KW-stamped page + a resolvable signing key + clean parity/valid pin, `loadContext(ws)` → `ready`; `context.allowSet` contains the `page:<slug>` fact; `context.rehydrate(page:<slug>)` is `ok`; `revisionId` == head. Why: §6 serving-context assembly.
2. **`loader_degraded_when_no_allowset`** — Asserts: an empty / never-indexed vault → `{mode:"degraded"}` (not `err`, no throw). Why: §6(v) fail-closed default; degraded is a NORMAL state.
3. **`loader_degraded_when_signing_key_unresolved`** — Asserts: SecretsPort cannot resolve `signingKeyRef` → `degraded`. Why: runbook §1 "no signing key → no sig can be verified → fail closed."
4. **`coverage_degraded_on_dirty_or_absent_parity`** — Asserts: an injected dirty/absent ParityReport OR a mismatched GbrainPin yields a non-green `ServingCoverage` (`isDegradedCoverage(coverage)===true`) — and the loader resolves `degraded` rather than serving under it. Why: runbook §1 "dirty parity / pin mismatch ⇒ untrusted"; pins the fail-closed derivation (NOT hardcoded all-green).
5. **`resolve_citation_maps_slug_to_page_factidentity`** — Asserts: `resolveCitation("gbrain:<slug>")` === `["page:<slug>"]` for a served page. Why: preconditions 2/3 (resolver).
6. **`resolve_citation_withholds_unknown_malformed_or_nonunique`** — Asserts: unknown slug → null; `"not-a-citation"` / `"gbrain:"` → null; a slug mapping to >1 served page → null. Why: precondition 3 (injectivity / withhold-on-ambiguity).
7. **`resolve_citation_returns_only_page_fact`** — Asserts: for a page carrying link + tag facts, `resolveCitation` returns exactly `["page:<slug>"]` (not the link/tag identities). Why: precondition 2 all-or-nothing + `createVaultRehydrate` serves page facts only.
8. **`oracle_over_loader_admits_stamped_withholds_unstamped`** (SAFETY PIN — own commit) — Asserts: `createServingGateOracle` over the real loader returns `{mode:"gated", admittedCitationIds: {gbrain:<slug>}}` for a genuinely stamped page; and admits **nothing** for an unstamped page and for a body-tampered page (hash mismatch / bad sig). Why: §6(v) unforgeable Markdown-provenance, end-to-end on the worker side.
9. **`loader_never_throws_folds_to_err_or_degraded`** — Asserts: a throwing vault reader / SecretsPort / deriver folds to `err` or `degraded`, never a throw. Why: §16 no-throw boundary.
10. **`boot_default_serving_oracle_stays_interim`** — Asserts: with `copilotProvenanceStamping` on, boot's selected `servingOracleFactory` still builds an oracle that always degrades (nothing admitted). Why: dormancy — the real oracle is constructible but not selected.

## Cross-doc invariant impact (implementer flags at Step 9; orchestrator writes the docs)
- **Model field changes:** **none.** Every type consumed already exists and is frozen/exported: `CanonicalFactSet`, `RehydrateFn`, `ServingCoverage`, `ServingDeps`, `QuarantineLedger`, `SecretsPort`/`SecretRef`, `RevisionId`, and the worker-internal `WorkspaceServingContext` / `ServingContextResolution` / `ServingContextLoader` / `CopilotServingVerdict` (all in `copilotProvenanceStamp.ts`). No Appendix-A / snapshot change.
- **Orchestrator doc rows to write hot (Step 9 routing):** none. **Architecture-doc note candidate only:** the §6 "Copilot serving-oracle seam" note calls the real oracle "PLANNED-NOT-BUILT" — once G1e-2 lands, the orchestrator may update that prose to "serving-context assembly BUILT + dormant; selection + content-integrity precondition remain." Flag at Step 9 as an arch-doc note (orchestrator writes hot), NOT a contract change.
- **§2.5-seam model touched?** No — `WorkspaceServingContext` et al. are worker-internal, not Appendix-A frozen models.

## Things to flag at Step 2.5
1. **ServingCoverage source — real `ParityReport` + `GbrainPin` (fail-closed) vs interim all-green?** My default vote: **derive from the real latest ParityReport + GbrainPin via injected reader seams, fail-closed to a degraded leg (⇒ `degraded` resolution) when a coverage input is absent / dirty / mismatched — NEVER hardcode all-green.** Rationale: runbook §1's hard rule mandates degraded coverage ⇒ untrusted on dirty parity / pin mismatch / oracle-build failure / unresolved key; hardcoding all-green plants a latent false-admit the day someone selects the loader-backed oracle. Deriving from real inputs keeps the loader honest-by-construction — with corpora absent today, coverage is degraded ⇒ the oracle degrades on everything (sound + inert), and boot keeps the interim oracle default regardless.
2. **`resolveCitation` granularity — only the page fact vs all of a page's facts?** My default vote: **only the page factIdentity (`page:<slug>`).** It is the sole stamped (G1d-2 mints one page-stamp per note) and sole rehydratable (`createVaultRehydrate` serves page facts only) unit; returning link/tag/timeline identities would make them fail the gate's leg A (page-hash ≠ fact-hash) and drop the whole page under all-or-nothing.
3. **Boot dormancy mechanism (dead-code-safe).** My default vote: **construct the real `createServingGateOracle(...)` factory on the real path but keep `createInterimDegradedServingOracle` the SELECTED default `servingOracleFactory`**; reference the real factory from a test (so it isn't dead code) and gate any real selection behind an internal not-yet-set precondition. No new live flag; selection stays a future go-live step.
4. **QuarantineLedger seed source.** My default vote: **inject the seed, default empty.** The ledger is operational truth; wiring the real rehydration from the operational store is a follow-up. An empty ledger is sound under dormancy (coverage-degraded keeps everything off anyway).
5. **Committed vault snapshot + head revision source.** My default vote: **inject a `CommittedVaultReader` seam** (`workspaceId → { revisionId, files: ReadonlyMap<path,content> } | undefined`) so the loader stays pure + unit-testable; boot binds it to the real FileVault/backends adapter, or leaves it unbound ⇒ the loader degrades (preserving dormancy). Confirm the exact worker adapter that can produce a committed snapshot + head revision per workspace, or accept the seam-unbound-⇒-degraded default for this slice.

## Dependencies + sequencing
- **Depends on:** G1e-1 `createVaultRehydrate` (`2123f66`) · oracle-core `createServingGateOracle` (`6e87602`) · G1d writer mint (`9a1cac4`) — all landed. `deriveCanonicalFacts` / `createQuarantineLedger` / `admitForServing` exported from `@sow/knowledge`.
- **Blocks:** the real-oracle go-live wiring — precondition 1 (content-integrity: a `CopilotServingVerdict` shape change to carry admitted `content`+`mdContentSha` so the go-live path rebuilds `RetrievedContext.blocks` from proven bytes — owner-gated contract slice), real KW-authored corpora to stamp, and the eventual selection flip.

## Estimated commit count
**2.** (1) `createServingContextLoader` + injective resolver + coverage derivation + unit tests (tests 1–7, 9). (2) The end-to-end **serving-trust safety pin** (test 8) + the dormant boot wiring (test 10) — a safety-critical provenance/serving pin gets its OWN commit per the bundling rule.

## Lessons-logged candidates anticipated
- **Convention candidate** — "The citation→fact resolver returns the page fact ONLY; the page is the sole stamped + rehydratable unit, so link/tag/timeline facts must never enter an all-or-nothing admission."
- **Convention candidate** — "Serving coverage is derived from real ParityReport+GbrainPin and fail-closes to degraded; never hardcode all-green even in a dormant loader."
- **Architecture-doc note candidate** — the §6 serving-oracle-seam prose moves from "PLANNED-NOT-BUILT" to "serving-context assembly built + dormant; selection + content-integrity precondition remain."

## How to invoke
1. Read this brief end-to-end — the Step-2.5 questions need answers before tests go GREEN.
2. Run `/tdd serving_context_loader` in the implementer session.
3. Step 0 (Restate) — confirm the restatement matches the Feature line.
4. Step 1 (Identify files) — confirm the file list.
5. Step 2.5 — ping back with answers to Q1–Q5 (or take defaults). Do not proceed to Step 4 until orchestrator signs off.
6. **Step 8 — MANDATORY adversarial review** (general-purpose Agent, security + code-quality prompts): this is a provenance / serving-trust surface. No false-stamp path may survive; §16 no-throw + fail-closed default must hold on every axis.
7. Step 9 — surface anything outside the anticipated lessons-logged candidates + the arch-doc note flag.
