# Session 173 — worker: two errata, a vacuous remedy, and the scopes I kept getting wrong

**Date:** 2026-08-14 · **Track:** `main` · **Role:** worker-implementer · **Predecessor:** `169` · **Successor:** `178-2026-08-18-two-slices-with-zero-production-delta-and-a-mutation-that-never-applied.md`

⚠ **Chains run PER-AREA. `170`/`171`/`172` are `packages/knowledge` docs and are NOT in this chain** — verified from their headers before writing the predecessor link, not inferred from the numbering.

## Shipped

| task | commit | what |
|---|---|---|
| lead-ruled | `ea8cafd4` | session `169` committed with a dated erratum; its gating sentence preserved verbatim |
| lead-ruled | `a00fc63a` | the same erratum extended to the INSTRUCTION and the follow-ups entry — the gate was annotated, the recipe was not |
| `#49` / `24.85` | `0f33f694` | the 5 `createCommitActivity` opt-out sites documented, after the remedy was MEASURED vacuous |
| `#75` / `24.72` Leg B | `27d919ac` | two new `KnowledgeCommitFailureCode` members, terminal mapping, `db_unavailable` class, 5 new pins |

⛔ **The close-out dispatch listed `#51`, `#52`, `#68` as mine. They are NOT — they are session `169`'s, and `169`'s own Shipped table already carries them.** Claiming them here would have double-counted a predecessor's work into my record. *A handoff list is a hypothesis; the artifact is the evidence.*

## The through-line: I was wrong four times, and each was a SCOPE

Every substantive error this session was the same shape — a measurement whose boundary did not match the sentence I wrote from it.

1. ⛔ **A package-scoped compiler enumeration reported as complete.** `#75` asked for the downstream sites. `tsc -p packages/workflows` found **3**; the true count is **4**. `semanticMutationDispatch.ts:213` lives in `apps/worker` and was **structurally invisible** to that run. ⭐ **I was one message from filing a correction against knowledge, whose citation was RIGHT.** ⇒ ***a compiler-enumerated site set inherits the SCOPE OF THE RUN.*** "Let the compiler enumerate" is still the best instrument here — it found the site a grep would have missed and no interception can forge a `tsc` error — but it finds **type-DEPENDENT** sites, at the scope compiled.
2. ⛔ **And the same instrument has a second bound, found by a reviewer:** `hermesAutomation.ts:617` **hardcodes** a resting state for every commit failure and never calls `commitFailureState`, so it type-depends on nothing and **no compiler run of any scope would surface it** — under a comment whose stated safety premise (*"the writer re-refuses on every re-drive"*) is FALSE for the two new codes. ⇒ ***the exhaustiveness guard covers the MAPPERS, not the CONSUMERS.*** Filed `#83` (rule 1).
3. ⛔ **A git author filter that cannot discriminate.** Verifying which commits were mine, I filtered by author — **every agent in this checkout commits as ONE identity**, so the filter was vacuous and returned the whole team's work. Caught by running the control (`git log --format='%an' | sort -u` → one name). **The population was defined by a field that does not vary.**
4. ⛔ **A citation stale at the moment I wrote it.** `#49`'s note cited `writer.ts:335`; an in-flight edit in another package had already moved the binding to `:369`, and it moved again to `:382` when that work landed. Switched both notes to **symbol anchors** and recorded why, so nobody restores the numbers.

## Two errata, and the discrimination between them

**`169` gated its own commit** on *"only after `1de290d9`'s message is restored"* — a precondition the lead's no-rewrite ruling made **unsatisfiable by construction** (`L131`: a gate phrased as an ACTION that can no longer be discharged). It was parked untracked, the one real loss vector.

⭐ **The first erratum annotated the GATE. It did not annotate the INSTRUCTION, and the instruction was the dangerous half.** The INCIDENT section carries a **copy-pasteable** `git commit --amend -C 614bcbdc`; HEAD has moved far past `1de290d9`, so running it today amends **someone else's commit** — *re-creating the exact incident the document exists to record*. Its first line is a **comment, not a guard**: it narrates a precondition and enforces nothing.

⇒ ***an erratum that corrects a document's PREMISE does not automatically correct its INSTRUCTIONS — and the instruction is the dangerous one, because a premise misleads and an instruction gets followed.***

⭐ **The sweep found no fourth site, and that is a measured result** (26 concept hits classified individually, not the two named). ⭐ **One instruction was deliberately LEFT ALONE:** *"prefer a follow-up commit or an erratum, which are race-free"* — its imperative **STRENGTHENED**, and only an **INVERTING** imperative needs countermanding (`L153` half 2). Annotating it would have implied it was suspect when the ruling had just vindicated it.

## `#49` — the remedy that was vacuous by construction

The Done-when offered "supply a real `workspacePathCheck`" or "document the opt-out." ⛔ **The first was measured VACUOUS before implementing:** a guard **throwing on any call** at all 5 sites left **40/40 GREEN**, while breaking a **sibling field of the same literal** went **RED 3/2**.

⭐ **The control is what makes the green mean anything** — it separates *not read* from *did not run* by measurement rather than assertion. Structural disproof backs it: the activity **forwards** `deps.deps` to an injected fake and never dereferences it.

⛔ **Then reviewers falsified SIX of my own claims in those notes** — a parameter enumeration I had the contradicting grep output for and wrote past; "STRUCTURALLY discarded" (the type declares two params, TS merely permits fewer); three **bare** `L84`/`L85` citations in a package whose ledger **ends at L82**, so they dangled; an over-general "green means NOT READ" at a §16-wrapped seam; and an overstated guard description. **All fixed pre-commit.**

⛔ **And the slice CAUSED citation rot: nine line numbers in the very file my notes name as "REAL ASSURANCE" now resolve to plausible WRONG text** — one of them to my own sentence *about* the sites. Routed on KIND to the lead (rule 4); repair was knowledge's territory (`#78`).

## `#75` — the decision was right and my reason for it was false

Two POST-COMMIT codes: the only ones under which **the Markdown write SUCCEEDED**. Mapped **terminal** / `retryable:false`.

⛔ **Both reviewers independently falsified the justification I shipped at three sites** — *"the writer's idempotent replay returns `replayed:true` and writes nothing."* Verified at source: the replay guard keys on `getByIdempotencyKey`; `revisions.record` runs **LAST**; `audit_record_failed` returns **before** it and `revision_record_failed` **IS** it failing. ⇒ **no revision record exists under either, so a retry MISSES the guard.** Leg A's own file said so, two packages away, the same day.

⭐ **The correction makes the decision STRONGER: the replay guard never closed this — terminal does.**

⭐ **What kept the decision sound while its reason was wrong: reason 2 was SEMANTIC.** *The Markdown is durable and the bookkeeping is not; the operator needs RECONCILE, not RE-RUN.* A claim about what the state **means** survives a stale census — which is why the lead asked me to lead with it.

⚠ **The two reviewers then reached OPPOSITE conclusions** on what a retry does at the live-head bindings — a second (false) audit row, or a truthful already-applied row plus the missing revision, i.e. reconcile-by-re-run. **Both derived from source; both said they had not run it.** ⇒ **I did not pick.** `24.76`'s own precedent is that executing beat four people reasoning. Filed `#85` as a harness.

## Findings filed rather than absorbed

`#83` rule-1 hermes re-drive · `#84` the `revisionId` Leg A added FOR remediation is dropped at the port while every comment prescribes reconcile (`worker L79`) · `#85` the harness · contributed to `#79`/`#80`.

## Instruments

⚠ **`git diff` here is a SUMMARISING SHIM** — a reviewer found it omitted a whole block of my file. **`#49`'s comment-only proof was computed on it**; `#75`'s claims were re-derived from raw source. ⚠ **`grep` fabricated twice this session, independently observed by two agents** (`"37 matches in 2 files"` on a single-file search) — corroborating because the runs *could* have failed independently. ⚠ **`turbo`'s summary hid a second failed task** (`14 + 1 ≠ 16`) and the `16` was itself an artifact: 2 failed, 4 never ran; the true graph is 20.

## TDD compliance

`#49` comment-only (zero logic delta proven mechanically). `#75` **RED first** — 3 new tests failed 3/5, the discriminating one reporting `Set size 1`, i.e. the defect reproduced. ⛔ **One disclosed deviation:** the worker cases shipped untested in the first pass; I **disclosed rather than claimed coverage**, and the pin was added on ruling before Step 10.

## Cross-doc invariant audit

**Clean** — no model field added/removed/renamed. `KnowledgeCommitFailureCode` is not a frozen Appendix-A seam (checked).

## Open follow-ups

- `#83` · `#84` · `#85` — all filed, none closed.
- ⛔ **`FailureClass` is frozen and `db_unavailable` is LEAST-WRONG, not correct** — it over-claims on a constraint error or lock contention. Partially addresses `24.80`; does not close it (the two codes still share a class with each other).
- **Unestablished, stated as such:** whether a retry at the live-head bindings reconciles or corrupts (`#85`); whether any consumer outside the two compiled projects hardcodes a commit-failure state as hermes does.
