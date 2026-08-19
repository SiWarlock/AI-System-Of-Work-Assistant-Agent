# Session 186 — the defect I fixed, and then rebuilt one slice later

**Date:** 2026-08-18
**Track:** main (single-track, root checkout — no worktree)
**Area:** providers-integrations (`packages/policy`, `packages/providers`, `packages/integrations`)
**Phase:** 24
**Predecessor:** `docs/sessions/181-2026-08-18-the-flag-that-drifted-and-the-add-i-refuted.md`
**Successor:** —
**Landed:** `6ea9748b` (`### 24.128`) · `9d92e5e7` (`### 24.134`)
**Session doc number ASSIGNED by main-orchestrator from committed history — not computed here** (029's deterministic close-out race).

---

## Why this session existed

Two slices, and the second exists because of the first.

`### 24.128` — my predecessor's cross-area handoff pin fired exactly as its comment predicted when `### 24.120` landed. Its URL-userinfo assertion became FALSE; its other half stayed TRUE. The pin had to be NARROWED, never deleted.

`### 24.134` — my own Step-9 find from that first slice. The PRODUCTION twin of the pin still carried the pre-`24.120` reason in the present tense and closed *"do NOT delegate this module until it is resolved."* ⛔ `24.120` IS resolved ⇒ the instruction read as SATISFIED and licensed exactly the delegation `### 24.110`'s unruled second axis forbids.

⭐ **`029`'s rotted-guard class with the rot in the RELEASE direction, and that is the distinction worth keeping: an ordinary rotted pointer invites a reader to DISMISS a guard; a satisfied precondition instructs them to PROCEED.**

## What was built

**Files modified (2 — nothing outside `packages/policy` was touched in either slice):**
- `packages/policy/test/audit-signal.test.ts` (`6ea9748b`, +126/−31) — pin narrowed and renamed in place; opposite-direction control added.
- `packages/policy/src/audit-signal.ts` (`9d92e5e7`, +45/−7) — **comment-only**, proven: non-comment changed lines = 0.

**Files created:** none.

### `### 24.128` — the narrowing

| Assertion | Disposition |
|---|---|
| policy refuses `//u:p[REDACTED:raw]q@h` | retained in past-tense prose; fixture no longer asserted |
| domain judges it SAFE | ⛔ **FALSE since `24.120`** — removed |
| policy refuses `[REDACTED:credential]`, domain judges it safe | ⭐ **NEW — the surviving axis, policy stricter** |
| policy admits `private[REDACTED:raw]key`, domain refuses it | ⭐ **NEW — the CONTROL, domain stricter** |

Renamed `the_url_userinfo_axis_…` → `the_marker_axis_still_diverges_and_that_divergence_is_OWNED`, and **retagged to `task 24.110`** — the entry that OWNS the divergence — rather than `24.128`, which closes with this slice and would resolve a reader to finished work.

### `### 24.134` — the re-grounding

The block now enumerates **both** blocked delegation shapes with their opposite failure directions, states what would unblock it, defends its own pointer, and retains the spent reason past-tensed with the closure dated and attributed.

## Decisions made

1. **Narrow, never delete** — a pin that loses an assertion because a fix landed is UPDATED; one that loses its file is SILENCED.
2. **Keep the opposite-direction control as ASSERTIONS, not narration.** Without it *"policy is stricter"* is one measurement written twice from a fixture chosen to show it.
3. **Name `### 24.110` as the divergence owner, not `### 24.123`** — verified at source: 24.123's two remedy shapes change the knowledge-side scan's GRANULARITY or DECISION, and neither moves either predicate's verdict on the marker. **24.123 changes what the divergence COSTS; it does not change that it EXISTS.**
4. **Fixtures are the frozen constants**, not string literals, so the pin follows the vocabulary rather than a copy (`### 24.127`'s concern avoided rather than incurred). Cost named and covered by a non-vacuity guard.
5. **Strike-and-retain rather than delete the spent reason** — deleting the dead reason would have deleted the block.
6. **Take the `### 24.129` see-also**, labelled MECHANISM CORROBORATION and explicitly not a second blocker. My live reason rests on a mechanism; the pin makes the VERDICTS falsifiable, not the mechanism.

## Decisions explicitly NOT made

- **`(C')` is not mentioned in the `24.128` pin's ownership paragraph beyond what `### 24.110` records.** Deliberate: having just shipped a fix for a one-directional `(C')` claim, the reliable way not to repeat it is not to make the claim.
- **No delegation, no composition change, no pattern edited** in either slice.
- **`SPAN_PRESERVING_FILLER` guard NOT added** — measured: it is not exported from the `@sow/domain` barrel (`TS2305`). Recorded at the site as a stated GAP naming the cross-package test that does cover it, claiming no coverage this file provides.
- **`//u:p[REDACTED:raw]q@h` NOT promoted into `ALREADY_REFUSED`** — it is now admissible and would pin the closure, but it changes a sibling test's contract. Routed as a Carry-forward.

## TDD compliance

⛔ **Neither slice followed standard red→green, and both reasons are structural rather than convenience. Recorded rather than glossed.**

- **`### 24.128` — test-only slice, no production code.** The RED already existed (the live failing assertion). What replaced standard RED was a **mutation proof**: two mutations, each proven applied by diff before its red was trusted, restore verified **byte-identical by sha256** (`659181f2…`).
  ⭐⭐ **The second mutation existed because the first did not prove what it appeared to: vitest ABORTS a test at its first failing assertion, so mutation 1 left the control assertion unexecuted while returning a wholly convincing red.** ⇒ ***a mutation proof over a multi-assertion block is PARTIAL BY DEFAULT and looks TOTAL.***
- **`### 24.134` — comment-only; no RED exists and none was manufactured.** A test over comment text pins the WORDING and stays green on a comment false in any way the assertion did not spell. **Declared at Step 2.5, not held to Step 9.** Precedent: session `183` → `### 24.113` → here, now three deep.
  **What stood in for RED:** suite unchanged at 522/522, `it(` 15, `expect(` 28 — a comment-only slice that moves any count did something else.

## Cross-doc invariants

**No impact.** No model field added, removed or renamed. Slice 1 touched a test; slice 2 is comment-only. `AuditSignal` is policy-internal and absent from the cross-doc table. **No `ARCHITECTURE.md` pairing is owed.**

## Reachability

- **`### 24.128`** — test-only; the pin's reachability IS the suite, and Step 7.5 was therefore inverted into the mutation proof above. **Not wired to a production entry point, and that is correct.**
- **`### 24.134`** — ⛔ **HUMAN reachability, not mechanical.** The artifact is read by someone about to delegate, so the test is whether the live reason sits at the point of decision. It does: the block is in the file that developer opens, and it now names a test they can RUN to falsify it rather than asking for trust.
- **No tested-but-unwired production code was introduced by either slice.**

## Open follow-ups

Routed hot at Step 9 and owned by the orchestrator — listed here only so they are not lost:

- **`### 24.110`'s Done-when amendment** — closing it via `(C')` would orphan the marker divergence behind a tick that looks fully earned. My flag; orchestrator wrote it.
- **Promote `//u:p[REDACTED:raw]q@h` into `ALREADY_REFUSED`** so the closure is PINNED rather than narrated in prose. ⚠ **Now carries a SECOND independent reason:** `24.134`'s comment states *"both modules refuse that value"* and, since `24.128` removed the policy-side assertion, **only `@sow/domain`'s test pins it.** Mitigated by anchoring the claim to the three commits rather than to "today"; the residual is real.
- **Export `SPAN_PRESERVING_FILLER` from `@sow/domain`** so the control pair can get a local non-vacuity guard — contract territory.
- **The U+2028 detector finding** (below) — filed by the orchestrator as its own item, deliberately NOT onto the git-wrapper entry.

**Still mine, unstarted:** `### 24.63`, `### 24.65`, `### 24.68`, `### 24.70`, `### 24.81`, `### 24.82`, `### 24.95`, `### 24.110`'s delegation half (BLOCKED), `### 24.118` step 2 (BLOCKED behind contract's step 1), `### 24.50`'s providers leg.

## Method notes worth carrying

⛔⛔ **1 — I FIXED A DEFECT AND THEN REBUILT IT ONE SLICE LATER, IN A NEW FORM.** `24.134` exists because a precondition satisfiable by A TASK COMPLETING read as permission. My first draft of the fix blocked delegation on a MECHANISM — *"delegating makes this module start stripping"* — which `security-reviewer` executed and found **FALSE for `(C')`**, the shape `### 24.110` records as composing. ⇒ ***a reader implementing `(C')` checks the stated reason, finds it does not apply, and concludes the block was about wholesale delegation.*** **Same class, new form, one slice later.**

⛔⛔ **2 — THREE INSTANCES OF ONE SHAPE ACROSS TWO SLICES, ALL MINE, ALL WHILE QUOTING MY OWN RULE ABOUT IT.** A claim true in the direction I was thinking about and silent or false in the other: the `(C')` sentence in the pin (true of refusals, silent on the SAFE verdict) · the `24.123` ownership sentence (true of the marker pair, silent once I added the control pair) · the `24.134` block (true of `(B)`, false for `(C')`). **My own sentence is *"monotone is a claim about LEAKS and is SILENT about AVAILABILITY"* and I under-covered availability three times.**
⇒ ⭐ ***A claim about a guard must be quantified over every SHAPE the guard must stop, not over the shape that motivated it.*** ⚠ **Knowing the rule did not make me apply it — which is the argument for a mechanical check rather than more care.**

⭐⭐ **3 — A RE-GROUNDING MUST DEFEND ITS OWN POINTER.** The `24.134` block anchors to `### 24.110`, an OPEN entry **whose closure is explicitly planned**. The moment it is re-homed and ticked, a reader greps it, finds it closed, and the block reads as discharged — **exactly as `24.120` does today.** Fixed with one clause: *a tick there means the divergence was RE-HOMED, NOT RELEASED.* ⇒ ***a block re-grounded on a task pointer must state what that pointer's CLOSURE means, or it is a satisfiable precondition wearing a fresh date.***

⛔ **4 — TWO OBVIOUS U+2028 DETECTORS RETURN 0 AGAINST A CONTROL THAT PROVABLY CONTAINS THE BYTES.** Control: `printf 'x\xe2\x80\xa8y\n' > /tmp/ctl.txt`; `od -An -tx1` → `78 e2 80 a8 79 0a`.
❌ `LC_ALL=C grep -c $'\xe2\x80\xa8\|\xe2\x80\xa9' <f>` → **0** · ❌ `perl -ne '$c++ while /\x{2028}|\x{2029}/g'` → **0** (no `-CSD`, so `\x{…}` never matches raw bytes)
✅ `LC_ALL=C grep -c -a -F $'\xe2\x80\xa8' <f>` → **1** · ✅ `perl -ne '$c++ while /\xe2\x80\xa8|\xe2\x80\xa9/g'` → **1**
⭐ **ISOLATED: it is the `\|` ALTERNATION, not the encoding — the single-pattern BRE returns 1.** ⇒ **the check whose false-clean breaks a TypeScript parse fails toward clean in its two most natural spellings.**

⚠ **5 — THE FABRICATING-OUTPUT SURFACE RETURNED A CORRECT NUMBER.** `pnpm vitest run <file> --dir .` → `PASS (15) FAIL (0)`, `029` instrument #7's format. **Unlike that instance (an absurd `628` from `--version`), the count was RIGHT.** ⇒ ***the tell was the FORMAT, not the value; a plausibility check on the number passes it straight through.*** All reported figures came from `pnpm --filter … test`.

⭐ **6 — A GREEN OBTAINED BY WAITING FOR A WINDOW IS NOT A PROPERTY OF YOUR CHANGE.** Slice 2 could not report a monorepo green: `@sow/domain` and `@sow/knowledge` were RED from two teammates' legitimate red-first slices (`### 24.132`, `### 24.136`). **Attributed by measurement with positive controls — domain does not declare `@sow/policy` at all (0), so it is structurally unreachable from me; knowledge's errors name THEIR missing exports with zero of my symbols.** ⛔ **On slice 1 I re-ran and caught a green window. Treating that as the standard makes a gate claim depend on other people's slice timing.** **For a comment-only change the 0-non-comment-lines proof is the stronger evidence anyway.**

⚠ **7 — DISCLOSURE AGAINST MYSELF: I created a scratch probe file in the shared tree** (`packages/policy/test/__export-probe-DELETEME.ts`) to settle whether `SPAN_PRESERVING_FILLER` is exported, ran one typecheck, deleted it. **~15 seconds, removal verified with a positive control — and it is the exact discipline I had invoked at Step 2.5 to avoid.** ***A brief risk taken knowingly and not reported is indistinguishable from one not noticed.***

⭐ **8 — REVIEWER CONVERGENCE IS NOT A SECOND DEFECT.** On slice 1 both reviewers independently found the stale pre-`24.120` claims in the test file's header; counted once. **Across both slices the reviewers produced 4 mediums I acted on, and the two that mattered most were both against text I had just written to fix the same class.**

## Gates

- `pnpm --filter @sow/policy test` → **522 passed (522)**, 19 files (was `1 failed / 521 passed` at session start)
- `pnpm --filter @sow/policy typecheck` → exit 0
- Slice 1 close: `pnpm -w turbo test --force --continue` → **20/20, `0 cached, 20 total`** · `typecheck --force` → **20/20, `0 cached`**
- Slice 2 close: ⛔ **monorepo NOT green — `@sow/domain` + `@sow/knowledge` red from other sessions' in-flight red-first slices, attributed above. My package green; my change proven incapable of behaviour effect.**
- ⚠ **"lint" in this repo IS `tsc --noEmit`** — not separate coverage.
- ⚠ **`format:check` exists as a script in NO package** — that preflight leg is **ABSENT, not passing.**

---

## `/preflight` — RUN, NOT CLEAN, AND THE FAILURES ARE ATTRIBUTED

⛔ **Reported as run-with-failures rather than "clean", because three of the five steps do not mean what the step name says in this repo.**

| Step | Result |
|---|---|
| 1 `pnpm install` | ⚠ **returned the literal `ok`** — the known instrument anomaly ⇒ **UNVERIFIED, not passed** |
| 2 `pnpm lint` | ⛔ **INTERMITTENT — see below** |
| 3 `pnpm format:check` | ⛔ **ABSENT** — `Command "format:check" not found`; the script exists in no package. **Not a pass** |
| 4 `pnpm typecheck` | ✅ **20 successful, 20 total** |
| 5 `pnpm test` | ⛔ **19/20 — `@sow/worker#test` fails, ATTRIBUTED BELOW, not mine** |

**`@sow/policy`, the scope I can speak for: `tsc --noEmit` exit 0 · 522 passed (522).**

### The worker red — attributed at source, not by proximity

Failing test: `createLogger — the redaction chokepoint > scrubs a credential in a field VALUE before it reaches the sink`.
- `apps/worker/src/observability/logger.ts` imports `redactRecord, redactError` from **`@sow/domain`** — **not** from `@sow/policy`.
- **contract-implementer's UNCOMMITTED WIP touches `CREDENTIAL_TOKEN`** (2 hits in `git diff` of `redaction-rules.ts`) — **the exact scrub pattern that assertion depends on.**
- `packages/policy` has **zero** working-tree changes; my two commits are test-only and comment-only.
⇒ **Traces to contract's live domain scrub arc.** ⚠ **One grep during attribution returned `1` where I expected `0` for my own symbols — it was a stderr line carrying a PASSING test's NAME, not the failure. Recorded because the honest move on a non-zero was to open it rather than round it down.**

### ⛔⛔ THE LINT ITEM IS INTERMITTENT — MEASURED BOTH STATES IN ONE SESSION, MINUTES APART

**Carry-forward item 6 `(0)` has carried three mutually-contradictory observations. All three are consistent, and it is the NARROWING that was wrong.**

Observed here, same command, same tree, same session:
1. `pnpm lint` → **`Command "eslint" not found`**, preceded by `ESLint output (JSON parse failed: expected value at line 1 column 1)`.
2. Minutes later, `pnpm lint` → **11 successful, 11 total**.
3. Six consecutive runs: **1 failure (exit 2, `10 successful, 11 total`), 5 passes.**

⇒ ⭐⭐ **THE ITEM'S ORIGINAL WORDING — *"intermittently exits 1"* — WAS RIGHT. The `### 24.93` narrowing to *"reproduces DETERMINISTICALLY … do not re-file this as flaky"* IS FALSIFIED BY MEASUREMENT, and session `181`'s non-reproduction was a correct sample of the passing state.** ***Nobody was wrong; the narrowing was — each session sampled an intermittent process once and reported it as its nature.***

**Manifest facts, positive-controlled** (all 11 `lint` scripts listed, so the zero is checkable): **11 packages declare `lint`; ALL are `tsc --noEmit`; ZERO invoke `eslint`.** Root `lint` is `turbo run lint`.
⇒ ⛔ **`Command "eslint" not found` CANNOT originate in the manifests.**

⛔⛔ **TWO PHENOMENA, DELIBERATELY NOT MERGED (`L202` — the bar for adding to a hypothesis must RISE as it strengthens):**
- **(a)** intermittent single-task failures in `pnpm lint`. ⚠ **`lint` IS `tsc --noEmit`, and two sessions were writing files throughout** — a plausible race I did **not** establish, because I did not capture which task failed.
- **(b)** the `eslint`/JSON-parse message, which **no manifest can produce**. **Unexplained. I am not proposing a mechanism.**
⚠ **`pnpm run lint` also returned `11 cached … 18ms >>> FULL TURBO` — instrument #6; that run executed nothing.**
