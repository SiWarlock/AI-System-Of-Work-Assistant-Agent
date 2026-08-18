# Session 172 — 24.80 re-scoped, and the precedent that had not solved it

**Date:** 2026-08-14 · **Phase:** 24 (hardening tail) · **Area:** `packages/knowledge` (knowledge-implementer, single-track `main`)
**Predecessor:** `171-2026-08-14-two-measurements-and-a-census-that-lied-in-both-directions.md` (also mine)
**Successor:** `175-2026-08-18-two-audit-paths-and-five-sentences-that-were-false.md` (also mine)

**Commits:** `ec418c5c` — comment-only correction in `writer.ts`.

---

## What landed

**`ec418c5c`** — `### 24.80`'s motivating sentence corrected. `24.77`'s block said suppression is honest in `tombstone.ts` *"only because tombstone moves the signal into its RETURN TYPE via `changed: false`."* **Technically true, materially overstated.**

**Measured:** `changed` has **one** declaration (`tombstone.ts`) and **three** reads, all in `tombstone.test.ts`; its port type `TombstoneCommitSuccess` does not declare it. ⇒ tombstone **declares** the fact and does **not** deliver it to a consumer. Original preserved as a quoted mention; explicitly **not** a claim that tombstone is wrong — a return-type honesty field is defensible; what was false is that it *solved* observability and could be mirrored as a solution.

## `### 24.80` — re-scoped, NOT built

The field was **not** added, on two grounds, neither about cost:
1. **It dies at the first port** — `createCommitActivity` returns a freshly-built two-field literal, with **seven** more independently-declared success shapes behind it.
2. ⛔ **The precedent was falsified** (above). *"The sibling writer solved this"* is false. The unchecked citation had propagated into **four** artifacts.

## TDD / cross-doc / reachability

Comment-only; no code, no model, no wiring. knowledge **764 / 0 / 1**, typecheck 0, prettier clean, one file.

## Open follow-ups

- **`#86`** — the class task: **eight** re-declared commit-success shapes **plus** a cast population. ⚠ Only the first half is reachable by typing; a value produced behind `as unknown as WriteSuccess` cannot be reached by any type change. `#69`/`#80`/`#82`/`#84` are four symptoms of that one seam.
- **`#85`** — three tasks now depend on an unrun retry measurement.
- **`#87`** — my `--stat`-derived claims were unaudited; the **staged set** was verified before every commit, the insertion counts were not.

## What this session is worth remembering for

⛔ **I reported "REQUIRED is free" and it was false.** `as WriteSuccess` is an **assertion**, not an assignment-checked construction, so a missing required property is never checked — **12 cast sites across four files**. Nothing broke *precisely because* the casts hide the constructions.

⭐⭐ **The two censuses fail in OPPOSITE directions, so their disagreement is the signal.** Name-keyed **over**-includes mentions but **found** the casts; the compiler **under**-includes casts but excludes mentions. I had `3` vs `2` in hand and **reconciled by picking a winner instead of explaining the delta** — and the delta was the interesting set. Same move as the earlier `75`-vs-`3` in the same task, where picking a winner happened to be right.

⚠ **Task metadata is a durable record.** The false claim reached no commit — I checked rather than assumed — but it sat in `#69`'s metadata, which I had not been treating as an artifact that needs correcting.
