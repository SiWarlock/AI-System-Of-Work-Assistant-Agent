# Session 178 — the expiry that fired, and the ground that was false

> ⛔ **RENUMBERED `176` → `178` (2026-08-18), and the number was never mine to pick.** **THREE implementers independently computed `176`** — knowledge's `175` landed while all three were reading `docs/sessions/`, so `max+1` returned the same answer concurrently. ⛔ **It committed at `176` first**, because a broad `git add` in this shared checkout swept this file (and my `174` edit) into another agent's commit `5f6a36be`, whose message describes neither. **Nothing was lost — verified byte-identical, not assumed.** ⭐ **The convention's `max+1` is computed from a DIRECTORY READ and therefore assumes close-outs are SERIALIZED; parallel close-out on a single track collides BY CONSTRUCTION**, and the track-prefix rule that would prevent it applies only in multi-track mode. ⚠ **`### 24.93`'s own shape one level up: a rule whose correctness rests on an unstated assumption.** *(Final landing-order assignment: knowledge `175` · worker `176` · contract `177` · providers `178`.)*

**Date:** 2026-08-18 (work spans 2026-08-17 evening) · **Area:** providers-integrations (`packages/policy`)
**Phase:** 24 · **Task:** `### 24.93`
**Predecessor:** chronological — `177-2026-08-18-the-option-i-argued-against-and-what-building-it-measured.md` (contract) · this area's prior session — `174-2026-08-14-24-68-the-remedy-that-could-not-be-built.md` (providers-integrations). ⚠ **Both are given because the chain convention is UNSETTLED** (`161` says per-AREA, `162` used chronological) **and a link that carries its area is wrong on sight if mis-drawn.**
**Successor:** `docs/sessions/181-2026-08-18-the-flag-that-drifted-and-the-add-i-refuted.md`
**Commit:** `462d5ad9` · **Brief:** `docs/briefs/291-24.93-option-b-expiry-re-derivation.md` (`spec-lint brief PASS @c3c6d8f2`)

## Why this session existed

`packages/policy` was an UNQUEUED track. `### 24.93` was filed **ownerless** — contract-implementer found the
defect in providers territory while shipping their own slice and **flagged rather than fixed**; the orchestrator
recorded it as unowned rather than handing policy work to a staffed area (`L120`: a fact about staffing is not a
fact about correctness). The lead then spawned this session as the owner the finding was waiting for.

**The defect:** `visibility.ts` recorded that an Option-(B) remedy was rejected *"against the CURRENT schema
(`.min(1)` + non-blank), so that rejection expires when `24.84` lands."* ⛔ **The condition was real, correctly
authored, and had no mechanism to announce its own firing** — `L176`'s fires-and-looks-silent direction, and
`L187` from the other side (the decision WAS defended at the right site; an expiry needs a WATCHER, not a
location).

⭐ **It fired mid-session.** `### 24.84`'s contracts leg landed at `25ae6c49` while this slice was in flight, and
the orchestrator sent the announcement the task says does not exist — the defect being fixed procedurally in the
same hour it was fixed in the file.

## What was built

**Files created:** none.

**Files modified:**
- `packages/policy/src/visibility.ts` — the recorded-rejection note inside `denyDirectCrossWorkspaceRaw`
  re-derived against the landed schema. **Comment-only: 56 insertions / 4 deletions, 0 non-comment lines**
  (`git show <rev> --numstat`).

## Decisions made

1. **Option (B) is STILL REJECTED — but only as a remedy for THIS residual.** The scope is load-bearing and sits
   in the headline: the *same edit* at this sink IS wanted for a different reason (`### 24.95`, bounded-input
   hygiene). Without the scope, whoever triages `### 24.95` reads "shape remedy rejected here" and closes a rule-7
   fix on the strength of a rejection that was never about it.
2. **The recorded ground was HALF false, which is a different repair from re-dating it.** Measured: the old schema
   added **0/4** rejections over the `typeof`/non-empty guard already present (genuinely "cosmetic"); the landed
   shape adds **4/4** ⇒ *"cosmetic"* is FALSIFIED. But `sk-ant-api03-…`, `akiaiosfodnn7example`, a 32-char hex and
   `hunter2abcdef` all ACCEPT ⇒ *"provably admits the bad case"* SURVIVES.
3. **The replacement ground is deliberately NOT charset-specific.** Stating it as *"the new regex accepts
   `sk-ant-…`"* would tie the note to a literal still moving under an open category-4 escalation — **re-creating
   this exact defect one layer down.**
4. **The regex literal is NOT mirrored into `visibility.ts`.** A second hand-maintained copy of a predicate is
   `### 24.46`'s class (authoritative by designation, two independently-maintained lists). The shape is named by
   its owner (`### 24.84` / `25ae6c49`) and described only as far as the ground requires.
5. **The referent is versioned:** `25ae6c49` for the landed shape, `zod-brands.ts:30-35 @ 54b052a7` for the
   superseded factory. ⛔ **The class fix is the hash, not the instance** — a relative word is what let this expire.
6. **The `from`/`to` asymmetry is preserved byte-unchanged** (`from` needs an authenticated identity; `to` needs an
   entitlement check). A shape validates WELL-FORMEDNESS, never AUTHENTICITY or ENTITLEMENT — orthogonal to the
   shape question and not deleted along with the stale premise (`L153` half 1).

## ⛔ The correction that matters most — MY OWN APPROVED GROUND WAS FALSE

The §3 ground sent at Step 2.5, **which the orchestrator approved and praised**, was **false as worded**:
*"a well-formedness rule cannot exclude credential shapes."*

⛔ **The security review CONSTRUCTED the counter-example:** `^(employer-work|personal-business|personal-life)$`
**is** a well-formedness rule, admits all three ids `### 24.84` measured live, and excludes every credential.
**I had conflated a CHARSET with a LANGUAGE; a charset does not determine a language** (`L198`).

⭐ **What actually makes the claim true had to be found, and is now stated:** the workspace-id set is **OPEN BY
CONSTRUCTION** — `parseCreateWorkspace` (`apps/worker/src/api/procedures/onboarding.ts:112`) admits ANY non-empty
string as the id — so enumerating would reject a live id, the AVAILABILITY BREAK `### 24.84`'s own binding gate
forbids.

⛔⛔ **AND THE SECOND-ORDER POINT IS THE LESSON: that premise HAS AN OWNER.** `### 24.84`'s WORKER leg exists to
close exactly that create path. ⇒ ***my "this ground CANNOT EXPIRE" could itself have expired, silently, through
the sibling leg — a second unwatched expiry inside the fix for the first.*** The note now names the contingency
AND the task that owns it rather than claiming unconditionality — **the slice's own rule applied to the slice.**

⚠ **Two people approved the false version; only construction caught it.** `L141`'s amendment shape on a new
surface: when two careful readers pass the same claim, the claim was under-specified.

## Decisions explicitly NOT made

- **Option (B) was NOT implemented.** The brief did not authorise it and the re-derivation rejects it for this
  residual. The genuine narrowing benefit was **filed as `### 24.95`** rather than folded in — folding it would
  record a partial improvement as a closure, the false-assurance failure this slice exists to correct.
- **`denyDirectCrossWorkspaceRaw`'s reachability was NOT re-derived.** It was measured 2026-08-13 and lives in the
  paragraph *below* the edited one; this change does not rest on it, and inheriting a measurement silently is the
  trap. Stated rather than restated as fresh.
- **The `### 24.84` tracker contradiction was NOT fixed here** — tracker text is orchestrator territory. Routed as
  a Step-9 Finding instead.
- **The `git`-tooling anomaly was NOT chased.** Shared-tooling question, not this slice.

## TDD compliance

**Clean — no violation, and the substitute discipline was load-bearing rather than ceremonial.**
The brief declared the substitute path explicitly (*"the subject is a recorded decision, so there is no behaviour
to pin"*). **Zero tests added, deliberately:** the acceptance-pin for the shape's limitation is
`packages/contracts/test/primitives/zod-brands.test.ts:161`, and `### 24.95` owns pinning it at this sink — a
policy-side copy would be the second maintained copy of one rule, i.e. the defect decision 4 refuses.

⭐ **The substitute RED was executed and it caught a real defect**: the firing condition was established with
`file:line` on both sides, and the discriminating counter-example was **measured against the regex literal
extracted from source** (never retyped, never inherited from the docblock's claim). That measurement is what
falsified clause 1 and preserved clause 2 — and the adversarial pass on the resulting ground is what caught the
false universal. **No implementation preceded a measurement.**

## Reachability

**No new symbol; zero executable lines added** ⇒ nothing to wire, and a green suite cannot be hiding an
unreachable feature here. `denyDirectCrossWorkspaceRaw` itself is **not production-reachable** (measured
2026-08-13; `guardCrossWorkspaceRawRead` ← `authorizeCrossWorkspaceRawRead` ← nothing). ⛔ Per the standing rule,
**reachability governed DISPOSITION, never ROUTING** — the rule-4 flag routed to the lead regardless.

## Open follow-ups

1. ⛔ **FINDING (rule 4 + 7), routed to orchestrator + lead, CONFIRMED at `IMPLEMENTATION_PLAN.md:4043` and being
   fixed this round:** `### 24.84` asserts the charset makes *"every credential shape UNREPRESENTABLE rather than
   DETECTED."* **False at `25ae6c49`**, refuted by three of its own artifacts (docblock, pinned test,
   measurement). ⭐ **Why a Finding and not a typo: it fails in the REASSURING direction AND sits at the LIKELIER
   DESTINATION** — a reader following the bare `### 24.84` token from this note reaches the tracker before the
   docblock, in the document that OUTRANKS the comment. **A defect in the document that would have overridden this
   fix.**
2. ⚠ **Citation drift THIS slice caused** (surfaced rather than left): +60 lines move the `refs` interpolation
   from `:486` to ~`:521`, so `### 24.95`'s and `### 24.93`'s `Files:` lines now resolve to the wrong content
   (`L93`). **Orchestrator adopting the fix: drop line numbers for the SYMBOL NAME, which survives edits** — the
   de-inlined-literal rule applied to citations.
3. **Architecture §5 note** (orchestrator writes): a shape remedy guarantees WELL-FORMEDNESS only; the
   credential-shape residual survives it completely.
4. **`### 24.95`** — the bounded-input-hygiene narrowing at this sink, worded so it can never be recorded as
   closing `### 24.45`/`### 24.65`. Providers-integrations territory; unstarted.
5. **`L97`-shape residual:** *"Option (B)"* is defined in exactly ONE place
   (`docs/briefs/286-…:45`). The note now states it inline so it no longer depends on the label; whether other
   citations of the label need the same is open.
6. **Carry-forward `6(a0)(0)` narrowed with evidence:** root `pnpm lint` fails **DETERMINISTICALLY** here, not
   intermittently — `Command "eslint" not found` (ESLint invoked in a repo with ESLint in zero manifests).

## ⛔ Instrument findings (four; one is new and one corrects my own attribution)

1. ⛔⛔ **`git show <rev> -U0 -- <path>` EMITTED THE DIFF TWICE** — 2 `diff --git` headers, 2 `@@` hunks, for a
   one-file one-hunk commit ⇒ every derived count doubled (112/8 vs the true 56/4). ⭐ **Caught only because the
   ratio was exactly 2× and a prior measurement contradicted it.** `--numstat`, `git add`'s own report and the
   pre-commit `git diff -U0` all agree on 60. ⛔ **This matters beyond one slice: `git show`/`git diff` is the
   surface this team verifies COMMITS against, including the comment-only proofs that gated lead-authorized
   crossings.** Handoff `028` records this family as a shim that **OMITS** blocks; **this is the same family
   INFLATING** ⇒ *the shim is not biased in one direction.* **Rule: verify a line count with `--numstat`, never by
   counting `+`/`-` lines out of a diff body.** ⚠ Observable tell, offered as a lead not a conclusion: the output's
   first line carried commit subject + author + relative date, which is not plain `git show` output — something
   wraps `git` here. ⚠ The orchestrator could NOT reproduce it (four clean probes) ⇒ **intermittent, so a
   comment-only proof cannot be validated by a different agent in a different session** (`L201`).
2. ⭐ **AND IT WAS NOT `grep` — the correction to my own Step-9 note.** `awk` independently reproduced 112/8, so
   the corruption was in the byte stream and **grep counted a corrupted input faithfully.** ⇒ ***an instrument can
   report a wrong number CORRECTLY, and blaming the known-bad tool would have hidden the actual defect.*** I opened
   that investigation expecting grep and found something else.
3. **`grep` DID fabricate match-count headers 4× this session** (phantom `N matches in N files:` + mangled
   `NNN:0:` rows, twice on SINGLE-FILE queries). Every line number in the slice was re-read with `sed`/`awk`.
4. ⛔ **`turbo run test --force`'s TAIL OVER-REPORTS FAILURES IN A SHARED-WIP TREE.** The first full run listed
   `@sow/db:test` and **`@sow/integrations:build`** as `[ELIFECYCLE]` failures; **both pass in isolation, forced,
   0 cached** — turbo was CANCELLING in-flight tasks when `@sow/knowledge#test` failed. ⇒ **a cancellation artifact
   is textually indistinguishable from a real red, and one of them accused MY OWN territory.** *"Name whose WIP it
   is" is insufficient — the accused package must be re-run alone.*
5. ⭐ **A REVIEWER SUBAGENT REPORTED A CITATION AS "VERIFIED" AND WAS WRONG, while the two reviewers DISAGREED with
   each other about the same line.** security-reviewer reported option (B) verbatim at `286:44`; code-quality
   reported `:44` = option (A) and (B) = `:45`. **Direct `sed` read settles it: `:44`=(A), `:45`=(B), `:46`=(C)**,
   and brief 286 is unmodified so it is not line drift. ⇒ ***"I verified it" from a subagent is a CLAIM, not a
   MEASUREMENT.*** ⛔ **My original note carried the same wrong citation** — in a comment block that itself cites
   `### 24.66` for exactly this class.

## Verification

- **Full `turbo run test --force`: 20/20 tasks, `Cached: 0 cached, 20 total`.** The tree held only this delta at
  that point, so the green is claimable for this slice.
- ⚠ **`@sow/desktop` 62/62 means `### 24.25` PASSED. Per `L83`'s concurrent-WIP signature that is consistent with
  a clean tree and is NOT a fix — `### 24.25` is NOT claimed resolved** (`L136`: cite a known-failure signature,
  never skip it silently).
- **Comment-only proven mechanically, not asserted:** `--numstat` → `56 4`; non-comment changed lines → `0`,
  computed with `awk` after `grep` proved unreliable.
- **Cross-doc invariants: CLEAN** — zero model field adds/removes/renames this session (no code delta of any kind),
  so no `ARCHITECTURE.md` row is owed by this slice.

## `/preflight` — ⚠ GATE NOT CLEAN, and the failures are PRE-EXISTING + ENVIRONMENTAL, not this slice's

⛔ **Recorded as `incomplete: preflight failures` per `/session-end` Step 5, rather than reported as clean.**
This slice added **zero executable lines**, so none of the below can originate from it — but the gate did not
pass and that is stated plainly rather than explained away.

| step | result |
|---|---|
| 1 `pnpm install` | ✅ exit 0 |
| 2 `pnpm lint` | ⛔ **FAIL — `Command "eslint" not found`** (ESLint invoked in a repo with ESLint in zero manifests). **Carry-forward `6(a0)(0)`, and DETERMINISTIC here — not "intermittent" as that item records.** The gate stops here by spec. |
| 3 `pnpm format:check` | ⛔ **SCRIPT DOES NOT EXIST** — `Command "format:check" not found`. ⚠ **A NEW gap, and it is in `/preflight` ITSELF: the gate mandates a step this repo cannot run**, so every prior "preflight clean" either skipped it silently or never reached it (Step 2 fails first). |
| 4 `pnpm typecheck` | ✅ **20/20** — ⚠ **first run reported `Cached: 10 cached, 20 total`, which is NOT a measurement**; re-run `--force` ⇒ **20/20, `Cached: 0 cached`.** |
| 5 `pnpm test` | ✅ **20/20, `Cached: 0 cached, 20 total`** (forced). |

⭐ **Steps 4 and 5 were re-run FORCED because a cached green is not a green** — the standing rule for this round,
and the first typecheck run would have passed on 10 replayed results.
⚠ **Forbidden-pattern warn-grep:** `packages/providers/CLAUDE.md` carries no `forbidden-patterns` block ⇒ silent
skip per spec. The staged diff is Markdown only in any case.
