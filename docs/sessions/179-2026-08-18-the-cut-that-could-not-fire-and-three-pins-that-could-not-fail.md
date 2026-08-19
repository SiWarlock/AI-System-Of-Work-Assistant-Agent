# Session 179 — the cut that could not fire, and three pins that could not fail

**Date:** 2026-08-18 · **Phase:** 24 (hardening tail) · **Area:** `packages/knowledge` (`knowledge-implementer`, single-track `main`)
**Predecessor:** this area's prior session — `175-2026-08-18-two-audit-paths-and-five-sentences-that-were-false.md`
**Successor:** `187-2026-08-18-two-guards-and-the-absence-i-measured-wrong.md`
**Task:** `### 24.103` · **Brief:** `docs/briefs/295-24.103-validation-refusal-shape-merge.md`
**Commits:** `ca8dc207` (workflows fixtures) · `cbf1c4f3` (the slice) · `324a068d` (review fixes)
**Session-doc number `179` was ASSIGNED by the orchestrator** from committed history, not computed here — see `178`'s banner for why that rule now exists.

---

## Why this session existed

`### 24.103`: four candidate-data gates each minted a structurally identical `{code, stage, issues}` refusal on their **own local union**, with no `AuditSignal`. `### 24.98` had made `audit` required on the GCL union, so `tsc` enumerated *that* union's construction sites — **and stopped dead at the union boundary.** A duplicated shape was invisible to exactly the instrument that secured the original.

The approved remedy was ***merge the SHAPE, not the unions***: one issue-carrying type that REQUIRES an `audit`, each union keeping its own vocabulary. That restores the enumeration at the boundary that defeated it, and makes the hazard unrepresentable at every site rather than patched at one.

⭐ **The hazard is BUILD-TIME, not a runtime leak** (`### 24.105` traced it and found none): the risk is that whoever adds the missing signal **reaches for `issues`, because that is what is sitting there** — and `issues[].message` is validator-authored and measured to echo row content.

---

## What was built

### Files created
- **`packages/knowledge/src/audit/validation-refusal.ts`** — the shared shape. `RefusalIssue`, `IssueCarryingRefusal` (`issues` + REQUIRED `audit`), the closed `CandidateSchemaId` union, `FREE_FORM_KEY_REGIONS` (the derived per-schema region table), `structuralPathOnly(path, schemaId)`, `MAXIMAL_CUT`, `buildRefusalSignal(...)`.
- **`packages/knowledge/test/validation-refusal-audit.test.ts`** — 23 pins.

### Files modified
- **`src/knowledge-writer/writer.ts`** — ⛔ rule-1 surface. `SchemaRejected` extends the shared shape; `runGate`'s three sites build a signal. `kwSchemaRejectedSignal` exported `@internal` for pinning.
- **`src/gbrain/remediation/router.ts`** — `RemediationError.plan_invalid` (3 sites); `planInvalidSignal` exported `@internal`.
- **`src/gbrain/remediation/generative-proposal-intake.ts`** — `IntakeError.schema_rejected` (2 sites) **and `plan_invalid`** (the member the task entry never named — and which spans a *different candidate schema*).
- **`src/knowledge-writer/provenance-stamp.ts`** — `StampInvalid` (1 site).
- **`src/gcl/visibility-gate.ts`** — the control, re-expressed onto the shared module; orphaned `MAX_ISSUE_PATH_REFS` + `buildAuditSignal` import removed.
- **`packages/workflows/test/{commit-knowledge-map-write-failure,meeting-activities}.test.ts`** — two fixtures supplying the now-required field (`L121`; own commit).

---

## Decisions made

1. **Regions are keyed by CANDIDATE SCHEMA, not by channel.** The brief said per-channel; that is wrong **by construction** — `writer.ts` and `router.ts` validate the same schema and share a set, while `generative-proposal-intake.ts` spans **two** schemas across its three sites. Orchestrator accepted the correction.
2. **`structuralPathOnly` takes a schema ID, not a region array.** The array form let a caller supply regions **without ever consulting the table** — the hole itself, one level below the guard that was requested for it.
3. **Fail closed on an unknown id via `MAXIMAL_CUT`, never a throw.** `applyPlan`'s gate call sits outside its two `try` blocks, so a throw would escape uncaught on the **sole-writer path** and fold to an undiscriminated `commit_failed` — strictly worse than the bug being fixed.
4. **Unions are NOT merged.** Merging the shape restores enumeration; merging the unions would collapse four layers' error vocabularies.
5. **The `scoped` stage is retained though measured unreachable.** Zod enforces a superset of `ruleScopedMutation`'s two conditions, so no candidate reaches stage (c). ⛔ Per the standing ruling, *unreachable is not a licence to delete* — kept as a fail-closed layer for if the Zod model ever loosens.
6. **Consumer honesty per channel:** *"produced and gated; no adapter persists it — `### 24.109`."* Never the unqualified "this gate is now audited."

## Decisions explicitly NOT made

- **No drift detector on the region table** — filed instead. `SourceRefSchema` is reachable from **both** `sow:gcl-projection` and `sow:knowledge-mutation-plan`, so one `z.record` on a shared nested shape silently invalidates two rows with the suite green. `emitJsonSchema` is exported, so a real derivation test is cheap. Scope, not oversight.
- **No per-ref length clamp** — filed. Cardinality is bounded (dedupe-then-cap at 20, drop reported); individual ref length is not, and it is the amplifier for any future cut failure.
- **No row-key pin for the stamp channel** — `SignedProvenanceStamp` has **zero** free-form-key regions on both surfaces, so there is no cut and **no mutation could red such a pin**. Reported, not satisfied with a synthetic region.
- **`writer.ts:285`'s self-falsifying comment left alone** — pre-existing, not this slice's territory to rewrite; flagged.

---

## ⛔ The findings — including two in my own work

### 1. The cut leaked, and the backstop returned `true` (rule 7, CRITICAL)
`structuralPathOnly`'s pattern is `^(.*?\b<region>\b)[./].*$`. Without the `s` (dotAll) flag, `.` does not match a **line terminator** and `$` (no `m`) matches only at end of input ⇒ **a row-authored key containing `\n`/`\r`/U+2028/U+2029 made the pattern fail entirely, and the `?? path` fallback returned the path VERBATIM.**

⭐ **`security-reviewer` built the input and ran it** rather than reasoning about it. Every channel leaked — **including the GCL control** — and **`isRedactionSafe` returned `true`**, because a project codename matches none of its credential patterns. ⇒ ***detection provably could not have backstopped this. The cut IS the control.***

⚠ **Arming precondition, not a live leak** (no per-entry issue can be raised under any region today) — but that is **the same condition under which `### 24.98`'s review demanded this be a construction rather than an argument**. It failed in exactly the case it exists for. Routing is by KIND; reachability governed only fence-vs-fix-now.

### 2. The fail-closed guard was bypassed by any `Object.prototype` key
`FREE_FORM_KEY_REGIONS["toString"]` resolves **through the prototype chain** to a non-undefined value, so `=== undefined` skipped `MAXIMAL_CUT` and the path returned uncut — defeating defence 2 under precisely the widened-id threat model it exists for. Both reviewers found it independently.
⛔ **My pin had sampled only `"sow:..."` — the direction that already worked.** The project's own *"only the SAFE direction has ever been sampled"* shape, reproduced **inside the remedy for it**.

### 3. ⛔⛔ Three of my pins passed while asserting nothing
- **`intake_plan_invalid_…` never reached `plan_invalid`.** The fixture returns `proposed_content_incomplete` from an earlier gate; the test *tolerated that code and returned* before its only audit assertions ran — green, with **zero coverage of the site its own comment calls "the member nobody had listed."**
- **Both scoped-stage pins were decorative** — they rebuilt the producer's literals inline and asserted a string passed one line above (`toContain("scoped")` **cannot fail**), with a neutral `isRedactionSafe` fixture **my own file forbids four lines away**.
- `writer_candidate_is_still_refused_…` asserted code but not stage; the intake equivalent used a bare `return` that let a drift to another refusal code pass.

⇒ ⭐⭐ ***The slice's whole argument was "a cut that cannot fire is the production form of a decorative assertion" — and it shipped three decorative assertions and a cut that could not fire. Every one was caught by a reviewer, not by me.*** Second witness for `175`'s correction: **a source comment survives every check we run except someone running it; a PIN survives every check except someone trying to make it fail.**

### 4. A false premise, with three carriers
*"`applyPlan` contains NO `try` ANYWHERE"* is **false** (two `try` blocks — the post-commit recording writes). The conclusion survives (the gate sits outside both), but I took it from `writer.ts`'s header **without re-deriving it**, and the orchestrator repeated it back in its `APPROVED.`
⚠ **My own verification nearly confirmed it:** `awk '/\btry\b/'` returned **nothing**, because awk's ERE has no `\b`.

### 5. My enumeration stopped at the PACKAGE boundary
I reported **10 sites, zero in test files** — scoped to `packages/knowledge`. Repo-wide it is **12**, and **2 are in test files** (`packages/workflows`).
⇒ ⭐ ***`### 24.98`'s enumeration stopped at the UNION boundary — which is why `### 24.103` exists — and mine stopped at the PACKAGE boundary, in the instrument being used to fix that class.*** **A compiler enumeration is only as wide as the compilation you ran, and "I ran tsc" does not say which tsc.** The orchestrator noted its own table shared that boundary, so the two measurements **could not have disagreed**.

### 5a. ⭐⭐ Is the terminator-bearing key forbiddable AT ITS SCHEMA? — MEASURED, and the answer INVERTS the question

**Asked by the lead because the finding is banked as evidence for `L103`'s *unrepresentable-beats-detected* posture, while the remedy — the `s` flag — makes the regex HANDLE terminators, which is the *detected* shape.** A fair challenge. Measured rather than reasoned (throwaway probe in `packages/contracts`, since deleted):

**YES, it is constrainable, on BOTH surfaces, with machinery this repo already has.**
- **Zod:** `z.record(z.string().regex(/^[^\n\rU+2028U+2029]+$/u), z.unknown())` **rejects** a terminator-bearing key (`invalid_string`) and accepts normal keys.
- **ajv:** `emitJsonSchema` carries it through as `propertyNames: {pattern: "^[^\\n\\r\\u2028\\u2029]+$"}` — the same `guardCatchallPropertyNames` policy already used for the reserved-key blocklist.
- **Live regions today carry no such constraint:** `{"type":"object","additionalProperties":{}}`.

⛔⛔ **BUT CONSTRAINING THE KEY DOES NOT RETIRE THE CUT — IT MAKES THE CUT *MORE* NECESSARY, AND THIS IS THE MEASURED PART: the Zod rejection's own issue path is `"frontmatter.Project\nFalcon"` — THE REJECTED KEY IS IN THE PATH.**
⇒ ***adding the schema constraint ADDS a producer of terminator-bearing paths into exactly the audit surface the cut protects.***

⇒ ⭐ **So the citation and the remedy do NOT disagree.** The schema constraint governs the **candidate** surface; the cut governs the **audit** surface, and it is the cut that makes the key **unrepresentable in the signal** — which is `L103` correctly applied. **The `s` flag is not the detected-shape half; it is what lets the unrepresentable-making construction actually run.**

⚠ **Asymmetry worth keeping: on the AJV side a `propertyNames` violation puts the key in `params.propertyName` with `instancePath` at the parent — and `schema-gate.ts` DROPS `params` (`### 24.104`), so the key would NOT reach the path there. The Zod side DOES carry it.** ⇒ **the two validator surfaces disagree about this, and only one of them is safe by accident.**

**Disposition: nothing built.** Recorded so a future author adding key constraints knows it *strengthens* the case for the cut rather than retiring it.

### 6. Instruments returning reassuring absences — three, one session
`grep` fabricating a match-count header · a **mutation that silently failed to apply and returned a full green** (caught only by an applied-by-diff guard) · `awk`'s missing `\b`. ⛔ **All three failed toward "nothing is wrong."**

---

## TDD compliance

**Mostly clean, with two honest exceptions in the review-fix commit.**

- ✅ **The slice proper (`cbf1c4f3`) was RED-first, twice** — structural RED (module absent), then **behavioral RED** after the module existed, so the pins were shown to detect the actual defect (11 failed / 11 passed, every failure the missing `audit`).
- ✅ The first RED run **exposed six wrong-reason failures** (fixtures rejecting at an earlier stage than named), fixed before any implementation. The non-vacuity guards are what caught it — without them the leak pins would have passed vacuously against any implementation.
- ⚠ **TDD violation — `324a068d`: `Object.hasOwn` was implemented before its pin existed.** I applied the fix while editing the docblock, and added the prototype-key assertions afterward.
- ⚠ **Partial — the dotAll fix:** a throwaway probe reproducing the leak was written and run **before** the fix (RED-first in substance), but the permanent regression pin was written **after** it.
- ⭐ **Compensating control, applied to both:** each was **mutation-proven** afterward — dropping `s`, or reverting `Object.hasOwn`, reds **exactly and only** its own pin. Both mutations were verified applied by diff first; one earlier mutation attempt silently failed and returned green, which is why that gate exists.

---

## Reachability

| symbol | reachable from | status |
|---|---|---|
| `applyPlan` → `runGate` → the shared module | `apps/worker/src/composition/buildActivities.ts` (wires the REAL KnowledgeWriter) | ⭐ **LIVE — rule 1** |
| `stampProvenance` | `writer.ts`, `src/fs-watch/reconcile.ts` | reachable |
| `admitProjection` (the control) | GCL serve path, unchanged | reachable |
| `intakeGenerativeProposal` | — | ⛔ **DORMANT** (0 production callers) |
| `routeRemediation` | — | ⛔ **no production caller found** → follow-up |

Traced **by symbol, not line number** (Carry-forward 8's de-inlining remedy — the brief's own `commitKnowledge.ts:156` cite is the class of pointer that rots).

---

## Open follow-ups

1. **Finding (→ lead, ROUTED):** the line-terminator leak. Fixed in-slice; routed by kind.
2. **Finding (→ lead, ROUTED):** no drift detector on the region table — orchestrator filing as a task.
3. **Future TODO (next-brief):** per-ref length clamp, so a future cut failure degrades to truncation rather than a full leak.
4. **Future TODO (belongs-to-a-phase):** `routeRemediation` has no production caller.
5. **Convention candidate:** `writer.ts:285`'s *"THIS FUNCTION CONTAINS NO `try` ANYWHERE"* is falsified by its own body (pre-existing).
6. **Convention candidate:** bare `LNN` citations in `visibility-gate.ts` (pre-existing) violate the area convention; only mine were fixed.
7. **Cross-doc invariant change: NONE.** No Appendix-A model changed; `WriteFailure`'s member **SET** is unchanged (a member's SHAPE changed) — confirmed, not assumed: the enumeration errored only at construction sites, never at `mapWriteFailure`/`commitFailureClass`/`commitFailureState`, and workflows' *"every pre-existing mapping is byte-identical"* regression pin passes.

---

## How to use what was built

**Adding a fifth channel:** make its issue-carrying member extend `IssueCarryingRefusal`, add its candidate schema to `CandidateSchemaId` + `FREE_FORM_KEY_REGIONS` (**derive the regions on both validator surfaces — do not copy another schema's**), and build the signal with `buildRefusalSignal`. The compiler will not let you skip the `audit`; the signature will not let you skip the table.

⛔ **Three edits that silently destroy this, each of which looks like an improvement** — all three are named at their own site with the consequence, not the rule:
1. Making `audit` optional "temporarily" — **deletes the enumeration**, and the gates go back to silently signal-less with the suite green.
2. Widening `structuralPathOnly`'s second parameter back to a region array — **restores the bypass** by making the table optional.
3. Dropping the `s` flag from the region pattern — **re-opens the line-terminator leak**, which `isRedactionSafe` cannot catch.
