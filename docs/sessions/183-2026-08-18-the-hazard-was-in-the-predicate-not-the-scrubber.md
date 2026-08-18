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
