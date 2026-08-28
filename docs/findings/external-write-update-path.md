# The external-write UPDATE path — RESOLVED (third attempt)

**Status:** ✅ **CLOSED 2026-08-28.** `update` is wired and all four hazards are
guarded. Two prior attempts landed as one large change and were reverted; this one
landed in six verifiable stages, each green and mutation-proved before the next.

**Reachability:** still DORMANT — the write transport is default-OFF until `§ARM-21`.
This is now a *fix-before-arming* item that has been DONE, not one still owed.

| Stage | What | Commit |
|---|---|---|
| 1 | `write_applications` — the applied-write ledger. Schema, both dialects, contract suite (incl. a test that REPRODUCES C1). No callers. | `8851034f` |
| 2 | Ledger wired into the replay gate. | `392457aa` |
| 3 | Re-drive enumeration CLOSED — **three** paths, not two + three closed-union `default:` arms dropped. | `eff5a113` |
| 4 | Adoption split out of the ledger — a defect stage 2 introduced. | `3fe68ec4` |
| 5 | `update` WIRED, all four hazards guarded, 19 tests. | `1915e033` |
| 6 | C3 closed on all three paths + the fixed-arity lambdas that dropped the argument. | `963ca26c` |

## How each hazard ended up

| # | Hazard | Resolution |
|---|---|---|
| C1 | Replay-gate eviction | **FIXED** — the applied-write ledger records every applied envelope independently of the object row, so a superseded key is still a replay. |
| C2 | Concurrency | **ACCEPTED + PINNED HONESTLY.** `reserve` guards CREATE only, so two concurrent updates both reach the vendor and the last wins. The outcome is ONE object carrying one of two legitimate payloads — recoverable — unlike the create path's duplicate-OBJECT hazard. A test pins the real behaviour; attempt 2 documented a limit materially narrower than this. |
| C3 | Ordering / stale re-drive | **FIXED** on all three re-drive paths via a dispatch-time `intentCreatedAt`. No frozen contract amended. |
| C4/C5 | Adoption laundering ownership | **FIXED** — authorship is decided by the LEDGER, not by the object row's payloadHash (which for an adopted row is merely the payload we intended). Fails closed on a missing ledger and on a ledger fault. |

## ⭐ The two findings worth keeping

**There is a THIRD re-drive path, and it is the worst one.** The APPROVAL path
dispatches `input.context.envelope` — durable Temporal workflow input held across a
HUMAN decision, for days by design. Neither reverted attempt named it, and attempt
2's defence (stripping grants inside `outbox-drain.ts`) structurally could never have
covered it, because that envelope never goes near the drain.

**A guard is worthless until something feeds it.** The live approval wiring was
`(action, env) => dispatch(action, env)` — a fixed-arity lambda that silently dropped
the new third argument. The guard existed, was tested at the gateway, and would have
received a value from nowhere in production. It was found by MUTATION: deleting the
forward changed nothing in 2669 worker tests, and that silence was the finding. Every
such forward is now `(...args) => …`, and each link has a test that REDs without it.

## The bug

`TargetWriteAdapter.update` is declared at `packages/integrations/src/tools/adapter-port.ts:141`,
in a file whose own header calls the Tool Gateway "the ONLY caller". **It has zero callers.**

So a vendor object can never be updated. Every write is create-or-reuse. Measured
consequence: a NotebookLM re-sync with CHANGED bodies issues zero vendor writes,
carries none of the new content, and reports `outcome: "synced"`. Edited notes never
reach Drive and the caller is told the vault is in sync.

## The root constraint

`write_receipts` has PRIMARY KEY `(targetSystem, canonicalObjectKey)` and `put` is
`onConflictDoUpdate` over that target, overwriting the row's `idempotencyKey` column
— in BOTH dialects (`packages/db/src/adapters/sqlite/index.ts` ~:1373-1391,
`postgres/index.ts` ~:1434-1451).

⇒ **The store holds ONE write per object.** It can answer *"is THIS envelope's key the
currently-applied key?"* and *"what payloadHash is currently applied?"* It cannot
answer *"was this OLD envelope ever applied?"*

A create-only world never hits this: an object is created once, so the single row IS
its entire history. **Updates make the history longer than the store can hold.**

⭐ And a second, independent gap: **there is no ordering anywhere in the system.**
Nothing distinguishes a newer intent from an older superseded envelope. These are two
different problems and they need two different mechanisms — conflating them is what
sank attempt 2.

## Attempt 1 — wire update generally (reverted)

Five criticals, all measured:

| # | Defect |
|---|---|
| C1 | Recording a receipt on update EVICTS the prior idempotencyKey, so a replay of the already-committed envelope stops replaying and writes again. **This is safety rule 3 itself.** |
| C2 | The update arm took no create-reservation — two concurrent dispatches with the same key both reached the vendor (measured: 2 vendor updates for one logical write). |
| C3 | A held update re-driven by `outbox-drain.ts` carries an OLD `payloadHash`, so after a newer body landed it wrote the old bytes back — a content REVERT. |
| C4 | Arm-(c) "adoption" persisted a receipt carrying `env.payloadHash` for a payload never written, so the NEXT changed-content dispatch read "we own this" and updated a FOREIGN object. |
| C5 | `adapter-port.ts` therefore asserted a property — "without a receipt there is no evidence this system authored it" — that the adoption step itself fabricated. |

It passed **918 tests**, because `InMemoryReceiptStore` accumulated every historical
idempotency key while the shipped store keeps one row. **The suite was green because
the fake was wrong.** That fake is now corrected (`3442d117`) and pinned.

## Attempt 2 — caller-asserted capability, narrowed to Drive (reverted)

Rejected the ledger and modelled freshness as a capability (`allowInPlaceUpdate` /
`allowAdoptedUpdate`) plus a target allowlist, stripping the grants in the outbox
drain. All five gates REFUTED:

- **C1 UNREPAIRED.** The receipt overwrite was kept; the design argued both replay
  channels were closed. One of them was not.
- **The strip has a hole.** `outbox-drain.ts` is *not* the only component that
  re-drives a persisted envelope — `packages/workflows/src/activities/envelopeReuse.ts`
  (`reuseExternalWriteOnResume`) is a second path the design never accounted for.
- **The capability protected nothing.** The sole production caller
  (`notebooklm-sync.ts`) set BOTH grants unconditionally on every dispatch, so the
  entire defence was caller discipline with nothing structural behind it.
- **C4/C5 reproduced** by a different route: on the composed notebook bind the outer
  adapter's `existenceCheck` returns `ok(null)`, so the adoption sentinel is never
  stamped on the outer row and the live probe happens in a NESTED dispatch.
- A held update whose grants are stripped returns `reused`, and the drain then closes
  the entry carrying a DIFFERENT write's receipt — **the held bytes are silently dropped.**

## What a third attempt needs

Two mechanisms, not one. Attempt 2 rejected the ledger by arguing it does not fix C3
— true, and beside the point: C3 is an ORDERING problem, not a replay problem.

1. **Replay (C1):** an applied-write ledger — every applied `idempotencyKey` recorded
   independently of the current-object row. A schema change in `packages/db` plus the
   dual-dialect contract suite, and a pruning story.
2. **Ordering (C3)** — ✅ **DESIGN DERIVED 2026-08-28, no contract change needed.**
   Verified first, as this section demanded: `ExternalWriteEnvelope` has NO temporal
   or sequence field (`actionId`, `targetSystem`, `canonicalObjectKey`,
   `idempotencyKey`, `preconditions`, `payloadHash`), `preconditions` is a free-form
   gate-name list, and `WriteReceipt.rawRef` is a redaction-safe POINTER, not an etag.
   So nothing on the envelope can carry a version, and **adding one means amending a
   FROZEN contract + its schema snapshot** — avoid.

   ⭐ **The ordering data already exists, just not on the envelope.** The receipt row
   holds the currently-applied `payloadHash` AND its `recordedAt`; and every re-drive
   path knows when ITS intent was created (`outbox.enqueuedAt`; the approval's
   creation time; the resume ledger's step time). So pass the intent's creation time
   as a DISPATCH-TIME parameter rather than an envelope field:

   > superseded ⇔ `current.recordedAt > intentCreatedAt` AND
   > `current.payloadHash !== env.payloadHash`

   - absent `intentCreatedAt` (a fresh dispatch, never a re-drive) ⇒ no check; it is
     current by definition.
   - `current.recordedAt <= intentCreatedAt` ⇒ the intent is newer ⇒ apply.
   - hashes equal ⇒ already applied ⇒ reuse.

   A superseded envelope is DROPPED with a typed outcome, never applied — which is the
   decision rule below (prefer stale over a revert) expressed as code.
3. ~~**Enumerate EVERY re-drive path**~~ — ✅ **DONE 2026-08-28. The list is THREE, and
   attempt 2 knew only two.** A "re-drive path" is a component that dispatches a
   PERSISTED envelope rather than building one from current facts — that is what makes
   a stale `payloadHash` reachable.

   | # | Path | How the envelope is persisted |
   |---|---|---|
   | 1 | `outbox-drain.ts` | the outbox row (`idempotencyKey`, `canonicalObjectKey`, `payloadHash`, payload) |
   | 2 | `envelopeReuse.ts` (`reuseExternalWriteOnResume`), called from `apps/worker/src/lifecycle/recovery.ts` | `RecoverableWrite.envelope`, from the resume ledger |
   | 3 | ⭐ **the APPROVAL path** — `approvalFlow.ts` dispatches `input.context.envelope` via `dispatchApproved` | **durable Temporal workflow input**, held across a HUMAN decision |

   ⭐ **#3 is new, and it is the worst of the three for C3.** The other two re-drive
   within minutes; an approval can sit pending for days by design. Approve it after a
   newer sync has landed and it writes the OLD payload back — the content revert, via
   a path neither reverted attempt named. It is also the one path a "strip the grants
   in the drain" defence (attempt 2's design) could never have covered, because the
   stripping happens in `outbox-drain.ts` and this envelope never goes near it.

   **Why the list is closed.** Every production caller of `dispatchExternalWrite` /
   the routed `dispatch` was classified. The rest build a FRESH envelope from current
   facts (`notebooklm-sync.ts`, `notebooklm-ground.ts`), are pass-through routers
   (`write-adapter-registry.ts`), or are a different `dispatch` concept entirely and
   never touch the external-write envelope (`vaultWatcher.ts` source-ingestion,
   `commands.ts` triage re-enter, `temporal-unavailable.ts` job dispatch,
   `gbrain-sync-trigger.ts` index sync).

   ⚠ A partial ordering defence already exists at ONE boundary and is worth reusing
   rather than reinventing: `copilotProposeSink.ts`'s `reconcileExisting` REJECTS a
   same-id approval whose `payloadHash` diverges (first-write-wins).
4. **Concurrency (C2):** `receiptStore.reserve` is the exclusive-right-to-CREATE guard
   and returns `committed` for an object that already has a receipt, so it cannot
   serialize two updates as-is. Either extend it or document last-writer-wins
   honestly — attempt 2 documented a limit materially narrower than the real one.

## Decision rule for this path

**Stale content is recoverable — you re-sync. A duplicate write, a clobbered foreign
object, and a reverted document are not.** When they conflict, prefer stale. That is
why both attempts were reverted rather than fixed forward: the bug they fixed is
recoverable and the bugs they introduced are not.

## Related

Three "built but unwired" defects surfaced in the same session, all the same shape —
machinery that exists and is never invoked: Phase-25 schedules registered with no
input; `TransportFaultDetail` defined with no producer; `update` declared with no
caller. Worth a grep for others before `§ARM-21`.
