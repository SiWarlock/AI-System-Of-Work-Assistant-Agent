# Session 168 — `24.65` Part 2: two stated advantages that died on measurement

**Date:** 2026-08-14 · **Phase:** 24 (hardening tail) · **Area:** `packages/policy` (`providers-integrations-implementer`, single-track `main`)
**Predecessor:** chronological — `167-…-the-guard-not-added-and-the-finding-i-had-to-retract.md` (knowledge) · **this area's prior session** — `165-2026-08-13-24-65-the-defect-that-was-not-there.md`
**Successor:** _(next `/session-end`)_

**Commit:** `db4f40e6` — 1 commit, 2 files, `packages/policy` only.
**Scope:** Part 2 only. ⛔ **Part 1 (the barrel un-export) is knowledge territory and went to knowledge as a cross-track pair.**

---

## ⭐⭐ The headline is not the fix

**Twice in one slice, a fix's STATED ADVANTAGE did not survive measurement — and both conclusions then survived on narrower, re-derived reasons while neither original reason did.**

| claim | verdict | what replaced it |
|---|---|---|
| Un-exporting the GCL barrel makes the hazard **unrepresentable** (`contracts L103`) | ⛔ **FALSE** | `package.json` declares a **`"./*"` wildcard subpath export**, so `@sow/knowledge/gcl/visibility-gate` stays importable — and it is **live** (3 deep-importers vs 105 barrel importers). Un-export is a **surface reduction**, not an elimination. Filed `### 24.78`. |
| The descriptor primitive closes the throw class **without a `try`/`catch`** — "the hostile code simply never runs" | ⛔ **FALSE** | `Object.getOwnPropertyDescriptor` **INVOKES** a Proxy's `getOwnPropertyDescriptor` trap, which is arbitrary caller code. **Three throw-throughs measured** (workspace, projection, taxonomy) against exactly the version claiming they could not happen. Now wrapped, fail-closed. |

⛔ **The second falsified a clause in the ORCHESTRATOR'S APPROVAL, not only my design** — the primitive was approved over the brief's implicit fix partly on that clause. **Recorded upward rather than patched quietly.**

⇒ ⭐ **The mechanism is identical at both layers: the reasoning sounded right and nobody had run it.** *A conclusion can be correct while its stated reason is false, and the reason is what the next person inherits.*

## What was built

| File | Change |
|---|---|
| `src/visibility.ts` | `readOwnDataProperty` → `{found, value}` via `Object.getOwnPropertyDescriptor`, `try`/`catch`-wrapped, fail-closed; all six producer-controlled reads converted; the sibling guard converted; stale `24.65` comment region retracted. |
| `test/visibility.test.ts` | 13 new tests + 1 modified. |

## The three defects I introduced, all caught by review

1. ⛔ **A split-read FAIL-OPEN — `L72` re-created by the fix for `L72`'s previous instance.** `isWithinDefault` took a **raw second read** of `sourceWorkspace.defaultVisibility` three statements after that property was hardened. A Proxy reporting `isolated` via the descriptor while returning `full` via `[[Get]]` passed the new guard and then **supplied THE CEILING** — on the one check that bounds over-exposure. It also falsified this file's own docblock claim of being *"the single hardened read."* ⭐ **`24.45` closed this for `srcId`; I re-opened it for `defaultVisibility`.** ⇒ ***single-sourcing ONE member of an aggregate leaves the aggregate exactly as unsafe, now with a comment claiming otherwise.*** Fixed by hoisting one `srcDefault`, **mutation-verified**, and closed as a property: *no raw `sourceWorkspace.<field>` or `projection.<field>` read remains in the file.*
2. ⛔ **A silent deny→allow flip.** `readOwnData` collapsed *absent* and *present-but-`undefined`*; pre-slice `Object.hasOwn` distinguished them, so a taxonomy `{ summary: undefined }` **denied** and post-slice **allowed**. ⚠ **I asked the reviewer to verify that function's exactness and was told it was NOT exact — my instinct was right about the area and one case off.**
3. ⛔ **A stale comment — `contracts L148`, which I banked ONE SLICE EARLIER IN THIS SAME FILE.** My `24.65` text still asserted *"§16 never-throw does NOT hold for hostile accessor shapes"* directly above the code that now closes it.
   ⭐ **Conclusion banked: *banking a lesson is not a control; the re-read is the control, and it is triggered by the CHANGE, not by remembering the lesson.*** ⚠ **And the trap that makes it near-inevitable (orchestrator's addition): a residual comment is falsified BY YOUR OWN FIX, so it is the text you are least likely to re-read — you wrote it and already know what it says.**

## The censuses — both vacuous, both would have returned the TRUE answer

**Two broken instruments in one measurement:** `for s in $SYMS` (**zsh does not word-split**, so the loop ran once with all 16 names as one symbol), then `awk '$0 ~ "\\<" S "\\>"'` (**macOS awk does not support `\<`**, so every symbol — including the positive control — returned nothing).

⛔ **Both would have reported the correct answer** (zero external importers) **from a broken matcher. The positive control is the only reason either was caught.**

⇒ ⭐⭐ **Banked as `contracts L160`: *a correct answer from a broken instrument is worse than a wrong one — the wrong one gets the instrument fixed, the right one gets the METHOD REUSED.*** Final method: `grep -rwl` per symbol, positive control `admitProjection` = 13 files, negative control = 0.

## Part 1 — the export decision (mine to make, because I measured it)

**Decision: UN-EXPORT.** ⛔ **But NOT on the brief's stated grounds**, which measurement falsified (above).

⭐ **The lead re-derived the fence on the corrected facts and WITHDREW their own `L103` reason; the recorded ruling is now the weaker-but-real basis I gave:** *it applies the file's own bar — "widen this line only for something a composition root must actually construct," which **nothing meets** (`CrossWorkspaceLinkMap` is constructed only in tests, 17 sites) — and it removes **the path taken by ACCIDENT** rather than the one taken by intent. **Different risk profiles, and only one of them happens by mistake.***

**Census (method + controls stated):** zero importers of all 16 symbols outside `packages/knowledge`; every external hit is a **comment**, classified individually — **two of them my own `24.65` comment.**
⚠ **What I did NOT do:** the worktree compile check — a fresh worktree lacks pnpm's per-package `node_modules` symlinks, so `tsc` there fails on module resolution. **Measured the determinant instead:** zero importers anywhere + no knowledge-internal file imports its own barrel.
**The barrel edit is knowledge's**; Part 1 went to them **carrying this census cited, not re-derived.**

## Decisions explicitly NOT made

- **The `"./*"` wildcard fence** — the REAL fence, and **filed (`24.78`), not absorbed**: narrowing it breaks 3 live deep-importers across two packages.
- **The channel-divergence remedy** — filed (`### 24.81`), and **fenced on the GCL port binding** by the lead.
- **Amending `contracts L76`** (reviewer says `9.36` closed it) — ⛔ **I passed the reviewer's CONCLUSION and labelled it as relayed.** The orchestrator filed rather than amended, because *a lesson corrected from someone else's summary is the shape this round keeps catching.*

## TDD compliance

**Clean for the core slice.** 7 RED tests written first and **verified RED for the right reasons** — the fail-open showed `expected 'allow' to be 'deny'`, each throw showed the real accessor error, and the 3 controls passed from the start.
⚠ **Review-driven additions came after their fixes** (the Proxy-trap trio, the `undefined`-valued regression, the split-read pin) — **the split-read pin is mutation-verified** (RED under the raw re-read, green restored).
⚠ **One pre-existing test MODIFIED:** `24.45`'s `reads: 1 → 0`. Strictly stronger against the accessor vector — a getter never invoked cannot return two values — **but the reviewer is right that its coverage narrowed from `{getter, Proxy}` to `{getter}`.** I added separate Proxy tests rather than widening that pin, so the suite covers both while that pin's prose is broader than its assertion. **Disclosed, not quietly re-scoped.**

## Cross-doc invariant audit

**No model field changed.** `Workspace`/`GclProjection` are read, never redefined; the primitive is module-private. **No `ARCHITECTURE.md` row owed.**

## Reachability

`validateProjectionVisibility` is reached via `admitProjection` (`packages/knowledge/src/gcl/visibility-gate.ts`) from **both** `admitAndPersistProjection` (write) and `serveProjection` (read).
⚠ **Producer enumeration (this gated Step 3, because a fail-CLOSED change to a live gate is the direction that breaks working systems quietly):** both production `Workspace` producers terminate in `WorkspaceSchema.parse()` — `defaultWorkspace` (contracts) and `packages/db`'s workspace read gate returning `parsed.data`. **Zod emits plain objects with own data properties**, so no legitimate producer is newly denied. **Independently verified by `security-reviewer`**, and corroborated by all downstream suites staying green.

## Open follow-ups

Filed, **referenced not re-filed**: `24.78` (the wildcard — the real fence) · `24.81` (**descriptor vs `[[Get]]` channel divergence**, fenced on the port binding) · non-enumerable own data properties accepted (a workspace serializing to `{}` passes) · `contracts L76` staleness (filed with evidence, pending verification).

⛔ **`24.81`'s framing, worth carrying verbatim because it is easy to downgrade:** ***a fail-closed gate whose PASS does not constrain the consumer is not a weaker gate — it is a gate measuring a DIFFERENT OBJECT.*** Fail-closed is about what it refuses; this is about what a pass **means**. ⚠ **Scope carried from the reviewer: they traced ONE production call site and did NOT trace `sourceWorkspace` to an entry point — this is not claimed unreachable.**

## Lessons raised

1. ⭐⭐ **A correct answer from a broken instrument is worse than a wrong one** (`contracts L160`).
2. ⭐⭐ **Banking a lesson is not a control** — the re-read is, and the CHANGE triggers it.
3. ⭐ **A conclusion can outlive its stated reason** — twice here. **The reason is what the next person inherits**, so re-derive it rather than the conclusion.
4. ⭐ **An adversarial reviewer covers the space the author's confidence CLOSED** — both HIGH findings landed exactly where I was most certain, and the reviewer's first move was the file re-scan I had skipped.
5. **Single-sourcing one member of an aggregate leaves the aggregate as unsafe** — with a comment claiming otherwise.

## Verification at close

`@sow/policy` **515/515** · tsc **0** · knowledge/workflows/evals/worker **green** · commit verified **per-path**, 2 files, **no peer path swept** · territory clean by **both** `git diff HEAD` and `git ls-files --others --exclude-standard` (the reviewer's `tmp-sec/` harness cleaned by the agent itself).
