# Session 170 — three fixes, two measurements, and the claims I had to retract about my own work

**Date:** 2026-08-14 · **Phase:** 24 (hardening tail) · **Area:** `packages/knowledge` (knowledge-implementer, single-track `main`)
**Predecessor:** `167-2026-08-13-the-guard-not-added-and-the-finding-i-had-to-retract.md` (this area's prior session — also mine)
**Successor:** _(filled in by the next `/session-end`)_

**Commits:** `77b889c2` (`### 24.77`) · `1c0bc625` + `f0d79d07` (`### 24.78` Parts 1+2) · `df39a090` (`### 24.72` Leg A) · `5d3ba8af` (`### 24.78` citation repair)
**No-commit slices:** `### 24.76` (execution) · `#77` (Claim-2 re-derivation)

---

## Why this session existed

Session `167` closed after `### 24.67`. The orchestrator kept dispatching, so this is a second close-out on the same spawn. The through-line: **every slice this stretch was downstream of a measurement, and three of them ended by retracting a claim I had made myself.**

## What was built

**`77b889c2` — `### 24.77`, the fix leg for `24.76`.** `applyPlan` no longer writes an audit row asserting an applied revision when the diff is empty but the plan declares mutations. New `alreadyApplied` discriminator + `summarizeAlreadyApplied`; 7 pins.

**`1c0bc625` / `f0d79d07` — `### 24.78`, both parts.** The barrel stops re-exporting `./gcl/visibility-gate` and `./gcl/cross-workspace-links`; `package.json` then denies those two exact subpaths, closing both public paths at the type *and* runtime layers.

**`df39a090` — `### 24.72` Leg A.** Two new `WriteFailure` members (`audit_record_failed`, `revision_record_failed`), each carrying the durable `revisionId`; both post-commit `await`s wrapped. Lands with **one declared cross-area red** — `mapWriteFailure`'s exhaustiveness guard doing its job. Leg B is `#75`.

**`5d3ba8af` — `### 24.78`'s citation repair.** Nine line-number citations re-anchored on symbols and populations.

## Decisions made

1. **`24.67`: NO GUARD, and the option that looked cheapest was a description of current behaviour.** Reusing `commit_failed` would have changed nothing observable.
2. **`24.77`: write a truthful row rather than suppress one** — and the sibling `tombstone.ts` shows suppression is honest *only* when the signal moves into the return type, which `WriteSuccess` cannot do (→ `### 24.80`).
3. **`24.78` Part 2: two exact denies, not `./gcl/*`.** A blanket would have closed two legitimately-public modules, creating a *public-by-one-door* asymmetry — the defect shape this arc was chasing.
4. **`24.72`: two distinct members, not one.** A caller that cannot tell which record is missing cannot remediate either; `24.58` measured what collapsing costs downstream.
5. **`24.78` item 2: `L88` decided MUST-AGREE ⇒ single-sourced.** The guarantee lives where the type is declared; this package names the type and states only the consequence.

## Decisions explicitly NOT made

- **No rollback of the Markdown commit** in `24.72` — pinned by vault *content* in every fault test.
- **No rule number asserted** for `24.72`'s grading — measured 0 hits across 59 added lines. The lead graded it rule-1-**adjacent**.
- **No `changed` discriminator on `WriteSuccess`** — filed as `### 24.80` rather than added, because a field no consumer reads is itself an `L106` defect.
- **The `./*` wildcard was not narrowed globally** — it would have broken two real deep-importers across two tracks for no gain.

## TDD compliance

**Clean on both fix legs.** `24.77`: 3 defect pins RED, both controls GREEN before *and* after — the shape that proves controls are controls. `24.72` Leg A: 6 RED, honest-path control GREEN throughout. `24.78` and the citation repair are comment/config-only.

**Mutation-verified throughout**, each in a short declared window restored byte-identically with a residue check: the `24.77` guard constant-fired (3 red), its discriminator narrowed to creates-only (1 red — reviewer's exact mutation), and the `24.78` subpath deny tested via `./markdown-vault/*` against a real importer.

## Cross-doc invariant audit

**No cross-doc row owed.** `WriteFailure` and `KnowledgeCommitFailureCode` are package-local — no schema file, no Appendix-A row, no frozen snapshot (orchestrator verified before dispatching, precisely so this would not be a frozen-contract repeat). ⚠ `24.78` Part 2 **does** narrow `packages/knowledge`'s public surface via `exports`; recorded here because it is a real public-API change even though it breaks nothing.

## Reachability

No new tested-but-unwired surface. `24.72` and `24.77` harden `applyPlan`, already live from three production bindings. `24.78` **removes** public surface. **The `24.72` pins call `applyPlan` directly, which is the demonstration** that its guard does not rest on the CAS or on `createCommitActivity`'s catch — both absent by construction in the test.

## Preflight

`turbo run test --force` → **`14 successful, 16 total`**. Every suite that ran is green — contracts 813 · domain 308 · policy 515 · providers 378 · integrations 544 · **knowledge 764 (+1 skipped)** · workflows 625.

⛔ **The single failure is `@sow/workflows#build`, and it is NOT my declared red any more.** `commitKnowledge.ts:97` — the site Leg A declared — is **cleared**; worker's Leg B landed the `mapWriteFailure` cases while I was closing out. The two remaining errors are downstream at `sourceIngestion.ts:288` / `:368`, which is the cascade predicted at Leg A's Step 2.5.

⚠ **Recorded this way deliberately:** *"my declared red still stands"* would have been the convenient sentence and it is false. **The red moved; the ownership moved with it.**

⭐ **Flagged mid-close-out rather than filed:** `commitFailureState` (`:368`) is the ONE case still unwritten, and it is exactly the retryable-vs-terminal decision `#77`'s precondition governs. Worker is at that line now.

## Open follow-ups

1. **`#75` (Leg B)** carries a precondition from `#77`: **map the new members to a TERMINAL state, or first establish that a commit-stage `failed_retryable` cannot re-drive.** `deriveIdempotencyKey` is deterministic at all three bindings, so a re-drive reuses the key by construction.
2. **`#76`** — the System-Health hop. The fault reaches `commitFailureClass` but **under the wrong class**; until this closes, `writer.ts` step 8's promise is a promise, not a description.
3. **Unmeasured:** whether a commit-stage `failed_retryable` is re-driven back through step 7. The *"re-drivable via the outbox"* comment is on **step 9**, a different origin — deliberately not transferred.
4. **`### 24.80`** — `WriteSuccess` cannot tell a caller applied from already-present, and `createCommitActivity` drops `auditRecord` entirely, so the distinction **cannot cross the port at all**.
5. **`### 24.72` cannot close** on Leg A + `#77` alone.

## What this session is worth remembering for

⭐⭐ **I wrote a retracted claim 266 lines below my own correction of it, in the same file, hours later.** `writer.ts` already said *"IT DOES NOT ESCAPE PRODUCTION UNTYPED, AND AN EARLIER DRAFT CLAIMED IT DID"* — and I then wrote "it escaped" again in a different region of the same file. **Reading the erratum is not what caught it; grepping my own diff for the phrase is.** `L94`'s ceiling, measured on the author of the correction.

⭐⭐ **Three decays in one comment block, from three directions, none touching the file it lives in.** Worker's insertions moved my line numbers; my own later slice falsified my prose; the enumeration was grouped by spelling. **A comment describing *other* files is exposed to every decay mechanism at once.**

⭐ **Re-verifying at landing caught an error travelling the other way.** Twice it was the orchestrator's figure that my later measurement falsified. The third time it was **my own sloppy summarisation, quoted back to me** — I sampled five kinds and wrote them as exhaustive; the true tally was three comments, not one. **The rule is *the lander re-verifies*, whoever authored the claim.**

⭐ **A per-package count is a count of vantage points, not of defects.** Four packages reported the same `commitKnowledge.ts:97` error transitively; reporting the raw number would have inflated Leg B fourfold. **And `turbo` halts dependents on first failure, so one forced run under-reports — the instrument is sound; the invocation truncates.**

⚠ **A brief's dispatch surface can be sufficient for the work and insufficient for the obligations.** `### 24.72`'s Done-when carried a lead-ruled re-derivation trigger that harness task `#60` did not. The orchestrator ruled it binds the brief's author primarily — but the implementer backstop is real and narrow: **when a Done-when looks thinner than the task's stakes, open the `###` entry.**
