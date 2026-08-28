# `recoverRun` and the "missing resume-ledger store" — DO NOT BUILD ONE

**Status:** CLOSED as *will-not-build*. This corrects a claim I made earlier in the
same round.

---

## The claim being corrected

An earlier handoff listed, among the items blocked only by a missing producer:

> `recoverRun` / in-flight recovery — **no resume-ledger store exists** (positive-controlled)

The positive control was sound. There is no resume-ledger table: 25 schema files under
`packages/db/src/schema/`, none of them run/step/resume shaped, and the only three files
that mention `ResumeInput` / `ResumeStep` are the definition, its consumer, and a comment
about the consumer.

**What was wrong was the implied remedy.** "No store exists" reads as "build the store,"
and building it would have been a mistake.

---

## Why building it is wrong

`planResume` needs two halves. They are in completely different situations:

| Half | Where it lives today |
|---|---|
| The **receipts** — did step N's side effect land? | Already durable, in two stores: `knowledge_revisions` (keyed by `idempotencyKey`) for KnowledgeWriter commits, and `write_receipts` + `write_applications` for external writes. |
| The **step plan** — what did this run intend to do? | Temporal's own durable event history. |

So the step plan is not missing. **Temporal is the store.** Re-deriving a run's plan into
a SQLite table would create a *second* durable record of whether a step committed — one
that can disagree with Temporal's history. Two ledgers that disagree about a committed
side effect is a strictly worse position than one ledger, and it is the exact hazard
safety rule 3 exists to prevent: the whole point of the envelope is that there is ONE
answer to "did this write already happen."

`apps/worker/src/lifecycle/recovery.ts:39-42` already says this in its own scope note —
the live re-entry path is `Worker.create/run` replaying durable history under
`SOW_TEMPORAL`, and `recoverRun` is deliberately "the pure recovery decision + the
no-dup-write proof," i.e. the unit-testable heart, not the production driver.

---

## What is actually missing

Not a store. A **projection**: Temporal event history → `ResumeInput`. That needs a live
Temporal server, and the whole Temporal path is `SOW_TEMPORAL`-gated owner arming. So this
item does not belong on the "buildable without keys" list at all — it belongs with the
arming work.

---

## The generalisable bit

This is the **consumer-built-before-producer** pattern from the same round, with a twist
worth keeping: naming the missing producer as *"a store"* silently picked an
implementation, and the picked one was wrong. The tracker's habit of writing "unwired"
flattens the distinction between *bind two existing things* and *build a thing that does
not exist*; writing "no store exists" flattens a different one — between *the record is
missing* and *the record is somewhere you did not look*.

⇒ **State the missing producer as a QUESTION ("what would answer this?"), not as a NOUN
("the X store").** The noun form skips the step where you notice the answer already
exists somewhere else.
