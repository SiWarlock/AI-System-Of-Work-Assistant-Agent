# Session 187 — two guards, and the absence I measured wrong

**Date:** 2026-08-18 · **Phase:** 24 (hardening tail) · **Area:** `packages/knowledge` (`knowledge-implementer`, single-track `main`)
**Predecessor:** `179-2026-08-18-the-cut-that-could-not-fire-and-three-pins-that-could-not-fail.md`
**Successor:** _(none yet)_
**Tasks:** `### 24.113` · `### 24.136` · **Briefs:** `docs/briefs/302-24.113-region-table-drift-detector.md` · `docs/briefs/305-24.136-structuralpathonly-guards-its-own-regions.md`
**Commits:** `106968f4` (24.113) · `0e2b7ec3` (24.136)
**Session-doc number `187` was ASSIGNED by the orchestrator** from committed history, not computed here.

---

## Why this session existed

`### 24.103` installed a cut that keeps a row-authored key out of an audit signal. It is driven by `FREE_FORM_KEY_REGIONS`, a **hand-maintained** table, and **nothing re-derived it** (`### 24.113`). Both reviewers had verified the table correct at HEAD — which is exactly what makes tomorrow's drift invisible: the cut runs, matches nothing, cuts nothing, suite stays green.

`### 24.136` is the residual `### 24.113` created: certifying every *derived* name says nothing about a name added **by hand**, and region names are interpolated into a live regex.

---

## What was built

### `### 24.113` — derive the table instead of trusting it (`106968f4`)

**Created:** `packages/knowledge/test/audit/region-table-derivation.test.ts` — derives free-form-key regions from the live candidate schemas on **both** validator surfaces and asserts the table **equals** the derivation, per schema id. 9 pins.

Both surfaces reproduce the table exactly: `["frontmatter","payload"]` · `["proposedContent"]` · `[]` · `["sanitizedPayload"]`. No disagreement at HEAD, so the brief's stop-and-route condition never fired.

### `### 24.136` — guard the names nobody derived, and fence the seam (`0e2b7ec3`)

**Modified:** `packages/knowledge/src/audit/validation-refusal.ts` — `SAFE_REGION_NAME` (exported), `compileRegionPatterns` (pure, partitions into `patterns`/`poisoned`/`known`), `cutWithCompiled`; `structuralPathOnly` delegates.
**Modified:** `packages/knowledge/package.json` — `"./audit/validation-refusal": null` in the exports map.
**Created:** `packages/knowledge/test/audit/region-name-guard.test.ts` — 10 pins.
**Modified:** `packages/knowledge/test/audit/region-table-derivation.test.ts` — asserts against the exported `SAFE_REGION_NAME` instance rather than a second copy of the literal.

---

## Decisions made

1. **Both validator surfaces BIND; neither merely corroborates.** `runGate` refuses at stage (a) with ajv errors and at stage (b) with Zod issues, and the cut handles both path dialects deliberately ⇒ a region visible on only one surface leaves real production paths **uncut**. The brief framed Zod as corroboration, which would have made it droppable if brittle.
2. **EQUALITY, not containment.** Derived∖table is an uncut region (rule-7 leak); table∖derived is an over-cut that silently truncates every path beneath it. A subset assertion catches one and licenses the other.
3. **Throw on any shape the walk cannot prove it understands**, rather than resolving one no fixture exercises. `emitJsonSchema` pins `$refStrategy:"none"`, so reference keywords are structurally impossible and a resolver would be untested code on a rule-7 guard, failing toward under-reporting.
4. **`### 24.136`: loud at TEST time, contained at RUNTIME.** A guard that throws at construction only replaces `SyntaxError` with `Error` at module init — the same rule-1 hazard in nicer clothes. Partition instead; the loudness lives in `no_live_schema_id_is_poisoned`.
5. **The poisoned check precedes the `pattern === undefined` branch.** That branch returns the path unchanged and is correct as the identity cut for a region-less schema — so a poisoned id falling into it is returned **verbatim**.
6. **The seam is FENCED, not documented.** See "The ruling that reversed a premise" below.
7. **`SAFE_REGION_NAME` is exported and shared**, so divergence between the two guards is unrepresentable rather than forbidden by a paragraph.

## Decisions explicitly NOT made

- **No `$ref`/`$defs` resolver** — brief bullet deliberately not implemented; the guard throws instead. Orchestrator accepted and corrected the brief's premise.
- **`Object.freeze` on `FREE_FORM_KEY_REGIONS`** — it is `Readonly<>` at compile time only, so `no_live_schema_id_is_poisoned` recompiles a *different object* than the runtime uses. Flagged, not fixed.
- **Per-ref length bound** — `### 24.114`, the next slice.
- **The tagged-union `RegionCut` refactor** and the `makeRegionCutter` factory (code review's findings 5/6) — routed to the orchestrator, superseded by the fence.

---

## ⛔ The findings — including three against myself

### 1. I proved my own APPROVED pin could not fail
After the orchestrator's `APPROVED.`, I applied the exact under-report bug I had just fixed — a global memo instead of a path-local cycle guard — and **all 8 tests passed**. Pin 5 walked each root in its own call, so per-call memoisation never fired. Added the intra-root leg (one instance under two property names); it reds. **Session `179`'s "three pins that could not fail", reproduced inside the remedy for it.**

### 2. A rule-7 fail-open the derivation could not see (`### 24.136`'s reason)
`security-reviewer` found that membership was certified and **regex-safety was not**. Verified against the real construction: `["@ext"]` leaves `a.@ext.ROW_KEY` **verbatim**; `["ext$"]` likewise; `["a|b"]` mis-cuts; `["pay(load"]` throws `SyntaxError` at **module init**, on `applyPlan`'s import path.

### 3. ⛔⛔ MY REMEDY FOR A REVIEWER'S FINDING NEARLY SHIPPED A WORSE DEFECT
Review measured that `regions` as a bare string throws `TypeError`. My fix — `[...regions].map(String)` — **spreads a string into CHARACTERS**: `"frontmatter"` would have compiled to `(?:f|r|o|n|t|m|a|t|t|e|r)`, cutting at the first occurrence of any of those letters, silently, in every path. ⇒ ***a loud throw converted into a silent catastrophic mis-cut, while fixing the throw.*** `Array.isArray` prevents it; `an_off_type_region_row_is_REFUSED_not_thrown` pins it. **A correction arrives with a reviewer's endorsement attached and reads as pre-vetted.**

### 4. ⛔⛔ I REPORTED A DANGLING-CITATION DEFECT THAT DID NOT EXIST — A FALSE NEGATIVE FROM MY OWN INSTRUMENT
I reported `L237`/`L239`/`L242` as existing in no ledger, citing "`packages/contracts/LESSONS.md` tops out at `## 203`". **They all exist.** That file uses **two** heading formats — **133 plain** `## N.` and **116 anchored** `## <a id="N"></a>N.` — and my pattern could see only the first. *"Tops out at 203"* is precisely what that instrument returns on a healthy file.
⇒ ⭐⭐ ***A MAX OVER A PATTERN IS AN ABSENCE CLAIM WEARING A NUMBER.*** My positive control proved the instrument **ran**; it never proved the instrument could see every **format** the data is written in — applicability vs non-vacuity (`contracts L178`), arriving through a heading-format split rather than a truncation.
⚠ **`code-quality-reviewer` independently made the identical measurement with the identical instrument and reached the identical wrong conclusion.** Two parties, same method, same false negative ⇒ `contracts L141`'s shape: **the METHOD under-specified**, and no amount of care would have caught it.
⭐ Remedy applied, not noted: every citation in both files is now checked against **both** formats with a discriminating control (`L999` absent) — `contracts L66/L73/L103/L187/L192/L237/L239` all resolve — and every bare `LNN` is ledger-qualified, because a bare one resolves to `packages/knowledge/LESSONS.md`, which stops at §3. Three of mine pointed at the wrong ledger.

### 5. The two reviewers contradicted each other; I settled it by measurement
`code-quality` said my inherited-key pin was a strict weaker subset of an existing pin and should be deleted; `security` measured that same pin as load-bearing. **They compared against different pins and both were right about what they measured.** I ran the discriminating mutant — reintroduced the prototype bypass — and the sibling pin **reds**, with the row key visible. Deletion safe.

### 6. Instruments
- ⚠ **`diff` correction, filed against myself:** I reported it claiming "Files are identical" for differing files. **That did not reproduce.** What does: `diff` here wraps `command diff --color` and in one measured mode **exited 0 on genuinely different files** (ground truth by `shasum`). The rule that survives: **branch on exit codes; never use `diff` to establish sameness.** Contract measured the opposite result the same evening; both readings are recorded, neither reconciled.
- **`grep` is `ugrep`** via a shell function in this session (`ARGV0=ugrep …`) — phantom `NNN:0:` lines, fabricated match-count headers, POSIX-ERE rejections. ⛔ **Instrument identity is SESSION-SCOPED (`contracts L244`); this is not a machine fact.**
- ⛔ **A batch replacement reporting ONE aggregate result cannot say WHICH member failed.** A 4-replacement script printed one boolean; the most security-relevant of the four silently no-opped and the run looked clean. Every replacement now carries `assert old in s` + an ambiguity check.
- ⚠ **Wrong-cwd false negatives, four times.** A `cd` inside one command persists into the next; pathspec greps and python edits returned clean-looking no-ops. Caught by positive controls and anchor asserts, never by noticing.
- ⚠ **I emitted a literal U+2028 into a shell command twice**, in the slice about that character class, with the brief's warning in front of me. The tool's rejection was the only thing that caught it. **`String.fromCodePoint(0x2028)` is the working form.**

---

## ⭐ The ruling that reversed a premise — the fence

`### 24.136`'s tracker entry recorded that it ships a stated exposure *"because a fence is not available to it."* **False, and I measured all three legs:** `package.json` already carries exact-subpath `null` keys beside the `"./*"` wildcard (the repo's own remedy, derived for `### 24.65`) · **zero** external importers of `@sow/knowledge/audit/*`, positive-controlled against 21 real deep-import occurrences in `packages/evals` · all five internal consumers import **relatively**, which never consults the exports map.

The orchestrator reversed its own recorded rationale rather than defend it. **Verified blocking, not merely present:** `@sow/knowledge/audit/validation-refusal` → `ERR_PACKAGE_PATH_NOT_EXPORTED`, while `@sow/knowledge/knowledge-writer/writer` still resolves to its real file.

⭐ **The retired scanner is worth a line: it went RED on a real hit before I excluded this test file — it proved detection on its own subject and was then retired for a fence.** *A scanner deleted because a fence replaced it is a different fact from one deleted because it never fired.*
⚠ **`### 24.78` closing makes the fence REDUNDANT, not WRONG** (`contracts L248`) — recorded at both sites so nobody reads that tick as permission to delete the line.

---

## TDD compliance

**`### 24.113` — RED-first unavailable by construction, declared and approved in advance.** The detector *is* the deliverable, so no structural RED exists. The behavioural RED is the mutation, run **before** any green was accepted. Approved by the orchestrator at Step 2.5 as a stated deviation.

**`### 24.136` — structural RED confirmed first** (6 of 8 failing on the missing function; 2 green by design as regression pins).

⚠ **THREE TDD VIOLATIONS, all in the review-fix phase of `### 24.136`, all disclosed:**
1. **`Array.isArray` off-type guard implemented before its pin existed** — added while applying a security finding, pin added after.
2. **The TOCTOU single-read fix** — same shape.
3. **The `package.json` fence** — added on the orchestrator's ruling, pinned after.

⭐ **Compensating control applied to all three: each was mutation-proven afterwards** (MO3 removes the guard → its pin reds; MO4 restores the double-read → the TOCTOU pin reds with the injected alternation; MO5 deletes the manifest line → the fence pin reds), **and every mutation was proven applied and restored by `shasum`/`--numstat`, never by `diff`.**

**Total: 14 mutations across both slices**, each proven applied, each restored and sha-verified.

---

## Reachability

| symbol | reachable from | status |
|---|---|---|
| `FREE_FORM_KEY_REGIONS` → `structuralPathOnly` → `buildRefusalSignal` | 5 call sites in 5 files (`writer.ts`, `router.ts`, `generative-proposal-intake.ts` ×2, `provenance-stamp.ts`, `visibility-gate.ts`) | ⭐ **LIVE** |
| `applyPlan` (the sole writer) | `apps/worker/src/composition/buildActivities.ts:613`, `:1104` | ⭐ **LIVE — rule 1** |
| `compileRegionPatterns` / `cutWithCompiled` | this module only; **fenced** from deep import | intentional |
| both new test files | the suite; proven able to fail by 14 mutations | ⭐ |

⚠ **The brief said "four channels"; measured it is four candidate-data channels PLUS the GCL gate** — five call sites. `### 24.115` still stands: `routeRemediation` has no production caller.

---

## ⛔ `/preflight` — FAILED AT STEP 2, ATTRIBUTED, AND IT RESOLVES A TWO-SESSION CONTRADICTION

**`pnpm lint` FAILS.** Not mine, and the discriminating test the tracker asked for has now been run.

```
pnpm lint                    -> ESLint output (JSON parse failed: expected value at line 1 column 1)
                                [ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "eslint" not found
pnpm -w turbo lint --force   -> 11 successful, 11 total · Cached: 0 cached, 11 total
```

⭐⭐ **THE SAME GRAPH PASSES ONE WAY AND FAILS THE OTHER, AND THE ROOT SCRIPT IS LITERALLY `turbo run lint`** — so the difference is the INVOCATION PATH, not the work. Measured alongside it: **zero** manifests in this repo invoke `eslint` (all 12 `lint` scripts are `tsc --noEmit` variants), so ***nothing at HEAD can produce `Command "eslint" not found`***.

⇒ **This reconciles the contradiction Carry-forward 6 `(0)` records rather than picking a side:** providers-integrations measured `11/11 successful` at `### 24.110` via `turbo lint --force` and could not reproduce the red; earlier sessions measured the red via `pnpm lint`. **Both are correct — they invoked different paths.**

⛔ **AND THE IDENTIFICATION IS POSITIVE, NOT FIT-BASED** (which the tracker explicitly forbids, `contracts L202`): the error text names **ESLint**, **JSON parsing**, and **pnpm recursive exec** — three things the root script (`turbo run lint`) does not do and no manifest requests. That is a wrapper intercepting `pnpm lint` and parsing its output as ESLint JSON, in the family of `### 24.122`.
⚠ **Bound, stated: I have not isolated the wrapper itself, and an alternative I cannot fully exclude is a pnpm-side recursive fallback. What IS established is that the failure does not originate in any manifest and that the turbo path is clean.**

**Remaining gate steps, measured independently minutes earlier with their commands:**
- **typecheck** — `pnpm -w turbo typecheck --force --continue` → **20/20 successful, `Cached: 0 cached, 20 total`**
- **test** — `packages/knowledge` → **816 passed / 1 skipped**; monorepo → 1 failure, `@sow/worker` `logger.test.ts`, attributed below.

**Session doc status: `incomplete: preflight failures` — Step 2 only, pre-existing and environmental, zero relation to this slice's diff.**

---

## Open follow-ups

1. **Convention candidate** — *a correction is a defect vector with a reviewer's endorsement attached* (finding 3).
2. **Convention candidate** — *a max over a pattern is an absence claim wearing a number; a positive control proves the instrument RAN, not that it can see every FORMAT* (finding 4). Two parties hit it independently.
3. **Convention candidate** — *when two reviewers disagree, the comparator is usually the difference — measure the discriminating mutant instead of picking.*
4. **Convention candidate** — *a pin NAMED for a hazard is not a pin that can DETECT it.* The enforceable test: **which mutation reds ONLY this pin?** Three instances this round.
5. **Future TODO (next-brief)** — `### 24.114`, per-ref length bound. The `?? path` fallback returns a full path when no region matches, and `MAX_ISSUE_PATH_REFS` bounds ref *count*, not *length*.
6. **Future TODO** — `FREE_FORM_KEY_REGIONS` is `Readonly<>` at compile time only; the poisoned canary recompiles a different object than the runtime uses. `Object.freeze` aligns them.
7. **Cross-doc invariant change: NONE.** Both commits touched only `packages/knowledge/{src/audit,test/audit,package.json}` — zero contracts model files, so no Appendix-A model field changed. ⚠ `packages/knowledge/package.json`'s **exports map** changed — a package-surface change, not a cross-doc model.
8. **Pre-existing, not fixed** — the `docs/sessions/114` duplicate still stands (`### 24.107`).
9. **Whose red is whose** — the one monorepo failure is `@sow/worker`'s `test/observability/logger.test.ts` redaction assertion, attributable to `packages/domain/src/redaction/redaction-rules.ts` carrying **+82 uncommitted lines** from contract-implementer. My diff touches no worker or domain file. **Not mine, not silenced.**

---

## ⛔ A CROSSING, RECORDED NOT REWRITTEN — `0e2b7ec3`'s MESSAGE IS ONE REVISION BEHIND ITS OWN CODE

**The orchestrator's revised commit message for `### 24.136` arrived AFTER the commit had landed.** Message ordering is not guaranteed — Carry-forward 6 `(a4)`, live, in this session's final exchange.

**Verified, so the record is exact rather than remembered:**
- ✅ **THE CODE IS COMPLETE.** `0e2b7ec3` carries the manifest fence (`"./audit/validation-refusal": null`) and the fence-integrity pin (`the_audit_module_is_FENCED_from_deep_import_by_the_exports_map`), across all four files. **Nothing is missing from the tree.**
- ⚠ **THE MESSAGE IS THE EARLIER WORDING.** It carries *"The seam the pins require is FENCED rather than documented"* but not three later additions: the **verified-blocking** evidence (`ERR_PACKAGE_PATH_NOT_EXPORTED` through Node's real resolver, plus the positive control proving the wildcard still resolves), the **"the fence itself is pinned"** paragraph, and the **citation-qualification** paragraph.

⛔ **DISPOSITION: RECORD IT, DO NOT REWRITE IT.** `--amend` is forbidden in this checkout and destroyed a seal on a prior round. **This is the same ruling the round already made for a misattributed commit: a divergence is a fact about the record; a rewritten history is a new defect.** The three missing paragraphs are preserved here and in the orchestrator's round close-out, so nothing is lost — only relocated.

⭐ **AND THIS IS WHY THE ROUND'S OWN REMEDY IS THE FILE, NOT THE MESSAGE.** Handoff `029` opens on exactly this: *a `SendMessage` may carry a pointer; it may not carry the only copy.* The revised wording existed solely inside a message that arrived one turn too late — so it is written down here, where it cannot cross.

⚠ **What would have prevented it: nothing either party did wrong.** The orchestrator ruled, I shipped on the ruling I had, and the better wording was in flight. **That is the structural case for `(a4)`, not an argument for more care** — care was present on both sides, as it was both times in `029`'s opening.

---

## How to use what was built

**Adding a fifth candidate schema:** add it to `CandidateSchemaId` and `FREE_FORM_KEY_REGIONS`, then run the suite. The derivation test reds if your regions disagree with the live schemas on either surface; the name guard reds if any region is not `[A-Za-z0-9_]+`; `no_live_schema_id_is_poisoned` reds if the table compiled to a refusal.

⛔ **Four edits that silently destroy this, each of which looks like an improvement:**
1. **Moving the poisoned check below the `pattern === undefined` branch** — every poisoned id then returns the row-authored path verbatim.
2. **Re-reading `regions` at join time** ("removing a pointless allocation") — restores the TOCTOU double-read.
3. **Adding a wrapper entry to `ZOD_WRAPPERS` without verifying its `_def` key** — a wrong key passes `undefined` down and drops the subtree **silently**, converting fail-loud into fail-quiet.
4. **Deleting `"./audit/validation-refusal": null`** from the exports map — re-opens the hand-built-`CompiledRegions` path. Redundant only once `### 24.78` closes, and redundant is not wrong.
