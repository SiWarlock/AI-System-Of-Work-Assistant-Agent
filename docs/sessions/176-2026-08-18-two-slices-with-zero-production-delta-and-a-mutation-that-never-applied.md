# Session 176 — two slices with zero production delta, and a mutation that never applied

**Date:** 2026-08-17 → 2026-08-18 · **Track:** `main` · **Role:** worker-implementer · **Predecessor:** this area’s prior session — `173-2026-08-14-two-errata-a-vacuous-remedy-and-the-scopes-i-kept-getting-wrong.md` · chronological — `175-2026-08-18-two-audit-paths-and-five-sentences-that-were-false.md` · **Successor:** _(none yet — cycled at a clean boundary)_
**Phase:** 24 (hardening tail) · **Area:** `apps/worker` (+ `packages/db`, `packages/workflows` owned, untouched)
**Commits:** `8df1db46` (`### 24.79` residual) · `a883c2f7` (`### 24.84` fixture-migration leg)

## Why this session existed

Activated on a stated premise — *"`### 24.25` unresolved and a compile red in `packages/workflows`"* — with the instruction to verify it rather than inherit it. **Both halves were false**, which set the tone for everything after: this session's output is mostly *measurements that corrected records*, and two small commits that carry zero production delta between them.

## What was built

**Files modified — `8df1db46` (comment-only, +22/−6, 0 non-comment residue):**
- `apps/worker/src/api/adapters/readModel.ts` — `dashboardCards()`'s comment claimed the global surface was *"cross-workspace-safe by construction, populated by the workflows."* Both clauses were false. Replaced with: the shape-vs-scope distinction (`readCardSources` is a fixed six-field **shape** control; `DashboardCardSource` has **no workspace field at all**, so the reader cannot scope-check even in principle), the measured writer census, and what the first real producer owes. Also corrected the same file's header `:16-17` and `getReadModel` doc `:364`, which still credited *"the workflows"* — narrowly, to "a producer," without widening to a claim about all read-model rows I had not measured.

**Files modified — `a883c2f7` (test-only, +8/−8, zero production delta):**
- `apps/worker/test/api/procedures/queries.test.ts` — 6 WS-8 `globalDrillDown` pins re-based off ids the tightened brand rejects.
- `apps/worker/test/api/adapters/storeBackedWorkspacePosture.test.ts` — the WS-8 re-gate pin, same.

**Not a commit, but the session's largest output:** a worker-territory landed-state sweep (12 tasks gate-checked) and two premise corrections that changed other people's work.

## Decisions made

1. **`### 24.79`'s defect is a comment defect, not a logic defect — then that reasoning was refuted and I said so.** I argued at Step 2.5 that the absent workspace gate was *correct by design*, since Global Today is deliberately cross-workspace. The orchestrator approved on that reasoning. It was wrong: §9.4 (`IMPLEMENTATION_PLAN.md:1064`) specifies GCL-sanitized results and *"never raw cross-workspace content,"* reached via the GCL Visibility Gate (`global_surface`). `dashboard_cards` is an **unreconciled second leg**. Reported against my own approved premise rather than shipping through it; the lead graded it a rule-4 crossing and filed **`### 24.91`** as a precondition on the first real producer.
2. **Ship the comment fix anyway.** It removes a false assurance sitting exactly where the next investigator lands; `### 24.91` carries the gap. The commit says explicitly that it does **not** close the rule-4 question.
3. **`### 24.84`'s slice is the re-mutation, not the re-base.** Per `L79`, mutation-verification does not survive a new conjunct. Seven pins, seven mutations, seven results.
4. **Verify green in BOTH brand states and name each.** Tight (contract's WIP live) and loose (HEAD `d563ddda`, throwaway worktree, removed after). Unasked; the lead promoted it to the standard for the chain, and it is why contract landed into no red window.
5. **Report scope premises that do not resolve, before starting.** Twice: the duplicate-basename warning (below) and the `24.25` premise. Both were corrected before they cost a cycle.

## Decisions explicitly NOT made

- **Did not fix the `dashboard_cards`/`global_surface` reconciliation.** That is `### 24.91`, a precondition on a producer that does not exist. Fixing it here would have been a production change inside a comment-correctness slice.
- **Did not add the cause-code assertion to `resolver_foreign_readback_fails_closed`.** It changes a pin's contract; not this slice. Routed as a Future TODO, now **`### 24.101`**.
- **Did not rule on `### 24.76`'s disposition.** I found the evidence (below) and reported it; the call is knowledge's.
- **Did not chase `main-bundle-resolution.test.ts`,** and — after the orchestrator's mid-slice correction — **did not attribute it either.** Two candidate mechanisms, neither established.
- **Did not scan `apps/desktop`** for breaking fixtures. Unstaffed; findings there are the orchestrator's. (Since confirmed zero.)
- **Did not pre-identify "the 7 red WS-8 pins" while waiting for the brief.** That set was defined by contract's security review and I did not have its definition — guessing it would have meant inventing the denominator, the exact error this round kept catching.

## TDD compliance

**Clean — with the note that neither slice had behaviour to pin, and both used the brief-defined substitute rather than skipping the discipline.**

- `8df1db46` — comment-correctness. The brief's RED substitute was **the five traces**; each site was dispositioned by tracing its mechanism, never by how the comment read. Zero-logic-delta proven mechanically (strip `+`/`-`, filter comment lines, residue must be empty) **with a positive control** that catches an injected `const x = 1;`. No test could have pinned this; none was written; that is the designed path, not a violation.
- `a883c2f7` — fixture-only. The RED discipline was **the per-pin mutation**: break what the pin exists to catch → RED → restore → GREEN, seven times. No production code was implemented in either slice, so there is no "implementation before test" case to flag.
- **One production file was temporarily weakened as a measurement instrument** (`toUiSafeGclProjection`, pin-2 probe, `L28` RED-on-weaken). Authorized in advance, restored, and verified byte-identical on three surfaces. **Zero production delta ships.**

## Cross-doc invariant audit

**Nothing owed.** No model field was added, removed, or renamed this session — one comment block and two test-fixture files. No `ARCHITECTURE.md` row is implied. One **architecture-doc note** was flagged at Step 9 for the orchestrator (that §9.4's text describes only the GCL leg while the shipped reality has two); flagged, not edited — orchestrator territory.

## Reachability

**Both slices: none, by design.** `8df1db46` is comment-only (no production surface, no new export, nothing becomes reachable — confirmed by the zero-residue proof). `a883c2f7` is test-only. No feature was left tested-but-unwired by this session, and no earlier slice's wiring was removed.

## ⭐ The finding worth carrying: a mutation that never applied

My **first** non-vacuity control mutation silently did not apply. The `sed` failed to match (an escaped `\n` plus an em-dash in the target), the test passed before and after, and **`exit 0` was indistinguishable from *"the pin held."*** I caught it only because the control diffs the file against a backup, which showed it byte-identical.

**How I now decide which mutations need an applied-proof** — the rule the orchestrator asked me to write down:

> **A RED mutation is self-proving; a GREEN one is ambiguous.**
> If a mutation is expected to red and *does* red, the red itself is evidence that the edit landed *and* reached the assertion — no separate proof is strictly needed.
> If a mutation expected to red comes back **GREEN**, that outcome has two indistinguishable causes: **the pin is blind** (a real finding) or **the mutation never applied** (an instrument failure). ⛔ **An applied-proof is therefore MANDATORY before reporting any green-under-mutation as a finding** — otherwise an instrument failure gets published as a clearance.
> ⇒ Practical form: capture the diff-line count on **every** mutation (it costs one command), but understand it is **load-bearing precisely in the case where the run does not red**. The cheap habit exists to cover the expensive case.

**Where it bites:** `sed` patterns containing escape sequences (`\n`) or non-ASCII (em-dash, `→`, `⛔`). Prefer an ASCII-only anchor, and diff-verify regardless.

⚠ Without that control, this session's seven "REDs" would each have been one unverified assumption away from meaning nothing — **including on six WS-8 safety pins.** Banked by the orchestrator as an `L190` amendment.

## Other measurements that corrected a record

- **`### 24.25` is CLOSED** (`[x] DONE`, `111506a6`), not unresolved — stale prose carried across two seals into a spawn prompt. Independently confirmed by three others.
- **No compile red in `packages/workflows`** — clean typecheck, 628/628 tests.
- **⛔ `npx` fabricates, in the *reassuring* direction.** `npx tsc --version` → `TypeScript: No errors found`; `npx vitest --version` → `PASS (628) FAIL (0)`; `npx eslint --version` → mangled JSON noise. Real binaries under `node_modules/.bin/` are sound. Handoff 028 lists five instruments that manufacture findings; **this one manufactures their absence**, so any typecheck-green sourced through `npx` is unverified. Every load-bearing number this session came from `node_modules/.bin/` or `pnpm`, and every search from `awk` (`grep` fabricated a `512 matches in 84 files` header on my first call — a third same-day reproduction of `### 24.87`).
- **The duplicate-basename warning in `### 24.86`'s scope names a file that never existed.** `packages/workflows/src/activities/buildActivities.ts`: 0 in `find`, 0 in `git ls-files`, 0 in path history, and the only `buildActivities.ts` ever *added* anywhere is the worker one. The `activities/` **directory** is real, which is why it read as plausible. The underlying hazard is real but attached to the wrong file — `packages/workflows/src` genuinely has **8** basenames duplicated across `ports/` and `workflows/`, and `buildActivities` is not among them. Corrected at `ac05a978`.
- **Territory sweep: 12 worker-tracked open tasks gate-checked, ZERO already-landed** (6 OPEN, 3 PARTIAL, 2 UNESTABLISHED, 1 pointer) — against a stated denominator of **12 of 120** open tasks. ⭐ **And the finding that outranks the sweep: 70 of 120 open tasks declare no `Track:` at all**, so *"sweep your own territory"* has a **58% blind spot by construction** and cannot compose into coverage even if all six areas run it. A property of the selector, not of anyone's execution. Filed as **`### 24.94`**.
- **`### 24.76` is PARTIAL, not tick-able.** A committed harness exists (`77b889c2`, `df39a090`) asserting reach-proof #1 (`lookupOnRetry === "empty"`), but **no `compareRevision`-passed assertion**, and its `describe` is scoped to `### 24.77` — the *fix*, not the *measurement*. The scenario is exercised **post-fix**, which is not the same claim as *"reproduced or shown unreachable."* It had been queued as tick-able.

## Open follow-ups

1. **`### 24.101`** — the bare-falsity pin census. Origin: `resolver_foreign_readback_fails_closed` asserts `isOk(p) === false` and nothing else, unlike every sibling which also pins `res.error.cause?.code`. It passes for the right reason **today** (proven by mutation), but **cannot detect its own future silent-greening** on a workspace-isolation gate. ⛔ Its Done-when requires deriving the population **by PROPERTY**, not by grepping the assertion's spelling.
2. **`### 24.91`** — precondition on the first real `dashboard_cards` producer: two cross-workspace read paths where rule 4 says *single*. Carries the `demoSeed`-no-teardown caveat (rows persist after `SOW_DEMO_SEED` clears, so *"absent"* is a property of a never-seeded install).
3. **`### 24.94`** — the `Track:` selector blind spot; bounds every future territory dispatch.
4. **`### 24.76`** — disposition is knowledge's; the evidence above is the input.
5. **`### 24.64` / `### 24.69` — UNESTABLISHED, not OPEN.** Settled by locating (or establishing the absence of) the by-concept enumeration in `docs/sessions/` or `docs/audits/`, which was outside this sweep's boundary. ⛔ Neither was folded into OPEN — that asymmetry is what hid `### 24.77` from an earlier scan.
6. **Architecture-doc note (orchestrator's):** §9.4's text describes only the GCL leg; the shipped reality has two.
7. **Instrument question, not a defect:** during the pin-2 probe, `git diff --name-only -- apps/worker/src` returned 0 while the file was demonstrably modified. A targeted reproduction did **not** reproduce it. Single unexplained observation; if it recurs for anyone it belongs with `### 24.87`.

## For your successor

- **The two premise corrections cost ~10 minutes each and saved two cycles.** Check a scope premise *before* starting; an unresolving citation is a question, not a verdict (`L93`).
- ⭐ **A count you PREDICTED is not a count you MEASURED.** At staging, the `ws-OTHER` re-base moved 2 lines where I had predicted 1 — the second being the comment that *quotes* the fixture id. Correct outcome, but I verified before committing rather than trusting a global `sed`. That gap is where a stray edit hides, and it recurred as a theme all round.
- **Say which state a green was measured in.** `0 cached, 32 total` on a forced turbo run did **not** cover `@sow/worker` — the package was cancelled with zero output when an unrelated package failed. A banner that covers less than it appears to is instrument six's shape.
- **In single-track mode, "the tree is red" does not identify *whose* red it is.** Name the WIP owner and scope any green claim to your own files.
