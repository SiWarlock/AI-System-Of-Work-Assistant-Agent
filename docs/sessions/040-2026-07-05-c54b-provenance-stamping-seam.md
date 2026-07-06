# Session 040 — Phase-C C5.4b: the provenance-stamping retrieval seam (owner "do all 3" — blocker 2 of 3)

- **Date:** 2026-07-05 · **Mode:** single-operator (build, ultracode) · **Track:** worker
- **Predecessor:** `039-2026-07-05-approvals-inbox-workspace-scoping.md`
- **Successor:** _(next — C6 skills, the 3rd of the owner's "do all 3"; blocked on an owner decision — which skills / what governance)_
- **HEAD at close:** `d170c3b` (C5.4b code) + this session's doc commit. Prior: `4ac7fe0` (039 doc).
- **Gate at close:** repo-wide `turbo typecheck test` **31/31**; the two touched worker test files **81** (16 decorator + 65 synthesis incl. 4 boot-wiring). Security + code-quality reviews **clean (0 crit/high/med)**.

## Why this session existed

The owner answered "do all 3, use workflows where possible." Blocker 1 (§9.8 approvals scoping) landed session 039. This session did **blocker 2 — C5.4b, the last contentTrust go-live gate**: make a `RetrievedSource` carry a SOUND `knowledge_writer` provenance so `deriveCopilotContentTrust` can flip a Copilot job to propose-capable — bound to a *verified* admission, never a blanket stamp (which re-opens the ING-7 bypass C4 cannot catch).

## The design workflow (ultracode)

Ran a **survey → design → 4-adversarial-verifier** Workflow (`wf_5cbbed96-9d9`, 9 agents, 0 errors). It established the smallest sound slice: a **thin `CopilotRetrievalPort` decorator** composing a `CopilotServingOracle` verdict — NOT a full rewire of retrieval onto `admitForServing` (whose five worker deps — CanonicalFactSet allow-set, committed-Markdown rehydrate, ParityReport coverage, QuarantineLedger, Keychain SecretsPort — are all unbuilt, and which if wired would turn propose ON, violating "structurally OFF today"). Keeping the gate behind an **oracle port** keeps the decorator pure/TDD-able and lets the real oracle land later without touching it. Verdicts: degraded⇒untrusted **HOLDS**; the other three **PARTIAL** with concrete ship-now corrections (below) + named go-live preconditions.

## What was built

- **NEW `apps/worker/src/api/procedures/copilotProvenanceStamp.ts`** — `createProvenanceStampingRetrieval({inner, oracle})` (the decorator), the `CopilotServingOracle` port + `CopilotServingVerdict` discriminated union (gated{admittedCitationIds} | degraded_direct_markdown — the degraded arm carries NO set, so a trusted stamp is structurally unrepresentable under degrade), and `createInterimDegradedServingOracle` (the always-degraded honest-interim input). 16-test suite.
- **`copilotClaudeSynthesis.ts` `buildCopilotDeps`** — new optional `servingOracle?: () => CopilotServingOracle`; wraps the chosen retrieval (fixture or gbrain-subprocess) in the decorator on the real path only. 4 boot-wiring tests ("a flipped ternary can't ship silently").
- **`boot.ts`** — new `copilotProvenanceStamping?` flag (OFF); wires the INTERIM oracle when on. So even flag-ON + a live gbrain hit ⇒ un-stamped ⇒ untrusted ⇒ propose OFF (the C5.4a pattern: a real mechanism kept OFF by its INPUT).

## The 4 ship-now corrections (folded from the verifiers)

1. **Always OVERWRITE provenance from the verdict** — `projectSource` rebuilds `{citationId,title[,provenance]}` from scratch, dropping any inner-supplied provenance, so a future inner GBrain adapter can never self-stamp its way to trusted (closes the C1/C4.4 latent leak).
2. **Subset-or-FAIL-CLOSED** — a foreign admitted id (⊄ retrieved citationIds) signals the oracle admitted against a *different* context (a TOCTOU); the whole verdict is distrusted (strip all), not partially honored.
3. **Strict discriminated-union mode read** — stamp only when `verdict.mode === "gated"` (never a truthiness/`in` check); a stray `admittedCitationIds` on a non-gated verdict stamps nothing.
4. **Whole-body no-throw** — the entire `retrieve` is try/caught; malformed `sources` (non-array / null element) ⇒ typed err before the oracle; WS-8 scope enforced before the oracle; any thrown/rejected fault ⇒ typed err (§16).

## Review outcome — CLEAN

- **security-reviewer:** all 5 invariants PASS (blanket-stamp/ING-7, degraded⇒untrusted, identity-join+TOCTOU, WS-8+fail-closed/no-throw, structurally-OFF wiring); no secret/raw-content leak; GO-LIVE PRECONDITIONS doc accurate. **0 crit/high/med**, 1 low (citationId non-injectivity within a context — folded as a 5th go-live precondition).
- **code-quality-reviewer:** no correctness bugs; matches the sibling copilot-adapter conventions; the sole `retrieve` consumer (`answerCopilotQuestion`) awaits the new async signature. **0 high/med**, 2 lows (folded: end-to-end `untrusted` assertions on the malformed-verdict tests + a missing-mode test).

## Decisions made

- **Decorator + oracle port, not a retrieval rewire** — the smallest sound slice; keeps the decorator pure and the real oracle a clean future swap.
- **Interim = always-degraded oracle** — the mechanism ships real, its INPUT keeps it OFF; wiring a real oracle is a security-review-gated go-live event, never a flag flip.
- **No frozen-contract change** — `SourceProvenance` + `RetrievedSource.provenance?` already existed (C5.4a); `CopilotServingOracle`/`CopilotServingVerdict` are internal worker types.

## Decisions explicitly NOT made (deferred — the real-oracle sub-slice)

The real `admitForServing`-backed oracle, gated behind **five named go-live preconditions** (documented in the module header + the go-live runbook §1): (1) content-integrity — rebuild `blocks[]` from proven `AdmittedFact.content`; (2) per-fact vs per-page granularity (all-or-nothing per citationId); (3) resolver injectivity (slug→factIdentity); (4) `ServingError`→oracle-`err` mapping; (5) citationId uniqueness within a context. Plus the propose-path governance eval (eval-security track).

## TDD compliance

Clean. RED-first throughout: the decorator suite (module-missing RED → GREEN), and the boot-wiring "decorator-wired" guard (spy-oracle-never-consulted RED → GREEN after wiring). All folded review corrections landed as tests.

## Reachability

`answerCopilotQuestion` (copilot.ts:451, awaits) → `deps.retrieval` = (on the real path with `copilotProvenanceStamping` on) the provenance-stamping decorator wrapping the gbrain-subprocess/fixture retrieval → `oracle.admit` (interim ⇒ degraded) → stamp map ⇒ every source un-stamped today ⇒ `deriveCopilotContentTrust` untrusted ⇒ `resolveCopilotAgentCapability` read_only ⇒ propose never granted. Live + wired; structurally OFF by its input.

## Open follow-ups

- **[owner decision] C6 — skills** (blocker 3 of "do all 3"): expose skill access to the Copilot agent (Option-C's third leg). Under-specified — needs the owner to pick WHICH skills + the governance for skill I/O before the mechanism is built.
- **[go-live, deferred] the real `admitForServing`-backed serving oracle** + its 5 preconditions + the propose-path governance eval (eval-security track — coordinate).
- **[tracked, pre-existing]** the worker forbidden-#4 boot version-guard is UNWIRED (wire before the next NON-additive migration).
