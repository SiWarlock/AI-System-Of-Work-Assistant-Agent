# Session 171 — two measurements, and a census that lied in both directions

**Date:** 2026-08-14 · **Phase:** 24 (hardening tail) · **Area:** `packages/knowledge` (knowledge-implementer, single-track `main`)
**Predecessor:** `170-2026-08-14-three-fixes-two-measurements-and-the-claims-i-had-to-retract-about-my-own-work.md` (also mine)
**Successor:** `172-2026-08-14-24-80-re-scoped-and-the-precedent-that-had-not-solved-it.md`

**Commits:** none — both slices were measurement-only. Verdicts recorded by the orchestrator at `d6295e89` (`#76`) and `103080dc` (`#81`).

---

## Why this doc exists

`170` closed before `#76` and `#81` ran. Both were **no-commit measurement slices**, so nothing in `packages/knowledge` changed — but they produced the scope that `### 24.72`'s verdicts now carry, and one methodological pairing worth more than either slice. **A close-out that skipped them would leave the implementer-side record ending mid-question.**

## What was measured

**`#76` Half A — does the commit path's `FailureClass` reach System Health?** **YES**, full chain traced by symbol: `applyPlan` err → `createCommitActivity`'s `!result.ok` branch → `mapWriteFailure` → `sourceIngestion`'s commit branch calling `surface(…, commitFailureClass(…))` → `deps.health.surface` → the production binding at `apps/worker/src/composition/buildActivities.ts:1244` → `surfaceWorkflowFailure` → `materializeHealthItem`. ⇒ `writer.ts` step 8's promise **has a wired destination**.

**`#81` — but for how many compositions?** Three exist; `#76` proved one.

| composition | commit fault → | durable health item? |
|---|---|---|
| `sourceIngestion` | `surface(…, commitFailureClass)` → `deps.health.surface` | **yes** |
| `meetingCloseout` sibling loop | `deps.health.surface` per iteration, then continues | **yes** |
| `semanticApprovalDispatch` | `FailureVariant` → tRPC → the approving user | ⛔ **no** |

⇒ **`### 24.72` Leg A's benefit is 2-of-3.** ⭐ **And the outlier is the only SYNCHRONOUS path — which is exactly why it looked adequate: it already has a human watching.** For a post-commit record fault that shape is wrong: **the state it reports is durable; the notification is not.** The inconsistency persists after the error toast is dismissed.

## Decisions made

1. **Named the two untraced compositions rather than letting `#76`'s verdict read as universal.** The scope now travels with the verdict, so neither can be quoted alone.
2. **Did not infer `meetingCloseout` from `sourceIngestion`.** They share a taxonomy (`commitFailureClass`'s own comment says so); **sharing a taxonomy is not sharing a route.**
3. **Reported Leg B as "a different consumer," not "no consumer."** It is not `L106` produce-and-drop — the signal reaches the approving user. The defect is the *shape*, and overstating it would have been the easier and less true framing.

## Decisions explicitly NOT made

- **No fix for the approval-path gap** — worker territory, filed separately rather than folded (the split that worked for `#77`/`#75`).
- **Half B of `#76` (class-correctness) left open** — it depends on `#75` and any verdict today expires on their commit.

## TDD compliance

**Not applicable — no code changed in either slice.** Both deliverables are call-path verdicts with their method, controls, and stated boundaries.

## Cross-doc invariant audit

**Nothing owed.** No model, field, or type touched.

## Reachability

Both slices *were* reachability work. **Nothing tested-but-unwired introduced; nothing wired.**

## Open follow-ups

1. **The approval-path health gap** — a post-commit record fault there mints no durable record.
2. **`#76` Half B**, **`#79`**, **`#80`**, **`#75`** — `### 24.72`'s remaining discharges.
3. ⛔ **`df39a090`'s commit message reads more broadly than it measures.** *"Makes the fault observable and identifiable"* holds on two compositions; on the third it is observable only to whoever was watching. **Flagged, and the tracker now carries the scope.**

## What this session is worth remembering for

⭐⭐ **The same root cause produced a false NEGATIVE and a false POSITIVE inside one task.** `#76`'s first census searched a **file name plus two guessed symbols** (`surfaceSystemHealth`, `runSystemHealthSurfacing` — neither exists) and returned 2 non-invocations, which reads as *"nothing calls it"*; the real export is `surfaceWorkflowFailure`, with 15 references including the live binding. Then `approvalCommands.ts` grepped for `health|surface` **returns hits that are the English words in prose**.
⇒ ***Searching plausible STRINGS instead of exported SYMBOLS misleads in whichever direction the prose happens to run.*** **The tell in the first case was free: `grep -n "^export"` was the line above in the same output, and I did not reconcile my search terms against it.**

⭐ **A stale hazard note is a legitimate SEARCH KEY and an illegitimate CLAIM.** `#81` arrived with *"`24.58` found sibling-plan loops with identical `subjectRef` and no `return` — prior form for not doing what it appears to."* That describes the **pre-fix** state; `24.58` had landed, the per-plan composite is in the source, and the missing `return` is **deliberate and documented** as best-effort. **Checking it was right; inheriting it would have produced a fabricated defect in a file behaving correctly.** ⚠ **But the lead was still worth sending — it pointed at the right file with the right question. The defect was its STRENGTH, not its existence.**

⭐ **The outlier being the synchronous path is the generalisable half.** A path with a human already watching *looks* like it needs no durable signal — and that intuition is right for transient failures and wrong for ones that leave durable state behind. **The question is not "did anyone see it?" but "does the record outlive the viewer?"**
