# Session 181 — the flag that drifted, and the ADD I refuted

**Date:** 2026-08-18
**Track:** main (single-track, root checkout — no worktree)
**Area:** providers-integrations (`packages/policy`, `packages/providers`, `packages/integrations`)
**Phase:** 24
**Predecessor:** `docs/sessions/178-2026-08-18-the-expiry-that-fired-and-the-ground-that-was-false.md`
**Successor:** —
**Landed:** `f621bd06` (`### 24.110`, scope (C))
**Session doc number ASSIGNED by main-orchestrator from committed history — not computed here** (029's deterministic close-out race; every implementer-side remedy re-runs it).

---

## ⛔ STATUS: BLOCKED, NOT DONE — read this before inferring anything from "providers stood down"

**This area is not finished. It stood down because the HEAD of its queue is blocked, not because the queue is empty.**

**Ten open tracked entries remain in providers-integrations territory:** `### 24.63`, `### 24.65`, `### 24.68`, `### 24.70`, `### 24.81`, `### 24.82`, `### 24.95`, `### 24.110`'s remaining half, `### 24.118`, and `### 24.50`'s providers leg.

⛔ **`### 24.110` IS NOT DISCHARGED BY `f621bd06`.** What landed is the `/i` half. **The delegation half — `packages/policy` consuming `@sow/domain`'s classifier instead of keeping its own copy — is BLOCKED on `### 24.120`**, which is a question nobody has answered yet: whether `stripMarkers` should substitute something other than a space. `contract` is being staffed for exactly that.

⚠ **Why this section exists, in my own words:** *a stand-down and an exhaustion look identical in a session log a week later, and only one of them is true here.* A future reader scanning for "which areas are done" will find this doc, and the honest answer is that providers stopped because its next move depends on someone else's unanswered question — not because there was nothing left to do. **If this distinction is ever dropped, the ten entries above become invisible work, and invisible work is indistinguishable from finished work.** That is the exact drift this round spent the evening killing, and it would be a poor joke to reintroduce it in the close-out doc.

---

## Why this session existed

`### 24.110`: `packages/policy/src/audit-signal.ts` defined its **own local** `looksUnsafe` over its **own local** copies of three redaction patterns, and its `CREDENTIAL_PREFIX` was missing the `/i` flag that `@sow/domain`'s otherwise **character-identical** copy carries.

⛔ **The reach is what made it urgent, and it is worse than the title suggests.** `isRedactionSafe` is not only an audit gate — `packages/knowledge/src/knowledge-writer/secret-scan.ts` implements `contentContainsSecret(value)` as `!isRedactionSafe(probe)` with the **whole rendered file** as the probe's single ref, and `writer.ts` step 6 runs it as the KnowledgeWriter's **blocking pre-commit secret scan**, immediately before the atomic commit. ⇒ **the weaker of the two heuristics was guarding the canonical Markdown.** Safety rule 7, and rule 1 by reach.

⭐ **Why it survived:** the divergence is **one flag on one pattern**, and the sibling `SENSITIVE_KEYWORD` in the same file carries `/i` in **both** copies. **Two of three patterns match on a side-by-side read, so the reader confirms and stops.**

## What was built

**Files modified (2 — nothing outside `packages/policy` was touched):**
- `packages/policy/src/audit-signal.ts` (+29/−1) — added `/i` to `CREDENTIAL_PREFIX`; 28 lines of comment recording why the copy still exists, what the fix costs, and what must not be "tidied".
- `packages/policy/test/audit-signal.test.ts` (+179/−0, **zero deletions** — no pre-existing assertion weakened or removed) — 7 new tests, 15/15 in file.

**The tests, and what each is for:**
| Test | Pins |
|---|---|
| `an_uppercase_credential_shape_is_refused` | the defect itself; each case also asserts its lowercased form so the pin passes on SHAPE, not casing |
| `lowercase_credential_shapes_still_refused` | no-regression; green on arrival, stated as such |
| `a_keyword_only_value_is_still_refused` | the keyword net stays distinguishable from the prefix net; strike-the-keyword control proves which one fired |
| `a_benign_uppercase_value_is_still_safe` | non-vacuity, **with near-miss fixtures** one character from each alternative |
| `policy_and_domain_agree_on_the_credential_shape_axis` | the drift itself — catches a re-forked COMPOSITION, not just a re-copied constant |
| `known_false_positives_are_pinned_so_the_class_is_not_INVISIBLE` | the availability cost, stated in the suite rather than rediscovered |
| `the_url_userinfo_axis_still_diverges_and_that_divergence_is_OWNED` | the FILED divergence blocking delegation (`### 24.120`) |

## Decisions made

1. **Scope (C) — ship the `/i` alone; defer the delegation.** Not (A) *(import the patterns, keep a local composition)* and not (B) *(delegate wholesale)*. Rationale below; the ruling is the orchestrator's, the measurement that forced it is this session's.
2. **Do not delegate to `@sow/domain`'s `looksUnsafe`.** It applies `stripMarkers` first, which substitutes a **SPACE**, and every `URL_USERINFO_CREDENTIAL` character class excludes whitespace ⇒ a frozen marker inside a `//user:pass@host` span **breaks the span** and the value stops being refused. Delegating would newly expose that on the sole-writer path.
3. **Ship the `/i` despite a measured availability cost.** `sk-[a-z0-9]` has no word boundary, so `/i` also newly refuses benign prose (`TASK-1`, `RISK-001`, `Full-Disk-Access`). Shipped because the widening is **monotone** — no value refused before is admitted now — and because it is parity with domain, which carries the identical unbounded alternative. **The word boundary is a domain-parity question, not an in-slice patch.**
4. **Pin the cost rather than absorb it.** A known false-positive class with no test is a class that gets rediscovered as a surprise.
5. **Correct, never delete, the false-assurance docblock** in `secret-scan.ts` — flagged with replacement wording, not edited (knowledge territory).

## Decisions explicitly NOT made

- **The `\b` word boundary on `sk-[a-z0-9]`** — deliberately NOT added. It changes domain parity, which is the thing `### 24.110` exists to restore. Routed as a Finding instead.
- **The `stripMarkers` fix** — NOT attempted here. It is `packages/domain` territory and a genuine design question: the obvious patch ("also test the unstripped string") **introduces false positives**, because the marker literal supplies its own `:` and can *complete* a userinfo match. Filed as `### 24.120`.
- **Consolidating the other pattern copies** — five copies across four packages exist. Two are in my territory and were deliberately left alone; see `### 24.118`.
- **The historical-exposure scan** — owner-gated, scoped on the tracker, not run and not to be run without authorization.

## TDD compliance

**Clean on the production change, with one nuance stated rather than glossed.**

- The `/i` change had its failing test **first**: 5 tests written → Step 2.5 review → RED confirmed (2 failures, both on `SK-ANT-API03-ABCDEF`, for the *right* reason — case-sensitivity, not a fixture typo) → implementation → GREEN.
- ⚠ **Nuance: two tests were added AFTER the green** (`known_false_positives_…` and the near-miss fixtures), both from reviewer findings. **They pin behaviour that already existed and drove no production change** — the only post-green source edits were comments. **I am recording this rather than claiming an unqualified "tests first"**, because "the tests all landed before the implementation" would be false as stated.
- **Mutation-proven twice, each proven APPLIED by diff before its red was trusted:** stripping `/i` reds 3 pins; widening `sk-[a-z0-9]`→`sk` **fires the non-vacuity control** — which is the evidence that the control is sensitive to a one-character widening, and it demonstrably was **not** before the reviewer finding.
- Restored byte-identical after each mutation, **verified by sha256** rather than by `diff` alone.

## Cross-doc invariants

**No impact.** No model field was added, removed, or renamed — the change is a regex flag, comments, and tests. `AuditSignal` is policy-internal and absent from the cross-doc table; `AuditRecord` is unchanged. **No `ARCHITECTURE.md` pairing is owed.**

## Reachability

**Established and re-confirmed at HEAD this session, not restated from the brief:**

`isRedactionSafe` (`packages/policy/src/audit-signal.ts`) ← `secret-scan.ts:20,54,63` (`contentContainsSecret` = `!isRedactionSafe`, `refs: [whole rendered file]`) ← `scanForSecrets:73` ← `writer.ts:385` (`deps.secretScan ?? scanForSecrets`) ← **three production composition sites leaving `secretScan` UNSET so the real scanner binds**: `buildActivities.ts:582`, `:1094`, `semanticApprovalDispatch.ts:68`.

**No tested-but-unwired code in this slice** — the change is to an already-reachable predicate.

## Open follow-ups

**Filed by the orchestrator from this session's findings (I did not file these and did not bake task numbers into source):**
- **`### 24.120`** — `stripMarkers` can DESTROY a `URL_USERINFO_CREDENTIAL` match. **Blocks `### 24.110`'s delegation half.** Already inherited by `packages/providers`' redactor and by domain's own `redact.ts`.
- **`### 24.123`** — `secret-scan.ts`'s whole-file predicate rejects ~40% of realistic Markdown. **Re-measured post-fix by the orchestrator on one denominator: 652 files, pre-fix 254 (39.0%), post-fix 263 (40.3%), 9 newly refused** — my 9 independently reproduced by a different method. ⛔ **`>40 KB` is `14/14` — every large document is rejected.** Root cause recorded as *one predicate reused across two scan GRANULARITIES*.
- **`### 24.117`** — `packages/contracts/src/config/config-schema.ts:85` is a second live `/i` gap with a different leading alternative.
- **`### 24.118`** — `packages/integrations` is **three detectors AHEAD** of domain (`AIza`, `GOOGLE_API_KEY`, `URL_CREDENTIAL_PARAM`). ⛔ **"Consolidate to domain for consistency" would DELETE three live detectors** — `### 24.112`'s trap shape, second instance. `Track:` corrected to two-sided: step 1 (promote `AIza` into domain) is contract work.
- **`### 24.121`** — `gcl-projection.test.ts:637` cites a policy→domain delegation that does not exist, **as the reason its assertion is trusted**. Carries my replacement docblock wording for `secret-scan.ts`.
- **`### 24.122`** — the git-wrapper task; carries my `diff` anomaly as a **non-admitted** candidate with the non-reproduction recorded.

**Still mine, unstarted:** `### 24.63`, `### 24.65`, `### 24.68`, `### 24.70`, `### 24.81`, `### 24.82`, `### 24.95`, `### 24.50`'s providers leg.

## Method notes worth carrying

⭐ **1 — An ADD is worth refuting, not just executing.** I was handed `strip_cannot_destroy_a_match`, with the orchestrator saying its own reasoning was *"probably not"* and that "probably not" is what this round keeps punishing. **I constructed the counter-example** (`//u:p[REDACTED:raw]q@h` — a marker carrying no keyword, so only the URL-userinfo net fired before the strip). It overturned a ruling the orchestrator had made and the lead had endorsed, and killed a wholesale delegation two people had already approved.

⛔ **2 — `diff` is on the unreliable list AND is the mandated mutation-verification instrument.** It reported *"Files are identical"* for a provably-different pair (the mutation was applied; the tests went red in the same breath). **Did not reproduce across three retries, piped and redirected — so it is NOT admitted to the git-wrapper hypothesis** (`L202`: a live hypothesis makes false positives cheap). ⭐ **The transferable half stands regardless: it failed toward a fabricated ABSENCE, which would have said my mutation never applied. What caught it was a second independent signal — the tests flipped.** ⇒ ***verify a mutation by its EFFECT as well as by its diff; the effect cannot fabricate an absence in the same direction.***

⭐ **3 — The pre-commit gate must be its OWN command.** Run separately (a decision between reading and acting, `L109`), it caught **`apps/worker/src/api/procedures/egressCommands.ts` and `systemHealth.ts` modified in the tree** — worker-implementer's live WIP. **A bare all-files staging command would have swept two worker files into a rule-7 policy commit.** Both verified still uncommitted after my commit. **029 records this defect as SURVIVED; here it was PREVENTED, and only because the check could still change the action.**

⚠ **4 — A quoted heredoc feeding Python makes a doubled backslash-n a LITERAL two-character escape.** It is consumed by neither layer and lands in the source; it broke the tree mid-session (`TS1127`), was caught by knowledge-implementer's preflight, and attributed to me **by measurement** (zero of their symbols in the error, policy green 20 minutes earlier) rather than by proximity. ⇒ **when writing files through a nested writer, verify the BYTES, not the exit code.**

⭐ **5 — Reviewer convergence is not a second defect.** `security-reviewer` independently re-derived a finding I had already fixed from `code-quality-reviewer`. **Reported as convergence, which keeps a defect count honest that would otherwise inflate.**

⚠ **6 — A counter-observation is not a correction.** I could not reproduce the repo-wide `eslint` red: `turbo lint --force` is **11/11, `0 cached`**, and **zero of 11 packages declare an `eslint` script**. Recorded as a counter-observation with its method — a different moment or surface is entirely possible, and overwriting the original claim on one negative would be the same error in the other direction.

⛔ **7 — THE GUARD CANNOT TELL A COMMAND FROM A DOCUMENT ABOUT THAT COMMAND.** Writing this very doc was BLOCKED by `scripts/guards/git-guard.sh` because method note 3 **quoted** the banned all-files staging form inside a heredoc. The guard string-matches the command text, so **a file that merely NAMES the forbidden pattern trips the guard that exists to prevent it.** ⇒ ***the lessons ledger structurally cannot quote the pattern it is teaching about***, and the workaround — paraphrasing — makes every such lesson vaguer than the defect it describes. **Note 3 above is deliberately paraphrased for this reason, and is weaker for it.** Filed as a DevEx flag, not fixed here.

## Gates

- `pnpm -w turbo test --force` → **20/20 successful, `0 cached, 20 total`** (no CANCELLED tasks inflating the total)
- `pnpm -w turbo typecheck --force` → **20/20, `0 cached`**
- ⚠ **"lint" in this repo IS `tsc --noEmit`** — not reported as separate coverage.
- ⚠ **`format:check` does not exist as a script in any package** — that preflight leg is **ABSENT, not passing.**

⛔ **CLOSE-OUT PREFLIGHT IS RED, AND IT IS NOT THIS SLICE'S RED — ATTRIBUTED BY MEASUREMENT, NOT BY PROXIMITY.**
`pnpm -w turbo test --force` → **20/20, `0 cached`**. `pnpm -w turbo typecheck --force` → **FAILS at `@sow/domain#typecheck`**:
`test/__scratch-24120b.test.ts(52,40): error TS2532: Object is possibly 'undefined'.`

**Why it is not mine, four ways:** the file is **UNTRACKED** — one of three live scratch probes (`__scratch-24120.test.ts`, `…b`, `…c`) in `packages/domain/test/`, named for `### 24.120`, which is **contract-implementer's in-flight task**, the very one this slice's deferral is blocked on · **zero of my symbols** appear in the error · `pnpm --filter @sow/policy typecheck` **passes standalone** · and `packages/policy` is **DOWNSTREAM** of `@sow/domain` (`{providers,integrations} → policy → {domain,contracts}`), so a policy change **structurally cannot** break domain's typecheck.

⭐ **Left ALONE deliberately — another session's live WIP is not mine to tidy, and deleting a mid-slice probe is the shared-tree defect this round has been hunting.** It should clear when contract finishes. **My slice landed green at `f621bd06`, before these appeared; the gates quoted above were measured at that state.**
