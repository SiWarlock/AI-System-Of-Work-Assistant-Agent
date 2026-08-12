# 160 — `auditPersist` required at consumption, the `24.44` consumer leg, and the `ownership_violation` invariant

**Date:** 2026-08-12 · **Phase:** 24 (cross-cutting remediation) · **Track:** `main` (single-track, root checkout)
**Role:** `worker-implementer` (Opus 5) · **Predecessor:** `docs/sessions/157-2026-08-12-l134-chain-closes-migration-detector-and-raw-content-fork-deleted.md` · **Successor:** _(none yet)_

---

## Why this session existed

The predecessor worker cycled at 87%. This session was activated to take `### 24.43` — **which turned out to be already DONE** (`a5214c8e`), the first of four stale-instruction catches. What actually shipped was three different slices: the consumer leg of the `24.44` pair, `### 24.37`, and `### 24.49`.

---

## What was built

### Files created
| file | purpose |
|---|---|
| `apps/worker/test/api/procedures/copilotAuditPersistRequired.test.ts` | `24.37` half B's type-level pin — 3 tests: omission is a compile error, the allow-side control, and fixtures stay permissive. |

### Files modified
| file | change |
|---|---|
| `apps/worker/src/composition/crossWorkspaceRead.ts` | `24.44` leg 1 — one word: `await serveProjection(...)`. |
| `apps/worker/src/api/procedures/copilot.ts` | `24.37` — new `AuditPersisting<T>` type. |
| `apps/worker/src/api/procedures/copilotClaudeSynthesis.ts` | `24.37` — `buildCopilotDeps` returns `AuditPersisting<CopilotDeps>`. |
| `apps/worker/src/api/procedures/copilotBriefing.ts` | `24.37` — the invalidating-condition comment at the `runGovernedCopilotSynthesis` call. |
| `apps/worker/src/boot.ts` | `24.37` — `briefing` literal typed `AuditPersisting<CopilotBriefingDeps>`. |
| `packages/workflows/src/workflows/sourceIngestion.ts` | `24.49` — 3 comment sites. |
| `packages/workflows/src/ports/meetingCloseout.ts` | `24.49` — 2 comment sites. |
| `packages/workflows/test/source-ingestion.test.ts` | `24.49` — 2 test names + 1 comment. |
| `packages/contracts/src/models/shared-enums.ts` | `24.49` — **lead-authorized cross-area comment**, own commit. |

### Commits
| hash | slice |
|---|---|
| `e7991d52` | `24.44` leg 1 — consumer-first `await` |
| `a44a921a` | `24.37` — `auditPersist` required at consumption |
| `b9ba520b` | `24.49` — 8 in-territory comment sites |
| `bbe22d75` | `24.49` — the authorized `packages/contracts` comment |

---

## Decisions made

1. **`24.44` shipped CONSUMER-FIRST.** The pair's Done-when required both commits in one round with **no red window**. Producer-first cannot deliver that — the sync→async flip breaks the call site's compile the moment it lands. `await` on a still-synchronous function is a legal no-op, so consumer-first is green at every commit. *Rationale: the ordering also means neither implementer writes outside their own territory.*

2. **`24.37` fixed the ERASURE, not the symptom.** The guarantee already existed at `buildCopilotDeps`'s **input** (`CopilotDepsOptions.auditPersist` is required) and was **erased by its return type**, which widened back to the fixture-permissive shape. `AuditPersisting<T>` carries it through the return. *Rationale: this is why 14 fixture sites across 8 files compile untouched and the planned two-type split was unnecessary — a generic did the work of a second type.*

3. **RED test 1 from brief `267` was DROPPED.** `every_boot_deps_literal_derives_from_its_factory` measured *"was this assembled by hand?"* when the property is *"can a safety-relevant field be silently absent?"* — an `L118` proxy, wrong in **both** directions (flags two harmless literals; blind to a spread-derived literal dropping an optional field). *The orchestrator named it more precisely: it had written a `pin:` for what is actually a convention — `L102`, which owes no slice a detector.*

4. **`24.49`'s `deletionSaga.ts:274` was HELD, not fixed.** That union carries **both** `ownership_violation` and `human_owned_region`; correcting the former to KN-7/KN-8 makes it indistinguishable from the latter. **The comment is only distinguishable today because it is wrong.** *Rationale: an accurate comment would create a worse defect than the inaccurate one.*

5. **The `packages/contracts` comment was taken under an explicit, narrow lead authorization** — comment-only, own pathspec-limited commit, recorded as a crossing with its reasoning and **explicitly not precedent**, and explicitly **not** an `L121` case (`L121` is a widening's own compile-break; this is correctness in another area's file).

---

## Decisions explicitly NOT made

- ⛔ **Whether `isolation_breach` is the right `FailureClass` for `ownership_violation`.** If it is KN-7/KN-8 **section** ownership, the class — which reads as *workspace* isolation and maps to **CRITICAL** via `defaultSeverityForFailureClass` — may be the wrong home. Brief `268` asserted *"classification is CORRECT and unaffected"*; that assertion may itself rest on the wrong reason, which is `24.49`'s own defect one level up. **Recorded as open in-code rather than resolved in the direction that made the comment tidy.** Deciding it is behaviour, which the authorization did not cover.
- **`probeDeps` (`boot.ts:1146`) and `reconcileHealthDeps` (`:2211`) audited and deliberately unchanged.** Neither field-picks a factory output, so neither can drift the `briefing` way. `reconcileHealthDeps` is untyped — a weaker posture — but its consumer type-checks it at the call site, and typing it is unrelated cleanup that does not belong in a safety slice.
- **`### 24.9` not absorbed**, per instruction. The transferable shape from `24.37`: *narrow the type the production path travels, rather than making the seam's guard non-optional for everyone.*
- **No briefing→persistence end-to-end test written.** See Reachability.

---

## TDD compliance

**Clean, with two disclosed exemptions — both pre-authorized, both stated in their commit messages.**

- **`24.37` — genuine red-first.** The pin was written **before** the type existed and failed with `TS2578 Unused '@ts-expect-error' directive` (the type-level RED signature, contracts `L87`), then green, then **mutation-verified**: aliasing `AuditPersisting<T> = T` yields **exactly one error — the new pin, and nothing else** ⇒ it is the **sole** detector. Restored, verified byte-identical, typecheck back to exit 0.
- **`24.44` leg 1 — disclosed exemption.** No RED test and **no source-assertion pin**: leg 2's type change makes the `await` structurally required, so a pin written then would exist only to be deleted.
- **`24.49` — disclosed exemption.** Comment accuracy; no behaviour to pin. Proven mechanically: `git diff -U0` over `packages/workflows` = 46 changed lines, **non-comment = 4**, all four being the two renamed `it(...)` titles. No `it()` added or removed ⇒ test count structurally unchanged (30/30 before and after).
- ⚠ **One process deviation, disclosed and priced by the orchestrator:** Step 9 was **compressed into the commit message** on `24.44` leg 1, justified by an explicit *"land promptly, knowledge is blocked"* plus a pre-authorised exemption. The orchestrator accepted it for that slice and drew the line for the next: **compressing Step 9 is defensible only when the slice is pre-authorized, carries no safety surface, and something is actively blocked on it. `24.37` failed two of three**, so its Step 9 preceded its commit.

---

## Cross-doc invariant audit

**No cross-doc invariant changed this session.** `AuditPersisting<T>` is a worker-internal **type alias** — no model field, no JSON Schema, no snapshot, no ajv registry entry, no Appendix-A row. Confirmed with the orchestrator at Step 2.5 and again at Step 9. `24.49` and `24.44` leg 1 touched no model shape at all.

---

## Reachability

| feature | entry point | status |
|---|---|---|
| `24.44` leg 1 `await` | `resolveApprovedCrossWorkspaceSlice` (`crossWorkspaceRead.ts:81`) | ⚠ **Dormant by design** — the function has zero production callers (established by `24.33`'s premise correction). The pair is a wiring precondition, not live. |
| `24.37` `AuditPersisting<T>` | `bootWorker` → `buildCopilotDeps` → `briefing` | ✅ **Live production path.** `copilotBriefing` is one of three live Copilot entry points. |
| `24.49` comments | n/a | Comment-only. |

⚠ **Tested-but-unwired gap, recorded not hidden:** no test drives `copilotBriefing` → denial persistence **end-to-end**. The guarantee holds **structurally** on three legs: (a) `copilotBriefing.ts` calls `runGovernedCopilotSynthesis` **directly**; (b) that function's deny-path persistence **is** pinned (`copilotDenialAudit.test.ts:115`, allow-side control `:178`, persistence-fault `:190`); (c) `24.37` makes the port **required**. ⛔ **Leg (c) survives a refactor; leg (a) does not.** The invalidating condition is recorded **at the call site itself**, where a refactorer will read it (`L94`), and in the tracker.

---

## Open follow-ups

1. **Task #36 — briefing→persistence is structural, not observed.** Done-when: an end-to-end test that **moves the state** (a construction-side assertion cannot distinguish *"constructed and dropped"* from a fix), **or** the directness pinned so interposing a wrapper goes red.
2. **`deletionSaga.ts`'s `ownership_violation` vs `human_owned_region` distinguishability.** If the two members have no distinguishing meaning, that is a **redundant union member — a real defect, not a comment defect**. Hypothesis (labelled as such): `human_owned_region` = ownership condition 4, `ownership_violation` = conditions 1–3.
3. **Is `isolation_breach` the right class for `ownership_violation`?** See *Decisions explicitly NOT made*.
4. **`### 24.9`** — same `L123` family; the `24.37` shape may apply.
5. **`reconcileHealthDeps` is untyped** — audited, deliberately unchanged, offered as a filing.

---

## Findings worth carrying forward

⭐ **1 — A wrong REASON gets reused as precedent, so its blast radius is not the task that introduced it.** `24.49` began as *"~3 comments"*; the final count was **9 sites across 4 files**. Three were my own text from `24.23` — including a pure `L73`: I justified classifying `workspace_path_violation` as `isolation_breach` on the grounds it was *"the SAME isolation class as `ownership_violation`"*, then built a **test name** on the false analogy. The conclusion was independently correct (it earns the class on its own §5 WS-8 merits), so the fix restates the reason and leaves the mapping. ⛔ **But `ports/meetingCloseout.ts:423` carries the same framing in a file `24.23` never edited** ⇒ `24.23` **inherited** an endemic wrong reason and spread it further rather than introducing it. **That sharpens `L73`: the blast radius of a wrong reason is not its origin task.**

⭐ **2 — A path-less citation produced a confident false negative.** Brief `268` cited `meetingCloseout.ts:420` **with no path**. `packages/workflows/src` has **eight basenames present in BOTH `ports/` and `workflows/`** (`approvalFlow · copilotQa · crossCalendarScheduling · dailyBrief · ingestionTriage · meetingCloseout · projectSync · sourceIngestion`). I resolved it to `workflows/`, measured **0** occurrences correctly, and reported **"not a site."** ⛔ **A false positive costs one classification; a false negative closes the question with a ✅ next to it.** The orchestrator challenged it and was right — **and neither of us had made a grep error; we had read different files.** `L97`, and now a brief-template rule.

⭐ **3 — `L64` landed three times in one task, once on each of us, each through a different search key.** The orchestrator grepped `deps.auditPersist !== undefined` and reported a discrepancy its search was structurally incapable of resolving (site 2 destructures to a local). I grepped the symbol `ownership_violation` and missed a site whose prose reads *"an ownership / secret / … failure"*. ⇒ ***the search key was the SYMBOL; the defect lives in PROSE ABOUT the symbol, which need not contain it.*** The final sweep searched the **claim**, scoped to ±12 lines of an `ownership` mention — a bare claim-sweep returns hundreds of legitimate `WS-*` mentions and is unusable (`L104`). **Even then it needed a second key set to find the 9th site**, which is why the count is reported **with its keys** (`L100`).

⭐ **4 — Blast radius measured from `tsc` output, not from a name-grep, and the difference was categorical.** Grep-by-type-name predicted 1/3/3 files for `24.37`; the measurement was **14 errors across 8 files** — and **zero of the 8 was the file the grep named**, which does not error because it already supplies the port. The largest cluster (`uiSafe.test.ts`, 4 sites) mentions none of the searched names. **Worker `L81` confirmed empirically: the name-grep found precisely the file needing no change and missed all eight that did.**

⚠ **5 — Four message-crossings on one slice, all resolved by checking the tree.** The `24.44` authority question · a *"Go, start Step 3"* that arrived after Step 9 · the `meetingCloseout` false negative · an *"your edit is uncommitted"* alarm that crossed with the commit landing. **Nothing was lost in any of them; the resolution was always to verify state rather than trust either party's recollection.**

⭐ **6 — Refusing a stale instruction was correct four times.** `24.43` was already DONE when dispatched; the `24.44` dispatch conflicted with three older records and needed the lead to confirm a **fresh** ruling (it was one — the three records genuinely predated it). The lead's standing instruction afterwards: *"do not loosen that guard because this one resolved as authorized."*

---

## How to use what was built

**`AuditPersisting<T>`** (`apps/worker/src/api/procedures/copilot.ts`) — apply to any deps type whose omission of a safety-relevant port would be a silent production gap:

```ts
function buildX(opts: XOptions): AuditPersisting<XDeps> { … }   // factory keeps the guarantee
const literal: AuditPersisting<XDeps> = { …, auditPersist };     // hand-built literal cannot omit it
const fixture: XDeps = { … };                                    // fixtures stay permissive
```

⛔ **Scope, and do not quote it unqualified:** this closes the recurrence **for `auditPersist`**. The general class — a hand-built literal dropping a factory's later-added **optional** field — is closed by **convention, not construction**: *make safety-relevant deps fields required*. **"Safety-relevant" is not a property the type system can see.**
