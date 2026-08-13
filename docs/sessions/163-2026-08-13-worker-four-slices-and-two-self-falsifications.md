# Session 163 — worker: four slices, and the two claims I falsified myself

**Date:** 2026-08-13 · **Track:** `main` · **Role:** worker-implementer · **Predecessor:** `160` · **Successor:** `166-2026-08-13-comments-that-lied-about-guards-and-the-fix-that-repaired-one.md`

## Shipped

| task | commit | what |
|---|---|---|
| `24.48` | `49253993` | hermes derives the §16 `FailureClass` from the commit CAUSE, not the resting state |
| `24.58` | `2587a64e` | per-plan health-item identity at four sibling-plan loop sites |
| `24.59` | `32d93104` | `workflows.ts` header said "three PURE drivers", imports five — de-inlined |
| `24.26` step 2 | `e8ffd7a7` | both `KnowledgeWriterDeps` literals supply the exempt workspace id from one worker const |

Suite at close: **7627 passed, 0 failed tests**; one failed *file* = known unowned `24.25`.

## ⛔ Two claims of mine that were WRONG, both caught by me, both evidenced

1. **`24.58` mechanism (B)** — I reported a LIVE-path collapse and asked for lead routing, then falsified it: `dispatchSourceIngestion.ts:187` sets `workflowIdReusePolicy: "REJECT_DUPLICATE"` and `:108` makes the Temporal `workflowId` the deterministic idempotency key, so **a workflowId never executes twice** and the sequence cannot occur. **I had verified every link INSIDE the driver and never checked the DISPATCH layer that decides whether the sequence can start.**
2. **`24.26` `planId` provenance** — I called it model-influenced; it is `deps.newPlanId()`, an injected generator, with **no production binding at all**. That correction then CHOSE the design (composite over bare id).

⭐ **Both lowered alarm — the direction least likely to get re-checked — so both went out with evidence attached, and the orchestrator re-verified both at source rather than accepting them.**

## Findings that outlived their slices

- ⛔ **`24.26` step 2's tests are VACUOUS by construction and the brief's criterion was inverted.** `writer.ts:225`'s `?? enforceWorkspacePathScope` is the SAME factory over the SAME string the new const holds ⇒ supplying and omitting are indistinguishable; an end-to-end test stays green with the wiring **deleted**. Reviewer confirmed empirically: **3,588 cases, zero divergences**, with a wrong-id control that DID diverge. ⇒ ***the middle leg of expand/migrate/contract is unverifiable end-to-end BY CONSTRUCTION — it changes who supplies a value without changing what the value is.***
- ⛔ **`buildActivities.ts` had NO pin of any kind** — the higher-traffic literal (feeds `commit` AND `sourceCommit`). Mutation-proved: a wrong-id rule-4 exemption change on the main write path left **2095 tests green**. ⇒ ***a required parameter type-checks PRESENCE, never the string*** — step 3 would not have caught it. Closed with a mutation-verified `worker L28` source pin.
- **`24.58`'s real defect was not the dedupe key's shape** but that a per-ITEM failure inside a loop carried a per-RUN `subjectRef`. `connectorSyncHealth` already had the right pattern ⇒ ***reuse the pattern, re-derive the parameter*** (`L39`'s correct generalisation): a connector is durable across runs, a plan is not.
- ⭐ **`24.58`'s biggest result came from the security review, not the task:** the dedupe key is also the item `id` and reaches the renderer via `UiSafeHealthItem.id`, a GLOBAL surface that deliberately drops `message` as content-bearing ⇒ a slug-derived `planId` would leak a content fragment into the one field assumed opaque. **Promoted to an arming condition on `§ARM-RESEARCH`**, phrased as state: *`newPlanId`'s binding is injective-per-run, bounded-length, and content-free.*

## Process

- ⭐ **`L141` AMENDMENT (adopted):** *reachability is a property of the code path PLUS its trigger.* The orchestrator and I each missed it across a layer boundary within two days, **each while actively holding the rule** ⇒ the rule under-specified where to look, not a discipline failure. **Operational form: name the trigger that makes the sequence start, and verify it separately from the path.**
- ⭐ **A THIRD crossing direction, filed:** handoff 026 named "work is missing" (self-correcting) and "work is done" (not). **A CORRECTION crossing with action already taken on the pre-correction state is neither** — a retraction must WIN A RACE against its own original. Had I gone idle after sending mine, a falsified finding would have been routed to the lead in my name. ⇒ **send a retraction BEFORE continuing the corrected work, and CONFIRM receipt rather than assume it.** (12 crossings observed this session.)
- ⚠ **`deps.health.surface(...)` is written TWO ways in this repo** (inline literal and named const) ⇒ **any single-form search of health surfacing is wrong by construction.** Bit me three times in one slice. Complete set: **22 direct sites across 9 of 15 workflows.**
- ⚠ **`xargs`+`awk` makes `NR` cumulative across files** — line numbers garbage, filenames fine. Use `FNR`.
- ⚠ **A stale file-state claim of mine** ("the `ARCHITECTURE.md` row is unwritten") was a FALSE NEGATIVE — checked early, carried forward as current. `L81` applied to me, a full slice after I named the asymmetry.
- ⭐ **Known-red published by NAME rather than count proved its worth within the hour** — I could verify it had CLEARED; a count would have read `1 failed` against the desktop bundle either way.

## Owed / routed

- **`workspace-path-guard.ts:73-76` is FALSIFIED by `e8ffd7a7`** — it claims the knowledge constant is still the only production source; after this commit the fallback has **zero** production callers. **Knowledge territory → step 3's leg** (orchestrator filing).
- **Step 3 INHERITS real tests:** once the `??` fallback is gone, the briefed end-to-end tests become meaningful and omitting the param fails to compile.
- **Deferred lows (flagged, not skipped):** the test's `as unknown as ApplyPlanFn` double-cast · two reinforcement clauses for the const's warning · `24.58`'s unbounded-`planId`-in-a-btree-PK and `${wf}:${pid}` delimiter non-injectivity.
- ⚠ **`24.58`'s arming clause is rule-4-adjacent**; I classified it as an Architecture note (arming precondition, not live breach) and **routed the CLASSIFICATION question to the lead rather than deciding it.**
