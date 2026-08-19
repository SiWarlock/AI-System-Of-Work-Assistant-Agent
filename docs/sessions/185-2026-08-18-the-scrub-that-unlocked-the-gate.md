# Session 185 — the scrub that unlocked the gate

**Date:** 2026-08-18 · **Role:** contract-implementer · **Track:** main (single-track, root checkout)
**Predecessor:** `docs/sessions/183-2026-08-18-the-hazard-was-in-the-predicate-not-the-scrubber.md`
**Brief:** `docs/briefs/300-24.118-domain-detector-promotion.md` · **Task:** `### 24.118` step 1
**Session number assigned by `main-orchestrator`** (sole assigner, derived from committed history — not computed here).

> ⛔ **WHY THIS FILE EXISTS BEFORE THE STEP-9 MESSAGE:** `029`'s structural finding. The measurement lives here; the message points at it.

---

## 1 — STATUS

⛔ **NOT COMMITTED AT TIME OF WRITING. A rule-7 finding produced by this slice's own second half is routed at Step 9 and the ship variant is not mine to pick.** Implementation is complete and green; what is in question is *which half ships*.

---

## 2 — WHAT WAS ASKED, AND WHAT THE BRIEF GOT WRONG

Brief `300` asked two gating questions and stated its own Q1 answer as **a hypothesis reasoned from source and explicitly not run**. Both are answered below; the Q1 premise is **refuted and replaced**, and the replacement matters because the brief's version left a repair standing that does not work.

---

## 3 — Q1: THE LOOKAHEAD. PREMISE REFUTED, CONCLUSION UPHELD

**The brief's mechanism:** `@sow/domain`'s `stripMarkers` turns `[REDACTED:credential]` into the filler, so integrations' `URL_CREDENTIAL_PARAM` negative lookahead `(?!\[REDACTED\])` stops suppressing and the net over-fires on already-scrubbed content.

**Measured — the lookahead was never engaged, stripping or not:**

| input | fires? |
|---|---|
| raw secret, unstripped | true |
| integrations' own marker `[REDACTED]`, unstripped | **false** (its lookahead works — for *its* vocabulary) |
| **our marker `[REDACTED:credential]`, UNSTRIPPED** | ⛔ **true** |
| our marker, stripped with `^` | true |
| our marker, stripped with a space | false |
| **two-arm disjunction as `looksUnsafe` evaluates it** | ⛔ **true** |

⇒ **TWO INDEPENDENT DEFEATERS, not one:**
1. **VOCABULARY.** `\[REDACTED\]` demands `]` immediately after `REDACTED`; ours has a colon. The lookahead never matched our marker in the first place.
2. **COMPOSITION.** `looksUnsafe` strips *before* any net runs, so no lookahead over marker text can suppress anything here **at all**.

⭐⭐ **WHY THE DISTINCTION IS LOAD-BEARING AND NOT PEDANTRY: the brief's mechanism leaves *"widen the lookahead to `(?!\[REDACTED)`"* standing as an obvious repair. Defeater 2 forecloses it and defeater 1 does not.** ⇒ ***a right conclusion carried by a wrong mechanism licenses a wrong fix, and it arrives with the authority of having been right.*** The orchestrator recorded this against themselves on `### 24.129`.

**The decisive datum, which neither party had — it is not over-refusal, it is `redactString` destroying its own output:**

| fixture | today | +GOOGLE | +BOTH |
|---|---|---|---|
| `...geocode?address=x&key=AIza...` | not scrubbed | ✅ scrubbed, host+path kept | ⛔ **whole field dropped** |
| `GET /v1?access_token=...` | not scrubbed | not scrubbed | ⛔ **whole field dropped** |

⇒ **HELD.** Filed by the orchestrator as `### 24.129`; cited in the in-file fence.

⚠ **Harness fidelity controlled:** the reference predicate reproduced shipped `looksUnsafe` on 5/5 probes and the reference scrubber reproduced shipped `redactString` on 5/5 fixtures. Without that the table would have been about my copy.

---

## 4 — Q2: THE GUARDS. NO PROPERTY RED; THREE REGISTRATION REDS

**BEFORE (measured before any edit): `marker-filler-property` 21 + `net-list-integrity` 5 = 26/26 green.**

`^` against the new net: **ZERO `P1'`/`P1''` violations.** ⭐ **Non-vacuous on this exact net — `-` and `_` each fire 20 violations on the `AIza` exemplars.** `### 24.120` predicted precisely this from a *simulated* future `AIza` pattern before one existed; it is now demonstrated on the live one.

**Three assertions red, all of one kind:** exemplar-completeness, and `CREDENTIAL_NETS.length === 3` in two tests.

⭐⭐ **THE ORCHESTRATOR'S RULING, WHICH IS THE REUSABLE PART — a guard file holds two kinds of assertion and the dispatch line collapsed them:**
- **PROPERTY** — *the world has a shape*. ⛔ Editing it to pass changes what is guaranteed. Never.
- **COMPLETENESS / REGISTRATION** — *every member of the set has been considered*. ⭐ It is BUILT to red when the set grows.

⇒ **The discriminator is checkable rather than a judgement call: *does the edit change what would be caught in FUTURE, or only acknowledge what has ALREADY been caught?***

### The proof that it was registration and not silencing

⛔ **Demanded by the orchestrator and it is the whole safety condition, not ceremony:** a hypothetical net #5 was injected into `CREDENTIAL_NETS`, and **both** assertions red on it — `net ZZTESTONLY[0-9]{4} has no exemplars` and `expected 5 to be 4` (twice). Reverted; **sha256 byte-identical**.
⇒ ***net #5 is caught exactly as net #4 was, so nothing was weakened.*** Without this, *"bumped 3 to 4 and added an exemplar"* is indistinguishable at the diff from *"silenced the alarm."*

**`L216` note written at both count literals:** they are literals ON PURPOSE — a count derived from the thing it checks passes for any list including an emptied one, which is the single failure the assertion exists to exclude.

---

## 5 — ⛔⛔ THE FINDING: A SUCCESSFUL SCRUB UNLOCKS THE TYPE GATE

**This is the slice's own product and it is the reason nothing is committed.**

`packages/domain/src/redaction/redact.ts`, `redactAllowlistedValue`:

```
const scrubbed = redactString(value);
if (scrubbed !== value) return scrubbed;          // <-- returns, SKIPPING the type gate
return isSafeFieldValue(key, value) ? value : REDACTED_RAW;
```

⇒ ***IF `redactString` CHANGED ANYTHING AT ALL, THE RESULT IS RETURNED AND `isSafeFieldValue` NEVER RUNS.*** A *partially* scrubbed string is treated as proven safe because *one* recognized secret was removed from it.

**Measured on the reachable path (`errorMessage` is allowlisted; the worker logger consumes this module — see §6):**

| input | BEFORE slice | net ONLY | **net + scrub alt (as built)** |
|---|---|---|---|
| `?key=AIza...` alone | `[REDACTED:raw]` | `[REDACTED:field-dropped]` | ✅ `?address=x&key=[REDACTED:credential]` |
| **`?key=AIza...&access_token=SECRET`** | `[REDACTED:raw]` | `[REDACTED:field-dropped]` | ⛔ **`access_token=ya29-SECRETVALUE-...` EMITTED VERBATIM** |
| `?access_token=SECRET` alone **(control)** | `[REDACTED:raw]` | `[REDACTED:raw]` | ✅ `[REDACTED:raw]` |
| `?email=jane.doe@acme.com&key=AIza...` | `[REDACTED:raw]` | dropped | ⛔ **email emitted verbatim** |

⭐ **THE CONTROL IS WHAT MAKES IT AN ATTRIBUTION RATHER THAN AN ANECDOTE:** `access_token` **alone** still drops. It is not that the sibling secret is undetected — it is that **scrubbing the Google key is what lets it out.**

⭐⭐ **AND THE HALF THAT ISOLATES BLAME: THE DETECTION NET ALONE IS SAFE.** Only the `CREDENTIAL_TOKEN` scrub alternative causes it.
⇒ ⛔ ***DETECTION NETS ARE MONOTONE; SCRUB ALTERNATIVES ARE ANTI-MONOTONE AT THE RECORD LEVEL.*** Adding a detector can only add refusals. Adding a *scrubber* REMOVES the trigger that was causing a fail-safe drop, so it converts drops into pass-throughs. **The brief priced this slice as "a pure TIGHTENING." That is true of half of it and false of the other half, and I asserted the whole thing at Step 2.5.**

**The defect is PRE-EXISTING and STRUCTURAL — this slice does not create it, it makes it REACHABLE for a new input class.** Any future addition to `CREDENTIAL_TOKEN` has the same effect.

⛔ **AND THE SITE CARRIES A FALSE ASSURANCE, `029`'s class exactly.** The comment reads: *"a recognized secret becomes REDACTED_CREDENTIAL and a residual-unsafe field drops whole — either way it never reaches the type gate."* **It enumerates TWO outcomes where there are THREE.** The third — *partially scrubbed, residually safe-looking* — also never reaches the type gate, and it is the only one that emits. ⚠ **A reader auditing this line is told the gate is bypassed only in cases that are already safe.**

⭐ **The coupling the brief treated as independent: this is exactly what the held `URL_CREDENTIAL_PARAM` was built to catch.** Promoting the scrub without the param net creates the gap the param net closes — but the param net cannot be promoted (§3). **The two questions are not separable, and the brief asked them as if they were.**

---

## 6 — REACHABILITY, MEASURED — AND A SEVERITY CLAIM I RETRACTED BEFORE SENDING IT

**Method:** census of non-test files referencing the changed surface, then per-file resolution of *which package each imports from* (positive control on a known-present token, negative control on a nonsense token; the first run's "no matches" was a shell-glob error the controls caught immediately).

**Genuine `@sow/domain` consumers — production:**
- `apps/worker/src/observability/logger.ts:14` — `redactRecord`, `redactError`. **The rule-7 log sink itself.**
- `apps/worker/src/composition/reconcileScheduler.ts:30` — `redactError` on `pass_faulted.cause`.

**NOT consumers of this copy** (they use `@sow/policy`'s own local `looksUnsafe`, which `audit-signal.ts:95` says outright it deliberately does not take from domain): `packages/knowledge` (4 files), `packages/policy`, `apps/worker/src/boot.ts`. `packages/providers` / `packages/integrations` carry their own.

⇒ **Unlike `isRedactionSafe` (zero production callers, `183` §5 / `### 24.126`), the surface this slice changes IS production-reachable.**

⛔⛔ **THE RETRACTION, RECORDED BECAUSE THE UNRETRACTED VERSION WAS ONE MESSAGE FROM BEING SENT:** having established reachability, I was about to report *"this slice closes a live rule-7 leak — a Google API key was previously emitted raw to the worker log sink."* **I measured it instead. It is FALSE.**
**`redactRecord` dropped the field wholesale before the slice (`[REDACTED:raw]`), for every field name probed.** The raw-content type gate was already fail-safe.
⇒ ⭐ ***THE SLICE'S EFFECT ON THE REACHABLE PATH IS AN AVAILABILITY GAIN, NOT A LEAK FIX — the opposite direction from the one the task framing implies.*** **And chasing the availability gain is exactly what produced §5's leak.**
⚠ **`redactString` in isolation DID pass the key through un-scrubbed before this slice. That is true and it is not the same claim** — no production caller reaches `redactString` without going through the field classifier first. *Applicability: a function-level fact is not a system-level fact.*

---

## 7 — INSTRUMENT REPORT

1. ⛔⛔ **MY OWN MUTATION PROOF WAS DECORATIVE FOR THREE MUTATIONS, AND I CAUGHT IT ONLY BY READING MY OWN OUTPUT.** I printed *"mutation applied, proven by diff"* using `git diff -- <path>`, which compares against **HEAD** — so it printed my whole *slice* diff and **would have printed identically had the mutation never applied.** ⭐ Re-run against a **pre-mutation snapshot** with a **negative control** (unmutated file vs snapshot ⇒ identical), which is a comparand that can actually distinguish the two cases. ⚠ **All three mutations produced RED, which is self-proving per `029`, so no conclusion moves** — but the *proof line* was worthless and it looked authoritative. **`183` §17's class, in my own hands, one slice later.**
2. ⚠ **`grep` emitted a `4 matches in 4 files` summary for a single-file query, twice, plus `NNN:0:<text>` lines.** ⛔ **SUPERSEDED THE SAME EVENING BY `### 24.131`, AND IT IS NOT FABRICATION: `grep` here resolves to `ugrep 7.5.0`** (a shell function in the Claude shell snapshot; confirmed by `type`, `--version`, and the `ugrep:` prefix it emits on a deliberate regex error). **Both symptoms are ugrep's own output format read as POSIX `grep`'s.** ⭐ **Recorded because I wrote it up under the old *"grep fabricates"* framing, which teaches DISTRUST and has no remedy, where *"grep is ugrep"* teaches a SUBSTITUTION.** Every census here was re-read at source with `sed` regardless, so no figure depends on it.
3. ⚠ **A `--include=*.ts` glob failed unquoted under zsh and printed `no matches found`** — which reads exactly like a clean empty result. **The negative + positive controls in the same invocation caught it immediately.** ⇒ ***the controls earned their cost on their first outing this session, and the failure was in the calming direction.***
4. `graphify query` returned a 291-node import-heuristic BFS dominated by barrel files — not wrong, but far too coarse for a consumer census; the targeted census is what answered it.

---

## 8 — DECISIONS MADE

| decision | rationale |
|---|---|
| **`GOOGLE_API_KEY` promoted VERBATIM** (no `/i`, no `\b`) | A "small improvement" during promotion would make the canonical copy diverge from the copy it is about to absorb — the drift this family exists to end. |
| **Separate net, not a new alternative inside `CREDENTIAL_PREFIX`** | `CREDENTIAL_PREFIX` carries `/i`; folding it in would silently widen to `aiza...`. Also the brief's acceptance requires array membership so the reflecting guard sees it. |
| **`URL_CREDENTIAL_PARAM` HELD** | §3. Structurally unpromotable under this module's composition. `### 24.129`. |
| **Registration assertions discharged, then re-proven with net #5** | §4. |
| **Reason for the held net written AT THE SITE** | `L187` — the wrong edit happens in this file, not in the tracker. |

## Decisions explicitly NOT made

| deferred | why, and to whom |
|---|---|
| ⛔ **Whether the `CREDENTIAL_TOKEN` scrub alternative ships at all** | §5 is a rule-7 regression on a reachable path. Routed at Step 9 → lead. **The detection net alone is safe; `### 24.118`'s Done-when names the scrub alternative, so dropping it fails the task as written.** Not mine to trade. |
| **Fixing `redactAllowlistedValue`'s gate bypass** | Pre-existing, affects every allowlisted field and every `CREDENTIAL_TOKEN` alternative — far wider than this slice. Needs its own task. |
| **Correcting the false two-outcome comment at that site** | Same site, same owner as the above; correcting the comment without the code would repair the document and leave the defect (`029`). |

---

## 9 — ⛔⛔ "NOTHING WOULD RED" IS FALSE, AND IT IS THE LOAD-BEARING SENTENCE OF THE WHOLE TASK

**`### 24.118`'s entry, brief `300`, the dispatch message, and my own first-draft source comment all state that delegating before promoting would delete a live detector and *nothing would red*.** I wrote it into the file on inherited authority and then checked it.

**MEASURED:** `packages/integrations/test/gateway-redaction-credentials.test.ts` pins **both** contested capabilities through integrations' own exported surface (`isGatewayLogSafe` / `redactString` / `buildSafeConnectorLog`) — a standalone Google key, a Google key echoed in a request URL, an opaque `access_token=`, an AWS SigV4 `X-Amz-Signature=`, and the connector-log path. **A delegation that dropped the local nets would red five assertions in that one file.**

⇒ ⭐ **THE ORDERING RULING SURVIVES; ITS STATED REASON DOES NOT.** The hazard is not a silent loss. It is that **the red arrives looking like an obstacle to a cleanup that has already been decided on**, and the cheapest way past a red is to weaken the pin — `### 24.55`'s failure mode, and `### 24.128` is a live instance of exactly that shape this round.
⚠ **A weaker, truer reason is still a sufficient reason. But it is a different one, and the difference decides what step 2 must be told to watch for** — *"do not let the delegation edit these tests"* is actionable; *"nothing will warn you"* is not.

⛔⛔ **AND IT SURFACES A BLOCKER FOR STEP 2 THAT NOBODY HAS RECORDED: integrations pins `access_token=` and SigV4 scrubbing, and `URL_CREDENTIAL_PARAM` is STRUCTURALLY UNPROMOTABLE into `@sow/domain` (§3).** ⇒ ***`### 24.118` step 2 cannot fully delegate integrations' copy at all — not in the wrong order, but in ANY order.*** The capability has no canonical home available to it. **Step 2 must therefore be re-scoped to a PARTIAL delegation with a documented local override, or the composition question in `### 24.129` must be solved first.** Routed, not decided.

⭐ **Corrected at the site as well as here** — the source comment now states the measured version and names the real failure mode.

---

## 10 — AN OUTPUT-LAYER SUBSTITUTION HIT `diff` AND BROKE THE REMEDY FOR §7.1

> ⛔⛔ **MECHANISM RETRACTED 2026-08-18, BY ME, BEFORE IT PROPAGATED FURTHER — THIS SECTION ORIGINALLY READ *"A SEVENTH `### 24.122` ANOMALY: `diff` IS WRAPPED."* THAT NAME IS FALSE.**
> **MEASURED AT SOURCE, three ways, after `### 24.131` landed:** `type diff` -> a shell function from the Claude shell snapshot whose entire body is `command diff --color "$@"` · `diff --version` -> **`Apple diff (based on FreeBSD diff)`** · `diff` and `/usr/bin/diff` on a known-different pair -> **identical standard output, BOTH exit 1.** ⇒ ***`diff` is real POSIX diff with a colour flag. It is not substituted, and it exits correctly.***
> ⛔ **I INFERRED A TOOL IDENTITY FROM OUTPUT SHAPE AND PUT THE WRONG NAME IN A HEADING — the exact defect `### 24.131` records against the orchestrator, committed by me four hours later, on the entry describing it.** ⭐ **`L235` is why the heading itself is rewritten rather than footnoted: a hedge protects the claim, not the artifact, and the title is what a reader carries.** **`L236`: a wrong mechanism is more expensive than no mechanism — and I had asked the orchestrator to bank this one.**
> ✅ **WHAT SURVIVES, AND IT IS UNEXPLAINED RATHER THAN UNREAL:** the OBSERVATIONS below are real and were not produced by any property of `diff`. They belong to the **uncharacterized literal-`ok` family** (`git status`, `git commit`, `pnpm install`, and here `[ok] Files are identical`) — **an intermittent substitution in the command-OUTPUT path, tool-agnostic**, not a per-tool wrapper. ⛔ **Not folded into `### 24.122`'s git hypothesis on a fit** (`L202`).
> ⭐⭐ **AND THE CORRECTED RULE IS BETTER THAN THE ONE I BANKED, because it explains why `cmp` worked: BRANCH ON EXIT CODES INSIDE THE SHELL; DO NOT PARSE RENDERED OUTPUT.** My failing proof piped `diff` into `head` and READ TEXT; my working one used `cmp -s` and branched on `$?`, which the shell evaluates before anything is rendered. ⇒ ***the discriminator is not `cmp`-vs-`diff`, it is exit-code-vs-text*** — and `cmp -s` is merely the cheapest exit-code-only comparand. **`/usr/bin/cmp` is unwrapped; `diff` and `grep` are shell functions.**


**Controlled probe, four cases, ground truth by `sha256`:**

| probe | output | exit |
|---|---|---|
| `diff` on two KNOWN-DIFFERENT files | ⛔ `d1.txt -> d2.txt` / `+1 added, -1 removed, ~0 modified` — **a non-standard summary format** | ⛔ **0** |
| `diff` on two IDENTICAL files | `[ok] Files are identical` | 0 |
| **`cmp` on the different pair** | ✅ `differ: char 7, line 2` | ✅ **1** |
| the same `diff` **inside a shell function** | ✅ standard `2c2 / < beta / --- / > GAMMA` | — |

⛔ **REAL `diff` EXITS 1 WHEN FILES DIFFER. THIS ONE EXITS 0.** ⇒ ***any script gating on `diff`'s exit status is broken in this checkout, silently and in the passing direction.***

⚠ **It is INTERMITTENT, not contextual** — the same top-level form produced standard output earlier in this session and the wrapped form later; the in-function probe went the other way. **`029`'s instrument #7 (`npx`) family: intermittency IS the finding, and one clean probe proves nothing.**

⛔⛔ **HOW IT BIT: my mutation harness printed `[ok] Files are identical` for two mutations THAT HAD DEMONSTRABLY APPLIED.** Caught only because N1 and N2 produced **different** failure sets, each exactly as predicted — ***an instrument contradicted by its own subject.***

⇒ ⭐⭐ **THE IRONY IS EXACT AND IT IS THE POINT: I adopted snapshot-`diff` in §7.1 precisely BECAUSE `git diff` had given me a decorative proof. The replacement then produced a FALSE proof in the opposite direction.** ***A remedy for an untrustworthy instrument was itself an untrustworthy instrument, and the second failure was worse — decorative output proves nothing, but `Files are identical` actively asserts the mutation did not apply.***

⭐ **THE DURABLE RULE, AND IT REPLACES WHAT §7.1 RECOMMENDED: prove mutation-application with `cmp -s` (exit 1) or by `sha256` comparison. NEVER with `diff`, and never by branching on `diff`'s exit code.** Both mutations were re-proven that way — `cmp` DIFFER + a changed sha for each, a negative control returning IDENTICAL on the unmutated file, and byte-identical restore.
⚠ **No conclusion in this document moves** — every mutation produced RED, which is self-proving (`029`). **What moves is the METHOD, and it moves for everyone.**

---

## 11 — THE REVIEWER ROUND, AND THE CORRECTION I HAD TO REFUSE

**`code-quality-reviewer`: 11 findings (0 high / 5 medium / 6 low). `security-reviewer`: 1 critical, 2 high, 2 medium, 2 low.** Every fix-in-slice item was **verified independently at source before acting** — a correction arrives with a reviewer's endorsement attached and reads as already-vetted, which is `029`'s recorded defect vector and this area's own.

### ⛔⛔ 11.1 — THE CRITICAL ONE, AND I MISSED IT: A **THIRD** COPY, ON THE SOLE-WRITER PATH, WITH A BLIND PARITY PIN

`packages/policy/src/audit-signal.ts:103` holds a third net set — **three nets, no `GOOGLE_API_KEY`, no `stripMarkers`**. It backs `contentContainsSecret` in `packages/knowledge/src/knowledge-writer/secret-scan.ts`, which is the KnowledgeWriter's **blocking pre-commit secret scan** (rule 1 sole-writer + rule 7), and the audit-signal persistence refusal in `gcl/projection.ts:102` (rule 4).

**MEASURED, both controls run:**

| input | `contentContainsSecret` |
|---|---|
| `My Google key is AIzaSyA...` | ⛔ **false** |
| bare Google key | ⛔ **false** |
| `sk-ant-api03-...` *(positive control)* | ✅ true |
| `the password is hunter2` *(positive control)* | ✅ true |
| ordinary prose *(negative control)* | ✅ false |

⇒ ***A GOOGLE API KEY PASSES THE SOLE-WRITER PRE-COMMIT SCAN AND CAN BE WRITTEN INTO CANONICAL MARKDOWN.***

⛔ **HONEST ATTRIBUTION, BECAUSE IT DECIDES THE DISPOSITION: THE LEAK IS PRE-EXISTING — policy's copy never had `AIza`, before or after.** **What this slice breaks is the PARITY INVARIANT.** A dedicated pin exists for exactly that — `packages/policy/test/audit-signal.test.ts`, whose failure message reads *"packages/policy and @sow/domain returned DIFFERENT verdicts on a credential shape — a second hand-maintained copy has re-diverged (task 24.46)"*. **Measured on the committed version: ZERO of its fixtures contain `AIza`** (positive control on the same stream: 20 hits of `isRedactionSafe`). **The suite is green: 522 pass, 0 fail.**

⇒ ⭐⭐ **THE EXACT SHAPE §9 RETRACTED FOR INTEGRATIONS IS TRUE ONE PACKAGE OVER.** For integrations, *"nothing would red"* was false — pins exist. **For policy it is TRUE: the guard built to catch this re-divergence is blind to the one shape that just diverged.** ⇒ ***a parity guard is only as wide as its fixture list, and a fixture list is a hand-maintained set — the same class `### 24.118` is about, one level up, defending the thing rather than being the thing.***

⛔ **NOT FIXED IN-SLICE, AND THE REVIEWER'S "minimum fix" IS DECLINED ON TERRITORY GROUNDS:** `packages/policy/test/audit-signal.test.ts` is providers-integrations territory **and is being actively edited by that session right now** (measured `126/31` uncommitted). Editing it would clobber a live session's work. **Routed, not touched.**

⚠ **Also inherited-stale, worth one line:** `audit-signal.ts:94` says *"do NOT delegate this module until `### 24.120` is resolved."* **`### 24.120` IS resolved.** The stated blocker is stale and nothing reds on it.

### ⛔ 11.2 — "NOTHING IS DELEGATED YET" WAS FALSE, IN MY OWN COMMENT, TWICE

`packages/providers/src/redaction/provider-log-redaction.ts:21` **already imports `looksUnsafe`, `PEM_BLOCK`, `URL_USERINFO_SEGMENT` and `CREDENTIAL_TOKEN` from `@sow/domain`** (delegated at task 10.1). ⇒ ***this slice changed providers' `redactString` and `isProviderLogSafe` IMMEDIATELY, cross-track, from a contract-track slice.*** Providers measured green (378/378), so it is an **undeclared-scope** defect rather than a breakage — but the claim was load-bearing in a file whose entire thesis is that stale copy-provenance comments cause the wrong cleanup.
⚠ **`codegraph_impact` on `CREDENTIAL_TOKEN` does NOT surface the providers import** — the tooling would not have corrected me. **Corrected at the site with all three copies and their three different states enumerated.**

### ⭐ 11.3 — THE CORRECTION I REFUSED, WITH THE MEASUREMENT

`security-reviewer` stated my exhibit *"does not reproduce"* — that `?key=AIza…&access_token=SECRET` drops both pre and post because `SECRET` trips `\bsecret\b`, and that **my** stated control measures `[REDACTED:field-dropped]` rather than `[REDACTED:raw]`.

**Re-measured. The evidence is against them and I am not conceding it:**

| fixture | result |
|---|---|
| **my** exhibit `...&access_token=ya29-SECRETVALUE-...` | ⛔ **survives verbatim** — reproduces exactly as reported |
| **my** control (same value, no `AIza`) | ✅ **`[REDACTED:raw]`** — the marker I reported |
| **their** substitute `access_token=SECRET` | `[REDACTED:field-dropped]` — correct, but a *different fixture* |
| `SENSITIVE_KEYWORD.test("SECRETVALUE")` | **false** — no `\b` after `SECRET` |

⇒ **They swapped the fixture and then reported the swap as a refutation of mine.** ⭐ **`029`'s rule applied in the direction it is hardest to apply — *when an agent pushes back on a correction with verifiable evidence, defer to the evidence* — and here the correction came from the review I had every reason to trust.**

⭐⭐ **AND THEIR SUBSTANTIVE EXPANSION IS RIGHT, AND IS STRICTLY STRONGER THAN MY VERSION — accepted in full:**
- **It is not about query strings.** Any `AIza`-shaped substring **anywhere** in a value, under **any** of the 20+ allowlisted fields, unlocks the whole value.
- **It is rule 5, not only rule 7** — PII (`alice@acme.com`) and an employer codename (`Project FALCON`) survive verbatim where they previously dropped. **Measured.**
- ⛔⛔ **THE TRIGGER IS FORGEABLE: `AIzaAAAAAAAAAA` — 14 plain ASCII characters, no real key — is sufficient.** **Measured.** On any path carrying imported/untrusted content (ING-7), appending that literal converts a drop into verbatim emission.
- **The primitive is PRE-EXISTING** (`sk-aaaaaaaa` already triggers it). ⇒ **the slice's real contribution is that EVERY FUTURE `CREDENTIAL_TOKEN` ALTERNATIVE SILENTLY ENLARGES IT — which makes it a blocker for the DELEGATION leg, not for this slice.**

### 11.4 — other fixes taken

| finding | action |
|---|---|
| `describe("… a pure TIGHTENING")` + *"there is no mechanism for it"* | ⛔ **RETRACTED** — my own finding is the counter-example. Split: the net is monotone, the scrub alternative is not, stated at the site. |
| No `redactRecord`-layer pin — every pin sat one layer above where the change leaks | **Characterization pin added**, fenced as a known defect with its control. |
| `looksUnsafeReference` conflated two changes; the 24.120 arm's corpus witness could go silent | **`GOOGLE_API_KEY` added to the reference** so the differential stays about the arm. |
| `expect(looksUnsafe("AIzaTeam meeting notes")).toBe(false)` claimed a wordness semantic the net lacks — and was contradicted 13 lines later by my own no-boundary pin | **Rewritten as a length claim, both directions.** |
| No counterpart to the non-global detection pin | **Added** — scrub patterns must stay `/g` or only the first secret is removed. |
| Greedy `AIza` consumes into an adjacent JWT, leaving post-dot segments (measured, contrived) | Noted; routed with the family. |
| Comments the diff falsified (`CREDENTIAL_PREFIX` mirror claim, "one of the **three** nets"), dangling referent, duplicated literal, fixture length, test names | **All fixed**, each verified at source first. |

---

## 12 — ⛔⛔ THE LEAD'S REGRESSION CLAIM IS **CONFIRMED**, AND IT INVERTS MY OWN §6

**Asked by the lead as a HYPOTHESIS derived from a description, with nothing measured — and flagged as such. Measured here, both sides, real-shaped 39-character `AIzaSyD-…` key, under the allowlisted `errorMessage` field.**

| carrier | BEFORE (pre-slice) | AFTER (slice live) |
|---|---|---|
| real key + street address | `[REDACTED:raw]` | ⛔ key scrubbed, **`1600+Amphitheatre+Pkwy` SURVIVES** |
| real key + PII + employer codename | `[REDACTED:raw]` | ⛔ key scrubbed, **`alice@acme.com` AND `FALCON` SURVIVE** |
| **CONTROL — same line, NO key** | `[REDACTED:raw]` | ✅ `[REDACTED:raw]` — **identical both sides** |
| **CONTROL — key ALONE** | `[REDACTED:raw]` | ✅ `[REDACTED:credential]` — the genuine gain |

⇒ ⭐⭐ **THE TWO CONTROLS TOGETHER ARE WHAT MAKE THIS AN ATTRIBUTION RATHER THAN AN ANECDOTE: remove the key and the two sides are IDENTICAL, so the key is the cause; give the key no companion text and the change is a pure improvement, so the mechanism is the COMPANION TEXT, not the key.**

⛔⛔ **THE RESULT, STATED THE WAY THE LEAD STATED IT, BECAUSE THEIR FRAMING IS THE CORRECT ONE: THE REGRESSION LANDS ON EXACTLY THE POPULATION THE PROMOTION EXISTS TO PROTECT.** A log line carrying a real Google API key — the thing the detector was added for — moves from **fully redacted** to **partially raw**. ⇒ ***the only lines that IMPROVE are those where the key is the ENTIRE value, which is the least realistic shape a key ever takes in a diagnostic.***

⭐⭐ **AND THE SHARPEST FORM: THE MORE SENSITIVE CONTEXT ACCOMPANIES THE KEY, THE MORE THE PROMOTION LEAKS** — because the gate that would have caught the context is skipped *precisely when the key is found*. **Detection strength and leak size move together, in the same direction.**

### ⛔ This RETRACTS my §6 conclusion, and the retraction is the important part

**§6 says: *"the slice's effect on the reachable path is an AVAILABILITY GAIN, not a leak fix."*** ⛔ **That is true and I drew the wrong conclusion from it. THE AVAILABILITY GAIN AND THE LEAK ARE THE SAME EVENT.** The text that "becomes available" IS the sensitive context. ⇒ ***I measured the mechanism correctly in §6 and then priced it as a benefit, because I was still asking whether the slice LEAKED A KEY rather than what it EMITTED.***

⚠ **The orchestrator named their own version of this defect — *"I assessed the change on the adversarial path and never on the path it exists to serve."* Mine is the same omission arriving one step earlier: I had the measurement in §6 and asked the wrong question of it.** ⭐ **Neither of us was missing data. `L234`'s shape — the author of a measurement is the one least likely to re-read it.**

⇒ ⛔ **SHIP OPTION (1) IS REFUTED BY MEASUREMENT, NOT BY CAUTION.** The lead's ordering — **F2's gate fix first (`### 24.132`, contract's own territory), promotion after** — is the only one that does not knowingly degrade the target population. **My own ship-ask recommended (1); it was wrong, and the reason it was wrong is in this document's §6.**

---

## 13 — ⛔⛔ I NEARLY DESTROYED THE HELD SLICE, AND THE CHECK THAT SHOULD HAVE STOPPED ME RAN AND PRINTED AND GATED NOTHING

**Parking `### 24.118` to build `### 24.132` on a clean base, I ran a verify-then-park script. It did this:**

```
cmp -s "$f" "$B/$f" && echo CURRENT || { echo "*** STALE — refreshing ***"; cp "$f" "$B/$f"; ok=0; }
...
git checkout -- <the three tracked files>          # IRREVERSIBLE
mv <the untracked new test> "$B/PARKED-..."        # IRREVERSIBLE
```

**Every `cmp` reported STALE. Every `cp` FAILED** — `No such file or directory`. **`ok=0` was set four times.** ⛔ **And then the script ran the `git checkout` and the `mv` anyway, because `ok` gated NOTHING.**

⇒ ⭐⭐ ***`L109` IN ITS PURE FORM, COMMITTED BY ME IN THE SAME SESSION IN WHICH I RELAYED ITS EXIT-CODE COROLLARY: A CHECK ONLY GATES IF A DECISION SITS BETWEEN READING IT AND ACTING.*** **I computed a safety verdict, printed it in alarming red-flag wording, stored it in a variable, and then discarded the variable.** ⚠ **The output even said `cp: No such file or directory` FOUR TIMES on screen before the destructive step ran.**

### The root cause is a naming decision, not a scripting slip

**The backup directory was keyed to `$(git rev-parse --short HEAD)`.** ⛔ **HEAD moves — twelve commits landed under me during the hold — so a later "refresh" of just the session doc created a SECOND directory under a NEW sha containing ONLY that one file.** Then `ls -d ~/.sow-slice-backup/24.118-step1-* | head -1` selected **alphabetically**, and `2a6bbc8a` sorts before `d0765c3a`.
⇒ ***I selected a backup by ALPHABETICAL ACCIDENT and validated against a directory that had never held the files.***
⛔ **A BACKUP KEYED TO A MOVING IDENTIFIER FRAGMENTS SILENTLY, AND EVERY FRAGMENT LOOKS LIKE A BACKUP.**

### Why nothing was lost, stated honestly

⭐ **Luck, of the same kind `029` opens with.** The FIRST backup — taken before HEAD moved — was complete, so `d0765c3a` still held all four files, and the `mv` had landed the untracked file intact in the other directory. **Two independent copies of the new test file were then compared with `cmp` and agreed.** ⇒ **Recovery was total, and it was not earned by the check that was supposed to guarantee it.**

### Fixed, and the fix is the naming rather than the script

**One authoritative directory, `~/.sow-slice-backup/24.118-step1-HELD/` — no sha, so it cannot fragment.** Every file verified present and non-empty by exit-code branch, plus a **positive control on content** (`GOOGLE_API_KEY` appears 4x in the backed-up source, so it is the post-promotion copy and not a HEAD blob). 551/351/188/169 lines + the session doc.

⇒ ⛔ **THE RULE: A DESTRUCTIVE STEP MUST BE A SEPARATE INVOCATION FROM ITS PRECONDITION CHECK, so the check's exit status is read by a human or by an explicit guard before the irreversible command is issued.** ⭐ **Identical in shape to `029`'s worker finding — *"the command PRINTED the staged set and ran `git commit` in the SAME invocation, converting the gate into a receipt"* — and I had read that finding at the start of this session.**
⚠ **`L234` again: the author of a measurement is the one least likely to re-read it. I wrote the check, so I already knew what it would say.**

---
---

# PART TWO — `### 24.132` (brief `303`): the gate that a scrub was allowed to waive

**`### 24.118` step 1 is PARKED out of the tree for this** (`~/.sow-slice-backup/24.118-step1-HELD/`, content-verified) so this lands on a clean base, per the lead's ordering.

## 14 — THE FIX, AND THE TRAP IN MY OWN PROPOSED SHAPE

`redactAllowlistedValue` now: **(1)** unredactable ⇒ `REDACTED_FIELD`, its own arm · **(2)** the type gate runs on the **scrubbed** value · **(3)** where the gate can judge, it is **enforced** ⇒ `REDACTED_RAW` · **(4)** where it cannot, today's behaviour is preserved exactly.

⛔⛔ **ARM (4) IS WHERE I NEARLY INTRODUCED A NEW LEAK, IN THE ARM WHOSE ONLY JOB WAS TO CHANGE NOTHING.** My Step-2.5 shape ended `return scrubbed;`. **For a vocabulary-less key with NO scrub, `scrubbed === value`, so that returns THE ORIGINAL VALUE — where today it returns `REDACTED_RAW`.** ⇒ ***a fix for a leak, introducing a leak, in its own no-op branch.*** Correct form is `scrubbed !== value ? scrubbed : REDACTED_RAW`. ⭐ **Found by enumerating the four cells rather than by testing — the pins I had written would not have caught it, because none of them used a vocabulary-less key.**

## 15 — ⛔ THE RESIDUAL IS **EIGHT** FIELDS, NOT TWO. I TOLD THE ORCHESTRATOR TWO, AND THEY RELAYED IT

**Measured: `attempt, count, durationMs, errorMessage, errorStack, fields, retryable, timestampMs`.**

⚠ **The claim was not idle — it was the load-bearing reason the residual looked small enough to route rather than solve** (*"isolates the open question to exactly TWO fields"*). ⛔ **I derived "two" from the two fields I had been reasoning about, and never enumerated the set.**

⭐ **The correction is not simply "four times bigger" — the eight split into two kinds with different risk, and that distinction is what the enumeration bought:**
- **`errorMessage`, `errorStack`** — genuinely free-form prose; the gate is vacuous **by design**; the measured leak lives here. **This is the real residual.**
- **`attempt`, `count`, `durationMs`, `retryable`, `timestampMs`, `fields`** — numeric / boolean / container. **Their normal values never reach the string branch at all** (they pass by TYPE earlier), so they land in the waiver **only when a caller passes a STRING under them** — a wrong-typed value, i.e. ***exactly the case where a waiver is least deserved.***

⇒ **The substantive routing is unchanged; its stated scope was wrong, and the second kind was invisible until the set was enumerated rather than recalled.** **Pinned by name, not by count, so the set cannot grow silently.**

## 16 — `hasFieldVocabulary` IS DERIVED, AND THE REFACTOR IS **PROVEN** BEHAVIOUR-IDENTICAL

The `switch` became one `FIELD_VOCABULARY` map; `isSafeFieldValue` and `hasFieldVocabulary` both read it plus the same two predicates. **No second list exists to drift** — the orchestrator's ADD, discharged by construction rather than by a keep-in-sync comment.

⭐ **Behaviour-identity was PROVEN, not asserted (341 passing tests is evidence, not proof).** A scratch matrix over **34 keys x 34 values = 1,156 cells** was run against **both** implementations — the pre-refactor `switch` restored from HEAD, and the table:

| implementation | cells | trueCount | fingerprint |
|---|---|---|---|
| pre-refactor `switch` (HEAD) | 1156 | **409** | **3943871851** |
| post-refactor table | 1156 | **409** | **3943871851** |

**Two independent statistics agreed.** Control built, used, deleted; the matrix ships as a forward regression pin with a non-degeneracy assertion first (a fingerprint over an all-false matrix would match itself forever).

⛔ **THREE OF MY FIRST-DRAFT PINS WERE WRONG BECAUSE I WROTE THE EXPECTATIONS FROM ASSUMPTION** — `ts` does accept a date-only form; `providerId` does not accept `"anthropic"` (the enum is `claude`/`openai`/…). ⭐ **Re-measured and rewritten; and the precedence pin is now demonstrated WITHOUT depending on enum membership at all** — the same value `corr-12345` is accepted under `correlationId` and rejected under `providerId`, which is the ordering itself rather than a fact about the enum.

## 17 — MUTATIONS (`cmp`-proven applied, byte-identical restore)

| mutation | reds |
|---|---|
| **M1** restore the early return (the defect) | **5** — the 3 leak pins + both marker-semantics pins |
| **M2** `hasFieldVocabulary` always false | **8** — incl. all three derivation pins |
| **M3** precedence broken (id rule before the table) | **3** — fingerprint, my precedence pin, **and a PRE-EXISTING worker-era safety pin I did not write** (*"`providerId` — an enum field whose Id-suffix must NOT defeat enum validation (re-verify HIGH)"*) |

⭐ **M3's third red is independent corroboration: my precedence pin guards the same property an existing safety pin already guarded, so the Map rewrite is covered by two authors' tests rather than only my own.**
⚠ **`L237` honesty: the representative-cells and precedence pins carry 3 assertions each and the runner aborts at the first failure, so each mutation proved ONE of their assertions, not all three.** The leak pins are single-assertion by construction and are individually attributable.

## 18 — ⛔ CROSS-TERRITORY CONSEQUENCE: A `apps/worker` TEST REDS, AND I HAVE NOT TOUCHED IT

`apps/worker/test/observability/logger.test.ts:50` — *"scrubs a credential in a field VALUE before it reaches the sink"*. **Same shape as the two domain pins the lead ruled I should split:**
- `not.toContain("sk-Abc…")` — ✅ **still passes; the credential never reaches the sink**
- `toContain(REDACTED_CREDENTIAL)` — ⛔ now `{"status":"[REDACTED:raw]"}`

⇒ ⭐ **No leak; the marker moved, at the PRODUCTION LOG CHOKEPOINT — which is also independent confirmation of the reachability census in §6.** ⛔ **`apps/worker` is worker-implementer's territory. Flagged at Step 9, NOT edited.** **Recommended disposition is the same split the lead ruled here: the safety assertion stays untouched; the marker assertion becomes its own pin.**

---

## 19 — ⛔⛔ THE ORDERING DID NOT ACHIEVE ITS PURPOSE: `### 24.118` STILL CAUSES THE REGRESSION WITH `### 24.132` LANDED

**`### 24.132` committed at `7cb304ff`. `### 24.118` re-merged onto it (source blocks taken from the verified backup, not retyped; counts reconciled against the backup: `24.118`=8 lines, `AIza`=6, `GOOGLE_API_KEY`=4 — identical).** Suite 363/363.

**Then the payoff measurement — the one the lead's ordering exists to produce:**

| field | 24.132 + 24.118 | 24.132 ONLY (24.118 backed out) |
|---|---|---|
| `correlationId` | ✅ `[REDACTED:raw]` | — |
| `sourceId` | ✅ `[REDACTED:raw]` | — |
| **`errorMessage`** | ⛔ **leaks `alice@acme.com` + `FALCON`** | ✅ **`[REDACTED:raw]`, no leak** |

⇒ ⛔⛔ ***THE LEAD'S PRECONDITION — "the promotion ships after, WHEN IT IS NO LONGER FEEDING A BYPASS" — IS NOT MET. It is still feeding the bypass, on the residual.***

⭐⭐ **THE STRUCTURE, AND IT IS THE ROUND'S OWN SHAPE ARRIVING ONE LEVEL UP: THE ORDERING WAS JUSTIFIED BY A MEASUREMENT IT DOES NOT ADDRESS.** §12's regression — the table that produced the ruling — was taken on **`errorMessage`**, and `errorMessage` is precisely the field `### 24.132` **cannot** fix, because the type gate is vacuous there by design. ⇒ ***I told the orchestrator at Step 2.5 that `### 24.132`'s Done-when "cannot close its own witness." The same sentence is true of the SEQUENCING DECISION, and neither of us noticed it while acting on it.***

⛔ **`### 24.132` is not thereby wasted and must not be read that way:** it closes the leak on **26 vocabulary-bearing fields**, measured, including the two id fields where a real leak was demonstrated. **What it does not do is make the promotion safe.**

⚠ **AND THE DIRECTION MATTERS: `errorMessage` / `errorStack` are where DIAGNOSTICS ACTUALLY LIVE.** The fields the fix protects are ids and enums, whose legitimate values are short tokens; the fields still exposed are the free-form ones a real log line uses. ⇒ ***the residual is not the tail of the problem, it is the part with the traffic.***

⇒ ⛔ **`### 24.118` MUST NOT SHIP ON RULING (c) AS WRITTEN.** Its stated precondition is measurably false. **Routed — not mine to re-rule, and explicitly NOT a reason to touch the residual, which is owner-gated.**

---

## 20 — THE SIX-FIELD MEASUREMENT: THE HYPOTHESIS HOLDS, AND THE QUESTION HAD A BETTER FORM

**Asked (orchestrator's inference, flagged by them as unmeasured):** *do `attempt`, `count`, `durationMs`, `retryable`, `timestampMs`, `fields` ever receive a LEGITIMATE value on the string branch? If not, closing them is a BUILD decision rather than an owner one.*

⛔ **THAT QUESTION IS NOT ANSWERABLE, AND SAYING SO IS THE FIRST RESULT.** It is a claim about **every producer, present and future**, and `redactRecord`'s parameter is `Record<string, unknown>` — nothing in the type system prevents a string. **A spelling census over call sites is exactly the instrument this round has repeatedly caught being blind to its own subject.**

⭐⭐ **THE ANSWERABLE FORM, AND IT IS STRICTLY STRONGER: DO NOT ASK WHAT INPUTS ARRIVE — MEASURE WHAT ENFORCEMENT WOULD *CHANGE*.**

| input class | today |
|---|---|
| **A** — native types (`attempt: 1`, `count: 3`, `retryable: true`) | ✅ pass by TYPE, never reach the string branch |
| **D** — a nested object under `fields` (its normal shape) | ✅ recursed normally, untouched |
| **B** — a STRING with **no** credential, under any of the six | ✅ **already `[REDACTED:raw]` TODAY** |
| **C** — a STRING **with** a credential, under any of the six | ⛔ **`retry after [REDACTED:credential] for alice@acme.com`** — companion PII emitted |

⇒ ⭐⭐ ***ENFORCING THE GATE ON THE SIX HAS PROVABLY ZERO EFFECT ON EVERY INPUT THAT IS NOT ALREADY LEAKING.*** **A**, **D** and **B** are untouched by construction; the **only** behaviour that changes is **C** — a value that is anomalous **twice over** (wrong type for its field *and* carrying a credential) and that is **currently emitting companion PII**.

⇒ **The orchestrator's inference is CONFIRMED, on better ground than it was framed:** I never had to establish *"a legitimate value never arrives"*. **I measured that every non-leaking input is already unaffected**, which does not depend on knowing the producers at all.

⭐ **The reframing is the transferable part: a question about INPUTS needs a claim over all producers and cannot be closed; the same concern posed as a question about BEHAVIOUR DELTAS is decidable from the code in front of you.**

⚠ **NOT BUILT, and deliberately.** `### 24.132` is committed (`7cb304ff` + `ff070bee`) and its acceptance line is written; widening a ruled slice after the fact is how atomicity erodes. **Reported for scoping.**

⭐ **A closure worth naming: this would leave the residual at exactly the TWO fields I originally claimed — `errorMessage` / `errorStack`.** ⛔ **My "two" was right in its conclusion and wrong in its derivation, and I only found that out by enumerating the eight.** ***Arriving at the same number twice by different routes is not confirmation — the first route was recall and produced a figure that went into an owner packet; the second was measurement and produced a decomposition that made this question askable at all.***

---
---

# CLOSE-OUT (`/session-end`)

**Successor session:** none at time of writing.
**Predecessor:** `docs/sessions/183-2026-08-18-the-hazard-was-in-the-predicate-not-the-scrubber.md`.
⚠ **`docs/sessions/186-…` is a DIFFERENT session's doc (knowledge), not my successor** — the numbers are orchestrator-assigned and not chronological across areas.

## Files created

| file | purpose | state |
|---|---|---|
| `packages/domain/test/redaction/scrub-does-not-unlock-type-gate.test.ts` | `### 24.132`'s leak pins, controls, and the OWNER-ACCEPTED open-leak pin | **committed** `7cb304ff` + `ff070bee` |
| `packages/domain/test/redaction/field-vocabulary-derivation.test.ts` | verdict matrix + `hasFieldVocabulary` derivation pins | **committed** `7cb304ff` |
| `packages/domain/test/redaction/google-api-key-promotion.test.ts` | `### 24.118` step 1's detection/scrub/boundary pins | ⛔ **UNCOMMITTED — held** |
| `docs/sessions/185-…` | this document | committed at close-out |

## Files modified

| file | change | state |
|---|---|---|
| `packages/domain/src/redaction/redact.ts` | `redactAllowlistedValue`: four arms; the type gate no longer waived by a successful scrub | **committed** `7cb304ff` |
| `packages/domain/src/redaction/redaction-rules.ts` | `FIELD_VOCABULARY` table + derived `hasFieldVocabulary` (committed); **plus `GOOGLE_API_KEY` + the `AIza` scrub alternative + fences (UNCOMMITTED, held)** | **split** |
| `packages/domain/test/redaction/redact.test.ts` | two property pins SPLIT (safety assertion untouched; marker assertion its own pin) | **committed** `7cb304ff` |
| `packages/domain/test/redaction/marker-filler-property.test.ts` | `GOOGLE_API_KEY` exemplars | ⛔ **UNCOMMITTED — held** |
| `packages/domain/test/redaction/net-list-integrity.test.ts` | net count 3→4 + membership + `L216` notes | ⛔ **UNCOMMITTED — held** |

⛔ **NOTHING ELSE.** No `packages/policy` / `providers` / `integrations` / `knowledge` / `apps/worker`. No `IMPLEMENTATION_PLAN.md`, `ARCHITECTURE.md`, `packages/contracts/**`, `LESSONS.md`, `docs/briefs/`.

## TDD compliance — ⛔ CLEAN ON BOTH SLICES' CORE, WITH THREE NAMED DEVIATIONS

✅ **`### 24.118` step 1 — RED FIRST.** 6 pins written, run, **5 failed / 1 passed**, then implemented.
✅ **`### 24.132` — RED FIRST.** 10 pins written, run, **3 failed / 7 passed** (the 7 are controls pinning unchanged behaviour), then implemented.

⛔ **DEVIATION 1 — `field-vocabulary-derivation.test.ts` was written AFTER the `switch`→table refactor**, because the refactor was required by the orchestrator's derivation ADD and the pins describe its result. ⭐ **Mitigation, and it is stronger than red-first for a refactor: behaviour-identity was PROVEN by differential against BOTH implementations** (the `switch` restored from HEAD), agreeing on two independent statistics over 1,156 cells. **Mutation-proven afterwards (M2, M3).**
⛔ **DEVIATION 2 — the open-leak pin (`ff070bee`) asserts EXISTING behaviour by construction.** It is a characterization pin discharging an owner condition, not a red-first pin; it could not have been red before the code existed. **Mutation-proven in the only direction that matters — "fixing" the residual reds exactly it.**
⛔ **DEVIATION 3 — the two marker-semantics assertions in `redact.test.ts` were updated after the implementation**, on the lead's explicit ruling (iii). **The safety assertions they were split from are untouched and were never red.**

## Cross-doc invariant audit — CLEAN

`git diff 46ef6c03..HEAD -- packages/contracts/src` is **empty** for the whole round; **no model gained, lost or renamed a field.** `ARCHITECTURE.md` untouched in tree and by me. ⚠ **Two new exported symbols on a rule-7 module surface (`hasFieldVocabulary`, and `GOOGLE_API_KEY` when the held slice lands) — not models, so not table-eligible; flagged at Step 9 and acknowledged.**

## Reachability

| symbol | reachable from | status |
|---|---|---|
| `redactAllowlistedValue` (changed) | `redactRecord` → `apps/worker/src/observability/logger.ts:14` (**the production log sink**) · `apps/worker/src/composition/reconcileScheduler.ts:30` via `redactError` | ✅ **production-reachable, MEASURED** |
| `hasFieldVocabulary` (new) | `redactAllowlistedValue` (same module) + its guard | ✅ reachable through the above |
| `FIELD_VOCABULARY` (new, private) | `isSafeFieldValue` + `hasFieldVocabulary` | ✅ not exported — deliberately minimal |
| `GOOGLE_API_KEY` (held) | `looksUnsafe` via `CREDENTIAL_NETS`; `CREDENTIAL_TOKEN` also consumed by `packages/providers` **which already imports from `@sow/domain`** | ⛔ **held, uncommitted** |

⚠ **PRE-EXISTING, NOT INTRODUCED: `@sow/domain`'s `isRedactionSafe` and `packages/providers`' `isProviderLogSafe` still have ZERO production callers** (`### 24.126`). **"Unreachable is not a licence to delete" binds.**

## Open follow-ups

1. ⛔ **`### 24.118` step 1 — HELD, uncommitted, in the tree.** Lead ruled **option 2**: *the owner accepted a leak AS IT IS; enlarging it is a NEW decision their acceptance does not cover.* **Do not commit, do not revert.**
2. ⛔ **`### 24.132`'s residual — OWNER-DECIDED, unbuilt.** `errorMessage`/`errorStack` keep today's behaviour; the leak is pinned OPEN with its reason and an expiry recorded at the arming-ledger head.
3. ⭐ **The six vocabulary-less non-prose fields are cheaply closable — measured, cost provably zero on every non-leaking input (§20).** **Orchestrator to scope; NOT built here.**
4. **`### 24.138`** — the `apps/worker` logger marker-semantics red. **Incidental, attributed, worker's territory.** Recommended remedy: the same split ruled here.
5. **`### 24.129`** — `URL_CREDENTIAL_PARAM` structurally unpromotable ⇒ **`### 24.118` step 2 cannot fully delegate in ANY order** and needs re-scoping to a partial delegation.
6. **`### 24.117`** — NOT started; **re-scope before dispatch**, because F1 makes contracts' copy a fourth divergent set.
7. **`### 24.133`** — `packages/policy`'s third copy on the sole-writer path, with a parity pin blind to `AIza`. **Providers' file; not touched.**
8. **`### 24.122`** — the literal `ok` appeared from `git commit` and `pnpm install` this session, and **`git commit` printed NORMALLY on a later invocation** ⇒ per-invocation, not per-tool.

## `/preflight` — ⛔ RED, MEASURED AND ATTRIBUTED. NOT REPORTED AS A PASS.

| step | result | attribution |
|---|---|---|
| 1 `pnpm install` | completed | ⚠ **printed the literal `ok` and nothing else** — `### 24.122`. Operation verified correct by every later command resolving deps normally. |
| 2 `pnpm lint` | ✅ **11/11 successful, `0 cached`** | ⭐ **NOTABLE — the standing Carry-forward `(0)` claim (`Command "eslint" not found`) DOES NOT REPRODUCE, on a `--force` run with zero cache hits.** **Corroborates providers' counter-observation at `### 24.110` Step 9, independently and on a different day.** ⛔ **Recorded as a datum, NOT as a closure — whoever closes that item must reconcile BOTH observations (its own standing instruction).** |
| 3 `pnpm format:check` | ⛔ **ABSENT** — `Did you mean "pnpm typecheck"?` | **The script is not defined in any package.** ⛔ **A gate step that cannot run has not passed** (worker's finding). Pre-existing, filed. |
| 4 `pnpm typecheck` | ✅ **20/20, `0 cached`** | forced, nothing replayed |
| 5 `pnpm test` | ⛔ **FAIL — exactly 1 test of 2,164 in `@sow/worker`; 19/20 tasks, `0 cached`** | **`apps/worker/test/observability/logger.test.ts` — the marker-semantics pin, `### 24.138`.** ⭐ **CAUSED BY MY LANDING AND FILED WITH ITS CAUSE NAMED.** ⛔ **Incidental, not designed — the lead's distinction: `### 24.128`'s red has an author watching it, this one does not.** **Remedy is the same split ruled for the two domain pins; worker's territory, untouched.** |

⭐ **The `--continue` form is load-bearing in step 5: without it turbo cancels dependents and the totals read as a multi-package failure** (`### 24.122`; measured earlier this session as a spurious `13 successful, 16 total`).

**⇒ PREFLIGHT VERDICT: RED.** **Step 3 is a pre-existing absent gate. Step 5 is ONE test, caused by this session, filed, attributed, leak-free (the credential still never reaches the sink — only the marker moved), and in another area's territory.** `@sow/domain` itself is **367/367** with the held slice in tree and **353/353** without it, on two runners plus a forced `turbo typecheck`.
