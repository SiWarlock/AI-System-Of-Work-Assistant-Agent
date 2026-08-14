# Session 169 — worker: the write path nobody traced, and the commit I clobbered

**Date:** 2026-08-14 · **Track:** `main` · **Role:** worker-implementer · **Predecessor:** `166` · **Successor:** _(none yet)_

⚠ **THIS DOC IS DELIBERATELY UNCOMMITTED AT WRITE TIME.** HEAD (`1de290d9`) carries an outstanding repair (see the incident below); committing on top of it would turn a one-command `git commit --amend` into a rebase. **Commit this only after `1de290d9`'s message is restored.**

> ⛔ **ERRATUM 2026-08-14 — added by the successor worker-implementer at the lead's ruling. The sentence above is PRESERVED VERBATIM and was correct when written; it is annotated, never struck.**
> ⛔ **The precondition it names was never met and never will be: it was SUPERSEDED, not satisfied.** The lead ruled the seal is **NOT repaired by rewriting** — *an amend would erase the evidence the incident happened, and would re-create the defect it fixes; **corrections land IN the record, never OVER it***  (`IMPLEMENTATION_PLAN.md:71`). `ad9c6815` executed that correction, and `1de290d9` still carries the seal's tracker content under this session's commit message. ⇒ ***`1de290d9`'s message will NOT be restored, so this doc's own gate became unsatisfiable BY CONSTRUCTION*** — an `L131` shape: **a gate phrased as an ACTION that can no longer be discharged.**
> ⭐ **Why annotated rather than struck, and it is the same rule the ruling rests on:** striking the sentence would erase the evidence that a hold was **correctly reasoned and then cancelled by a later decision.** The erratum preserves both halves; a strike preserves neither.
> ⚠ **THE GENERALISABLE HALF (lead's framing): A HOLD OUTLIVES ITS REASON SILENTLY.** The holder's reasoning was sound when written and was cancelled by **a ruling they never saw** — they had already cycled. ⭐ **Same family as a residual-documenting comment outliving its residual (`L148`): both are correct-when-written instructions with NO SIGNAL WHEN THEIR PRECONDITION DIES.** Nothing reds, nothing drifts, nothing contradicts them — the only thing that changed is a decision made elsewhere.
> ⭐ **The check that caught it was `L153` half 2 applied to a DOC HEADER rather than a code comment — first instance.** The imperative **INVERTED**: written to keep an amend cheap, it now buys nothing and carries only loss risk (`L117` — an untracked file is the only real loss vector, and this gate was holding one there). **An instruction whose imperative inverts needs AUTHORIZATION, not a unilateral fix** — which is why the successor flagged it and did not commit on its own judgement.

## Why this session existed

Four slices in the `### 24.62` family, each one falling out of the last: two comment-truth fixes, then the two boundary questions `24.62` had closed *by assumption* — who may name a workspace, and who may write the registry that made naming safe.

## Shipped

| task | commit | what |
|---|---|---|
| `#68` / `24.79` | `5f18f894` | four `by construction` WS-8 claims branch-qualified; sweep found 4 across 3 files where 2 were dispatched |
| `#51` / `24.62`(b) | `ad9166df` | the owner's single-owner ruling recorded at both seams + the owed residual correction |
| `#72` / `24.83` | `9674554e` | the remedy boundary measured — three boundaries, not two |
| `#52` / `24.62`(a) | — | closed on measurement; both halves disposed, neither dropped |

## ⛔ INCIDENT — I overwrote the orchestrator's seal commit

`git commit --amend` in a **shared checkout** is not an operation on *your* commit. **It is an operation on whatever HEAD points at when it runs.** The orchestrator landed `614bcbdc` ("seal the round") in the window between my commit and my amend, so my `--amend` rewrote **theirs**: `1de290d9` holds their tree under my message.

**Recoverable, nothing lost:** their content is intact, `614bcbdc` survives in the reflog with message + authorship, my `9674554e` is untouched, nothing is pushed. **Repair (needs someone with the permission — the auto-mode classifier denied it to me, correctly):**
```
git rev-parse HEAD          # MUST read 1de290d9…
git commit --amend -C 614bcbdc
```

⛔ **The part that is mine to own: I had already refused this exact operation two slices earlier** on `ad0224f1`, and one of my three stated reasons was *"an orchestrator commit sits on top of it."* I checked that condition here, found HEAD clean, and proceeded — **treating a snapshot as a durable property.** ⇒ `L141` on myself: **I verified the path and not its trigger.** *Naming a failure mode buys nothing; only re-executing the check does.*

⭐ **Same root as `L166`, opposite blast radius.** One checkout, several writers. There, a shared tree produced a **phantom** failure belonging to nobody and the risk was a wrong accusation. Here, shared **HEAD** produced real damage to someone else's work. ⇒ **never `--amend` in this repo without verifying HEAD is still yours in the same breath; prefer a follow-up commit or an erratum, which are race-free.**

## Findings that outlived their slices

- ⛔ **`24.62`'s justification is falsified, and the reasoning was mine.** It kept `workspaceId` raw *because registry-validated*. `parseCreateWorkspace` admits **any non-empty string**, so a credential-shaped id is registry-valid **by construction**. **"Registry-validated" means "someone inserted it," not "an authority vouched for its shape"** — `contracts L147`'s predicted instance, in the place it said nobody looks. ⭐ **My own residual at `boot.ts` predicted it three slices earlier and named `#52` as its bound.**
- ⭐ **The remedy boundary is THREE, not two, and coverage decided it.** **17 frozen models carry `workspaceId`** ⇒ audit = 1/17, and the id also reaches the **renderer**, which rule 7 names explicitly. Write = the worker-side **call-site** remedy. **Type boundary (`WorkspaceIdSchema`, 15/17) is the class fix** — frozen-contract, filed as `24.84`. ⛔ **And `parseCreateWorkspace` never runs the brand at all**, so the worker work is *stop bypassing the validator that exists*, not *add a second rule*.
- ⭐ **"Credential-shaped" is undefinable and does not need to be.** Detection is `worker L73`'s unwinnable denylist — `isRedactionSafe`'s own doc concedes a codename passes it. **Invert: not "is this a credential?" but "is this a well-formed workspace id?"** A bounded slug charset makes credential shapes **unrepresentable rather than detected**, and measurably also closes `ws/../etc` — traversal ids, which matter because this id builds vault paths.
- **`#51` ruled by the owner:** single-owner is correct by design; rule 4 protects **content scope**, not principal-from-principal. **Both seams fence the ruling's edge** — it is about the CALLER, not the STRING — because that is how a ruling widens in retelling.

## Self-corrections, all caught by re-running rather than by review

- ⛔ **A vacuous compliance sample.** I checked test fixtures against a slug rule using the pattern `"ws-[a-z0-9-]+"` — **which can only match conforming values**, so zero rejections was the only possible result. Re-run with a permitting pattern: **5 would break** (one of them mine). ⇒ **a compliance sample must be drawn with a pattern that COULD return a violation; otherwise it proves the pattern, not the population.**
- ⛔ **A phantom red I nearly escalated** at the track that had just committed: 57 failed files from a **torn read of the shared tree mid-commit**. Disproof was **structural** — the `dist` file the error named still does not exist, so it was never capable of being the cause. ⇒ **prefer a structural disproof to a re-run; a re-run cannot distinguish "never real" from "intermittent."**
- **A counting error:** per-dialect `workspace_config` writes reported as 5, actually **3** — the pattern had matched reads.
- **An enumeration done by method name, redone by concept** — which produced the better result: `WorkspaceConfigRepository` is the **sole write gateway**.

## TDD compliance

**No violations.** `#68`, `#51`, `#72` were comment-only (**zero logic delta proven mechanically on the STAGED SET**, not just the working tree). `#52` and `#72`'s measurement legs shipped **zero tests deliberately** — pinning current behaviour would have foreclosed the owner's ruling by making its reversal read as a regression (`contracts L69`).

## Cross-doc invariant audit

**Clean** — no model field added/removed/renamed. `AuditPersistPort`'s signature untouched throughout.

## Reachability

No new code; all four slices were documentation or measurement. The annotated sites are existing, reachable composition/auth/retrieval seams.

## Open follow-ups

- ⛔ **`1de290d9`'s message repair** — the only outstanding action from this session.
- **`#73` / `24.84`** — the write-boundary validator. Carries the binding live-id gate (3/3 live ids accept) **and the 5-fixture migration cost**, surfaced rather than discovered at implementation time.
- **The contracts-side change** — `WorkspaceIdSchema` its own schema, never the shared `brandedIdSchema` factory. **Contracts-first is cheaper**: it shrinks the worker change to routing through the brand.
- **Unestablished, stated as such:** 2 of the 17 models do not reference the brand (unidentified); **pre-existing rows are uncovered by all three boundaries**; which retrieval branch is live is a **deployment** fact, never asserted from source.
