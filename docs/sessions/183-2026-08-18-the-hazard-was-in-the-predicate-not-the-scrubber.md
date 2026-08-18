# Session 183 — the hazard was in the predicate, not the scrubber

**Date:** 2026-08-18 · **Role:** contract-implementer · **Track:** main (single-track, root checkout)
**Predecessor:** `docs/team-handoffs/029-2026-08-17-the-round-that-wrote-itself-down-as-it-went.md`
**Brief:** `docs/briefs/299-24.120-stripmarkers-span-destruction.md` · **Task:** `### 24.120`
**Status:** ⛔ **MEASURE-AND-ROUTE COMPLETE. NO CODE SHIPPED, DELIBERATELY.** The design call is stated below with its measurements and is routed — it is not made here.

> ⛔ **WHY THIS FILE EXISTS BEFORE THE STEP-2.5 MESSAGE:** `029`'s structural finding — twice in one evening a durable statement was produced inside a `SendMessage` and survived only by luck. **The measurement lives here; the message points at it.**

---

## 1 — WHAT WAS MEASURED, AND WITH WHAT

All figures below come from a **scratch vitest harness** built inside `packages/domain/test/`, importing the **real exported regexes and functions** (`CREDENTIAL_PREFIX`, `SENSITIVE_KEYWORD`, `URL_USERINFO_CREDENTIAL`, `PEM_BLOCK`, `URL_USERINFO_SEGMENT`, `CREDENTIAL_TOKEN`, `looksUnsafe`, `isRedactionSafe`, `redactString`) — ⭐ **never re-typed patterns**, because a transcription would have measured my own copy rather than the code.

**Five scratch files, used and DELETED.** Reported per `029`'s rule: *build the control, use it, report it, delete it — and say in the report that it existed and what it established.* Tree verified clean after deletion (`git diff HEAD --stat` empty, `git ls-files --others --exclude-standard` empty).

**Two-surface green after cleanup** (`029` rule: no measurement stands on one surface): `./node_modules/.bin/vitest run` → **18 files / 308 tests passed**; `pnpm --filter @sow/domain test` → **18 files / 308 tests passed.**

⚠ **Instrument note:** `grep` output was malformed once during the census (`7 matches in 3 files` with impossible line numbers), consistent with the standing trap. **Every census below was re-read at source with `sed` before being reported**, and each ran with a **positive control** (a token that must hit) and a **negative control** (a nonsense token that must not).

---

## 2 — THE FINDING REPRODUCES, AND IT IS WIDER THAN FILED

`### 24.120` and brief `299` both use `[REDACTED:raw]`, chosen so only one mechanism fires. **Measured: all THREE frozen markers destroy the span identically** — `REDACTED_RAW`, `REDACTED_CREDENTIAL`, `REDACTED_FIELD`. The property is not raw-specific; it belongs to `stripMarkers`' substitution character, not to any one marker's text.

| input | `looksUnsafe` today | reading |
|---|---|---|
| `//u:p<RAW>q@h` | **safe** | the entry's case, reproduced |
| `//user:REALSECRET<RAW>@host` | **safe** | a real secret, un-refused |
| `//user:REALSECRET@host` | unsafe | ⭐ **CONTROL — same span, no marker** |
| `//u:p<CREDENTIAL>q@h` | **safe** | ⛔ **NEW — not in the entry** |
| `//u:p<FIELD>q@h` | **safe** | ⛔ **NEW — not in the entry** |

---

## 3 — ⭐⭐ THE STRUCTURAL RESULT: EXACTLY ONE OF THE THREE NETS IS AFFECTED, AND THE REASON IS CHECKABLE

This replaces case-enumeration with an argument that holds over all inputs. **A space substitution can only change a verdict where a marker sits INSIDE a would-be match and the pattern's class at that position excludes whitespace.**

- **`CREDENTIAL_PREFIX`** — every alternative (`sk-[a-z0-9]`, `sk_(live|test)`, `xox[baprs]-`, `gh[pousr]_`, `AKIA[0-9A-Z]{16}`, `-----BEGIN`, `eyJ[A-Za-z0-9_-]{10,}\.`) is a contiguous literal/class run admitting **no `[`**. A marker literal begins with `[`, so a marker inside already breaks the match **before** stripping. ⇒ **verdict identical stripped or not.** Measured on `sk-<RAW>abc`, `-----BE<RAW>GIN RSA`, `eyJabcdefghijk<RAW>.sig` — safe under both.
- **`SENSITIVE_KEYWORD`** — `\b(…)\b` over word runs. A marker inside breaks it both ways; a marker adjacent leaves `\b` satisfied both ways (`[`/`]` are non-word, and so is a space). ⇒ **stripping never destroys a keyword match.** ⭐ It can only ADD one: `private<RAW>key` → `private key` matches `private[_ -]?key`. **Fail-safe direction.**
- **`URL_USERINFO_CREDENTIAL`** — `/\/\/[^/\s:@]+:[^/\s@]+@/`. The second class **`[^/\s@]+` admits `[`, `]` and `:`** — it is the only class in the three nets that lets a marker sit inside a real match — **and whitespace is exactly what it excludes.** ⇒ **the unique hazard, by construction.**

⇒ ⭐ **The defect is not "stripping is unsafe." It is that ONE net's permissive class overlaps the marker's alphabet while excluding the substitute.** That is what makes the remedy space small and decidable.

---

## 4 — ⭐⭐ THE HAZARD IS IN THE PREDICATE, NOT IN THE SCRUBBER — 489 CASES, WITH A SENSITIVITY CONTROL

`### 24.120` names `redact.ts:66,83` as inheritors. **Measured: `:66` (`isRedactionSafe`) carries the hazard; `:83` (`redactString`'s post-scrub re-check) does NOT.**

**Method:** insert every frozen marker at every position of six userinfo carriers — **489 constructed cases** — and ask two different questions of the same inputs.

| question | result |
|---|---|
| does `redactString` ever EMIT surviving secret material? | ⭐ **0 / 489** |
| does `isRedactionSafe` call a raw-userinfo-bearing input SAFE? | ⛔ **111 / 489** |

⭐⭐ **The search is provably non-vacuous, and it satisfies `029`'s concordance rule — the two methods COULD have disagreed and DID.** A zero from the scrubber beside a zero from the predicate would have proven only that the harness was inert.

**Why the scrubber is immune, and it is structural rather than lucky:** `URL_USERINFO_SEGMENT` and `URL_USERINFO_CREDENTIAL` are the **same pattern** (identical but for a capture group and `/g`), and the scrubber applies it to the **UNSTRIPPED** value **before** the re-check runs. ⇒ **any userinfo the detector could catch has already been replaced.** The re-check can never be the thing that had to catch it.

⇒ **`### 24.120`'s `redact.ts:66,83` pairing is half right and should be narrowed to `:66`.** ⚠ Same correction applies to `provider-log-redaction.ts:68`.

---

## 5 — ⛔⛔ REACHABILITY RE-MEASURED: BRIEF `299`'s WIRING LINE IS FALSE AT HEAD

Brief `299` states: *"`isRedactionSafe` is the sole-writer gate's predicate via `@sow/knowledge`'s `secret-scan.ts`"* and *"Reachability is established and NOT in question"* — while also instructing **"Confirm at HEAD anyway."** ⭐ **Confirming is what found it.**

**Measured at source:** `packages/knowledge/src/knowledge-writer/secret-scan.ts` imports `isRedactionSafe` from **`@sow/policy`**, not `@sow/domain`. `packages/policy`'s `looksUnsafe` **does not call `stripMarkers`** — its own fence block says so and names `### 24.120` as owner. ⇒ ***the sole-writer path does NOT inherit this hazard today.*** This agrees with `### 24.110`'s own text (*"`secret-scan.ts` → policy's `isRedactionSafe` does NOT strip today; post-(B) it would"*); the brief compressed two different `isRedactionSafe` symbols into one.

**Consumer census of the stripping composition (positive + negative controls run, every hit re-read at source):**

| site | status |
|---|---|
| `packages/domain` `isRedactionSafe` | ⛔ **ZERO production callers** — tests only |
| `packages/providers` `isProviderLogSafe` | ⛔ **ZERO production callers** — tests only |
| `packages/domain` `redactString` re-check | production-reachable, but **structurally inert** (§4) |
| `packages/providers` `redactString` re-check | same |
| `packages/policy`, `packages/knowledge`, `apps/worker` | ⭐ **do not consume it** — they use `@sow/policy`'s copy |

⇒ ⭐⭐ ***THE HAZARD HAS NO PRODUCTION CONSUMER TODAY. IT IS UNREACHABLE PRECISELY BECAUSE THE CONSOLIDATION EVERYONE AGREES IS CORRECT HAS NOT HAPPENED YET — and every filed task in this family (`### 24.110` (B), `### 24.118`, `### 24.124`) moves toward giving it one.***

⛔ **THIS CHANGES DISPOSITION, NEVER ROUTING** (standing lead ruling, `route on KIND`). It is rule 7; it routes. ⛔ **And it is NOT a licence to close, delete, or downgrade** — the lead's pre-positioned ruling on `### 24.55` binds here by shape.

---

## 6 — THE FOUR OPTIONS, MEASURED

⭐ **(A) and (B) are REFUTED, and not marginally. The reason is one the brief did not have: THE SCRUBBER IS ITSELF A MARKER PRODUCER**, so its re-check never sees an unstripped string in normal operation. Un-stripping the re-check makes `redactString`'s own output trip its own net.

**`redactString("endpoint //user:hunter2@db.example.com is down")` — the designed happy path, run under each option:**

| option | result |
|---|---|
| **today** | `"endpoint //[REDACTED:credential]@db.example.com is down"` ✅ scrubbed, host preserved |
| **(A) test stripped OR unstripped** | ⛔ **`"[REDACTED:field-dropped]"` — whole line destroyed** |
| **(B) per-net stripping** | ⛔ **`"[REDACTED:field-dropped]"` — whole line destroyed** |
| **(C) inert filler** | `"endpoint //[REDACTED:credential]@db.example.com is down"` ✅ unchanged |

⇒ ⛔ **Under (A) or (B), EVERY successfully-scrubbed URL credential drops its whole field**, and under (A) every scrubbed API-key line does too — defeating the module's stated contract (*"preserving the surrounding non-sensitive text"*). **That is `### 24.123`'s failure mode, caused rather than found.**

**(C) — replace the marker with an INERT filler.** Measured over **654 tracked `.md` files / 89,451 lines** (proxy corpus, same family `### 24.110` used):

- **newly UNSAFE vs today: 3 lines.** ⚠ **All three are `IMPLEMENTATION_PLAN.md` and brief `299` — the documents describing this bug.** **State the bias: the corpus over-represents this exact discussion; it is not evidence about a user's vault.**
- **newly SAFE vs today: 0** ⇒ ⭐ **MONOTONE — no value refused before is admitted now.** That is precisely the argument that made `### 24.110` shippable.
- **`redactString` output identical to today on all six fixtures** ⇒ no availability regression on the scrub path.
- (A) costs 6 lines, (B) costs 5, on the same corpus.

**(D) — document only.** Zero code risk. Cost: the canonical classifier keeps a known hole, and **`### 24.110`'s delegation half stays blocked indefinitely**, which also stalls `### 24.118`'s promote-then-delegate ladder.

---

## 7 — ⛔ (C)'s REAL COST IS NOT THE 3 LINES — IT IS A STANDING INVARIANT WITH NO GUARD

A filler is only inert **against today's pattern set**. **Measured filler table (HIT = the filler bridges two halves a marker had separated):**

| filler | verdict |
|---|---|
| `-` | ⛔ **DISQUALIFIED** — bridges `sk-`, `-----BEGIN`, `eyJ…\.` |
| `_` | ⛔ **DISQUALIFIED** — bridges `eyJ…\.` |
| `.` | ⛔ **DISQUALIFIED** — bridges `eyJ…\.` |
| `""` (delete) | ⛔ **DISQUALIFIED TWICE** — bridges `-----BEGIN` and `eyJ…\.`, **and destroys `\b` keyword boundaries** (`my<RAW>password` stops matching) |
| `" "` (today) | ⛔ the defect — breaks `[^/\s@]+` |
| `*` `#` `!` `~` `%` `^` `?` `+` | ✅ satisfy every probe |

**The criterion, stated so it can be checked rather than remembered:** the filler must be **(i)** absent from every pattern's literal and character-class alphabet (else it BRIDGES), **(ii)** a non-word character (else it destroys `\b`), **(iii)** not whitespace (else it breaks `[^/\s@]+`).

⛔⛔ **AND THE COUPLING THE BRIEF ASKED ABOUT, MEASURED:** `### 24.118` step 1 promotes `AIza[0-9A-Za-z_-]{10,}` into domain. **`-` and `_` are both members of that class** ⇒ had either been chosen as the filler, `### 24.118` step 1 would have **silently armed a bridge, and nothing would red.**
⭐ **Good news, measured rather than assumed: the currently-qualifying set survives BOTH queued edits** — no qualifying filler bridges `AIza…`, and `\bsk-` behaves identically under a filler and under today's space.
⇒ ⛔ **But the invariant is real and undefended: a future pattern widening can retro-actively disqualify the chosen filler, and no test would notice.** ***(C) is not a one-line change — it installs a constraint on every future edit to `redaction-rules.ts` and therefore needs its own guard.*** ⭐ **This is `### 24.118`'s general rule inverted: delegation silently DISCARDS a capability; a filler silently ACQUIRES a bridge.**

---

## 8 — THE ROUTING

⛔ **I am not picking.** The measurement **refutes (A) and (B)** and leaves a genuine two-way call:

- **(C)** — monotone, measured cost 3 corpus lines (all self-referential), fixes the canonical classifier and unblocks `### 24.110` (B); **requires a new guard** on the filler invariant, else it rots the way `### 24.110`'s two copies did.
- **(D)** — no code risk; leaves a known hole in the canonical classifier and **blocks the consolidation direction the project has already chosen** across three filed tasks.

⚠ **What makes it a real call rather than an obvious one:** (C) is safe *today* and its ongoing correctness depends on a discipline no instrument enforces. **Every argument for (C) is an argument about the present tense**, and this ledger's own record is that present-tense safety arguments are the ones that go stale silently.

⛔ **Rule 7 ⇒ Step 9 auto-routes to the lead. Routed through `main-orchestrator`, not decided here.**

---

## 9 — SIDE FINDINGS (flagged, NOT fixed — none are `### 24.120`)

1. ⚠ **`isProviderLogSafe` is an exported rule-7 safety predicate with ZERO production callers.** `### 24.55`'s family — a control with no live carrier. ⛔ **Flagged only; "unreachable is not a licence to delete" binds.**
2. ⚠ **`packages/providers`' `redactString` scrubs to a LOCAL marker `[REDACTED]`**, which is **not** one of the three frozen literals `stripMarkers` neutralizes — a **fourth marker vocabulary**. Benign today (it carries no sensitive keyword), but it is a **composition** divergence, which is exactly the half `### 24.118`'s delegation rule says a patterns-only check would miss.
3. ⚠ **Brief `299`'s wiring line should be corrected, not deleted** (`L194`) — it is the only artifact naming the intended predicate relationship, and it names the right relationship one package too low.
4. ⚠ **`### 24.120`'s title says "two live inheritors already."** Measured, that is an **import** census, not a **reachability** one: of the four cited sites, two are dead exports and two are structurally inert.

---

## 10 — SCOPE HELD

⛔ **Nothing outside `### 24.120` was touched.** No edits to `### 24.118` / `### 24.124`'s domain legs (their meaning could move on this answer — the sequencing reason this slice went first). No edits in `packages/policy`, `packages/providers`, `packages/integrations`, `packages/knowledge`. **No commits to `IMPLEMENTATION_PLAN.md`** — hook-enforced against implementer writes; the tracker text above is for the orchestrator to land.

---

## 11 — ⛔⛔ APPENDED AFTER `963d8eeb` LANDED ON THIS ENTRY MID-SLICE: MY §5 IS **NOT** THE RETRACTED ARGUMENT, AND MUST NOT BE READ AS RETIRING IT

While this slice ran, the orchestrator filed a ruling **onto `### 24.120`**: *the low-reachability argument is UNMEASURED and this entry must not close on it* — providers-integrations' final act before termination, retracting a **credit** rather than a claim, because *"flagging it as reasoning did not make it measured, and the praise is what makes it look checked."*

⛔ **I have to state plainly that §5 of this document is the single most likely artifact to be misused against that ruling**, so the separation goes here rather than being left to a reader:

| claim | status |
|---|---|
| **(i) CALL-GRAPH** — which code paths consume the stripping composition | ✅ **MEASURED HERE** (source-read census, positive + negative controls) |
| **(ii) INPUT DISTRIBUTION** — whether a frozen marker ever lands inside a userinfo span in real content | ⛔ **UNMEASURED. I DID NOT MEASURE IT.** The retraction stands untouched by anything above. |

⇒ ⛔⛔ ***THE DANGEROUS READ IS "contract measured reachability, so the rarity argument is now checked." IT IS NOT.*** **§5 bounds WHO could be affected; it says nothing about HOW OFTEN the triggering input occurs. A severity claim needs both, and only one exists.**

⭐⭐ **AND THE DIRECTION IS THE OPPOSITE OF REASSURING — this is the part worth carrying: §5 makes the UNMEASURED argument MORE load-bearing, not less.** Today the consumer set is empty, so the input distribution does not matter. ***The moment `### 24.110`'s delegation lands, the consumer set becomes non-empty and the ONLY remaining bound on severity is exactly the unmeasured rarity argument.*** ⇒ **the retraction's importance is scheduled to arrive at the same moment the fix is.**

⚠ **The finder's formulation, honoured here because it is the operative part: *the flag only holds while the word "unmeasured" travels with it.*** **The word is now on this document too.**

---

## 12 — INSTRUMENT REPORT (shared tooling — routed to `### 24.122`, NOT chased)

⭐⭐ **1 — I NEARLY FILED A FALSE ANOMALY, AND THE CHECK THAT STOPPED IT COST 30 SECONDS.** `git diff <base>..HEAD -- IMPLEMENTATION_PLAN.md | grep -c '24\.120'` returned **0** on a delta whose first commit subject is *about* `24.120`. With four recorded `git` anomalies fresh in context, my first reading was fabrication.
⛔ **It was not. `grep`, `awk` and `sed` all three returned 0 independently; the positive control on the same stream returned 2.** ⇒ **the added lines refer to the task as *"THIS ENTRY"* and never spell `24.120`.** ⭐ ***A token census blind to its own subject*** — the class already logged four times this round, arriving inside the instrument-distrust discipline itself. **`L202` exactly: a strong hypothesis makes false positives cheaper to accept, and mine was one check away from being confirmed.**

⛔⛔ **2 — ANOMALY 3 + 4 REPRODUCED CROSS-SESSION, AND THEY ARE ONE BEHAVIOUR WITH A DISCRIMINATOR.** `029` recorded that the doubled-diff *"would not reproduce across four clean probes in another session."* **It reproduces here — deterministically — and the reason the probes disagreed is that the flag set differed.** Controlled A/B, same commit, same path, same `-U0`, ground truth `--numstat` = **5 insertions**:

| form | body emission | header |
|---|---|---|
| `git show <rev> -U0 -- <path>` | ⛔ **3× (3/3 trials, deterministic)** | ⛔ carries subject + author + **relative date** |
| `git show <rev> -U0 --format='%h' -- <path>` | ✅ **1×** | ✅ clean |

⇒ ⭐⭐ ***AN EXPLICIT `--format` SUPPRESSES BOTH THE INJECTED HEADER AND THE BODY DUPLICATION*** — so anomalies 3 and 4 are **one** behaviour (the header-rewriting path re-emits the body), it is **deterministic rather than intermittent on a given flag set**, and `### 24.122` gains a **workaround with a reason** rather than only a warning.
⚠ **BOUND, STATED SO IT IS NOT OVER-READ: one commit, one path, `-U0`. This explains anomalies 3 and 4 ONLY. It does NOT explain 1 (`status --porcelain`), 5 (bare `git log`) or 6 (`commit`) — none of which involve `--format`.**

⚠ **3 — ANOMALY 6 REPRODUCED IN THIS SESSION:** `git commit -F … -- <path>` printed **`ok 1 file changed, 162 insertions(+)`** then a bare **`ok`** — the `[main <hash>] <subject>` line replaced by the literal `ok`. **Operation verified correct independently of its own output** (`fd6fe971`, exactly 1 path, 162 insertions, tree clean after). ⭐ **Corroborates `### 24.122`'s "rare and per-invocation" counter-datum with a second actor.**

⚠ **4 — `grep` emitted the malformed summary form twice** (`7 matches in 3 files` / `1 matches in 1 files` with impossible line numbers). **Content was correct both times; only the summary line was non-standard.** ⛔ **Every census in this document was re-read at source with `sed` before being reported.**

⛔ **`git commit`'s pathspec-only form CANNOT commit a NEW file** — `error: pathspec … did not match any file(s) known to git`. The safe sequence for a new path is `git add <one path>` then `git commit -F <msg> -- <same path>`; the pathspec still scopes the commit, so the index is not consulted at commit time. **Verified: 1 path in the resulting commit, 0 foreign.** ⚠ Worth stating because `029`'s rule reads as *"never `git add`"* and for a new file that is not achievable.

---

## 13 — ⭐⭐ I MEASURED THE RETRACTED ARGUMENT RATHER THAN INHERITING IT — AND ITS PREMISE IS TRUE WHILE ITS CONCLUSION IS FALSE

**The argument (`963d8eeb`):** *frozen SoW redaction markers are LOGGER-EMITTED and would not normally appear in vault content reaching the KnowledgeWriter, so a marker landing inside a userinfo span is rare.*

**Decomposed into two halves that can be measured separately — which is what nobody had done:**

**H1 — the PRODUCER half. ✅ CONFIRMED.** Non-test emitters of a frozen marker, censused with positive + negative controls and re-read at source: `packages/contracts/.../log-record.ts` (the definitions), `packages/domain`'s two redaction modules, and `apps/worker/.../systemHealth.ts`. **All four are diagnostic / redaction paths. No producer writes a marker onto a vault-content path.** The premise is TRUE.

**H2 — the CONTENT half. ⛔ REFUTED, MEASURED.** Vault content does not come from our producers — it comes from a human and from ingested sources, so H1 does not constrain it. Measured over **656 tracked `.md`**: **19 marker-bearing lines across 6 files**, of which ⛔ **8 lines exhibit the EXACT triggering condition — a marker breaking a real `URL_USERINFO_CREDENTIAL` span** (`IMPLEMENTATION_PLAN.md` ×3, brief `299` ×3, session docs `181` and `182`).

⇒ ⭐⭐ ***THE PREMISE IS TRUE AND THE CONCLUSION DOES NOT FOLLOW FROM IT, BECAUSE THE TWO POPULATIONS ARE NOT DISJOINT.*** **A SoW vault is a second brain for engineering work: a pasted log excerpt, an incident note, a design discussion IS logger-emitted content arriving as vault content.** ⛔ ***"Markers are logger-emitted" CONNECTS the two populations rather than separating them — it is the reason the co-occurrence happens, not the reason it does not.***

⛔⛔ **AND THE COUNT IS NOT STATIC — IT GREW FROM 3 TO 8 IN FIFTEEN MINUTES OF THIS SESSION**, as the tracker entry, the brief, two session docs and this document were written. ⇒ ⭐⭐ ***THE POPULATION OF TRIGGERING LINES IS GROWING MONOTONICALLY, AND EVERY NEW INSTANCE IS CREATED BY THE TEAM DOCUMENTING THIS DEFECT.*** **A team that writes down a credential-redaction defect generates the defect's own triggering input as a by-product.**

⛔⛔ **STATE WHAT THIS DOES AND DOES NOT ESTABLISH — the temptation now runs the OTHER way, and over-claiming here would repeat the error in mirror:**
- ✅ **ESTABLISHED: the co-occurrence the argument called RARE is ORDINARY.** It arises in ordinary human-authored engineering Markdown, with no adversary and no logger writing to a vault. **That is a class-existence result and it is enough to deny the argument its severity conclusion.**
- ⛔ **NOT ESTABLISHED: that any REAL secret has ever co-occurred with a marker.** All 8 instances are constructed examples inside prose. **They are CARRIERS OF THE PATTERN, NOT LEAKS.** That claim remains unmeasured, and no vault content was read (owner-gated, `### 24.110`).
- ⚠ **BIAS, STATED BECAUSE IT IS LARGE: this corpus is SELF-REFERENTIAL. All 8 exist because we are documenting this bug.** It is **not** a base rate for an arbitrary vault. ⭐ **What it is, is a demonstration that the pattern needs no exotic input — and the self-reference is itself the finding, not merely a caveat.**

⇒ ⛔ **DISPOSITION CONSEQUENCE: the low-reachability argument may no longer be used to grade this low-severity, and it is now refuted rather than merely unmeasured.** ⭐ **The finder's retraction was right for a reason even they did not have: the argument does not fail for want of measurement, it fails on its own premise.**

---

## 14 — ⛔⛔ A DEFECT IN *THIS DOCUMENT*, CAUGHT BY RE-MEASURING BEFORE ROUTING IT: §6's `3` AND §13's `8` ARE **DIFFERENT METRICS**, AND I READ THEM AS THE SAME ONE

**On reviewing the landed tracker corrections I saw `(C)` costed at *3 lines of 89,451* while §13 of this document said *8*, and I was one message from routing "the lead's decision input is understated 2.6× and growing."** ⛔ **It is not. Both numbers are mine, both are correct, and they measure different quantities.**

| metric | definition | value at HEAD |
|---|---|---|
| **(C)'s COST** (§6, the tracker's figure) | lines where **no net** trips today but **some net** trips under an inert filler — i.e. **newly REFUSED** | **4** (was 3; corpus grew 654→656) |
| **TRIGGERING CONDITION** (§13, the H2 refutation) | lines where **`URL_USERINFO_CREDENTIAL` specifically** is broken by a marker, **regardless of whether another net already flags the line** | **8** |

⇒ ⭐ **The gap is not drift — it is that 4 of the 8 triggering lines are ALREADY UNSAFE TODAY VIA ANOTHER NET**, because prose discussing credential redaction contains the words *credential* / *secret* / *password*. **`SENSITIVE_KEYWORD` incidentally covers half the triggering population.** ⚠ **That is real defence-in-depth and it softens H2's practical bite — stated because it cuts against my own §13 and would have been convenient to omit.**

⛔⛔ **THE MECHANISM, AND IT IS `L190` ARRIVING IN MY OWN WORK: TWO CORRECT NUMBERS FROM THE SAME PREDICATE FAMILY, MEASURED MINUTES APART, READ AS ONE QUANTITY BECAUSE THE SECOND WAS BIGGER AND I HAD A STORY FOR WHY IT WOULD GROW.** ***Re-derivation cannot catch this class, because neither number was ever wrong.*** ⭐ **What caught it was re-running the EXACT metric the tracker quotes rather than comparing two remembered figures.**

⛔ **AND IT IS THE CLASS THIS AREA ALREADY OWNS — `029`: *two of contract's defects were introduced AS CORRECTIONS.*** ***A correction carries its own endorsement and reads as already-vetted*** — and this one was aimed at a decision input sitting in front of the lead, which is the worst available target.

⭐ **The growth claim in §13 survives and shrinks: the triggering population did grow 3→8 during the session, but the (C) COST grew only 3→4.** ⇒ **"(C)'s cost grows as we document the defect" is TRUE BUT SMALL, and I stated it larger than it is.** ⚠ **§13's 8 stands as the H2 class-existence result; it was never a cost figure and must not be read as one.**
