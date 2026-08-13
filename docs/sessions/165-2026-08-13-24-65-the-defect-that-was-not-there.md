# Session 165 — `24.65`: the defect that was not there, and four surfaces that said it was

**Date:** 2026-08-13 · **Phase:** 24 (hardening tail) · **Area:** `packages/policy` (`providers-integrations-implementer`, single-track `main`)
**Predecessor:** chronological — `164-2026-08-13-24-26-closes-and-the-comment-that-instructed-the-forbidden-binding.md` (knowledge) · **this area's prior session** — `161-2026-08-13-redaction-safe-producer-enumeration-24-45.md`
**Successor:** _(next `/session-end`)_

**Commit:** `ba0deb1b` — 1 commit, 3 files, **zero logic delta** (non-comment `+/-` lines empty, verified mechanically).

> ⚠ **Session-doc chain convention is INCONSISTENT in this repo and I did not unilaterally pick one.** `161` (mine) declares chains run **per-AREA**; `162` (knowledge) used **global-chronological** for its `Predecessor` and **per-area** for its `Successor`, and set `161`'s successor to `162`. ⇒ **following the providers-integrations chain from `161` lands in knowledge's doc and never reaches this one.** Both lineages are named above so this doc is reachable either way. **Flagged at Step 9; not resolved here.**

---

## Why this session existed

`### 24.65`, filed with two defects in `packages/policy/src/visibility.ts`. **Neither survived contact with the source in the form filed**, which is the whole story of the slice.

## What was built

**Files modified:**

| File | Change |
|---|---|
| `src/visibility.ts` | **Comment only.** Retracted a false never-throw residual; qualified a retained `24.45` claim; added the residual note for finding 1 with its lead ruling, `contracts L147` class, both-direction cross-reference, and measured reachability. |
| `test/visibility.test.ts` | 3 tests: null and undefined source workspace return typed denials without throwing; the `defaultVisibility` guard is reachable with a **real** workspace (so it is not deleted as dead code). |
| `docs/sessions/161-…md` | Dated erratum **in place**, original text preserved. |

## Decisions made

1. **Defect 2 does not exist — pin it, change nothing.** `24.45`'s own `?.` makes `srcId` undefined, so the mismatch branch returns a typed denial before the unguarded `defaultVisibility` read. **Probed, not read.** Verified against `git show 48ec7c91` that the pre-`24.45` line genuinely did throw — so this is a **history-verified incidental fix**, not an inferred one.
2. **Defect 1 accepted as residual (lead ruling, option D).** `24.45`'s remedy is **referential** — interpolate only a value proven equal to a trusted counterpart in scope. `denyDirectCrossWorkspaceRaw` receives only `req`, so both ids are caller-supplied and **no counterpart exists**. Reusing its sentinel without the validation that earns it is a weaker second spelling of a control `24.45` proved insufficient ⇒ false assurance, which costs more than a documented gap.
3. **Erratum in place, never rewrite** — the false text stands, marked inline `⛔ FALSE`, so a `grep` cannot surface it as a clean assertion and the evidence that the claim propagated survives.
4. **One residual, two sites** — cross-referenced in both directions, under `contracts L147`, with the real fix tracked durably as `### 24.68`.

## Decisions explicitly NOT made

- **No fix to defect 1** — a scope cut, escalated as a **deferment** (category 3) and ruled by the lead, not settled between orchestrator and implementer.
- **Options (A)/(B)/(C) declined with reasons on the record** — (A) destroys the audit's only identifying content; (B) is cosmetic (`WorkspaceIdSchema` is `.min(1)` + non-blank, so it admits the bad case); ⛔ **(C) rejected on principle** — a second, weaker spelling of a disproved control is false assurance, and it is the most tempting option **because it produces a diff.**
- **Nothing in `packages/knowledge` or `packages/workflows`.**

## TDD compliance

⚠ **Not a red-first slice, and labelled as such in-test rather than dressed up.** The three tests are **green on first write**: they pin an existing guarantee (defect 2 was never real). ⛔ **A green-on-write test presented as TDD-red would be a false claim in a slice about false claims.**

**Compensating evidence:** the never-throw property was established by **probe** before any test was written, and the guard's reachability test is self-verifying (reaching that message requires passing the referential pin, so a wrong fixture fails rather than silently passes).

## Cross-doc invariant audit

**No model field changed.** Comment + tests only; `AuditSignal` and `AuditRecord` untouched. **No `ARCHITECTURE.md` row owed.**

## Reachability

⛔ **`denyDirectCrossWorkspaceRaw` is not production-REACHABLE — but it is NOT "uncalled", and the distinction is load-bearing.** It has two production callers: `← guardCrossWorkspaceRawRead` (`packages/knowledge/src/gcl/visibility-gate.ts:255`) `← CrossWorkspaceLinkMap.authorizeCrossWorkspaceRawRead` (`cross-workspace-links.ts:237`) `← NOTHING`.

⭐ **Both hops are exported from `@sow/knowledge`'s public barrel, so ONE import makes the residual live with fully caller-supplied values against a rule-4 gate — with `CrossWorkspaceLinkMap` never constructed.** ⇒ **the dormancy this residual was accepted under is one import away from ending, and that is not the condition the ruling was argued on.**

**All four apparent `packages/workflows/src` call sites are COMMENTS** (`contracts L104`, use vs mention) — filed as a separate task. **Stopping at the symbol search would have produced a confident false positive.**

## Open follow-ups

Filed; **referenced, not re-filed**: the real fix for finding 1 (`### 24.68`) · the four false-liveness workflow comments · §16 never-throw is **not total** — six throw shapes measured, and the projection-side ones matter most because `serveProjection` re-gates already-stored, possibly-tampered rows · a **zero-own-property workspace returns ALLOW** (`Object.create` prototype-only), a silent fail-open on a visibility gate, filed as a **wiring precondition** on the GCL port binding.

## Lessons raised

1. ⭐ **"Unreachable" is not "uncalled."** Measuring reachability and reporting callers is `contracts L118` — measure one property, report another. **I made this error in the note after stating it correctly at Step 2.5**, and the orchestrator then propagated it into the commit message.
2. ⭐⭐ **A conditional authorization is a gate, not a formality.** *"Land without checking in **if it comes back clean**"* — it came back HIGH, so the landing stopped automatically rather than by judgment. ⛔ **What it caught was a falsified claim in the commit message, not in the code** — and a commit message is the most durable artifact of all.
3. ⭐ **The remedy is a high-frequency site for the defect it remedies.** My corrected comment over-claimed in the same direction as the original (*"never-throw holds"*, false for a throwing getter) — **caught in the very block documenting getter-backed records as a threat.** I also re-endorsed a retained `24.45` line claiming a property was *"total"* that an accessor escapes.
4. **A remediation ledger is a claim like any other.** The erratum's per-surface status was itself wrong — it labelled a **corrected** artifact uncorrected, inviting a re-correction that would have destroyed preserved evidence.
5. **`contracts L51`/`L97`** — a commit message must not anchor to a session-scoped `#N`; the id already resolved to a different historical item.

## Verification at close

`@sow/policy` **500/500** · tsc **0** · **non-comment source delta empty** · commit verified **per-path** (`git log --oneline -1 -- <file>`), 3 files, **no peer path swept** while the orchestrator's tracker edits and worker's `boot.ts` sat unstaged in the same tree.
