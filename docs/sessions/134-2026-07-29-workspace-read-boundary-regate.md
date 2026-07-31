# 134 — worker: the workspace repository read boundary re-gates stored rows (9.36)

**Date:** 2026-07-29
**Track / role:** main · worker-implementer
**Predecessor session:** `docs/sessions/130-2026-07-29-worker-partial-scaffold-typed-resumable-outcome.md`
**Successor session:** `docs/sessions/138-2026-07-30-worker-three-slices-egress-notice-corruption-surfacing-meeting-keystone.md`

---

## What landed

| Task | Commit | Summary |
|---|---|---|
| **9.36** | `be62e348` | Every workspace repository read (`get`/`list`/`updateProvisioningFields`'s RETURNING row, both dialects) now re-gates the stored row through the full `WorkspaceSchema` instead of an unchecked cast, via a new permanently-non-retryable `DbErrorCode`, `stored_row_schema_violation`. |

The technical shape of the fix is fully recorded in `be62e348`'s commit message and in brief 223 — this doc does not repeat it. What follows is what a session doc is for: the decisions I did NOT make, the residuals I named rather than closed, and the two things I caught myself getting wrong before they shipped.

---

## Why this session existed

9.36 was dispatched as a rule-5-adjacent slice: the six `as Workspace`/`as Workspace[]` casts on the workspace repository's read paths were the last thing standing between an out-of-band-corrupted stored row and both a policy decision (the §5 egress veto's input) and a subsequent write (`egressRevoke.ts`'s get-before-upsert). The brief's own premise-count (six cast sites) turned out to be the wrong completeness metric — caught mid-slice, see below.

---

## The mechanism-vs-belt split — written as the experiment, not the conclusion

The brief's original framing was "delete six casts." Mid-slice, the orchestrator (relaying the lead) corrected that: the six casts were *decorative*, because `workspace-config.ts`'s drizzle schema already typed the two nested JSON columns `.$type<Workspace["egressPolicy"]>()`/`["providerMatrix"]>()` — the SELECT row was already structurally `Workspace` before any cast ran. Deleting the casts would have changed nothing.

The fix I built types both columns (both dialects) `unknown` instead, so a bare `return ok(row)` with no cast at all no longer compiles. I did not stop there and assume that closed the question. I ran the experiment: with the columns `unknown`, I wrote `ok(row as Workspace)` back into one adapter and ran `tsc --noEmit`. **It compiled clean.** TypeScript's `as` operator permits a cast when either type is assignable to the other, and a concrete `Workspace` value *is* assignable to a type whose fields are `unknown` — so the cast direction holds regardless of how "empty" the row's declared shape is. I then confirmed the stronger, more general form: `as unknown as Workspace` compiles for *any* two types, always — that is not specific to this schema, it is how the operator works.

**The decision I made from that result, not before it:** no purely structural TypeScript mechanism can forbid a deliberate double-cast. Type-level unrepresentability (the `unknown` columns) closes the *accidental* bypass — the case where a future reader forgets to parse and just returns the row. It cannot close a *deliberate* reintroduction of the exact historical single-cast. That is why the source census (`repository-contract.test.ts`, "workspace read-boundary cast census") exists as its own, separately-reported artifact, not as belt-and-braces decoration over a mechanism that already covers the case — it is the *only* coverage for that class. I want this recorded as an experiment someone can rerun, not as a rule to take on faith: revert the schema's `unknown` typing to the frozen model types, try the same cast, and it will compile just as easily either way — the census is what changes.

## The named write-side trade, in my own words

Typing the two JSON columns `unknown` removes a compile-time check on the *write* side too: before this slice, `.values(ws)`/`.onConflictDoUpdate({set:{egressPolicy: ws.egressPolicy, ...}})` was checked against the frozen `EgressPolicy`/`ProviderMatrix` shapes at the column level. After, that specific column-level check is gone.

I did not treat this as free. I checked what actually constrains a write today: `upsert(workspace: Workspace)` and `insertIfAbsent(workspace: Workspace)` both take a caller-supplied, already-typed `Workspace` as their *parameter* — the value is constrained before it ever reaches the `.values()` call, by the caller's own type signature, not by the column overlay. The column-level check was catching nothing a write-time caller wasn't already prevented from doing wrong. The *read*-side version of the same overlay was different in kind: it was the thing that let six unchecked casts look unnecessary, i.e. it was hiding the exact bypass this slice exists to close. Trading a redundant write-side check to close a real read-side one is the right trade, and I want it on record as a trade rather than as "writes unaffected" — a future reader who sees an untyped insert column with no compile-time shape check will read that as an oversight and be tempted to "fix" it by restoring the `.$type<>()` overlay. Restoring it reopens the accidental-bypass case this slice closed. Don't.

## The TDD deviation, its residual, and why the remedy actually discharges it

I wrote the db-layer implementation (the shared parse helper, both adapters' gate, the schema retype) before the dual-dialect tests — I traced the existing `ParityReportSchema.parse(r.payload)` precedent in this codebase first, to settle the design, then wrote tests against the implementation I'd already built. I disclosed this rather than presenting it as ordinary red-green.

Mutation verification is not a substitute for red-first, and I want the distinction precise rather than hand-waved: reverting one adapter's gate and rerunning the suite turned exactly the tests that touch that gate RED, and left the tests scoped elsewhere green — that proves the tests *discriminate*, i.e. they are not vacuous. It cannot prove *spec-fidelity*, because a test written by looking at the implementation can encode what the implementation happens to do rather than what the specification (`WorkspaceSchema`) actually requires, and no mutation of that same implementation can ever surface a case both the code and the test independently forgot.

The remedy — the spec-fidelity cross-map against `packages/contracts/test/models/workspace.test.ts`'s own constraint-class enumeration — discharges that residual for a specific, load-bearing reason: that file was authored by a different area, for a different purpose (freezing the contract's own schema-snapshot behavior), before this slice existed. It could not have been shaped by my implementation because my implementation didn't exist when the reasoning that produced those test cases was written. Red-first proves a test predates the *code*; an independently-authored, cross-area enumeration proves it predates the *author*. That is a stronger property than red-first gives you, in the one dimension red-first doesn't cover — and it is also *not* something I could have gotten by simply being more disciplined about test order this session; it required an enumeration that already existed somewhere I didn't write.

The disposition (covered / unreachable-with-reason / handled-but-unpinned) is in `be62e348`'s message. The one place I initially got the framing wrong: I recorded the JSON-`null`-in-a-`NOT NULL`-column case as an "unclosed gap." The orchestrator corrected this — `WorkspaceSchema.safeParse` genuinely rejects a `null` `egressPolicy` (the nested schema is a `z.object`, `null` fails it structurally), so the *gate* covers this state; what's missing is only a fixture, because constructing that exact state requires bypassing the typed `upsert` wrapper (a JS `null` maps to SQL NULL at the write, which the NOT NULL column rejects, rather than storing a JSON-null blob). I accepted the correction rather than defending my original wording, and asked that the more accurate framing — "handled by the gate; not independently pinned, because the state cannot be constructed through the typed write path" — be the one that survives in the architecture doc, since my own commit's wording is not being rewritten for a phrasing nuance after a doc commit had already landed on top of it.

## Two self-caught false passes, in my own words

**The census's file-discovery was blind to my own new file.** I built the "cast census" source-scan using `git ls-files` (tracked files only). My own new file, `workspace-read-gate.ts`, was untracked at the time I wrote and ran the census — so the census's own discovery step silently excluded the one file most likely to need scanning, and would have reported "clean" forever on a subset that happened not to include the slice's own addition. I caught this because the census's own "non-vacuity" test (asserting the scan actually found something, including that specific file) failed — not because I went looking for the gap ahead of time. Fixed to `git ls-files --cached --others --exclude-standard`, which includes untracked-but-not-ignored files.

**My first mutation-verification attempt used a cast shape the census couldn't see, and I noticed before reporting it as a pass.** To prove the census catches a reintroduced cast, I first wrote `row as unknown as import("@sow/contracts").Workspace` back into an adapter. The census's regex (`\bas\s+Workspace(\s*\[\s*\])?\b`) did not match it — correctly, on reflection: the token immediately after the second `as` is `import`, not the bare word `Workspace`, since I'd used an inline type-only import to avoid re-adding a top-level import for the experiment. That is a real difference in the source text, not a bug in the regex. But it meant my first "the belt catches a reintroduced cast" claim would have been false if I'd reported it — I re-ran the mutation using the realistic, single-token form (`row as Workspace`, with `Workspace` imported normally, matching exactly how the original six casts read), confirmed THAT went red, and reported that result instead. The lesson I'd draw: a mutation a guard cannot see is indistinguishable from a guard that works, and the only way to know which one you have is to check what specifically failed to match, not just whether the test passed.

## Q3 (Option-A refinement) — a capability, not yet a guarantee

The lead's Option-A refinement asked for three things: fail-closed, distinguishable at the repository boundary, and operator-visible so a human can see the corruption they need to repair. I verified the third does not hold today: `boot.ts:578-592`'s `egressStatus` folds *any* `get()` error — including the new `stored_row_schema_violation` — into the same generic fail-closed value (`ok:true, zeroEgressOnly:false`), indistinguishable from `not_found` or a plain outage. The first two hold; the third does not. I did not build a surfacing path for it — inventing one wasn't in scope, and the brief's own Step-2.5 guidance was explicit that a not-yet-existing diagnostic consumer should be named, not manufactured. This is now tracked as its own task, **9.38**.

## On `pnpm lint`'s reported intermittency

I have no first-hand observation to add here. I never ran `pnpm lint` directly this session — every quality check I ran was `npx tsc --noEmit` invoked per-package (`packages/db`, `apps/worker`, and the four dependent packages), which is what `lint` resolves to in this repo per the standing L89 finding, but I did not run it through the `pnpm lint` script wrapper itself, piped or unpiped, and did not encounter any inconsistency in the runs I did make — each `tsc --noEmit` I ran gave a clean, repeatable "No errors found." I'm recording the absence of an observation rather than a data point, since the lead asked for each observer's own account.

---

## Decisions explicitly NOT made

- **The JSON-null fixture was not built.** Constructing it would require a raw SQL INSERT bypassing the typed `upsert` wrapper — judged out of proportion for this residual; recorded as handled-by-the-gate-but-unpinned rather than silently dropped.
- **9.38 (surfacing the new code to a diagnostic consumer)** — not started; recorded as its own task per Q3 above.
- **No renaming of the `.strict()`-unreachable or NOT-NULL-unreachable classes into fixtures "for completeness"** — both are genuinely unreachable via a stored row (structurally, not just currently), and building a test for an impossible state would be decorative, not protective.

## TDD compliance

Deviation disclosed, not silently absorbed: the db-layer implementation (shared helper, both adapters' gate, the schema retype) was written before its dual-dialect tests, for the reason given above (tracing the `ParityReportSchema` precedent to settle the design). Recorded as forbidden-pattern #1 with its residual (spec-fidelity, not vacuity) and its remedy (the independently-authored cross-map). Every other file in this slice — the worker-layer classification changes and their tests — was written test-first as usual.

## Reachability

- **LIVE**, not dormant. All three consumers that benefit — `storeBackedWorkspacePosture.ts:31` (→ `systemHealth.egressStatus`), `egressRevoke.ts:53` (→ `egressCommand.revokeEgressAck`), `provisionWorkspace.ts` (→ the `onboarding` router, two sites) — are already-live production entry points; this slice hardens them rather than adding new wiring.
- **Confirmed NOT live:** `resolveWorkspacePolicy`/`buildActivities.ts`, the consumer the original brief cited as the "decisive argument" for fixing at the boundary. Zero production callers of `resolveWorkspacePolicy` exist (only its own unit test invokes it); `boot.ts:1194`'s `ResolvedWorkspacePolicy` value is a hand-built dev/proof-spine literal, consistent by construction, not derived from a DB read. This correction travels in the commit message and was not softened.

## Open follow-ups

1. **Task 9.38** — surface `stored_row_schema_violation` to a diagnostic consumer so an operator can actually see the corruption they must repair (currently a capability with no consumer).
2. **The JSON-null fixture** — recorded as handled-by-the-gate-but-unpinned; would need a raw-SQL-bypassing-the-typed-write test harness if ever prioritized. Not blocking anything.
3. **Do not restore `.$type<>()` on the two JSON columns** — this is a load-bearing "don't," not a stale TODO. Restoring it reopens the accidental no-cast bypass this slice closed.
4. **The census is not defense-in-depth decoration** — if a future refactor of `workspace-config.ts`'s schema changes shape again, re-verify the `unknown`-typing still holds and that the census still runs against the correct file set (tracked + untracked).

## How this was built

One `/tdd`-adjacent cycle dispatched as brief 223 (three amendments mid-slice, each correcting a premise: the cast-count metric, the mechanism/belt split, the naming of the new `DbErrorCode` member). Reviewed and shipped as rule-5-adjacent — Step 9 routed through the orchestrator to the lead per the brief. One commit, `be62e348`, landed via a pathspec-limited `git commit -- <paths>` after an unrelated concurrent mixed-commit incident (main-orchestrator's `ARCHITECTURE.md` commit briefly swept my staged files; repaired non-destructively on both sides independently, verified via `git show --stat` before proceeding — nothing lost, no history rewritten).
