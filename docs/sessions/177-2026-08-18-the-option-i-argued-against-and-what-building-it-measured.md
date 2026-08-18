# Session 177 — the option I argued against, and what building it measured

**Date:** 2026-08-17 → 2026-08-18 · **Phase:** 24 (hardening tail) · **Area:** `packages/contracts` (`contract-implementer`, single-track `main`)
**Predecessor (this area):** **NONE — this is the `contract` area's first session doc.** The track was deliberately unqueued (handoff `028`); the owner staffed it this round.
**Predecessor (chronological):** `178-2026-08-18-the-expiry-that-fired-and-the-ground-that-was-false.md` (providers-integrations)

> ⚠ **RENUMBERED 176 → 177 AT WRITE TIME (2026-08-18).** Providers and I wrote a doc numbered `176` **eight seconds apart**, in the same tree — the `173`/`174` collision **repeating, four days after it was recorded as a defect and renumbered.** ⛔ **A per-directory `NNN` counter is not concurrency-safe, the follow-up was filed and never adopted, and filing it did not stop the second occurrence** (`L110`: a mitigation recorded as an option is not a mitigation). **Resolved by the `173`→`174` precedent — inbound links decide:** providers' doc already had **2** inbound links from its predecessor `174`; mine had **0**, because this chain starts here. ⭐ **Renumbering mine therefore broke nothing, which is the only reason this was cheap.**
**Successor:** _(none yet)_

**Commit (mine):** `25ae6c49` — `### 24.84` contracts leg. 17 files, 412 insertions, 18 deletions, zero foreign.
**Baseline at start:** `3b74e497`. **Tree at close:** `packages/contracts` clean apart from orchestrator-territory files I must not touch.

> ⚠ **NO SUCCESSOR LINK WAS WRITTEN INTO `175`, DELIBERATELY.** `175` is the **knowledge** chain. A session-doc number is a chronological fact, not an authorship one — `L176`'s third instance is exactly this, and updating `175`'s successor link would have written a false edge into another area's chain. **My chain starts here.**

---

## Why this session existed

`### 24.84` was **deferred on staffing, not design** (lead ruling, 2026-08-14): the task's own analysis said the cheaper path was contracts-first, and the `contract` track was unqueued. *"I am not letting staffing pick the design."* The owner staffed this area to unpark exactly that.

⛔ **The pointer to it was dead.** Handoff `028` named the deferment as `#73` — a session-scoped harness id that died with its session, and per `### 24.66` it does **not** map to `### 24.73`. It was recovered **by content, from git**: commit `c36574d3`'s message states *"#73 / ### 24.84 DEFERRED"*, corroborated by `24.84`'s own body. ⭐ A numeric guess would have landed on `### 24.73` — an unrelated §16 sweep. **First live confirmation of the two-namespace ruling.**

## What was built

`WorkspaceIdSchema` was `brandedIdSchema<WorkspaceId>()` — a shape-free generic factory, so `.min(1)` plus a non-blank refine was the *entire* definition of a workspace id. It now carries a bounded positive slug shape, `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, maxLength 64.

**Files created**
- `packages/contracts/test/primitives/zod-brands.test.ts` — 10 tests. Rejection table (18 cases incl. traversal, control chars, ZWSP, newline/CR regression pins); the **availability pin** (every live production id parses); the **credential-acceptance pin**; the length bound with its non-defense assertion; a type-level brand pin (`@ts-expect-error`, RED = unused directive); all 16 sibling factory brands asserted **both directions**; the one real skipper pinned; and a written record of why the discriminating-control describe was deleted rather than repaired.

**Files modified**
- `packages/contracts/src/primitives/zod-brands.ts` — `WorkspaceIdSchema` gains its own schema; `brandedIdSchema` **byte-identical to HEAD** (verified by two surfaces). Docblock states what the shape is **not**.
- 15 × `packages/contracts/schemas/*.schema.json` — regenerated. **Purely additive**: `pattern` + `maxLength` added, `minLength` retained, **zero removals**, verified by structural diff of all 15 rather than by eye or by `git diff`.

## Decisions made

**1 — The shape is WELL-FORMEDNESS, not credential detection, and that is load-bearing rather than a caveat.** Measured: every lowercase credential shape **accepts** (`sk-ant-api03-abc123def456`, `akiaiosfodnn7example`, 32-char lowercase hex). The prior claim that the shape "rejects `sk-`/`AKIA`/`ghp_`" is true only of those *spellings*, which carry uppercase/underscore/dots.
⭐ **That documented weakness is what keeps `### 24.55`'s rule-7 redaction control reachable** — a slug-valid id can still be credential-shaped, so it passes this brand and reaches the redaction gate. **The two gates must not be collapsed.**

**2 — The length bound is bounded-input hygiene ONLY.** Measured across the credential set: `max(64)` and `max(40)` both accept **5 of 5**. No plausible bound buys credential rejection. The rationale is ruled to never drift into one.

**3 — Pin the limitation as an EXECUTABLE assertion, not a flag.** The orchestrator asked for a Step-9 flag if the docblock moved. Shipped `accepts lowercase credential shapes` instead. ⭐ **A prose dependency needs a reader; a pin needs nobody** — a future tightening that rejected credential shapes now reds this test rather than silently retiring `24.55`'s control.

**4 — Argue against the remedy that would have unblocked me.** A proposal to drop the pattern from the read-path schema would have let this slice ship immediately. It was **wrong**: the read gate exists to refuse a *post-write tamper*, and dropping the pattern lets a credential-shaped id pass the shape stage and be **served**. **Refused-but-unaudited is strictly safer than admitted.** The owner ruled for the split anyway on a packet that never carried this; the ruling was then **voided** because its deciding clause was false (there is no "after-redaction" — `isRedactionSafe` gates the audit *write*). Re-put, and the owner adopted the position argued here.

**5 — Root cause is TEMPORAL, not structural.** Rows outlive schemas, so tightening a schema that gates **both** admission and re-validation of already-persisted data is a **migration event**. That framing killed the split twice: it surrenders containment *and* manufactures `### 24.46`'s two-shapes class.

**6 — Build the option I opposed, then measure it.** Implemented the read-path split under the (then-live) ruling; the void landed while I worked. Reverted **to the committed directive, not to the message** (`L132`). ⭐ The discarded work produced the decisive number: option (a) takes the suite **8 reds → 2** — and the six that go green are the `globalDrillDown` WS-8 pins, **green because the row is no longer refused.** *The suite getting greener was the containment loss becoming invisible.* Reported with that framing attached, because the two readings decide oppositely.

## Decisions explicitly NOT made

- **`audit-record.ts` NOT routed through the brand.** Its skip is deliberate and structural — the model imports no branded ids at all, to keep `z.infer` free of module-private brand symbols. `### 24.62`/`### 24.83` have live history on that field. Flagged, not absorbed.
- **`Workspace` NOT loosened.** Measured: `WorkspaceSchema` is *both* the write validator (`defaultWorkspace`) and the read re-validator (`parseStoredWorkspace`). Splitting it would have removed the write-side tightening **and** made knowledge's bypass unnecessary — contradicting the two-fixes structure the ruling rested on. ⇒ the `egressRevoke` surface is **not reachable from `packages/contracts`**.
- **The read-path split NOT shipped.** Ruling voided; slice held as built.
- **`### 24.100` / `### 24.102` / `### 24.104`** — filed on this track, deliberately unstarted.

## TDD compliance

**Clean, with one ordering deviation disclosed.**
- RED confirmed before implementation: **5 failed / 4 passed**, for the right reason. The 4 passes were invariants that must hold *both* sides of the change. The control showed the old schema rejected only **3 of 15** cases — the 3→15 delta is the discriminating power the change had to produce.
- ⚠ **Deviation:** the Step-2.5 write-up was sent **before** the test file was written (design first, file second). The review surface — the asserted invariants — was reviewed and approved, which is the point of the gate, but the order deviated from `/tdd` Step 2 → 2.5. Disclosed at the time.
- **Mutation verification, red-outcome (self-proving):** stripping `.min(1)` + refine from the factory turns **exactly** the new reject-side sibling test red (1 failed / 9 passed) — proving the reviewer's diagnosis that the accept-only version could not see a weakened factory. File restored byte-identically.
- **No green-outcome mutation was used to reach any verdict.** The deleted discriminating control was ruled vacuous **structurally**: `WorkspaceIdSchema` was not an input to the assertion, so no implementation could change its value. Immune to the applied-proof problem by construction (`L190` amendment).

## Reachability

**`WorkspaceIdSchema` — reachable, proven EMPIRICALLY rather than by trace.** It is consumed by the 15 models that validate through it; the cross-package test failures this change produced *are* the reachability evidence (`defaultWorkspace` → `WorkspaceSchema.parse` → the brand). ⭐ A green suite in my own package would not have shown it.
⛔ **The create path is NOT wired to it.** `parseCreateWorkspace` uses `isNonEmptyString` and returns the id raw — the worker leg, undispatched. **This slice DEFINES the shape; it does not enforce it at the write boundary.** No coverage is claimed beyond that.

## Open follow-ups

1. ⛔ **Owner-accepted cost (1) is NOT discharged and is NOT bounded.** It reads *"legacy rows stay unreadable until `### 24.98` lands"*; `24.98` **has landed** and does not make them readable (its own Done-when requires the row stays refused). **No filed task ends it — only a migration would.** With the owner for re-pricing. **Do not tick.**
2. **`### 24.99` BLOCKS `### 24.84`'s closure.** Branch (A) is **ruled against, not deferred**. Residual: `### 24.102`.
3. **`### 24.97` leg (b)** (`workspace-read-gate` / `egressRevoke`) remains open. Neither leg ticks alone.
4. **`### 24.93` FIRED on this landing** — announced in the commit body so the firing is not silent.
5. **`ParityReportSchema.parse` is a THROWING parse inside a DB read adapter**, both dialects — newly reachable for legacy rows. Filed `### 24.96` as precondition-class.
6. **Pre-existing-row population measured on ONE deployment only** — 13 columns, 3 distinct values, all conform, 0 non-conforming, read-only, one moment. **Other installs UNMEASURED.** The scope is as much the finding as the number.
7. `### 24.100`, `### 24.102`, `### 24.104` — filed on this track, unstarted.

## Corrections I made against myself

Recorded because the ratio matters more than any single one.
- **"14 newly-breaking fixtures, 10 in desktop"** → measured **3 values break 8 tests; desktop breaks ZERO**. *The literal exists ≠ the literal reaches the validator.* ⛔ **The retraction did not travel with the number** — an escalation about "an unknown number of unowned desktop tests" reached the lead on the withdrawn figure and had to be pulled. Desktop imports **none** of these schemas; it cannot red on this change.
- **"20 factory brands"** → **17**. I corrected the brief's floor of 8 with a wrong number of my own.
- **"15 of 17 models"** in my own test comment → that is `L183`'s unit-laundering subtraction, **banked this session from my own census finding.** Replaced with all five populations and their units.
- **The census command I wrote returns ZERO** on the one file carrying the repo's deliberate bypass (indexed-access casts). **Withdrawn as a census** rather than patched to catch one more spelling — patching would have left the miss-set unknown while reading more authoritative.
- ⚠ **The last two were introduced AS CORRECTIONS.** A correction arrives with a reviewer's endorsement attached and reads as already-vetted — but the reviewer approved retiring the old claim, not the new one replacing it.

## How to use what was built

- **Adding a model with a `workspaceId`:** import `WorkspaceIdSchema`; the shape is inherited. `audit-record.ts` is the documented exception.
- **Before claiming a value is a well-formed workspace id:** the guarantee is *"everything that PARSES is well-formed"*, never *"every value of this type is well-formed."* Casts bypass it. Derive by position/type, never by spelling — the docblock says why, and records the census that got it wrong.
- **If `accepts lowercase credential shapes` ever goes red:** that is not a test to fix. It means the brand was tightened into rejecting credential shapes, which retires `### 24.55`'s redaction-control reachability.
